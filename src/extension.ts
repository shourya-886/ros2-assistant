import * as vscode from 'vscode';
import { exec, spawn, ChildProcess, ChildProcessWithoutNullStreams } from 'child_process';

// Must match the shell where your ROS 2 nodes run (domain and RMW from ~/.bashrc).
// Mixing RMW implementations (e.g. Fast DDS client with a CycloneDDS server) breaks service calls.
const ROS_SETUP =
    'export ROS_DOMAIN_ID=3 && export RMW_IMPLEMENTATION=rmw_cyclonedds_cpp && source /opt/ros/humble/setup.bash';

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

export function activate(context: vscode.ExtensionContext) {

    try {
        const helloDisposable = vscode.commands.registerCommand('ros2-assistant.helloWorld', () => {
            vscode.window.showInformationMessage('Hello World from ROS2 Assistant!');
        });
        context.subscriptions.push(helloDisposable);

        const treeDataProvider = new Ros2TreeDataProvider();
        vscode.window.registerTreeDataProvider('ros2View', treeDataProvider);

        context.subscriptions.push({
            dispose: () => treeDataProvider.dispose()
        });

        const backDisposable = vscode.commands.registerCommand('ros2-assistant.goBack', () => {
            treeDataProvider.goBack();
        });
        context.subscriptions.push(backDisposable);

        const selectDisposable = vscode.commands.registerCommand('ros2-assistant.selectItem', (viewType: string) => {
            treeDataProvider.navigateTo(viewType);
        });
        context.subscriptions.push(selectDisposable);

        // Command to open Topic Echo Webview tab
        const inspectTopicDisposable = vscode.commands.registerCommand('ros2-assistant.inspectItem', (item: Ros2TreeItem) => {
            if (item.viewType === 'topics') {
                TopicEchoPanel.createOrShow(context.extensionUri, item.label);
            }
        });
        context.subscriptions.push(inspectTopicDisposable);

        // Command to open Node Info Webview tab
        const inspectNodeDisposable = vscode.commands.registerCommand('ros2-assistant.inspectNode', (item: Ros2TreeItem) => {
            if (item.viewType === 'nodes') {
                NodeInfoPanel.createOrShow(context.extensionUri, item.label);
            }
        });
        context.subscriptions.push(inspectNodeDisposable);

        // Command to open Service Call Webview tab
        const inspectServiceDisposable = vscode.commands.registerCommand('ros2-assistant.inspectService', (item: Ros2TreeItem) => {
            if (item.viewType === 'services') {
                ServiceCallPanel.createOrShow(context.extensionUri, item.label);
            }
        });
        context.subscriptions.push(inspectServiceDisposable);

        // Command to open Action Goal Webview tab
        const inspectActionDisposable = vscode.commands.registerCommand('ros2-assistant.inspectAction', (item: Ros2TreeItem) => {
            if (item.viewType === 'actions') {
                ActionGoalPanel.createOrShow(context.extensionUri, item.label);
            }
        });
        context.subscriptions.push(inspectActionDisposable);

    } catch (error) {
        console.error('Error during ROS2 Assistant activation:', error);
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

    getTreeItem(element: Ros2TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: Ros2TreeItem): Thenable<Ros2TreeItem[]> {
        if (element) {
            return Promise.resolve([]);
        }

        if (this.currentView === 'root') {
            return Promise.resolve([
                new Ros2TreeItem('List Topics', vscode.TreeItemCollapsibleState.None, 'root', {
                    command: 'ros2-assistant.selectItem',
                    title: 'Select Topics View',
                    arguments: ['topics']
                }, new vscode.ThemeIcon('broadcast')),
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
                }, new vscode.ThemeIcon('server'))
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
        }, 1000);
    }

    private stopPolling() {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = undefined;
        }
    }

    private fetchData() {
        if (this.currentView === 'root') {
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

        const fullCmd = `bash -c "${ROS_SETUP} && ${cmd}"`;

        exec(fullCmd, { env: process.env }, (error, stdout) => {
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
 * Manages Topic Echo Webview Panels
 */
class TopicEchoPanel {
    public static currentPanels: Map<string, TopicEchoPanel> = new Map();
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _process: ChildProcessWithoutNullStreams | undefined;

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
        this._panel.webview.html = this._getHtmlForWebview(this.topicName);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._startEchoProcess();
    }

    private _startEchoProcess() {
        const echoCmd = `${ROS_SETUP} && ros2 topic echo ${this.topicName}`;
        this._process = spawn('bash', ['-c', echoCmd], { env: process.env });

        this._process.stdout.on('data', (data) => {
            const message = data.toString();
            this._panel.webview.postMessage({ command: 'echoData', data: message });
        });

        this._process.stderr.on('data', (data) => {
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
    <div id="output" class="segment-container">
        <div class="message-card">Waiting for messages on ${topicName}...</div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const outputDiv = document.getElementById('output');
        let initialCleared = false;

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
                outputDiv.scrollTop = outputDiv.scrollHeight;
            }
        });
    </script>
</body>
</html>`;
    }

    public dispose() {
        TopicEchoPanel.currentPanels.delete(this.topicName);

        if (this._process) {
            this._process.kill();
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
        this._panel.webview.html = this._getHtmlForWebview(this.nodeName, 'Loading node information...');

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._fetchNodeInfo();
    }

    private _fetchNodeInfo() {
        const innerCmd = `${ROS_SETUP} && ros2 node info ${this.nodeName}`;
        const cmd = `bash -c "${innerCmd}"`;

        exec(cmd, { env: process.env }, (error, stdout, stderr) => {
            if (error) {
                this._panel.webview.postMessage({
                    command: 'nodeInfoData',
                    data: `Error executing command:\n${stderr || error.message}`
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
        this._panel.webview.html = this._getHtmlForWebview(this.serviceName, 'Fetching service type...');

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            message => {
                if (message.command === 'callService') {
                    this._executeServiceCall(message.args);
                }
            },
            null,
            this._disposables
        );

        this._fetchServiceType();
    }

    private _fetchServiceType() {
        const cmd = `bash -c "${ROS_SETUP} && ros2 service type ${this.serviceName}"`;

        exec(cmd, { env: process.env }, (error, stdout, stderr) => {
            if (error || stderr) {
                this.serviceType = 'Unknown';
                this._panel.webview.postMessage({
                    command: 'initType',
                    serviceType: 'Unknown (Check terminal)',
                    error: stderr || error?.message
                });
                return;
            }
            this.serviceType = stdout.trim();
            this._panel.webview.postMessage({
                command: 'initType',
                serviceType: this.serviceType
            });

            this._fetchInterfaceTemplate(this.serviceType);
        });
    }

    private _fetchInterfaceTemplate(serviceType: string) {
        const cmd = `bash -c "${ROS_SETUP} && ros2 interface show ${serviceType}"`;

        exec(cmd, { env: process.env }, (error, stdout) => {
            if (error || !stdout) {
                this._panel.webview.postMessage({
                    command: 'setTemplateOnce',
                    template: '{\n  a: 0,\n  b: 0\n}'
                });
                return;
            }

            const lines = stdout.split(/\r?\n/);
            let isRequest = true;
            let reqFields: string[] = [];

            for (let line of lines) {
                const trimmed = line.trim();
                if (trimmed === '---') {
                    isRequest = false;
                    continue;
                }
                if (isRequest && trimmed && !trimmed.startsWith('#')) {
                    const parts = trimmed.split(/\s+/);
                    if (parts.length >= 2) {
                        const fieldName = parts[parts.length - 1];
                        reqFields.push(fieldName);
                    }
                }
            }

            let yamlTemplate = '{\n';
            if (reqFields.length > 0) {
                reqFields.forEach((field, index) => {
                    yamlTemplate += `  ${field}: 0${index === reqFields.length - 1 ? '' : ','}\n`;
                });
            }
            yamlTemplate += '}';

            this._panel.webview.postMessage({
                command: 'setTemplateOnce',
                template: yamlTemplate
            });
        });
    }

    private _executeServiceCall(args: string) {
        if (!this.serviceType || this.serviceType === 'Unknown') {
            this._panel.webview.postMessage({
                command: 'serviceResponse',
                data: 'Error: Valid service type not found. Cannot execute call.'
            });
            return;
        }

        const flattenedArgs = args.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();

        // Values travel through environment variables, so no shell quoting can alter them.
        const env = {
            ...process.env,
            PYTHONUNBUFFERED: '1',
            SVC_NAME: this.serviceName,
            SVC_TYPE: this.serviceType,
            SVC_ARGS: flattenedArgs
        };
        const script = `${ROS_SETUP} && ros2 service call "$SVC_NAME" "$SVC_TYPE" "$SVC_ARGS"`;

        const show = (text: string) => {
            this._panel.webview.postMessage({ command: 'serviceResponse', data: text });
        };
        show(`Calling ${this.serviceName} (${this.serviceType})...`);

        let stdout = '';
        let stderr = '';
        const child = spawn('bash', ['-c', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        const timeout = setTimeout(() => {
            child.kill();
            show('No response after 30s. Is the service server running (same domain and RMW)?');
        }, 30000);

        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on('error', (err) => {
            clearTimeout(timeout);
            show(`Failed to start: ${err.message}`);
        });
        child.on('close', (code) => {
            clearTimeout(timeout);
            if (code !== 0) {
                show(`Error executing service call:\n${(stderr || stdout).trim()}`);
                return;
            }
            // Show only the fields, e.g. "sum=3" instead of "example_interfaces.srv.AddTwoInts_Response(sum=3)".
            const idx = stdout.indexOf('response:');
            const result = (idx >= 0 ? stdout.slice(idx + 'response:'.length) : stdout).trim();
            const open = result.indexOf('(');
            const close = result.lastIndexOf(')');
            const fields = open >= 0 && close > open ? result.slice(open + 1, close) : result;
            show(fields || 'Service called successfully.');
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
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
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
    <h2>Service Call: ${serviceName}</h2>
    <div class="info-box" id="type-info">Type: ${statusText}</div>

    <div class="input-group">
        <label for="args-input"><strong>Request Arguments Template:</strong></label>
        <textarea id="args-input">{\n  a: 0,\n  b: 0\n}</textarea>
        <button id="call-btn">Call Service</button>
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

        argsInput.addEventListener('input', (e) => {
            currentArgs = e.target.value;
        });

        callBtn.addEventListener('click', () => {
            vscode.postMessage({
                command: 'callService',
                args: currentArgs
            });
        });

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'initType') {
                typeInfo.textContent = 'Type: ' + message.serviceType;
                if (message.error) {
                    outputPre.textContent = 'Error fetching type: ' + message.error;
                }
            } else if (message.command === 'setTemplateOnce') {
                if (!templateLoaded) {
                    argsInput.value = message.template;
                    currentArgs = message.template;
                    templateLoaded = true;
                }
            } else if (message.command === 'serviceExecuting') {
                outputPre.textContent = message.info;
            } else if (message.command === 'serviceResponse') {
                outputPre.textContent = message.data;
            }
        });
    </script>
</body>
</html>`;
    }

    public dispose() {
        ServiceCallPanel.currentPanels.delete(this.serviceName);
        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}

export function deactivate() {}

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
        this._panel.webview.html = this._getHtmlForWebview(this.actionName);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            message => {
                if (message.command === 'sendGoal') {
                    this._sendGoal(message.args);
                } else if (message.command === 'cancelGoal') {
                    this._cancelGoal();
                }
            },
            null,
            this._disposables
        );

        this._fetchActionType();
    }

    private _post(message: object) {
        this._panel.webview.postMessage(message);
    }

    private _fetchActionType() {
        const cmd = `bash -c "${ROS_SETUP} && ros2 action list -t"`;

        exec(cmd, { env: process.env }, (error, stdout, stderr) => {
            const type = error ? undefined : parseActionType(stdout, this.actionName);
            if (!type) {
                this.actionType = 'Unknown';
                this._post({
                    command: 'initType',
                    actionType: 'Unknown (is the action server running?)',
                    error: stderr || error?.message
                });
                return;
            }
            this.actionType = type;
            this._post({ command: 'initType', actionType: type });
            this._fetchGoalTemplate(type);
        });
    }

    private _fetchGoalTemplate(actionType: string) {
        const cmd = `bash -c "${ROS_SETUP} && ros2 interface show ${actionType}"`;

        exec(cmd, { env: process.env }, (error, stdout) => {
            this._post({
                command: 'setTemplateOnce',
                template: error || !stdout ? '{}' : buildGoalTemplate(stdout)
            });
        });
    }

    private _sendGoal(args: string) {
        if (!this.actionType || this.actionType === 'Unknown') {
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
        const script = `${ROS_SETUP} && exec ros2 action send_goal --feedback "$ACT_NAME" "$ACT_TYPE" "$ACT_GOAL"`;

        this.cancelled = false;
        this._post({ command: 'goalOutput', data: `Sending goal to ${this.actionName} (${this.actionType})...` });
        this._post({ command: 'goalState', running: true });

        let stdout = '';
        let stderr = '';
        const child = spawn('bash', ['-c', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
        child.kill('SIGINT'); // same as Ctrl+C in a terminal
        setTimeout(() => {
            if (this.goalProcess === child) {
                child.kill('SIGKILL');
            }
        }, 3000);
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

        sendBtn.addEventListener('click', () => {
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
                if (!templateLoaded) {
                    goalInput.value = message.template;
                    templateLoaded = true;
                }
            } else if (message.command === 'goalState') {
                sendBtn.disabled = message.running;
                cancelBtn.disabled = !message.running;
            } else if (message.command === 'goalOutput') {
                outputPre.textContent = message.data;
            }
        });
    </script>
</body>
</html>`;
    }

    public dispose() {
        ActionGoalPanel.currentPanels.delete(this.actionName);
        if (this.goalProcess) {
            this.cancelled = true;
            this.goalProcess.kill('SIGINT');
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