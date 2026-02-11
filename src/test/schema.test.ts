import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { tools } from '../debug-server';

suite('Package.json Commands', () => {
    let packageJson: any;

    suiteSetup(() => {
        const pkgPath = path.resolve(__dirname, '../../package.json');
        packageJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    });

    test('copyClaudeCodeCommand is registered', () => {
        const commands = packageJson.contributes.commands.map((c: any) => c.command);
        assert.ok(
            commands.includes('vscode-debug-mcp.copyClaudeCodeCommand'),
            'package.json should register copyClaudeCodeCommand'
        );
    });

    test('claudeCodeCommand has inline menu entry', () => {
        const menuItems = packageJson.contributes.menus['view/item/context'];
        const entry = menuItems.find(
            (m: any) => m.command === 'vscode-debug-mcp.copyClaudeCodeCommand'
        );
        assert.ok(entry, 'should have a menu entry for copyClaudeCodeCommand');
        assert.strictEqual(entry.when, 'view == mcpDebugView && viewItem == claudeCodeCommand');
        assert.strictEqual(entry.group, 'inline');
    });
});

suite('Schema Consistency', () => {

    test('tools array has exactly 3 tools', () => {
        assert.strictEqual(tools.length, 3);
    });

    test('tool names are correct', () => {
        const names = tools.map(t => t.name);
        assert.deepStrictEqual(names, ['debug_execute', 'debug_breakpoints', 'debug_inspect']);
    });

    test('all tools require action parameter', () => {
        for (const tool of tools) {
            assert.ok(
                tool.inputSchema.required.includes('action'),
                `${tool.name} should require 'action'`
            );
        }
    });

    test('debug_execute has correct action enum', () => {
        const tool = tools.find(t => t.name === 'debug_execute')!;
        const actionEnum = (tool.inputSchema.properties.action as any).enum;
        assert.deepStrictEqual(
            actionEnum,
            ['launch', 'stop', 'continue', 'stepOver', 'stepIn', 'stepOut', 'listConfigurations']
        );
    });

    test('debug_execute has correct properties', () => {
        const tool = tools.find(t => t.name === 'debug_execute')!;
        const props = Object.keys(tool.inputSchema.properties);
        assert.deepStrictEqual(
            props.sort(),
            ['action', 'configurationName', 'granularity', 'noDebug', 'threadId'].sort()
        );
    });

    test('debug_breakpoints has correct action enum', () => {
        const tool = tools.find(t => t.name === 'debug_breakpoints')!;
        const actionEnum = (tool.inputSchema.properties.action as any).enum;
        assert.deepStrictEqual(actionEnum, ['set', 'remove', 'list']);
    });

    test('debug_breakpoints has correct properties', () => {
        const tool = tools.find(t => t.name === 'debug_breakpoints')!;
        const props = Object.keys(tool.inputSchema.properties);
        assert.deepStrictEqual(
            props.sort(),
            ['action', 'condition', 'file', 'hitCondition', 'line', 'logMessage'].sort()
        );
    });

    test('debug_inspect has correct action enum', () => {
        const tool = tools.find(t => t.name === 'debug_inspect')!;
        const actionEnum = (tool.inputSchema.properties.action as any).enum;
        assert.deepStrictEqual(actionEnum, ['evaluate', 'stackTrace']);
    });

    test('debug_inspect has correct properties', () => {
        const tool = tools.find(t => t.name === 'debug_inspect')!;
        const props = Object.keys(tool.inputSchema.properties);
        assert.deepStrictEqual(
            props.sort(),
            ['action', 'context', 'expression', 'frameId', 'levels', 'startFrame', 'threadId'].sort()
        );
    });

    test('debug_inspect context enum is correct', () => {
        const tool = tools.find(t => t.name === 'debug_inspect')!;
        const contextEnum = (tool.inputSchema.properties.context as any).enum;
        assert.deepStrictEqual(contextEnum, ['watch', 'repl', 'hover', 'clipboard']);
    });

    test('debug_execute granularity enum is correct', () => {
        const tool = tools.find(t => t.name === 'debug_execute')!;
        const granularityEnum = (tool.inputSchema.properties.granularity as any).enum;
        assert.deepStrictEqual(granularityEnum, ['statement', 'line', 'instruction']);
    });

    suite('stdio bridge consistency', () => {
        let mcpSource: string;

        suiteSetup(() => {
            const mcpPath = path.resolve(__dirname, '../../mcp/src/index.ts');
            mcpSource = fs.readFileSync(mcpPath, 'utf8');
        });

        test('stdio bridge defines same tool names', () => {
            for (const tool of tools) {
                assert.ok(
                    mcpSource.includes(`"${tool.name}"`),
                    `stdio bridge is missing tool "${tool.name}"`
                );
            }
        });

        test('stdio bridge defines same action enums for each tool', () => {
            for (const tool of tools) {
                const actionEnum = (tool.inputSchema.properties.action as any).enum as string[];
                for (const action of actionEnum) {
                    assert.ok(
                        mcpSource.includes(`"${action}"`),
                        `stdio bridge is missing action "${action}" for tool "${tool.name}"`
                    );
                }
            }
        });

        test('stdio bridge defines same properties for each tool', () => {
            for (const tool of tools) {
                for (const prop of Object.keys(tool.inputSchema.properties)) {
                    assert.ok(
                        mcpSource.includes(prop),
                        `stdio bridge is missing property "${prop}" for tool "${tool.name}"`
                    );
                }
            }
        });

        test('stdio bridge defines same required fields for each tool', () => {
            for (const tool of tools) {
                for (const req of tool.inputSchema.required) {
                    // Check that the required field appears near a "required" keyword in the mcp source
                    assert.ok(
                        mcpSource.includes(`"${req}"`),
                        `stdio bridge is missing required field "${req}" for tool "${tool.name}"`
                    );
                }
            }
        });

        test('stdio bridge has no extra tools', () => {
            // Count tool name occurrences — each tool name should appear exactly once
            // in the tools array definition (as a "name" property value)
            const toolNamePattern = /name:\s*"(debug_\w+)"/g;
            const mcpToolNames: string[] = [];
            let match;
            while ((match = toolNamePattern.exec(mcpSource)) !== null) {
                mcpToolNames.push(match[1]);
            }
            const extensionToolNames = tools.map(t => t.name).sort();
            assert.deepStrictEqual(
                mcpToolNames.sort(),
                extensionToolNames,
                'stdio bridge tool names should exactly match extension tool names'
            );
        });
    });
});
