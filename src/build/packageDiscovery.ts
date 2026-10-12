import * as fs from 'fs';
import * as path from 'path';

export type RosPackageBuildType = 'ament_cmake' | 'ament_python' | 'cmake' | 'catkin' | 'unknown';

export type RosPackageDependencyKind =
    | 'depend'
    | 'buildtool_depend'
    | 'build_depend'
    | 'build_export_depend'
    | 'exec_depend'
    | 'test_depend'
    | 'doc_depend'
    | 'group_depend'
    | 'member_of_group';

export interface RosPackageDependency {
    name: string;
    kind: RosPackageDependencyKind;
}

export interface RosPackageInfo {
    name: string;
    version?: string;
    description?: string;
    buildType: RosPackageBuildType;
    packagePath: string;
    relativePath: string;
    manifestPath: string;
    dependencies: RosPackageDependency[];
}

export interface PackageDiscoveryIssue {
    manifestPath: string;
    message: string;
}

export interface PackageDiscoveryResult {
    workspaceRoot: string;
    sourceDirectory: string;
    manifestCount: number;
    packages: RosPackageInfo[];
    issues: PackageDiscoveryIssue[];
    duplicatePackageNames: string[];
    scanLimitReached: boolean;
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

function decodeXmlEntities(value: string): string {
    return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, code: string) => {
        const named: Record<string, string> = {
            amp: '&',
            lt: '<',
            gt: '>',
            quot: '"',
            apos: "'"
        };
        if (code[0] !== '#') {
            return named[code.toLowerCase()] ?? entity;
        }
        const numeric = code[1].toLowerCase() === 'x'
            ? Number.parseInt(code.slice(2), 16)
            : Number.parseInt(code.slice(1), 10);
        try {
            return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : entity;
        } catch {
            return entity;
        }
    });
}

