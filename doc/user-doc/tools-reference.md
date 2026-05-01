# Tools Reference

The Epimethian MCP server provides **35 tools** for managing Confluence pages, spaces, attachments, labels, diagrams, comments, content status badges, and version history. All tools return plain text output suitable for AI consumption.

_Last updated: 2026-04-30 — v6.6.3_

---

## Spaces

### `get_spaces`

Lists available Confluence spaces. Use this tool to discover space keys before using other tools.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `limit` | number | No | Maximum number of spaces to return (default: 25) |
| `type` | string | No | Filter by type: `global` or `personal` |

---

## Pages

### `create_page`

Creates a new page in a Confluence space. Accepts either GFM markdown or Confluence storage format (XHTML); markdown is auto-detected and converted. Do not mix the two — a body containing both `<ac:…/>` storage tags and markdown structural patterns is rejected with `MIXED_INPUT_DETECTED`.

In spaces with auto-numbering, the page version may advance silently after creation while post-processing renders the TOC and number prefixes. Use `wait_for_post_processing: true` when the next operation will be an update on the new page.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `title` | string | Yes | Page title |
| `space_key` | string | Yes | Space key (e.g., `DEV`) |
| `body` | string | Yes | Page content — GFM markdown or Confluence storage format |
| `parent_id` | string | No | ID of the parent page |
| `allow_raw_html` | boolean | No | Allow raw HTML passthrough inside markdown bodies (default: false) |
| `confluence_base_url` | string (URL) | No | Override the Confluence base URL used by the link rewriter |
| `wait_for_post_processing` | boolean | No | When true, polls the page version every 250 ms up to 3 s and returns once two consecutive reads agree (default: false). Recommended when the next operation will be an `update_page` on the new page. |

---

### `get_page`

Reads a page by its numeric ID. For large pages, use `headings_only` to get the page outline first, then use `section` to read a specific section, or `max_length` to limit the response size.

In Confluence spaces with heading auto-numbering enabled, stored heading text contains the prefix (e.g., `1.2. Section`); the section matcher accepts either the prefixed or plain form. `headings_only` output decodes HTML entities (`&uuml;` → `ü`, etc.).

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `page_id` | string | Yes | Numeric page ID |
| `include_body` | boolean | No | Whether to include page content (default: true) |
| `headings_only` | boolean | No | Return only the heading outline (default: false). Takes precedence over all other body options. HTML entities in headings are decoded. |
| `section` | string | No | Return only the content under this heading (case-insensitive). Use `headings_only` first to see available sections. Accepts both prefixed and plain forms in auto-numbered spaces. |
| `max_length` | number | No | Truncate the page body after this many characters. Pass `0` for no limit. |
| `format` | string | No | `"storage"` (default) or `"markdown"`. Markdown is a read-only rendering — macros and rich elements are summarised, not preserved. |

Returns title, ID, space, version, URL, and optionally the page content. Page bodies are cached in memory — repeated reads of the same page version avoid redundant API calls.

---

### `get_page_by_title`

Looks up a page by its exact title within a space. Supports the same body-reading parameters as `get_page`. Use this when you know the page name but not its numeric ID.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `title` | string | Yes | Exact page title |
| `space_key` | string | Yes | Space key (e.g., `DEV`) |
| `include_body` | boolean | No | Whether to include page content (default: false) |
| `headings_only` | boolean | No | Return only the heading outline (default: false). Takes precedence over all other body options. HTML entities in headings are decoded. |
| `section` | string | No | Return only the content under this heading (case-insensitive). |
| `max_length` | number | No | Truncate the page body after this many characters. |
| `format` | string | No | `"storage"` (default) or `"markdown"`. |

---

### `update_page`

Updates an existing page using optimistic concurrency control. Accepts GFM markdown or Confluence storage format; markdown is converted via the token-aware write path, which preserves existing macros and rich elements. Do not mix the two formats.

