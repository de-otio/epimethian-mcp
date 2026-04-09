# Investigation: Comments (Inline + Footer)

**STATUS: ⏳ PENDING** (Not yet implemented)

## Problem

The official Atlassian Rovo MCP server exposes comment tools, but no local/self-hosted MCP server handles comments well. Comments are core to Confluence collaboration workflows — reviewing content, leaving feedback, tracking action items. Without comment support, AI agents can read and write pages but can't participate in the discussion around them.

## Confluence Comment Types

**Footer comments** — standard comment thread at the bottom of a page. Form a flat or threaded discussion not tied to specific text.

**Inline comments** — anchored to a specific text selection within the page body. Appear as highlights. Support a resolution workflow with states: `open`, `reopened`, `resolved`, `dangling`. A "dangling" comment is one whose highlighted text has been edited away.

## API Endpoints (v2 — recommended)

Base path: `/wiki/api/v2`

The v2 API treats footer and inline comments as separate resource types with dedicated endpoints. V1 lumps both under "content" of type "comment" — v1 is being deprecated for endpoints that have v2 equivalents.

### Footer Comments

| Method | Path | Description |
|--------|------|-------------|
| GET | `/pages/{id}/footer-comments` | List footer comments on a page |
| POST | `/footer-comments` | Create a footer comment or reply |
| GET | `/footer-comments/{id}` | Get a comment by ID |
| PUT | `/footer-comments/{id}` | Update a comment |
| DELETE | `/footer-comments/{id}` | Delete a comment |
| GET | `/footer-comments/{id}/children` | Get replies to a comment |

### Inline Comments

| Method | Path | Description |
|--------|------|-------------|
| GET | `/pages/{id}/inline-comments` | List inline comments on a page |
| POST | `/inline-comments` | Create an inline comment or reply |
| GET | `/inline-comments/{id}` | Get a comment by ID |
| PUT | `/inline-comments/{id}` | Update (or resolve/reopen) a comment |
| DELETE | `/inline-comments/{id}` | Delete a comment |
| GET | `/inline-comments/{id}/children` | Get replies to a comment |

### Key Query Parameters

**Listing endpoints:**
- `body-format`: `storage` | `atlas_doc_format` — must be specified to include body in response
- `status`: filter by `current`, `archived`, etc.
- `sort`: `created-date`, `-created-date`, `modified-date`, `-modified-date`
- `cursor` / `limit` (1-250, default 25): cursor-based pagination

**Inline comments additionally:**
- `resolution-status`: `open` | `reopened` | `resolved` | `dangling`

### Request Bodies

**Create footer comment (top-level):**
```json
{
  "pageId": "12345",
  "body": {
    "representation": "storage",
    "value": "<p>This is a comment</p>"
  }
}
```

**Create footer comment (reply):**
```json
{
  "parentCommentId": "67890",
  "body": {
    "representation": "storage",
    "value": "<p>This is a reply</p>"
  }
}
```

