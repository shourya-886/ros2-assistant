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
