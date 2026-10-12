import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BuildManager } from '../build/buildManager';
import type { BuildSnapshot } from '../build/buildManager';
import { ProcessManager } from '../core/processManager';

suite('ROS 2 build execution', () => {
    let temporaryRoot: string;
    let workspaceRoot: string;
    let binDirectory: string;

    setup(() => {
        temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ros2-assistant-build-'));
        workspaceRoot = path.join(temporaryRoot, 'robot_ws');
        binDirectory = path.join(temporaryRoot, 'bin');
        fs.mkdirSync(path.join(workspaceRoot, 'src'), { recursive: true });
        fs.mkdirSync(binDirectory, { recursive: true });
    });

    teardown(() => {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    });

    function createColcon(exitCode = 0): void {
        const executable = path.join(binDirectory, 'colcon');
        fs.writeFileSync(executable, '#!/bin/sh\nprintf "FAKE_COLCON:%s\\n" "$*"\nexit ' + exitCode + '\n');
        fs.chmodSync(executable, 0o755);
    }

    function createManager(): BuildManager {
        const ros = {
            isConfigured: true,
            withEnvironment: (command: string) => 'export PATH=' + binDirectory + ':$PATH && ' + command
        };
        return new BuildManager(new ProcessManager(), ros);
    }

    test('runs colcon in the workspace, streams output, and reports success', async () => {
        createColcon();
        const manager = createManager();
        const output: string[] = [];
        manager.on('output', event => output.push(event.data));

        const finalStatus = new Promise<BuildSnapshot>(resolve => manager.once('status', resolve));
        const started = manager.startBuild({
            workspaceRoot,
            packages: ['bumperbot_description', 'bumperbot_bringup'],
            symlinkInstall: true
        });
        assert.strictEqual(started.status, 'running');
        assert.strictEqual(started.command,
            'colcon build --symlink-install --packages-select bumperbot_description bumperbot_bringup');

        const result = await finalStatus;
        assert.strictEqual(result.status, 'succeeded');
        assert.strictEqual(result.exitCode, 0);
        assert.ok(output.join('').includes('FAKE_COLCON:build --symlink-install --packages-select bumperbot_description bumperbot_bringup'));
        assert.strictEqual(manager.getActiveBuild(), undefined);
        manager.dispose();
    });

    test('omits symlink-install when disabled', async () => {
        createColcon();
        const manager = createManager();
        const finalStatus = new Promise<BuildSnapshot>(resolve => manager.once('status', resolve));

        const started = manager.startBuild({ workspaceRoot, symlinkInstall: false });
        assert.strictEqual(started.command, 'colcon build');

        const result = await finalStatus;
        assert.strictEqual(result.status, 'succeeded');
        manager.dispose();
    });

    test('rejects invalid package filters before starting a process', () => {
        createColcon();
        const manager = createManager();

        assert.throws(
            () => manager.startBuild({ workspaceRoot, packages: ['valid_pkg; rm -rf /'] }),
            /valid ROS package names/
        );
        assert.strictEqual(manager.getActiveBuild(), undefined);
        manager.dispose();
    });

    test('rejects a folder without a src directory', () => {
        createColcon();
        const manager = createManager();
        const invalidWorkspace = path.join(temporaryRoot, 'not_a_workspace');
        fs.mkdirSync(invalidWorkspace);

        assert.throws(
            () => manager.startBuild({ workspaceRoot: invalidWorkspace }),
            /src directory not found/
        );
        manager.dispose();
    });

    test('reports a non-zero colcon exit as a failed build', async () => {
        createColcon(2);
        const manager = createManager();
        const finalStatus = new Promise<BuildSnapshot>(resolve => manager.once('status', resolve));

        manager.startBuild({ workspaceRoot });
        const result = await finalStatus;

        assert.strictEqual(result.status, 'failed');
        assert.strictEqual(result.exitCode, 2);
        manager.dispose();
    });
});
