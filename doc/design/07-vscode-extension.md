# CLI and npm Package

> **Note:** This file previously documented the VS Code extension, which was removed in v2.0.0 in favor of a standalone npm package.

## Package Manifest (`package.json`)

Key fields:

```jsonc
{
  "name": "@de-otio/epimethian-mcp",
  "bin": {
    "epimethian-mcp": "./dist/cli/index.js"
  },
  "files": ["dist"],
  "publishConfig": {
    "access": "public"
  }
}
```

The `bin` field exposes the `epimethian-mcp` command globally after `npm install -g`.

## CLI Entry Point (`src/cli/index.ts`)

The entry point routes based on `process.argv[2]`:

```typescript
#!/usr/bin/env node
import { main as startServer } from '../server/index.js';

const command = process.argv[2];
if (command === 'setup') {
  const { runSetup } = await import('./setup.js');
  await runSetup();
} else {
  await startServer();
}
```

- **Default (no args):** Start the MCP server via stdio transport. This is how MCP clients launch it.
- **`setup`:** Run the interactive credential setup command.

## Setup Command (`src/cli/setup.ts`)

Interactive credential configuration:

1. Prompts for Confluence URL (validates `https://`, strips trailing slash)
2. Prompts for email
3. Prompts for API token with **masked input** (`process.stdin.setRawMode(true)`, echoes `*`)
4. Tests the connection via `testConnection()` (GET `/wiki/api/v2/spaces?limit=1`)
5. On success: saves to OS keychain via `saveToKeychain()`
6. Prints confirmation with list of available tools

If existing credentials are found in the keychain, they are offered as defaults.

Requires an interactive terminal (`process.stdin.isTTY`). For headless environments, credentials are set via environment variables.

## Agent Installation Guide (`install-agent.md`)

A markdown file at the repository root, written for AI agents, not humans. When a user says "Install Epimethian MCP", the agent fetches this file and follows it:

1. Install: `npm install -g @de-otio/epimethian-mcp`
2. Resolve path: `which epimethian-mcp`
3. Collect profile name from user
4. Write `.mcp.json` with command + `CONFLUENCE_PROFILE` env var
5. Direct user to run `epimethian-mcp setup --profile <name>` for credential storage
6. Validate

The agent must NOT handle the API token directly -- it would appear in conversation logs.

## Credential Resolution

> **Updated in v3.0.0.** See `doc/design/10-multi-tenant.md` for the full design.

At server startup, credentials are resolved in order:

1. **Named profile:** `CONFLUENCE_PROFILE` env var → read all credentials from OS keychain
2. **All three env vars:** `CONFLUENCE_URL` + `CONFLUENCE_EMAIL` + `CONFLUENCE_API_TOKEN` (CI/CD only)
3. **Partial env vars or nothing:** hard error

Credential merging across sources is never performed. The env var path is for CI/Docker where a secret manager injects all three credentials. For interactive use, named profiles are the primary store.

## Bundling

esbuild produces a single bundle:

| Bundle | Entry | Output | Target |
|--------|-------|--------|--------|
| CLI + Server | `src/cli/index.ts` | `dist/cli/index.js` | `node18` |

The output includes a `#!/usr/bin/env node` shebang via esbuild's `banner` option.

```javascript
// esbuild.config.mjs
import { build } from 'esbuild';

const shared = { bundle: true, platform: 'node', format: 'cjs', sourcemap: true, target: 'node18' };

await build({
  ...shared,
  entryPoints: ['src/cli/index.ts'],
  outfile: 'dist/cli/index.js',
  banner: { js: '#!/usr/bin/env node' },
});
```

## Security Considerations

- The API token is stored in the OS keychain (macOS Keychain / Linux libsecret). It is never written to `.mcp.json`, `.env`, or any config file on disk.
- The `setup` command uses masked input so the token doesn't appear in terminal scrollback.
- URL and email (non-secrets) can be stored in `.mcp.json` as environment variables.
- The server reads the token from the keychain at startup, keeping it in process memory only.
- For CI environments, `CONFLUENCE_API_TOKEN` can be set via a secret manager -- it exists only in the process environment, not on disk.
