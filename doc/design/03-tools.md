# MCP Tools

All tools return plain text (not JSON) for LLM consumption. Tools are registered using `server.registerTool()` with annotations that hint at their behavior (e.g., `readOnlyHint`, `destructiveHint`, `idempotentHint`). All API responses are validated at runtime using Zod schemas defined in `confluence-client.ts`.

## Read-Only Mode

When a profile posture is `"read-only"` — set via `posture: "read-only"` in profile settings, the legacy `readOnly: true` alias, or `CONFLUENCE_READ_ONLY=true` env var — write tools are **not registered** at all. The agent's tool list is truthful: only read tools and `check_permissions` appear. A startup probe auto-detects the token's capability when `posture: "detect"` (the default). See [doc/design/14-api-permission-handling.md](14-api-permission-handling.md) for the full posture / detection logic.

The legacy `readOnly: boolean` profile key remains supported as an alias for `posture: "read-only"` / `"read-write"`. Users should migrate to `posture` directly.

## Tool Annotations

Every tool carries a `title` and the four hints below (`openWorldHint` is `true` on all of them). The table is pinned by `src/server/tool-surface.test.ts`.

| Tool | readOnlyHint | destructiveHint | idempotentHint |
|------|:---:|:---:|:---:|
| `get_page`, `get_page_by_title`, `search_pages`, `list_pages`, `get_page_children`, `get_spaces`, `get_attachments`, `get_labels`, `get_comments`, `get_page_status`, `get_page_versions`, `get_page_version`, `diff_page_versions`, `get_recent_changes`, `get_version`, `check_permissions`, `lookup_user`, `resolve_page_link` | yes | no | yes |
| `create_page`, `add_attachment`, `create_comment`, `prepend_to_page`, `append_to_page` | no | no | no |
| `add_label`, `resolve_comment` | no | no | yes |
| `update_page`, `update_page_section`, `update_page_sections`, `add_drawio_diagram`, `revert_page`, `download_attachment`, `authorise_destructive_writes` | no | yes | no |
| `delete_page`, `delete_comment`, `remove_label`, `set_page_status`, `remove_page_status`, `upgrade` | no | yes | yes |

`destructiveHint` is true for any tool that can remove or overwrite content, including a local file (`download_attachment`) or the installed server (`upgrade`). `prepend_to_page` and `append_to_page` only ever add, so they stay non-destructive.

### `requiresUserInteraction`

`delete_page`, `revert_page`, `delete_comment`, `authorise_destructive_writes` and `upgrade` also set `_meta["anthropic/requiresUserInteraction"]: true`. A client that honours the key (Claude Code does) shows an approval prompt on every call, whatever the user's allow rules say. Flag-gated writes such as `update_page` do not set it: they keep the elicitation / soft-confirmation path, where a prompt on every call would be too broad. Annotations and `_meta` are hints to the client, not enforcement; see [security/06-limitations.md](security/06-limitations.md).

### Tool descriptions

Every description, measured after the safety wrappers are applied, is at most 1,800 characters. The wrappers (`withDestructiveWarning`, `withUntrustedNote`) prepend their text, so the safety wording comes first and survives a client that truncates from the end. Worked examples live in `install-agent.md`, not in the descriptions. Whether clients truncate individual parameter descriptions is an open question (see [security/06-limitations.md](security/06-limitations.md)); parameter descriptions are kept short as a precaution.

## Tool Summary

