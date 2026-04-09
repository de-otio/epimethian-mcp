# Investigation: Token-Efficient Output Mode

## Problem

Confluence API responses are verbose. Page bodies use storage format HTML with macro markup, inline styles, and deeply nested structures. List responses include metadata fields (`_links`, `_expandable`, `version`, `history`) that are irrelevant to most tool calls. This drives high token consumption in LLM context windows.

Currently, Epimethian returns:
- Full storage-format HTML when `include_body: true` (no trimming or conversion)
- Plain-text formatted responses for lists (already lean, but structured data is flattened)
- No field filtering — tool handlers cherry-pick fields, but the selection is fixed

## Prior Art

### aashari/mcp-server-atlassian-confluence — TOON Format

The aashari server uses a three-layer strategy:

1. **TOON encoding** (Token-Oriented Object Notation, spec v3.0 at `github.com/toon-format/spec`)
   - Lossless encoding of JSON that uses YAML-like `key: value` for objects and CSV-style tabular layout for uniform arrays
   - Field names declared once in a header row; data follows as compact comma-separated rows
   - Benchmarked at ~40% fewer tokens than pretty-printed JSON with equal or higher LLM accuracy (tested on Claude Haiku 4.5, Gemini 3 Flash, GPT-5 Nano, Grok 4.1)
   - Biggest wins on uniform arrays of objects (exactly what list endpoints return)
   - Reference implementation: npm `@toon-format/toon`

2. **JMESPath field filtering** (`jq` parameter per tool call)
   - Lets the LLM request only the fields it needs: `results[*].{id: id, title: title}`
   - Arguably more impactful than TOON for Confluence since it eliminates irrelevant fields entirely
   - Encourages a "schema discovery" pattern: fetch 1 item unfiltered, then filter subsequent calls

3. **Response truncation** at 40,000 characters (~10k tokens)
   - Truncates at newline boundary, appends guidance telling the LLM to refine its query
   - Full raw response saved to `/tmp/mcp/` for reference

**Example — Spaces list:**

JSON (standard):
```json
[{"id":"327682","name":"Codashop","key":"SHOP"},{"id":"16711683","name":"Codapay","key":"PAY"}]
```

TOON (57% smaller):
```
[2]{id,name,key}:
  "327682",Codashop,SHOP
  "16711683",Codapay,PAY
```

### Other approaches in the ecosystem

- **Markdown conversion**: Convert storage format HTML to Markdown before returning (strips tags, inline styles, macros). Lossy but dramatically smaller.
- **API-level field selection**: Use Confluence `?expand=` parameters to request only needed data from the API itself.
- **Pagination control**: Smaller `limit` values to avoid overwhelming context windows.

## Current Epimethian Response Analysis

### What's already lean
- List responses (search, children, spaces, attachments) use plain-text bullet format: `- Title (ID: 123, space: DEV)`. These are already compact — no JSON overhead.
- Only essential fields are extracted (id, title, space, version, URL).
- Metadata like `_links`, `_expandable`, creation dates, authors are already stripped.

### Where tokens are wasted
1. **Page body content** — full storage format HTML returned verbatim. A typical Confluence page body can be 5,000-50,000+ tokens. Macro markup (`<ac:structured-macro>`, `<ac:parameter>`, `<ri:attachment>`) is extremely verbose.
2. **No content summarization** — no way to request "first 500 chars" or "headings only".
3. **No format conversion** — storage format is the worst possible format for token efficiency. Markdown is 2-5x smaller for equivalent content.

## Hard Constraint: Data Safety

**Any optimization that causes data loss on round-trip is unacceptable.**

Confluence pages contain elements with no Markdown equivalent:

- **Macros** — `<ac:structured-macro>` blocks: code blocks with language metadata, Jira issue links, table of contents, expand/collapse sections, status lozenges, panels/notes/warnings, roadmaps, excerpts, page includes, etc.
- **Layouts** — `<ac:layout>` with `<ac:layout-section>` and `<ac:layout-cell>` for multi-column layouts
- **Rich media** — `<ac:image>`, `<ac:emoticon>`, `<ri:attachment>` references with sizing/alignment attributes
- **Inline cards** — `<ac:link>` and smart links with display metadata
- **Table attributes** — column widths, merged cells, header rows, colored cells

A naive storage-format → markdown → storage-format round-trip **destroys all of these silently**. An LLM that reads a page as markdown and writes it back will produce a page stripped of macros, layouts, and rich formatting. This is the catastrophic scenario to prevent.

### Safety principles

1. **The MCP server must never cause data loss in Confluence.** This is a hard constraint, not a trade-off to weigh against token savings.
2. **Storage format is the source of truth for writes.** The `update_page` and `create_page` tools must always accept and work with storage format. Never accept markdown as page body input.
3. **Markdown output is view-only.** If we provide a markdown rendering, the response must explicitly state it cannot be used for updates. The server must reject any attempt to write markdown back as page content.
4. **All token optimizations must be lossless with respect to Confluence data.** Reducing what we *return to the LLM* (windowing, excerpts, field filtering) is safe. Transforming what gets *written to Confluence* is not.

