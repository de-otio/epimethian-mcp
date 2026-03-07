# Overview

A VS Code extension that packages a local MCP server for Confluence Cloud. Users build from source and install the `.vsix` locally. A built-in webview provides graphical configuration, and credentials are stored securely in the OS keychain via VS Code's SecretStorage API.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Packaging | VS Code extension (.vsix) | Graphical configuration; secure secret storage; local install |
| Language | TypeScript | Shared language for extension host and MCP server |
| MCP Framework | `@modelcontextprotocol/sdk` | Official MCP SDK, proven in POC |
| Transport | stdio | Standard for local MCP servers; VS Code launches as subprocess |
| Confluence API | REST API v2 + v1 search | v2 for CRUD, v1 CQL search endpoint |
| Auth (Confluence) | API token (Basic Auth) | Per-user tokens; changes attributed to the correct user |
| Secret storage | VS Code SecretStorage | Backed by OS keychain (Keychain on macOS, libsecret on Linux, Credential Vault on Windows) |
| Bundler | esbuild | Fast bundling of extension + server into single files |

## Why a VS Code Extension

The standalone MCP server requires users to manually edit `.mcp.json` with environment variables including a plaintext API token. Packaging as a VS Code extension improves this:
- **Graphical setup** via a webview panel (no JSON editing)
- **Secure credential storage** via OS keychain (not plaintext env vars)
- **Automatic MCP registration** -- the extension registers the server with VS Code's MCP support
- Changes in Confluence are still attributed to the individual user's API token
