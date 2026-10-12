import * as fs from 'fs';
import * as path from 'path';

export type WorkspaceDetectionStatus = 'detected' | 'incomplete' | 'not-found';

export interface WorkspaceIndicators {
    src: boolean;
    build: boolean;
    install: boolean;
    log: boolean;
}

export interface WorkspaceDetectionResult {
    status: WorkspaceDetectionStatus;
    workspaceRoot?: string;
    sourceDirectory?: string;
    packageManifestCount: number;
    indicators: WorkspaceIndicators;
    message: string;
}

const IGNORED_DIRECTORIES = new Set([
    '.git',
    'build',
    'install',
    'log',
    'node_modules',
    '__pycache__'
]);

const MAX_SCAN_DEPTH = 10;
const MAX_SCANNED_DIRECTORIES = 5000;

function isDirectory(directoryPath: string): boolean {
    try {
        return fs.lstatSync(directoryPath).isDirectory();
    } catch {
        return false;
    }
}

/**
 * Counts ROS package manifests beneath a workspace's src directory.
 * Generated directories and symlinks are skipped to keep the scan bounded.
 */
function countPackageManifests(sourceDirectory: string): number {
    let count = 0;
    let scannedDirectories = 0;

    const scan = (directory: string, depth: number): void => {
        if (depth > MAX_SCAN_DEPTH || scannedDirectories >= MAX_SCANNED_DIRECTORIES) {
            return;
        }

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }

        scannedDirectories++;

        for (const entry of entries) {
            if (entry.isFile() && entry.name === 'package.xml') {
                count++;
                continue;
            }

            if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) {
                scan(path.join(directory, entry.name), depth + 1);
            }
        }
    };

    scan(sourceDirectory, 0);
    return count;
}

function getIndicators(workspaceRoot: string): WorkspaceIndicators {
    return {
        src: isDirectory(path.join(workspaceRoot, 'src')),
        build: isDirectory(path.join(workspaceRoot, 'build')),
        install: isDirectory(path.join(workspaceRoot, 'install')),
        log: isDirectory(path.join(workspaceRoot, 'log'))
    };
}

function notFound(): WorkspaceDetectionResult {
    return {
        status: 'not-found',
        packageManifestCount: 0,
        indicators: { src: false, build: false, install: false, log: false },
        message: 'No ROS 2 workspace was found in this folder or its parent directories.'
    };
}

/**
 * Detects a ROS 2 colcon workspace from a folder or any folder nested inside it.
 *
 * A src directory containing at least one package.xml is considered a detected
 * workspace. An empty src directory is reported as incomplete so newly-created
 * workspace skeletons can still be identified without treating every source
 * project as a ROS 2 workspace.
 */
export function detectRos2Workspace(startPath: string): WorkspaceDetectionResult {
    if (!startPath.trim()) {
        return notFound();
    }

    let currentPath = path.resolve(startPath);
    try {
        if (!fs.statSync(currentPath).isDirectory()) {
            currentPath = path.dirname(currentPath);
        }
    } catch {
        return notFound();
    }

    let incompleteCandidate: WorkspaceDetectionResult | undefined;

    while (true) {
        const indicators = getIndicators(currentPath);
        if (indicators.src) {
            const sourceDirectory = path.join(currentPath, 'src');
            const packageManifestCount = countPackageManifests(sourceDirectory);

            if (packageManifestCount > 0) {
                return {
                    status: 'detected',
                    workspaceRoot: currentPath,
                    sourceDirectory,
                    packageManifestCount,
                    indicators,
                    message: `ROS 2 workspace detected. Found ${packageManifestCount} package.xml manifest(s).`
                };
            }

            if (!incompleteCandidate) {
                incompleteCandidate = {
                    status: 'incomplete',
                    workspaceRoot: currentPath,
                    sourceDirectory,
                    packageManifestCount: 0,
                    indicators,
                    message: 'Found a src directory, but no package.xml manifests. This may be a new or incomplete ROS 2 workspace.'
                };
            }
        }

        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) {
            break;
        }
        currentPath = parentPath;
    }

    return incompleteCandidate ?? notFound();
}


export interface RosBuildEnvironment {
    installedRosDistros: string[];
    activeRosDistro?: string;
    colconPath?: string;
}

/** Checks common ROS 2 installations and searches PATH for an executable colcon command. */
export function detectRosBuildEnvironment(
    rosInstallRoot = '/opt/ros',
    searchPath = process.env.PATH ?? ''
): RosBuildEnvironment {
    let installedRosDistros: string[] = [];
    try {
        installedRosDistros = fs.readdirSync(rosInstallRoot, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .filter(distro => fs.existsSync(path.join(rosInstallRoot, distro, 'setup.bash')));
    } catch {
        // A missing /opt/ros directory simply means no standard ROS installation was found.
    }

    let colconPath: string | undefined;
    for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
        const candidate = path.join(directory, 'colcon');
        try {
            if (fs.statSync(candidate).isFile()) {
                fs.accessSync(candidate, fs.constants.X_OK);
                colconPath = candidate;
                break;
            }
        } catch {
            // Continue searching the remaining PATH entries.
        }
    }

    return {
        installedRosDistros,
        activeRosDistro: process.env.ROS_DISTRO,
        colconPath
    };
}
