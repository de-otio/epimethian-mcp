# MCP Tools

All tools return plain text (not JSON) for LLM consumption. Tools are registered using `server.registerTool()` with annotations that hint at their behavior (e.g., `readOnlyHint`, `destructiveHint`, `idempotentHint`). All API responses are validated at runtime using Zod schemas defined in `confluence-client.ts`.

## Read-Only Mode

When a profile is configured as read-only (`readOnly: true` in profile settings or `CONFLUENCE_READ_ONLY=true` env var), write tools are blocked at call time using a whitelist pattern: only tools in the `READ_ONLY_TOOLS` set are permitted, all others return an error. Write tool descriptions are prefixed with `[READ-ONLY]` during registration. New tools are blocked by default unless explicitly added to the whitelist.

## Tool Annotations

| Tool | readOnlyHint | destructiveHint | idempotentHint |
|------|:---:|:---:|:---:|
| `get_page`, `search_pages`, `list_pages`, `get_page_children`, `get_spaces`, `get_page_by_title`, `get_attachments`, `get_labels`, `get_comments`, `get_page_status`, `get_page_versions`, `get_page_version`, `diff_page_versions`, `get_version` | yes | — | — |
| `create_page`, `add_attachment`, `add_drawio_diagram`, `add_label`, `create_comment` | — | no | no |
| `update_page`, `update_page_section`, `resolve_comment` | — | no | no |
| `delete_page`, `remove_label`, `delete_comment`, `set_page_status`, `remove_page_status` | — | yes | yes |

## Tool Summary

| Tool | Parameters | Description |
|------|-----------|-------------|
| `create_page` | title, space_key, body, parent_id? | Create a new Confluence page |
| `get_page` | page_id, include_body?, headings_only?, section?, max_length?, format? | Read a page by ID |
| `update_page` | page_id, title, version, body?, version_message? | Update an existing page (optimistic concurrency via version) |
| `update_page_section` | page_id, section, body, version, version_message? | Update a single section by heading name |
| `delete_page` | page_id | Delete a page by ID |
| `search_pages` | cql, limit? | Search using CQL |
| `list_pages` | space_key, limit?, status? | List pages in a space |
| `get_page_children` | page_id, limit? | Get child pages |
| `get_spaces` | limit?, type? | List available spaces |
| `get_page_by_title` | title, space_key, include_body?, headings_only?, section?, max_length?, format? | Look up a page by title within a space |
| `add_attachment` | page_id, file_path, filename?, comment? | Upload a file attachment to a page |
| `get_attachments` | page_id, limit? | List attachments on a page |
| `add_drawio_diagram` | page_id, diagram_xml, diagram_name, append? | Add a draw.io diagram to a page (all-in-one) |
| `get_labels` | page_id | Get all labels on a page |
| `add_label` | page_id, labels | Add one or more labels to a page |
| `remove_label` | page_id, label | Remove a label from a page |
| `get_comments` | page_id, type?, resolution_status?, include_replies? | Get footer/inline comments on a page |
| `create_comment` | page_id, body, type?, parent_comment_id?, text_selection?, text_selection_match_index? | Create a footer or inline comment |
| `resolve_comment` | comment_id, resolved? | Resolve or reopen an inline comment |
| `delete_comment` | comment_id, type | Permanently delete a comment |
| `get_page_status` | page_id | Get the content status badge on a page |
| `set_page_status` | page_id, name, color | Set the content status badge on a page |
| `remove_page_status` | page_id | Remove the content status badge from a page |
| `get_page_versions` | page_id, limit? | List version history for a page |
| `get_page_version` | page_id, version | Get page content at a specific historical version |
| `diff_page_versions` | page_id, from_version, to_version?, max_length?, format? | Compare two versions of a page |
| `get_version` | *(none)* | Return the epimethian-mcp server version |

## Tool Details

### create_page
Creates a new page in a Confluence space. Resolves the human-readable `space_key` (e.g., "DEV") to a numeric space ID internally. Plain text body content is auto-wrapped in `<p>` tags; HTML/storage format is passed through as-is.

### get_page
Reads a page by its numeric ID. By default includes the page body in Confluence storage format. Returns title, ID, space, version, URL, and optionally the content. For large pages, use `headings_only: true` to get the page outline first (a numbered heading hierarchy), then use `section` to read a specific section, or `max_length` to limit the response size. The `format: "markdown"` option returns a read-only markdown rendering (macros and rich elements are summarized as placeholders, not preserved). Page bodies are cached in memory to avoid redundant API calls during iterative editing sessions.

