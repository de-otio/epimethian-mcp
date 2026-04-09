# Implementation Plan: Token-Efficient Output Mode

**Source:** [investigate-token-efficiency.md](../investigations/investigate-token-efficiency.md)
**Coverage target:** 80% (lines, branches, functions, statements) — enforced by vitest threshold on `src/server/**`

## Current State

- `headings_only` parameter: **implemented** on `get_page` and `get_page_by_title`
- `extractHeadings()`: **implemented** with regex extraction
- `formatPage()`: **implemented** with `FormatPageOptions` overload
- Tests: 8 new tests (4 `formatPage` headings, 4 `extractHeadings`)

## Phase 1: Content Windowing (section + max_length)

**Depends on:** nothing (headings_only already done)
**New dependency:** `node-html-parser` (MIT, no native deps)

### 1.1 Add `node-html-parser` dependency

```bash
npm install node-html-parser
```

### 1.2 Implement `extractSection(storageHtml, headingText)` in `confluence-client.ts`

**File:** `src/server/confluence-client.ts`
**Export:** `extractSection`

Behavior:
- Parse the storage format HTML with `node-html-parser`
- Find the first heading (`<h1>`–`<h6>`) whose text content matches `headingText` (case-insensitive)
- Collect all sibling elements after that heading until the next heading of equal or higher level (or end of document)
- Return the original storage format HTML for the heading + its content (preserving macros, layouts, etc.)
- If no matching heading found, return an error string: `Section "${headingText}" not found. Use headings_only to see available sections.`

Key constraints:
- Must preserve `<ac:structured-macro>`, `<ac:layout>`, and all Confluence-specific elements verbatim
- Must handle headings inside macros correctly — only match top-level headings (not headings inside `<ac:rich-text-body>` or `<ac:structured-macro>`)
- Return value is valid storage format that can be passed to `update_page`

**Tests** (`confluence-client.test.ts`):
1. Extracts correct section from multi-section document
2. Includes content up to next heading of same or higher level
3. Includes content through end of document when section is last
4. Preserves `<ac:structured-macro>` blocks within the section
5. Case-insensitive heading match
6. Returns error message for non-existent section
7. Handles nested headings (h2 section includes h3 subsections)
8. Does not match headings inside `<ac:structured-macro>` bodies

### 1.3 Implement `truncateStorageFormat(storageHtml, maxLength)` in `confluence-client.ts`

**File:** `src/server/confluence-client.ts`
**Export:** `truncateStorageFormat`

Behavior:
- If `storageHtml.length <= maxLength`, return it unchanged
- Otherwise, truncate at the nearest element boundary (closing tag) before `maxLength`
- Append: `\n\n[truncated at ${truncatedLength} of ${totalLength} characters]`