| Tool | Parameters | Description |
|------|-----------|-------------|
| `create_page` | title, space_key, body, parent_id? | Create a new Confluence page. Applies the "AI-edited" provenance badge. Requires write permission. |
| `get_page` | page_id, include_body?, headings_only?, section?, max_length?, format? | Read a page by ID |
| `update_page` | page_id, title, version, body?, version_message? | Update an existing page (optimistic concurrency via version). Applies the "AI-edited" provenance badge. Requires write permission. |
| `update_page_section` | page_id, section, body? or find_replace?, version, version_message?, confirm_*?, confirm_token?, batch_token? | Update a single section by heading name, by replacing its body or by literal find/replace pairs. Applies the "AI-edited" provenance badge. Requires write permission. |
| `update_page_sections` | page_id, sections (each `{section, body?` or `find_replace?}`), version, version_message?, confirm_*?, confirm_token?, batch_token? | Update several sections in one PUT and one version. Applies the "AI-edited" provenance badge. Requires write permission. |
| `authorise_destructive_writes` | page_ids, ttl_seconds?, max_operations?, reason? | Mint a batch token that pre-authorises a bounded set of destructive writes. A write tool: not registered in the read-only posture. |
| `delete_page` | page_id | Delete a page by ID. Requires delete permission. |
| `search_pages` | cql, limit? (1-200), all_spaces?, excerpts? | Search using CQL, scoped to the profile's `read_spaces` when set. Shows last-modified time, version and last editor. |
| `list_pages` | space_key, limit?, status? | List pages in a space |
| `get_page_children` | page_id, limit? | Get child pages |
| `get_spaces` | limit?, type? | List available spaces |
| `get_page_by_title` | title, space_key, include_body?, headings_only?, section?, max_length?, format? | Look up a page by title within a space |
| `add_attachment` | page_id, file_path, filename?, comment? | Upload a file attachment to a page. Requires add-attachment permission. |
| `get_attachments` | page_id, limit? | List attachments on a page |
| `download_attachment` | attachment_id, output_path?, overwrite? | Download an attachment's bytes to a local file under the working directory and return the path. Read-only against Confluence; no write permission and no write budget consumed. Annotated as destructive because it writes a local file. |
| `add_drawio_diagram` | page_id, diagram_xml, diagram_name, append? | Add a draw.io diagram to a page (all-in-one). Applies the "AI-edited" provenance badge. Requires write permission. |
| `get_labels` | page_id | Get all labels on a page |
| `add_label` | page_id, labels | Add one or more labels to a page. Requires edit permission. |
| `remove_label` | page_id, label | Remove a label from a page. Requires edit permission. |
| `get_comments` | page_id, type?, resolution_status?, include_replies? | Get footer/inline comments on a page. When `include_replies` is true, returns partial results if any individual reply fetch is inaccessible. |
| `create_comment` | page_id, body, type?, parent_comment_id?, text_selection?, text_selection_match_index? | Create a footer or inline comment. Requires add-comment permission. |
| `resolve_comment` | comment_id, resolved? | Resolve or reopen an inline comment. Requires edit permission. |
| `delete_comment` | comment_id, type | Permanently delete a comment. Requires delete permission. |
| `get_page_status` | page_id | Get the content status badge on a page |
| `set_page_status` | page_id, name, color | Set the content status badge on a page. Requires edit permission. |
| `remove_page_status` | page_id | Remove the content status badge from a page. Requires edit permission. |
| `get_page_versions` | page_id, limit? | List version history for a page |
| `get_page_version` | page_id, version | Get page content at a specific historical version |
| `diff_page_versions` | page_id, from_version, to_version?, max_length?, format? | Compare two versions of a page (`summary`, `unified` or `storage`) |
| `get_recent_changes` | hours or since, spaces?, all_spaces?, include_blogposts?, detail?, limit?, max_diffs? | Report the pages and blog posts changed in a time window, scoped like `search_pages` |
| `prepend_to_page` | page_id, version, content, separator?, version_message?, allow_raw_html?, confluence_base_url? | Insert content at the beginning of an existing page. Applies the "AI-edited" provenance badge. Requires write permission. |
| `append_to_page` | page_id, version, content, separator?, version_message?, allow_raw_html?, confluence_base_url? | Insert content at the end of an existing page. Applies the "AI-edited" provenance badge. Requires write permission. |
| `revert_page` | page_id, target_version, current_version, confirm_shrinkage?, confirm_structure_loss?, version_message? | Revert page to a previous version (lossless, uses raw storage). Applies the "AI-edited" provenance badge. Requires write permission. |
| `lookup_user` | query | Search for Atlassian users by name or email |
| `resolve_page_link` | title, space_key | Resolve a page title + space key to a stable page ID and URL |
| `get_version` | *(none)* | Return the epimethian-mcp server version |
| `check_permissions` | *(none)* | Report the configured posture, effective posture, probe result, token capability, and human-readable notes for the active profile. Always registered, in every posture. See [doc/design/14-api-permission-handling.md](14-api-permission-handling.md). |

## Tool Details

### create_page
Creates a new page in a Confluence space. Resolves the human-readable `space_key` (e.g., "DEV") to a numeric space ID internally. Plain text body content is auto-wrapped in `<p>` tags; HTML/storage format is passed through as-is. Creates or refreshes the "AI-edited" provenance badge on the page after successful creation. Configurable via the `unverifiedStatus` profile setting (see [doc/design/13-unverified-status.md](13-unverified-status.md)).

