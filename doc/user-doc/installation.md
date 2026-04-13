# Installing and Configuring the Epimethian MCP Server

The Epimethian MCP server runs locally on your machine and connects your AI coding assistant (Claude Code, Claude Desktop, Cursor, etc.) to Confluence Cloud. All changes you make through the AI are attributed to your Confluence user.

## Prerequisites

- Node.js 18 or later

## Option A: Agent-Assisted Install (Recommended)

Tell your AI agent:

> Install and configure the Epimethian MCP server. See https://github.com/de-otio/epimethian-mcp

The agent will handle the installation and configuration for you.

## Option B: Manual Install

### Step 1: Install

```bash
npm install -g @de-otio/epimethian-mcp
```

### Step 2: Set Up Credentials

Run the interactive setup command with a profile name:

```bash
epimethian-mcp setup --profile <name>
```

Choose a short, descriptive profile name (e.g., `globex`, `acme-corp`). If you only work with one Confluence instance, any name works (e.g., `main`).

This will prompt for:
1. Your Confluence URL (e.g., `https://yourcompany.atlassian.net`)
2. Your email address
3. Your API token (masked input)

It tests the connection and stores all credentials securely in your OS keychain under the named profile.

To generate an API token:
1. Go to [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click **Create API token**
3. Give it a label (e.g., "Epimethian MCP") and click **Create**
4. Copy the token -- it is only shown once

No admin access is required. Any Confluence user can generate their own token.

### Step 3: Configure Your AI Client

Add to your MCP client configuration (`.mcp.json` or equivalent):

```json
{
  "mcpServers": {
    "confluence": {
      "command": "epimethian-mcp",
      "env": {
        "CONFLUENCE_PROFILE": "<profile name from Step 2>"
      }
    }
  }
}
```

For IDE-hosted agents that may not resolve PATH correctly, use the absolute path:

```bash
which epimethian-mcp
```

Then use the output as the `command` value.

**Important:** Only `CONFLUENCE_PROFILE` goes in the config file. URL, email, and API token are read from the OS keychain at startup.

### Client-Specific Config Locations

| Client | Config File |
|--------|------------|
| Claude Code (project) | `.mcp.json` in project root |
| Claude Code (global) | `~/.claude/mcp.json` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` |

## Multi-Tenant Setup

If you work with multiple Confluence instances (e.g., as a consultant), create a profile for each:

```bash
epimethian-mcp setup --profile globex
epimethian-mcp setup --profile acme-corp
```

Each project's `.mcp.json` specifies which profile to use. Profiles are fully isolated — different keychain entries, different Confluence instances.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CONFLUENCE_PROFILE` | **Recommended.** Name of the credential profile in the OS keychain. |
| `CONFLUENCE_URL` | Atlassian instance URL (CI/CD only — requires all three env vars) |
| `CONFLUENCE_EMAIL` | Atlassian account email (CI/CD only) |
| `CONFLUENCE_API_TOKEN` | API token (CI/CD only — use OS keychain for interactive use) |

For CI/headless environments where the OS keychain is not available, set all three `CONFLUENCE_*` env vars. Partial combinations are rejected.

## Verifying the Setup

After configuring, restart your AI client and ask:

> "List my Confluence spaces"

If configured correctly, your AI assistant will use the `get_spaces` tool and return your Confluence spaces.

You can also test from the terminal:

```bash
CONFLUENCE_PROFILE=<name> epimethian-mcp status
```

## Troubleshooting

**Server fails to start**
- Run `epimethian-mcp status` (with `CONFLUENCE_PROFILE` set) to verify credentials.
- Ensure `CONFLUENCE_PROFILE` is set in your `.mcp.json`.

**Authentication errors (401)**
- Run `epimethian-mcp setup --profile <name>` to re-enter your API token.
- Verify your token has not been revoked at id.atlassian.com.

**Forbidden errors (403)**
- Your account may not have permission to access the requested space or page.

**Pages or spaces not found (404)**
- Double-check the space key, page ID, or page title.
- Use the `get_spaces` tool to discover valid space keys.