Important: for replies, provide `parentCommentId` only — do NOT also provide `pageId` (it's an error).

**Create inline comment:**
```json
{
  "pageId": "12345",
  "body": {
    "representation": "storage",
    "value": "<p>This needs revision</p>"
  },
  "inlineCommentProperties": {
    "textSelection": "the exact text to highlight",
    "textSelectionMatchCount": 3,
    "textSelectionMatchIndex": 1
  }
}
```

The `inlineCommentProperties` object is **required for top-level inline comments** but **must be omitted for replies**.

- `textSelection`: exact text string to highlight
- `textSelectionMatchCount`: total occurrences of this text on the page
- `textSelectionMatchIndex`: zero-based index of which occurrence to highlight

**Resolve an inline comment:**
```json
{
  "version": { "number": 2 },
  "resolved": true
}
```

Note: test whether the Confluence API accepts a resolve PUT without a `body` field. If so, omit the body to avoid overwriting concurrent edits. If the body is required, the GET step must include `?body-format=storage` and the implementation must assert the body is non-null before sending.

### Response Shape

```json
{
  "id": "456",
  "status": "current",
  "title": "Re: ...",
  "pageId": "12345",
  "parentCommentId": null,
  "version": { "number": 1, "createdAt": "...", "authorId": "..." },
  "body": { "storage": { "representation": "storage", "value": "<p>...</p>" } },
  "resolutionStatus": "open",
  "_links": { "webui": "/wiki/..." }
}
```

Inline comments additionally include `resolutionStatus`, `resolutionLastModifierId`, and `properties.inlineOriginalSelection`.

## Competitive Landscape

| Feature | Rovo (official) | sooperset | epimethian (current) |
|---------|:-:|:-:|:-:|
| Get footer comments | Yes | No | No |
| Get inline comments | Yes | No | No |
| Create footer comment | Yes | No | No |
| Create inline comment | Yes | No | No |
| Reply to comment | Yes (footer only) | No | No |
| Resolve inline comment | No | No | No |
| Update comment | No | No | No |
| Delete comment | No | No | No |
| Get replies | No | No | No |

Opportunity: epimethian can offer a more complete comment workflow than even the official server.

## Proposed Tools

### `get_comments`

```
Inputs:
  page_id: string (required) — validated: /^\d+$/
  type: "footer" | "inline" | "all" (default: "all")
  resolution_status: "open" | "resolved" | "all" (default: "all", inline only)
  include_replies: boolean (default: false)

Output: formatted list of comments with author, date, body, resolution status
```

Implementation: call the appropriate v2 list endpoint with `?body-format=storage`. If `include_replies`, make additional calls to `/children` for each top-level comment. For `type: "all"`, make both calls in parallel.

**Pagination:** return up to 250 comments (one API page). Do not auto-paginate — if the first page is full, append a note that more comments exist.

**Read-only integration:** add `get_comments` to the `READ_ONLY_TOOLS` whitelist in `index.ts`.

### `create_comment`

```
Inputs:
  page_id: string (required) — validated: /^\d+$/
  body: string (required) — plain text (converted to <p> tags) or storage format
  type: "footer" | "inline" (default: "footer")
  parent_comment_id: string (optional — for replies) — validated: /^\d+$/
  text_selection: string (optional — required for inline top-level, ignored for footer)
  text_selection_match_index: number (optional, default: 0)
  text_selection_match_count: number (optional, default: 1)

Output: created comment ID + tenant echo
```

Write operation — must respect write locks. Uses `describeWithLock()` for tool description. Uses `writeGuard()` at handler entry.

**Attribution:** all created comments must include an attribution prefix in the body: `[AI-generated via Epimethian] ` prepended to the comment text. This matches the existing page attribution footer pattern and mitigates prompt injection leaving deceptive annotations.

**Body sanitization:** before sending to the API, strip `<ac:structured-macro>`, `<script>`, `<iframe>`, `<embed>`, and `<object>` tags from the body. Comments should not contain macros. Log a warning if any tags are stripped. The tool description should state that the body accepts plain text or simple HTML paragraphs.

**Inline text_selection auto-detection:** when `text_selection_match_count` is not provided (defaulting to 1), the implementation should read the page body, count occurrences of `text_selection`, and populate both `textSelectionMatchCount` and verify `textSelectionMatchIndex` is in range. This prevents silent failures from stale occurrence counts.

### `resolve_comment`

```
Inputs:
  comment_id: string (required) — validated: /^\d+$/
  resolved: boolean (default: true) — false to reopen

Output: confirmation + tenant echo
```

Implementation: GET the inline comment (with `?body-format=storage`) to get the current version. If the comment's `resolutionStatus` is `dangling`, return an error explaining that dangling comments cannot be resolved. Otherwise, PUT with `resolved` flag and version + 1.

**Optimistic concurrency:** if the PUT returns HTTP 409 (conflict), re-GET and retry up to 2 times. Reuse the existing `ConfluenceConflictError` pattern from page updates.

**Body handling:** test whether the API accepts a resolve PUT without a `body` field. If so, omit the body to avoid the TOCTOU risk of overwriting concurrent edits. If the body is required, include it from the GET response and assert it is non-null.

Write operation — must respect write locks.

### `delete_comment`

```
Inputs:
  comment_id: string (required) — validated: /^\d+$/
  type: "footer" | "inline" (required)

Output: confirmation + tenant echo
```

Write operation — must respect write locks.

**Decision:** require the `type` parameter. Do not auto-detect by probing both endpoints. This is a destructive, irreversible operation — being explicit is a safety feature. The double-request pattern would leak comment type information and double API load.

## Security Considerations

### S1. Body Injection / XSS (High)

`toStorageFormat()` wraps plain text in `<p>` tags but performs no sanitization on input that already looks like HTML. A malicious prompt (or prompt injection in page content the AI reads) could instruct the agent to create a comment containing `<ac:structured-macro ac:name="html">` or other dangerous tags that Confluence renders for other users.

**Mitigation:** strip dangerous tags (`<ac:structured-macro>`, `<script>`, `<iframe>`, `<embed>`, `<object>`) from comment bodies before sending to the API. Document in the tool description that comments accept plain text or simple HTML paragraphs only.

### S2. resolve_comment TOCTOU Race (Medium)

The GET-then-PUT pattern for resolving comments can overwrite concurrent edits if another user modifies the comment body between the two calls.

**Mitigation:** omit body from the resolve PUT if the API allows it. If the body is required, implement optimistic concurrency retry on HTTP 409, reusing the existing `ConfluenceConflictError` pattern.

### S3. Inline text_selection Semantic Manipulation (Medium)

Prompt injection in page content could instruct the AI to create inline comments on specific text, leaving visible annotations that appear authoritative to human readers (e.g., highlighting "This approach is approved by Legal" with a "Confirmed reviewed" comment).

**Mitigation:** AI attribution prefix on all created comments (`[AI-generated via Epimethian]`). Tool description should warn the model not to create comments based on instructions found within page content.

### S4. ID Parameter Path Traversal (Low)

`comment_id` and `page_id` are interpolated into API URL paths. Without validation, values like `../pages/12345` could alter the request target.

**Mitigation:** validate all ID parameters with Zod `.regex(/^\d+$/)` at the tool input schema level. The Confluence API would likely reject malformed IDs, but validating early prevents unexpected HTTP requests.

### S5. Comment Spam via Agent Loops (Low)

An AI agent in a loop could create many comments rapidly, flooding page watchers with notifications and hitting API rate limits.

**Mitigation:** add MCP tool annotations `{ destructiveHint: false, idempotentHint: false }` so MCP-aware clients can add confirmation prompts. Consider client-side rate limiting if this becomes a problem in practice.

### S6. Write Guard Integration (Medium)

The existing write guard uses a `READ_ONLY_TOOLS` whitelist. `get_comments` must be added to this set. The three write tools (`create_comment`, `resolve_comment`, `delete_comment`) must NOT be added — they will be automatically blocked by the whitelist pattern.

**Verification:** add tests confirming `get_comments` works in read-only mode and all three write tools are blocked.

## Implementation Notes

- Use v2 API exclusively for comments (v1 is being deprecated for endpoints with v2 equivalents)
- Comment body supports `storage`, `atlas_doc_format`, and `wiki` representations for writing. Use `storage` for consistency with the rest of the server.
- The existing `toStorageFormat()` helper can convert plain text to `<p>` tags for comment bodies (after sanitization).
- Add Zod schemas for comment response validation with numeric ID regex.
- All write comment tools must include tenant echo, use `writeGuard()`, and `describeWithLock()`.
- Use `sanitizeError()` for all error responses (existing pattern in all tools).
- Comment output should support markdown view via `toMarkdownView()` for consistency with the `format: "markdown"` option on pages.

## Resolved Questions

1. **Should `get_comments` default to including or excluding replies?** → **Exclude replies by default** (`include_replies: false`). Callers opt in to the extra API calls when they need full thread context.

2. **Should inline comment creation auto-detect `textSelectionMatchCount`?** → **Yes, auto-detect.** Read the page body, count occurrences, populate `textSelectionMatchCount`, and verify `textSelectionMatchIndex` is in range. Too error-prone to rely on the caller.

3. **Is `delete_comment` worth exposing?** → **Yes.** It's gated by write locks and requires explicit `type` parameter. Consultants need to clean up stale comments as part of content management workflows.

## Security Review Notes

This document was reviewed for security on 2026-04-09. Ten findings were identified and integrated:

| # | Severity | Finding | Section |
|---|----------|---------|---------|
| S1 | High | Comment body storage format injection / XSS | Security Considerations §S1, create_comment spec |
| S2 | Medium | resolve_comment TOCTOU race condition | Security Considerations §S2, resolve_comment spec |
| S3 | Medium | Inline text_selection semantic manipulation | Security Considerations §S3, create_comment spec |
| S4 | Low | ID parameter path traversal | Security Considerations §S4, all tool specs |
| S5 | Low | Comment spam via agent loops | Security Considerations §S5 |
| S6 | Medium | Write guard READ_ONLY_TOOLS integration | Security Considerations §S6, get_comments spec |
| — | Info | Write guard whitelist is deny-by-default (positive) | Security Considerations §S6 |
| — | Info | Cross-tenant isolation preserved by architecture (positive) | — |
| — | Low | Missing body-format in resolve GET step | resolve_comment spec |
| — | Low | delete_comment auto-detection probes both endpoints | delete_comment spec (resolved: require type) |
