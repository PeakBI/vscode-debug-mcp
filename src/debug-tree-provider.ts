import * as vscode from 'vscode';
import * as path from 'path';
import { DebugServer } from './debug-server';

export class DebugTreeDataProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private port: number;

    constructor(
        private server: DebugServer,
        port: number,
        private mcpServerPath: string
    ) {
        this.port = port;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    setPort(port: number): void {
        this.port = port;
        this.refresh();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(): vscode.TreeItem[] {
        const items: vscode.TreeItem[] = [];

        // Server status row
        const running = this.server.isRunning;
        const statusItem = new vscode.TreeItem(
            running ? 'Server: Running' : 'Server: Stopped',
            vscode.TreeItemCollapsibleState.None
        );
        statusItem.iconPath = new vscode.ThemeIcon(running ? 'debug-start' : 'debug-stop');
        statusItem.contextValue = running ? 'serverRunning' : 'serverStopped';
        items.push(statusItem);

        // Port row
        const portItem = new vscode.TreeItem('Port', vscode.TreeItemCollapsibleState.None);
        portItem.description = String(this.port);
        portItem.iconPath = new vscode.ThemeIcon('server');
        portItem.contextValue = 'port';
        portItem.command = {
            command: 'vscode-debug-mcp.setPort',
            title: 'Set Port'
        };
        items.push(portItem);

        // Stdio Path row
        const stdioItem = new vscode.TreeItem('Stdio Path', vscode.TreeItemCollapsibleState.None);
        stdioItem.description = path.basename(this.mcpServerPath);
        stdioItem.tooltip = this.mcpServerPath;
        stdioItem.iconPath = new vscode.ThemeIcon('file-code');
        stdioItem.contextValue = 'stdioPath';
        items.push(stdioItem);

        // SSE Address row
        const sseAddress = `http://localhost:${this.port}/sse`;
        const sseItem = new vscode.TreeItem('SSE Address', vscode.TreeItemCollapsibleState.None);
        sseItem.description = sseAddress;
        sseItem.iconPath = new vscode.ThemeIcon('globe');
        sseItem.contextValue = 'sseAddress';
        items.push(sseItem);

        // Autostart row
        const config = vscode.workspace.getConfiguration('mcpDebug');
        const autostart = config.get<boolean>('autostart') ?? true;
        const autostartItem = new vscode.TreeItem('Autostart', vscode.TreeItemCollapsibleState.None);
        autostartItem.description = autostart ? 'Enabled' : 'Disabled';
        autostartItem.iconPath = new vscode.ThemeIcon(autostart ? 'sync' : 'sync-ignored');
        autostartItem.contextValue = 'autostart';
        autostartItem.command = {
            command: 'vscode-debug-mcp.toggleAutostart',
            title: 'Toggle Autostart'
        };
        items.push(autostartItem);

        return items;
    }
}
