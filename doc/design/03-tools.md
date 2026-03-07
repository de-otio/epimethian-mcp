# MCP Tools

All tools return plain text (not JSON) for LLM consumption. Tools are registered using `server.registerTool()` with annotations that hint at their behavior (e.g., `readOnlyHint`, `destructiveHint`, `idempotentHint`). All API responses are validated at runtime using Zod schemas defined in `confluence-client.ts`.

## Tool Annotations

| Tool | readOnlyHint | destructiveHint | idempotentHint |
|------|:---:|:---:|:---:|
| `get_page`, `search_pages`, `list_pages`, `get_page_children`, `get_spaces`, `get_page_by_title`, `get_attachments` | yes | — | — |
| `create_page`, `add_attachment`, `add_drawio_diagram` | — | no | no |
| `update_page` | — | no | yes |
| `delete_page` | — | yes | yes |

## Tool Summary

| Tool | Parameters | Description |
|------|-----------|-------------|
| `create_page` | title, space_key, body, parent_id? | Create a new Confluence page |
| `get_page` | page_id, include_body? | Read a page by ID |
| `update_page` | page_id, title?, body?, version_message? | Update an existing page (auto-increments version) |
| `delete_page` | page_id | Delete a page by ID |
| `search_pages` | cql, limit? | Search using CQL |
| `list_pages` | space_key, limit?, status? | List pages in a space |
| `get_page_children` | page_id, limit? | Get child pages |
| `get_spaces` | limit?, type? | List available spaces |
| `get_page_by_title` | title, space_key, include_body? | Look up a page by title within a space |
| `add_attachment` | page_id, file_path, filename?, comment? | Upload a file attachment to a page |
| `get_attachments` | page_id, limit? | List attachments on a page |
| `add_drawio_diagram` | page_id, diagram_xml, diagram_name, append? | Add a draw.io diagram to a page (all-in-one) |

## Tool Details

### create_page
Creates a new page in a Confluence space. Resolves the human-readable `space_key` (e.g., "DEV") to a numeric space ID internally. Plain text body content is auto-wrapped in `<p>` tags; HTML/storage format is passed through as-is.

### get_page
Reads a page by its numeric ID. By default includes the page body in Confluence storage format. Returns title, ID, space, version, URL, and optionally the content.

### update_page
Updates an existing page. Fetches the current page first to determine the version number, then auto-increments it. Only the fields provided (title, body) are changed; omitted fields keep their current values.

### delete_page
Deletes a page by ID. Returns confirmation text.

### search_pages
Searches using CQL (Confluence Query Language). Uses the v1 `/rest/api/content/search` endpoint since v2 doesn't have a dedicated CQL search endpoint. Example CQL: `space = "DEV" AND title ~ "architecture"`.

### list_pages
Lists pages in a space by space key. Supports filtering by status (default: "current") and limiting result count.

### get_page_children
Returns child pages of a given parent page ID.

### get_spaces
Lists available Confluence spaces. Supports filtering by type (`global`, `personal`) and limiting result count. Useful for discovering space keys before using other tools.

### get_page_by_title
Looks up a page by its exact title within a space. Returns the same formatted output as `get_page`. Useful when you know the page name but not its numeric ID.

### add_attachment
Uploads a local file as an attachment to a Confluence page. Reads the file from the local filesystem and uploads via the v1 attachment API with `X-Atlassian-Token: nocheck` header. **Security:** The file path is resolved and validated to be under `process.cwd()` to prevent exfiltration of files outside the working directory.

### get_attachments
Lists attachments on a page with filename, ID, media type, and size.

### add_drawio_diagram
All-in-one tool for adding draw.io diagrams. The LLM provides the diagram XML (mxGraph format) and the tool handles the entire workflow:
1. Writes the XML to a temp file
2. Uploads it as a `.drawio` attachment
3. Updates the page body with the draw.io macro
4. Cleans up the temp file

By default appends the diagram to existing page content (`append: true`). Set `append: false` to replace the page body entirely. Requires the draw.io app to be installed on the Confluence instance.
