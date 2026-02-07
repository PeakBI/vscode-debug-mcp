# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A VS Code extension ("VSCode Debug MCP") that exposes an MCP (Model Context Protocol) server allowing LLMs to interactively debug code using breakpoints, expression evaluation, and program launching via the VS Code debug adapter protocol.

## Build Commands

```bash
# Full compile (builds MCP stdio server via esbuild, then compiles extension via tsc)
npm run compile

# Watch mode (tsc only, does not rebuild mcp/)
npm run watch

# Lint
npm run lint

# Test (requires VS Code test infrastructure)
npm run test

# Package for distribution
vsce package
```

The MCP subproject must be installed separately: `cd mcp && npm install && cd ..`

## Architecture

There are two separate TypeScript projects with independent `tsconfig.json` and `package.json`:

### Root project — VS Code Extension
- `src/extension.ts` — Extension activation, command registration, status bar, port config management. Copies the built MCP stdio server to VS Code's global storage on activation.
- `src/debug-server.ts` — The core `DebugServer` class. Runs an HTTP server exposing:
  - **SSE transport** (`/sse`, `/messages`) — Direct MCP connection for clients like Cursor
  - **Legacy TCP endpoint** (`/tcp`) — HTTP POST-based tool invocation used by the stdio bridge
  - **Shutdown endpoint** (`/shutdown`) — Allows other VS Code windows to request graceful shutdown
- MCP tools registered on the server: `listFiles`, `getFileContent`, `debug` (with steps: setBreakpoint, removeBreakpoint, continue, evaluate, launch)

### `mcp/` — Stdio MCP Bridge Server
- `mcp/src/index.ts` — Standalone Node.js process (bundled via esbuild into `mcp/build/index.js`). Acts as a stdio-to-HTTP bridge: receives MCP requests over stdio and forwards them to the extension's HTTP server on `/tcp`.
- `mcp/build.js` — esbuild config that bundles into a single CJS file with `#!/usr/bin/env node` banner.
- Reads port from `port-config.json` in VS Code's global storage directory (platform-specific paths).

### Communication Flow
```
MCP Client (stdio) → mcp/build/index.js → HTTP POST /tcp → DebugServer → VS Code Debug API
MCP Client (SSE)   → /sse endpoint → DebugServer → VS Code Debug API
```

## Key Details

- Default port: 4711 (configurable via `mcpDebug.port` setting)
- The extension auto-starts the server on activation unless `mcpDebug.autostart` is disabled
- Both projects use `@modelcontextprotocol/sdk` but at different versions (root uses ^1.4.1, mcp/ uses 1.0.1) — the mcp/ subproject uses the older `Server` class while root uses the newer `McpServer` class
- Tool schemas are defined twice: once with Zod in `debug-server.ts` (for SSE) and once with JSON Schema in `mcp/src/index.ts` (for stdio). These must stay in sync.
- The extension uses VS Code's debug API (`vscode.debug.*`) for all debugger interactions — it's language-agnostic, working with any debugger that has a valid `launch.json`
