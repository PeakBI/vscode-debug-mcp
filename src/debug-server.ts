import * as net from 'net';
import * as http from 'http';
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { z } from 'zod';

interface DebugServerEvents {
    on(event: 'started', listener: () => void): this;
    on(event: 'stopped', listener: () => void): this;
    emit(event: 'started'): boolean;
    emit(event: 'stopped'): boolean;
}
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

export interface DebugCommand {
    command: 'debug_execute' | 'debug_breakpoints' | 'debug_inspect';
    payload: any;
}

interface ToolRequest {
    type: 'listTools' | 'callTool';
    tool?: string;
    arguments?: any;
}

interface StoppedState {
    file: string;
    line: number;
    column: number;
    stackTrace: Array<{ id: number; name: string; file: string; line: number; column: number }>;
}

// Server-level instructions for LLMs
const serverInstructions = `This server controls VS Code's debugger. Typical workflow:
1. Set breakpoints with debug_breakpoints (action: "set")
2. Launch the program with debug_execute (action: "launch")
3. When stopped at a breakpoint, inspect state with debug_inspect
4. Step through code with debug_execute (stepOver/stepIn/stepOut)
5. Stop the session with debug_execute (action: "stop")

The program must be paused (at a breakpoint or after a step) before you can inspect state or step. All file paths must be absolute.`;

// Tool descriptions
const executeDescription = `Control debug session execution. Actions:
- listConfigurations: List available launch.json configurations. Returns configuration names. Call this before launch to verify the correct configuration name.
- launch: Start a debug session using a launch.json configuration. Returns the stopped location if a breakpoint is hit, or a status message if the program is still running after 10s.
- continue: Resume execution until the next breakpoint. Returns the new stopped location.
- stepOver/stepIn/stepOut: Step through code. Returns the new stopped location and stack trace.
- stop: End the debug session.
Requires an active debug session for all actions except launch and listConfigurations.`;

const breakpointsDescription = `Manage source breakpoints in VS Code. Actions:
- set: Add a breakpoint at a file:line. Returns confirmation with the location.
- remove: Remove a breakpoint at a file:line. Returns the number removed.
- list: List all current breakpoints. Returns file, line, enabled status, and any conditions.
File paths must be absolute. Breakpoints persist across debug sessions.`;

const inspectDescription = `Inspect program state while paused at a breakpoint. Actions:
- evaluate: Evaluate an expression (variable name, method call, condition) in the current stack frame. Returns the result value and type.
- stackTrace: Get the current call stack. Returns an array of frames with file, line, column, and function name.
Requires an active debug session that is paused.`;

// Zod schemas for the 3 tools
const executeInputSchema = {
    action: z.enum(["launch", "stop", "continue", "stepOver", "stepIn", "stepOut", "listConfigurations"]).describe("The execution action to perform"),
    configurationName: z.string().optional().describe("Name of the launch.json configuration to use (only for launch). If omitted with multiple configs, returns the available names so you can choose."),
    noDebug: z.boolean().optional().describe("If true, launch without debugging (only for launch)"),
    threadId: z.number().optional().describe("Thread ID to operate on (for continue/step*). If omitted, uses the active thread."),
    granularity: z.enum(["statement", "line", "instruction"]).optional().describe("Stepping granularity (for step* actions)"),
};

const breakpointsInputSchema = {
    action: z.enum(["set", "remove", "list"]).describe("The breakpoint action to perform"),
    file: z.string().optional().describe("Absolute path to the file (required for set/remove)"),
    line: z.number().optional().describe("Line number for the breakpoint (required for set/remove)"),
    condition: z.string().optional().describe("Breakpoint condition expression (only for set)"),
    hitCondition: z.string().optional().describe("Hit count condition (only for set)"),
    logMessage: z.string().optional().describe("Log message instead of breaking (only for set)"),
};

const inspectInputSchema = {
    action: z.enum(["evaluate", "stackTrace"]).describe("The inspection action to perform"),
    expression: z.string().optional().describe("Expression to evaluate (required for evaluate)"),
    frameId: z.number().optional().describe("Stack frame ID for evaluation context (for evaluate)"),
    context: z.enum(["watch", "repl", "hover", "clipboard"]).optional().describe("Evaluation context: 'repl' (default) executes as code, 'watch' evaluates without side effects, 'hover' for quick inspection, 'clipboard' formats for copying"),
    threadId: z.number().optional().describe("Thread ID (for stackTrace). If omitted, uses the active thread."),
    startFrame: z.number().optional().describe("First frame to return (for stackTrace)"),
    levels: z.number().optional().describe("Maximum number of frames to return (for stackTrace)"),
};