function extractTagValues(xml: string, tagName: string): string[] {
    const escapedName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expression = new RegExp(
        '<(?:[\\w.-]+:)?' + escapedName + '(?:\\s+(?:"[^"]*"|\\'[^\\']*\\'|[^\\'">])*)?\\s*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?' + escapedName + '\\s*>',
        'gi'
    );

    return [...xml.matchAll(expression)].map(match => {
        const raw = match[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1');
        return decodeXmlEntities(raw.replace(/<[^>]+>/g, '').trim());
    }).filter(Boolean);
}

/** Parses the metadata used by the Build Manager from a ROS package.xml manifest. */
export function parseRosPackageManifest(
    manifestText: string,
    manifestPath: string,
    workspaceRoot: string
): RosPackageInfo {
    const xml = manifestText.replace(/<!--[\s\S]*?-->/g, '');
    if (!/<package(?:\s|>)/i.test(xml) || !/<\/package\s*>/i.test(xml)) {
        throw new Error('Manifest is not a well-formed package.xml document.');
    }

    const name = extractTagValues(xml, 'name')[0];
    if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) {
        throw new Error('Missing or invalid package name in package.xml.');
    }

    const version = extractTagValues(xml, 'version')[0];
    const description = extractTagValues(xml, 'description')[0];
    const declaredBuildType = extractTagValues(xml, 'build_type')[0];
    const buildToolDependencies = extractTagValues(xml, 'buildtool_depend');
    const inferredBuildType = declaredBuildType
        || (buildToolDependencies.includes('ament_cmake') ? 'ament_cmake' : undefined)
        || (buildToolDependencies.includes('ament_python') ? 'ament_python' : undefined)
        || (buildToolDependencies.includes('catkin') ? 'catkin' : undefined)
        || (buildToolDependencies.includes('cmake') ? 'cmake' : undefined);

    const supportedBuildTypes: RosPackageBuildType[] = [
        'ament_cmake', 'ament_python', 'cmake', 'catkin'
    ];
    const buildType: RosPackageBuildType = inferredBuildType && supportedBuildTypes.includes(inferredBuildType as RosPackageBuildType)
        ? inferredBuildType as RosPackageBuildType
        : 'unknown';

    const dependencyKinds: RosPackageDependencyKind[] = [
        'depend',
        'buildtool_depend',
        'build_depend',
        'build_export_depend',
        'exec_depend',
        'test_depend',
        'doc_depend',
        'group_depend',
        'member_of_group'
    ];
    const dependencies: RosPackageDependency[] = [];
    const seenDependencies = new Set<string>();

    for (const kind of dependencyKinds) {
        for (const dependencyName of extractTagValues(xml, kind)) {
            const key = kind + ':' + dependencyName;
            if (!seenDependencies.has(key)) {
                dependencies.push({ name: dependencyName, kind });
                seenDependencies.add(key);
            }
        }
    }

    const packagePath = path.dirname(manifestPath);
    return {
        name,
        version,
        description,
        buildType,
        packagePath,
        relativePath: path.relative(workspaceRoot, packagePath) || '.',
        manifestPath,
        dependencies
    };
}

/**
 * Discovers package.xml files below a workspace src directory.
 * Generated folders and symlinks are skipped, and the scan is bounded.
 */
export function discoverRos2Packages(
    workspaceRoot: string,
    sourceDirectory = path.join(workspaceRoot, 'src')
): PackageDiscoveryResult {
    const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
    const resolvedSourceDirectory = path.resolve(sourceDirectory);
    const packages: RosPackageInfo[] = [];
    const issues: PackageDiscoveryIssue[] = [];
    let manifestCount = 0;
    let scannedDirectories = 0;
    let scanLimitReached = false;

    const scan = (directory: string, depth: number): void => {
        if (depth > MAX_SCAN_DEPTH || scannedDirectories >= MAX_SCANNED_DIRECTORIES) {
            scanLimitReached = true;
            return;
        }

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch (error) {
            issues.push({
                manifestPath: directory,
                message: error instanceof Error ? error.message : 'Unable to read directory.'
            });
            return;
        }
        scannedDirectories++;

        for (const entry of entries) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isFile() && entry.name === 'package.xml') {
                manifestCount++;
                try {
                    const manifestText = fs.readFileSync(entryPath, 'utf8');
                    packages.push(parseRosPackageManifest(manifestText, entryPath, resolvedWorkspaceRoot));
                } catch (error) {
                    issues.push({
                        manifestPath: entryPath,
                        message: error instanceof Error ? error.message : 'Unable to parse package manifest.'
                    });
                }
                continue;
            }

            if (entry.isDirectory()
                && !entry.name.startsWith('.')
                && !IGNORED_DIRECTORIES.has(entry.name)) {
                scan(entryPath, depth + 1);
            }
        }
    };

    let sourceDirectoryExists = false;
    try {
        sourceDirectoryExists = fs.statSync(resolvedSourceDirectory).isDirectory();
    } catch {
        sourceDirectoryExists = false;
    }

    if (!sourceDirectoryExists) {
        issues.push({
            manifestPath: resolvedSourceDirectory,
            message: 'Workspace src directory does not exist or is not a directory.'
        });
    } else {
        scan(resolvedSourceDirectory, 0);
    }

    packages.sort((a, b) => a.name.localeCompare(b.name) || a.relativePath.localeCompare(b.relativePath));

    const nameCounts = new Map<string, number>();
    for (const pkg of packages) {
        nameCounts.set(pkg.name, (nameCounts.get(pkg.name) ?? 0) + 1);
    }
    const duplicatePackageNames = [...nameCounts.entries()]
        .filter(([, count]) => count > 1)
        .map(([name]) => name)
        .sort();

    if (scanLimitReached) {
        issues.push({
            manifestPath: resolvedSourceDirectory,
            message: `Package scan reached its safety limit of ${MAX_SCANNED_DIRECTORIES} directories or depth ${MAX_SCAN_DEPTH}.`
        });
    }

    return {
        workspaceRoot: resolvedWorkspaceRoot,
        sourceDirectory: resolvedSourceDirectory,
        manifestCount,
        packages,
        issues,
        duplicatePackageNames,
        scanLimitReached
    };
}
