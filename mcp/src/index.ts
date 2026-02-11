import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Determine the global storage path based on platform
function getStoragePath(): string {
    const homeDir = os.homedir();
    if (process.platform === 'darwin') {
        return path.join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'peakbi.vscode-debug-mcp');
    } else if (process.platform === 'win32') {
        return path.join(homeDir, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'peakbi.vscode-debug-mcp');
    } else {
        return path.join(homeDir, '.config', 'Code', 'User', 'globalStorage', 'peakbi.vscode-debug-mcp');
    }
}

// Look up the port for the current working directory from the workspace-keyed registry
function getPortFromConfig(): number {
    try {
        const configPath = path.join(getStoragePath(), 'port-config.json');
        if (!fs.existsSync(configPath)) {
            return 4711;
        }

        const registry: Record<string, number> = JSON.parse(fs.readFileSync(configPath, 'utf8'));

        // Match CWD against registered workspace paths (longest match wins)
        const cwd = process.cwd();
        let bestMatch = '';
        let bestPort: number | null = null;

        for (const [workspacePath, port] of Object.entries(registry)) {
            if (typeof port !== 'number') { continue; }
            if (cwd === workspacePath || cwd.startsWith(workspacePath + path.sep)) {
                if (workspacePath.length > bestMatch.length) {
                    bestMatch = workspacePath;
                    bestPort = port;
                }
            }
        }

        if (bestPort !== null) {
            return bestPort;
        }

        // No CWD match — fall back to any registered port (single-window case)
        const ports = Object.values(registry).filter((v): v is number => typeof v === 'number');
        if (ports.length > 0) {
            return ports[0];
        }
    } catch (error) {
        console.error('Error reading port config:', error);
    }

    return 4711;
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

const serverInstructions = `This server controls VS Code's debugger. Typical workflow:
1. Set breakpoints with debug_breakpoints (action: "set")
2. Launch the program with debug_execute (action: "launch")
3. When stopped at a breakpoint, inspect state with debug_inspect
4. Step through code with debug_execute (stepOver/stepIn/stepOut)
5. Stop the session with debug_execute (action: "stop")

The program must be paused (at a breakpoint or after a step) before you can inspect state or step. All file paths must be absolute.`;

const server = new Server(
    {
        name: "mcp-debug-server",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
        },
        instructions: serverInstructions,
    }
);

const executeDescription = `Control debug session execution. Actions:
- launch: Start a debug session using a launch.json configuration. Returns the stopped location if a breakpoint is hit, or a status message if the program is still running after 10s.
- continue: Resume execution until the next breakpoint. Returns the new stopped location.
- stepOver/stepIn/stepOut: Step through code. Returns the new stopped location and stack trace.
- stop: End the debug session.
Requires an active debug session for all actions except launch.`;

const breakpointsDescription = `Manage source breakpoints in VS Code. Actions:
- set: Add a breakpoint at a file:line. Returns confirmation with the location.
- remove: Remove a breakpoint at a file:line. Returns the number removed.
- list: List all current breakpoints. Returns file, line, enabled status, and any conditions.
File paths must be absolute. Breakpoints persist across debug sessions.`;

const inspectDescription = `Inspect program state while paused at a breakpoint. Actions:
- evaluate: Evaluate an expression (variable name, method call, condition) in the current stack frame. Returns the result value and type.
- stackTrace: Get the current call stack. Returns an array of frames with file, line, column, and function name.
Requires an active debug session that is paused.`;

const tools = [
    {
        name: "debug_execute",
        description: executeDescription,
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["launch", "stop", "continue", "stepOver", "stepIn", "stepOut"], description: "The execution action to perform" },
                configurationName: { type: "string", description: "Name of the launch.json configuration to use (only for launch). If omitted with multiple configs, returns the available names so you can choose." },
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
                context: { type: "string", enum: ["watch", "repl", "hover", "clipboard"], description: "Evaluation context: 'repl' (default) executes as code, 'watch' evaluates without side effects, 'hover' for quick inspection, 'clipboard' formats for copying" },
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
