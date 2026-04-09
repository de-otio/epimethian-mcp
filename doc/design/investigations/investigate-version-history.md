# Investigation: Page Version History / Diff

**STATUS: ⏳ PENDING** (Not yet implemented)

## Problem

No MCP server exposes Confluence page version history or diffing. Without it, an AI agent working on Confluence content is blind to what changed, when, and by whom — limiting it to snapshot-only workflows.

Example prompts that require version history:

- **Multi-page change audit:** "I was out all last week — summarize every change across the Project Alpha space since Monday, grouped by author." (Requires listing versions across many pages, filtering by date, and synthesizing a cross-page report — tedious and error-prone to do manually across dozens of pages.)
- **Change-aware editing:** "Update the SLA page to reflect our new response times, but first check if anyone has edited it since I drafted it on Tuesday — if so, show me what they changed so I don't overwrite their work." (The agent needs version awareness *before* it can safely write — without it, the agent either refuses to edit or risks clobbering recent changes.)
- **Regression detection:** "The API docs page has a wrong endpoint URL that I fixed last month — check if someone reverted or overwrote my fix, and if so, restore the correct version." (Requires diffing across multiple versions to find when the regression appeared and which version to restore.)
- **Review prep:** "For tomorrow's architecture review, pull up every change to the three design doc pages since the last review on March 15th, and draft a summary of what's new or contentious." (Agent combines version diffs with content understanding to produce a useful pre-meeting brief — something that would take 30+ minutes of manual Confluence UI navigation.)

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
| `by` / `authorId` | object/string | Full user object (v1) or account ID (v2). **Only expose `displayName` + `accountId` — strip email, avatar URL, and other user metadata.** |
| `when` / `createdAt` | ISO 8601 | When the version was saved |
| `message` | string | User-provided version comment (often empty) |
| `minorEdit` | boolean | True = minor edit |
| `collaborators` | object | (v1 with expand) Users who contributed via collaborative editing |

Not available from API: word count, change size, inline change annotations. Must be computed from body diff.

## Diffing Strategy

Since no diff API exists, the server must:

1. Fetch body of version A and version B (2 API calls, parallelizable)
2. **Reject if either body exceeds `MAX_DIFF_SIZE` (500KB)** — return an error indicating the page is too large to diff
3. Convert both bodies to sanitized plain text (strip HTML, replace macro content with placeholders — see below)
4. Diff the two sanitized text strings

**Critical: diffing always operates on sanitized text, never raw storage format.** Macro parameters can contain API keys, tokens, and credentials (common in `widget`, `html-include`, `code` macros). The text extraction must replace all macro content with placeholders like `[macro: code]`, consistent with the existing `toMarkdownView` pattern in `confluence-client.ts`.

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

- `diff` npm package (BSD, zero dependencies, ~50M weekly downloads) — for text diffing. Pin to a specific major version. Use `diffLines` / `structuredPatch`; avoid `diffWords` on large inputs (quadratic time complexity).
- `node-html-parser` (already a project dependency) — for parsing storage format XHTML to extract text by section. **Do not add `cheerio`** (larger dependency tree, unnecessary supply chain surface). **Do not use regex-based HTML stripping** — Confluence storage format contains namespaced XML (`ac:structured-macro`, `ac:parameter`, CDATA sections) that will cause ReDoS on maliciously crafted content and produce broken output.

## Rate Limiting / Performance

- **Listing versions is cheap** — metadata only, no body. Paginate at `limit=200` (v1 max).
- **Fetching bodies is expensive** — one API call per version. For a diff, that's 2 calls (parallelizable).
- **Recommendation:** List versions first (1 call), then fetch only the 2 versions being compared.
- **Payload size:** Storage format for content-heavy pages can be 100KB+. Macro markup adds bulk but images are referenced (not inline).
- **Confluence Cloud rate limits** are typically ~100 requests/minute for API tokens. An agent looping `diff_page_versions` across many pages (e.g., "diff every page in this space") could exhaust the quota quickly (2 API calls per diff). The implementation must handle `429 Retry-After` responses gracefully — add retry-after support to the HTTP helper rather than letting cascading 429s fail silently. Document the API call cost in each tool description so the AI agent can reason about it.

## Proposed Tools

### `get_page_versions`

