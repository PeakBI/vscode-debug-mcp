import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { DebugServer } from '../debug-server';
import { TEST_PORT, callTool } from './test-helpers';

/**
 * Regression test for cross-file continue bug.
 *
 * Scenario: breakpoints set in two files (utils.js and multi-file-app.js).
 * The debugger stops at the first breakpoint in utils.js (an external module).
 * After calling "continue", the debugger should stop at the next breakpoint
 * in multi-file-app.js.
 *
 * Bug: executeAndWaitForStop uses onDidChangeActiveStackItem to detect when
 * the debugger stops. However, session.customRequest('continue') bypasses
 * VS Code's internal debug model state updates — the model may not transition
 * to "running" state, so when the next DAP stopped event arrives,
 * activeStackItem doesn't change and the event never fires. This causes
 * the continue to time out instead of detecting the second breakpoint.
 */
suite('Cross-File Continue', function () {
    this.timeout(30000);

    // These tests depend on debugger stepping which is unreliable in CI
    if (process.env.CI) {
        test('skipped in CI (requires interactive debugger)', function () { this.skip(); });
        return;
    }

    let server: DebugServer;
    let multiFileAppPath: string;
    let utilsPath: string;

    suiteSetup(async () => {
        server = new DebugServer(TEST_PORT);
        await server.start();

        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(wsFolder, 'workspace folder must exist');
        multiFileAppPath = path.join(wsFolder.uri.fsPath, 'multi-file-app.js');
        utilsPath = path.join(wsFolder.uri.fsPath, 'utils.js');
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

    test('launch stops at breakpoint in external file (utils.js)', async () => {
        // Set breakpoint in utils.js line 2: const result = x * 2
        await callTool('debug_breakpoints', { action: 'set', file: utilsPath, line: 2 });
        // Set breakpoint in multi-file-app.js line 6: const final = output + 1
        await callTool('debug_breakpoints', { action: 'set', file: multiFileAppPath, line: 6 });

        const result = await callTool('debug_execute', {
            action: 'launch',
            configurationName: 'Launch Multi-File',
        });

        // Should stop at utils.js:2 first (processData is called before line 6)
        assert.ok(result.message.includes('stopped'), `expected stopped message, got: ${result.message}`);
        assert.ok(result.file.endsWith('utils.js'), `expected utils.js, got: ${result.file}`);
        assert.strictEqual(result.line, 2);
    });

    test('continue from external file stops at breakpoint in main file', async () => {
        // This is the bug scenario: continuing from a breakpoint in utils.js
        // should stop at the breakpoint in multi-file-app.js.
        //
        // With the bug, executeAndWaitForStop's onDidChangeActiveStackItem
        // listener never fires after customRequest('continue'), so this
        // times out and returns { stopped: false, reason: 'Timed out...' }
        // instead of the expected stopped state.
        const result = await callTool('debug_execute', { action: 'continue' });

        assert.ok(result.file, `expected a stopped location, got: ${JSON.stringify(result)}`);
        assert.ok(result.file.endsWith('multi-file-app.js'),
            `expected multi-file-app.js, got: ${result.file}`);
        assert.strictEqual(result.line, 6, 'should stop at line 6 breakpoint');
    });

    test('evaluate variable at second breakpoint', async () => {
        // After processData(42) returns 84, output = 84
        const result = await callTool('debug_inspect', {
            action: 'evaluate',
            expression: 'output',
        });

        assert.strictEqual(result.result, '84');
        assert.strictEqual(result.type, 'number');
    });

    test('continue past last breakpoint terminates session', async () => {
        const result = await callTool('debug_execute', { action: 'continue' });

        assert.ok(result.message.includes('terminated'),
            `expected session terminated, got: ${result.message}`);
    });
});
