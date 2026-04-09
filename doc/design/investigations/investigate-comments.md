# Investigation: Comments (Inline + Footer)

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
  "body": { "representation": "storage", "value": "<current body>" },
  "resolved": true
}
```

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
  page_id: string (required)
  type: "footer" | "inline" | "all" (default: "all")
  resolution_status: "open" | "resolved" | "all" (default: "all", inline only)
  include_replies: boolean (default: false)

Output: formatted list of comments with author, date, body, resolution status
```

Implementation: call the appropriate v2 list endpoint. If `include_replies`, make additional calls to `/children` for each top-level comment. For `type: "all"`, make both calls in parallel.

### `create_comment`

```
Inputs:
  page_id: string (required)
  body: string (required) — plain text or storage format
  type: "footer" | "inline" (default: "footer")
  parent_comment_id: string (optional — for replies)
  text_selection: string (optional — required for inline, ignored for footer)
  text_selection_match_index: number (optional, default: 0)
  text_selection_match_count: number (optional, default: 1)

Output: created comment ID + tenant echo
```

Write operation — must respect write locks.

### `resolve_comment`

```
Inputs:
  comment_id: string (required)
  resolved: boolean (default: true) — false to reopen

Output: confirmation + tenant echo
```

Implementation: GET the comment to get current version, then PUT with `resolved` flag and version + 1. Write operation.

### `delete_comment`

```
Inputs:
  comment_id: string (required)

Output: confirmation + tenant echo
```

Write operation. Consider requiring the comment type (footer/inline) or auto-detecting by trying both endpoints.

## Gotchas

1. **Inline comment text selection** — the LLM must know the exact text and occurrence index. This is fragile. Consider: have the LLM read the page body first, find the text, count occurrences, then create the comment. Tool description should guide this workflow.

2. **Dangling comments** — inline comments become dangling when highlighted text is edited away. Cannot be updated or resolved. Tools should handle this gracefully (detect `dangling` status before attempting update).

3. **Body not returned by default** — must pass `?body-format=storage` to include comment body in responses.

4. **Version tracking for updates** — like pages, updating a comment requires version + 1. Follow the same optimistic concurrency pattern as `update_page`.

5. **Known bug** — filtering by `resolution-status=open` may still return resolved comments. Handle defensively.

## Implementation Notes

- Use v2 API exclusively for comments (v1 is being deprecated for endpoints with v2 equivalents)
- Comment body supports `storage`, `atlas_doc_format`, and `wiki` representations for writing. Use `storage` for consistency with the rest of the server.
- The existing `toStorageFormat()` helper can convert plain text to `<p>` tags for comment bodies.
- Add Zod schemas for comment response validation.
- All write comment tools must include tenant echo and respect write locks.

## Open Questions

1. Should `get_comments` default to including or excluding replies? Including replies adds API calls but gives complete context.
2. Should inline comment creation auto-detect `textSelectionMatchCount` by reading the page body, or require the caller to provide it?
3. Is `delete_comment` worth exposing, or is it too destructive for the consultant use case?
