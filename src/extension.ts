import * as vscode from 'vscode';
import { DebugServer } from './debug-server';
import { DebugTreeDataProvider } from './debug-tree-provider';
import * as fs from 'fs';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    // Get the storage path for your extension
    const storagePath = context.globalStorageUri.fsPath;

    // Ensure the storage directory exists
    fs.mkdirSync(storagePath, { recursive: true });
    const mcpServerPath = path.join(storagePath, 'mcp-debug.js');
    const sourcePath = path.join(context.extensionUri.fsPath, 'mcp', 'build', 'index.cjs');

    try {
        fs.copyFileSync(sourcePath, mcpServerPath);
    } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to setup debug server: ${err.message}`);
        return;
    }

    // --- Port registry helpers ---
    // Maps workspace folder paths to ports so the stdio bridge can find the right server
    const portConfigPath = path.join(storagePath, 'port-config.json');

    function readPortRegistry(): Record<string, number> {
        try {
            if (fs.existsSync(portConfigPath)) {
                return JSON.parse(fs.readFileSync(portConfigPath, 'utf8'));
            }
        } catch (_) { /* ignore */ }
        return {};
    }

    function writePortRegistry(registry: Record<string, number>): void {
        try {
            fs.writeFileSync(portConfigPath, JSON.stringify(registry, null, 2));
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to write port configuration: ${err.message}`);
        }
    }

    function registerWorkspacePorts(port: number): void {
        const registry = readPortRegistry();
        const folders = vscode.workspace.workspaceFolders ?? [];
        for (const folder of folders) {
            registry[folder.uri.fsPath] = port;
        }
        writePortRegistry(registry);
    }

    function unregisterWorkspacePorts(): void {
        const registry = readPortRegistry();
        const folders = vscode.workspace.workspaceFolders ?? [];
        for (const folder of folders) {
            delete registry[folder.uri.fsPath];
        }
        writePortRegistry(registry);
    }

    const config = vscode.workspace.getConfiguration('mcpDebug');
    const port = config.get<number>('port') ?? 4711;

    const server = new DebugServer(port);

    // Create tree view provider for the debug panel
    const treeProvider = new DebugTreeDataProvider(server, port, mcpServerPath);
    const treeView = vscode.window.registerTreeDataProvider('mcpDebugView', treeProvider);

    // Listen for server state changes
    server.on('started', () => treeProvider.refresh());
    server.on('stopped', () => treeProvider.refresh());

    // Listen for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async e => {
            if (e.affectsConfiguration('mcpDebug.port')) {
                // Always reload the latest configuration
                const updatedConfig = vscode.workspace.getConfiguration('mcpDebug');
                const newPort = updatedConfig.get<number>('port') ?? 4711;

                // Update server's port setting
                server.setPort(newPort);
                treeProvider.setPort(newPort);

                if (server.isRunning) {
                    // Port changed, restart server with new port
                    vscode.window.showInformationMessage(`Port changed to ${newPort}. Restarting server...`);
                    await vscode.commands.executeCommand('vscode-debug-mcp.restart');
                }
            } else if (e.affectsConfiguration('mcpDebug')) {
                treeProvider.refresh();
            }
        })
    );

    async function startServer() {
        // Always get the current port from config
        const updatedConfig = vscode.workspace.getConfiguration('mcpDebug');
        const currentPort = updatedConfig.get<number>('port') ?? 4711;
        server.setPort(currentPort);

        try {
            await server.start();
            // Update tree view and port registry with the actual port (may differ if configured port was in use)
            const actualPort = server.getPort();
            treeProvider.setPort(actualPort);
            registerWorkspacePorts(actualPort);
        } catch (err: any) {
            await server.stop();
            vscode.window.showErrorMessage(`Failed to start debug server: ${err.message}`);
        }
    }

    const startupConfig = vscode.workspace.getConfiguration('mcpDebug');
    if (startupConfig.get<boolean>('autostart')) {
        void startServer();
    }

    context.subscriptions.push(
        treeView,
        vscode.commands.registerCommand('vscode-debug-mcp.restart', async () => {
            try {
                await server.stop();
                await startServer();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to stop debug server: ${err.message}`);
                await startServer();
            }
        }),
        vscode.commands.registerCommand('vscode-debug-mcp.stop', () => {
            server.stop()
                .then(() => {
                    unregisterWorkspacePorts();
                    vscode.window.showInformationMessage('MCP Debug Server stopped');
                })
                .catch(err => {
                    vscode.window.showErrorMessage(`Failed to stop debug server: ${err.message}`);
                });
        }),
        vscode.commands.registerCommand('vscode-debug-mcp.copyStdioPath', async () => {
            await vscode.env.clipboard.writeText(mcpServerPath);
            vscode.window.showInformationMessage(`MCP stdio server path copied to clipboard.`);
        }),
        vscode.commands.registerCommand('vscode-debug-mcp.copySseAddress', async () => {
            await vscode.env.clipboard.writeText(`http://localhost:${server.getPort()}/sse`);
            vscode.window.showInformationMessage(`MCP sse server address copied to clipboard.`);
        }),
        vscode.commands.registerCommand('vscode-debug-mcp.copyClaudeCodeCommand', async () => {
            const command = `claude mcp add --transport stdio vscode-debug -- node "${mcpServerPath}"`;
            await vscode.env.clipboard.writeText(command);
            vscode.window.showInformationMessage('Claude Code setup command copied to clipboard.');
        }),
        vscode.commands.registerCommand('vscode-debug-mcp.setPort', async () => {
            // Always get the latest configuration
            const updatedConfig = vscode.workspace.getConfiguration('mcpDebug');
            const currentPort = updatedConfig.get<number>('port') ?? 4711;
            const newPort = await vscode.window.showInputBox({
                prompt: 'Enter port number for MCP Debug Server',
                placeHolder: 'Port number',
                value: currentPort.toString(),
                validateInput: (input) => {
                    const port = parseInt(input);
                    if (isNaN(port) || port < 1024 || port > 65535) {
                        return 'Please enter a valid port number (1024-65535)';
                    }
                    return null;
                }
            });

            if (newPort) {
                const portNum = parseInt(newPort);
                await updatedConfig.update('port', portNum, vscode.ConfigurationTarget.Global);

                // Update server's port setting directly
                server.setPort(portNum);
                treeProvider.setPort(portNum);

                if (server.isRunning) {
                    const restart = await vscode.window.showInformationMessage(
                        'Port updated. Restart server to apply changes?',
                        'Yes', 'No'
                    );

                    if (restart === 'Yes') {
                        vscode.commands.executeCommand('vscode-debug-mcp.restart');
                    }
                }
            }
        }),
        vscode.commands.registerCommand('vscode-debug-mcp.toggleAutostart', async () => {
            const updatedConfig = vscode.workspace.getConfiguration('mcpDebug');
            const currentAutostart = updatedConfig.get<boolean>('autostart') ?? true;
            await updatedConfig.update('autostart', !currentAutostart, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`Autostart ${!currentAutostart ? 'enabled' : 'disabled'}`);
            treeProvider.refresh();
        }),
    );
}

export function deactivate() {
    // We should already have cleaned up during context disposal, but just in case
}
