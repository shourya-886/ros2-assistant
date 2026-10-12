import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('ROS2 Assistant extension activation started.');

    try {
        // Hello World command
        const helloDisposable = vscode.commands.registerCommand('ros2-assistant.helloWorld', () => {
            vscode.window.showInformationMessage('Hello World from ROS2 Assistant!');
        });
        context.subscriptions.push(helloDisposable);

        // Tree Data Provider instance
        const treeDataProvider = new Ros2TreeDataProvider();
        vscode.window.registerTreeDataProvider('ros2View', treeDataProvider);

        // Go Back command implementation
        const backDisposable = vscode.commands.registerCommand('ros2-assistant.goBack', () => {
            treeDataProvider.goBack();
        });
        context.subscriptions.push(backDisposable);

        console.log('ROS2 Assistant successfully activated!');
    } catch (error) {
        console.error('Error during ROS2 Assistant activation:', error);
    }
}

class Ros2TreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly children?: Ros2TreeItem[]
    ) {
        super(label, collapsibleState);
        this.contextValue = children ? 'folder' : 'item';
    }
}

class Ros2TreeDataProvider implements vscode.TreeDataProvider<Ros2TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<Ros2TreeItem | undefined | void> = new vscode.EventEmitter<Ros2TreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<Ros2TreeItem | undefined | void> = this._onDidChangeTreeData.event;

    // Navigation history stack
    private history: Ros2TreeItem[][] = [];

    private rootItems: Ros2TreeItem[] = [
        new Ros2TreeItem('list node', vscode.TreeItemCollapsibleState.Collapsed, [
            new Ros2TreeItem('/talker', vscode.TreeItemCollapsibleState.None),
            new Ros2TreeItem('/listener', vscode.TreeItemCollapsibleState.None)
        ]),
        new Ros2TreeItem('list topics', vscode.TreeItemCollapsibleState.Collapsed, [
            new Ros2TreeItem('/chatter', vscode.TreeItemCollapsibleState.None),
            new Ros2TreeItem('/parameter_events', vscode.TreeItemCollapsibleState.None)
        ]),
        new Ros2TreeItem('list services', vscode.TreeItemCollapsibleState.Collapsed, [
            new Ros2TreeItem('/describe_node', vscode.TreeItemCollapsibleState.None)
        ]),
        new Ros2TreeItem('list actions', vscode.TreeItemCollapsibleState.Collapsed, [
            new Ros2TreeItem('/navigate_to_pose', vscode.TreeItemCollapsibleState.None)
        ])
    ];

    private currentItems: Ros2TreeItem[] = this.rootItems;

    getTreeItem(element: Ros2TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: Ros2TreeItem): Thenable<Ros2TreeItem[]> {
        if (!element) {
            return Promise.resolve(this.currentItems);
        }
        return Promise.resolve(element.children || []);
    }

    // Call this when the back button is clicked
    public goBack() {
        if (this.history.length > 0) {
            this.currentItems = this.history.pop()!;
            this._onDidChangeTreeData.fire();
            vscode.window.showInformationMessage('Went back a folder.');
        } else {
            vscode.window.showInformationMessage('Already at the root level.');
        }
    }

    // Optional: if you want clicking an item to drill down into a "folder view"
    public drillDown(item: Ros2TreeItem) {
        if (item.children && item.children.length > 0) {
            this.history.push(this.currentItems);
            this.currentItems = item.children;
            this._onDidChangeTreeData.fire();
        }
    }
}

export function deactivate() {}