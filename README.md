# Epimethian MCP

Confluence Cloud tools for AI assistants via the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP). (not associated with or endorsed by Atlassian)

> **Note:** For most Confluence use cases, the official [Atlassian Rovo MCP server](https://github.com/atlassian/mcp-server-atlassian) may be sufficient. Use Epimethian if you need draw.io diagram support, OS keychain credential storage, or attribution tracking on managed pages.

## Quick Start

Tell your AI agent:

> Install and configure the Epimethian MCP server. See https://github.com/de-otio/epimethian-mcp

Or install manually:

```bash
npm install -g @de-otio/epimethian-mcp
epimethian-mcp setup
```

The `setup` command prompts for your Confluence URL, email, and API token (masked input), tests the connection, and stores credentials securely in your OS keychain.

## MCP Configuration

Add to your `.mcp.json` (or equivalent MCP client config):

```json
{
  "mcpServers": {
    "confluence": {
      "command": "epimethian-mcp",
      "env": {
        "CONFLUENCE_URL": "https://yoursite.atlassian.net",
        "CONFLUENCE_EMAIL": "user@example.com"
      }
    }
  }
}
```

The API token is read from the OS keychain at startup. **Do not put it in config files.**

For IDE-hosted agents, use the absolute path from `which epimethian-mcp` as the `command` value.

## Tools

| Tool                 | Description                |
| -------------------- | -------------------------- |
| `create_page`        | Create a new page          |
| `get_page`           | Read a page by ID          |
| `get_page_by_title`  | Look up a page by title    |
| `update_page`        | Update an existing page    |
| `delete_page`        | Delete a page              |
| `list_pages`         | List pages in a space      |
| `get_page_children`  | Get child pages            |
| `search_pages`       | Search via CQL             |
| `get_spaces`         | List available spaces      |
| `add_attachment`     | Upload a file attachment   |
| `get_attachments`    | List attachments on a page |
| `add_drawio_diagram` | Add a draw.io diagram      |

## Credential Security

- API tokens are stored in the OS keychain (macOS Keychain / Linux libsecret)
- Tokens are never written to disk in plaintext
- The `setup` command uses masked input so tokens don't appear in terminal scrollback
- For CI/headless environments, set `CONFLUENCE_API_TOKEN` as an environment variable injected by your secret manager

## Development

```bash
git clone https://github.com/de-otio/epimethian-mcp.git
cd epimethian-mcp
npm install
npm run build
npm test
```

## License

[MIT](LICENSE)
