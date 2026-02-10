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

    const config = vscode.workspace.getConfiguration('mcpDebug');
    const port = config.get<number>('port') ?? 4711;

    // Write port configuration to a file that can be read by the MCP server
    const portConfigPath = path.join(storagePath, 'port-config.json');
    try {
        fs.writeFileSync(portConfigPath, JSON.stringify({ port }));
    } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to write port configuration: ${err.message}`);
    }

    const server = new DebugServer(port, portConfigPath);

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

                // Update port configuration file
                try {
                    const portConfigPath = path.join(storagePath, 'port-config.json');
                    fs.writeFileSync(portConfigPath, JSON.stringify({ port: newPort }));
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Failed to write port configuration: ${err.message}`);
                }

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
        } catch (err: any) {
            // Stop our own server
            await server.stop();

            // Check if this is likely a port conflict (server already running)
            const nodeErr = err as NodeJS.ErrnoException;
            if ((nodeErr.code === 'EADDRINUSE') || (nodeErr.message && nodeErr.message.includes('already running'))) {
                const response = await vscode.window.showInformationMessage(
                    `Failed to start debug server. Another server is likely already running in a different VS Code window. Would you like to stop it and start the server in this window?`,
                    'Yes', 'No', 'Disable Autostart'
                );

                if (response === 'Yes') {
                    try {
                        // First try to stop any existing server
                        await server.forceStopExistingServer();

                        // Wait for the port to be released with retry logic
                        let portAvailable = false;
                        let retryCount = 0;
                        const maxRetries = 5;
                        const currentPort = server.getPort();

                        while (!portAvailable && retryCount < maxRetries) {
                            try {
                                // Check if port is available
                                const net = require('net');
                                const testServer = net.createServer();

                                await new Promise<void>((resolve, reject) => {
                                    testServer.once('error', (err: any) => {
                                        testServer.close();
                                        if (err.code === 'EADDRINUSE') {
                                            reject(new Error('Port still in use'));
                                        } else {
                                            reject(err);
                                        }
                                    });

                                    testServer.once('listening', () => {
                                        testServer.close();
                                        portAvailable = true;
                                        resolve();
                                    });

                                    testServer.listen(currentPort);
                                });
                            } catch (err) {
                                // Port still in use, wait and retry
                                await new Promise(resolve => setTimeout(resolve, 500));
                                retryCount++;
                            }
                        }

                        if (!portAvailable) {
                            throw new Error(`Port ${currentPort} is still in use after ${maxRetries} attempts to release it`);
                        }

                        // Now try to start our server
                        await server.start();
                    } catch (startErr: any) {
                        vscode.window.showErrorMessage(`Still failed to start debug server: ${startErr.message}`);
                    }
                } else if (response === 'Disable Autostart') {
                    // Update autostart configuration to false
                    await startupConfig.update('autostart', false, vscode.ConfigurationTarget.Global);
                    vscode.window.showInformationMessage('Autostart has been disabled');
                }
            } else {
                vscode.window.showErrorMessage(`Failed to start debug server: ${err.message}`);
            }
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
            // Always get the latest port from config
            const updatedConfig = vscode.workspace.getConfiguration('mcpDebug');
            const currentPort = updatedConfig.get<number>('port') ?? 4711;
            await vscode.env.clipboard.writeText(`http://localhost:${currentPort}/sse`);
            vscode.window.showInformationMessage(`MCP sse server address copied to clipboard.`);
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

                // Update port configuration file
                try {
                    const portConfigPath = path.join(storagePath, 'port-config.json');
                    fs.writeFileSync(portConfigPath, JSON.stringify({ port: portNum }));
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Failed to write port configuration: ${err.message}`);
                }

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
