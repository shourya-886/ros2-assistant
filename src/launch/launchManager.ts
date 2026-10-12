import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { processManager } from '../core/processManager';
import type { ProcessManager } from '../core/processManager';
import { rosEnvironment } from '../core/rosEnvironment';
import type { RosEnvironmentManager } from '../core/rosEnvironment';

export interface LaunchArgument {
    name: string;
    defaultValue?: string;
    description?: string;
}

export interface LaunchFileInfo {
    packageName: string;
    packagePath: string;
    workspaceRoot: string;
    filePath: string;
    fileName: string;
    relativePath: string;
    extension: 'py' | 'xml' | 'yaml' | 'yml';
    arguments: LaunchArgument[];
}

export interface LaunchDiscoveryIssue {
    path: string;
    message: string;
}

export interface LaunchDiscoveryResult {
    workspaceRoot: string;
    packagesScanned: number;
    launchFiles: LaunchFileInfo[];
    issues: LaunchDiscoveryIssue[];
    scanLimitReached: boolean;
}

export type LaunchSessionStatus = 'running' | 'succeeded' | 'failed' | 'stopped';

export interface LaunchSessionSnapshot {
    id: number;
    packageName: string;
    launchFile: string;
    launchFilePath: string;
    workspaceRoot: string;
    arguments: Record<string, string>;
    startedAt: number;
    finishedAt?: number;
    pid?: number;
    status: LaunchSessionStatus;
    exitCode?: number | null;
    signal?: NodeJS.Signals | null;
    error?: string;
}

export interface LaunchOutput {
    launchId: number;
    stream: 'stdout' | 'stderr';
    data: string;
    timestamp: number;
}

type RosEnvironment = Pick<RosEnvironmentManager, 'isConfigured' | 'withEnvironment'>;

const IGNORED_DIRECTORIES = new Set([
    '.git', 'build', 'install', 'log', 'node_modules', '__pycache__', '.venv'
]);
const LAUNCH_FILE_PATTERN = /\.launch\.(py|xml|yaml|yml)$/i;
const MAX_SCAN_DEPTH = 10;
const MAX_SCANNED_DIRECTORIES = 5000;
const MAX_LAUNCH_DEPTH = 6;

function packageNameFromManifest(manifestPath: string): string | undefined {
    try {
        const xml = fs.readFileSync(manifestPath, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
        const match = xml.match(/<(?:[\w.-]+:)?name(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?name\s*>/i);
        const name = match?.[1].replace(/<[^>]+>/g, '').trim();
        return name && /^[a-z][a-z0-9_]*$/.test(name) ? name : undefined;
    } catch {
        return undefined;
    }
}

function readLaunchDirectory(
    packageName: string,
    packagePath: string,
    workspaceRoot: string,
    launchDirectory: string,
    issues: LaunchDiscoveryIssue[]
): LaunchFileInfo[] {
    const files: LaunchFileInfo[] = [];
    let scanned = 0;

    const scan = (directory: string, depth: number): void => {
        if (depth > MAX_LAUNCH_DEPTH || scanned >= MAX_SCANNED_DIRECTORIES) {
            return;
        }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch (error) {
            issues.push({
                path: directory,
                message: error instanceof Error ? error.message : 'Unable to read launch directory.'
            });
            return;
        }
        scanned++;

        for (const entry of entries) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isSymbolicLink()) {
                continue;
            }
            if (entry.isDirectory() && !entry.name.startsWith('.') && !IGNORED_DIRECTORIES.has(entry.name)) {
                scan(entryPath, depth + 1);
            } else if (entry.isFile()) {
                const match = entry.name.match(LAUNCH_FILE_PATTERN);
                if (!match) {
                    continue;
                }
                let content = '';
                try {
                    content = fs.readFileSync(entryPath, 'utf8');
                } catch (error) {
                    issues.push({
                        path: entryPath,
                        message: error instanceof Error ? error.message : 'Unable to read launch file.'
                    });
                    continue;
                }
                files.push({
                    packageName,
                    packagePath,
                    workspaceRoot,
                    filePath: entryPath,
                    fileName: entry.name,
                    relativePath: path.relative(workspaceRoot, entryPath),
                    extension: match[1].toLowerCase() as LaunchFileInfo['extension'],
                    arguments: parseLaunchArguments(content, match[1].toLowerCase())
                });
            }
        }
    };

    scan(launchDirectory, 0);
    return files;
}