### update_page
Updates an existing page using optimistic concurrency control. The caller must provide the `version` number from their most recent `get_page` call. The server sends `version + 1` to the Confluence API. If the page has been modified since the caller's read (version mismatch), Confluence returns a 409 and the tool returns a `ConfluenceConflictError` instructing the agent to re-read the page. Both `title` and `version` are required; `body` is optional (omit to update only the title). Bodies that appear to be markdown (rather than storage format) are rejected with an error.

### update_page_section
Updates a single section of a page by heading name. The rest of the page is untouched. Fetches the full page body, replaces the content under the specified heading (case-insensitive match), and calls `update_page` with the reconstructed body. Uses the same optimistic concurrency pattern as `update_page`. This reduces the blast radius of edits — untouched sections are never re-serialized.

### delete_page
Deletes a page by ID. Returns confirmation text.

### search_pages
Searches using CQL (Confluence Query Language). Uses the v1 `/rest/api/search` endpoint (not `/content/search`) to include content excerpts in results. Example CQL: `space = "DEV" AND title ~ "architecture"`.

### list_pages
Lists pages in a space by space key. Supports filtering by status (default: "current") and limiting result count.

### get_page_children
Returns child pages of a given parent page ID.

### get_spaces
Lists available Confluence spaces. Supports filtering by type (`global`, `personal`) and limiting result count. Useful for discovering space keys before using other tools.

### get_page_by_title
Looks up a page by its exact title within a space. Returns the same formatted output as `get_page`. Useful when you know the page name but not its numeric ID. Supports the same `headings_only` drill-down pattern as `get_page`.

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

### get_labels
Returns all labels on a page. Labels are returned as an array of strings. This is a read-only operation and does not require edit permissions.

### add_label
Adds one or more labels to a page. The `labels` parameter accepts either a single label name (string) or an array of label names. Labels are case-insensitive when matching existing labels, but the server preserves the case of the label as provided. This operation does not remove existing labels; it only adds new ones. Duplicate label additions are idempotent (duplicate additions have no effect). Requires edit permission on the page.

### remove_label
Removes a single label from a page. The `label` parameter is the name of the label to remove. Removal is case-insensitive. If the label is not present on the page, the operation succeeds silently (idempotent). Requires edit permission on the page.

### get_comments
Retrieves footer and/or inline comments on a page. Supports filtering by type (`footer`, `inline`, `all`) and resolution status (`open`, `resolved`, `all`). Optionally fetches reply threads for each top-level comment. Comment bodies are sanitized HTML.

### create_comment
Creates a footer or inline comment on a page. All comments are auto-prefixed with `[AI-generated via Epimethian]` for attribution. Footer comments appear at the bottom of the page; inline comments are anchored to a specific text selection. The `text_selection` parameter is required for top-level inline comments; `text_selection_match_index` disambiguates when the same text appears multiple times. Supports replies via `parent_comment_id`.

### resolve_comment
Resolves or reopens an inline comment. Only inline comments have resolution status — footer comments do not.

### delete_comment
Permanently deletes a comment. The `type` parameter (`footer` or `inline`) is required because Confluence uses separate API endpoints for each. Deleting a parent comment also deletes all replies. Idempotent — deleting a non-existent comment succeeds silently.

### get_page_status
Returns the content status badge on a page (name and color). If no status is set, indicates that. This is a read-only operation.

### set_page_status
Sets the content status badge on a page. The `name` parameter is validated (max 20 chars, no control characters). The `color` parameter must be one of five predefined hex values. **Warning:** Setting a status creates a new page version in Confluence.

### remove_page_status
Removes the content status badge from a page. Idempotent — succeeds silently if no status is set.

### get_page_versions
Lists version history metadata for a page (version number, author, date, version message). Results are ordered from newest to oldest. The `limit` parameter caps at 200.

### get_page_version
Fetches the content of a page at a specific historical version. Returns the body as sanitized markdown. Historical version bodies are cached separately from current versions in the page cache (using composite keys).

### diff_page_versions
Compares two versions of a page. The `summary` format (default) uses section-aware diffing — it splits both versions by heading and reports added, removed, and modified sections with per-section change details. The `unified` format returns a standard unified diff. Both formats support `max_length` truncation. Uses the `diff` npm package internally. Size-limited to 500 KB per version.

### get_version
Returns the epimethian-mcp server version (e.g., `epimethian-mcp v4.3.0`). Takes no parameters. The version is injected at build time from `package.json` via esbuild's `define` and embedded in the attribution footer, page version comments, and this tool's output.
