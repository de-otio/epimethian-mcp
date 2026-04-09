# Tools Reference

The Epimethian MCP server provides 26 tools for managing Confluence pages, spaces, attachments, labels, diagrams, comments, content status badges, and version history. All tools return plain text output suitable for AI consumption.

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

Reads a page by its numeric ID. For large pages, use `headings_only` to get the page outline first, then use `section` to read a specific section, or `max_length` to limit the response size.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page_id` | string | Yes | Numeric page ID |
| `include_body` | boolean | No | Whether to include page content (default: true) |
| `headings_only` | boolean | No | Return only the heading outline (default: false). Takes precedence over all other body options. |
| `section` | string | No | Return only the content under this heading (case-insensitive). Use `headings_only` first to see available sections. |
| `max_length` | number | No | Truncate the page body after this many characters. |
| `format` | string | No | `"storage"` (default) or `"markdown"`. Markdown is a read-only rendering — macros and rich elements are summarized, not preserved. |

Returns title, ID, space, version, URL, and optionally the page content. Page bodies are cached in memory — repeated reads of the same page version avoid redundant API calls.

---

### `get_page_by_title`

Looks up a page by its exact title within a space. Supports the same parameters as `get_page` (`headings_only`, `section`, `max_length`, `format`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Exact page title |
| `space_key` | string | Yes | Space key (e.g., `DEV`) |
| `include_body` | boolean | No | Whether to include page content (default: false) |
| `headings_only` | boolean | No | Return only the heading outline (default: false). Takes precedence over all other body options. |
| `section` | string | No | Return only the content under this heading (case-insensitive). |
| `max_length` | number | No | Truncate the page body after this many characters. |
| `format` | string | No | `"storage"` (default) or `"markdown"`. |

Returns the same output as `get_page`. Use this when you know the page name but not its numeric ID.

---

### `update_page`

Updates an existing page using optimistic concurrency control. You must provide the `version` number from your most recent `get_page` call. If the page was modified by someone else since then, the tool returns an error asking you to re-read the page and retry.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page_id` | string | Yes | Numeric page ID |
| `title` | string | Yes | Page title (use the title from `get_page` if unchanged) |
| `version` | number | Yes | Page version number from your most recent `get_page` call |
| `body` | string | No | New page content (omit to leave body unchanged) |
| `version_message` | string | No | Version comment visible in page history |

Bodies that appear to be markdown (rather than Confluence storage format) are rejected with an error to prevent accidental data loss.

---

### `update_page_section`

Updates a single section of a page by heading name. Only the content under the specified heading is replaced; the rest of the page is untouched.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page_id` | string | Yes | Numeric page ID |
| `section` | string | Yes | Heading text identifying the section to replace (case-insensitive) |
| `body` | string | Yes | New content for this section in Confluence storage format |
| `version` | number | Yes | Page version number from your most recent `get_page` call |
| `version_message` | string | No | Version comment visible in page history |

Use `headings_only` on `get_page` first to find section names. This reduces the blast radius of edits — the LLM never needs to handle the full page body.

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

Searches pages using CQL (Confluence Query Language). Results include a content excerpt (~300 chars) so you can triage matches without fetching each page.

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

---

## Comments

### `get_comments`

Retrieves comments on a page. Works in read-only mode.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page_id` | string | Yes | Confluence page ID |
| `type` | string | No | Comment type: `footer`, `inline`, or `all` (default: `all`) |
| `resolution_status` | string | No | Filter inline comments by status: `open`, `resolved`, or `all` (default: `all`). Ignored for footer comments. |
| `include_replies` | boolean | No | If true, fetches replies for each top-level comment (default: false) |

Returns all comments of the specified type with author, creation date, and content.

---

### `create_comment`

Adds a new comment to a page. Blocked in read-only mode.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page_id` | string | Yes | Confluence page ID |
| `body` | string | Yes | Comment body (plain text or simple HTML) |
| `type` | string | No | Comment type: `footer` or `inline` (default: `footer`) |
| `parent_comment_id` | string | No | Parent comment ID to reply to (creates a nested reply) |
| `text_selection` | string | No | Exact text to highlight for inline comments (required for top-level inline comments) |
| `text_selection_match_index` | number | No | Zero-based index of which occurrence to highlight (default: 0). Use this if the same text appears multiple times on the page. |

Footer comments appear at the bottom of the page. Inline comments are anchored to specific text on the page.

---

### `resolve_comment`

Resolves or reopens an inline comment. Blocked in read-only mode.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `comment_id` | string | Yes | Inline comment ID |
| `resolved` | boolean | No | `true` to resolve the comment, `false` to reopen (default: true) |

Only inline comments can be resolved. Footer comments have no resolution status.

---

### `delete_comment`

Deletes a comment. Blocked in read-only mode.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `comment_id` | string | Yes | Comment ID to delete |
| `type` | string | Yes | Comment type: `footer` or `inline` |

Deleting a parent comment also deletes all replies to that comment.

---

## Content Status

### `get_page_status`

Gets the content status badge (e.g., "Draft", "In Progress", "Ready for Review") on a page. Works in read-only mode.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page_id` | string | Yes | Confluence page ID |

Returns the status name and color, or indicates that no status is set.

---

### `set_page_status`

Sets the content status badge on a page. Blocked in read-only mode.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page_id` | string | Yes | Confluence page ID |
| `name` | string | Yes | Status name (max 20 characters, no control characters) |
| `color` | string | Yes | Status color: `#FFC400` (yellow), `#2684FF` (blue), `#57D9A3` (green), `#FF7452` (red), or `#8777D9` (purple) |

Setting a status creates a new page version. This is a Confluence Cloud behavior — the tool warns about it in the response.

---

### `remove_page_status`

Removes the content status badge from a page. Blocked in read-only mode.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page_id` | string | Yes | Confluence page ID |

Idempotent — removing a status that doesn't exist succeeds silently.

---

## Version History

### `get_page_versions`

Lists the version history for a page. Works in read-only mode.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page_id` | string | Yes | Confluence page ID |
| `limit` | number | No | Maximum number of versions to return (1–200, default: 25) |

Returns version number, author, date, and optional version message for each version. Results are ordered from newest to oldest.

---

### `get_page_version`

Gets the content of a page at a specific historical version. Works in read-only mode.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page_id` | string | Yes | Confluence page ID |
| `version` | number | Yes | Version number (must be ≥ 1) |

Returns the page content as sanitized markdown at the requested version. Historical version bodies are cached separately from current versions.

---

### `diff_page_versions`

Compares two versions of a page with a section-aware summary or unified diff. Works in read-only mode.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `page_id` | string | Yes | Confluence page ID |
| `from_version` | number | Yes | Starting version number |
| `to_version` | number | No | Ending version number (defaults to current version) |
| `max_length` | number | No | Truncate output after this many characters |
| `format` | string | No | `"summary"` (default) or `"unified"`. Summary shows section-level changes; unified shows a standard diff. |

The summary format groups changes by heading — added sections, removed sections, and modified sections with per-section diffs. Useful for answering "what changed since version X?"
