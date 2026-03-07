# Installing and Configuring the Epimethian MCP Server

The Epimethian MCP server runs locally on your machine and connects your AI coding assistant (Claude Code, Cursor, etc.) to Confluence Cloud. All changes you make through the AI are attributed to your Confluence user.

## Prerequisites

- Node.js 18 or later
- A Confluence Cloud account
- Git (to clone the repository)

## Step 1: Get the Code

Clone or download the repository to your machine:

```bash
git clone <repository-url>
cd epimethian-mcp
```

## Step 2: Generate an Atlassian API Token

1. Go to [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click **Create API token**
3. Give it a label (e.g., "MCP Server") and click **Create**
4. Copy the token — it is only shown once

No admin access is required. Any Confluence user can generate their own token.

## Step 3: Build the Server

```bash
npm install
npm run build
```

This compiles the TypeScript source to `dist/index.js`.

## Step 4: Configure Your AI Client

Choose the section for your AI client below.

### Claude Code

Add an `.mcp.json` file in your project root (for project-scoped access) or in `~/.claude/` (for global access):

```json
{
  "mcpServers": {
    "confluence": {
      "command": "node",
      "args": ["dist/index.js"],
      "env": {
        "CONFLUENCE_URL": "https://yourcompany.atlassian.net",
        "CONFLUENCE_EMAIL": "you@company.com",
        "CONFLUENCE_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

Replace the placeholder values with your actual Atlassian instance URL, email address, and API token.

> **Note:** When using a project-scoped `.mcp.json`, the `args` path is relative to where Claude Code launches the server. For a global config in `~/.claude/`, use an absolute path:
> ```json
> "args": ["/path/to/epimethian-mcp/dist/index.js"]
> ```

### Cursor

Add the server to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "confluence": {
      "command": "node",
      "args": ["/path/to/epimethian-mcp/dist/index.js"],
      "env": {
        "CONFLUENCE_URL": "https://yourcompany.atlassian.net",
        "CONFLUENCE_EMAIL": "you@company.com",
        "CONFLUENCE_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

Replace `/path/to/epimethian-mcp` with the absolute path to the directory where you cloned the repository.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CONFLUENCE_URL` | Yes | Your Atlassian instance URL (e.g., `https://yourcompany.atlassian.net`) |
| `CONFLUENCE_EMAIL` | Yes | Your Atlassian account email address |
| `CONFLUENCE_API_TOKEN` | Yes | Your personal API token generated in Step 2 |

If any of these variables are missing at startup, the server will print an error to stderr and exit.

## Verifying the Setup

After configuring your AI client, restart it and ask it to list your Confluence spaces:

> "List my Confluence spaces"

If the server is configured correctly, your AI assistant will use the `get_spaces` tool and return a list of spaces from your Confluence instance.

## Troubleshooting

**Server fails to start**
- Ensure `npm run build` completed without errors and `dist/index.js` exists.
- Check that all three environment variables are set correctly in your MCP config.

**Authentication errors (401)**
- Verify your API token is correct and has not been revoked.
- Confirm `CONFLUENCE_EMAIL` matches the email address of your Atlassian account.

**Forbidden errors (403)**
- Your account may not have permission to access the requested space or page in Confluence.

**Pages or spaces not found (404)**
- Double-check the space key, page ID, or page title you are referencing.
- Use the `get_spaces` tool to discover valid space keys.
