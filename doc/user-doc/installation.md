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

Run the interactive setup command:

```bash
epimethian-mcp setup
```

This will prompt for:
1. Your Confluence URL (e.g., `https://yourcompany.atlassian.net`)
2. Your email address
3. Your API token (masked input)

It tests the connection and stores the API token securely in your OS keychain.

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
        "CONFLUENCE_URL": "https://yourcompany.atlassian.net",
        "CONFLUENCE_EMAIL": "you@company.com"
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

**Important:** The API token is NOT in the config file. The server reads it from the OS keychain at startup.

### Client-Specific Config Locations

| Client | Config File |
|--------|------------|
| Claude Code (project) | `.mcp.json` in project root |
| Claude Code (global) | `~/.claude/mcp.json` |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor | `~/.cursor/mcp.json` |

## Environment Variables

For CI/headless environments where OS keychain is not available:

| Variable | Required | Description |
|----------|----------|-------------|
| `CONFLUENCE_URL` | Yes | Your Atlassian instance URL |
| `CONFLUENCE_EMAIL` | Yes | Your Atlassian account email |
| `CONFLUENCE_API_TOKEN` | For CI only | Your API token (use OS keychain for interactive use) |

## Verifying the Setup

After configuring, restart your AI client and ask:

> "List my Confluence spaces"

If configured correctly, your AI assistant will use the `get_spaces` tool and return your Confluence spaces.

## Troubleshooting

**Server fails to start**
- Run `epimethian-mcp setup` to verify credentials are stored correctly.
- Ensure `CONFLUENCE_URL` and `CONFLUENCE_EMAIL` are set in your MCP config.

**Authentication errors (401)**
- Run `epimethian-mcp setup` to re-enter your API token.
- Verify your token has not been revoked at id.atlassian.com.

**Forbidden errors (403)**
- Your account may not have permission to access the requested space or page.

**Pages or spaces not found (404)**
- Double-check the space key, page ID, or page title.
- Use the `get_spaces` tool to discover valid space keys.