```
Inputs:
  page_id: pageIdSchema (required)          — z.string().regex(/^\d+$/)
  limit: number (optional, default 25)      — z.number().int().min(1).max(200).default(25)

Output: list of versions with:
  number: int
  authorDisplayName: string
  authorId: string (opaque account ID — no email or avatar)
  when: ISO 8601
  message: string (truncated to 500 chars — treat as untrusted user content)
  minorEdit: boolean
```

Read-only. Lightweight — no body fetching. Costs 1 API call.

### `get_page_version`

```
Inputs:
  page_id: pageIdSchema (required)          — z.string().regex(/^\d+$/)
  version: number (required)                — z.number().int().min(1)
  format: "text" (Phase 1 — "storage" deferred, see Rollout Phases)

Output: full page content at that version
```

Read-only. Costs 1 API call. Cache fetched version bodies in the page cache (keyed by pageId + version number) to avoid redundant fetches when the agent diffs then reads the same version.

The `text` format converts storage XHTML to sanitized plain text: HTML tags stripped, macro content replaced with placeholders (reusing the `toMarkdownView` logic).

### `diff_page_versions`

```
Inputs:
  page_id: pageIdSchema (required)          — z.string().regex(/^\d+$/)
  from_version: number (required)           — z.number().int().min(1)
  to_version: number (optional)             — z.number().int().min(1), default: current version
  max_length: number (optional)             — max chars for unified diff output, consistent with get_page
  format: "summary" | "unified" (default: "summary")

Validation: when both provided, from_version < to_version.

Output:
  summary: "15 lines added, 8 removed. Changes in sections: Pricing, FAQ"
  changes: [
    { type: "modified", section: "Pricing", added: 5, removed: 3 },
    { type: "added", section: "FAQ" },
    { type: "removed", section: "Old Terms" }
  ]
  unified_diff: string (if format = "unified", truncated to max_length with [truncated] indicator)
```

Read-only. Costs 2 API calls (parallelizable). Always diffs sanitized text — macro content is replaced with placeholders before diffing to prevent credential leakage. The `summary` format is naturally bounded and most useful for AI agents.

### `restore_page_version` (Phase 2 — see Rollout Phases)

```
Inputs:
  page_id: pageIdSchema (required)          — z.string().regex(/^\d+$/)
  version: number (required)                — z.number().int().min(1)
  current_version: number (required)        — z.number().int().min(1), must match page's actual current version
  message: string (optional)                — z.string().max(255), default: "[AI-restored via Epimethian] Restored to version {N}"

Output: confirmation with new version number, page title, restored version number + tenant echo
```

Write operation — must call `writeGuard()` at handler entry. Uses `destructiveHint: true` in MCP annotations.

**Concurrency check:** Before executing the restore, fetch the page's actual current version and reject with `ConfluenceConflictError` if it does not match the `current_version` input. This forces the agent to have recently read the page on the correct tenant (implicit cross-tenant safety check) and prevents silent overwrites of intermediate edits.

**Attribution:** The version message is always prefixed with `[AI-restored via Epimethian]`, consistent with the `[AI-generated via Epimethian]` prefix on comments. The message input is validated to max 255 characters with control characters stripped.

**Implementation:** Use the v2 "manual restore" pattern (fetch old version body, then `PUT` with the body) rather than the v1 atomic restore endpoint. This gives the server a chance to inspect the content and log what is being written, at the cost of one extra API call. Version history is preserved either way.

## Rollout Phases

### Phase 1: Read-only tools, text format only

Ship `get_page_versions`, `get_page_version` (text format only), and `diff_page_versions`. This covers all four example use cases in the Problem section — multi-page audit, change-aware editing, regression detection, and review prep — with minimal risk surface:

- No write operations. No cross-tenant write risk.
- No raw storage format. Macro credentials are always sanitized.
- The only accepted risk is historical content exfiltration, which is inherent to the Confluence API and already present in `get_page`.

Add the three tools to `READ_ONLY_TOOLS`. Add `diff` as a dependency. Implement the text extraction utility (shared with `toMarkdownView`), the diffing module (`src/server/diff.ts`), and the page cache integration for historical version bodies.

### Phase 2: Restore

