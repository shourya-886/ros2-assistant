import * as vscode from 'vscode';
import { exec } from 'child_process';

export function activate(context: vscode.ExtensionContext) {
    console.log('ROS2 Assistant extension activation started.');

    try {
        const helloDisposable = vscode.commands.registerCommand('ros2-assistant.helloWorld', () => {
            vscode.window.showInformationMessage('Hello World from ROS2 Assistant!');
        });
        context.subscriptions.push(helloDisposable);

        const treeDataProvider = new Ros2TreeDataProvider();
        vscode.window.registerTreeDataProvider('ros2View', treeDataProvider);

        // Clean up polling interval when extension deactivates
        context.subscriptions.push({
            dispose: () => treeDataProvider.dispose()
        });

        // Command for the header Back button
        const backDisposable = vscode.commands.registerCommand('ros2-assistant.goBack', () => {
            treeDataProvider.goBack();
        });
        context.subscriptions.push(backDisposable);

        // Command triggered when clicking a main menu button
        const selectDisposable = vscode.commands.registerCommand('ros2-assistant.selectItem', (viewType: string) => {
            treeDataProvider.navigateTo(viewType);
        });
        context.subscriptions.push(selectDisposable);

        console.log('ROS2 Assistant successfully activated!');
    } catch (error) {
        console.error('Error during ROS2 Assistant activation:', error);
    }
}

class Ros2TreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly command?: vscode.Command
    ) {
        super(label, collapsibleState);
        this.command = command;
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
                new Ros2TreeItem('list node', vscode.TreeItemCollapsibleState.None, {
                    command: 'ros2-assistant.selectItem',
                    title: 'Select Node View',
                    arguments: ['nodes']
                }),
                new Ros2TreeItem('list topics', vscode.TreeItemCollapsibleState.None, {
                    command: 'ros2-assistant.selectItem',
                    title: 'Select Topics View',
                    arguments: ['topics']
                }),
                new Ros2TreeItem('list services', vscode.TreeItemCollapsibleState.None, {
                    command: 'ros2-assistant.selectItem',
                    title: 'Select Services View',
                    arguments: ['services']
                }),
                new Ros2TreeItem('list actions', vscode.TreeItemCollapsibleState.None, {
                    command: 'ros2-assistant.selectItem',
                    title: 'Select Actions View',
                    arguments: ['actions']
                })
            ]);
        } else {
            // Render fetched items or "nothing here" fallback
            if (this.currentItems.length === 0) {
                return Promise.resolve([new Ros2TreeItem('nothing here', vscode.TreeItemCollapsibleState.None)]);
            }
            return Promise.resolve(
                this.currentItems.map(item => new Ros2TreeItem(item, vscode.TreeItemCollapsibleState.None))
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
        this.fetchData(); // Fetch immediately on open
        this.refreshInterval = setInterval(() => {
            this.fetchData();
        }, 1000); // Poll every 1 second
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

        // Source both ROS2 Humble AND your workspace overlay (replace path with your actual workspace)
        const fullCmd = `bash -c "source /opt/ros/humble/setup.bash && source  ~/robot_ws/install/setup.bash 2>/dev/null || true && ${cmd}"`;

        exec(fullCmd, (error, stdout) => {
            let items: string[] = [];
            if (!error && stdout) {
                items = stdout
                    .split('\n')
                    .map(s => s.trim())
                    .filter(s => s.length > 0);
            }

            this.currentItems = items;
            this._onDidChangeTreeData.fire();
        });
    }

    public dispose() {
        this.stopPolling();
    }
}

export function deactivate() {}