You must provide the `version` number from your most recent `get_page` call, or pass `"current"` to skip the read. If the page was modified by someone else since your read, the tool returns a 409 conflict error (including the current version) — re-read and retry. For narrow changes to a single section, prefer `update_page_section`.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `page_id` | string | Yes | Numeric page ID |
| `title` | string | Yes | Page title (use the title from `get_page` if unchanged) |
| `version` | number \| `"current"` | Yes | Version from your most recent `get_page` call. Pass `"current"` to skip the read and apply on top of the latest version. **Warning:** `"current"` bypasses optimistic concurrency and is not a conflict-resolution strategy. |
| `body` | string | No | New body content — GFM markdown or Confluence storage format. Omit to leave body unchanged. |
| `version_message` | string | No | Version comment visible in page history |
| `confirm_deletions` | boolean | No | Acknowledge that your markdown removes preserved macros or rich elements (default: false). Required when any preserved element would be deleted. |
| `replace_body` | boolean | No | Wholesale page rewrite that skips token preservation — all existing macros will be lost (default: false). |
| `confirm_shrinkage` | boolean | No | Acknowledge that the new body is >50% smaller than the existing body (default: false). |
| `confirm_structure_loss` | boolean | No | Acknowledge that heading count drops by >50% (default: false). |
| `allow_raw_html` | boolean | No | Allow raw HTML passthrough inside markdown bodies (default: false). |
| `confluence_base_url` | string (URL) | No | Override the Confluence base URL used by the link rewriter. |
| `source` | string | No | Provenance hint: `user_request`, `chained_tool_output`, `agent_decision`, or `elicitation_response`. Required when destructive flags are set. |

**Note:** `replace_body` skips all safety nets. When delegating `update_page` to a subagent, ensure the agent includes the full existing body — `replace_body` replaces ALL content with only what you provide.

---

### `update_page_section`

Updates a single section of a page by heading name. Only the content under the specified heading is replaced; the rest of the page is untouched. Use `headings_only` on `get_page` first to find section names.

In auto-numbered spaces, `section` accepts both the prefixed form (`"1.2. Lesereihenfolge"`) and the plain form (`"Lesereihenfolge"`). If the plain form matches multiple headings, a structured ambiguity error is returned.

Exactly one of `body` or `find_replace` must be provided.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `page_id` | string | Yes | Numeric page ID |
| `section` | string | Yes | Heading text identifying the section to replace (case-insensitive). Accepts prefixed or plain forms in auto-numbered spaces. |
| `body` | string | No* | New content for this section — GFM markdown or Confluence storage format. The heading itself is preserved; only content under it is replaced. *Exactly one of `body` or `find_replace` must be provided.* |
| `find_replace` | array | No* | Alternative to `body`: array of `{find, replace}` pairs. Each `find` is a literal string (not a regex); substitutions cannot match inside macro attribute values or CDATA bodies. Pairs are applied in input order. If a `find` string is not found, the call fails with `FIND_REPLACE_MATCH_FAILED`. *Exactly one of `body` or `find_replace` must be provided.* |
| `version` | number \| `"current"` | Yes | Version from your most recent `get_page` call. Pass `"current"` to skip the read. **Warning:** `"current"` bypasses optimistic concurrency. |
| `version_message` | string | No | Version comment visible in page history |
| `confirm_deletions` | boolean | No | Acknowledge that your markdown removes preserved macros, emoticons, or rich elements from this section (default: false). |

**Example — `find_replace` mode:**

```json
{
  "page_id": "12345",
  "section": "1. Overview",
  "version": 7,
  "find_replace": [
    { "find": "**1. Overview**", "replace": "**[1. Overview](confluence://ENG/Overview)**" }
  ]
}
```

---

### `update_page_sections`

Atomically updates multiple sections of a page in a single version bump. Either every section applies or none do — if any heading is missing, ambiguous, or duplicated in the input, the entire call is rejected and the page is left unchanged.

Sections are matched against the **original** page contents (not the cumulative-edited state), so sections in the input list cannot reference content introduced by an earlier section in the same call. The aggregate `confirm_deletions` gate fires **once** on the cross-section total — deletions cannot be bypassed by spreading them across sections.

In auto-numbered spaces, section names accept both prefixed and plain forms.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `page_id` | string | Yes | Numeric page ID |
| `version` | number \| `"current"` | Yes | Version from your most recent `get_page` call. Pass `"current"` to skip the read. **Warning:** `"current"` bypasses optimistic concurrency. |
| `version_message` | string | No | Version comment for the single resulting revision |
| `confirm_deletions` | boolean | No | Acknowledge that the aggregated set of sections removes preserved macros, emoticons, or rich elements (default: false). The gate fires once on the aggregate. |
| `sections` | array | Yes | List of `{section, body}` pairs. `section` is the heading text (case-insensitive); `body` is GFM markdown or Confluence storage format. Section names must be unique within the list. |

**Example:**