Key constraints:
- Never split a tag mid-element (no broken HTML)
- If the first element exceeds `maxLength`, truncate after it anyway (don't return empty)

**Tests** (`confluence-client.test.ts`):
1. Returns unchanged when content is shorter than maxLength
2. Truncates at element boundary
3. Appends truncation marker with correct lengths
4. Does not split mid-tag
5. Handles content with no HTML tags (plain text truncation)
6. Handles single large element gracefully

### 1.4 Add `section` and `max_length` parameters to `get_page` tool

**File:** `src/server/index.ts`

Add to `get_page` inputSchema:
- `section: z.string().optional().describe("Return only the content under this heading (case-insensitive). Use headings_only first to see available sections.")`
- `max_length: z.number().optional().describe("Truncate the page body after this many characters.")`

Handler logic:
- If `section` is set, call `extractSection()` on the body. The returned content is storage format.
- If `max_length` is set (and `section` is not), call `truncateStorageFormat()` on the body.
- `section` takes precedence over `max_length`. If both are set, extract the section first, then truncate if still over limit.
- `headings_only` takes precedence over both `section` and `max_length`.
- When `section` or `max_length` is used, the API call must include `body-format=storage` (same as `include_body: true`).

Update tool description:
```
"Read a Confluence page by ID. For large pages, use headings_only to get the page outline first, then use section to read a specific section, or max_length to limit the response size."
```

**Tests** (`index.test.ts`):
1. `section` parameter calls extractSection and returns section content
2. `max_length` parameter truncates the body
3. `headings_only` takes precedence over `section`
4. `section` + `max_length` extracts section then truncates

### 1.5 Add `section` and `max_length` parameters to `get_page_by_title` tool

**File:** `src/server/index.ts`

Same parameters and handler logic as 1.4, applied to `get_page_by_title`.

**Tests** (`index.test.ts`):
1. `section` parameter works on get_page_by_title
2. `max_length` parameter works on get_page_by_title

### 1.6 Implement `update_page_section` tool

**File:** `src/server/index.ts`
**Depends on:** `extractSection` from 1.2

New tool registration:
- Name: `update_page_section`
- Description: `"Update a single section of a Confluence page by heading name. Only the content under the specified heading is replaced; the rest of the page is untouched. Use headings_only to find section names first."`
- Parameters:
  - `page_id: z.string()` — page ID
  - `section: z.string()` — heading text identifying the section to replace
  - `body: z.string()` — new storage format content for this section (replaces everything between the heading and the next heading of equal or higher level)
  - `version: z.number()` — current page version (optimistic concurrency, same as `update_page`)
  - `version_message: z.string().optional()` — version comment
- Annotations: `{ destructiveHint: false, idempotentHint: false }`

Handler logic:
1. Fetch the full page body (storage format)
2. Parse with `node-html-parser`
3. Find the target heading
4. Replace all sibling elements between this heading and the next heading of equal or higher level with the new `body` content
5. Reconstruct the full page storage format
6. Call `updatePage()` with the reconstructed body and `version + 1`

Key constraints:
- If the section is not found, return an error (do not create a new section — this prevents accidental page restructuring)
- The heading itself is preserved (only content under it is replaced)
- Version conflict handling follows the same pattern as `update_page`

**Tests** (`index.test.ts`):
1. Replaces section content while preserving other sections
2. Preserves macros in untouched sections
3. Returns error when section not found
4. Returns ConfluenceConflictError on version mismatch
5. Preserves the heading element itself

**Client function** (`confluence-client.ts`):
- Add `replaceSection(storageHtml, headingText, newContent)` — returns the full HTML with the section replaced
- This is a pure function (no API call), making it easy to test

**Tests** for `replaceSection` (`confluence-client.test.ts`):
1. Replaces content under target heading
2. Preserves content before and after the section
3. Handles last section in document
4. Preserves macros in other sections
5. Returns null/error when heading not found
6. Handles nested headings correctly (h2 replacement preserves h3 subsections in other h2 sections)

### 1.7 Update documentation

- `doc/design/03-tools.md` — add `update_page_section` to tool annotations and summary table; update `get_page` and `get_page_by_title` parameter lists
- `doc/user-doc/tools-reference.md` — add `update_page_section` section; update `get_page` and `get_page_by_title` parameter tables
- `README.md` — add `update_page_section` to tools table
- `install-agent.md` — add `update_page_section` to available tools table, update tool count to 13
- `src/cli/setup.ts` — add `update_page_section` to TOOLS array

### Phase 1 Test Summary

| Location | New Tests | What's Covered |
|----------|-----------|----------------|
| `confluence-client.test.ts` | ~20 | `extractSection`, `truncateStorageFormat`, `replaceSection` |
| `index.test.ts` | ~11 | `get_page` section/max_length, `get_page_by_title` section/max_length, `update_page_section` |

---

## Phase 2: Search Excerpt Inclusion

**Depends on:** nothing
**New dependencies:** none

### 2.1 Add `excerpt` to `PageSchema`

**File:** `src/server/confluence-client.ts`

Add to `PageSchema`:
```typescript
excerpt: z.string().optional(),
```

This is backward-compatible — the field is optional and existing API responses that lack it will parse fine.

**Tests** (`confluence-client.test.ts`):
1. `PageSchema` parses response with `excerpt` field
2. `PageSchema` parses response without `excerpt` field (backward compat)

### 2.2 Update `search_pages` handler to include excerpts

**File:** `src/server/index.ts`

Change the result formatting from:
```
- Title (ID: 123, space: DEV)
```
To:
```
- Title (ID: 123, space: DEV)
  Excerpt text here...
```

Only include the excerpt line if `p.excerpt` is truthy and non-empty.

**Tests** (`index.test.ts`):
1. Search results include excerpt when present
2. Search results omit excerpt line when excerpt is missing
3. Search results omit excerpt line when excerpt is empty string

### 2.3 Update documentation

- `doc/design/03-tools.md` — note that search results now include excerpts
- `doc/user-doc/tools-reference.md` — update `search_pages` returns description

### Phase 2 Test Summary

| Location | New Tests | What's Covered |
|----------|-----------|----------------|
| `confluence-client.test.ts` | 2 | Schema parsing with/without excerpt |
| `index.test.ts` | 3 | Excerpt formatting in search results |

---

## Phase 3: Read-Only Markdown Rendering

**Depends on:** Phase 1 (shares `node-html-parser` parsing infrastructure)
**New dependency:** `turndown` (MIT, ~15KB bundled, no native deps)

### 3.1 Add `turndown` dependency

```bash
npm install turndown
npm install -D @types/turndown
```

### 3.2 Implement `toMarkdownView(storageHtml)` in `confluence-client.ts`

**File:** `src/server/confluence-client.ts`
**Export:** `toMarkdownView`

Behavior:
- Strip all `<ac:structured-macro>` blocks, replacing each with a human-readable placeholder:
  - `[macro: {ac:name} ({safe parameters})]` — only whitelisted parameter names are shown (e.g., `language`, `title`). Parameters named `url`, `server`, `key`, `token`, `password` are redacted.
  - Unknown/custom macros: `[macro: {ac:name}]` (no parameters shown)
- Strip `<ac:layout>` blocks, replacing with `[layout: {N}-column]` (count `<ac:layout-cell>` children)
- Strip `<ac:image>`, `<ri:attachment>` with `[image: {filename}]` or `[attachment: {filename}]`
- Convert remaining HTML to markdown using `turndown`
- Append footer: `\n\n---\n[Page contains {N} Confluence elements not shown in this view. Use format: storage to see full content.]`

Key constraints:
- This is a pure function — no API calls, no side effects
- Output is clearly lossy — the footer makes this explicit
- Parameter redaction prevents sensitive macro parameters from leaking into LLM context

**Tests** (`confluence-client.test.ts`):
1. Converts basic HTML (paragraphs, headings, bold, italic, links) to markdown
2. Replaces `<ac:structured-macro>` with placeholder showing macro name
3. Whitelisted parameters (language, title) are shown in placeholder
4. Sensitive parameters (url, token, password) are redacted
5. Unknown macros show name only, no parameters
6. Replaces `<ac:layout>` with column count placeholder
7. Replaces `<ac:image>` / `<ri:attachment>` with filename placeholders
8. Appends element count footer
9. Returns plain markdown for pages with no Confluence-specific elements (footer says 0)
10. Handles empty string input

### 3.3 Add `format` parameter to `get_page` and `get_page_by_title`

**File:** `src/server/index.ts`

Add to inputSchema:
```typescript
format: z.enum(["storage", "markdown"]).default("storage").describe(
  "Response format. 'storage' (default) returns Confluence storage format, safe for editing. 'markdown' returns a read-only summary — macros, layouts, and rich elements are summarized, not preserved."
)
```

Handler logic:
- When `format: "markdown"` and body is available, pass body through `toMarkdownView()` before returning
- Prepend the warning to the response: `"Read-only markdown rendering. Macros and rich elements are summarized. To edit this page, use format: storage.\n\n"`
- `format: "markdown"` is compatible with `section` (convert just that section to markdown)
- `format: "markdown"` is incompatible with `headings_only` — `headings_only` takes precedence

**Tests** (`index.test.ts`):
1. `format: "markdown"` returns markdown with warning prefix
2. `format: "storage"` (default) returns storage format unchanged
3. `format: "markdown"` + `section` returns markdown for just that section
4. `headings_only` takes precedence over `format: "markdown"`

### 3.4 Add markdown rejection guard to `update_page`

**File:** `src/server/index.ts`

In the `update_page` handler, before calling `updatePage()`, check if the body appears to be markdown rather than storage format. This is a defense-in-depth measure — the primary protection is that the LLM should never receive markdown as an editable format.

Heuristic: if the body contains markdown-specific patterns (`^#{1,6} `, `**bold**`, `[text](url)`, ``` ``` ```) AND does not contain any `<ac:` or `<ri:` or `<p>` tags, reject with an error:
```
"Error: Body appears to be markdown, not Confluence storage format. The update_page tool requires storage format. Use get_page with format: storage to retrieve the editable content."
```

This guard errs on the side of permissiveness — it only rejects when the content is clearly markdown and contains no HTML at all. Valid storage format always contains HTML tags.

**Tests** (`index.test.ts`):
1. Rejects body that is clearly markdown (headings with `#`, links with `[]()`, no HTML tags)
2. Accepts body that is valid storage format HTML
3. Accepts body that is plain text (no markdown patterns, no HTML — wraps in `<p>` as before)
4. Accepts body that contains both markdown-like patterns and HTML tags (could be storage format with `#` in text)

### 3.5 Update documentation

- `doc/design/03-tools.md` — document `format` parameter
- `doc/user-doc/tools-reference.md` — document `format` parameter and markdown guard on `update_page`

### Phase 3 Test Summary

| Location | New Tests | What's Covered |
|----------|-----------|----------------|
| `confluence-client.test.ts` | ~10 | `toMarkdownView` conversion, placeholders, parameter redaction |
| `index.test.ts` | ~8 | `format` parameter on both tools, markdown rejection guard |

---

## Phase 4: Version-Aware Page Cache (In-Memory)

**Depends on:** nothing (can be implemented alongside any phase)
**New dependencies:** none

### 4.1 Implement `PageCache` class in new file `src/server/page-cache.ts`

**File:** `src/server/page-cache.ts` (new file)
**Export:** `PageCache` class, `pageCache` singleton instance

```typescript
export class PageCache {
  private cache: Map<string, { version: number; body: string }>;
  private maxSize: number;

  constructor(maxSize: number = 50);
  get(pageId: string, version: number): string | undefined;
  set(pageId: string, version: number, body: string): void;
  has(pageId: string): { version: number } | undefined;
  delete(pageId: string): void;
  clear(): void;
  get size(): number;
}
```

Behavior:
- `get(pageId, version)` — returns cached body if page_id exists and version matches; returns `undefined` otherwise
- `set(pageId, version, body)` — stores body, evicts oldest entry if at capacity (LRU by insertion order — `Map` preserves insertion order, delete and re-insert to promote)
- `has(pageId)` — returns `{ version }` if cached, `undefined` otherwise (for version-check-only flows)
- `delete(pageId)` — removes from cache (used after `deletePage`)
- `clear()` — empties the cache

LRU eviction: when `cache.size >= maxSize`, delete the first key (oldest) before inserting.

**Tests** (`page-cache.test.ts` — new file):
1. `get` returns undefined for empty cache
2. `set` then `get` with matching version returns body
3. `get` with mismatched version returns undefined
4. `set` overwrites entry for same pageId
5. LRU eviction removes oldest entry when at capacity
6. Recently accessed entries survive eviction (get promotes entry)
7. `delete` removes specific entry
8. `clear` empties cache
9. `has` returns version when cached
10. `has` returns undefined when not cached
11. `size` returns correct count

### 4.2 Integrate cache into `getPage()`

**File:** `src/server/confluence-client.ts`

Modify `getPage()`:
1. If `includeBody` is true, first call the API **without** `body-format=storage` to get metadata only
2. Check cache: if `pageCache.get(pageId, page.version.number)` returns a body, use it
3. If cache miss, re-fetch **with** `body-format=storage`, cache the body, return
4. If `includeBody` is false, call API without body as before (no cache interaction)

This adds one extra API call on cache miss (metadata-only + full fetch), but saves the full-body call on cache hit. Net positive after the first read.

Optimization: skip the metadata-only call if the page is not in the cache at all (`pageCache.has(pageId)` returns undefined). In that case, go straight to the full fetch and cache the result. This means cache misses for never-seen pages have zero overhead.

**Tests** (`confluence-client.test.ts`):
1. Cache hit: only one API call (metadata-only), body from cache
2. Cache miss (version changed): two API calls (metadata + full), body cached
3. Cache miss (never seen): one API call (full), body cached
4. `includeBody: false` does not interact with cache

### 4.3 Integrate cache into `updatePage()` and `createPage()`

**File:** `src/server/confluence-client.ts`

After successful `updatePage()`:
- Cache the body that was sent: `pageCache.set(pageId, newVersion, body)`

After successful `createPage()`:
- Cache the body: `pageCache.set(page.id, 1, body)` (new pages start at version 1)

After successful `deletePage()`:
- Evict: `pageCache.delete(pageId)`

**Tests** (`confluence-client.test.ts`):
1. `updatePage` caches the body with new version
2. `createPage` caches the body with version 1
3. `deletePage` evicts from cache
4. Subsequent `getPage` after `updatePage` serves from cache (1 API call, not 2)

### 4.4 Update documentation

- `doc/design/03-tools.md` — mention caching behavior (transparent to tool callers)

### Phase 4 Test Summary

| Location | New Tests | What's Covered |
|----------|-----------|----------------|
| `page-cache.test.ts` | 11 | `PageCache` class — all methods, LRU eviction |
| `confluence-client.test.ts` | ~8 | Cache integration in getPage, updatePage, createPage, deletePage |

---

## Implementation Order

```
Phase 2 (search excerpts)     ← smallest, no dependencies, ship first
    ↓
Phase 4 (page cache)          ← no dependencies, high impact, ship second
    ↓
Phase 1 (section + max_length + update_page_section)  ← needs node-html-parser
    ↓
Phase 3 (markdown rendering)  ← needs turndown + Phase 1 parser, ship last
```

Rationale:
- Phase 2 is ~5 new tests, ~20 lines of code. Quick win.
- Phase 4 is self-contained and immediately reduces token usage for iterative editing.
- Phase 1 is the largest phase (new dependency, new tool, section extraction + replacement). Ship after Phase 4 so the cache is already available.
- Phase 3 depends on Phase 1's `node-html-parser` usage and is the most complex (turndown, macro whitelisting, markdown guard). Ship last.

## Total New Tests

| Phase | Tests | Description |
|-------|-------|-------------|
| 1 | ~31 | Section extraction, truncation, section replacement, tool params, update_page_section |
| 2 | ~5 | Schema excerpt, search formatting |
| 3 | ~18 | Markdown conversion, format param, markdown rejection guard |
| 4 | ~19 | PageCache class, cache integration |
| **Total** | **~73** | |

## New Dependencies

| Package | Phase | License | Size | Native? |
|---------|-------|---------|------|---------|
| `node-html-parser` | 1 | MIT | ~50KB | No |
| `turndown` | 3 | MIT | ~15KB | No |
| `@types/turndown` | 3 (dev) | MIT | — | No |

## New Files

| File | Phase | Purpose |
|------|-------|---------|
| `src/server/page-cache.ts` | 4 | PageCache class + singleton |
| `src/server/page-cache.test.ts` | 4 | PageCache tests |

## Modified Files (all phases)

| File | Phases | Changes |
|------|--------|---------|
| `src/server/confluence-client.ts` | 1, 2, 3, 4 | `extractSection`, `replaceSection`, `truncateStorageFormat`, `toMarkdownView`, excerpt in schema, cache integration |
| `src/server/confluence-client.test.ts` | 1, 2, 3, 4 | Tests for all new functions |
| `src/server/index.ts` | 1, 2, 3 | New params on get_page/get_page_by_title, update_page_section tool, format param, markdown guard |
| `src/server/index.test.ts` | 1, 2, 3 | Tests for all tool changes |
| `src/cli/setup.ts` | 1 | Add update_page_section to TOOLS array |
| `doc/design/03-tools.md` | 1, 2, 3, 4 | Tool docs |
| `doc/user-doc/tools-reference.md` | 1, 2, 3 | User-facing tool docs |
| `README.md` | 1 | Tools table |
| `install-agent.md` | 1 | Available tools table + count |
| `package.json` | 1, 3 | New dependencies |
