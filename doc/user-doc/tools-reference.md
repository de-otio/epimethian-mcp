# Tools Reference

The Confluence MCP server provides 12 tools for managing Confluence pages, spaces, attachments, and diagrams. All tools return plain text output suitable for AI consumption.

## Spaces

### `get_spaces`

Lists available Confluence spaces.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | No | Maximum number of spaces to return |
| `type` | string | No | Filter by type: `global` or `personal` |

Use this tool to discover space keys before using other tools.

---

## Pages

### `create_page`

Creates a new page in a Confluence space.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Page title |
| `space_key` | string | Yes | Space key (e.g., `DEV`) |
| `body` | string | Yes | Page content (plain text or Confluence storage format HTML) |
| `parent_id` | string | No | ID of the parent page |

Plain text body content is automatically wrapped in `<p>` tags. HTML in Confluence storage format is passed through as-is.

---

### `get_page`

Reads a page by its numeric ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page_id` | string | Yes | Numeric page ID |
| `include_body` | boolean | No | Whether to include page content (default: true) |

Returns title, ID, space, version, URL, and optionally the page content in Confluence storage format.

---

### `get_page_by_title`

Looks up a page by its exact title within a space.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Exact page title |
| `space_key` | string | Yes | Space key (e.g., `DEV`) |
| `include_body` | boolean | No | Whether to include page content (default: false) |

Returns the same output as `get_page`. Use this when you know the page name but not its numeric ID.

---

### `update_page`

Updates an existing page. Automatically fetches the current version and increments it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page_id` | string | Yes | Numeric page ID |
| `title` | string | No | New page title (keeps current if omitted) |
| `body` | string | No | New page content (keeps current if omitted) |
| `version_message` | string | No | Version comment visible in page history |

---

### `delete_page`

Deletes a page by its numeric ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page_id` | string | Yes | Numeric page ID |

---

### `list_pages`

Lists pages in a space.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `space_key` | string | Yes | Space key (e.g., `DEV`) |
| `limit` | number | No | Maximum number of pages to return |
| `status` | string | No | Page status filter (default: `current`) |

---

### `get_page_children`

Returns child pages of a given parent page.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page_id` | string | Yes | Numeric ID of the parent page |
| `limit` | number | No | Maximum number of children to return |

---

### `search_pages`

Searches pages using CQL (Confluence Query Language).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `cql` | string | Yes | CQL query string |
| `limit` | number | No | Maximum number of results to return |

Example CQL queries:

```
space = "DEV" AND title ~ "architecture"
space = "DEV" AND label = "approved"
title = "My Page" AND space.key = "TEAM"
```

---

## Attachments

### `add_attachment`

Uploads a local file as an attachment to a Confluence page. For security, the file path must resolve to a location under the server's working directory.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page_id` | string | Yes | Numeric page ID |
| `file_path` | string | Yes | Absolute path to the local file (must be under the working directory) |
| `filename` | string | No | Name to use for the attachment (defaults to the file's name) |
| `comment` | string | No | Comment describing the attachment |

**draw.io diagrams:** Upload a `.drawio` file and then reference it in a page body using the draw.io macro:

```xml
<ac:structured-macro ac:name="drawio" ac:schema-version="1">
  <ac:parameter ac:name="diagramName">my-diagram.drawio</ac:parameter>
  <ac:parameter ac:name="attachment">my-diagram.drawio</ac:parameter>
</ac:structured-macro>
```

---

### `get_attachments`

Lists attachments on a page.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page_id` | string | Yes | Numeric page ID |
| `limit` | number | No | Maximum number of attachments to return |

Returns filename, attachment ID, media type, and file size for each attachment.

---

## Diagrams

### `add_drawio_diagram`

Adds a draw.io diagram to a Confluence page in a single step. Uploads the diagram XML as an attachment and embeds the draw.io macro in the page body.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page_id` | string | Yes | Numeric page ID |
| `diagram_xml` | string | Yes | The diagram in mxGraph XML format (starting with `<mxfile>`) |
| `diagram_name` | string | Yes | Filename for the diagram (e.g., `architecture.drawio`) |
| `append` | boolean | No | Append to existing page content (default: true). Set to false to replace. |

**Requires the draw.io app to be installed on your Confluence instance.** If draw.io is not installed, the attachment will upload successfully but the diagram macro will display as an unknown macro on the page.

Example usage: ask your AI assistant to "create a draw.io architecture diagram on page 12345" and it will generate the mxGraph XML and call this tool to handle the rest.
