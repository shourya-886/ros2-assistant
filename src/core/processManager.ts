import {
    exec as nodeExec, execFile as nodeExecFile, spawn as nodeSpawn,
    type ChildProcess, type ExecException, type ExecOptionsWithStringEncoding,
    type ExecFileOptionsWithStringEncoding, type SpawnOptions
} from 'child_process';
import { EventEmitter } from 'events';

export type ProcessState = 'running' | 'exited' | 'failed';
export interface ProcessSnapshot {
    id: number; pid?: number; command: string; state: ProcessState;
    startedAt: number; finishedAt?: number; exitCode?: number | null;
    signal?: NodeJS.Signals | null; error?: string;
}
export interface ProcessOutput {
    id: number; pid?: number; stream: 'stdout' | 'stderr'; data: string; timestamp: number;
}

/** Shared child-process lifecycle, status tracking, and output streaming. */
export class ProcessManager extends EventEmitter {
    private readonly processes = new Map<number, ProcessSnapshot>();
    private nextId = 1;
    private readonly historyLimit = 100;

    exec(command: string, options: ExecOptionsWithStringEncoding,
        callback: (error: ExecException | null, stdout: string, stderr: string) => void): ChildProcess {
        const child = nodeExec(command, options, callback);
        this.track(child, command);
        return child;
    }
    execFile(file: string, args: readonly string[], options: ExecFileOptionsWithStringEncoding,
        callback: (error: ExecException | null, stdout: string, stderr: string) => void): ChildProcess {
        const child = nodeExecFile(file, [...args], options, callback);
        this.track(child, [file, ...args].join(' '));
        return child;
    }
    spawn(command: string, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
        const child = nodeSpawn(command, [...args], options);
        this.track(child, [command, ...args].join(' '));
        return child;
    }
    getActiveProcesses(): ProcessSnapshot[] {
        return [...this.processes.values()].filter(item => item.state === 'running').map(item => ({ ...item }));
    }
    getProcessStatus(pid: number): ProcessSnapshot | undefined {
        const item = [...this.processes.values()].find(entry => entry.pid === pid);
        return item ? { ...item } : undefined;
    }
    getProcessHistory(): ProcessSnapshot[] {
        return [...this.processes.values()].map(item => ({ ...item }));
    }
    terminate(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM', escalationDelayMs = 3000): boolean {
        if (child.exitCode !== null || child.signalCode !== null || child.killed) return false;
        const sent = child.kill(signal);
        if (sent && escalationDelayMs > 0) {
            const timer = setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            }, escalationDelayMs);
            timer.unref();
        }
        return sent;
    }
    private track(child: ChildProcess, command: string): void {
        const snapshot: ProcessSnapshot = {
            id: this.nextId++, pid: child.pid, command, state: 'running', startedAt: Date.now()
        };
        this.processes.set(snapshot.id, snapshot);
        this.emit('started', { ...snapshot });
        child.stdout?.on('data', chunk => this.emitOutput(snapshot, 'stdout', chunk));
        child.stderr?.on('data', chunk => this.emitOutput(snapshot, 'stderr', chunk));
        child.once('error', error => {
            snapshot.state = 'failed'; snapshot.error = error.message; snapshot.finishedAt = Date.now();
            this.emit('status', { ...snapshot }); this.trimHistory();
        });
        child.once('close', (exitCode, signal) => {
            if (snapshot.state !== 'failed') snapshot.state = exitCode === 0 ? 'exited' : 'failed';
            snapshot.exitCode = exitCode; snapshot.signal = signal; snapshot.finishedAt = Date.now();
            this.emit('status', { ...snapshot }); this.trimHistory();
        });
    }
    private emitOutput(snapshot: ProcessSnapshot, stream: 'stdout' | 'stderr', chunk: Buffer | string): void {
        const event: ProcessOutput = {
            id: snapshot.id, pid: snapshot.pid, stream, data: chunk.toString(), timestamp: Date.now()
        };
        this.emit('output', event);
        this.emit(stream, event);
    }
    private trimHistory(): void {
        if (this.processes.size <= this.historyLimit) return;
        for (const [id, item] of this.processes) {
            if (this.processes.size <= this.historyLimit) break;
            if (item.state !== 'running') this.processes.delete(id);
        }
    }
}

/** Consistent error formatting for feature panels and logs. */
export function formatProcessError(operation: string, error?: Error | null, stderr = '', stdout = ''): string {
    const detail = stderr.trim() || stdout.trim() || error?.message || 'Unknown process error.';
    return `${operation} failed: ${detail}`;
}
export const processManager = new ProcessManager();
