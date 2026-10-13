import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { ChildProcess } from 'child_process';
import { formatProcessError, processManager } from './core/processManager';
import { rosEnvironment } from './core/rosEnvironment';
import { LaunchManager } from './launch/launchManager';
import { LaunchManagerDashboard } from './launch/launchDashboard';
import { InterfaceExplorerPanel } from './interfaces/interfaceExplorer';
import { CommunicationDashboard } from './communication/communicationDashboard';
import { existsSync, readdirSync } from 'fs';
import * as path from 'path';

// ROS 2 release order. Rolling is also accepted because it tracks the newest ROS 2 development branch.
let launchManager: LaunchManager | undefined;

const ROS_DISTRO_ORDER: Record<string, number> = {
    humble: 2022,
    iron: 2023,
    jazzy: 2024,
    kilted: 2025,
    lyrical: 2026,
    rolling: 9999
};

function findInstalledRosDistros(): string[] {
    const rosInstallRoot = '/opt/ros';
    if (!existsSync(rosInstallRoot)) {
        return [];
    }

    try {
        return readdirSync(rosInstallRoot, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .filter(distro => existsSync(path.join(rosInstallRoot, distro, 'setup.bash')));
    } catch {
        return [];
    }
}

function findCompatibleRosDistro(): { distro?: string; installed: string[] } {
    const installed = findInstalledRosDistros();
    const compatible = installed
        .filter(distro => Object.prototype.hasOwnProperty.call(ROS_DISTRO_ORDER, distro))
        .sort((a, b) => ROS_DISTRO_ORDER[b] - ROS_DISTRO_ORDER[a]);

    // Prefer the ROS distro already active in the VS Code process, if it is supported and installed.
    const activeDistro = process.env.ROS_DISTRO;
    const distro = activeDistro && compatible.includes(activeDistro)
        ? activeDistro
        : compatible[0];

    return { distro, installed };
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}


function secureWebviewHtml(webview: vscode.Webview, html: string): string {
    const nonce = randomBytes(16).toString('base64');
    webview.options = { enableScripts: true };
    const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`;
    return html.replace('</head>', policy + '</head>').replace(/<script>/g, `<script nonce="${nonce}">`);
}
function defaultForType(type: string): string {
    if (type.endsWith(']')) {
        return '[]';
    }
    if (/^w?string/.test(type)) {
        return "''";
    }
    if (type === 'bool') {
        return 'false';
    }
    if (/^float(32|64)$/.test(type)) {
        return '0.0';
    }
    if (/^(u?int(8|16|32|64)|byte|char)$/.test(type)) {
        return '0';
    }
    return '{}'; // nested message: leave at its defaults
}

/** Builds a YAML goal template from the goal section of `ros2 interface show <action type>`. */
export function buildGoalTemplate(interfaceText: string): string {
    const fields: string[] = [];
    for (const rawLine of interfaceText.split(/\r?\n/)) {
        if (rawLine.trim() === '---') {
            break; // end of the goal section
        }
        const line = rawLine.split('#')[0].trim();
        if (!line || /^\S+\s+\S+\s*=/.test(line) || /^\s/.test(rawLine)) {
            continue; // blank, comment, constant, or indented line
        }
        const parts = line.split(/\s+/);
        if (parts.length >= 2) {
            fields.push(`  ${parts[1]}: ${defaultForType(parts[0])}`);
        }
    }
    return fields.length > 0 ? `{\n${fields.join(',\n')}\n}` : '{}';
}

/** Finds the type of `actionName` in the output of `ros2 action list -t`. */
export function parseActionType(listOutput: string, actionName: string): string | undefined {
    for (const line of listOutput.split(/\r?\n/)) {
        const match = line.trim().match(/^(\S+)\s+\[(.+)\]$/);
        if (match && match[1] === actionName) {
            return match[2];
        }
    }
    return undefined;
}

/** Keeps the goal response, feedback and result; drops the CLI's start-up chatter. */
export function formatGoalOutput(raw: string): string {
    const idx = raw.search(/Goal (accepted|rejected)/);
    if (idx < 0) {
        return 'Waiting for the action server...';
    }
    return raw.slice(idx).replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Reads the .srv / .action / .msg definition for a type such as "pkg/action/Name" straight from the
 * installed packages. `ros2 interface` is not installed in every ROS setup, so it is not used.
 */
export function readInterfaceDefinition(
    interfaceType: string,
    callback: (error: Error | null, text: string, stderr: string) => void,
    setup: string = rosEnvironment.setupCommand
) {
    const script = [
        setup,
        'IFS=/ read -r pkg kind name <<< "$IFACE_TYPE"',
        'IFS=: read -ra prefixes <<< "$AMENT_PREFIX_PATH"',
        'for p in "${prefixes[@]}"; do f="$p/share/$pkg/$kind/$name.$kind"; if [ -f "$f" ]; then cat "$f"; exit 0; fi; done',
        'echo "definition file for $IFACE_TYPE not found in AMENT_PREFIX_PATH" >&2; exit 1'
    ].join(' && ').replace('done && echo', 'done; echo');

    processManager.execFile('bash', ['-c', script], { env: { ...process.env, IFACE_TYPE: interfaceType } }, (error, stdout, stderr) => {
        callback(error, stdout, stderr);
    });
}

export async function activate(context: vscode.ExtensionContext) {
    try {

        const extensionName = String(context.extension.packageJSON.displayName || context.extension.packageJSON.name || 'ROS2 Assistant');
        const detected = findCompatibleRosDistro();

        if (!detected.distro) {
            const installedText = detected.installed.length > 0 ? detected.installed.join(', ') : 'no ROS 2 distro found';
            vscode.window.showErrorMessage(
                `extension ${extensionName} is not compatible with the ros2 distro ${installedText}`
            );
            return;
        }

        let domainId = context.globalState.get<number>('ros2-assistant.domainId');
        if (!Number.isInteger(domainId) || domainId! < 0 || domainId! > 232) {
            const inheritedDomain = process.env.ROS_DOMAIN_ID;
            const initialValue = inheritedDomain && /^\d+$/.test(inheritedDomain) && Number(inheritedDomain) <= 232
                ? inheritedDomain
                : '0';
            const enteredDomain = await vscode.window.showInputBox({
                title: 'ROS 2 Assistant Setup',
                prompt: `ROS 2 ${detected.distro} detected. Enter the ROS_DOMAIN_ID to use.`,
                placeHolder: '0',
                value: initialValue,
                validateInput: value => {
                    if (!/^\d+$/.test(value.trim())) {
                        return 'Enter a whole number between 0 and 232.';
                    }
                    const parsed = Number(value);
                    return parsed >= 0 && parsed <= 232 ? undefined : 'ROS_DOMAIN_ID must be between 0 and 232.';
                },
                ignoreFocusOut: true
            });

            if (enteredDomain === undefined) {
                vscode.window.showWarningMessage('ROS2 Assistant setup was cancelled. Reload the window to try again.');
                return;
            }

            domainId = Number(enteredDomain.trim());
            await context.globalState.update('ros2-assistant.domainId', domainId);
        }

        rosEnvironment.configure(detected.distro, domainId!);
        console.log(`ROS2 Assistant using ROS 2 ${detected.distro}, ROS_DOMAIN_ID=${domainId}`);

        // Change the active ROS domain at any time from the Command Palette.
        const setDomainIdDisposable = vscode.commands.registerCommand('ros2-assistant.setDomainId', async () => {
            const enteredDomain = await vscode.window.showInputBox({
                title: 'ROS 2 Assistant: Set ROS_DOMAIN_ID',
                prompt: `Current ROS_DOMAIN_ID is ${domainId}. Enter a new value (0-232).`,
                value: String(domainId),
                placeHolder: '3',
                validateInput: value => {
                    const trimmed = value.trim();
                    if (!/^\d+$/.test(trimmed)) {
                        return 'Enter a whole number between 0 and 232.';
                    }
                    const parsed = Number(trimmed);
                    return Number.isSafeInteger(parsed) && parsed <= 232
                        ? undefined
                        : 'ROS_DOMAIN_ID must be between 0 and 232.';
                },
                ignoreFocusOut: true
            });

            if (enteredDomain === undefined) {
                return;
            }

            const nextDomainId = Number(enteredDomain.trim());
            try {
                rosEnvironment.configure(detected.distro!, nextDomainId);
                await context.globalState.update('ros2-assistant.domainId', nextDomainId);
                domainId = nextDomainId;
                console.log(`ROS2 Assistant switched to ROS_DOMAIN_ID=${domainId}`);
                vscode.window.showInformationMessage(
                    `ROS 2 Assistant is now using ROS_DOMAIN_ID=${domainId}. Refresh the Communication Dashboard to load that domain's graph.`
                );
            } catch (error) {
                vscode.window.showErrorMessage(
                    `Could not change ROS_DOMAIN_ID: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        });
        context.subscriptions.push(setDomainIdDisposable);

        const helloDisposable = vscode.commands.registerCommand('ros2-assistant.helloWorld', () => {
            vscode.window.showInformationMessage('Hello World from ROS2 Assistant!');
        });
        context.subscriptions.push(helloDisposable);

        const treeDataProvider = new Ros2TreeDataProvider();
        context.subscriptions.push(vscode.window.registerTreeDataProvider('ros2View', treeDataProvider));
        context.subscriptions.push({ dispose: () => treeDataProvider.dispose() });

        const backDisposable = vscode.commands.registerCommand('ros2-assistant.goBack', () => {
            treeDataProvider.goBack();
        });
        context.subscriptions.push(backDisposable);

        const selectDisposable = vscode.commands.registerCommand('ros2-assistant.selectItem', (viewType: string) => {
            treeDataProvider.navigateTo(viewType);
        });
        context.subscriptions.push(selectDisposable);

        const inspectTopicDisposable = vscode.commands.registerCommand('ros2-assistant.inspectItem', (item: Ros2TreeItem) => {
            if (item.viewType === 'topics') {
                TopicEchoPanel.createOrShow(context.extensionUri, item.label);
            }
        });
        context.subscriptions.push(inspectTopicDisposable);

        const publishTopicDisposable = vscode.commands.registerCommand('ros2-assistant.publishTopic', () => {
            PublishTopicPanel.createOrShow(context.extensionUri);
        });
        context.subscriptions.push(publishTopicDisposable);

        const inspectNodeDisposable = vscode.commands.registerCommand('ros2-assistant.inspectNode', (item: Ros2TreeItem) => {
            if (item.viewType === 'nodes') {
                NodeInfoPanel.createOrShow(context.extensionUri, item.label);
            }
        });
        context.subscriptions.push(inspectNodeDisposable);

        const inspectServiceDisposable = vscode.commands.registerCommand('ros2-assistant.inspectService', (item: Ros2TreeItem) => {
            if (item.viewType === 'services') {
                ServiceCallPanel.createOrShow(context.extensionUri, item.label);
            }
        });
        context.subscriptions.push(inspectServiceDisposable);

        const inspectActionDisposable = vscode.commands.registerCommand('ros2-assistant.inspectAction', (item: Ros2TreeItem) => {
            if (item.viewType === 'actions') {
                ActionGoalPanel.createOrShow(context.extensionUri, item.label);
            }
        });
        context.subscriptions.push(inspectActionDisposable);

        launchManager = new LaunchManager();
        context.subscriptions.push({ dispose: () => launchManager?.dispose() });
        const launchManagerDisposable = vscode.commands.registerCommand('ros2-assistant.openLaunchManager', () => {
            const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
            LaunchManagerDashboard.createOrShow(launchManager!, workspaceRoots);
        });
        context.subscriptions.push(launchManagerDisposable);

        const communicationDashboardDisposable = vscode.commands.registerCommand('ros2-assistant.openCommunicationDashboard', () => {
            CommunicationDashboard.createOrShow(context.extensionUri);
        });
        context.subscriptions.push(communicationDashboardDisposable);

        const interfaceExplorerDisposable = vscode.commands.registerCommand('ros2-assistant.openInterfaceExplorer', () => {
            InterfaceExplorerPanel.createOrShow(context.extensionUri);
        });
        context.subscriptions.push(interfaceExplorerDisposable);
    } catch (error) {
        console.error('Error during ROS2 Assistant activation:', error);
        vscode.window.showErrorMessage(`ROS2 Assistant failed to start: ${error instanceof Error ? error.message : String(error)}`);
    }
}
class Ros2TreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly viewType?: string,
        public readonly command?: vscode.Command,
        public readonly iconPath?: vscode.ThemeIcon
    ) {
        super(label, collapsibleState);
        this.command = command;
        this.iconPath = iconPath;
        this.tooltip = label;
    }
}

class Ros2TreeDataProvider implements vscode.TreeDataProvider<Ros2TreeItem>, vscode.Disposable {
    private _onDidChangeTreeData: vscode.EventEmitter<Ros2TreeItem | undefined | void> = new vscode.EventEmitter<Ros2TreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<Ros2TreeItem | undefined | void> = this._onDidChangeTreeData.event;

    private history: string[] = [];
    private currentView: string = 'root';
    private currentItems: string[] = [];
    private refreshInterval: NodeJS.Timeout | undefined;
    private fetchInProgress = false;

    getTreeItem(element: Ros2TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: Ros2TreeItem): Thenable<Ros2TreeItem[]> {
        if (element) {
            return Promise.resolve([]);
        }

        if (this.currentView === 'root') {
            return Promise.resolve([
                new Ros2TreeItem('Communication Dashboard', vscode.TreeItemCollapsibleState.None, 'root', {
                    command: 'ros2-assistant.openCommunicationDashboard',
                    title: 'Open ROS 2 Communication Dashboard'
                }, new vscode.ThemeIcon('graph')),
                new Ros2TreeItem('List Topics', vscode.TreeItemCollapsibleState.None, 'root', {
                    command: 'ros2-assistant.selectItem',
                    title: 'Select Topics View',
                    arguments: ['topics']
                }, new vscode.ThemeIcon('broadcast')),
                new Ros2TreeItem('Publish to Topic', vscode.TreeItemCollapsibleState.None, 'root', {
                    command: 'ros2-assistant.publishTopic',
                    title: 'Publish to Topic'
                }, new vscode.ThemeIcon('send')),
                new Ros2TreeItem('List Actions', vscode.TreeItemCollapsibleState.None, 'root', {
                    command: 'ros2-assistant.selectItem',
                    title: 'Select Actions View',
                    arguments: ['actions']
                }, new vscode.ThemeIcon('play')),
                new Ros2TreeItem('List Services', vscode.TreeItemCollapsibleState.None, 'root', {
                    command: 'ros2-assistant.selectItem',
                    title: 'Select Services View',
                    arguments: ['services']
                }, new vscode.ThemeIcon('symbol-method')),
                new Ros2TreeItem('List Nodes', vscode.TreeItemCollapsibleState.None, 'root', {
                    command: 'ros2-assistant.selectItem',
                    title: 'Select Node View',
                    arguments: ['nodes']
                }, new vscode.ThemeIcon('server')),
                new Ros2TreeItem('Launch Manager', vscode.TreeItemCollapsibleState.None, 'root', {
                    command: 'ros2-assistant.openLaunchManager',
                    title: 'Open ROS 2 Launch Manager'
                }, new vscode.ThemeIcon('rocket')),
                new Ros2TreeItem('Interface Explorer', vscode.TreeItemCollapsibleState.None, 'root', {
                    command: 'ros2-assistant.openInterfaceExplorer',
                    title: 'Open ROS 2 Interface Explorer'
                }, new vscode.ThemeIcon('symbol-interface'))
            ]);
        } else {
            if (this.currentItems.length === 0) {
                return Promise.resolve([
                    new Ros2TreeItem('nothing here', vscode.TreeItemCollapsibleState.None, this.currentView, undefined, new vscode.ThemeIcon('info'))
                ]);
            }

            let iconName = 'symbol-misc';
            if (this.currentView === 'nodes') {
                iconName = 'server';
            } else if (this.currentView === 'topics') {
                iconName = 'broadcast';
            } else if (this.currentView === 'services') {
                iconName = 'symbol-method';
            } else if (this.currentView === 'actions') {
                iconName = 'play';
            }

            return Promise.resolve(
                this.currentItems.map(item => new Ros2TreeItem(
                    item,
                    vscode.TreeItemCollapsibleState.None,
                    this.currentView,
                    this.currentView === 'nodes' ? {
                        command: 'ros2-assistant.inspectNode',
                        title: 'Inspect Node Info',
                        arguments: [new Ros2TreeItem(item, vscode.TreeItemCollapsibleState.None, 'nodes')]
                    } : this.currentView === 'topics' ? {
                        command: 'ros2-assistant.inspectItem',
                        title: 'Echo Topic Messages',
                        arguments: [new Ros2TreeItem(item, vscode.TreeItemCollapsibleState.None, 'topics')]
                    } : this.currentView === 'services' ? {
                        command: 'ros2-assistant.inspectService',
                        title: 'Call Service',
                        arguments: [new Ros2TreeItem(item, vscode.TreeItemCollapsibleState.None, 'services')]
                    } : this.currentView === 'actions' ? {
                        command: 'ros2-assistant.inspectAction',
                        title: 'Send Goal',
                        arguments: [new Ros2TreeItem(item, vscode.TreeItemCollapsibleState.None, 'actions')]
                    } : undefined,
                    new vscode.ThemeIcon(iconName)
                ))
            );
        }
    }

    public navigateTo(viewType: string) {
        this.history.push(this.currentView);
        this.currentView = viewType;
        this.startPolling();
        this._onDidChangeTreeData.fire();
    }

    public goBack() {
        if (this.history.length > 0) {
            this.currentView = this.history.pop()!;
            if (this.currentView === 'root') {
                this.stopPolling();
            } else {
                this.startPolling();
            }
            this._onDidChangeTreeData.fire();
        } else {
            vscode.window.showInformationMessage('Already at the main menu.');
        }
    }

    private startPolling() {
        this.stopPolling();
        this.fetchData();
        this.refreshInterval = setInterval(() => {
            this.fetchData();
        }, 5000);
    }

    private stopPolling() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = undefined;
        }
    }

    private fetchData() {
        if (this.currentView === 'root' || this.fetchInProgress) {
            return;
        }

        let cmd = '';
        if (this.currentView === 'nodes') {
            cmd = 'ros2 node list';
        } else if (this.currentView === 'topics') {
            cmd = 'ros2 topic list';
        } else if (this.currentView === 'services') {
            cmd = 'ros2 service list';
        } else if (this.currentView === 'actions') {
            cmd = 'ros2 action list';
        }

        const fullCmd = `bash -c "${rosEnvironment.setupCommand} && ${cmd}"`;

        this.fetchInProgress = true;
        processManager.exec(fullCmd, { env: process.env, timeout: 10000 }, (error, stdout) => {
            this.fetchInProgress = false;
            let items: string[] = [];
            if (!error && stdout) {
                items = stdout.split('\n').map(s => s.trim()).filter(s => s.length > 0);
            }

            this.currentItems = items;
            this._onDidChangeTreeData.fire();
        });
    }

    public dispose() {
        this.stopPolling();
    }
}

/**
 * Provides a GUI for publishing ROS 2 messages to a selected topic.
 */
class PublishTopicPanel {
    private static currentPanel: PublishTopicPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _disposables: vscode.Disposable[] = [];
    private selectedTopic = '';
    private messageType = '';
    private publisherProcess: ChildProcess | undefined;
    private selectionVersion = 0;
    private newTopicMode = false;

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor?.viewColumn;
        if (PublishTopicPanel.currentPanel) {
            PublishTopicPanel.currentPanel._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'ros2PublishTopic',
            'Publish to Topic',
            column || vscode.ViewColumn.One,
            { enableScripts: true }
        );
        PublishTopicPanel.currentPanel = new PublishTopicPanel(panel);
    }

    private constructor(panel: vscode.WebviewPanel) {
        this._panel = panel;
        this._panel.webview.html = secureWebviewHtml(this._panel.webview, this._getHtmlForWebview());
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(message => {
            if (message.command === 'ready' || message.command === 'refreshTopics') {
                this._fetchTopics();
                if (message.command === 'ready') {
                    this._fetchInterfaces();
                }
            } else if (message.command === 'refreshInterfaces') {
                this._fetchInterfaces();
            } else if (message.command === 'setTopicMode') {
                this._setTopicMode(Boolean(message.newTopic));
            } else if (message.command === 'selectMessageType') {
                this._selectMessageType(String(message.type || ''));
            } else if (message.command === 'selectTopic') {
                this._selectTopic(String(message.topic || ''));
            } else if (message.command === 'startPublishing') {
                this._startPublishing(message.rate, message.count, String(message.topic || ''), String(message.type || ''), Boolean(message.newTopic), String(message.yaml || ''));
            } else if (message.command === 'stopPublishing') {
                this._stopPublishing();
            }
        }, null, this._disposables);
    }

    private _post(message: object) {
        this._panel.webview.postMessage(message);
    }
    private _fetchInterfaces() {
        // Discover ROS message definitions from the installed package prefixes.
        // Some ROS 2 distributions do not provide the optional "ros2 interface" CLI verb.
        const discoveryScript = [
            "import os",
            "from pathlib import Path",
            "types = set()",
            "for prefix in os.environ.get('AMENT_PREFIX_PATH', '').split(os.pathsep):",
            "    share = Path(prefix) / 'share'",
            "    if share.is_dir():",
            "        for definition in share.glob('*/msg/*.msg'):",
            "            types.add(f'{definition.parent.parent.name}/msg/{definition.stem}')",
            "for interface_type in sorted(types):",
            "    print(interface_type)"
        ].join('\n');
        const encodedScript = Buffer.from(discoveryScript, 'utf8').toString('base64');
        const script = `${rosEnvironment.setupCommand} && exec python3 -c "$(printf %s "${encodedScript}" | base64 -d)"`;
        processManager.execFile('bash', ['-c', script], { env: process.env }, (error, stdout, stderr) => {
            if (error) {
                this._post({ command: 'interfaces', types: [], error: (stderr || error.message).trim() || error.message });
                return;
            }
            const types = [...new Set(stdout.split(/\r?\n/).map(line => line.trim()).filter(line => /^[A-Za-z][A-Za-z0-9_]*\/msg\/[A-Za-z][A-Za-z0-9_]*$/.test(line)))].sort();
            this._post({ command: 'interfaces', types });
            if (types.length === 0) {
                this._post({ command: 'interfaces', types: [], error: 'No ROS 2 message definitions were found in AMENT_PREFIX_PATH. Check that your ROS 2 setup and message packages are sourced.' });
            }
        });
    }

    private _setTopicMode(newTopic: boolean) {
        this.newTopicMode = newTopic;
        this.selectedTopic = '';
        this.messageType = '';
        ++this.selectionVersion;
        this._post({ command: 'clearSelection' });
        this._post({ command: 'modeChanged', newTopic });
        if (!newTopic) {
            this._fetchTopics();
        }
    }

    private _selectMessageType(type: string) {
        if (!this.newTopicMode) {
            return;
        }
        this.messageType = '';
        const version = ++this.selectionVersion;
        this._post({ command: 'topicType', topic: '', type: '', template: '', loading: Boolean(type) });
        if (!/^[A-Za-z][A-Za-z0-9_]*\/msg\/[A-Za-z][A-Za-z0-9_]*$/.test(type)) {
            return;
        }
        this._loadMessageDefinition(type, version, '');
    }

    private _loadMessageDefinition(type: string, version: number, topic: string) {
        readInterfaceDefinition(type, (error, definition, stderr) => {
            if (version !== this.selectionVersion) {
                return;
            }
            if (error || !definition.trim()) {
                this._post({ command: 'topicType', topic, type, template: '{}', loading: false, error: (stderr || error?.message || 'Could not load message definition.').trim() });
                return;
            }
            this.messageType = type;
            this._post({ command: 'topicType', topic, type, template: buildGoalTemplate(definition), loading: false });
        });
    }

    private _fetchTopics() {
        const script = `${rosEnvironment.setupCommand} && exec ros2 topic list`;
        processManager.execFile('bash', ['-c', script], { env: process.env }, (error, stdout, stderr) => {
            if (error) {
                this._post({ command: 'topics', topics: [], error: (stderr || error.message).trim() });
                return;
            }
            const topics = stdout.split(/\r?\n/).map(topic => topic.trim()).filter(Boolean);
            this._post({ command: 'topics', topics });
            if (!this.newTopicMode && this.selectedTopic && topics.includes(this.selectedTopic)) {
                this._post({ command: 'selectTopic', topic: this.selectedTopic });
                this._selectTopic(this.selectedTopic);
            }
        });
    }

    private _selectTopic(topic: string) {
        if (this.newTopicMode) {
            return;
        }
        this.selectedTopic = topic;
        this.messageType = '';
        const requestVersion = ++this.selectionVersion;
        this._post({ command: 'topicType', topic, type: '', template: '', loading: Boolean(topic) });
        if (!topic) {
            return;
        }

        const env = { ...process.env, ROS_TOPIC_NAME: topic };
        const script = `${rosEnvironment.setupCommand} && exec ros2 topic type "$ROS_TOPIC_NAME"`;
        processManager.execFile('bash', ['-c', script], { env }, (error, stdout, stderr) => {
            if (requestVersion !== this.selectionVersion) {
                return;
            }
            if (error || !stdout.trim()) {
                this._post({ command: 'topicType', topic, type: '', template: '', loading: false,
                    error: (stderr || error?.message || 'Could not determine topic type.').trim() });
                return;
            }

            const type = stdout.trim().split(/\r?\n/)[0].trim();
            this._loadMessageDefinition(type, requestVersion, topic);
        });
    }

    private _startPublishing(rateValue: unknown, countValue: unknown, topicValue: string, typeValue: string, newTopic: boolean, yaml: string) {
        if (this.publisherProcess) {
            return;
        }
        const rate = Number(rateValue);
        const count = Number(countValue);
        const topic = newTopic ? topicValue.trim() : this.selectedTopic;
        const type = newTopic ? typeValue.trim() : this.messageType;
        if (newTopic !== this.newTopicMode) {
            this._post({ command: 'publishStatus', running: false, text: 'Topic mode changed. Select the topic and message type again.' });
            return;
        }
        if (!topic || !type) {
            this._post({ command: 'publishStatus', running: false, text: 'Select a valid topic and message type first.' });
            return;
        }
        if (newTopic && (!topic.startsWith('/') || !/^\/[A-Za-z][A-Za-z0-9_]*(\/[A-Za-z][A-Za-z0-9_]*)*$/.test(topic))) {
            this._post({ command: 'publishStatus', running: false, text: 'New topic names must start with / and contain valid ROS name tokens.' });
            return;
        }
        if (!Number.isFinite(rate) || rate <= 0) {
            this._post({ command: 'publishStatus', running: false, text: 'Publish rate must be greater than 0 Hz.' });
            return;
        }
        if (!Number.isInteger(count) || count < 1) {
            this._post({ command: 'publishStatus', running: false, text: 'Number of messages must be a positive whole number.' });
            return;
        }
        if (!yaml.trim()) {
            this._post({ command: 'publishStatus', running: false, text: 'Message cannot be empty.' });
            return;
        }

        const publisherScript = [
            "import os, time, yaml, rclpy",
            "from contextlib import suppress",
            "from rosidl_runtime_py.utilities import get_message",
            "from rosidl_runtime_py.set_message import set_message_fields",
            "topic=os.environ['ROS_TOPIC_NAME']; type_name=os.environ['ROS_MESSAGE_TYPE']",
            "rate=float(os.environ['ROS_PUBLISH_RATE']); count=int(os.environ['ROS_PUBLISH_COUNT'])",
            "payload=yaml.safe_load(os.environ['ROS_MESSAGE_YAML'])",
            "if payload is None: payload={}",
            "if not isinstance(payload, dict): raise ValueError('Message YAML must be a mapping/object.')",
            "rclpy.init(); node=rclpy.create_node('ros2_assistant_gui_publisher')",
            "try:",
            "    msg_type=get_message(type_name); pub=node.create_publisher(msg_type, topic, 10)",
            "    for i in range(count):",
            "        msg=msg_type(); set_message_fields(msg, payload)",
            "        now = node.get_clock().now().to_msg()",
            "        if hasattr(msg, 'header') and hasattr(msg.header, 'stamp'):",
            "            msg.header.stamp = now",
            "        elif hasattr(msg, 'stamp') and hasattr(msg, 'frame_id'):",
            "            msg.stamp = now",
            "        pub.publish(msg); node.get_logger().info('Published %d/%d to %s' % (i+1,count,topic))",
            "        rclpy.spin_once(node, timeout_sec=0.0)",
            "        if i+1<count: time.sleep(1.0/rate)",
            "except KeyboardInterrupt:",
            "    pass  # Stopping the publisher is an expected user action.",
            "finally:",
            "    with suppress(Exception): node.destroy_node()",
            "    with suppress(Exception): rclpy.try_shutdown()"
        ].join('\n');
        const env = {
            ...process.env,
            PYTHONUNBUFFERED: '1',
            ROS_TOPIC_NAME: topic,
            ROS_MESSAGE_TYPE: type,
            ROS_PUBLISH_RATE: String(rate),
            ROS_PUBLISH_COUNT: String(count),
            ROS_MESSAGE_YAML: yaml,
            ROS_PUBLISHER_SCRIPT_B64: Buffer.from(publisherScript, 'utf8').toString('base64')
        };
        const script = `${rosEnvironment.setupCommand} && exec python3 -c "$(printf %s "$ROS_PUBLISHER_SCRIPT_B64" | base64 -d)"`;
        const child = processManager.spawn('bash', ['-c', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        this.publisherProcess = child;
        this._post({ command: 'publishStatus', running: true, text: `Publishing ${count} message(s) to ${topic} at ${rate} Hz...` });

        child.stdout?.on('data', chunk => {
            this._post({ command: 'publishOutput', text: chunk.toString() });
        });
        child.stderr?.on('data', chunk => {
            this._post({ command: 'publishOutput', text: chunk.toString() });
        });
        child.on('error', error => {
            if (this.publisherProcess === child) {
                this.publisherProcess = undefined;
            }
            this._post({ command: 'publishStatus', running: false, text: `Failed to start publisher: ${error.message}` });
        });
        child.on('close', code => {
            if (this.publisherProcess === child) {
                this.publisherProcess = undefined;
            }
            this._post({ command: 'publishStatus', running: false,
                text: code === 0 ? 'Publishing completed.' : `Publisher stopped (exit code ${code}).` });
        });
    }

    private _stopPublishing() {
        const child = this.publisherProcess;
        if (!child) {
            return;
        }
        processManager.terminate(child, 'SIGINT');
        this._post({ command: 'publishStatus', running: true, text: 'Stopping publisher...' });
        setTimeout(() => {
            if (this.publisherProcess === child) {
                processManager.terminate(child, 'SIGKILL', 0);
            }
        }, 2000);
    }

    private _getHtmlForWebview(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Publish to Topic</title>
<style>
    body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    h2 { margin: 0 0 20px; padding-bottom: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
    .row { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; flex-wrap: wrap; }
    [hidden] { display: none !important; }
    label { font-weight: 600; min-width: 150px; }
    select, input, textarea { box-sizing: border-box; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 3px; padding: 8px; font: inherit; }
    select { flex: 1; min-width: 220px; }
    input[type=number] { width: 120px; }
    .inline-field { display: flex; align-items: center; gap: 8px; }
    .inline-field label { min-width: auto; }
    button { border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; padding: 8px 14px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .5; cursor: not-allowed; }
    #message { display: block; width: 100%; min-height: 230px; resize: vertical; font-family: var(--vscode-editor-font-family, monospace); white-space: pre; }
    .message-label { display: block; margin-bottom: 8px; }
    .actions { display: flex; gap: 10px; margin-top: 16px; }
    #stopButton { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    #status { margin-top: 18px; padding: 10px; background: var(--vscode-textCodeBlock-background); white-space: pre-wrap; }
    #output { margin-top: 8px; max-height: 180px; overflow: auto; white-space: pre-wrap; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
    .muted { color: var(--vscode-descriptionForeground); }
    @media (max-width: 600px) { label { min-width: 100%; } .row { align-items: stretch; } .inline-field { flex-wrap: wrap; } }
</style>
</head>
<body>
<h2>Publish to Topic</h2>
<div class="row">
    <label style="min-width:auto"><input id="newTopicCheckbox" type="checkbox"> Publish on a new topic</label>
</div>
<div class="row" id="existingTopicRow">
    <label for="topicSelect">Topic to publish on:</label>
    <select id="topicSelect"><option value="">Loading topics...</option></select>
    <button id="refreshButton" type="button" title="Refresh topics">Refresh</button>
</div>
<div class="row" id="newTopicRow" hidden>
    <label for="newTopicInput">New topic name:</label>
    <input id="newTopicInput" type="text" placeholder="/my_robot/custom_topic" style="flex:1;min-width:220px">
    <span class="muted">Include the leading /</span>
</div>
<div class="row" id="messageTypeRow" hidden>
    <label for="messageTypeSelect">Message type:</label>
    <select id="messageTypeSelect"><option value="">Loading ROS message types...</option></select>
    <button id="refreshInterfacesButton" type="button">Refresh</button>
</div>
<div class="row">
    <div class="inline-field">
        <label for="rateInput">Publish rate:</label>
        <input id="rateInput" type="number" min="0.001" step="any" value="1">
        <span class="muted">Hz</span>
    </div>
    <div class="inline-field">
        <label for="countInput">Number of messages:</label>
        <input id="countInput" type="number" min="1" step="1" value="1">
    </div>
</div>
<div class="row" style="display:block">
    <label class="message-label" for="message">Message:</label>
    <textarea id="message" spellcheck="false" placeholder="Select a topic to load its message template..." disabled></textarea>
    <div id="typeInfo" class="muted"></div>
</div>
<div class="actions">
    <button id="startButton" type="button" disabled>Start Publishing</button>
    <button id="stopButton" type="button" disabled>Stop Publishing</button>
</div>
<div id="status" role="status">Select a topic to begin.</div>
<pre id="output"></pre>
<script>
    const vscode = acquireVsCodeApi();
    const topicSelect = document.getElementById('topicSelect');
    const newTopicCheckbox = document.getElementById('newTopicCheckbox');
    const newTopicInput = document.getElementById('newTopicInput');
    const existingTopicRow = document.getElementById('existingTopicRow');
    const newTopicRow = document.getElementById('newTopicRow');
    const messageTypeRow = document.getElementById('messageTypeRow');
    const messageTypeSelect = document.getElementById('messageTypeSelect');
    const rateInput = document.getElementById('rateInput');
    const countInput = document.getElementById('countInput');
    const messageInput = document.getElementById('message');
    const typeInfo = document.getElementById('typeInfo');
    const startButton = document.getElementById('startButton');
    const stopButton = document.getElementById('stopButton');
    const status = document.getElementById('status');
    const output = document.getElementById('output');
    let selectedType = '';
    let isRunning = false;
    let newTopicMode = false;

    document.getElementById('refreshButton').addEventListener('click', () => vscode.postMessage({ command: 'refreshTopics' }));
    document.getElementById('refreshInterfacesButton').addEventListener('click', () => vscode.postMessage({ command: 'refreshInterfaces' }));
    newTopicCheckbox.addEventListener('change', () => {
        newTopicMode = newTopicCheckbox.checked;
        existingTopicRow.hidden = newTopicMode;
        newTopicRow.hidden = !newTopicMode;
        messageTypeRow.hidden = !newTopicMode;
        selectedType = '';
        messageInput.value = '';
        messageInput.disabled = true;
        startButton.disabled = true;
        typeInfo.textContent = '';
        status.textContent = newTopicMode ? 'Enter a new topic name and select a message type.' : 'Select an existing topic.';
        vscode.postMessage({ command: 'setTopicMode', newTopic: newTopicMode });
    });
    messageTypeSelect.addEventListener('change', () => {
        selectedType = '';
        messageInput.value = '';
        messageInput.disabled = true;
        startButton.disabled = true;
        status.textContent = 'Loading message definition...';
        vscode.postMessage({ command: 'selectMessageType', type: messageTypeSelect.value });
    });
    topicSelect.addEventListener('change', () => {
        selectedType = '';
        messageInput.value = '';
        messageInput.disabled = true;
        startButton.disabled = true;
        typeInfo.textContent = '';
        status.textContent = 'Loading topic type and message template...';
        output.textContent = '';
        vscode.postMessage({ command: 'selectTopic', topic: topicSelect.value });
    });
    startButton.addEventListener('click', () => {
        if (isRunning) return;
        output.textContent = '';
        vscode.postMessage({ command: 'startPublishing', topic: newTopicMode ? newTopicInput.value : topicSelect.value, type: selectedType, newTopic: newTopicMode, rate: rateInput.value, count: countInput.value, yaml: messageInput.value });
    });
    stopButton.addEventListener('click', () => vscode.postMessage({ command: 'stopPublishing' }));

    window.addEventListener('message', event => {
        const data = event.data;
        if (data.command === 'topics') {
            const previous = topicSelect.value;
            topicSelect.replaceChildren();
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = data.error ? 'Unable to load topics' : 'Select a topic';
            topicSelect.appendChild(placeholder);
            for (const topic of data.topics || []) {
                const option = document.createElement('option');
                option.value = topic;
                option.textContent = topic;
                topicSelect.appendChild(option);
            }
            if (data.error) status.textContent = data.error;
            if (previous && (data.topics || []).includes(previous)) topicSelect.value = previous;
        } else if (data.command === 'interfaces') {
            messageTypeSelect.replaceChildren();
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = data.error ? 'Unable to load message types' : 'Select a message type';
            messageTypeSelect.appendChild(placeholder);
            for (const type of data.types || []) {
                const option = document.createElement('option');
                option.value = type;
                option.textContent = type;
                messageTypeSelect.appendChild(option);
            }
            if (data.error) status.textContent = data.error;
        } else if (data.command === 'clearSelection') {
            selectedType = '';
            messageInput.value = '';
            messageInput.disabled = true;
            startButton.disabled = true;
            typeInfo.textContent = '';
        } else if (data.command === 'modeChanged') {
            newTopicMode = data.newTopic;
        } else if (data.command === 'selectTopic') {
            if (data.topic && topicSelect.value !== data.topic) topicSelect.value = data.topic;
        } else if (data.command === 'topicType') {
            if (!newTopicMode && data.topic !== topicSelect.value) return;
            if (newTopicMode && data.topic) return;
            selectedType = data.type || '';
            messageInput.value = data.template || '';
            messageInput.disabled = Boolean(data.loading) || !selectedType;
            typeInfo.textContent = selectedType ? 'Message type: ' + selectedType : (data.error || '');
            startButton.disabled = !selectedType || isRunning;
            if (data.loading) status.textContent = 'Loading message definition...';
            else if (data.error) status.textContent = data.error;
            else status.textContent = selectedType ? 'Message template loaded. Edit it and start publishing.' : 'Select a topic to begin.';
        } else if (data.command === 'publishStatus') {
            isRunning = data.running;
            startButton.disabled = isRunning || !selectedType;
            stopButton.disabled = !isRunning;
            status.textContent = data.text;
        } else if (data.command === 'publishOutput') {
            output.textContent += data.text;
            output.scrollTop = output.scrollHeight;
        }
    });

    vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
    }

    public dispose() {
        if (PublishTopicPanel.currentPanel === this) {
            PublishTopicPanel.currentPanel = undefined;
        }
        if (this.publisherProcess) {
            processManager.terminate(this.publisherProcess, 'SIGINT');
            this.publisherProcess = undefined;
        }
        while (this._disposables.length) {
            this._disposables.pop()?.dispose();
        }
    }
}

/**
 * Manages Topic Echo Webview Panels
 */
class TopicEchoPanel {
    public static currentPanels: Map<string, TopicEchoPanel> = new Map();
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _process: ChildProcess | undefined;

    public static createOrShow(extensionUri: vscode.Uri, topicName: string) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (TopicEchoPanel.currentPanels.has(topicName)) {
            TopicEchoPanel.currentPanels.get(topicName)!._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'ros2TopicEcho',
            `Echo: ${topicName}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true
            }
        );

        TopicEchoPanel.currentPanels.set(topicName, new TopicEchoPanel(panel, topicName));
    }

    private constructor(panel: vscode.WebviewPanel, private readonly topicName: string) {
        this._panel = panel;
        this._panel.webview.html = secureWebviewHtml(this._panel.webview, this._getHtmlForWebview(this.topicName));

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._startEchoProcess();
    }

    private _startEchoProcess() {
        const echoCmd = `${rosEnvironment.setupCommand} && ros2 topic echo ${this.topicName}`;
        this._process = processManager.spawn('bash', ['-c', echoCmd], { env: process.env });

        this._process.stdout?.on('data', (data) => {
            const message = data.toString();
            this._panel.webview.postMessage({ command: 'echoData', data: message });
        });

        this._process.stderr?.on('data', (data) => {
            this._panel.webview.postMessage({ command: 'echoError', data: data.toString() });
        });
    }

    private _getHtmlForWebview(topicName: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Echo ${topicName}</title>
    <style>
        body {
            font-family: var(--vscode-editor-font-family, monospace);
            padding: 15px;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        h2 {
            margin-top: 0;
            color: var(--vscode-symbolIcon-keywordForeground);
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 8px;
        }
        .toolbar {
            display: flex;
            align-items: center;
            gap: 16px;
            margin-bottom: 10px;
        }
        .toolbar button {
            padding: 4px 10px;
            color: var(--vscode-button-secondaryForeground);
            background-color: var(--vscode-button-secondaryBackground);
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 2px;
            cursor: pointer;
        }
        .toolbar button:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .toolbar label {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            cursor: pointer;
            font-size: 13px;
        }
        .toolbar input[type="checkbox"] {
            margin: 0;
        }
        .segment-container {
            display: flex;
            flex-direction: column;
            gap: 10px;
            max-height: 80vh;
            overflow-y: auto;
        }
        .message-card {
            background-color: var(--vscode-textCodeBlock-background);
            border-left: 4px solid var(--vscode-activityBarBadge-background);
            padding: 10px 14px;
            border-radius: 4px;
            white-space: pre-wrap;
            font-size: 13px;
        }
    </style>
</head>
<body>
    <h2>Topic Stream: ${topicName}</h2>
    <div class="toolbar">
        <label for="autoScrollCheckbox">
            <input id="autoScrollCheckbox" type="checkbox">
            Auto-scroll
        </label>
        <button id="clearMessagesButton" type="button">Clear messages</button>
    </div>
    <div id="output" class="segment-container">
        <div class="message-card">Waiting for messages on ${topicName}...</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const outputDiv = document.getElementById('output');
        const autoScrollCheckbox = document.getElementById('autoScrollCheckbox');
        const clearMessagesButton = document.getElementById('clearMessagesButton');
        let initialCleared = false;

        clearMessagesButton.addEventListener('click', () => {
            outputDiv.innerHTML = '';
            initialCleared = true;
        });

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'echoData') {
                if (!initialCleared) {
                    outputDiv.innerHTML = '';
                    initialCleared = true;
                }
                const card = document.createElement('div');
                card.className = 'message-card';
                card.textContent = message.data;
                outputDiv.appendChild(card);
                while (outputDiv.children.length > 100) {
                    outputDiv.removeChild(outputDiv.firstElementChild);
                }
                if (autoScrollCheckbox.checked) {
                    outputDiv.scrollTop = outputDiv.scrollHeight;
                }
            }
        });
    </script>