```json
{
  "page_id": "12345",
  "version": 3,
  "version_message": "Update summary and scope sections",
  "sections": [
    { "section": "Summary", "body": "<p>New summary text.</p>" },
    { "section": "Scope", "body": "<p>Updated scope.</p>" }
  ]
}
```

---

### `prepend_to_page`

Inserts content at the beginning of an existing Confluence page. The caller provides only the new content — the server fetches the existing body and handles concatenation. Safer than `update_page` with `replace_body` for additive operations.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `page_id` | string | Yes | Numeric page ID |
| `version` | number \| `"current"` | Yes | Version from your most recent `get_page` call. Pass `"current"` to skip the read. **Warning:** `"current"` bypasses optimistic concurrency. |
| `content` | string | Yes | Content to insert before the existing body — GFM markdown or Confluence storage format (auto-detected). |
| `separator` | string | No | Separator between new and existing content. Max 100 chars, no XML tags. Defaults to a blank line (markdown) or empty (storage). |
| `version_message` | string | No | Version comment visible in page history |
| `allow_raw_html` | boolean | No | Allow raw HTML inside markdown content (default: false). |
| `confluence_base_url` | string (URL) | No | Override the Confluence base URL used by the link rewriter. |

---

### `append_to_page`

Inserts content at the end of an existing Confluence page. The caller provides only the new content — the server fetches the existing body and handles concatenation. Safer than `update_page` with `replace_body` for additive operations.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `page_id` | string | Yes | Numeric page ID |
| `version` | number \| `"current"` | Yes | Version from your most recent `get_page` call. Pass `"current"` to skip the read. **Warning:** `"current"` bypasses optimistic concurrency. |
| `content` | string | Yes | Content to insert after the existing body — GFM markdown or Confluence storage format (auto-detected). |
| `separator` | string | No | Separator between existing and new content. Max 100 chars, no XML tags. Defaults to a blank line (markdown) or empty (storage). |
| `version_message` | string | No | Version comment visible in page history |
| `allow_raw_html` | boolean | No | Allow raw HTML inside markdown content (default: false). |
| `confluence_base_url` | string (URL) | No | Override the Confluence base URL used by the link rewriter. |

---

### `delete_page`

Deletes a page by its numeric ID. Requires the current `version` from your most recent `get_page` call — delete is refused if the page has been modified since. Set `EPIMETHIAN_LEGACY_DELETE_WITHOUT_VERSION=true` to restore version-less behaviour for one release while migrating scripts.

Does **not** accept `version: "current"` — this tool uses optimistic locking as a guard against destroying someone else's work.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `page_id` | string | Yes | Numeric page ID to delete |
| `version` | number | Yes* | Version from your most recent `get_page` call. *Required unless `EPIMETHIAN_LEGACY_DELETE_WITHOUT_VERSION=true` is set.* |
| `source` | string | No | Provenance hint (see `update_page`). Treated as destructive unconditionally. |

**Warning:** This operation is gated — clients that support elicitation will prompt the user for confirmation before proceeding.

---

### `list_pages`

Lists pages in a space.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `space_key` | string | Yes | Space key (e.g., `DEV`) |
| `limit` | number | No | Maximum number of pages to return (default: 25) |
| `status` | string | No | Page status filter (default: `current`) |

---

### `get_page_children`

Returns child pages of a given parent page.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `page_id` | string | Yes | Numeric ID of the parent page |
| `limit` | number | No | Maximum number of children to return (default: 25) |

---

### `search_pages`

Searches pages using CQL (Confluence Query Language). Results include a content excerpt (~300 chars) so you can triage matches without fetching each page.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `cql` | string | Yes | CQL query string |
| `limit` | number | No | Maximum number of results to return (default: 25) |

Example CQL queries:

```
space = "DEV" AND title ~ "architecture"
space = "DEV" AND label = "approved"
title = "My Page" AND space.key = "TEAM"
```

---

### `revert_page`

Reverts a Confluence page to a previous version. Fetches the exact storage-format body from the historical version and pushes it as a new version. This is a lossless revert — unlike reading `get_page_version` (which returns sanitised markdown) and passing it to `update_page`, this preserves all macros, formatting, and rich elements exactly.

