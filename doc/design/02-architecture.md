# Architecture

```
  ┌──────────────────────┐
  │  MCP Client           │
  │  (Claude Code,        │
  │   Claude Desktop,     │
  │   Cursor, etc.)       │
  └───────┬──────────────┘
          │ stdio (JSON-RPC)
          ▼
  ┌──────────────────────┐
  │  epimethian-mcp       │
  │  (npm global binary)  │
  │                       │
  │  - CLI entry point    │
  │  - MCP server (26     │
  │    Confluence tools)  │
  │  - Reads credentials  │
  │    from OS keychain   │
  └───────┬──────────────┘
          │ HTTPS
          │ Basic Auth
          ▼
  ┌──────────────────────┐
  │  Confluence           │
  │  Cloud API            │
  │  (v2 + v1 REST)      │
  └──────────────────────┘
```

## How It Works

1. User installs globally: `npm install -g @de-otio/epimethian-mcp`
2. User runs `epimethian-mcp setup` to enter credentials interactively (masked input)
3. The setup command tests the connection and stores credentials in the OS keychain
4. User (or AI agent) configures `.mcp.json` with the server command and non-secret env vars
5. The MCP client launches `epimethian-mcp` as a child process via stdio
6. On startup, the server reads credentials from env vars (URL, email) and the OS keychain (API token)
7. The server resolves the per-profile read-only flag (strict-mode OR: registry OR env var) and freezes it into the config
8. All Confluence API calls use Basic Auth with the user's personal token

## Project Structure

```
epimethian-mcp/
├── package.json                  # npm package manifest with bin entry
├── tsconfig.json
├── esbuild.config.mjs            # Bundles CLI + server into single file
├── install-agent.md              # Agent-readable installation guide
├── src/
│   ├── cli/
│   │   ├── index.ts              # Entry point: routes to server, setup, or subcommands
│   │   ├── setup.ts              # Interactive credential setup command
│   │   ├── profiles.ts           # Profile list/remove subcommand
│   │   ├── status.ts             # Connection status subcommand
│   │   └── agent-guide.ts        # Prints install-agent.md to stdout
│   ├── server/
│   │   ├── index.ts              # MCP server setup + tool registrations
│   │   ├── confluence-client.ts  # HTTP helpers, Zod schemas, formatting, section ops
│   │   ├── page-cache.ts         # In-memory version-keyed page cache (LRU)
│   │   └── diff.ts               # Section-aware summary and unified diff for version comparison
│   └── shared/
│       ├── keychain.ts           # OS keychain abstraction (macOS, Linux)
│       ├── profiles.ts           # Profile registry (JSON file alongside keychain)
│       └── test-connection.ts    # Connection test (used by setup command)
├── doc/
│   └── design/
├── .github/
│   └── workflows/
│       ├── build.yml             # CI: build + test on push/PR
│       └── publish.yml           # Publish to npm on GitHub release
└── dist/
    └── cli/
        └── index.js              # Single bundled binary with shebang
```

Everything is bundled by esbuild into a single file (`dist/cli/index.js`) with a `#!/usr/bin/env node` shebang. The binary is exposed as `epimethian-mcp` via the `bin` field in `package.json`.