Add `restore_page_version` once real usage of the read-only tools confirms demand. The read-only tools will reveal whether users actually need programmatic restore or are fine restoring through the Confluence UI after the agent identifies the right version to restore.

Gate on: at least one real workflow where the agent identifies a version to restore and the user has to leave the MCP session to do it manually.

### Deferred: `storage` format on `get_page_version`

No example prompt in the Problem section requires raw XHTML. The `storage` format bypasses all macro-content sanitization and increases prompt injection surface. Defer until a concrete use case demands structural fidelity (e.g., restoring a specific section, debugging macro markup). When added, document it as a power-user escape hatch with explicit warnings.

## Competitive Landscape

No MCP server offers any version-aware tools. This is a clear differentiator. The combination of version listing + section-aware diffing + plain-language change summaries enables:
- AI-assisted content review ("what changed since I last looked?")
- Audit/compliance workflows (review changes across many pages)
- Safe rollback with agent confirmation

## Implementation Notes

- Use v1 API for version listing and body fetching — more mature, higher pagination limits. Use v2 manual restore pattern for `restore_page_version` (fetch body + PUT) to enable content inspection before writing.
- The diff computation should happen in a separate module (`src/server/diff.ts`) for testability.
- For the HTML-to-text conversion, reuse the `toMarkdownView` logic from `confluence-client.ts` (macro placeholder replacement, heading extraction). Factor into a shared utility if not already extracted. If `turndown` is added for markdown conversion (investigate-token-efficiency.md Phase 1), it can serve both purposes.
- Version listing should include the page title in the response header for context.
- **Read-only whitelist:** Add `get_page_versions`, `get_page_version`, and `diff_page_versions` to the `READ_ONLY_TOOLS` set in `src/server/index.ts`. Do NOT add `restore_page_version` — it is a write operation and must be blocked in read-only mode by default.
- **Caching:** Store fetched historical version bodies in the existing page cache (keyed by pageId + version number). This avoids redundant API calls when the agent diffs two versions and then reads one of them.
- **Error handling:** Use `toolError()` + `sanitizeError()` for all error paths. Do not distinguish "page not found" from "permission denied" — return a generic "Page not found or inaccessible" to avoid leaking page existence. For version-not-found, return "Version N does not exist" (requires knowing the latest version number, available from the version list). Catch diff computation failures generically — do not expose page content in error messages.
- **Response schemas:** Define Zod schemas for version metadata responses that allowlist specific fields (number, displayName, accountId, when, message, minorEdit). Do not pass through raw v1 user objects — they may contain email addresses.

## Security Considerations

### Cross-tenant safety (restore)

`restore_page_version` is the highest-risk tool in this set. A restore executed on the wrong tenant silently overwrites a page with old content. Mitigations:

- **Mandatory `current_version` parameter** — the agent must supply the version it believes is current. The server rejects the request if it doesn't match. **This is a concurrency guard, not a tenant guard.** If the same page ID exists on two tenants and both happen to be at the same version number, the check passes on the wrong tenant. Cross-tenant safety ultimately rests on the profile system and write locks — `current_version` adds a layer that makes accidental wrong-tenant restores less likely (the agent must have recently read *some* version of the page) but does not prevent them.
- **v2 manual restore** — fetching the old body and writing it via PUT (rather than the v1 atomic restore) means the server sees the content before writing. The implementation should log the page ID, tenant hostname, old version number, and new version number. This is observability for post-incident investigation, not pre-write validation — there is no automated content policy check.
- **Attribution** — the version message is always prefixed with `[AI-restored via Epimethian]` so restores are identifiable in Confluence's version history.

### Historical version content exfiltration

**Accepted risk.** Old versions may contain credentials, PII, or content that was deliberately deleted. Confluence grants access to all historical versions if the user can read the current page — this is a Confluence API design choice, not a bug, and the MCP server cannot restrict access below what the API token permits.

The MCP server amplifies the risk by making historical content programmatically accessible to an AI agent that may be operating under prompt injection:

- A prompt injection in any readable page could instruct the agent to fetch old versions and include their contents in a response, exfiltrating content that was intentionally removed.
- The `text` format mitigates macro credential leakage (macro parameters are replaced with placeholders) but does not prevent exfiltration of plain-text content that appeared in old versions.