Does **not** accept `version: "current"` — this tool relies on optimistic locking.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `page_id` | string | Yes | Numeric page ID |
| `target_version` | number | Yes | The version number to revert to. Must be less than the current version. |
| `current_version` | number | Yes | The current page version from your most recent `get_page` call (for optimistic locking). |
| `confirm_shrinkage` | boolean | No | Acknowledge that the historical version is significantly smaller than the current version (default: false). |
| `confirm_structure_loss` | boolean | No | Acknowledge that the historical version has fewer headings than the current version (default: false). |
| `version_message` | string | No | Version comment. Defaults to `"Revert to version N"`. |
| `source` | string | No | Provenance hint (see `update_page`). |

**Warning:** This operation is gated — clients that support elicitation will prompt the user for confirmation before proceeding.

---

## Attachments

### `add_attachment`

Uploads a local file as an attachment to a Confluence page. For security, the file path must resolve to a location under the server's working directory.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `page_id` | string | Yes | Numeric page ID |
| `file_path` | string | Yes | Absolute path to the local file (must be under the working directory) |
| `filename` | string | No | Name to use for the attachment (defaults to the file's basename) |
| `comment` | string | No | Comment describing the attachment |

---

### `get_attachments`

Lists attachments on a page.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `page_id` | string | Yes | Numeric page ID |
| `limit` | number | No | Maximum number of attachments to return (default: 25) |

Returns filename, attachment ID, media type, and file size for each attachment.

---

## Diagrams

### `add_drawio_diagram`

Adds a draw.io diagram to a Confluence page in a single step. Uploads the diagram XML as an attachment and embeds the draw.io macro in the page body. **Requires the draw.io app to be installed on your Confluence instance.**

The result text includes both `attachment_id` and `macro_id` so a follow-up call can target the inserted macro programmatically (e.g., to replace or remove it).

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `page_id` | string | Yes | Numeric page ID |
| `diagram_xml` | string | Yes | The diagram in mxGraph XML format (starting with `<mxfile>`) |
| `diagram_name` | string | Yes | Filename for the diagram (e.g., `architecture.drawio`). `.drawio` is appended if not already present. |
| `append` | boolean | No | If true, appends the diagram to existing page content; if false, replaces the page body (default: true). |

**Example result text:**

```
Diagram "architecture.drawio" added to page My Page (ID: 12345, version: 4, attachment ID: att-abc123, macro ID: uuid-xxx)
```

---

## Labels

### `get_labels`

Gets all labels on a Confluence page.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `page_id` | string | Yes | Confluence page ID |

Returns each label's prefix and name.

---

### `add_label`

Adds one or more labels to a Confluence page. Labels must be lowercase, alphanumeric, hyphens, or underscores.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `page_id` | string | Yes | Confluence page ID |
| `labels` | array of strings | Yes | Labels to add (1–20 items; lowercase, alphanumeric, hyphens, underscores) |

---

### `remove_label`

Removes a label from a Confluence page.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `page_id` | string | Yes | Confluence page ID |
| `label` | string | Yes | Label to remove |

---

## Content Status

### `get_page_status`

Gets the content status badge (e.g., "Draft", "In Progress", "Ready for Review") on a page. Works in read-only mode.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `page_id` | string | Yes | Confluence page ID |

Returns the status name and color, or indicates that no status is set.

---

### `set_page_status`

Sets the content status badge on a page.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `page_id` | string | Yes | Confluence page ID |
| `name` | string | Yes | Status name (max 20 characters, no control characters) |
| `color` | string | Yes | Status badge color: `#FFC400` (yellow), `#2684FF` (blue), `#57D9A3` (green), `#FF7452` (red), `#8777D9` (purple) |

**Warning:** Each call creates a new page version even if the status is unchanged — do not call in a loop. The tool short-circuits (no-op) if the current status already matches the requested name and color.

---

### `remove_page_status`

Removes the content status badge from a page. Idempotent — removing a status that does not exist succeeds silently.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `page_id` | string | Yes | Confluence page ID |

---

## Comments

### `get_comments`

Retrieves comments on a page. Works in read-only mode.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `page_id` | string | Yes | Confluence page ID |
| `type` | string | No | Comment type: `footer`, `inline`, or `all` (default: `all`) |
| `resolution_status` | string | No | Filter inline comments by status: `open`, `resolved`, or `all` (default: `all`). Ignored for footer comments. |
| `include_replies` | boolean | No | If true, fetches replies for each top-level comment (one extra API call per comment; default: false) |

Returns all comments of the specified type with author, creation date, and content.

---

### `create_comment`

Adds a new comment to a page.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `page_id` | string | Yes | Confluence page ID |
| `body` | string | Yes | Comment body (plain text or simple HTML paragraphs — macros not supported) |
| `type` | string | No | Comment type: `footer` or `inline` (default: `footer`) |
| `parent_comment_id` | string | No | Parent comment ID to reply to (creates a nested reply) |
| `text_selection` | string | No | Exact text to highlight for inline comments (required for top-level inline comments; ignored for footer) |
| `text_selection_match_index` | number | No | Zero-based index of which occurrence to highlight when text appears multiple times (default: 0) |

Footer comments appear at the bottom of the page. Inline comments are anchored to specific text on the page. All comments are prefixed with `[AI-generated via Epimethian]`.

---

### `resolve_comment`

Resolves or reopens an inline comment. Only inline comments can be resolved — footer comments have no resolution status.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `comment_id` | string | Yes | Inline comment ID |
| `resolved` | boolean | No | `true` to resolve, `false` to reopen (default: true) |

---

### `delete_comment`

Permanently deletes a comment. Deleting a parent comment also deletes all its replies.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `comment_id` | string | Yes | Comment ID to delete |
| `type` | string | Yes | Comment type: `footer` or `inline` (required — cannot be auto-detected) |

---

## Version History

### `get_page_versions`

Lists the version history for a page. Results are ordered newest to oldest.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `page_id` | string | Yes | Confluence page ID |
| `limit` | number | No | Maximum number of versions to return (1–200, default: 25) |

Returns version number, author, date, and optional version message for each version.

---

### `get_page_version`

Gets the content of a page at a specific historical version. Returns sanitised read-only markdown (macros replaced with placeholders). This content is **not** suitable for round-trip updates via `update_page` — the conversion is lossy. To revert a page to a previous version, use `revert_page` instead.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `page_id` | string | Yes | Confluence page ID |
| `version` | number | Yes | Version number to retrieve (must be ≥ 1) |

Historical version bodies are cached separately from current versions.

---

### `diff_page_versions`

Compares two versions of a page with a section-aware summary or unified diff. Always operates on sanitised text (macro content replaced with placeholders).

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `page_id` | string | Yes | Confluence page ID |
| `from_version` | number | Yes | Starting version number |
| `to_version` | number | No | Ending version number (defaults to current version). Must be greater than `from_version`. |
| `max_length` | number | No | Truncate output after this many characters (applies to `unified` format). |
| `format` | string | No | `"summary"` (default) or `"unified"`. Summary shows section-level changes; unified shows a standard diff. |

The summary format groups changes by heading — added sections, removed sections, and modified sections with per-section diffs. Costs 2–3 API calls.

---

## User and Page Lookup

### `lookup_user`

Searches for Atlassian/Confluence users by name, display name, or email substring. Returns up to 10 matches, each with `accountId`, `displayName`, and `email`. Use this to resolve an `accountId` for the `:mention[Display]{accountId=…}` markdown directive when authoring pages via `create_page` or `update_page`.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Name, display name, or email substring to search for (minimum 1 character) |

---

### `resolve_page_link`

Resolves a Confluence page to its stable content ID and URL given a page title and space key. Use this to construct a `confluence://` markdown link when authoring pages — either `[text](confluence://SPACE_KEY/PAGE_TITLE)` (preferred; produces an `<ac:link>` reference that follows the page across renames) or `[text](confluence://CONTENT_ID)` (plain anchor to the stable URL).

If multiple pages share the same title in the space, the first match is returned with a notice.

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `title` | string | Yes | Exact page title to look up |
| `space_key` | string | Yes | Confluence space key (e.g., `ENG`) |

Returns `contentId`, `url`, `spaceKey`, and `title` for the matched page.

---

## Server Administration

### `check_permissions`

Reports the current profile's MCP access mode and the token's capabilities. Always available in every posture (read-only and read-write).

Takes no parameters.

---

### `get_version`

Returns the epimethian-mcp server version. Also reports available updates, if any, including whether a patch was auto-installed via `EPIMETHIAN_AUTO_UPGRADE=patches`.

Takes no parameters.

---

### `upgrade`

Upgrades epimethian-mcp to the latest available version. After a successful upgrade the user must restart the MCP server (reload the VS Code window or restart Claude) for the new version to take effect.

Takes no parameters.

**Note:** If `get_version` reports a pending update, call this tool to install it. The install runs an npm provenance check before fetching the tarball.
