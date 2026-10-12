import * as assert from 'assert';
import { ProcessManager, formatProcessError } from '../core/processManager';

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


import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectRos2Workspace } from '../build/workspaceManager';

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

    test('does not classify an ordinary source folder as a ROS 2 workspace', () => {
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
});