### get_page
Reads a page by its numeric ID. By default includes the page body in Confluence storage format. Returns title, ID, space, version, URL, and optionally the content. For large pages, use `headings_only: true` to get the page outline first (a numbered heading hierarchy), then use `section` to read a specific section, or `max_length` to limit the response size. The `format: "markdown"` option returns a read-only markdown rendering (macros and rich elements are summarized as placeholders, not preserved). Every body path (storage, section storage, markdown, section markdown, truncated) is returned inside the untrusted-content fence, with field names `body`, `section` and `markdown`; the fence folds the text to NFKC and strips zero-width, bidi and control characters. Page bodies are cached in memory to avoid redundant API calls during iterative editing sessions.

### update_page
Updates an existing page using optimistic concurrency control. The caller must provide the `version` number from their most recent `get_page` call. The server sends `version + 1` to the Confluence API. If the page has been modified since the caller's read (version mismatch), Confluence returns a 409 and the tool returns a `ConfluenceConflictError` instructing the agent to re-read the page. Both `title` and `version` are required; `body` is optional (omit to update only the title). Accepts GFM markdown or Confluence storage format (auto-detected). Markdown is converted via the token-aware write path, preserving existing macros and rich elements. Content-safety guards reject >50% body shrinkage (`confirm_shrinkage`), >50% heading loss (`confirm_structure_loss`), and near-empty replacement bodies. Creates or refreshes the "AI-edited" provenance badge on the page after a successful update. Configurable via the `unverifiedStatus` profile setting.

### update_page_section
Updates a single section of a page by heading name. The rest of the page is untouched. Fetches the full page body, replaces the content under the specified heading (case-insensitive match), and calls `update_page` with the reconstructed body. Exactly one of `body` and `find_replace` is given. Uses the same optimistic concurrency pattern as `update_page`. This reduces the blast radius of edits — untouched sections are never re-serialized. Creates or refreshes the "AI-edited" provenance badge on the page after a successful update. Configurable via the `unverifiedStatus` profile setting.

**`find_replace` mode.** `find_replace` is an array of `{find, replace, replace_all?}` pairs applied in order to the section's storage, with every macro and rich element replaced by an opaque `[[epi:Tnnnn]]` placeholder first, so text inside a macro is never matched. `find` is a literal string, not a regex; `replace` is storage syntax, not markdown. Rules (see [security/03-write-safety.md](security/03-write-safety.md)):

- Each `find` must match exactly once. No match fails with `FIND_REPLACE_MATCH_FAILED`; several matches fail with `FIND_REPLACE_AMBIGUOUS` and the count. A pair with `replace_all: true` opts in to several occurrences. Overlapping occurrences are rejected even then.
- If the exact bytes are not found, the engine retries on the same normalised view that reads use, so text copied from a fenced read (NBSP, `…`, `²`, zero-width characters) still matches. The result says when this happened, and unchanged text at the start and end of `find` keeps its stored bytes.
- A placeholder may not appear twice in the result (`DUPLICATED_TOKEN`) and may not be one the section does not contain (`FORGED_TOKEN`). Dropping a placeholder removes the macro and goes through the same `confirm_deletions` gate as body mode (elicitation, soft-confirmation token or `batch_token`).
- If the page's own text contains a literal `[[epi:` string, the edit is refused (`PLACEHOLDER_LITERAL_IN_PAGE`).
- `version: "current"` is refused when any find or replace string, or any body (`update_page`, `update_page_section`, `update_page_sections` entries), contains a placeholder (`PLACEHOLDER_NEEDS_PINNED_VERSION`): placeholder ids are positional, so pass the version from the read that showed them.

In `get_page` markdown section views, placeholder ids are numbered from the section body (the heading is excluded and rendered separately), so ids in the view match the ids `find_replace` and body mode use.

### update_page_sections
Applies edits to several sections of one page in a single PUT and a single new version. Each entry is `{section, body}` or `{section, find_replace}` (exactly one), with the same rules as `update_page_section`. The content-safety guards run once on the merged page, so several sections that are each under the shrinkage threshold cannot together remove most of the page. Deletion ids are section-qualified (`Section#T0001`) because ids restart in every section, and `confirm_deletions` covers the aggregate. Confirmation tokens are bound to the whole call (see [security/03-write-safety.md](security/03-write-safety.md)).

### authorise_destructive_writes
Mints a short-lived batch token that pre-authorises destructive writes on a named set of pages, so a parallel batch does not prompt once per call. It is a write tool: in the read-only posture it is not registered. It sets `requiresUserInteraction`, so a supporting client asks the user before it runs.

