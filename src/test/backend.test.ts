import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProcessManager, formatProcessError } from '../core/processManager';
import { detectRos2Workspace, detectRosBuildEnvironment } from '../build/workspaceManager';
import { discoverRos2Packages, parseRosPackageManifest } from '../build/packageDiscovery';

suite('ROS 2 Assistant backend', () => {
    test('formats process errors consistently and prefers stderr', () => {
        assert.strictEqual(
            formatProcessError('ROS topic list', new Error('exit 1'), 'daemon unavailable', 'ignored stdout'),
            'ROS topic list failed: daemon unavailable'
        );
    });

    test('tracks a spawned process through its exit status', async () => {
        const manager = new ProcessManager();
        const child = manager.spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
        assert.ok(child.pid);
        await new Promise<void>((resolve, reject) => {
            child.once('close', () => resolve());
            child.once('error', reject);
        });
        const status = manager.getProcessStatus(child.pid!);
        assert.ok(status);
        assert.strictEqual(status.state, 'exited');
        assert.strictEqual(status.exitCode, 0);
        assert.ok(status.finishedAt);
    });
});



suite('ROS 2 workspace detection', () => {
    let temporaryRoot: string;

    setup(() => {
        temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ros2-assistant-workspace-'));
    });

    teardown(() => {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    });

    test('detects a workspace when a nested package folder is opened', () => {
        const workspaceRoot = path.join(temporaryRoot, 'robot_ws');
        const packageDirectory = path.join(workspaceRoot, 'src', 'bumperbot', 'bumperbot_description');
        fs.mkdirSync(packageDirectory, { recursive: true });
        fs.writeFileSync(path.join(packageDirectory, 'package.xml'), '<package/>');

        const result = detectRos2Workspace(packageDirectory);

        assert.strictEqual(result.status, 'detected');
        assert.strictEqual(result.workspaceRoot, workspaceRoot);
        assert.strictEqual(result.packageManifestCount, 1);
        assert.strictEqual(result.indicators.src, true);
    });

    test('reports an empty src workspace skeleton as incomplete', () => {
        const workspaceRoot = path.join(temporaryRoot, 'empty_ws');
        fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });

        const result = detectRos2Workspace(workspaceRoot);

        assert.strictEqual(result.status, 'incomplete');
        assert.strictEqual(result.workspaceRoot, workspaceRoot);
        assert.strictEqual(result.packageManifestCount, 0);
    });

    test('reports an ordinary src-only folder as incomplete rather than detected', () => {
        const projectRoot = path.join(temporaryRoot, 'ordinary_project');
        fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });

        const result = detectRos2Workspace(projectRoot);

        assert.strictEqual(result.status, 'incomplete');
        assert.strictEqual(result.workspaceRoot, projectRoot);
    });

    test('returns not-found when no src directory exists in the ancestor chain', () => {
        const projectRoot = path.join(temporaryRoot, 'plain_folder');
        fs.mkdirSync(projectRoot, { recursive: true });

        const result = detectRos2Workspace(projectRoot);

        assert.strictEqual(result.status, 'not-found');
        assert.strictEqual(result.workspaceRoot, undefined);
    });

    test('detects installed ROS distributions and an executable colcon on PATH', () => {
        const rosInstallRoot = path.join(temporaryRoot, 'ros');
        const humbleDirectory = path.join(rosInstallRoot, 'humble');
        const binDirectory = path.join(temporaryRoot, 'bin');
        fs.mkdirSync(humbleDirectory, { recursive: true });
        fs.mkdirSync(binDirectory, { recursive: true });
        fs.writeFileSync(path.join(humbleDirectory, 'setup.bash'), '');
        const colconExecutable = path.join(binDirectory, 'colcon');
        fs.writeFileSync(colconExecutable, '#!/bin/sh\\nexit 0\\n');
        fs.chmodSync(colconExecutable, 0o755);

        const result = detectRosBuildEnvironment(rosInstallRoot, binDirectory);

        assert.deepStrictEqual(result.installedRosDistros, ['humble']);
        assert.strictEqual(result.colconPath, colconExecutable);
    });
});


