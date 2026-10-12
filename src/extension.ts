import * as vscode from 'vscode';
import { exec, spawn, ChildProcessWithoutNullStreams } from 'child_process';

export function activate(context: vscode.ExtensionContext) {
    console.log('ROS2 Assistant extension activation started.');

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
        const inspectDisposable = vscode.commands.registerCommand('ros2-assistant.inspectItem', (item: Ros2TreeItem) => {
            if (item.viewType === 'topics') {
                TopicEchoPanel.createOrShow(context.extensionUri, item.label);
            }
        });
        context.subscriptions.push(inspectDisposable);

        console.log('ROS2 Assistant successfully activated!');
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
                new Ros2TreeItem('list node', vscode.TreeItemCollapsibleState.None, 'root', {
                    command: 'ros2-assistant.selectItem',
                    title: 'Select Node View',
                    arguments: ['nodes']
                }, new vscode.ThemeIcon('server')),
                new Ros2TreeItem('list topics', vscode.TreeItemCollapsibleState.None, 'root', {
                    command: 'ros2-assistant.selectItem',
                    title: 'Select Topics View',
                    arguments: ['topics']
                }, new vscode.ThemeIcon('broadcast')),
                new Ros2TreeItem('list services', vscode.TreeItemCollapsibleState.None, 'root', {
                    command: 'ros2-assistant.selectItem',
                    title: 'Select Services View',
                    arguments: ['services']
                }, new vscode.ThemeIcon('symbol-method')),
                new Ros2TreeItem('list actions', vscode.TreeItemCollapsibleState.None, 'root', {
                    command: 'ros2-assistant.selectItem',
                    title: 'Select Actions View',
                    arguments: ['actions']
                }, new vscode.ThemeIcon('play'))
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
                    // Enable click handler to inspect topics
                    this.currentView === 'topics' ? {
                        command: 'ros2-assistant.inspectItem',
                        title: 'Echo Topic Messages',
                        arguments: [new Ros2TreeItem(item, vscode.TreeItemCollapsibleState.None, 'topics')]
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

        const fullCmd = `bash -c "export ROS_DOMAIN_ID=3 && source /opt/ros/humble/setup.bash && ${cmd}"`;

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

        // If panel already exists for this topic, reveal it
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

        // Start streaming ros2 topic echo
        this._startEchoProcess();
    }

    private _startEchoProcess() {
        const echoCmd = `export ROS_DOMAIN_ID=3 && source /opt/ros/humble/setup.bash && ros2 topic echo ${this.topicName}`;
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

export function deactivate() {}