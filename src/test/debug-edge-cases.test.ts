import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { DebugServer } from '../debug-server';
import { TEST_PORT, callTool } from './test-helpers';

suite('Edge Cases and Optional Parameters', function () {
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
        if (vscode.debug.activeDebugSession) {
            await vscode.debug.stopDebugging();
        }
        vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
        await server.stop();
    });

    // --- Launch edge cases ---

    suite('noDebug launch', function () {
        teardown(async () => {
            await new Promise(resolve => setTimeout(resolve, 500));
            if (vscode.debug.activeDebugSession) {
                await vscode.debug.stopDebugging();
            }
            vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
        });

        test('noDebug launch runs without stopping at breakpoints', async () => {
            // Set a breakpoint — it should NOT be hit with noDebug
            await callTool('debug_breakpoints', { action: 'set', file: appPath, line: 7 });

            const result = await callTool('debug_execute', {
                action: 'launch',
                configurationName: 'Launch Program',
                noDebug: true,
            });

            // With noDebug, the program runs to completion without stopping
            assert.ok(
                result.message.includes('terminated') || result.message.includes('running'),
                `expected terminated or running, got: ${result.message}`
            );
        });
    });

    suite('already active session', function () {
        teardown(async () => {
            if (vscode.debug.activeDebugSession) {
                await vscode.debug.stopDebugging();
            }
            vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
        });

        test('launch when session already active returns message', async () => {
            await callTool('debug_breakpoints', { action: 'set', file: appPath, line: 7 });

            const first = await callTool('debug_execute', {
                action: 'launch',
                configurationName: 'Launch Program',
            });
            assert.ok(first.message.includes('stopped'), 'first launch should stop at breakpoint');

            // Try to launch again while session is active
            const second = await callTool('debug_execute', {
                action: 'launch',
                configurationName: 'Launch Program',
            });
            assert.strictEqual(second.message, 'Debug session already active');
        });
    });

    suite('single config auto-select', function () {
        teardown(async () => {
            if (vscode.debug.activeDebugSession) {
                await vscode.debug.stopDebugging();
            }
            vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
        });

        test('single config auto-selects without configurationName', async function () {
            const wsFolder = vscode.workspace.workspaceFolders?.[0];
            if (!wsFolder) {
                this.skip();
                return;
            }

            const launchConfig = vscode.workspace.getConfiguration('launch', wsFolder.uri);
            const original = launchConfig.get('configurations');

            // Temporarily replace with a single configuration
            await launchConfig.update('configurations', [
                {
                    type: 'node',
                    request: 'launch',
                    name: 'Launch Program',
                    program: '${workspaceFolder}/app.js',
                },
            ], vscode.ConfigurationTarget.WorkspaceFolder);

            try {
                await callTool('debug_breakpoints', { action: 'set', file: appPath, line: 7 });

                // Launch without configurationName — should auto-select the only config
                const result = await callTool('debug_execute', { action: 'launch' });

                assert.ok(result.message.includes('stopped'),
                    `expected stopped message, got: ${result.message}`);
                assert.ok(result.file.endsWith('app.js'));
                assert.strictEqual(result.line, 7);
            } finally {
                if (vscode.debug.activeDebugSession) {
                    await vscode.debug.stopDebugging();
                }
                await launchConfig.update('configurations', original, vscode.ConfigurationTarget.WorkspaceFolder);
            }
        });
    });

    // --- Optional parameters (sequential, needs active debug session) ---
    // Break at line 9: const result = helper(x, y)
    // At this point x=10, y=20.

    suite('optional parameters with active session', function () {
        suiteSetup(async () => {
            await callTool('debug_breakpoints', { action: 'set', file: appPath, line: 9 });

            const result = await callTool('debug_execute', {
                action: 'launch',
                configurationName: 'Launch Program',
            });
            assert.strictEqual(result.line, 9, `expected to stop at line 9, got line ${result.line}`);
        });

        suiteTeardown(async () => {
            if (vscode.debug.activeDebugSession) {
                await vscode.debug.stopDebugging();
            }
            vscode.debug.removeBreakpoints(vscode.debug.breakpoints);
        });

        // Non-destructive tests first (don't change execution state)

        test('evaluate with explicit context parameter', async () => {
            const result = await callTool('debug_inspect', {
                action: 'evaluate',
                expression: 'x',
                context: 'watch',
            });

            assert.strictEqual(result.result, '10');
            assert.strictEqual(result.type, 'number');
        });

        test('evaluate without expression throws', async () => {
            await assert.rejects(
                callTool('debug_inspect', { action: 'evaluate' }),
                /expression is required/
            );
        });

        test('stackTrace with levels parameter', async () => {
            const result = await callTool('debug_inspect', {
                action: 'stackTrace',
                levels: 1,
            });

            assert.strictEqual(result.frames.length, 1, 'should return exactly 1 frame');
            assert.ok(result.frames[0].name.includes('main'));
        });

        test('stackTrace with startFrame parameter', async () => {
            // Get full stack for comparison
            const full = await callTool('debug_inspect', { action: 'stackTrace' });
            assert.ok(full.frames.length >= 2, 'need at least 2 frames');

            // Skip the top frame
            const result = await callTool('debug_inspect', {
                action: 'stackTrace',
                startFrame: 1,
            });

            assert.ok(result.frames.length >= 1);
            // First frame in partial result should match second frame of full result
            assert.strictEqual(result.frames[0].name, full.frames[1].name);
        });

        test('stackTrace with explicit threadId', async () => {
            // Get threadId first, then use it explicitly
            const first = await callTool('debug_inspect', { action: 'stackTrace' });
            const threadId = first.threadId;
            assert.ok(typeof threadId === 'number');

            const result = await callTool('debug_inspect', {
                action: 'stackTrace',
                threadId: threadId,
            });

            assert.ok(result.frames.length >= 1);
            assert.strictEqual(result.threadId, threadId);
        });

        test('evaluate with explicit frameId', async () => {
            const stack = await callTool('debug_inspect', { action: 'stackTrace' });
            const frameId = stack.frames[0].id;

            const result = await callTool('debug_inspect', {
                action: 'evaluate',
                expression: 'x + y',
                frameId: frameId,
            });

            assert.strictEqual(result.result, '30');
        });

        // Destructive tests (change execution state, must be last)

        test('stepOver with granularity parameter', async () => {
            // Line 9 → line 10 (stepOver calls helper and advances)
            const result = await callTool('debug_execute', {
                action: 'stepOver',
                granularity: 'line',
            });

            assert.ok(result.file.endsWith('app.js'));
            assert.strictEqual(result.line, 10);
        });

        test('continue with explicit threadId', async () => {
            const stack = await callTool('debug_inspect', { action: 'stackTrace' });
            const threadId = stack.threadId;

            // No more breakpoints ahead — program should terminate
            const result = await callTool('debug_execute', {
                action: 'continue',
                threadId: threadId,
            });

            assert.ok(result.message.includes('terminated'),
                `expected terminated, got: ${result.message}`);
        });
    });
});
