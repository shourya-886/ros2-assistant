import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "ros2-assistant" is now active!');

    // Existing helloWorld command
    const disposable = vscode.commands.registerCommand('ros2-assistant.helloWorld', () => {
        vscode.window.showInformationMessage('Hello World from ROS2 Assistant!');
    });
    context.subscriptions.push(disposable);

    // Register our custom sidebar tree view provider
    const treeDataProvider = new Ros2TreeDataProvider();
    vscode.window.registerTreeDataProvider('ros2View', treeDataProvider);
}

class Ros2TreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): Thenable<vscode.TreeItem[]> {
        // Return a "Hello World" item, or return an empty array [] to keep it completely empty
        return Promise.resolve([
            new vscode.TreeItem('Hello World', vscode.TreeItemCollapsibleState.None)
        ]);
    }
}

export function deactivate() {}