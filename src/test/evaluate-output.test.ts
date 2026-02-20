import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { DebugServer } from '../debug-server';
import { TEST_PORT, callTool } from './test-helpers';

suite('Evaluate Output Capture', function () {
    this.timeout(30000);

    let server: DebugServer;
    let appPath: string;

    suiteSetup(async () => {
        server = new DebugServer(TEST_PORT);
        await server.start();

        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        assert.ok(wsFolder, 'workspace folder must exist');
        appPath = path.join(wsFolder.uri.fsPath, 'console-app.js');
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

    // These tests MUST run in order — each depends on the debug state from the prior test.

    test('launch and stop at breakpoint', async () => {
        // Set breakpoint at line 3 (console.log('hello from stdout'))
        await callTool('debug_breakpoints', { action: 'set', file: appPath, line: 3 });

        const result = await callTool('debug_execute', {
            action: 'launch',
            configurationName: 'Launch Console App',
        });

        assert.ok(result.message.includes('stopped'), `expected stopped message, got: ${result.message}`);
        assert.strictEqual(result.line, 3);
    });

    test('evaluate expression with no output has no output fields', async () => {
        const result = await callTool('debug_inspect', {
            action: 'evaluate',
            expression: 'x',
        });

        assert.strictEqual(result.result, '10');
        assert.strictEqual(result.type, 'number');
        assert.strictEqual(result.output, undefined, 'should not have output field');
        assert.strictEqual(result.stderr, undefined, 'should not have stderr field');
    });

    test('evaluate console.log captures stdout', async () => {
        const result = await callTool('debug_inspect', {
            action: 'evaluate',
            expression: "console.log('captured')",
        });

        assert.ok(result.output, 'should have output field');
        assert.ok(result.output.includes('captured'), `output should contain "captured", got: ${result.output}`);
    });

    test('evaluate console.error captures stderr', async () => {
        const result = await callTool('debug_inspect', {
            action: 'evaluate',
            expression: "console.error('err-msg')",
        });

        assert.ok(result.stderr, 'should have stderr field');
        assert.ok(result.stderr.includes('err-msg'), `stderr should contain "err-msg", got: ${result.stderr}`);
    });

    test('stop debug session', async () => {
        const result = await callTool('debug_execute', { action: 'stop' });
        assert.ok(
            result.message === 'Debug session stopped' || result.message === 'No active debug session',
            `unexpected message: ${result.message}`
        );
    });
});
