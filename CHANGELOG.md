# Change Log

All notable changes to the "vscode-debug-mcp" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.3.0](https://github.com/PeakBI/vscode-debug-mcp/compare/v0.2.0...v0.3.0) (2026-02-11)


### Features

* add listConfigurations action to debug_execute ([e27b96b](https://github.com/PeakBI/vscode-debug-mcp/commit/e27b96b85c10db991c6685908b625439390efedb))
* add listConfigurations action to debug_execute ([a1ee479](https://github.com/PeakBI/vscode-debug-mcp/commit/a1ee47953910eb7728b9484b82ee5dd3b7a3fb37))


### Bug Fixes

* update bridge test expected action enum for listConfigurations ([c1e2c9d](https://github.com/PeakBI/vscode-debug-mcp/commit/c1e2c9d8dc0a0e591f7a8ac608f8955468e49266))

## [0.2.0](https://github.com/PeakBI/vscode-debug-mcp/compare/v0.1.1...v0.2.0) (2026-02-11)


### Features

* auto-switch ports for multi-window support ([69bd8aa](https://github.com/PeakBI/vscode-debug-mcp/commit/69bd8aaf99fee682f67e2a37aee3443eb34ea012))
* auto-switch ports for multi-window support ([e17b903](https://github.com/PeakBI/vscode-debug-mcp/commit/e17b90345dcd035d1608d598b5430fc0e505f06d))
* build VSIX artifact on pull requests ([f62ed7c](https://github.com/PeakBI/vscode-debug-mcp/commit/f62ed7c9c5d4ddc0ab24c919ea46c6297ae2a8b8))


### Bug Fixes

* resolve port-config.json lookup for Remote Tunnels ([37468b4](https://github.com/PeakBI/vscode-debug-mcp/commit/37468b49e9e3924df3dd1aef75fec40c559dc5bc))
* resolve port-config.json lookup for Remote Tunnels ([4fd0ac1](https://github.com/PeakBI/vscode-debug-mcp/commit/4fd0ac1ecdc0d2880bbcf56423e2bcc5b4f9ba7e))

## [0.1.1](https://github.com/PeakBI/vscode-debug-mcp/compare/v0.1.0...v0.1.1) (2026-02-10)


### Bug Fixes

* build VSIX in release-please workflow ([51349e7](https://github.com/PeakBI/vscode-debug-mcp/commit/51349e7097a754e01ff8e06c7a00090a7cc204f1))

## [0.1.0](https://github.com/PeakBI/vscode-debug-mcp/compare/v0.0.4...v0.1.0) (2026-02-10)


### Features

* add release-please for automated releases ([71c62c1](https://github.com/PeakBI/vscode-debug-mcp/commit/71c62c1b7f610cc4e5efa65a8f3a8814da6545ad))
* add release-please for automated releases ([061c644](https://github.com/PeakBI/vscode-debug-mcp/commit/061c644daa0ae78170e1332683d03bbc57da162f))


### Bug Fixes

* use plain version tags for release-please ([df67189](https://github.com/PeakBI/vscode-debug-mcp/commit/df67189e2be7faf97e7eba21aec6ee4452006f8d))

## 0.1.2

- Report exceptions to LLM
- Properly send threadId to comply with DAP, fixing issues with debugging with C++, etc.


## 0.1.1

- Fixes issue with Claude Desktop not detecting tools

## 0.1.0

- Fixes /sse use via fixing to properly use zod

## 0.0.9

- Fixes bug with tool descriptions

## 0.0.8

- Adds support to resume debugging if already running and LLM requests launch.

## 0.0.7

- Introduces the status menu
- Adds multi-window support
- Improves configuration capabilities and experience
- Simplifies first-time setup

## 0.0.6

- Adds automatic startup and stability improvements

## [0.0.4]
- Add /sse support

## [0.0.3]

- Change built mcp server to be CJS instead of ESM by @jasonjmcghee in #4
- Adds Windows compatibility by fixing a bug by @dkattan in #3, fixing #2

## [0.0.2]

- Adds ability to configure the port of the MCP Server

## [0.0.1]

- Initial release (built initial prototype in hackathon)
- Added support for conditional breakpoints
- Added support for automatically opening the file for debug
- Restructured to work well with .visx and to be language agnostic