suite('ROS 2 package discovery', () => {
    let temporaryRoot: string;

    setup(() => {
        temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ros2-assistant-packages-'));
    });

    teardown(() => {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    });

    test('parses package metadata, build type, and dependency categories', () => {
        const manifestPath = path.join(temporaryRoot, 'src', 'demo_pkg', 'package.xml');
        const manifest = `<?xml version="1.0"?>
<package format="3">
    <!-- package metadata -->
    <name>demo_pkg</name>
    <version>1.2.3</version>
    <description>Demo &amp; testing package</description>
    <buildtool_depend>ament_cmake</buildtool_depend>
    <depend>rclcpp</depend>
    <exec_depend>sensor_msgs</exec_depend>
    <test_depend>ament_lint_auto</test_depend>
    <export><build_type>ament_cmake</build_type></export>
</package>`;

        const result = parseRosPackageManifest(manifest, manifestPath, temporaryRoot);

        assert.strictEqual(result.name, 'demo_pkg');
        assert.strictEqual(result.version, '1.2.3');
        assert.strictEqual(result.description, 'Demo & testing package');
        assert.strictEqual(result.buildType, 'ament_cmake');
        assert.strictEqual(result.relativePath, path.join('src', 'demo_pkg'));
        assert.deepStrictEqual(result.dependencies, [
            { name: 'rclcpp', kind: 'depend' },
            { name: 'ament_cmake', kind: 'buildtool_depend' },
            { name: 'sensor_msgs', kind: 'exec_depend' },
            { name: 'ament_lint_auto', kind: 'test_depend' }
        ]);
    });

    test('discovers nested packages in a stable order and skips generated folders', () => {
        const sourceDirectory = path.join(temporaryRoot, 'src');
        const firstPackage = path.join(sourceDirectory, 'drivers', 'camera_driver');
        const secondPackage = path.join(sourceDirectory, 'interfaces');
        const generatedPackage = path.join(temporaryRoot, 'build', 'generated_pkg');
        const hiddenPackage = path.join(sourceDirectory, '.hidden', 'hidden_pkg');

        for (const directory of [firstPackage, secondPackage, generatedPackage, hiddenPackage]) {
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(path.join(directory, 'package.xml'),
                '<package format="3"><name>' + path.basename(directory) + '</name><version>0.0.1</version></package>');
        }

        const result = discoverRos2Packages(temporaryRoot);

        assert.strictEqual(result.manifestCount, 2);
        assert.deepStrictEqual(result.packages.map(pkg => pkg.name), ['camera_driver', 'interfaces']);
        assert.strictEqual(result.packages[0].relativePath, path.join('src', 'drivers', 'camera_driver'));
        assert.deepStrictEqual(result.issues, []);
    });

    test('reports malformed manifests without discarding valid packages', () => {
        const sourceDirectory = path.join(temporaryRoot, 'src');
        const validDirectory = path.join(sourceDirectory, 'valid_pkg');
        const invalidDirectory = path.join(sourceDirectory, 'invalid_pkg');
        fs.mkdirSync(validDirectory, { recursive: true });
        fs.mkdirSync(invalidDirectory, { recursive: true });
        fs.writeFileSync(path.join(validDirectory, 'package.xml'),
            '<package format="3"><name>valid_pkg</name></package>');
        fs.writeFileSync(path.join(invalidDirectory, 'package.xml'),
            '<package><name>invalid_pkg</name>');

        const result = discoverRos2Packages(temporaryRoot);

        assert.strictEqual(result.manifestCount, 2);
        assert.deepStrictEqual(result.packages.map(pkg => pkg.name), ['valid_pkg']);
        assert.strictEqual(result.issues.length, 1);
        assert.match(result.issues[0].message, /well-formed/);
    });

    test('identifies duplicate package names in different directories', () => {
        const sourceDirectory = path.join(temporaryRoot, 'src');
        for (const parent of ['one', 'two']) {
            const directory = path.join(sourceDirectory, parent, 'shared_pkg');
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(path.join(directory, 'package.xml'),
                '<package format="3"><name>shared_pkg</name></package>');
        }

        const result = discoverRos2Packages(temporaryRoot);

        assert.deepStrictEqual(result.duplicatePackageNames, ['shared_pkg']);
        assert.strictEqual(result.packages.length, 2);
    });
});