</body>
</html>`;
    }

    public dispose() {
        TopicEchoPanel.currentPanels.delete(this.topicName);

        if (this._process) {
            processManager.terminate(this._process, 'SIGTERM');
        }

        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}

/**
 * Manages Node Info Webview Panels
 */
class NodeInfoPanel {
    public static currentPanels: Map<string, NodeInfoPanel> = new Map();
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri, nodeName: string) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (NodeInfoPanel.currentPanels.has(nodeName)) {
            NodeInfoPanel.currentPanels.get(nodeName)!._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'ros2NodeInfo',
            `Node: ${nodeName}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true
            }
        );

        NodeInfoPanel.currentPanels.set(nodeName, new NodeInfoPanel(panel, nodeName));
    }

    private constructor(panel: vscode.WebviewPanel, private readonly nodeName: string) {
        this._panel = panel;
        this._panel.webview.html = secureWebviewHtml(this._panel.webview, this._getHtmlForWebview(this.nodeName, 'Loading node information...'));

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._fetchNodeInfo();
    }

    private _fetchNodeInfo() {
        const innerCmd = `${rosEnvironment.setupCommand} && ros2 node info ${this.nodeName}`;
        const cmd = `bash -c "${innerCmd}"`;

        processManager.exec(cmd, { env: process.env }, (error, stdout, stderr) => {
            if (error) {
                this._panel.webview.postMessage({
                    command: 'nodeInfoData',
                    data: formatProcessError('ros2 node info', error, stderr, stdout)
                });
                return;
            }
            this._panel.webview.postMessage({
                command: 'nodeInfoData',
                data: stdout
            });
        });
    }

    private _getHtmlForWebview(nodeName: string, initialContent: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Node Info: ${nodeName}</title>
    <style>
        body {
            font-family: var(--vscode-editor-font-family, monospace);
            padding: 15px;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        h2 {
            margin-top: 0;
            color: var(--vscode-symbolIcon-interfaceForeground);
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 8px;
        }
        .segment-container {
            display: flex;
            flex-direction: column;
            gap: 15px;
            max-height: 85vh;
            overflow-y: auto;
        }
        .section-card {
            background-color: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 12px;
        }
        .section-title {
            font-weight: bold;
            color: var(--vscode-symbolIcon-keywordForeground, #4fc1ff);
            margin-bottom: 8px;
            font-size: 14px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        pre {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 10px;
            border-radius: 4px;
            margin: 0;
            white-space: pre-wrap;
            word-break: break-all;
            font-size: 12px;
            color: var(--vscode-editor-foreground);
        }
    </style>
</head>
<body>
    <h2>Node Info: ${nodeName}</h2>
    <div id="output" class="segment-container">
        <div class="section-card">
            <pre>${initialContent}</pre>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const outputDiv = document.getElementById('output');

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'nodeInfoData') {
                outputDiv.innerHTML = '';
                const rawText = message.data;

                const rawSections = rawText.split(/(?=\\n[A-Za-z\\s]+:)/);

                if (rawSections.length === 0 || rawText.trim() === '') {
                    const card = document.createElement('div');
                    card.className = 'section-card';
                    card.innerHTML = '<pre>' + (rawText || 'No information returned.') + '</pre>';
                    outputDiv.appendChild(card);
                } else {
                    rawSections.forEach(sec => {
                        const trimmed = sec.trim();
                        if (trimmed.length > 0) {
                            const lines = trimmed.split('\\n');
                            let title = '';
                            let content = trimmed;

                            if (lines[0].endsWith(':')) {
                                title = lines[0].slice(0, -1).trim();
                                content = lines.slice(1).join('\\n').trim();
                            }

                            const card = document.createElement('div');
                            card.className = 'section-card';
                            
                            if (title) {
                                const titleDiv = document.createElement('div');
                                titleDiv.className = 'section-title';
                                titleDiv.textContent = title;
                                card.appendChild(titleDiv);
                            }

                            const pre = document.createElement('pre');
                            pre.textContent = content || 'None';
                            card.appendChild(pre);

                            outputDiv.appendChild(card);
                        }
                    });
                }
            }
        });
    </script>
</body>
</html>`;
    }

    public dispose() {
        NodeInfoPanel.currentPanels.delete(this.nodeName);
        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}

/**
 * Manages Service Call Webview Panels
 */
class ServiceCallPanel {
    public static currentPanels: Map<string, ServiceCallPanel> = new Map();
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private serviceType: string = '';
    private started = false;
    private typeMessage: object | undefined;
    private template: string | undefined;
    private serviceProcess: ChildProcess | undefined;

    public static createOrShow(extensionUri: vscode.Uri, serviceName: string) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (ServiceCallPanel.currentPanels.has(serviceName)) {
            ServiceCallPanel.currentPanels.get(serviceName)!._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'ros2ServiceCall',
            `Service: ${serviceName}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true
            }
        );

        ServiceCallPanel.currentPanels.set(serviceName, new ServiceCallPanel(panel, serviceName));
    }

    private constructor(panel: vscode.WebviewPanel, private readonly serviceName: string) {
        this._panel = panel;
        this._panel.webview.html = secureWebviewHtml(this._panel.webview, this._getHtmlForWebview(this.serviceName, 'Fetching service type...'));

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            message => {
                if (message.command === 'ready') {
                    this._onReady();
                } else if (message.command === 'callService') {
                    this._executeServiceCall(message.args);
                }
            },
            null,
            this._disposables
        );
    }

    // The webview announces itself once its script is listening; only then do we send data,
    // because messages posted earlier are silently dropped.
    private _onReady() {
        if (this.started) {
            // Webview was reloaded: replay what we already know.
            if (this.typeMessage) {
                this._panel.webview.postMessage(this.typeMessage);
            }
            if (this.template !== undefined) {
                this._panel.webview.postMessage({ command: 'setTemplateOnce', template: this.template });
            }
            return;
        }
        this.started = true;
        this._fetchServiceType();
    }

    private _fetchServiceType() {
        const cmd = `bash -c "${rosEnvironment.setupCommand} && ros2 service type ${this.serviceName}"`;

        processManager.exec(cmd, { env: process.env }, (error, stdout, stderr) => {
            if (error || stderr) {
                this.serviceType = 'Unknown';
                this.typeMessage = {
                    command: 'initType',
                    serviceType: 'Unknown (Check terminal)',
                    error: stderr || error?.message
                };
                this._panel.webview.postMessage(this.typeMessage);
                return;
            }
            this.serviceType = stdout.trim();
            this.typeMessage = { command: 'initType', serviceType: this.serviceType };
            this._panel.webview.postMessage(this.typeMessage);

            this._fetchInterfaceTemplate(this.serviceType);
        });
    }

    private _fetchInterfaceTemplate(serviceType: string) {
        readInterfaceDefinition(serviceType, (error, stdout, stderr) => {
            if (error || !stdout.trim()) {
                this.template = '{}';
                const reason = (stderr || error?.message || 'empty output').trim();
                this._panel.webview.postMessage({
                    command: 'serviceResponse',
                    data: `Could not load the request template (using {}):\n${reason}`
                });
            } else {
                // The request section is everything before the first '---'.
                this.template = buildGoalTemplate(stdout);
            }
            this._panel.webview.postMessage({ command: 'setTemplateOnce', template: this.template });
        });
    }

    private _executeServiceCall(args: string) {
        if (!this.serviceType || this.serviceType === 'Unknown') {
            this._panel.webview.postMessage({ command: 'serviceState', running: false });
            this._panel.webview.postMessage({
                command: 'serviceResponse',
                data: 'Error: Valid service type not found. Cannot execute call.'
            });
            return;
        }
        if (this.serviceProcess) {
            return;
        }

        const flattenedArgs = args.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
        const env = {
            ...process.env,
            PYTHONUNBUFFERED: '1',
            SVC_NAME: this.serviceName,
            SVC_TYPE: this.serviceType,
            SVC_ARGS: flattenedArgs
        };
        const script = `${rosEnvironment.setupCommand} && exec ros2 service call "$SVC_NAME" "$SVC_TYPE" "$SVC_ARGS"`;
        const show = (text: string) => this._panel.webview.postMessage({ command: 'serviceResponse', data: text });

        this._panel.webview.postMessage({ command: 'serviceState', running: true });
        show(`Calling ${this.serviceName}...`);

        let stdout = '';
        let stderr = '';
        let finished = false;
        const child = processManager.spawn('bash', ['-c', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        this.serviceProcess = child;

        const finish = (message: string) => {
            if (finished) {
                return;
            }
            finished = true;
            clearTimeout(timeout);
            this.serviceProcess = undefined;
            this._panel.webview.postMessage({ command: 'serviceState', running: false });
            show(message);
        };

        const timeout = setTimeout(() => {
            processManager.terminate(child, 'SIGTERM', 0);
            finish('No response after 30s. Is the service server running on the selected ROS domain?');
        }, 30000);

        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on('error', err => finish(`Failed to start: ${err.message}`));
        child.on('close', code => {
            if (code !== 0) {
                finish(`Error executing service call:\n${(stderr || stdout).trim()}`);
                return;
            }
            const idx = stdout.indexOf('response:');
            const result = (idx >= 0 ? stdout.slice(idx + 'response:'.length) : stdout).trim();
            const open = result.indexOf('(');
            const close = result.lastIndexOf(')');
            const fields = open >= 0 && close > open ? result.slice(open + 1, close) : result;
            finish(fields || 'Service called successfully.');
        });
    }

    private _getHtmlForWebview(serviceName: string, statusText: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Service: ${serviceName}</title>
    <style>
        body {
            font-family: var(--vscode-editor-font-family, monospace);
            padding: 20px;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        h2 {
            margin-top: 0;
            color: var(--vscode-symbolIcon-methodForeground, #dcdcaa);
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 8px;
        }
        .info-box {
            margin-bottom: 15px;
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }
        .input-group {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-bottom: 15px;
        }
        textarea {
            width: 100%;
            height: 90px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 8px;
            font-family: monospace;
            border-radius: 4px;
            resize: vertical;
        }
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 14px;
            border-radius: 4px;
            cursor: pointer;
            font-weight: bold;
            align-self: flex-start;
        }
        button:hover:not(:disabled) {
            background-color: var(--vscode-button-hoverBackground);
        }
        button:disabled {
            opacity: 0.7;
            cursor: default;
        }
        .spinner {
            display: inline-block;
            width: 12px;
            height: 12px;
            margin-right: 7px;
            border: 2px solid currentColor;
            border-right-color: transparent;
            border-radius: 50%;
            vertical-align: -2px;
            animation: spin 0.7s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .section-card {
            background-color: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 12px;
            margin-top: 15px;
        }
        .section-title {
            font-weight: bold;
            color: var(--vscode-symbolIcon-keywordForeground, #4fc1ff);
            margin-bottom: 8px;
            font-size: 13px;
        }
        pre {
            margin: 0;
            white-space: pre-wrap;
            word-break: break-all;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <h2>Service Call: ${serviceName}</h2>
    <div class="info-box" id="type-info">Type: ${statusText}</div>

    <div class="input-group">
        <label for="args-input"><strong>Request Arguments Template:</strong></label>
        <textarea id="args-input">{}</textarea>
        <button id="call-btn" type="button">Call Service</button>
    </div>

    <div class="section-card">
        <div class="section-title">Response Output</div>
        <pre id="output">Ready to send request...</pre>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const typeInfo = document.getElementById('type-info');
        const argsInput = document.getElementById('args-input');
        const callBtn = document.getElementById('call-btn');
        const outputPre = document.getElementById('output');

        let currentArgs = argsInput.value;
        let templateLoaded = false;
        let userEdited = false;

        argsInput.addEventListener('input', (e) => {
            currentArgs = e.target.value;
            userEdited = true;
        });

        const setServiceRunning = running => {
            callBtn.disabled = running;
            callBtn.innerHTML = running ? '<span class="spinner" aria-hidden="true"></span>Calling...' : 'Call Service';
        };

        callBtn.addEventListener('click', () => {
            if (callBtn.disabled) return;
            setServiceRunning(true);
            vscode.postMessage({ command: 'callService', args: currentArgs });
        });

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'initType') {
                typeInfo.textContent = 'Type: ' + message.serviceType;
                if (message.error) {
                    outputPre.textContent = 'Error fetching type: ' + message.error;
                }
            } else if (message.command === 'setTemplateOnce') {
                if (!templateLoaded && !userEdited) {
                    argsInput.value = message.template;
                    currentArgs = message.template;
                    templateLoaded = true;
                }
            } else if (message.command === 'serviceState') {
                setServiceRunning(message.running);
            } else if (message.command === 'serviceExecuting') {
                outputPre.textContent = message.info;
            } else if (message.command === 'serviceResponse') {
                outputPre.textContent = message.data;
            }
        });

        vscode.postMessage({ command: 'ready' });
    </script>
</body>
</html>`;
    }

    public dispose() {
        ServiceCallPanel.currentPanels.delete(this.serviceName);
        if (this.serviceProcess) {
            processManager.terminate(this.serviceProcess, 'SIGTERM');
            this.serviceProcess = undefined;
        }
        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}

export function deactivate() {
    launchManager?.dispose();
}

/**
 * Manages Action Goal Webview Panels
 */
class ActionGoalPanel {
    public static currentPanels: Map<string, ActionGoalPanel> = new Map();
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private actionType: string = '';
    private goalProcess: ChildProcess | undefined;
    private cancelled = false;
    private started = false;
    private typeMessage: object | undefined;
    private template: string | undefined;

    public static createOrShow(extensionUri: vscode.Uri, actionName: string) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        if (ActionGoalPanel.currentPanels.has(actionName)) {
            ActionGoalPanel.currentPanels.get(actionName)!._panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'ros2ActionGoal',
            `Action: ${actionName}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true
            }
        );

        ActionGoalPanel.currentPanels.set(actionName, new ActionGoalPanel(panel, actionName));
    }

    private constructor(panel: vscode.WebviewPanel, private readonly actionName: string) {
        this._panel = panel;
        this._panel.webview.html = secureWebviewHtml(this._panel.webview, this._getHtmlForWebview(this.actionName));

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            message => {
                if (message.command === 'ready') {
                    this._onReady();
                } else if (message.command === 'sendGoal') {
                    this._sendGoal(message.args);
                } else if (message.command === 'cancelGoal') {
                    this._cancelGoal();
                }
            },
            null,
            this._disposables
        );
    }

    // The webview announces itself once its script is listening; only then do we send data,
    // because messages posted earlier are silently dropped.
    private _onReady() {
        if (this.started) {
            // Webview was reloaded: replay what we already know.
            if (this.typeMessage) {
                this._post(this.typeMessage);
            }
            if (this.template !== undefined) {
                this._post({ command: 'setTemplateOnce', template: this.template });
            }
            return;
        }
        this.started = true;
        this._fetchActionType();
    }

    private _post(message: object) {
        this._panel.webview.postMessage(message);
    }

    private _fetchActionType() {
        const cmd = `bash -c "${rosEnvironment.setupCommand} && ros2 action list -t"`;

        processManager.exec(cmd, { env: process.env }, (error, stdout, stderr) => {
            const type = error ? undefined : parseActionType(stdout, this.actionName);
            if (!type) {
                this.actionType = 'Unknown';
                this.typeMessage = {
                    command: 'initType',
                    actionType: 'Unknown (is the action server running?)',
                    error: stderr || error?.message
                };
                this._post(this.typeMessage);
                return;
            }
            this.actionType = type;
            this.typeMessage = { command: 'initType', actionType: type };
            this._post(this.typeMessage);
            this._fetchGoalTemplate(type);
        });
    }

    private _fetchGoalTemplate(actionType: string) {
        readInterfaceDefinition(actionType, (error, stdout, stderr) => {
            if (error || !stdout.trim()) {
                this.template = '{}';
                const reason = (stderr || error?.message || 'empty output').trim();
                this._post({ command: 'goalOutput', data: `Could not load the goal template (using {}):\n${reason}` });
            } else {
                this.template = buildGoalTemplate(stdout);
            }
            this._post({ command: 'setTemplateOnce', template: this.template });
        });
    }

    private _sendGoal(args: string) {
        if (!this.actionType || this.actionType === 'Unknown') {
            this._post({ command: 'goalState', running: false });
            this._post({ command: 'goalOutput', data: 'Error: Valid action type not found. Cannot send goal.' });
            return;
        }
        if (this.goalProcess) {
            this._post({ command: 'goalOutput', data: 'A goal is already running. Cancel it first.' });
            return;
        }

        const flattenedArgs = args.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();

        // Values travel through environment variables, so no shell quoting can alter them.
        const env = {
            ...process.env,
            PYTHONUNBUFFERED: '1',
            ACT_NAME: this.actionName,
            ACT_TYPE: this.actionType,
            ACT_GOAL: flattenedArgs
        };
        // exec replaces the shell, so signals reach the ros2 process directly.
        const script = `${rosEnvironment.setupCommand} && exec ros2 action send_goal --feedback "$ACT_NAME" "$ACT_TYPE" "$ACT_GOAL"`;

        this.cancelled = false;
        this._post({ command: 'goalOutput', data: `Sending goal to ${this.actionName} (${this.actionType})...` });
        this._post({ command: 'goalState', running: true });

        let stdout = '';
        let stderr = '';
        const child = processManager.spawn('bash', ['-c', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        this.goalProcess = child;

        child.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
            this._post({ command: 'goalOutput', data: formatGoalOutput(stdout) });
        });
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

        const finish = (message: string) => {
            this.goalProcess = undefined;
            this._post({ command: 'goalState', running: false });
            this._post({ command: 'goalOutput', data: message });
        };

        child.on('error', (err) => finish(`Failed to start: ${err.message}`));
        child.on('close', (code) => {
            if (this.cancelled) {
                const partial = stdout.search(/Goal (accepted|rejected)/) >= 0 ? formatGoalOutput(stdout) + '\n\n' : '';
                finish(`${partial}Cancelled by user.`);
            } else if (code !== 0) {
                finish(`Error sending goal:\n${(stderr || stdout).trim()}`);
            } else {
                finish(formatGoalOutput(stdout));
            }
        });
    }

    private _cancelGoal() {
        const child = this.goalProcess;
        if (!child) {
            return;
        }
        this.cancelled = true;
        processManager.terminate(child, 'SIGINT'); // same as Ctrl+C in a terminal
    }

    private _getHtmlForWebview(actionName: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Action: ${escapeHtml(actionName)}</title>
    <style>
        body {
            font-family: var(--vscode-editor-font-family, monospace);
            padding: 20px;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        h2 {
            margin-top: 0;
            color: var(--vscode-symbolIcon-methodForeground, #dcdcaa);
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 8px;
        }
        .info-box {
            margin-bottom: 15px;
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
        }
        .input-group {
            display: flex;
            flex-direction: column;
            gap: 8px;
            margin-bottom: 15px;
        }
        textarea {
            width: 100%;
            height: 110px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 8px;
            font-family: monospace;
            border-radius: 4px;
            resize: vertical;
        }
        .button-row {
            display: flex;
            gap: 8px;
        }
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 14px;
            border-radius: 4px;
            cursor: pointer;
            font-weight: bold;
        }
        button:hover:not(:disabled) {
            background-color: var(--vscode-button-hoverBackground);
        }
        button:disabled {
            opacity: 0.5;
            cursor: default;
        }
        .spinner {
            display: inline-block;
            width: 12px;
            height: 12px;
            margin-right: 7px;
            border: 2px solid currentColor;
            border-right-color: transparent;
            border-radius: 50%;
            vertical-align: -2px;
            animation: spin 0.7s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        button.secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .section-card {
            background-color: var(--vscode-textCodeBlock-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 6px;
            padding: 12px;
            margin-top: 15px;
        }
        .section-title {
            font-weight: bold;
            color: var(--vscode-symbolIcon-keywordForeground, #4fc1ff);
            margin-bottom: 8px;
            font-size: 13px;
        }
        pre {
            margin: 0;
            white-space: pre-wrap;
            word-break: break-all;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <h2>Action Goal: ${escapeHtml(actionName)}</h2>
    <div class="info-box" id="type-info">Type: Fetching action type...</div>

    <div class="input-group">
        <label for="goal-input"><strong>Goal (YAML):</strong></label>
        <textarea id="goal-input">{}</textarea>
        <div class="button-row">
            <button id="send-btn">Send Goal</button>
            <button id="cancel-btn" class="secondary" disabled>Cancel</button>
        </div>
    </div>

    <div class="section-card">
        <div class="section-title">Response, Feedback and Result</div>
        <pre id="output">Ready to send goal...</pre>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const typeInfo = document.getElementById('type-info');
        const goalInput = document.getElementById('goal-input');
        const sendBtn = document.getElementById('send-btn');
        const cancelBtn = document.getElementById('cancel-btn');
        const outputPre = document.getElementById('output');

        let templateLoaded = false;
        let userEdited = false;

        goalInput.addEventListener('input', () => {
            userEdited = true;
        });

        const setGoalRunning = running => {
            sendBtn.disabled = running;
            sendBtn.innerHTML = running ? '<span class="spinner" aria-hidden="true"></span>Sending...' : 'Send Goal';
        };

        sendBtn.addEventListener('click', () => {
            if (sendBtn.disabled) return;
            setGoalRunning(true);
            vscode.postMessage({ command: 'sendGoal', args: goalInput.value });
        });

        cancelBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'cancelGoal' });
        });

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'initType') {
                typeInfo.textContent = 'Type: ' + message.actionType;
                if (message.error) {
                    outputPre.textContent = 'Error fetching type: ' + message.error;
                }
            } else if (message.command === 'setTemplateOnce') {
                if (!templateLoaded && !userEdited) {
                    goalInput.value = message.template;
                    templateLoaded = true;
                }
            } else if (message.command === 'goalState') {
                setGoalRunning(message.running);
                cancelBtn.disabled = !message.running;
            } else if (message.command === 'goalOutput') {
                outputPre.textContent = message.data;
            }
        });

        vscode.postMessage({ command: 'ready' });
    </script>
</body>
</html>`;
    }

    public dispose() {
        ActionGoalPanel.currentPanels.delete(this.actionName);
        if (this.goalProcess) {
            this.cancelled = true;
            processManager.terminate(this.goalProcess, 'SIGINT');
        }
        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}