## Recommended Approach

### Phase 1: Content windowing (lossless, highest safety)

Add optional parameters to body-returning tools:
- `max_length: number` — truncate body after N characters, append `[truncated at N of M characters]` marker
- `section: string` — extract only the content under a matching `<h1>`–`<h6>` heading (return storage format for that section only, preserving macros)
- `headings_only: boolean` — return just the heading outline of the page (extremely compact, useful for navigation)

This is **completely lossless** — the returned content is valid storage format that can be used in updates. The LLM can request just the section it needs to edit, reducing token usage without conversion risk.

**Implementation:**
- Parse the storage format HTML with a lightweight parser (e.g., `node-html-parser`)
- For `section`: find the target heading, collect all siblings until the next heading of equal or higher level
- For `headings_only`: extract all `<h1>`–`<h6>` elements and return as a numbered outline
- For `max_length`: truncate at the nearest element boundary (don't split tags mid-element)

**Token savings:** Variable but significant. A 50,000-token page where the LLM only needs one section becomes 2,000-5,000 tokens. Heading-only view is typically <500 tokens.

### Phase 2: Search excerpt inclusion

`search_pages` responses currently discard the `excerpt` field from Confluence search results. Include it:
- Confluence generates these server-side as plain-text content snippets (~300 chars)
- Lets the LLM preview content without calling `get_page` at all
- Zero conversion risk — excerpts come from the API, not from our conversion

### Phase 3: Read-only markdown rendering

Markdown conversion can reduce token usage for **read-only** scenarios (e.g., summarizing a page, answering questions about its content). It must never feed into a write path.

**Implementation:**
- Convert storage format HTML to markdown using `turndown`
- For Confluence-specific elements with no markdown equivalent (macros, layouts, rich media), render a human-readable placeholder: `[macro: code-block (language=python)]`, `[layout: 3-column]`, `[jira: PROJECT-123]`
- Append a summary footer: `[Page contains N Confluence elements not shown in this view]`

**Guardrails — the server must enforce these, not rely on LLM compliance:**
- The `format: "markdown"` response is **read-only**. The server must include a clear warning: `"⚠ Read-only markdown rendering. Macros, layouts, and rich elements are summarized, not preserved. To edit this page, use format: storage."`
- The `update_page` tool must **reject** markdown input. It accepts storage format only. This is enforced at the tool handler level, not by instruction.
- There is no round-trip. Markdown is a one-way rendering for the LLM's comprehension. It never flows back into Confluence.

Concrete parameter design:
- `format: "storage"` (default) — full storage format, safe for editing
- `format: "markdown"` — read-only rendering, server-enforced write rejection

### Phase 4: Version-aware page cache (in-memory)

In iterative editing workflows (the most common LLM pattern), the server repeatedly fetches the same page body. A write-through, version-keyed in-memory cache eliminates redundant full-body fetches.

**How it works:**
1. **Write-through on mutate:** After a successful `update_page` or `create_page`, cache the body keyed by `(page_id, version_number)`. The server already has the body — it just sent it.
2. **Read-through on fetch:** On `get_page`, first fetch metadata only (no `body-format=storage` — lightweight call returning title, version, space, links). If the version matches a cache entry, return the cached body. If not (someone else edited, or cache miss), fetch the full body and cache it.
3. **Also applies to `headings_only`:** Extract headings from the cached body when available.

**Why it's safe:**
- Confluence version numbers are strictly monotonic — same version = identical content, guaranteed by the API contract
- **No cross-tenant leak risk.** Page IDs are not globally unique across Confluence instances, but the in-memory cache does not need a tenant-scoped key. The multi-tenant architecture (see `10-multi-tenant.md`) enforces one process per profile: each MCP server process connects to exactly one Confluence tenant, with the config frozen at startup via `Object.freeze()`. There is no mechanism to switch tenants at runtime. The in-memory cache lives and dies with the process, scoped to that single tenant. A `page_id`-only key is therefore unique within the cache's lifetime. (The rejected SQLite cache *does* need `(tenant_url, page_id, version)` keying because persistence survives process restarts where a different profile may be active.) **If the architecture ever evolves to support multiple profiles per process, the cache key must be changed to include the tenant URL.**
- Cache miss falls through to a full fetch — correctness is never compromised
- No transformation — cached value is the exact storage format HTML

**Token savings:** In an iterative session with 10 edits to a 20,000-token page: 1 full fetch + 9 version-only checks ≈ 22,000 tokens vs. 200,000 tokens without cache. ~90% reduction for the common case.

**Implementation details:**
- Simple `Map<string, { version: number; body: string }>` keyed by page_id
- LRU eviction at ~50 entries to bound memory (each page body is typically 10-100KB)
- No external dependencies

**Rejected alternative: SQLite persistent cache.** A persistent cache would warm across server restarts, but the downsides are severe for a multi-tenant consultant tool:
- **Customer content on disk in plaintext** — contradicts the project's security posture (keychain storage, no plaintext tokens). Customer A's content sits in a local file while working with Customer B.
- **Cross-tenant cache key safety** — page IDs are not globally unique across Confluence instances. Must be keyed by `(tenant_url, page_id, version)`. A bug here is a data leak.
- **Native dependency** — `better-sqlite3` has native bindings, breaking the project's zero-native-deps packaging. `sql.js` (WASM) avoids this but adds ~1MB.
- **Marginal benefit** — in-memory cache covers the highest-impact case (iterative editing within a session). The incremental gain from persistence is "warm start after restart" — real but not worth the security and packaging cost.

### Phase 5: Response format for list operations (TOON or compact)

Consider adding a `response_format` parameter (`"text"` | `"json"` | `"toon"`):
- `"text"` (default) — current plain-text format
- `"json"` — structured JSON for programmatic consumption
- `"toon"` — TOON-encoded for token efficiency on list responses

**Trade-off:** TOON adds a dependency (`@toon-format/toon`) and complexity. The current plain-text list format is already quite compact. The biggest token savings come from Phase 1 (content windowing), not list encoding. TOON may not justify the added complexity unless users frequently query large result sets.

### Phase 5: Field filtering (JMESPath)

Add a `fields` or `jq` parameter that lets the LLM specify which fields to return. This is powerful but adds significant complexity and a dependency on a JMESPath library.

**Recommendation:** Defer unless there's clear demand. The fixed field selection in tool handlers already covers the common case.

## Priority Assessment

| Phase | Token Savings | Data Safety | Effort | Recommendation |
|-------|--------------|-------------|--------|----------------|
| 1. Content windowing | High (section-level) | **Lossless** — returns unmodified storage format | Low | **Do this first** |
| 2. Search excerpts | Moderate (avoids get_page calls) | **Lossless** — API-provided excerpts | Very low | Do second |
| 3. Read-only markdown | 50-70% on body | **Safe** — server enforces write rejection | Medium | Do third |
| 4. Page cache | ~90% on iterative edits | **Lossless** — version-keyed, session-scoped | Low | Do alongside Phase 1 |
| 5. TOON/JSON format | 30-60% on list responses | **Lossless** — encoding only | Medium | Evaluate later |
| 6. Field filtering | Variable | **Lossless** — reduces fields returned | High | Defer |

## Dependencies

- Phase 1: None — `headings_only` uses regex extraction (no external parser needed). `section` and `max_length` will need `node-html-parser` or similar.
- Phase 3: `turndown` (MIT, ~15KB bundled, no native deps)
- Phase 4: None — pure in-memory Map, no external dependencies
- Phase 5: `@toon-format/toon` (MIT)
- Phase 6: `@metrichor/jmespath` or similar

## Decisions

1. **`headings_only` is an explicit opt-in parameter, not the default.** `include_body: true` remains the default for `get_page`. The `headings_only: boolean` parameter was added to both `get_page` and `get_page_by_title`. When set, it returns a numbered heading outline instead of the full body. Tool descriptions guide the LLM toward the drill-down pattern: outline first, then full body when needed. **(Implemented)**

2. **Add a dedicated `update_page_section` tool.** This tool replaces only the content under a specific heading, leaving the rest of the page untouched. This complements the drill-down pattern — the LLM uses `headings_only` to find the section, `get_page` with a `section` parameter to read just that section in storage format, and `update_page_section` to write it back. This drastically reduces the blast radius of edits (the LLM never needs to handle the full page body) and is inherently safer for macro-heavy pages since untouched sections are never re-serialized. **(Planned — requires Phase 1 section extraction first)**

3. **No global `output_format` config option.** Format decisions are per-tool-call only. A per-profile setting can't anticipate what the LLM needs on each call (browsing vs. reading vs. editing), and would create a footgun for multi-tenant workflows where a profile-level `markdown` setting could silently break edit workflows. If a constrained LLM needs to default to compact output, that belongs in the LLM client's system prompt, not the MCP server. **(Won't do)**

4. **Always include excerpts in `search_pages` results.** The Confluence v1 search API returns an `excerpt` field (plain-text snippet, ~300 chars) that we currently strip during Zod parsing. Include it in every search response — it lets the LLM triage results without calling `get_page` on each one. Zero conversion risk (excerpts come from the API, not our transformation), minimal token overhead, and no reason to make it opt-in since the snippets are small enough to never be unwanted. Implementation: add `excerpt` as optional to `PageSchema`, include it in `search_pages` output formatting. **(Planned)**
