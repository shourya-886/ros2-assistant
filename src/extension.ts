import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('ROS2 Assistant extension activation started.');

    try {
        const helloDisposable = vscode.commands.registerCommand('ros2-assistant.helloWorld', () => {
            vscode.window.showInformationMessage('Hello World from ROS2 Assistant!');
        });
        context.subscriptions.push(helloDisposable);

        const treeDataProvider = new Ros2TreeDataProvider();
        vscode.window.registerTreeDataProvider('ros2View', treeDataProvider);

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

class Ros2TreeDataProvider implements vscode.TreeDataProvider<Ros2TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<Ros2TreeItem | undefined | void> = new vscode.EventEmitter<Ros2TreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<Ros2TreeItem | undefined | void> = this._onDidChangeTreeData.event;

    private history: string[] = [];
    private currentView: string = 'root';

    getTreeItem(element: Ros2TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: Ros2TreeItem): Thenable<Ros2TreeItem[]> {
        if (element) {
            return Promise.resolve([]);
        }

        // Render based on the current view state
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
        } else if (this.currentView === 'nodes') {
            return Promise.resolve([
                new Ros2TreeItem('/talker', vscode.TreeItemCollapsibleState.None),
                new Ros2TreeItem('/listener', vscode.TreeItemCollapsibleState.None)
            ]);
        } else if (this.currentView === 'topics') {
            return Promise.resolve([
                new Ros2TreeItem('/chatter', vscode.TreeItemCollapsibleState.None),
                new Ros2TreeItem('/parameter_events', vscode.TreeItemCollapsibleState.None)
            ]);
        } else if (this.currentView === 'services') {
            return Promise.resolve([
                new Ros2TreeItem('/describe_node', vscode.TreeItemCollapsibleState.None)
            ]);
        } else if (this.currentView === 'actions') {
            return Promise.resolve([
                new Ros2TreeItem('/navigate_to_pose', vscode.TreeItemCollapsibleState.None)
            ]);
        }

        return Promise.resolve([]);
    }

    public navigateTo(viewType: string) {
        this.history.push(this.currentView);
        this.currentView = viewType;
        this._onDidChangeTreeData.fire();
    }

    public goBack() {
        if (this.history.length > 0) {
            this.currentView = this.history.pop()!;
            this._onDidChangeTreeData.fire();
        } else {
            vscode.window.showInformationMessage('Already at the main menu.');
        }
    }
}

export function deactivate() {}