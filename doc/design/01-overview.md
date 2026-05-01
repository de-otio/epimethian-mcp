# Overview

A standalone MCP server for Confluence Cloud, published as `@de-otio/epimethian-mcp` on npm. Users install globally, run an interactive `setup` command to store credentials securely in the OS keychain, and configure their MCP client to use the server. An agent-readable `install-agent.md` enables AI agents to install and configure the server on behalf of users.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Packaging | npm package with `bin` | Global install via `npm install -g`; agent-installable |
| Language | TypeScript | Shared language for CLI and MCP server |
| MCP Framework | `@modelcontextprotocol/sdk` | Official MCP SDK |
| Transport | stdio | Standard for local MCP servers; MCP clients launch as subprocess |
| Confluence API | REST API v2 + v1 search | v2 for CRUD, v1 CQL search endpoint |
| Auth (Confluence) | API token (Basic Auth) | Per-user tokens; changes attributed to the correct user |
| Secret storage | OS keychain | macOS Keychain, Linux libsecret; never stored in plaintext on disk |
| Bundler | esbuild | Fast bundling into a single file with shebang |
| Distribution | npm + GitHub Actions | OIDC trusted publishing with provenance attestation |

## Why a Standalone npm Package

The previous VS Code extension approach tied the server to a single IDE. The npm package model:
- **Works with any MCP client** -- Claude Code, Claude Desktop, Cursor, VS Code, etc.
- **Agent-installable** -- AI agents read `install-agent.md` and handle the entire setup
- **Secure credential storage** via OS keychain (API tokens never in config files)
- **Simple distribution** -- `npm install -g` with semver versioning
- Changes in Confluence are attributed to the individual user's API token
