import * as assert from 'assert';
import * as vscode from 'vscode';
import { DebugServer } from '../debug-server';
import { TEST_PORT, callTool } from './test-helpers';

suite('Launch Configuration Resolution', function () {
    this.timeout(15000);

    let server: DebugServer;

    suiteSetup(async () => {
        server = new DebugServer(TEST_PORT);
        await server.start();
    });

    suiteTeardown(async () => {
        await server.stop();
    });

    test('multiple configs without configurationName returns list', async () => {
        const result = await callTool('debug_execute', { action: 'launch' });
        assert.strictEqual(
            result.message,
            'Multiple debug configurations available. Specify configurationName.'
        );
        assert.ok(Array.isArray(result.configurations));
        assert.strictEqual(result.configurations.length, 4);
        assert.ok(result.configurations.includes('Launch Program'));
        assert.ok(result.configurations.includes('Launch Tests'));
        assert.ok(result.configurations.includes('Launch Multi-File'));
        assert.ok(result.configurations.includes('Launch Exception App'));
    });

    test('configurationName not found throws with available names', async () => {
        await assert.rejects(
            callTool('debug_execute', { action: 'launch', configurationName: 'NonExistent' }),
            /Configuration "NonExistent" not found\. Available: Launch Program, Launch Tests/
        );
    });

    test('no configurations throws', async function () {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            this.skip();
            return;
        }

        const launchConfig = vscode.workspace.getConfiguration('launch', workspaceFolder.uri);
        const original = launchConfig.get('configurations');

        await launchConfig.update('configurations', [], vscode.ConfigurationTarget.WorkspaceFolder);
        try {
            await assert.rejects(
                callTool('debug_execute', { action: 'launch' }),
                /No debug configurations found/
            );
        } finally {
            await launchConfig.update('configurations', original, vscode.ConfigurationTarget.WorkspaceFolder);
        }
    });

    test('listConfigurations returns available configurations', async () => {
        const result = await callTool('debug_execute', { action: 'listConfigurations' });
        assert.ok(Array.isArray(result.configurations));
        assert.strictEqual(result.configurations.length, 4);
        assert.deepStrictEqual(result.configurations[0], { name: 'Launch Program', type: 'node', request: 'launch' });
        assert.deepStrictEqual(result.configurations[1], { name: 'Launch Tests', type: 'node', request: 'launch' });
        assert.deepStrictEqual(result.configurations[2], { name: 'Launch Multi-File', type: 'node', request: 'launch' });
        assert.deepStrictEqual(result.configurations[3], { name: 'Launch Exception App', type: 'node', request: 'launch' });
    });

    test('unknown execute action throws', async () => {
        await assert.rejects(
            callTool('debug_execute', { action: 'bogus' }),
            /Unknown execute action/
        );
    });

    test('unknown breakpoints action throws', async () => {
        await assert.rejects(
            callTool('debug_breakpoints', { action: 'bogus' }),
            /Unknown breakpoints action/
        );
    });

    test('unknown inspect action throws', async () => {
        // handleInspect checks for active session before action,
        // so this throws "No active debug session" without a session.
        // The unknown action error is only reachable during an active session.
        await assert.rejects(
            callTool('debug_inspect', { action: 'bogus' }),
            /No active debug session/
        );
    });

    test('unknown tool name throws', async () => {
        await assert.rejects(
            callTool('nonexistent_tool', { action: 'test' }),
            /Unknown tool/
        );
    });
});
