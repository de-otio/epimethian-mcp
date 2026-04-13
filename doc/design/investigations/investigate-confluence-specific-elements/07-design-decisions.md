# Design decisions and open questions

[← Back to index](README.md)

## Decided

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Markdown flavour:** GFM as the base | Mature, well-known to LLMs and humans; handles tables, code, task lists, autolinks. |
| 2 | **Block extensions:** Pandoc-style fenced divs (`::: panel ... :::`) | Conventional in markdown ecosystem; mature parser plugins; composes with GFM tables. |
| 3 | **Inline extensions:** remark-directive syntax (`:status[...]{}`) | Standard form for the directive plugin family; readable inside table cells. |
| 4 | **Raw HTML:** disabled by default (`html: false`) | XSS / macro-injection prevention. Opt-in for trusted callers (see [Security #4](06-security.md#4-raw-html-in-markdown-body)). |
| 5 | **Raw `<ac:>`/`<ri:>` passthrough:** allowlisted macros only | Macro-injection prevention (see [Security #2](06-security.md#2-macro-injection-via-raw-passthrough)). |
| 6 | **Failure mode:** fail-loud on any conversion that would lose data | Data preservation invariant (see [01-data-preservation.md](01-data-preservation.md)). |
| 7 | **Detection heuristic:** strengthen `looksLikeMarkdown` so `<ac:`/`<ri:`/`<ac:layout>` are strong storage signals; bare `<br/>` is not | Avoids misclassifying markdown with incidental HTML as storage and skipping conversion. |
| 8 | **Status macro colour parameter** uses British spelling (`colour`) and named values (`Blue`, `Green`, `Red`, `Yellow`, `Grey`, `Purple`) | Confluence storage quirk; validate at directive layer with a clear error listing valid values. |
| 9 | **Library choice:** `markdown-it` over `marked` | Plugin architecture is materially better for per-element extensions; performance difference is irrelevant at our scale. See [alternatives](08-alternatives-considered.md). |
| 10 | **Backward compatibility:** existing callers passing raw storage format continue to work unchanged | The detection heuristic routes them through the existing path; no migration needed. |
| 11 | **CDATA wrapping is mandatory for code blocks**, with `]]>` escape | Required by storage format and by [Security #1](06-security.md#1-cdata-injection-in-code-blocks). |
| 12 | **`ac:schema-version="1"`** is emitted on every `<ac:structured-macro>` | Matches Confluence editor output; safe default. |

## Defaults that need explicit confirmation on first review

| # | Question | Proposed default | Why this default |
|---|----------|-----------------|------------------|
| A | **Smart quotes / typography** (`'` → `'`, `--` → `–`, etc.) | **OFF** (`typographer: false`) | Markdown round-trips cleanly; avoids surprising callers who expect their punctuation preserved. Confluence editor doesn't typographically transform on save either. |
| B | **Linkify bare URLs** | **ON** (`linkify: true`) | Standard markdown behaviour; bare Confluence URLs become `<ac:link>` automatically (consistent with Channel 3). |
| C | **Heading-level offset** when frontmatter doesn't specify | **0** (no offset) | Pages with no frontmatter still typically start with `# Title`; auto-offsetting would surprise. Frontmatter `headingOffset: 1` is the documented opt-in for "page title is in the metadata; bump my headings down". |
| D | **`confirm_deletions` threshold** | Any deletion (i.e. zero tolerance) | Maximally safe; explicit opt-in for any macro removal. Could relax to "1 or more deletions allowed" later if friction warrants. |
| E | **`replace_body` opt-out flag** | **OFF** | The data-preservation invariant is the default; opting out is loud (per [01-data-preservation.md](01-data-preservation.md#caller-ergonomics)). |
| F | **Code-block macro vs plain `<pre><code>`** when fenced block has no language | **Macro** (`<ac:name="code">` with no language parameter) | Consistent rendering with language-tagged blocks; users get the Confluence code-macro toolbar (copy, line numbers). |
| G | **`ac:macro-id` for newly-authored macros** | Generate fresh UUID for `drawio`, `code`, `expand`, `excerpt`; omit for the panel/status/toc family unless evidence shows it's needed | Matches existing `add_drawio_diagram` behaviour; minimises wire size where unnecessary. |

## Open questions for review

1. **`success` panel macro name.** Some Confluence Cloud versions render as `success`, others as `check`. Confirm against current behaviour at implementation time and document the chosen name.
2. **Round-trip fidelity for `<ac:layout>`.** Layouts can be deeply nested (sections containing cells containing layouts). Phase 1 tokens preserve them by reference; Phase 2/3 markdown-shim authoring is restricted to flat two-/three-column layouts. Acceptable?
3. **Excerpt-include by ID.** The current shim accepts source page by title only. Should we also accept by content ID for stability across renames? Probably yes; defer to Phase 3.
4. **Multi-Jira deployments.** The `:jira[KEY-123]` directive emits `<ac:name="jira">` with a single configured `serverId`. For tenants with multiple linked Jira applications, accept `:jira[KEY-123]{server=other}` and resolve via config map. Not blocking for v1.
5. **Mention discovery.** Phase 4 proposes `lookup_user(query)`. Until then, agents must already know the `accountId`. Should the directive accept `email=` or `name=` as input and resolve at write time? Adds an Atlassian API call per mention; defer unless usage demands it.
6. **`task-id` collision strategy across concurrent edits.** Phase 1 reads max-id from pre-edit storage and assigns IDs starting at max+1. Two concurrent updates could pick the same IDs. Confluence rejects duplicates on save → caller retries. Document and accept; full optimistic-concurrency handling is future work.
7. **Token-comment compatibility inside GFM tables.** HTML comments in markdown table cells are ecosystem-fragile. Verify markdown-it preserves `<!--epi:T####-->` inside table cells; if not, define a non-comment token form (e.g. `[[epi:T0042]]`).
8. **Attribution-label visibility.** The current write path adds the `epimethian-managed` label. Phase 1 changes don't affect this, but verify behaviour when token preservation restores macros — labels should not toggle on every restore-only update.

## Operational / non-functional

- **Performance.** markdown-it parses ~10 MB/s on commodity hardware; tokenise + diff + restore for typical pages is sub-50 ms. Hard caps and acceptance bounds are in [Acceptance criteria](09-acceptance-criteria.md#performance).
- **Bundle size.** `markdown-it` core is ~30 KB minified; the four extension plugins add ~50 KB. Total ~80 KB to the esbuild output. Acceptable for a server-side MCP; flag if the binary gets distributed in a size-sensitive context.
- **Telemetry.** No phone-home from `markdown-it` or its plugins. Confirm during dependency audit.
- **CHANGELOG / SemVer.** Adding markdown conversion is arguably **breaking** for callers who relied on the old `<p>`-wrap behaviour (however broken). Recommend SemVer **major** bump with a clear migration note: "Bodies that look like markdown are now converted; pass storage format verbatim if you need the old behaviour."
- **`writeGuard` interaction.** The new converter runs inside the existing write guard ([index.ts:235](../../../../src/server/index.ts#L235)); read-only mode rejects markdown writes the same way it rejects storage writes. Add a regression test (Phase 3 step 20).