### delete_page
Deletes a page by ID. Returns confirmation text.

### search_pages
Searches using CQL (Confluence Query Language). Uses the v1 `/rest/api/search` endpoint (not `/content/search`) to include content excerpts in results. Example CQL: `space = "DEV" AND title ~ "architecture"`.

When the profile sets `read_spaces`, the query is wrapped as `(<cql>) AND space in (...)` before it is sent; `all_spaces: true` searches every space instead, unless the profile also sets `read_spaces_enforced`, in which case `all_spaces` is an error. `excerpts: false` returns titles only. Result titles and excerpts have the v1 highlight markers removed and, when the profile sets `redact_patterns`, matching text replaced with `[redacted]`. Each result is fenced as its own untrusted block (ID, Space, Title, Excerpt). See [security/04-input-validation.md](security/04-input-validation.md) for the CQL scoping rules and the redaction pipeline.

Since 7.1.0 the request expands `content.space` and `content.version`, and the client follows the `_links.next` cursor until `limit` hits are collected (the cap is 200; the default is 25). Only pages and blog posts are kept. The unfenced line per result is `- ID: 123, Space: DOCS, Modified: <ISO>, v14`; `Modified` and the version appear when known, and the timestamp outside the fence is re-rendered by the server from the parsed time (the later of `lastModified` and `version.when`), never copied from the response. The last editor's display name is tenant text, so it is shown inside the fence as `Last editor: …`. When more matches exist, the output ends with `More results exist. Raise limit or narrow the query.`

### get_recent_changes
Reports the pages and blog posts changed in a time window, in one call. Read-only; it never calls the write guard. Added in 7.1.0 (plan: `plans/recent-changes-report.md`).

Input: exactly one of `hours` (0 < h ≤ 720) or `since` (ISO 8601 with offset, in the past, at most 720 hours ago); `spaces`; `all_spaces` (default false); `include_blogposts` (default true); `detail` (`list`, `versions` or `summary`; default `list`); `limit` (1-200, default 50); `max_diffs` (1-25, default 10, `summary` only).

**Window.** CQL reads absolute dates in the Confluence user's profile timezone, so the server always sends a relative bound, `lastmodified >= now("-Nm")`, with 10 minutes of slack for clock skew, and then filters exactly on its own side against the requested start. Only hits inside the slack band are dropped; a hit CQL matched with an earlier time is kept and counted in the header (`matched with an earlier time (metadata change?)`). The clock is injected so tests can freeze it. The CQL is built by a pure function; space keys go through `escapeCqlString`.

**Scope.** It uses the same read scope as `search_pages`: `read_spaces` is the default, a `spaces` argument is intersected with it, and with `read_spaces_enforced` a space outside `read_spaces` or `all_spaces: true` is an error. `redact_patterns` applies to titles. These settings scope `search_pages` and `get_recent_changes`, not the other read tools.

**Detail levels and cost.** P is the number of pages reported and D is `min(P, max_diffs)`.

| `detail` | HTTP calls |
|---|---|
| `list` | One search request per result page (1 for most reports). The search expands version metadata, so no per-page calls are needed. |
| `versions` | `list` + P calls to `getPageVersions(id, 50)`. A pure summariser counts the in-window versions, lists the editors and finds the baseline version, or `new page` when version 1 is in the window. |
| `summary` | `versions` + at most 2D calls: the first `max_diffs` pages with a numeric baseline are diffed `baseline → current` with the existing body cache and `computeSummaryDiff`, then condensed to `Changed: <sections> (+a −r)`. |

Per-page work runs through `settleInChunks` and the process-wide semaphore (6 in flight). A page whose version fetch fails still gets a line (`versions unavailable (<status>)`), and the header counts these. A page that matched the CQL but has no version in the window is reported as `metadata change only (no new version)`. When all 50 fetched versions fall in the window, the count reads `≥50 edits`. Bodies over the diff size limit say `too large to diff`.

**Output.** Plain text. The header says `complete` or `showing N, more exist (...)`; a truncated report never says `complete`. Pages are grouped by space key, then newest first, and blog posts carry `[blog]` after the ID. Per page, the unfenced line holds the ID, version, time and change; one fence holds the title, editors and changed sections. A note says how many pages were listed without a diff because of `max_diffs`. The output ends with the tenant echo.

Out of scope: deleted or trashed pages, comment-only changes and attachment-only changes.