No technical mitigation is available at the MCP server layer — the API token has the access, and the server passes it through. The tool description for `get_page_version` should note this risk so the user can make an informed decision about which profiles to enable it on.

### Prompt injection via version metadata

**Partially mitigated — defense in depth, not prevention.** Version messages returned by `get_page_versions` are user-generated content from Confluence. They are untrusted and could contain prompt injection text designed to influence the agent's subsequent behavior. A prompt injection payload fits easily in a single version message.

Server-side mitigations reduce attack surface but do not prevent injection:
- Truncate version messages in the output (500 chars) to limit payload size for multi-stage injection.
- Treat version messages as opaque strings in tool descriptions — do not instruct the agent to interpret or act on them.

**The primary mitigation is client-side.** MCP clients must treat all tool response content as untrusted user data. This is not specific to version history — it applies to all tools that return Confluence content. The MCP server cannot solve prompt injection; it can only avoid amplifying it.

For the `restore_page_version` message input: validate and truncate (max 255 chars), strip control characters, and always prepend the `[AI-restored via Epimethian]` prefix regardless of user-supplied content.

### HTML parsing safety

Confluence storage format is user-controlled content. The text extraction step (for `get_page_version` text format and `diff_page_versions`) must be resilient to malicious input:

- **Use `node-html-parser` only** — it is already a dependency. Regex-based HTML stripping is a ReDoS vector on deeply nested or pathological markup. Do not add `cheerio` (unnecessary supply chain surface).
- **Body size limit** — reject pages exceeding `MAX_DIFF_SIZE` (500KB) before parsing. Two large pages parsed simultaneously for a diff could consume significant memory.
- **Macro content** — replace all `ac:structured-macro` content with placeholders (e.g., `[macro: code]`). Macro parameters (`ac:parameter`) frequently contain API keys, tokens, and URLs. Reuse the existing `toMarkdownView` replacement logic.

### Reconnaissance via version metadata

Version metadata is lightweight and cheap to fetch (no body). Combined with `list_pages` or `search_pages`, an agent could enumerate all pages in a space and fetch 200 versions of metadata per page, building a complete activity timeline (who edited what, when, with what commit messages). Version messages often contain sensitive context ("removed client pricing from public page," "reverted Bob's accidental publish").

This is inherent to the Confluence API — the MCP server cannot restrict it beyond what the token's permissions allow. The default limit of 25 (rather than the API max of 200) reduces casual over-fetching.

### Input validation summary

All four tools must validate inputs consistently:

| Parameter | Schema |
|-----------|--------|
| `page_id` | `pageIdSchema` — `z.string().regex(/^\d+$/)` |
| `version`, `from_version`, `to_version`, `current_version` | `z.number().int().min(1)` |
| `limit` | `z.number().int().min(1).max(200).default(25)` |
| `message` | `z.string().max(255)`, strip control characters |
| `from_version` < `to_version` | Validate when both provided |

## Resolved Questions

1. **Should `diff_page_versions` default to comparing against the current version when only `from_version` is provided?** → **Yes.** "What changed since version N?" is the most natural question. Make `to_version` optional, defaulting to the current (latest) version. This covers the dominant use case without requiring the caller to look up the latest version number first.

2. **Should `get_page_versions` include a "changes since date" filter?** → **No.** The version list already includes timestamps. The AI agent can read the list and identify the right version itself. Adding date-based filtering adds API complexity for minimal benefit — keep the tool simple and let the model reason over the output.

3. **Is `restore_page_version` too dangerous to expose, or is the write lock sufficient?** → **Write lock plus concurrency check.** `restore_page_version` is a write operation, so it's automatically blocked by the `READ_ONLY_TOOLS` whitelist in read-only mode. For writable profiles, additional safeguards are required beyond the write guard: (a) `current_version` is mandatory — forces the agent to have recently read the page, serving as an implicit tenant cross-check; (b) `destructiveHint: true` in MCP annotations so clients can add confirmation prompts; (c) attribution prefix `[AI-restored via Epimethian]` on the version message for audit trails; (d) v2 manual restore pattern to allow content inspection before writing.

4. **Should the diff tool support cross-page comparison?** → **No — defer.** Cross-page diff is a different use case (content deduplication, template divergence) with different UX. It doesn't belong in a version-history tool. If needed later, it's a separate tool with a separate investigation.