/** Extracts statically declared launch arguments. Dynamic Python expressions are intentionally omitted. */
export function parseLaunchArguments(content: string, extension: string): LaunchArgument[] {
    const result: LaunchArgument[] = [];
    const seen = new Set<string>();
    const add = (argument: LaunchArgument): void => {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(argument.name) && !seen.has(argument.name)) {
            seen.add(argument.name);
            result.push(argument);
        }
    };

    if (extension === 'py') {
        const declarations = /DeclareLaunchArgument\s*\(\s*(?:name\s*=\s*)?(['"])([^'"]+)\1([\s\S]{0,800}?)\)/g;
        for (const match of content.matchAll(declarations)) {
            const tail = match[3];
            const defaultMatch = tail.match(/default_value\s*=\s*(['"])([\s\S]*?)\1/);
            const descriptionMatch = tail.match(/description\s*=\s*(['"])([\s\S]*?)\1/);
            add({
                name: match[2],
                defaultValue: defaultMatch?.[2],
                description: descriptionMatch?.[2]
            });
        }
    } else if (extension === 'xml') {
        const declarations = /<arg\b([^>]*)\/?\s*>/gi;
        for (const match of content.matchAll(declarations)) {
            const attributes: Record<string, string> = {};
            for (const attribute of match[1].matchAll(/([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
                attributes[attribute[1]] = attribute[2] ?? attribute[3] ?? '';
            }
            if (attributes.name) {
                add({
                    name: attributes.name,
                    defaultValue: attributes.default,
                    description: attributes.description
                });
            }
        }
    } else if (extension === 'yaml' || extension === 'yml') {
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
            const nameMatch = lines[index].match(/\bname\s*:\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*$/);
            if (!nameMatch) {
                continue;
            }
            let defaultValue: string | undefined;
            for (let lookahead = index + 1; lookahead < Math.min(lines.length, index + 7); lookahead++) {
                const defaultMatch = lines[lookahead].match(/\bdefault\s*:\s*(?:['"]([^'"]*)['"]|([^\s#]+))/);
                if (defaultMatch) {
                    defaultValue = defaultMatch[1] ?? defaultMatch[2];
                    break;
                }
                if (/^\s*-\s/.test(lines[lookahead])) {
                    break;
                }
            }
            add({ name: nameMatch[1], defaultValue });
        }
    }

    return result;
}

/** Discovers launch files below package launch/ directories in a ROS 2 workspace src tree. */
export function discoverLaunchFiles(workspaceRoot: string): LaunchDiscoveryResult {
    const root = path.resolve(workspaceRoot);
    const sourceDirectory = path.join(root, 'src');
    const launchFiles: LaunchFileInfo[] = [];
    const issues: LaunchDiscoveryIssue[] = [];
    let packagesScanned = 0;
    let scannedDirectories = 0;
    let scanLimitReached = false;

    if (!fs.existsSync(sourceDirectory) || !fs.statSync(sourceDirectory).isDirectory()) {
        issues.push({ path: sourceDirectory, message: 'Workspace src directory was not found.' });
        return { workspaceRoot: root, packagesScanned, launchFiles, issues, scanLimitReached };
    }

    const scanPackages = (directory: string, depth: number): void => {
        if (depth > MAX_SCAN_DEPTH || scannedDirectories >= MAX_SCANNED_DIRECTORIES) {
            scanLimitReached = true;
            return;
        }
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch (error) {
            issues.push({
                path: directory,
                message: error instanceof Error ? error.message : 'Unable to read source directory.'
            });
            return;
        }
        scannedDirectories++;

        const manifest = entries.find(entry => entry.isFile() && entry.name === 'package.xml');
        if (manifest) {
            const packagePath = directory;
            const packageName = packageNameFromManifest(path.join(directory, manifest.name));
            if (!packageName) {
                issues.push({ path: path.join(directory, manifest.name), message: 'Could not read a valid package name.' });
                return;
            }
            packagesScanned++;
            const launchDirectory = path.join(packagePath, 'launch');
            if (fs.existsSync(launchDirectory) && fs.statSync(launchDirectory).isDirectory()) {
                launchFiles.push(...readLaunchDirectory(packageName, packagePath, root, launchDirectory, issues));
            }
            return;
        }

        for (const entry of entries) {
            if (entry.isDirectory() && !entry.isSymbolicLink()
                && !entry.name.startsWith('.') && !IGNORED_DIRECTORIES.has(entry.name)) {
                scanPackages(path.join(directory, entry.name), depth + 1);
            }
        }
    };

    scanPackages(sourceDirectory, 0);
    launchFiles.sort((a, b) => a.packageName.localeCompare(b.packageName) || a.relativePath.localeCompare(b.relativePath));
    if (scanLimitReached) {
        issues.push({ path: sourceDirectory, message: 'Launch discovery reached its scan safety limit.' });
    }
    return { workspaceRoot: root, packagesScanned, launchFiles, issues, scanLimitReached };
}

/** Tracks multiple ros2 launch processes and exposes output and lifecycle events. */
export class LaunchManager extends EventEmitter {
    private readonly sessions = new Map<number, LaunchSessionSnapshot>();
    private readonly children = new Map<number, ChildProcess>();
    private nextId = 1;

    constructor(
        private readonly processes: ProcessManager = processManager,
        private readonly ros: RosEnvironment = rosEnvironment
    ) {
        super();
    }

    getSessions(): LaunchSessionSnapshot[] {
        return [...this.sessions.values()].sort((a, b) => b.startedAt - a.startedAt).map(session => ({
            ...session,
            arguments: { ...session.arguments }
        }));
    }

    startLaunch(
        launchFile: LaunchFileInfo,
        argumentsMap: Record<string, string>,
        extraArguments: string[] = []
    ): LaunchSessionSnapshot {
        if (!this.ros.isConfigured) {
            throw new Error('ROS 2 environment has not been configured.');
        }
        const workspaceRoot = path.resolve(launchFile.workspaceRoot);
        const filePath = path.resolve(launchFile.filePath);
        const relative = path.relative(workspaceRoot, filePath);
        if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !fs.existsSync(filePath)) {
            throw new Error('The selected launch file is outside the workspace or no longer exists.');
        }
        if (!/^[a-z][a-z0-9_]*$/.test(launchFile.packageName)) {
            throw new Error('Invalid ROS package name.');
        }

        const cliArguments: string[] = [];
        const seen = new Set<string>();
        for (const [name, value] of Object.entries(argumentsMap)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string' || value.includes('\0')) {
                throw new Error('Launch arguments must have valid names and string values.');
            }
            if (seen.has(name)) {
                throw new Error('Duplicate launch argument: ' + name);
            }
            seen.add(name);
            cliArguments.push(name + ':=' + value);
        }
        for (const rawArgument of extraArguments) {
            const separator = rawArgument.indexOf(':=');
            const name = separator > 0 ? rawArgument.slice(0, separator).trim() : '';
            const value = separator > 0 ? rawArgument.slice(separator + 2) : '';
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes('\0')) {
                throw new Error('Additional arguments must use name:=value syntax.');
            }
            if (seen.has(name)) {
                throw new Error('Launch argument was specified more than once: ' + name);
            }
            seen.add(name);
            cliArguments.push(name + ':=' + value);
        }

        const id = this.nextId++;
        const snapshot: LaunchSessionSnapshot = {
            id,
            packageName: launchFile.packageName,
            launchFile: launchFile.fileName,
            launchFilePath: filePath,
            workspaceRoot,
            arguments: { ...argumentsMap },
            startedAt: Date.now(),
            status: 'running'
        };
        const script = this.ros.withEnvironment(
            'package="$1" && launch_file="$2" && shift 2 && exec ros2 launch "$package" "$launch_file" "$@"'
        );
        const child = this.processes.spawn(
            'bash',
            ['-c', script, 'ros2-launch', launchFile.packageName, launchFile.fileName, ...cliArguments],
            {
                cwd: workspaceRoot,
                env: { ...process.env, PYTHONUNBUFFERED: '1' },
                stdio: ['ignore', 'pipe', 'pipe']
            }
        );
        snapshot.pid = child.pid;
        this.sessions.set(id, snapshot);
        this.children.set(id, child);
        this.emit('started', { ...snapshot });

        child.stdout?.on('data', chunk => this.emit('output', {
            launchId: id, stream: 'stdout', data: chunk.toString(), timestamp: Date.now()
        } satisfies LaunchOutput));
        child.stderr?.on('data', chunk => this.emit('output', {
            launchId: id, stream: 'stderr', data: chunk.toString(), timestamp: Date.now()
        } satisfies LaunchOutput));

        let finalized = false;
        const finish = (status: LaunchSessionStatus, exitCode: number | null, signal: NodeJS.Signals | null, error?: string) => {
            if (finalized) {
                return;
            }
            finalized = true;
            snapshot.status = status;
            snapshot.exitCode = exitCode;
            snapshot.signal = signal;
            snapshot.finishedAt = Date.now();
            if (error) {
                snapshot.error = error;
            }
            this.children.delete(id);
            this.emit('status', { ...snapshot });
        };
        child.once('error', error => finish('failed', null, null, error.message));
        child.once('close', (exitCode, signal) => {
            const current = this.sessions.get(id);
            const stopped = current?.status === 'stopped';
            finish(stopped ? 'stopped' : exitCode === 0 ? 'succeeded' : 'failed', exitCode, signal);
        });

        return { ...snapshot, arguments: { ...snapshot.arguments } };
    }

    stopLaunch(id: number): boolean {
        const child = this.children.get(id);
        const session = this.sessions.get(id);
        if (!child || !session || session.status !== 'running') {
            return false;
        }
        session.status = 'stopped';
        this.emit('status', { ...session });
        return this.processes.terminate(child, 'SIGINT', 5000);
    }

    async getNodes(): Promise<string[]> {
        if (!this.ros.isConfigured) {
            throw new Error('ROS 2 environment has not been configured.');
        }
        const script = this.ros.withEnvironment('exec ros2 node list');
        return new Promise((resolve, reject) => {
            this.processes.execFile('bash', ['-c', script], { env: process.env }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error((stderr || error.message).trim()));
                    return;
                }
                resolve([...new Set(stdout.split(/\r?\n/).map(node => node.trim()).filter(Boolean))].sort());
            });
        });
    }

    dispose(): void {
        for (const id of this.children.keys()) {
            this.stopLaunch(id);
        }
        this.removeAllListeners();
    }
}
