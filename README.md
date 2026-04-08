# Epimethian MCP

Confluence Cloud tools for AI assistants via the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP). (not associated with or endorsed by Atlassian)

## Why use this?

The official [Atlassian MCP server](https://github.com/atlassian/atlassian-mcp-server) covers basic Confluence and Jira access. Epimethian targets gaps that matter for consultants, power users, and teams with strict security requirements:

- **OS keychain credential storage** — API tokens are stored in macOS Keychain or Linux libsecret, never in plaintext config files. Setup uses masked input so tokens don't leak into terminal scrollback.
- **Multi-tenant profile isolation** — Each Atlassian tenant gets its own named profile with fully separate credentials and keychain entries. No risk of cross-tenant writes when switching between clients.
- **Tenant-aware write safety** — Write operations echo the target tenant so the AI agent (and you) always see where changes are going before they land.
- **draw.io diagram support** — Create and embed draw.io diagrams directly in Confluence pages, something the official server doesn't expose.
- **Attribution tracking** — Managed pages carry metadata so you can trace which AI-assisted edits touched which content.

If you don't need any of the above, the official Atlassian server is a fine choice.

## How it works

Epimethian runs as a local MCP server that your AI agent (Claude Code, Cursor, etc.) talks to over stdio. On startup it reads a profile name from the environment, pulls the matching credentials from your OS keychain, validates the connection against Confluence Cloud, and then exposes a set of tools the agent can call. All Confluence API calls go directly from your machine to Atlassian — there is no intermediate service.

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
