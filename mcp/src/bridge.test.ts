import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Determine the port config path (same logic as the bridge)
function getPortConfigPath(): string {
    const homeDir = os.homedir();
    let storagePath: string;
    if (process.platform === 'darwin') {
        storagePath = path.join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'peakbi.vscode-debug-mcp');
    } else if (process.platform === 'win32') {
        storagePath = path.join(homeDir, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'peakbi.vscode-debug-mcp');
    } else {
        storagePath = path.join(homeDir, '.config', 'Code', 'User', 'globalStorage', 'peakbi.vscode-debug-mcp');
    }
    return path.join(storagePath, 'port-config.json');
}

const MOCK_PORT = 24711;
const portConfigPath = getPortConfigPath();

let mockServer: http.Server;
let client: Client;
let transport: StdioClientTransport;
let originalPortConfig: string | null = null;
let lastRequest: { tool: string; arguments: any } | null = null;
let mockResponse: any = { message: 'mock response' };

// Start a mock HTTP server that mimics the extension's /tcp endpoint
function startMockServer(): Promise<void> {
    return new Promise((resolve) => {
        mockServer = http.createServer((req, res) => {
            if (req.method === 'POST' && req.url === '/tcp') {
                let body = '';
                req.on('data', (chunk: string) => body += chunk);
                req.on('end', () => {
                    const request = JSON.parse(body);

                    if (request.type === 'listTools') {
                        // The bridge never calls listTools via HTTP — it has its own tool list.
                        // But handle it for completeness.
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, data: { tools: [] } }));
                        return;
                    }

                    if (request.type === 'callTool') {
                        lastRequest = {
                            tool: request.tool,
                            arguments: request.arguments,
                        };
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, data: mockResponse }));
                        return;
                    }

                    res.writeHead(400).end('Unknown request type');
                });
                return;
            }
            res.writeHead(404).end();
        });

        mockServer.listen(MOCK_PORT, () => resolve());
    });
}

describe('Stdio Bridge', () => {
    beforeAll(async () => {
        // Save original port config if it exists
        if (fs.existsSync(portConfigPath)) {
            originalPortConfig = fs.readFileSync(portConfigPath, 'utf8');
        }

        // Write our mock port config
        fs.mkdirSync(path.dirname(portConfigPath), { recursive: true });
        fs.writeFileSync(portConfigPath, JSON.stringify({ port: MOCK_PORT }));

        // Start mock server
        await startMockServer();

        // Build the bridge first
        const buildPath = path.resolve(__dirname, '../build/index.cjs');
        if (!fs.existsSync(buildPath)) {
            throw new Error(`Bridge not built. Run "npm run build" in the mcp directory first. Expected: ${buildPath}`);
        }

        // Connect MCP client via stdio to the bridge process
        transport = new StdioClientTransport({
            command: 'node',
            args: [buildPath],
            stderr: 'pipe',
        });

        client = new Client(
            { name: 'test-client', version: '1.0.0' },
            { capabilities: {} },
        );

        await client.connect(transport);
    }, 15000);

    afterAll(async () => {
        // Close client and transport
        try {
            await client.close();
        } catch {
            // Client may already be closed
        }
        try {
            await transport.close();
        } catch {
            // Transport may already be closed
        }

        // Stop mock server
        await new Promise<void>((resolve) => {
            mockServer.close(() => resolve());
        });

        // Restore original port config
        if (originalPortConfig !== null) {
            fs.writeFileSync(portConfigPath, originalPortConfig);
        } else {
            // Remove the config file we created (but not the directory)
            try {
                fs.unlinkSync(portConfigPath);
            } catch {
                // Ignore if already gone
            }
        }
    });

    // --- ListTools ---

    it('listTools returns exactly 3 tools', async () => {
        const result = await client.listTools();
        expect(result.tools).toHaveLength(3);
    });

    it('listTools returns correct tool names', async () => {
        const result = await client.listTools();
        const names = result.tools.map(t => t.name);
        expect(names).toEqual(['debug_execute', 'debug_breakpoints', 'debug_inspect']);
    });

    it('debug_execute tool has correct action enum', async () => {
        const result = await client.listTools();
        const tool = result.tools.find(t => t.name === 'debug_execute')!;
        const actionProp = (tool.inputSchema.properties as any)?.action;
        expect(actionProp.enum).toEqual(['launch', 'stop', 'continue', 'stepOver', 'stepIn', 'stepOut']);
    });

    it('debug_breakpoints tool has correct action enum', async () => {
        const result = await client.listTools();
        const tool = result.tools.find(t => t.name === 'debug_breakpoints')!;
        const actionProp = (tool.inputSchema.properties as any)?.action;
        expect(actionProp.enum).toEqual(['set', 'remove', 'list']);
    });

    it('debug_inspect tool has correct action enum', async () => {
        const result = await client.listTools();
        const tool = result.tools.find(t => t.name === 'debug_inspect')!;
        const actionProp = (tool.inputSchema.properties as any)?.action;
        expect(actionProp.enum).toEqual(['evaluate', 'stackTrace']);
    });

    it('all tools require action parameter', async () => {
        const result = await client.listTools();
        for (const tool of result.tools) {
            const required = (tool.inputSchema as any).required;
            expect(required).toContain('action');
        }
    });

    // --- CallTool forwarding ---

    it('callTool forwards tool name and arguments to HTTP server', async () => {
        lastRequest = null;
        mockResponse = { breakpoints: [], count: 0 };

        const result = await client.callTool({
            name: 'debug_breakpoints',
            arguments: { action: 'list' },
        });

        // Verify the bridge forwarded the request correctly
        expect(lastRequest).not.toBeNull();
        expect(lastRequest!.tool).toBe('debug_breakpoints');
        expect(lastRequest!.arguments).toEqual({ action: 'list' });

        // Verify the response came back through the bridge
        const content = result.content as Array<{ type: string; text: string }>;
        expect(content).toHaveLength(1);
        expect(content[0].type).toBe('text');
        const parsed = JSON.parse(content[0].text);
        expect(parsed.breakpoints).toEqual([]);
        expect(parsed.count).toBe(0);
    });

    it('callTool forwards debug_execute with arguments', async () => {
        lastRequest = null;
        mockResponse = {
            message: 'Multiple debug configurations available. Specify configurationName.',
            configurations: ['Launch Program', 'Launch Tests'],
        };

        const result = await client.callTool({
            name: 'debug_execute',
            arguments: { action: 'launch' },
        });

        expect(lastRequest!.tool).toBe('debug_execute');
        expect(lastRequest!.arguments).toEqual({ action: 'launch' });

        const content = result.content as Array<{ type: string; text: string }>;
        const parsed = JSON.parse(content[0].text);
        expect(parsed.configurations).toEqual(['Launch Program', 'Launch Tests']);
    });

    it('callTool forwards debug_inspect with arguments', async () => {
        lastRequest = null;
        mockResponse = { result: '42', type: 'number' };

        await client.callTool({
            name: 'debug_inspect',
            arguments: { action: 'evaluate', expression: 'x + 1' },
        });

        expect(lastRequest!.tool).toBe('debug_inspect');
        expect(lastRequest!.arguments).toEqual({ action: 'evaluate', expression: 'x + 1' });
    });

    it('callTool returns string responses directly', async () => {
        lastRequest = null;
        mockResponse = 'plain string response';

        const result = await client.callTool({
            name: 'debug_breakpoints',
            arguments: { action: 'list' },
        });

        const content = result.content as Array<{ type: string; text: string }>;
        expect(content[0].text).toBe('plain string response');
    });
});
