import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Try to read port from config file, fallback to default
function getPortFromConfig(): number {
    try {
        // Determine the global storage path based on platform
        let storagePath: string;
        const homeDir = os.homedir();

        if (process.platform === 'darwin') {
            storagePath = path.join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'peakbi.vscode-debug-mcp');
        } else if (process.platform === 'win32') {
            storagePath = path.join(homeDir, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'peakbi.vscode-debug-mcp');
        } else {
            // Linux and others
            storagePath = path.join(homeDir, '.config', 'Code', 'User', 'globalStorage', 'peakbi.vscode-debug-mcp');
        }

        const configPath = path.join(storagePath, 'port-config.json');

        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (config && typeof config.port === 'number') {
                return config.port;
            }
        }
    } catch (error) {
        console.error('Error reading port config:', error);
    }

    return 4711; // Default port
}

async function makeRequest(payload: any): Promise<any> {
    const port = getPortFromConfig();

    return new Promise((resolve, reject) => {
        const data = JSON.stringify(payload);

        const req = http.request({
            hostname: 'localhost',
            port,
            path: '/tcp',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        }, res => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const response = JSON.parse(body);
                    if (!response.success) {
                        reject(new Error(response.error || 'Unknown error'));
                    } else {
                        resolve(response.data);
                    }
                } catch (err) {
                    reject(err);
                }
            });
        });

        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

const server = new Server(
    {
        name: "mcp-debug-server",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

const executeDescription = `Control program execution during debugging. Use 'launch' to start a debug session (set breakpoints FIRST). Use 'continue' to run to the next breakpoint. Use 'stepOver' to execute the current line, 'stepIn' to enter a function call, 'stepOut' to finish the current function. Use 'stop' to end the debug session. After launch/continue/step actions, returns the stopped location and stack trace.`;

const breakpointsDescription = `Manage breakpoints. Use 'set' to add a breakpoint at a file and line (absolute path required). Use 'remove' to delete a breakpoint at a specific file and line. Use 'list' to see all current breakpoints. Set breakpoints BEFORE launching the debug session or while paused.`;

const inspectDescription = `Inspect program state while paused at a breakpoint. Use 'evaluate' to evaluate an expression in the current stack frame (e.g. inspect variables, check conditions). Use 'stackTrace' to see the full call chain that led to the current location. The program must be paused.`;

const tools = [
    {
        name: "debug_execute",
        description: executeDescription,
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["launch", "stop", "continue", "stepOver", "stepIn", "stepOut"], description: "The execution action to perform" },
                configurationName: { type: "string", description: "Name of the launch configuration to use (only for launch)" },
                noDebug: { type: "boolean", description: "If true, launch without debugging (only for launch)" },
                threadId: { type: "number", description: "Thread ID to operate on (for continue/step*)" },
                granularity: { type: "string", enum: ["statement", "line", "instruction"], description: "Stepping granularity (for step* actions)" },
            },
            required: ["action"],
        },
    },
    {
        name: "debug_breakpoints",
        description: breakpointsDescription,
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["set", "remove", "list"], description: "The breakpoint action to perform" },
                file: { type: "string", description: "Absolute path to the file (required for set/remove)" },
                line: { type: "number", description: "Line number for the breakpoint (required for set/remove)" },
                condition: { type: "string", description: "Breakpoint condition expression (only for set)" },
                hitCondition: { type: "string", description: "Hit count condition (only for set)" },
                logMessage: { type: "string", description: "Log message instead of breaking (only for set)" },
            },
            required: ["action"],
        },
    },
    {
        name: "debug_inspect",
        description: inspectDescription,
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["evaluate", "stackTrace"], description: "The inspection action to perform" },
                expression: { type: "string", description: "Expression to evaluate (required for evaluate)" },
                frameId: { type: "number", description: "Stack frame ID for evaluation context (for evaluate)" },
                context: { type: "string", enum: ["watch", "repl", "hover", "clipboard"], description: "Evaluation context (for evaluate)" },
                threadId: { type: "number", description: "Thread ID (for stackTrace)" },
                startFrame: { type: "number", description: "First frame to return (for stackTrace)" },
                levels: { type: "number", description: "Maximum number of frames to return (for stackTrace)" },
            },
            required: ["action"],
        },
    },
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const response = await makeRequest({
        type: 'callTool',
        tool: request.params.name,
        arguments: request.params.arguments
    });

    return {
        content: [{
            type: "text",
            text: typeof response === 'string' ? response : JSON.stringify(response)
        }]
    };
});

function sleep(ms: number) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function main() {
    try {
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error("MCP Debug Server running");
        return true;
    } catch (error) {
        console.error("Error starting server:", error);
        return false;
    }
}

// Only try up to 10 times
const MAX_RETRIES = 10;

// Wait 500ms before each subsequent check
const TIMEOUT = 500;

// Wait 500ms before first check
const INITIAL_DELAY = 500;

(async function() {
    await sleep(INITIAL_DELAY);

    for (let i = 0; i < MAX_RETRIES; i++) {
        const success = await main();
        if (success) {
            break;
        }
        await sleep(TIMEOUT);
    }
})();
