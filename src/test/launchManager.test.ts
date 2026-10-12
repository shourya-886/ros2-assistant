import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverLaunchFiles, parseLaunchArguments, parseRos2ShowArgs } from '../launch/launchManager';

suite('ROS 2 launch discovery', () => {
    let temporaryRoot: string;

    setup(() => {
        temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ros2-assistant-launch-'));
    });

    teardown(() => {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    });

    test('parses statically declared Python launch arguments', () => {
        const source = `
DeclareLaunchArgument('use_sim_time', default_value='true', description='Use simulation clock')
DeclareLaunchArgument(name="robot_name", default_value="robot")
`;
        assert.deepStrictEqual(parseLaunchArguments(source, 'py'), [
            { name: 'use_sim_time', defaultValue: 'true', description: 'Use simulation clock' },
            { name: 'robot_name', defaultValue: 'robot', description: undefined }
        ]);
    });

    test('parses arguments reported by the ROS 2 launch CLI', () => {
        const output = `Arguments (pass arguments as '<name>:=<value>'):

    'use_sim_time':
        no description given
        (default: 'false')

    'robot_name':
        Name of the robot
        (default: 'bumperbot')
`;
        assert.deepStrictEqual(parseRos2ShowArgs(output), [
            { name: 'use_sim_time', defaultValue: 'false', description: undefined },
            { name: 'robot_name', defaultValue: 'bumperbot', description: 'Name of the robot' }
        ]);
    });

    test('parses XML launch arguments and defaults', () => {
        const source = '<launch><arg name="namespace" default="/robot" description="Robot namespace"/></launch>';
        assert.deepStrictEqual(parseLaunchArguments(source, 'xml'), [
            { name: 'namespace', defaultValue: '/robot', description: 'Robot namespace' }
        ]);
    });

    test('discovers supported launch files inside ROS packages and skips generated directories', () => {
        const workspace = path.join(temporaryRoot, 'robot_ws');
        const packageRoot = path.join(workspace, 'src', 'demo_pkg');
        const launchDirectory = path.join(packageRoot, 'launch');
        const generatedDirectory = path.join(workspace, 'build', 'generated_pkg', 'launch');
        fs.mkdirSync(launchDirectory, { recursive: true });
        fs.mkdirSync(generatedDirectory, { recursive: true });
        fs.writeFileSync(path.join(packageRoot, 'package.xml'),
            '<package format="3"><name>demo_pkg</name></package>');
        fs.writeFileSync(path.join(launchDirectory, 'demo.launch.py'),
            "DeclareLaunchArgument('robot_name', default_value='robot')");
        fs.writeFileSync(path.join(launchDirectory, 'view.launch.xml'),
            '<launch><arg name="use_sim_time" default="false"/></launch>');
        fs.writeFileSync(path.join(launchDirectory, 'notes.txt'), 'not a launch file');
        fs.writeFileSync(path.join(generatedDirectory, 'ignored.launch.py'), '');

        const result = discoverLaunchFiles(workspace);
        assert.strictEqual(result.packagesScanned, 1);
        assert.deepStrictEqual(result.launchFiles.map(file => file.fileName), [
            'demo.launch.py', 'view.launch.xml'
        ]);
        assert.strictEqual(result.launchFiles[0].packageName, 'demo_pkg');
        assert.strictEqual(result.launchFiles[0].arguments[0].name, 'robot_name');
        assert.deepStrictEqual(result.issues, []);
    });

    test('reports a missing src directory without throwing', () => {
        const result = discoverLaunchFiles(temporaryRoot);
        assert.strictEqual(result.launchFiles.length, 0);
        assert.match(result.issues[0].message, /src directory/);
    });
});
