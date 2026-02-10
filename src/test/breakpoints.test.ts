import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { DebugServer } from '../debug-server';
import { TEST_PORT, callTool } from './test-helpers';

const fixtureA = path.resolve(__dirname, '../../src/test/fixtures/sample-a.js');
const fixtureB = path.resolve(__dirname, '../../src/test/fixtures/sample-b.js');

suite('Breakpoint Management', function () {
    this.timeout(15000);

    let server: DebugServer;

    suiteSetup(async () => {
        server = new DebugServer(TEST_PORT);
        await server.start();
    });

    suiteTeardown(async () => {
        await server.stop();
    });

    teardown(() => {
        // Clean up all breakpoints after each test
        const bps = vscode.debug.breakpoints;
        if (bps.length > 0) {
            vscode.debug.removeBreakpoints(bps);
        }
    });

    // --- set action ---

    test('set returns confirmation with correct fields', async () => {
        const result = await callTool('debug_breakpoints', {
            action: 'set',
            file: fixtureA,
            line: 3,
        });
        assert.ok(result.message.includes('Breakpoint set'));
        assert.strictEqual(result.file, fixtureA);
        assert.strictEqual(result.line, 3);
    });

    test('set breakpoint appears in vscode.debug.breakpoints', async () => {
        await callTool('debug_breakpoints', {
            action: 'set',
            file: fixtureA,
            line: 3,
        });

        const bps = vscode.debug.breakpoints.filter(
            (bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint
        );
        assert.strictEqual(bps.length, 1);
        assert.strictEqual(bps[0].location.uri.fsPath, fixtureA);
        assert.strictEqual(bps[0].location.range.start.line, 2); // 0-indexed
        assert.strictEqual(bps[0].enabled, true);
    });

    test('set with condition', async () => {
        const result = await callTool('debug_breakpoints', {
            action: 'set',
            file: fixtureA,
            line: 3,
            condition: 'x > 5',
        });
        assert.strictEqual(result.condition, 'x > 5');

        const bps = vscode.debug.breakpoints.filter(
            (bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint
        );
        assert.strictEqual(bps[0].condition, 'x > 5');
    });

    test('set with hitCondition', async () => {
        const result = await callTool('debug_breakpoints', {
            action: 'set',
            file: fixtureA,
            line: 3,
            hitCondition: '3',
        });
        assert.strictEqual(result.hitCondition, '3');

        const bps = vscode.debug.breakpoints.filter(
            (bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint
        );
        assert.strictEqual(bps[0].hitCondition, '3');
    });

    test('set with logMessage', async () => {
        const result = await callTool('debug_breakpoints', {
            action: 'set',
            file: fixtureA,
            line: 3,
            logMessage: 'hit line 3',
        });
        assert.strictEqual(result.logMessage, 'hit line 3');

        const bps = vscode.debug.breakpoints.filter(
            (bp): bp is vscode.SourceBreakpoint => bp instanceof vscode.SourceBreakpoint
        );
        assert.strictEqual(bps[0].logMessage, 'hit line 3');
    });

    test('set requires file parameter', async () => {
        await assert.rejects(
            callTool('debug_breakpoints', { action: 'set', line: 3 }),
            /file is required/
        );
    });

    test('set requires line parameter', async () => {
        await assert.rejects(
            callTool('debug_breakpoints', { action: 'set', file: fixtureA }),
            /line is required/
        );
    });

    // --- list action ---

    test('list returns empty array when no breakpoints', async () => {
        const result = await callTool('debug_breakpoints', { action: 'list' });
        assert.strictEqual(result.count, 0);
        assert.deepStrictEqual(result.breakpoints, []);
    });

    test('list returns all set breakpoints', async () => {
        await callTool('debug_breakpoints', { action: 'set', file: fixtureA, line: 3 });
        await callTool('debug_breakpoints', { action: 'set', file: fixtureA, line: 8 });

        const result = await callTool('debug_breakpoints', { action: 'list' });
        assert.strictEqual(result.count, 2);
        assert.strictEqual(result.breakpoints.length, 2);

        const lines = result.breakpoints.map((bp: any) => bp.line).sort();
        assert.deepStrictEqual(lines, [3, 8]);
    });

    test('list includes correct fields', async () => {
        await callTool('debug_breakpoints', {
            action: 'set',
            file: fixtureA,
            line: 3,
            condition: 'i === 0',
        });

        const result = await callTool('debug_breakpoints', { action: 'list' });
        const bp = result.breakpoints[0];
        assert.strictEqual(bp.file, fixtureA);
        assert.strictEqual(bp.line, 3);
        assert.strictEqual(bp.enabled, true);
        assert.strictEqual(bp.condition, 'i === 0');
    });

    // --- remove action ---

    test('remove deletes the correct breakpoint', async () => {
        await callTool('debug_breakpoints', { action: 'set', file: fixtureA, line: 3 });
        await callTool('debug_breakpoints', { action: 'set', file: fixtureA, line: 8 });

        const removeResult = await callTool('debug_breakpoints', {
            action: 'remove',
            file: fixtureA,
            line: 3,
        });
        assert.strictEqual(removeResult.removed, 1);

        const listResult = await callTool('debug_breakpoints', { action: 'list' });
        assert.strictEqual(listResult.count, 1);
        assert.strictEqual(listResult.breakpoints[0].line, 8);
    });

    test('remove non-existent breakpoint returns 0', async () => {
        const result = await callTool('debug_breakpoints', {
            action: 'remove',
            file: fixtureA,
            line: 99,
        });
        assert.strictEqual(result.removed, 0);
    });

    test('remove filters by both file AND line', async () => {
        // Set breakpoints at the same line in two different files
        await callTool('debug_breakpoints', { action: 'set', file: fixtureA, line: 3 });
        await callTool('debug_breakpoints', { action: 'set', file: fixtureB, line: 3 });

        // Remove only from file A
        const removeResult = await callTool('debug_breakpoints', {
            action: 'remove',
            file: fixtureA,
            line: 3,
        });
        assert.strictEqual(removeResult.removed, 1);

        // File B's breakpoint should still exist
        const listResult = await callTool('debug_breakpoints', { action: 'list' });
        assert.strictEqual(listResult.count, 1);
        assert.strictEqual(listResult.breakpoints[0].file, fixtureB);
        assert.strictEqual(listResult.breakpoints[0].line, 3);
    });

    test('remove requires file parameter', async () => {
        await assert.rejects(
            callTool('debug_breakpoints', { action: 'remove', line: 3 }),
            /file is required/
        );
    });

    test('remove requires line parameter', async () => {
        await assert.rejects(
            callTool('debug_breakpoints', { action: 'remove', file: fixtureA }),
            /line is required/
        );
    });

    // --- error handling for execute/inspect without session ---

    suite('no active session errors', function () {
        setup(async () => {
            // Ensure no debug session is active before each test
            if (vscode.debug.activeDebugSession) {
                await vscode.debug.stopDebugging();
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        });

        test('debug_execute stop with no session returns message', async () => {
            const result = await callTool('debug_execute', { action: 'stop' });
            assert.strictEqual(result.message, 'No active debug session');
        });

        test('debug_execute continue with no session throws', async () => {
            await assert.rejects(
                callTool('debug_execute', { action: 'continue' }),
                /No active debug session/
            );
        });

        test('debug_inspect evaluate with no session throws', async () => {
            await assert.rejects(
                callTool('debug_inspect', { action: 'evaluate', expression: 'x' }),
                /No active debug session/
            );
        });

        test('debug_inspect stackTrace with no session throws', async () => {
            await assert.rejects(
                callTool('debug_inspect', { action: 'stackTrace' }),
                /No active debug session/
            );
        });
    });
});
