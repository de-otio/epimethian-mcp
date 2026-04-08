# Epimethian MCP

Confluence Cloud tools for AI assistants via the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP). (not associated with or endorsed by Atlassian)

> **Note:** For most Confluence use cases, the official [Atlassian MCP server](https://github.com/atlassian/atlassian-mcp-server) may be sufficient. Use Epimethian if you need draw.io diagram support, OS keychain credential storage, multi-tenant profile isolation, or attribution tracking on managed pages.

## Quick Start

Tell your AI agent:

> Install and configure the Epimethian MCP server. See https://github.com/de-otio/epimethian-mcp

Or install manually:

```bash
npm install -g @de-otio/epimethian-mcp
epimethian-mcp setup --profile <name>
```

The `setup` command prompts for your Confluence URL, email, and API token (masked input), tests the connection, and stores all credentials securely in your OS keychain under the named profile.

## MCP Configuration

Add to your `.mcp.json` (or equivalent MCP client config):

```json
{
  "mcpServers": {
    "confluence": {
      "command": "epimethian-mcp",
      "env": {
        "CONFLUENCE_PROFILE": "my-profile"
      }
    }
  }
}
```

All credentials (URL, email, token) are read from the OS keychain at startup. **Only the profile name goes in config files.**

For IDE-hosted agents, use the absolute path from `which epimethian-mcp` as the `command` value.

## Multi-Tenant Support

Consultants and developers working across multiple Atlassian tenants can create a profile per tenant:

```bash
epimethian-mcp setup --profile jambit
epimethian-mcp setup --profile acme-corp
```

Each project's `.mcp.json` specifies which profile to use. Profiles are fully isolated — separate keychain entries, separate Confluence instances, separate MCP server names (`confluence-jambit`, `confluence-acme-corp`).

Manage profiles:

```bash
epimethian-mcp profiles              # list all
epimethian-mcp profiles --verbose    # show URLs and emails
CONFLUENCE_PROFILE=jambit epimethian-mcp status   # test connection
```

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

- Credentials are stored per-profile in the OS keychain (macOS Keychain / Linux libsecret)
- URL, email, and API token are stored as an atomic unit — no mixing across profiles
- Tokens are never written to disk in plaintext
- The `setup` command uses masked input so tokens don't appear in terminal scrollback
- Startup validation verifies credentials and tenant identity before accepting tool calls
- Write operations include a tenant echo so the target is always visible
- For CI/headless environments, set all three env vars (`CONFLUENCE_URL`, `CONFLUENCE_EMAIL`, `CONFLUENCE_API_TOKEN`) — partial combinations are rejected

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
