# epimethian-mcp

> **Note:** For most Confluence use cases, we recommend the official [Atlassian Rovo MCP server](https://github.com/atlassian/mcp-server-atlassian) instead. It covers standard page and space operations and is maintained by Atlassian. Use this extension if you need features it doesn't provide, such as draw.io diagram support, OS keychain credential storage, or the VS Code graphical configuration panel.

A VS Code extension that provides Confluence Cloud tools to AI assistants via the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP). Build from source, install the `.vsix` locally, configure your credentials through a graphical panel, and your AI assistant can create, read, update, search, and manage Confluence pages.

## Features

- 12 Confluence tools: pages, spaces, search, attachments, draw.io diagrams
- Graphical configuration via a VS Code webview -- no JSON editing
- API token stored securely in your OS keychain (macOS Keychain, libsecret, Windows Credential Vault)
- All changes attributed to your Confluence user identity

## Tools

| Tool | Description |
|------|-------------|
| `create_page` | Create a new page |
| `get_page` | Read a page by ID |
| `get_page_by_title` | Look up a page by title |
| `update_page` | Update an existing page |
| `delete_page` | Delete a page |
| `list_pages` | List pages in a space |
| `get_page_children` | Get child pages |
| `search_pages` | Search via CQL |
| `get_spaces` | List available spaces |
| `add_attachment` | Upload a file attachment |
| `get_attachments` | List attachments on a page |
| `add_drawio_diagram` | Add a draw.io diagram (all-in-one) |

## Installation

### From CI Artifact

1. Go to the repository's **Actions** tab on GitHub
2. Click the latest successful **Build Extension** run
3. Download the **epimethian-mcp-vsix** artifact
4. Extract and install:

```bash
code --install-extension epimethian-mcp-*.vsix
```

### From Source

```bash
git clone https://github.com/rmyers/epimethian-mcp.git
cd epimethian-mcp
npm install
npm run build
npm run package
code --install-extension epimethian-mcp-*.vsix
```

## Setup

1. Click the **Epimethian MCP** icon in the Activity Bar (left sidebar) to open the configuration panel
2. Enter your Confluence URL (e.g., `https://yourcompany.atlassian.net`)
3. Enter your Atlassian email address
4. Enter your [API token](https://id.atlassian.com/manage-profile/security/api-tokens)
5. Click **Test Connection** to verify
6. Register the MCP server with your AI clients using the **AI Clients** section at the bottom of the panel

Your API token is stored in the OS keychain and never written to disk in plaintext.

## License

[MIT](LICENSE)