// JSON Schema versions for the /tcp endpoint (used by stdio bridge)
export const tools = [
    {
        name: "debug_execute",
        description: executeDescription,
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["launch", "stop", "continue", "stepOver", "stepIn", "stepOut", "listConfigurations"], description: "The execution action to perform" },
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

export class DebugServer extends EventEmitter implements DebugServerEvents {
    private server: net.Server | null = null;
    private port: number = 4711;
    private activeTransports: Record<string, SSEServerTransport> = {};
    private mcpServer: McpServer;
    private _isRunning: boolean = false;
    private stoppedEmitter = new vscode.EventEmitter<{ session: vscode.DebugSession; body: any }>();
    private trackerDisposable: vscode.Disposable;

    constructor(port?: number) {
        super();
        this.port = port || 4711;

        // Register a debug adapter tracker to reliably detect DAP stopped events.
        // Using onDidChangeActiveStackItem is unreliable after customRequest('continue')
        // because customRequest bypasses VS Code's internal debug model state updates —
        // the model may not transition to "running", so when the next stopped event
        // arrives, activeStackItem doesn't change and the event never fires.
        this.trackerDisposable = vscode.debug.registerDebugAdapterTrackerFactory('*', {
            createDebugAdapterTracker: (session: vscode.DebugSession) => {
                const emitter = this.stoppedEmitter;
                return {
                    onDidSendMessage(message: any) {
                        if (message.type === 'event' && message.event === 'stopped') {
                            emitter.fire({ session, body: message.body });
                        }
                    }
                };
            }
        });

        this.mcpServer = new McpServer({
            name: "Debug Server",
            version: "1.0.0",
        }, {
            instructions: serverInstructions,
        });

        // Register the 3 new MCP tools
        this.mcpServer.tool("debug_execute", executeDescription, executeInputSchema, async (args: any) => {
            const result = await this.handleExecute(args);
            return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        });

        this.mcpServer.tool("debug_breakpoints", breakpointsDescription, breakpointsInputSchema, async (args: any) => {
            const result = await this.handleBreakpoints(args);
            return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        });

        this.mcpServer.tool("debug_inspect", inspectDescription, inspectInputSchema, async (args: any) => {
            const result = await this.handleInspect(args);
            return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        });
    }

    get isRunning(): boolean {
        return this._isRunning;
    }

    setPort(port: number): void {
        this.port = port || 4711;
    }

    getPort(): number {
        return this.port;
    }

    async start(): Promise<void> {
        if (this.server) {
            throw new Error('Server is already running');
        }

        this.server = http.createServer(async (req, res) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', '*');

            if (req.method === 'OPTIONS') {
                res.writeHead(204).end();
                return;
            }

            if (req.method === 'POST' && req.url === '/shutdown') {
                res.writeHead(200).end('Server shutting down');
                this.stop().catch(err => {
                    console.error('Error shutting down:', err);
                });
                return;
            }

            // Legacy TCP-style endpoint (used by stdio bridge)
            if (req.method === 'POST' && req.url === '/tcp') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', async () => {
                    try {
                        const request = JSON.parse(body);
                        let response: any;

                        if (request.type === 'listTools') {
                            response = { tools };
                        } else if (request.type === 'callTool') {
                            response = await this.handleCommand(request);
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, data: response }));
                    } catch (error) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: false,
                            error: error instanceof Error ? error.message : 'Unknown error'
                        }));
                    }
                });
                return;
            }

            // SSE endpoint
            if (req.method === 'GET' && req.url === '/sse') {
                const transport = new SSEServerTransport('/messages', res);
                this.activeTransports[transport.sessionId] = transport;
                await this.mcpServer.connect(transport);
                res.on('close', () => {
                    delete this.activeTransports[transport.sessionId];
                });
                return;
            }

            // Message endpoint for SSE
            if (req.method === 'POST' && req.url?.startsWith('/messages')) {
                const url = new URL(req.url, 'http://localhost');
                const sessionId = url.searchParams.get('sessionId');
                if (!sessionId || !this.activeTransports[sessionId]) {
                    res.writeHead(404).end('Session not found');
                    return;
                }
                await this.activeTransports[sessionId].handlePostMessage(req, res);
                return;
            }

            res.writeHead(404).end();
        });

        const maxAttempts = 10;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const portToTry = this.port + attempt;
            try {
                await new Promise<void>((resolve, reject) => {
                    this.server!.once('error', reject);
                    this.server!.listen(portToTry, () => {
                        this.server!.removeAllListeners('error');
                        this.port = portToTry;
                        this._isRunning = true;
                        this.emit('started');
                        resolve();
                    });
                });
                return; // Successfully bound
            } catch (err: any) {
                if (err.code === 'EADDRINUSE' && attempt < maxAttempts - 1) {
                    // Port in use, try the next one
                    this.server!.removeAllListeners('error');
                    continue;
                }
                throw err;
            }
        }
    }

    // --- Shared helpers ---

    private async resolveThreadId(session: vscode.DebugSession, explicitThreadId?: number): Promise<number> {
        if (explicitThreadId !== undefined) {
            return explicitThreadId;
        }

        // Try to get thread from activeStackItem
        const activeStackItem = vscode.debug.activeStackItem;
        if (activeStackItem instanceof vscode.DebugThread) {
            return activeStackItem.threadId;
        }
        if (activeStackItem instanceof vscode.DebugStackFrame) {
            return activeStackItem.threadId;
        }

        // Fall back to DAP threads request
        const threadsResponse = await session.customRequest('threads');
        if (threadsResponse?.threads?.length > 0) {
            return threadsResponse.threads[0].id;
        }

        throw new Error('No threads available');
    }

    private async gatherStoppedState(session: vscode.DebugSession, threadId: number): Promise<StoppedState> {
        const stackResponse = await session.customRequest('stackTrace', {
            threadId,
            startFrame: 0,
            levels: 20,
        });

        const frames = stackResponse.stackFrames || [];
        if (frames.length === 0) {
            throw new Error('No stack frames available');
        }

        const topFrame = frames[0];
        return {
            file: topFrame.source?.path || topFrame.source?.name || '<unknown>',
            line: topFrame.line,
            column: topFrame.column,
            stackTrace: frames.map((f: any) => ({
                id: f.id,
                name: f.name,
                file: f.source?.path || f.source?.name || '<unknown>',
                line: f.line,
                column: f.column,
            })),
        };
    }

    private async executeAndWaitForStop(
        session: vscode.DebugSession,
        executeFn: () => Promise<void>,
        fallbackThreadId?: number
    ): Promise<{ stopped: true; state: StoppedState; stopReason?: string; description?: string; exceptionText?: string } | { stopped: false; reason: string }> {
        return new Promise(async (resolve) => {
            let resolved = false;

            const cleanup = () => {
                stoppedDisposable.dispose();
                terminateDisposable.dispose();
                clearTimeout(timer);
            };

            // Listen for DAP stopped events directly from the debug adapter.
            // This is more reliable than onDidChangeActiveStackItem because
            // it doesn't depend on VS Code's debug model state.
            const stoppedDisposable = this.stoppedEmitter.event(async ({ session: stoppedSession, body }) => {
                if (resolved) { return; }
                if (stoppedSession === session) {
                    resolved = true;
                    cleanup();
                    try {
                        const threadId = body?.threadId ?? fallbackThreadId;
                        const state = await this.gatherStoppedState(session, threadId);
                        // Pass through DAP stop metadata so callers can
                        // distinguish breakpoints from exceptions, etc.
                        const stopReason: string | undefined = body?.reason;
                        const description: string | undefined = body?.description;
                        const exceptionText: string | undefined = body?.text;
                        resolve({ stopped: true, state, stopReason, description, exceptionText });
                    } catch (err) {
                        resolve({ stopped: false, reason: `Stopped but failed to get state: ${err instanceof Error ? err.message : String(err)}` });
                    }
                }
            });

            const terminateDisposable = vscode.debug.onDidTerminateDebugSession((terminatedSession) => {
                if (resolved) { return; }
                if (terminatedSession === session) {
                    resolved = true;
                    cleanup();
                    resolve({ stopped: false, reason: 'Debug session terminated' });
                }
            });

            const timer = setTimeout(() => {
                if (resolved) { return; }
                resolved = true;
                cleanup();
                resolve({ stopped: false, reason: 'Timed out waiting for program to stop (10s)' });
            }, 10000);

            try {
                await executeFn();
            } catch (err) {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    resolve({ stopped: false, reason: `Execution failed: ${err instanceof Error ? err.message : String(err)}` });
                }
            }
        });
    }

    private async waitForLaunchResult(
        workspaceFolder: vscode.WorkspaceFolder,
        config: any
    ): Promise<any> {
        return new Promise(async (resolve) => {
            let resolved = false;

            const cleanup = () => {
                stoppedDisposable.dispose();
                terminateDisposable.dispose();
                clearTimeout(timer);
            };

            // Listen for DAP stopped events directly from the debug adapter
            const stoppedDisposable = this.stoppedEmitter.event(async ({ session, body }) => {
                if (resolved) { return; }
                resolved = true;
                cleanup();
                try {
                    const threadId = body?.threadId;
                    if (threadId === undefined) {
                        resolve({ message: 'Debug session started but no thread ID in stopped event' });
                        return;
                    }
                    const state = await this.gatherStoppedState(session, threadId);
                    const stopReason: string | undefined = body?.reason;
                    const stopDescription: string | undefined = body?.description;
                    const exceptionText: string | undefined = body?.text;
                    const reasonSuffix = stopReason ? ` (${stopReason})` : '';
                    const response: any = {
                        message: `Debug session started - stopped at ${state.file}:${state.line}${reasonSuffix}`,
                        reason: stopReason,
                        ...state,
                    };
                    if (stopDescription) {
                        response.description = stopDescription;
                    }
                    if (exceptionText) {
                        response.exceptionText = exceptionText;
                    }
                    resolve(response);
                } catch (err) {
                    resolve({ message: `Debug session started - stopped but failed to get state: ${err instanceof Error ? err.message : String(err)}` });
                }
            });

            // Listen for session termination
            const terminateDisposable = vscode.debug.onDidTerminateDebugSession(() => {
                if (resolved) { return; }
                resolved = true;
                cleanup();
                resolve({ message: 'Debug session terminated' });
            });

            // Timeout after 10 seconds — program might be running without hitting a breakpoint
            const timer = setTimeout(() => {
                if (resolved) { return; }
                resolved = true;
                cleanup();
                resolve({ message: 'Debug session started (program is running)' });
            }, 10000);

            // Start the debug session
            try {
                await vscode.debug.startDebugging(workspaceFolder, config);
            } catch (err) {
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    resolve({ message: `Failed to start debug session: ${err instanceof Error ? err.message : String(err)}` });
                }
            }
        });
    }

    // --- Tool handlers ---

    private async handleExecute(args: {
        action: string;
        configurationName?: string;
        noDebug?: boolean;
        threadId?: number;
        granularity?: string;
    }): Promise<any> {
        switch (args.action) {
            case 'launch': {
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) {
                    throw new Error('No workspace folder found');
                }

                const launchConfig = vscode.workspace.getConfiguration('launch', workspaceFolder.uri);
                const configurations = launchConfig.get<any[]>('configurations');

                if (!configurations || configurations.length === 0) {
                    throw new Error('No debug configurations found in launch.json');
                }

                let config: any;
                if (args.configurationName) {
                    config = configurations.find(c => c.name === args.configurationName);
                    if (!config) {
                        const names = configurations.map(c => c.name);
                        throw new Error(`Configuration "${args.configurationName}" not found. Available: ${names.join(', ')}`);
                    }
                    config = { ...config };
                } else if (configurations.length === 1) {
                    config = { ...configurations[0] };
                } else {
                    const names = configurations.map(c => c.name);
                    return {
                        message: 'Multiple debug configurations available. Specify configurationName.',
                        configurations: names,
                    };
                }

                // Replace ${workspaceFolder} in config values
                const replacePlaceholders = (obj: any): any => {
                    if (typeof obj === 'string') {
                        return obj.replace(/\$\{workspaceFolder\}/g, workspaceFolder.uri.fsPath);
                    }
                    if (Array.isArray(obj)) {
                        return obj.map(replacePlaceholders);
                    }
                    if (obj && typeof obj === 'object') {
                        const result: any = {};
                        for (const key of Object.keys(obj)) {
                            result[key] = replacePlaceholders(obj[key]);
                        }
                        return result;
                    }
                    return obj;
                };
                config = replacePlaceholders(config);

                if (args.noDebug) {
                    config.noDebug = true;
                }

                // Check if we're already debugging
                let session = vscode.debug.activeDebugSession;
                if (session) {
                    return { message: 'Debug session already active' };
                }

                // Wait for either a stop event (breakpoint hit) or session termination
                return await this.waitForLaunchResult(workspaceFolder, config);
            }

            case 'stop': {
                const session = vscode.debug.activeDebugSession;
                if (!session) {
                    return { message: 'No active debug session' };
                }
                await vscode.debug.stopDebugging(session);
                return { message: 'Debug session stopped' };
            }

            case 'continue':
            case 'stepOver':
            case 'stepIn':
            case 'stepOut': {
                const session = vscode.debug.activeDebugSession;
                if (!session) {
                    throw new Error('No active debug session');
                }

                const threadId = await this.resolveThreadId(session, args.threadId);

                // Use VS Code's high-level commands by default so the internal
                // debug model state is properly updated (transitions to "running"
                // then back to "stopped"). This ensures the UI correctly shows
                // exceptions, hit breakpoints, etc.
                // Fall back to DAP customRequest only when the caller needs
                // features the high-level commands don't support (explicit
                // threadId or stepping granularity).
                const useCustomRequest = args.threadId !== undefined || (args.granularity && args.action !== 'continue');

                let executeFn: () => Promise<void>;
                if (useCustomRequest) {
                    const dapCommandMap: Record<string, string> = {
                        'continue': 'continue',
                        'stepOver': 'next',
                        'stepIn': 'stepIn',
                        'stepOut': 'stepOut',
                    };
                    const dapCommand = dapCommandMap[args.action];
                    const dapArgs: any = { threadId };
                    if (args.granularity && args.action !== 'continue') {
                        dapArgs.granularity = args.granularity;
                    }
                    executeFn = () => session.customRequest(dapCommand, dapArgs);
                } else {
                    const vscodeCommandMap: Record<string, string> = {
                        'continue': 'workbench.action.debug.continue',
                        'stepOver': 'workbench.action.debug.stepOver',
                        'stepIn': 'workbench.action.debug.stepInto',
                        'stepOut': 'workbench.action.debug.stepOut',
                    };
                    const vscodeCommand = vscodeCommandMap[args.action];
                    executeFn = () => vscode.commands.executeCommand(vscodeCommand);
                }

                const result = await this.executeAndWaitForStop(session, executeFn, threadId);
                if (result.stopped) {
                    const reasonSuffix = result.stopReason ? ` (${result.stopReason})` : '';
                    const response: any = {
                        message: `${args.action} completed - stopped at ${result.state.file}:${result.state.line}${reasonSuffix}`,
                        reason: result.stopReason,
                        ...result.state,
                    };
                    if (result.description) {
                        response.description = result.description;
                    }
                    if (result.exceptionText) {
                        response.exceptionText = result.exceptionText;
                    }
                    return response;
                }
                return { message: result.reason };
            }

            case 'listConfigurations': {
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                if (!workspaceFolder) {
                    throw new Error('No workspace folder found');
                }
                const launchConfig = vscode.workspace.getConfiguration('launch', workspaceFolder.uri);
                const configurations = launchConfig.get<any[]>('configurations');
                if (!configurations || configurations.length === 0) {
                    return { message: 'No debug configurations found in launch.json', configurations: [] };
                }
                return {
                    configurations: configurations.map(c => ({ name: c.name, type: c.type, request: c.request })),
                };
            }

            default:
                throw new Error(`Unknown execute action: ${args.action}`);
        }
    }

    private async handleBreakpoints(args: {
        action: string;
        file?: string;
        line?: number;
        condition?: string;
        hitCondition?: string;
        logMessage?: string;
    }): Promise<any> {
        switch (args.action) {
            case 'set': {
                if (!args.file) {
                    throw new Error('file is required for set action');
                }
                if (!args.line) {
                    throw new Error('line is required for set action');
                }

                const document = await vscode.workspace.openTextDocument(args.file);
                const editor = await vscode.window.showTextDocument(document);

                const bp = new vscode.SourceBreakpoint(
                    new vscode.Location(
                        editor.document.uri,
                        new vscode.Position(args.line - 1, 0)
                    ),
                    true,
                    args.condition,
                    args.hitCondition,
                    args.logMessage,
                );
                vscode.debug.addBreakpoints([bp]);
                return {
                    message: `Breakpoint set at ${args.file}:${args.line}`,
                    file: args.file,
                    line: args.line,
                    condition: args.condition,
                    hitCondition: args.hitCondition,
                    logMessage: args.logMessage,
                };
            }

            case 'remove': {
                if (!args.file) {
                    throw new Error('file is required for remove action');
                }
                if (!args.line) {
                    throw new Error('line is required for remove action');
                }

                const bps = vscode.debug.breakpoints.filter(bp => {
                    if (bp instanceof vscode.SourceBreakpoint) {
                        return bp.location.uri.fsPath === args.file &&
                            bp.location.range.start.line === args.line! - 1;
                    }
                    return false;
                });

                if (bps.length === 0) {
                    return { message: `No breakpoint found at ${args.file}:${args.line}`, removed: 0 };
                }

                vscode.debug.removeBreakpoints(bps);
                return { message: `Removed ${bps.length} breakpoint(s) at ${args.file}:${args.line}`, removed: bps.length };
            }

            case 'list': {
                const breakpoints = vscode.debug.breakpoints
                    .filter((bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint)
                    .map(bp => ({
                        file: bp.location.uri.fsPath,
                        line: bp.location.range.start.line + 1,
                        enabled: bp.enabled,
                        condition: bp.condition,
                        hitCondition: bp.hitCondition,
                        logMessage: bp.logMessage,
                    }));

                return { breakpoints, count: breakpoints.length };
            }

            default:
                throw new Error(`Unknown breakpoints action: ${args.action}`);
        }
    }

    private async handleInspect(args: {
        action: string;
        expression?: string;
        frameId?: number;
        context?: string;
        threadId?: number;
        startFrame?: number;
        levels?: number;
    }): Promise<any> {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            throw new Error('No active debug session. The program must be paused.');
        }

        switch (args.action) {
            case 'evaluate': {
                if (!args.expression) {
                    throw new Error('expression is required for evaluate action');
                }

                let frameId = args.frameId;

                if (frameId === undefined) {
                    // Get the top frame from a fresh stack trace request.
                    // We don't use activeStackItem.frameId because the tracker-based
                    // stop detection resolves before VS Code updates activeStackItem,
                    // which would give us a stale frame ID from the previous stop.
                    const threadId = await this.resolveThreadId(session, args.threadId);
                    const frames = await session.customRequest('stackTrace', { threadId });
                    if (!frames?.stackFrames?.length) {
                        throw new Error('No stack frame available');
                    }
                    frameId = frames.stackFrames[0].id;
                }

                const response = await session.customRequest('evaluate', {
                    expression: args.expression,
                    frameId,
                    context: args.context || 'repl',
                });

                return {
                    result: response.result,
                    type: response.type,
                    variablesReference: response.variablesReference,
                };
            }

            case 'stackTrace': {
                const threadId = await this.resolveThreadId(session, args.threadId);
                const stackResponse = await session.customRequest('stackTrace', {
                    threadId,
                    startFrame: args.startFrame ?? 0,
                    levels: args.levels ?? 20,
                });

                const frames = (stackResponse.stackFrames || []).map((f: any) => ({
                    id: f.id,
                    name: f.name,
                    file: f.source?.path || f.source?.name || '<unknown>',
                    line: f.line,
                    column: f.column,
                }));

                return { threadId, frames, totalFrames: stackResponse.totalFrames };
            }

            default:
                throw new Error(`Unknown inspect action: ${args.action}`);
        }
    }

    // Dispatch tool calls from /tcp endpoint
    private async handleCommand(request: ToolRequest): Promise<any> {
        switch (request.tool) {
            case 'debug_execute':
                return await this.handleExecute(request.arguments);
            case 'debug_breakpoints':
                return await this.handleBreakpoints(request.arguments);
            case 'debug_inspect':
                return await this.handleInspect(request.arguments);
            default:
                throw new Error(`Unknown tool: ${request.tool}`);
        }
    }

    stop(): Promise<void> {
        return new Promise((resolve) => {
            this.trackerDisposable.dispose();
            this.stoppedEmitter.dispose();

            if (!this.server) {
                this._isRunning = false;
                this.emit('stopped');
                resolve();
                return;
            }

            Object.values(this.activeTransports).forEach(transport => {
                transport.close();
            });
            this.activeTransports = {};

            this.server.close(() => {
                this.server = null;
                this._isRunning = false;
                this.emit('stopped');
                resolve();
            });
        });
    }
}