### list_pages
Lists pages in a space by space key. Supports filtering by status (default: "current") and limiting result count.

### get_page_children
Returns child pages of a given parent page ID.

### get_spaces
Lists available Confluence spaces. Supports filtering by type (`global`, `personal`) and limiting result count. Useful for discovering space keys before using other tools.

### get_page_by_title
Looks up a page by its exact title within a space. Returns the same formatted output as `get_page`. Useful when you know the page name but not its numeric ID. Supports the same `headings_only` drill-down pattern as `get_page`, and applies the same default `max_length` cap.

### add_attachment
Uploads a local file as an attachment to a Confluence page. Reads the file from the local filesystem and uploads via the v1 attachment API with `X-Atlassian-Token: nocheck` header. **Security:** The file path is resolved and validated to be under `process.cwd()` to prevent exfiltration of files outside the working directory.

### get_attachments
Lists attachments on a page with filename, ID, media type, and size.

### download_attachment
Fetches an attachment's bytes by attachment ID and writes them to a local file, returning the path. The bytes are never returned inline — attachments are routinely megabytes of binary, and base64 in a tool result would consume the agent's context for no benefit; the agent reads the saved file with its own file tools. Registered in every posture: it is a read against Confluence, so it is not gated by the write guard and does not consume write budget. Its annotations nonetheless say `readOnlyHint: false, destructiveHint: true` (7.0.0), because it writes, and with `overwrite: true` replaces, a local file; annotations are untrusted hints and the server-side rules below are what enforce safety. The asymmetry is deliberate — the tool writes to the *local* filesystem while the read-only posture governs the *remote* side. **Security:** `output_path` is resolved and validated to be under `process.cwd()`; when it is omitted the attachment's own (Confluence-controlled) filename is validated — no separators, no control characters, no `..`, no leading dot — and rejected rather than sanitised; any destination containing a `.`-prefixed path segment below the working directory (`.git`, `.claude`, `.github`, `.vscode`, dot-files) is refused, and files are never created executable (an overwrite clears any execute bits the old file had); the write opens with `O_NOFOLLOW | O_EXCL` so a symlink at the destination is not followed and an existing file is not clobbered unless `overwrite: true`; attachments above a 10 MB ceiling are refused before the body is fetched, with an error naming the actual size.

### add_drawio_diagram
All-in-one tool for adding draw.io diagrams. The LLM provides the diagram XML (mxGraph format) and the tool handles the entire workflow:
1. Writes the XML to a temp file
2. Uploads it as a `.drawio` attachment
3. Updates the page body with the draw.io macro
4. Cleans up the temp file

By default appends the diagram to existing page content (`append: true`). Set `append: false` to replace the page body entirely. Requires the draw.io app to be installed on the Confluence instance. Creates or refreshes the "AI-edited" provenance badge on the page after the diagram is embedded. Configurable via the `unverifiedStatus` profile setting.

### get_labels
Returns all labels on a page. Labels are returned as an array of strings. This is a read-only operation and does not require edit permissions.

### add_label
Adds one or more labels to a page. The `labels` parameter accepts either a single label name (string) or an array of label names. Labels are case-insensitive when matching existing labels, but the server preserves the case of the label as provided. This operation does not remove existing labels; it only adds new ones. Duplicate label additions are idempotent (duplicate additions have no effect). Requires edit permission on the page.

### remove_label
Removes a single label from a page. The `label` parameter is the name of the label to remove. Removal is case-insensitive. If the label is not present on the page, the operation succeeds silently (idempotent). Requires edit permission on the page.

### get_comments
Retrieves footer and/or inline comments on a page. Supports filtering by type (`footer`, `inline`, `all`) and resolution status (`open`, `resolved`, `all`). Optionally fetches reply threads for each top-level comment via `include_replies: true`. Reply fetches use `Promise.allSettled` — if a reply thread is inaccessible (403), the response includes partial results with a per-comment error entry and a summary note (`"Note: N of M reply fetches failed — partial results shown."`). Comment bodies are sanitized HTML.

### create_comment
Creates a footer or inline comment on a page. All comments are auto-prefixed with an attribution tag — `[AI-generated by {client} via Epimethian]` when the MCP client identity is available, or `[AI-generated via Epimethian]` otherwise. Footer comments appear at the bottom of the page; inline comments are anchored to a specific text selection. The `text_selection` parameter is required for top-level inline comments; `text_selection_match_index` disambiguates when the same text appears multiple times. Supports replies via `parent_comment_id`.

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
Fetches the content of a page at a specific historical version. Returns sanitized read-only markdown — macros are replaced with placeholders. This content is NOT suitable for round-trip updates via `update_page` (the conversion is lossy). To revert a page to a previous version, use `revert_page` instead. Historical version bodies are cached separately from current versions in the page cache (using composite keys).

