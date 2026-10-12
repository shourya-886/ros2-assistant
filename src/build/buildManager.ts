import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { ProcessManager, processManager } from '../core/processManager';
import { RosEnvironmentManager, rosEnvironment } from '../core/rosEnvironment';

export interface ColconBuildOptions {
    workspaceRoot: string;
    packages?: string[];
    symlinkInstall?: boolean;
    continueOnError?: boolean;
}

export type BuildStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface BuildSnapshot {
    id: number;
    workspaceRoot: string;
    command: string;
    status: BuildStatus;
    startedAt: number;
    finishedAt?: number;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    error?: string;
}

export interface BuildOutput {
    stream: 'stdout' | 'stderr';
    data: string;
    timestamp: number;
}

interface ActiveBuild {
    child: ChildProcess;
    snapshot: BuildSnapshot;
    cancelRequested: boolean;
    finalized: boolean;
}

type RosEnvironment = Pick<RosEnvironmentManager, 'isConfigured' | 'withEnvironment'>;

/** Runs one colcon build at a time and exposes output and lifecycle events. */
export class BuildManager extends EventEmitter {
    private activeBuild?: ActiveBuild;
    private nextBuildId = 1;

    constructor(
        private readonly processes: ProcessManager = processManager,
        private readonly ros: RosEnvironment = rosEnvironment
    ) {
        super();
    }

    getActiveBuild(): BuildSnapshot | undefined {
        return this.activeBuild ? { ...this.activeBuild.snapshot } : undefined;
    }

    startBuild(options: ColconBuildOptions): BuildSnapshot {
        if (this.activeBuild) {
            throw new Error('A colcon build is already running.');
        }
        if (!this.ros.isConfigured) {
            throw new Error('ROS 2 environment has not been configured.');
        }
        if (!options.workspaceRoot.trim() || !fs.existsSync(options.workspaceRoot)
            || !fs.statSync(options.workspaceRoot).isDirectory()
            || !fs.existsSync(path.join(options.workspaceRoot, 'src'))
            || !fs.statSync(require('path').join(options.workspaceRoot, 'src')).isDirectory()) {
            throw new Error('The selected folder is not a valid ROS 2 workspace (src directory not found).');
        }

        const packages = options.packages ?? [];
        if (packages.some(name => !/^[a-z][a-z0-9_]*$/.test(name))) {
            throw new Error('Package filters must contain valid ROS package names.');
        }

        const args = ['build'];
        if (options.symlinkInstall) {
            args.push('--symlink-install');
        }
        if (options.continueOnError) {
            args.push('--continue-on-error');
        }
        if (packages.length > 0) {
            args.push('--packages-select', ...packages);
        }

        const command = this.ros.withEnvironment(
            'command -v colcon >/dev/null 2>&1 || { echo "colcon was not found on PATH after sourcing ROS 2." >&2; exit 127; }; '
            + 'exec colcon ' + args.join(' ')
        );
        const snapshot: BuildSnapshot = {
            id: this.nextBuildId++,
            workspaceRoot: options.workspaceRoot,
            command: 'colcon ' + args.join(' '),
            status: 'running',
            startedAt: Date.now()
        };

        const child = this.processes.spawn('bash', ['-c', command], {
            cwd: options.workspaceRoot,
            env: { ...process.env, PYTHONUNBUFFERED: '1' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const active: ActiveBuild = {
            child,
            snapshot,
            cancelRequested: false,
            finalized: false
        };
        this.activeBuild = active;
        this.emit('started', { ...snapshot });

        child.stdout?.on('data', chunk => this.emit('output', {
            stream: 'stdout',
            data: chunk.toString(),
            timestamp: Date.now()
        } satisfies BuildOutput));
        child.stderr?.on('data', chunk => this.emit('output', {
            stream: 'stderr',
            data: chunk.toString(),
            timestamp: Date.now()
        } satisfies BuildOutput));

        child.once('error', error => {
            snapshot.error = error.message;
            this.finishBuild(active, null, null);
        });
        child.once('close', (exitCode, signal) => this.finishBuild(active, exitCode, signal));

        return { ...snapshot };
    }

    cancelBuild(): boolean {
        if (!this.activeBuild) {
            return false;
        }
        this.activeBuild.cancelRequested = true;
        return this.processes.terminate(this.activeBuild.child, 'SIGINT', 5000);
    }

    dispose(): void {
        this.cancelBuild();
        this.removeAllListeners();
    }

    private finishBuild(
        active: ActiveBuild,
        exitCode: number | null,
        signal: NodeJS.Signals | null
    ): void {
        if (active.finalized) {
            return;
        }
        active.finalized = true;
        const snapshot = active.snapshot;
        snapshot.exitCode = exitCode;
        snapshot.signal = signal;
        snapshot.finishedAt = Date.now();
        if (active.cancelRequested) {
            snapshot.status = 'cancelled';
        } else {
            snapshot.status = exitCode === 0 ? 'succeeded' : 'failed';
        }
        if (this.activeBuild === active) {
            this.activeBuild = undefined;
        }
        this.emit('status', { ...snapshot });
    }
}
