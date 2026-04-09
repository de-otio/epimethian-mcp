# Investigation: Page Version History / Diff

## Problem

No MCP server exposes Confluence page version history or diffing. This is a significant gap for AI-assisted content review workflows:
- "What changed on this page since last week?"
- "Who edited the architecture doc and what did they change?"
- "Roll back the pricing page to before yesterday's edit"

These are common consultant workflows that currently require manual Confluence UI interaction.

## API Endpoints

### List Versions

**V1:** `GET /wiki/rest/api/content/{pageId}/version`
- Query params: `start` (default 0), `limit` (default 25, max 200), `expand`
- Returns: array of version metadata (number, author, date, message, minorEdit)

**V2:** `GET /wiki/api/v2/pages/{pageId}/versions`
- Query params: `cursor`, `limit` (max 50), `sort`, `body-format`
- Cursor-based pagination

### Get Specific Version Metadata

**V1:** `GET /wiki/rest/api/content/{pageId}/version/{versionNumber}`

**V2:** `GET /wiki/api/v2/pages/{pageId}/versions/{versionNumber}`

### Get Page Body at Historical Version

**V1 (critical endpoint):**
```
GET /wiki/rest/api/content/{pageId}?version={N}&expand=body.storage,version
```

Returns the complete page body in storage format (XHTML) for any historical version.

**V2:**
```
GET /wiki/api/v2/pages/{pageId}?version={N}&body-format=storage
```

### Restore a Version

**V1 (dedicated restore):**
```
POST /wiki/rest/api/content/{pageId}/version
{
  "operationKey": "restore",
  "params": { "versionNumber": 12 },
  "message": "Restored to version 12"
}
```

Creates a new version whose body matches the specified old version. Version history is preserved.

**V2 (manual restore):** Fetch old version body, then `PUT /wiki/api/v2/pages/{pageId}` with that body and incremented version number.

### Diff

**There is no native diff endpoint in the Confluence Cloud REST API.**

Confluence's web UI generates diffs client-side. The MCP server must implement diffing server-side.

## Version Metadata Per Entry

| Field | Type | Notes |
|-------|------|-------|
| `number` | int | Sequential (1, 2, 3, ...) |
| `by` / `authorId` | object/string | Full user object (v1) or account ID (v2) |
| `when` / `createdAt` | ISO 8601 | When the version was saved |
| `message` | string | User-provided version comment (often empty) |
| `minorEdit` | boolean | True = minor edit |
| `collaborators` | object | (v1 with expand) Users who contributed via collaborative editing |

Not available from API: word count, change size, inline change annotations. Must be computed from body diff.

## Diffing Strategy

Since no diff API exists, the server must:

1. Fetch body of version A and version B (2 API calls, parallelizable)
2. Diff the two `body.storage.value` strings

### Approaches

| Approach | Pros | Cons |
|----------|------|------|
| Text diff on raw storage XML | Simple, uses standard diff libs | Noisy — XML tag changes obscure content changes |
| Strip HTML to plain text, then diff | Clean, readable for AI agents | Loses structural info (tables, macros) |
| DOM-aware diff | Semantically accurate | More complex, heavier dependency |
| **Hybrid: plain-text diff + change summary** | Best of both | Two-pass implementation |

### Recommended: Hybrid approach

1. Convert storage format XHTML to plain text (strip tags, preserving heading hierarchy)
2. Split text by headings into sections
3. Diff each section independently using a standard text diff library
4. Return a structured summary ("Section X: 5 lines added, 2 removed") plus optional unified diff

This gives AI agents the most actionable output — they can answer "what changed?" without parsing diff syntax.

### Dependencies

- `diff` npm package (BSD, mature) — for text diffing
- `cheerio` or `node-html-parser` — for parsing storage format XHTML to extract text by section
- Alternatively, a simple regex-based HTML stripper could avoid the cheerio dependency for basic cases

## Rate Limiting / Performance

- **Listing versions is cheap** — metadata only, no body. Paginate at `limit=200` (v1 max).
- **Fetching bodies is expensive** — one API call per version. For a diff, that's 2 calls (parallelizable).
- **Recommendation:** List versions first (1 call), then fetch only the 2 versions being compared.
- **Payload size:** Storage format for content-heavy pages can be 100KB+. Macro markup adds bulk but images are referenced (not inline).

## Proposed Tools

### `get_page_versions`

```
Inputs:
  page_id: string (required)
  limit: number (optional, default 25, max 200)

Output: list of versions with number, author, date, message, minorEdit
```

Read-only. Lightweight — no body fetching.

### `get_page_version`

```
Inputs:
  page_id: string (required)
  version: number (required)
  format: "storage" | "text" (default: "text")

Output: full page content at that version
```

Read-only. The `text` format strips HTML for readability and token efficiency. `storage` preserves full fidelity.

### `diff_page_versions`

```
Inputs:
  page_id: string (required)
  from_version: number (required)
  to_version: number (required)
  format: "summary" | "unified" (default: "summary")

Output:
  summary: "15 lines added, 8 removed. Changes in sections: Pricing, FAQ"
  changes: [
    { type: "modified", section: "Pricing", added: 5, removed: 3 },
    { type: "added", section: "FAQ" },
    { type: "removed", section: "Old Terms" }
  ]
  unified_diff: string (if format = "unified")
```

Read-only. The `summary` format is most useful for AI agents — answers "what changed?" in a token-efficient way.

### `restore_page_version`

```
Inputs:
  page_id: string (required)
  version: number (required)
  message: string (optional, default: "Restored to version {N}")

Output: confirmation with new version number + tenant echo
```

Write operation — must respect write locks. Uses the v1 restore endpoint (creates a new version, preserves history).

## Competitive Landscape

No MCP server offers any version-aware tools. This is a clear differentiator. The combination of version listing + section-aware diffing + plain-language change summaries enables:
- AI-assisted content review ("what changed since I last looked?")
- Audit/compliance workflows (review changes across many pages)
- Safe rollback with agent confirmation

## Implementation Notes

- Use v1 API for version operations — more mature, higher pagination limits, dedicated restore endpoint.
- The diff computation should happen in a separate module (`src/server/diff.ts`) for testability.
- For the HTML-to-text conversion, consider reusing the same logic as the token efficiency feature (investigate-token-efficiency.md Phase 1). If `turndown` is added for markdown conversion, it can serve both purposes.
- Version listing should include the page title in the response header for context.

## Open Questions

1. Should `diff_page_versions` default to comparing against the current version when only `from_version` is provided?
2. Should `get_page_versions` include a "changes since date" filter (find the version closest to a given date)?
3. Is `restore_page_version` too dangerous to expose by default, or is the write lock sufficient protection?
4. Should the diff tool support comparing across pages (e.g., "what's different between these two pages")? This would be a separate tool.
