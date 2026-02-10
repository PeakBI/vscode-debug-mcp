import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { DebugServer } from '../debug-server';
import { TEST_PORT, callTool } from './test-helpers';

suite('End-to-End Debug Session', function () {
    this.timeout(30000);
    this.retries(2);

    let server: DebugServer;
    let appPath: string;

    suiteSetup(async () => {
        server = new DebugServer(TEST_PORT);
        await server.start();

        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(wsFolder, 'workspace folder must exist');
        appPath = path.join(wsFolder.uri.fsPath, 'app.js');
    });

    suiteTeardown(async () => {
        // Ensure clean state
        if (vscode.debug.activeDebugSession) {
            await vscode.debug.stopDebugging();
        }
        vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
        await server.stop();
    });

    // --- Sequential flow: breakpoint → step → evaluate → stack trace → stop ---
    // These tests MUST run in order. Each depends on the debug state from the prior test.

    test('launch stops at breakpoint', async () => {
        // Set breakpoints at line 7 (const x = 10) and line 11 (console.log)
        await callTool('debug_breakpoints', { action: 'set', file: appPath, line: 7 });
        await callTool('debug_breakpoints', { action: 'set', file: appPath, line: 11 });

        const result = await callTool('debug_execute', {
            action: 'launch',
            configurationName: 'Launch Program',
        });

        assert.ok(result.message.includes('stopped'), `expected stopped message, got: ${result.message}`);
        assert.ok(result.file.endsWith('app.js'), `expected app.js, got: ${result.file}`);
        assert.strictEqual(result.line, 7);
        assert.ok(Array.isArray(result.stackTrace));
        assert.ok(result.stackTrace.length > 0);
    });

    test('stepOver advances to next line', async () => {
        const result = await callTool('debug_execute', { action: 'stepOver' });

        assert.ok(result.file.endsWith('app.js'));
        assert.strictEqual(result.line, 8, 'should advance from line 7 to line 8');
    });

    test('evaluate variable after assignment', async () => {
        // After stepping over "const x = 10", x should be 10
        const result = await callTool('debug_inspect', {
            action: 'evaluate',
            expression: 'x',
        });

        assert.strictEqual(result.result, '10');
        assert.strictEqual(result.type, 'number');
    });

    test('stepOver to function call line', async () => {
        const result = await callTool('debug_execute', { action: 'stepOver' });

        assert.ok(result.file.endsWith('app.js'));
        assert.strictEqual(result.line, 9, 'should advance from line 8 to line 9');
    });

    test('stepIn enters called function', async () => {
        // Line 9: const result = helper(x, y) — stepIn should enter helper()
        const result = await callTool('debug_execute', { action: 'stepIn' });

        assert.ok(result.file.endsWith('app.js'));
        assert.strictEqual(result.line, 2, 'should be on first line of helper()');
    });

    test('evaluate expression inside called function', async () => {
        const result = await callTool('debug_inspect', {
            action: 'evaluate',
            expression: 'a + b',
        });

        assert.strictEqual(result.result, '30');
    });

    test('stackTrace shows call chain', async () => {
        const result = await callTool('debug_inspect', { action: 'stackTrace' });

        assert.ok(result.frames.length >= 2, 'should have at least 2 frames');
        // Node.js debugger prefixes scope (e.g. "global.helper")
        assert.ok(result.frames[0].name.includes('helper'), `expected helper frame, got: ${result.frames[0].name}`);
        assert.ok(result.frames[1].name.includes('main'), `expected main frame, got: ${result.frames[1].name}`);
        // Verify frame structure
        assert.ok(result.frames[0].file.endsWith('app.js'));
        assert.strictEqual(result.frames[0].line, 2);
        assert.ok(typeof result.frames[0].id === 'number');
        assert.ok(typeof result.frames[0].column === 'number');
    });

    test('stepOut returns to caller', async () => {
        const result = await callTool('debug_execute', { action: 'stepOut' });

        assert.ok(result.file.endsWith('app.js'));
        // After stepping out of helper, we return to main near the call site
        assert.ok(result.line >= 9 && result.line <= 10,
            `expected line 9-10 after stepOut, got line ${result.line}`);
    });

    test('continue runs to next breakpoint', async () => {
        const result = await callTool('debug_execute', { action: 'continue' });

        // Should stop at the breakpoint on line 11
        assert.ok(result.file.endsWith('app.js'));
        assert.strictEqual(result.line, 11, 'should stop at line 11 breakpoint');
    });

    test('evaluate computed value at second breakpoint', async () => {
        const result = await callTool('debug_inspect', {
            action: 'evaluate',
            expression: 'doubled',
        });

        assert.strictEqual(result.result, '60');
        assert.strictEqual(result.type, 'number');
    });

    test('continue past last breakpoint terminates session', async () => {
        const result = await callTool('debug_execute', { action: 'continue' });

        assert.ok(result.message.includes('terminated'),
            `expected session terminated, got: ${result.message}`);
    });

    test('stop after session ended', async () => {
        // Brief wait for the session to fully tear down after termination
        await new Promise(resolve => setTimeout(resolve, 500));

        const result = await callTool('debug_execute', { action: 'stop' });

        // Session may have already cleared or still be tearing down
        assert.ok(
            result.message === 'No active debug session' || result.message === 'Debug session stopped',
            `unexpected message: ${result.message}`
        );
    });
});
