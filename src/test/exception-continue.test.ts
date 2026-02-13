import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { DebugServer } from '../debug-server';
import { TEST_PORT, callTool } from './test-helpers';

/**
 * Regression test for exception-after-continue bug.
 *
 * Scenario: a breakpoint is hit, the MCP is used to continue, and then an
 * uncaught exception is thrown. Previously, session.customRequest('continue')
 * bypassed VS Code's internal debug model state updates — the model never
 * transitioned to "running", so the subsequent exception stop was not properly
 * shown in the VS Code UI and the debugger appeared stuck.
 *
 * Fix: use vscode.commands.executeCommand('workbench.action.debug.continue')
 * instead, which properly updates the model state.
 */
suite('Exception After Continue', function () {
    this.timeout(30000);

    let server: DebugServer;
    let exceptionAppPath: string;

    suiteSetup(async () => {
        server = new DebugServer(TEST_PORT);
        await server.start();

        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(wsFolder, 'workspace folder must exist');
        exceptionAppPath = path.join(wsFolder.uri.fsPath, 'exception-app.js');
    });

    suiteTeardown(async () => {
        if (vscode.debug.activeDebugSession) {
            await vscode.debug.stopDebugging();
        }
        for (let i = 0; i < 20; i++) {
            if (!vscode.debug.activeDebugSession) { break; }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
        await server.stop();
    });

    // --- Sequential tests: must run in order ---

    test('launch stops at breakpoint before exception', async () => {
        // Set breakpoint on line 7: const x = setup()
        await callTool('debug_breakpoints', { action: 'set', file: exceptionAppPath, line: 7 });

        const result = await callTool('debug_execute', {
            action: 'launch',
            configurationName: 'Launch Exception App',
        });

        assert.ok(result.message.includes('stopped'), `expected stopped message, got: ${result.message}`);
        assert.ok(result.file.endsWith('exception-app.js'), `expected exception-app.js, got: ${result.file}`);
        assert.strictEqual(result.line, 7);
        assert.strictEqual(result.reason, 'breakpoint', 'stop reason should be breakpoint');
    });

    test('enable uncaught exception breakpoints', async () => {
        const session = vscode.debug.activeDebugSession;
        assert.ok(session, 'debug session must be active');
        // Tell the debug adapter to break on uncaught exceptions
        await session.customRequest('setExceptionBreakpoints', { filters: ['uncaught'] });
    });

    test('continue stops at uncaught exception (not timeout)', async () => {
        // This is the bug scenario: after continuing from a breakpoint,
        // the program throws an uncaught exception. With the old
        // customRequest('continue') approach, VS Code's UI would not
        // properly show the exception. With the fix (using
        // vscode.commands.executeCommand), the model state is updated
        // and the exception stop is handled correctly.
        const result = await callTool('debug_execute', { action: 'continue' });

        // Should stop at the throw line (line 8), not timeout or terminate
        assert.ok(result.file, `expected stopped location with file, got: ${JSON.stringify(result)}`);
        assert.ok(result.file.endsWith('exception-app.js'),
            `expected exception-app.js, got: ${result.file}`);
        assert.strictEqual(result.line, 8, 'should stop at the throw line');
        assert.ok(Array.isArray(result.stackTrace), 'should have stack trace');
        assert.ok(result.stackTrace.length > 0, 'stack trace should not be empty');

        // Verify exception details are passed through to the LLM
        assert.strictEqual(result.reason, 'exception', 'stop reason should be exception');
        assert.ok(result.description, 'should include stop description');
        assert.ok(result.message.includes('(exception)'),
            `message should indicate exception, got: ${result.message}`);
    });

    test('can evaluate exception message while stopped', async () => {
        // Verify we can inspect state at the exception — this confirms
        // the debug session is in a proper stopped state
        const result = await callTool('debug_inspect', {
            action: 'evaluate',
            expression: 'x',
        });

        assert.strictEqual(result.result, '42');
        assert.strictEqual(result.type, 'number');
    });

    test('continue past exception terminates session', async () => {
        const result = await callTool('debug_execute', { action: 'continue' });

        assert.ok(result.message.includes('terminated'),
            `expected session terminated, got: ${result.message}`);
    });
});