### diff_page_versions
Compares two versions of a page. The `summary` format (default) uses section-aware diffing — it splits both versions by heading and reports added, removed, and modified sections with per-section change details. The `unified` format returns a standard unified diff. The `storage` format returns a unified diff of the normalised storage, so macro and attribute changes are visible. When the text is identical but the storage differs, the summary says `No text changes; N macro/attribute changes in: …`. Panel, info, note, warning, tip and expand bodies are rendered as block quotes in the markdown view, which also applies to `get_page_version` output. All formats support `max_length` truncation. Uses the `diff` npm package internally. Size-limited to 500 KB per version.

### prepend_to_page
Inserts content at the beginning of an existing page. The caller provides only the new content — the server fetches the existing body and handles concatenation. Content can be GFM markdown or Confluence storage format (auto-detected). An optional `separator` parameter controls the boundary between new and existing content (max 100 chars, no XML tags). Safer than `update_page` with `replace_body` for additive operations like adding banners or notices. Logs mutations and reports body-length changes. Creates or refreshes the "AI-edited" provenance badge on the page after a successful write. Configurable via the `unverifiedStatus` profile setting.

### append_to_page
Inserts content at the end of an existing page. Same interface and behavior as `prepend_to_page` but appends instead of prepends. Useful for adding appendices, changelog entries, or footnotes. Creates or refreshes the "AI-edited" provenance badge on the page after a successful write. Configurable via the `unverifiedStatus` profile setting.

### revert_page
Reverts a page to a previous version by fetching the exact storage-format body from the historical version and pushing it as a new version. This is a lossless revert — unlike reading `get_page_version` (which returns sanitized markdown) and passing it to `update_page`, this preserves all macros, formatting, and rich elements. Content-safety guards apply: shrinkage and structural integrity guards protect against reverting to an unexpectedly smaller version. Includes TOCTOU mitigation — verifies the page's actual version matches `current_version` before proceeding. Creates or refreshes the "AI-edited" provenance badge on the page after a successful revert. Configurable via the `unverifiedStatus` profile setting.

### lookup_user
Searches for Atlassian/Confluence users by name, display name, or email substring. Returns up to 10 matches with `accountId`, `displayName`, and `email`. Use this to resolve an `accountId` for the `:mention[Display]{accountId=...}` inline directive.

### resolve_page_link
Resolves a page title and space key to a stable `contentId` and URL. Useful for constructing `<ac:link>` page references without hardcoding page IDs.

### get_version
Returns the epimethian-mcp server version (e.g., `epimethian-mcp v5.2.0`). Takes no parameters. The version is injected at build time from `package.json` via esbuild's `define` and embedded in Confluence version messages, comment attribution, and this tool's output.

### check_permissions
Reports the permission and posture state for the active profile. Always registered, in every posture (read-only and read-write). Takes no parameters. The response is a JSON object with these fields:

```jsonc
{
  "profile": "<profile name>",
  "user": { "email": "…", "accountId": "…" },
  "posture": {
    "effective": "read-only" | "read-write",
    "configured": "read-only" | "read-write" | "detect",
    "source": "profile" | "probe" | "default"
  },
  "tokenCapability": {
    "authenticated": true,
    "listSpaces": true | false,
    "readPages": true | false,
    "writePages": true | false | "unknown",
    "addLabels": "unknown",
    "setContentState": "unknown",
    "addAttachments": "unknown",
    "addComments": "unknown"
  },
  "notes": [ /* human-readable strings explaining the config */ ]
}
```

`posture.configured` reflects the profile's `posture` setting (`"read-only"` | `"read-write"` | `"detect"`). `posture.source` is `"profile"` when the user pinned the posture, `"probe"` when auto-detected at startup, or `"default"` when the probe was inconclusive. `tokenCapability.writePages` reflects the probe result (`true`, `false`, or `"unknown"` when the probe was not run). Fine-grained capabilities (`addLabels`, etc.) are `"unknown"` in v1; Level 2a will populate them from a capability cache.

See [doc/design/14-api-permission-handling.md](14-api-permission-handling.md) for full details.
