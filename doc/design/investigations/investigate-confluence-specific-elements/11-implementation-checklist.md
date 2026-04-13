# Implementation checklist — parallel multi-agent execution

[← Back to index](README.md)

This checklist breaks the [implementation plan](05-implementation-plan.md) into independent **streams** that can be worked by separate agents in parallel, with explicit dependencies, model assignments, and per-stream acceptance gates. Coverage target: **80% line + branch on every stream's owned files** (95% on security-critical helpers in Stream 1).

## Model-assignment heuristic

| Model | Use for |
|-------|---------|
| **Opus 4.6** | Security-critical code, the data-preservation diff/restore logic, ambiguous design calls, anything where a wrong implementation silently corrupts data or opens an attack surface. |
| **Sonnet 4.6** | Bulk implementation, plugin integration, mainstream feature work, standard tests. The default. |
| **Haiku 4.5** | Documentation, scaffolding, golden-file fixtures, CHANGELOG entries, tool-description updates. |

## Stream dependency graph

```
Stream 0 (setup, file scaffolding)
     │
     ├── Stream 1 (security helpers) ──────────┐
     │                                          │
     ├── Stream 2 (md→storage core) ◄──────────┤
     │           │                              │
     ├── Stream 3 (storage tokeniser) ◄────────┤
     │           │                              │
     │           └── Stream 4 (token-aware write path) ◄── depends on 2 + 3
     │                         │
     ├── Stream 5 (heuristic + tool wiring) ◄── depends on 4
     ├── Stream 6 (storageToMarkdown rewrite) ◄── depends on 3
     │
     ├── Stream 7 (panels — GH alert) ◄──── depends on 2
     ├── Stream 8 (containers) ◄─────────── depends on 2
     ├── Stream 9 (inline directives) ◄──── depends on 2 + 1 (mention validator)
     ├── Stream 10 (frontmatter / ToC) ◄─── depends on 2
     ├── Stream 11 (heading anchor slugger) ◄── depends on 2
     │
     ├── Stream 13 (documentation) — fully independent of code
     │
     └── Stream 12 (cross-cutting regression suite) ◄── depends on 5, 6, 7-11
```

**Critical path:** 0 → 1 → 3 → 4 → 5 → 12. Everything else parallelises off the critical path.

**Parallelism windows:**

- **Window A (after Stream 0):** Streams 1, 13 in parallel.
- **Window B (after Streams 0 + 1):** Streams 2, 3 in parallel.
- **Window C (after Stream 2):** Streams 7, 8, 9, 10, 11 in parallel.
- **Window D (after Streams 2 + 3):** Stream 4.
- **Window E (after Stream 4 + Stream 3):** Streams 5, 6 in parallel.
- **Window F (after all above):** Stream 12.

Phase 4 (lookup_user, resolve_page_link) is independent and can launch any time after Stream 0 — Stream 14.

---

## Stream 0 — Setup and file scaffolding (Sonnet 4.6)

**Goal:** create the structural seams that let later streams work without merge conflicts in `confluence-client.ts`.

- [ ] Add runtime deps to `package.json`: `markdown-it`, `markdown-it-container`, `markdown-it-directive` (or equivalent), `markdown-it-attrs`, `markdown-it-task-lists`, `gray-matter`, plus `@types/markdown-it` dev dep.
- [ ] Run `npm install` and verify `npm run build` still passes with the new deps.
- [ ] Create new directory `src/server/converter/` with empty stub files:
  - `md-to-storage.ts` (export `markdownToStorage(md: string, opts?: ConverterOptions): string`)
  - `storage-to-md.ts` (export `storageToMarkdown(storage: string): { markdown: string; sidecar: TokenSidecar }`)
  - `tokeniser.ts` (export `tokeniseStorage(storage: string): { canonical: string; sidecar: TokenSidecar }`)
  - `escape.ts` (export `escapeXmlAttr`, `escapeXmlText`, `escapeCdata`)
  - `url-parser.ts` (export `parseConfluenceUrl(url: string, baseUrl: string): ConfluencePageRef | null`)
  - `account-id-validator.ts` (export `isValidAccountId(id: string): boolean`)
  - `filename-validator.ts` (export `isValidAttachmentFilename(name: string): boolean`)
  - `allowlist.ts` (export `MACRO_ALLOWLIST: readonly string[]`, `isMacroAllowed(name: string): boolean`)
  - `types.ts` (`TokenSidecar`, `ConverterOptions`, `ConfluencePageRef`, error types)
  - `diff.ts` (export `diffTokens(canonical: string, callerMd: string, sidecar: TokenSidecar): TokenDiff`)
  - `restore.ts` (export `restoreFromTokens(storageWithTokens: string, sidecar: TokenSidecar): string`)
- [ ] Each stub returns a sentinel (e.g. `throw new Error("not implemented")`) so type-checking and import wiring can be verified before any stream touches them.
- [ ] Add `vitest` test file scaffolding (`*.test.ts`) for each new source file.
- [ ] Verify coverage config in `vitest.config.ts` includes the new directory and enforces ≥80% line/branch (≥95% for `escape.ts`, `url-parser.ts`, `account-id-validator.ts`, `filename-validator.ts`, `allowlist.ts`, `tokeniser.ts`, `diff.ts`, `restore.ts`).

**Acceptance:** `npm run build && npm test` passes (all stubs throw, but no compile errors). PR merged.

---

## Stream 1 — Security helpers (Opus 4.6)

**Goal:** implement every helper listed in [06-security.md](06-security.md) checklist with comprehensive regression tests. **No production code calls these helpers yet** — they exist as standalone, testable units.

- [ ] `escape.ts`:
  - [ ] `escapeXmlAttr(s: string): string` → `&` `<` `>` `"` `'` and control characters.
  - [ ] `escapeXmlText(s: string): string` → `&` `<` `>`.
  - [ ] `escapeCdata(s: string): string` → split `]]>` into `]]]]><![CDATA[>`. **Critical — get this exactly right.**
  - [ ] Tests: every special character round-trips; literal `]]>` survives; nested CDATA breakers; multi-byte UTF-8.
- [ ] `url-parser.ts`:
  - [ ] `parseConfluenceUrl(url, baseUrl): ConfluencePageRef | null` using `new URL(...)` host equality (no string comparison).
  - [ ] Returns `{ contentId, spaceKey, anchor? }` if internal; `null` if external or malformed.
  - [ ] Tests: spoofing variants from [Security #5](06-security.md#5-url-rewrite-spoofing) — `entrixenergy.atlassian.net.attacker.com`, port-suffix tricks, percent-encoded host (`%65ntrixenergy.atlassian.net`), `userinfo@host` (`anything@entrixenergy.atlassian.net`), `?host=...` query trickery, IPv6 hosts.
- [ ] `account-id-validator.ts`:
  - [ ] `isValidAccountId(id: string): boolean` accepting both modern (`557058:UUID`) and legacy (`5b...` opaque) Atlassian formats.
  - [ ] Tests: valid samples; XML injection attempts; empty; oversized; non-string-shaped.
- [ ] `filename-validator.ts`:
  - [ ] `isValidAttachmentFilename(name: string): boolean` — rejects `..`, `/`, `\`, null bytes, control characters, leading-dot files.
  - [ ] Tests: path-traversal variants; encoded variants; legitimate filenames with dots, hyphens, parens, spaces.
- [ ] `allowlist.ts`:
  - [ ] `MACRO_ALLOWLIST` constant matching the list in [Channel 4](04-markdown-syntax-design.md#channel-4--allowlisted-raw-storage-format-escape-hatch-for-new-content).
  - [ ] `isMacroAllowed(name: string): boolean` — case-sensitive match against allowlist.
  - [ ] Tests: every allowlisted name matches; common attempted bypasses (`Info`, `info `, `info\n`, `info<`) reject.

**Acceptance:** ≥95% line + branch coverage on each file. Every regression test from the [security checklist](06-security.md#summary--security-checklist-for-the-implementation-pr) implemented and green.

---

## Stream 2 — Markdown→storage core (Sonnet 4.6)

**Depends on:** Stream 0, Stream 1.

**Goal:** implement `markdownToStorage` for plain GFM input with security mitigations applied.

- [ ] Configure `markdown-it` with: `html: false`, `linkify: true`, `typographer: false`, `breaks: false`, `maxNesting: 100`, GFM tables enabled, GFM strikethrough, GFM autolinks, GFM task-lists.
- [ ] Implement input size cap (1 MB markdown) and `maxNesting` enforcement; reject with clear error before parsing.
- [ ] Implement `allow_raw_html: false` default; opt-in flag re-enables `html: true` and logs (use existing logger).
- [ ] Post-processing pipeline:
  - [ ] Void elements self-close (`<br>` → `<br/>`, `<hr>` → `<hr/>`, `<img>` → `<img/>`).
  - [ ] Fenced code blocks → `<ac:structured-macro ac:name="code">` with `language` parameter (uses `escapeCdata` from Stream 1; uses `escapeXmlAttr` for `language` value); generate `ac:macro-id` UUID.
  - [ ] Plain-language code blocks (no fence info) → same macro with no language parameter ([decision F in 07-design-decisions.md](07-design-decisions.md#defaults-that-need-explicit-confirmation-on-first-review)).
  - [ ] Inline `<a href>` to a URL passing `parseConfluenceUrl` from Stream 1 → `<ac:link><ri:page ri:content-id="..."/>...`.
  - [ ] All attribute values and `<ac:parameter>` text run through `escapeXmlAttr` / `escapeXmlText`.
- [ ] Implement `confluence://` scheme handling for explicit-by-title page links.
- [ ] Implement allowlisted raw `<ac:.../>` passthrough (uses `isMacroAllowed` from Stream 1); reject non-allowlisted with actionable error.
- [ ] Failure mode: any conversion that would lose data → `throw ConverterError` with actionable message. No fallback to `<p>` wrap.
- [ ] Unit tests:
  - [ ] One representative input per markdown construct (heading 1-6, paragraph, list ordered/unordered/nested, blockquote, table, hr, code fence with/without language, link, image, em/strong, inline code, task-list).
  - [ ] CDATA injection regression (literal `]]>` in fenced block).
  - [ ] Attribute injection regression (`<`, `&`, `"`, `'`, newlines in code-block language and title parameters).
  - [ ] URL spoofing regression (re-uses Stream 1 fixtures).
  - [ ] Raw-HTML disabled by default test.
  - [ ] Allowlisted passthrough test; non-allowlisted error test.
  - [ ] Size cap and `maxNesting` rejection tests.
  - [ ] Failure-mode tests (malformed markdown → error, not silent).

**Acceptance:** ≥80% coverage on `md-to-storage.ts`. All regression tests green. Does not yet need to be wired into `create_page` / `update_page` (Stream 5 does that).

---

## Stream 3 — Storage tokeniser (Opus 4.6)

**Depends on:** Stream 0.

**Goal:** implement `tokeniseStorage(storage)` and the inverse `untokeniseStorage(tokens, sidecar)` machinery.

- [ ] `tokeniser.ts`:
  - [ ] Parse storage XML using `node-html-parser` (already a dep, used by `extractSection`) or a stricter XML parser if needed.
  - [ ] Walk the parsed tree depth-first.
  - [ ] For every `<ac:*>`, `<ri:*>`, `<time>` element (and any other element not in the converter's known-renderable set): assign a token ID (`T0001`, `T0002`, ...), replace the element with `<!--epi:T####-->`, store the element's verbatim outer XML in `sidecar[id]`.
  - [ ] Return `{ canonical: string, sidecar: TokenSidecar }`.
- [ ] `restore.ts`:
  - [ ] `restoreFromTokens(storageWithTokens, sidecar)`: replace every `<!--epi:T####-->` with `sidecar[id]` byte-for-byte.
  - [ ] Validate: any token in `storageWithTokens` not in `sidecar` → `throw ConverterError("forged token T####")` (covers [Security #8](06-security.md#8-token-id-forgery)).
- [ ] Token-comment compatibility verification inside GFM tables (decision in [07-design-decisions.md open #7](07-design-decisions.md#open-questions-for-review)). If `<!--epi:-->` in table cells doesn't survive markdown-it round-trip, switch to a non-comment form (`[[epi:T0042]]`) — document choice in source comment.
- [ ] Unit tests:
  - [ ] Single macro round-trip: tokenise → restore → byte-identical to input.
  - [ ] Nested macros (panel containing code containing emoticon).
  - [ ] `<ac:layout>` with multiple sections and cells.
  - [ ] Drawio macro round-trip.
  - [ ] `<time datetime="..."/>` round-trip.
  - [ ] Token-id-forgery rejection.
  - [ ] Tokens inside table cells round-trip.
  - [ ] Property test (≥1000 random storage samples): `restore(tokenise(s).canonical, tokenise(s).sidecar) === s`.

**Acceptance:** ≥95% coverage on `tokeniser.ts` and `restore.ts`. Property test passes ≥1000 iterations.

---

## Stream 4 — Token-aware write path (Opus 4.6)

**Depends on:** Streams 2, 3.

**Goal:** orchestrate the safe `update_page` flow that satisfies the [data-preservation invariant](01-data-preservation.md).

- [ ] `diff.ts`:
  - [ ] `diffTokens(canonical, callerMd, sidecar): TokenDiff` returns `{ preserved: TokenId[], deleted: TokenId[], reordered: TokenId[], invented: TokenId[] }`.
  - [ ] `invented` = tokens in `callerMd` but not in `sidecar` → caller submitted forged IDs.
- [ ] Update orchestrator (lives in `confluence-client.ts` `updatePage` or a new `update-orchestrator.ts`):
  1. If body looks like markdown (uses Stream 5's strengthened heuristic): fetch current storage, tokenise (Stream 3), produce canonical pre-edit markdown.
  2. Run `diffTokens`.
  3. If `invented.length > 0` → error with token ID list.
  4. If `deleted.length > 0` and `confirm_deletions` is not `true` → error listing what would be removed.
  5. Convert non-token regions of caller's markdown via `markdownToStorage` (Stream 2).
  6. Restore tokens via `restoreFromTokens` (Stream 3).
  7. Compose final storage XML, attach version-message log of deletions (with token IDs only — see [Security #11](06-security.md#11-information-disclosure-via-error-messages)).
  8. Submit via existing Confluence v2 API call.
- [ ] `replace_body: true` opt-out: skips steps 1-6, runs `markdownToStorage` directly on the caller's markdown.
- [ ] Unit tests:
  - [ ] No-op round-trip: `update_page(P, get_page(P).markdown)` produces byte-identical storage to original.
  - [ ] Add new content: caller adds a paragraph; existing macros preserved.
  - [ ] Add new macro via Phase 1 channel: new content emits storage, existing macros preserved.
  - [ ] Explicit deletion with `confirm_deletions: true`: macro removed, version message logs `T####`.
  - [ ] Implicit deletion without `confirm_deletions` → error.
  - [ ] Invented token ID → error.
  - [ ] Token reordering → preserved without log entry.
  - [ ] `replace_body: true` skips preservation.
- [ ] **Round-trip property test (acceptance criterion):** 1000+ randomised real-page samples; assert `update_page(P, get_page(P, format=markdown).markdown)` produces byte-identical storage to original.

**Acceptance:** ≥95% coverage on `diff.ts`, `update-orchestrator.ts`. Property test passes.

---

## Stream 5 — `looksLikeMarkdown` heuristic + tool wiring (Sonnet 4.6)

**Depends on:** Streams 2, 4.

**Goal:** route markdown bodies into the new converter; route storage bodies through the existing path.

- [ ] Strengthen `looksLikeMarkdown` in `confluence-client.ts`:
  - [ ] Strong storage signals (return `false` immediately): presence of `<ac:`, `<ri:`, `<ac:layout>`.
  - [ ] Strong markdown signals: GFM table separator (`|---|`), fenced code block, ATX headings, GitHub alerts, container fences.
  - [ ] Weak/neutral: bare `<br/>`, `<hr/>` in markdown is ambiguous — defer to other signals.
- [ ] Update `create_page` handler in `index.ts` (around [line 217](../../../../src/server/index.ts#L217)):
  - [ ] Apply markdown detection.
  - [ ] If markdown → call `markdownToStorage` (Stream 2).
  - [ ] If storage → existing path.
  - [ ] Add `allow_raw_html: boolean` and `replace_body` parameters (with sensible defaults).
- [ ] Update `update_page` handler in `index.ts` (around [line 374](../../../../src/server/index.ts#L374)):
  - [ ] Replace `looksLikeMarkdown` rejection with routing into Stream 4's orchestrator.
  - [ ] Add `confirm_deletions: boolean` and `replace_body: boolean` parameters.
  - [ ] Update tool description to recommend `update_page_section` for targeted edits.
- [ ] Tests:
  - [ ] Heuristic edge cases (markdown with `<br/>` correctly classified as markdown; storage with `<ac:>` correctly classified as storage).
  - [ ] Integration test: `create_page` with markdown body produces a real page (mock the v2 API).
  - [ ] Integration test: `update_page` with markdown body uses Stream 4 orchestrator.

**Acceptance:** ≥80% coverage on changed code. Integration tests pass.

---

## Stream 6 — `storageToMarkdown` rewrite (Sonnet 4.6)

**Depends on:** Stream 3.

**Goal:** make `get_page(format: markdown)` lossless via tokens (today it strips macros to placeholders).

- [ ] Replace existing `storageToMarkdown` ([confluence-client.ts:1278](../../../../src/server/confluence-client.ts#L1278)) with a new implementation that:
  - [ ] Uses Stream 3 `tokeniseStorage` to extract macros.
  - [ ] Renders the canonical (token-augmented) form to markdown using `turndown` (already a dep) for the parts the converter handles natively.
  - [ ] Returns `{ markdown, sidecar }`.
- [ ] Update `get_page` handler in `index.ts` (around [line 286](../../../../src/server/index.ts#L286)):
  - [ ] When `format: markdown`, return the new structure.
  - [ ] Append a token reference table at the top of the markdown response: `Tokens: T0042 (info macro), T0107 (drawio diagram), …`.
  - [ ] Include `sidecar` in the structured tool result (server-side cache keyed by `(page_id, version)` for `update_page` re-use).
- [ ] Tests:
  - [ ] Page with no macros → markdown identical to old behaviour for the markdown-renderable parts.
  - [ ] Page with macros → tokens appear inline; sidecar populated.
  - [ ] Token reference table is human-readable.

**Acceptance:** ≥80% coverage on changed code. Old `storageToMarkdown` callers updated; no broken references.

---

## Stream 7 — Phase 2: panels via GitHub alert syntax (Sonnet 4.6)

**Depends on:** Stream 2.

- [ ] Custom markdown-it rule recognising `> [!INFO]`, `> [!NOTE]`, `> [!WARNING]`, `> [!TIP]`, `> [!SUCCESS]` at the start of a blockquote.
- [ ] Optional title on the same line: `> [!WARNING] Optional title`.
- [ ] Maps to `<ac:structured-macro ac:name="info|note|warning|tip|success">` with `<ac:rich-text-body>`.
- [ ] Confirm `success` vs `check` macro name against current Confluence Cloud (decision in [07-design-decisions.md open #1](07-design-decisions.md#open-questions-for-review)).
- [ ] Tests: golden-file output for each panel type; nested content; title parameter; absence of title.

**Acceptance:** ≥80% coverage. Golden-file tests for all five panel types.

---

## Stream 8 — Phase 2: containers (Sonnet 4.6)

**Depends on:** Stream 2.

- [ ] Integrate `markdown-it-container` with handlers for `panel`, `expand`, `columns`, `column`.
- [ ] `::: panel title=... bgColor=... borderColor=...` → generic panel macro.
- [ ] `::: expand title=...` → expand macro with `ac:macro-id`.
- [ ] `::: columns` containing `::: column ... :::` blocks → `<ac:layout>` / `<ac:layout-section>` / `<ac:layout-cell>` (two_equal / three_equal based on column count).
- [ ] All parameter values escaped via `escapeXmlAttr` (Stream 1).
- [ ] Tests: golden-file output for each container; parameter escaping; nested containers.

**Acceptance:** ≥80% coverage. Golden-file tests.

---

## Stream 9 — Phase 2: inline directives (Sonnet 4.6)

**Depends on:** Streams 1, 2.

- [ ] Integrate `markdown-it` directive plugin with handlers for `:status`, `:mention`, `:date`, `:emoji`, `:jira`, `:anchor`.
- [ ] `:status[label]{colour=Blue}` → status macro; validate colour against `Grey/Red/Yellow/Green/Blue/Purple`.
- [ ] `:mention[Display]{accountId=...}` → user mention; validate accountId via Stream 1's `isValidAccountId`.
- [ ] `:date[2026-04-30]` → `<time datetime="..."/>`.
- [ ] `:emoji[smile]` → `<ac:emoticon ac:name="smile"/>`; validate against known emoticon set.
- [ ] `:jira[KEY-123]{server=...}` → Jira issue macro; serverId from config (single tenant) or directive param (multi).
- [ ] `:anchor[name]` → anchor macro.
- [ ] Tests: each directive golden-file; invalid input rejection (bad colour, malformed accountId, unknown emoji).

**Acceptance:** ≥80% coverage. Golden-file tests for all six directives.

---

## Stream 10 — Phase 2: frontmatter and ToC (Sonnet 4.6)

**Depends on:** Stream 2.

- [ ] Integrate `gray-matter` to parse frontmatter at the top of markdown bodies.
- [ ] Recognised keys: `toc: { maxLevel, minLevel, style }`, `headingOffset`, `numbered`, `excerpt`.
- [ ] When `toc` present: inject `<ac:structured-macro ac:name="toc">` at the top of the converted body.
- [ ] When `headingOffset: N`: shift all heading levels by N during conversion.
- [ ] Tests: each frontmatter key; absence of frontmatter; invalid frontmatter values.

**Acceptance:** ≥80% coverage. Tests for all keys.

---

## Stream 11 — Phase 3: heading anchor slugger (Sonnet 4.6)

**Depends on:** Stream 2.

- [ ] Implement a slugger that matches Confluence's heading-ID algorithm (research the algorithm via the editor's output; document in source comment).
- [ ] Wire the slugger into `markdown-it`'s heading rule so generated `<h1 id="...">` IDs match what Confluence would produce.
- [ ] Make `:anchor[name]{}` directive (Stream 9) coexist with auto-generated heading IDs.
- [ ] Tests: heading text → expected Confluence ID for representative samples (alphanumeric, spaces, special characters, non-ASCII, duplicates).

**Acceptance:** ≥80% coverage. Slugger algorithm documented.

---

## Stream 12 — Cross-cutting regression suite (Sonnet 4.6)

**Depends on:** Streams 5, 6, 7-11.

**Goal:** the no-loss invariant and backward-compat acceptance criteria from [09-acceptance-criteria.md](09-acceptance-criteria.md).

- [ ] **Round-trip fixture suite:** check the existing `epimethian-mcp/doc/design/investigations/*.md` files into a test fixtures directory. For each, assert that converting markdown→storage→markdown round-trips losslessly through token preservation.
- [ ] **`entrix-network` real-world fixtures:** capture sample outputs from `generate_confluence_page` (overview, account, traffic-flows) into fixtures; assert round-trip.
- [ ] **Drawio coexistence regression:** create a page via `add_drawio_diagram`, then update via markdown `update_page`; assert drawio macro preserved byte-identical.
- [ ] **Attribution footer regression:** confirm `stripAttributionFooter`/`buildAttributionFooter` continue to function; footer not double-applied; footer not lost on token-preserving update.
- [ ] **`writeGuard`/read-only mode regression:** assert that markdown writes are rejected in read-only mode the same way storage writes are.
- [ ] **`update_page_section` regression:** confirm the existing tool still works (Stream 4 changes don't break it).
- [ ] **Performance bound:** 100 KB markdown → <50ms (p95); 100 KB storage tokenise+diff+restore → <100ms (p95). Use `vitest --bench` or a custom timing harness.
- [ ] **Fuzz inputs:** 10,000 random malformed markdown inputs → either valid storage or clean error (no crash, no silent corruption).

**Acceptance:** All regression tests green. Performance bounds met. No fuzz-induced crashes.

---

## Stream 13 — Documentation (Haiku 4.5)

**Depends on:** independent of code (can run in parallel from day 1).

- [ ] `doc/markdown-cheatsheet.md`: copy-paste examples for every supported markdown construct (GFM + extensions) with the resulting Confluence rendering.
- [ ] `doc/data-preservation.md`: tokenisation contract for tool callers; `confirm_deletions` flag; `replace_body` opt-out; how to read the token reference table from `get_page`.
- [ ] `CHANGELOG.md` entry: SemVer **major** bump; "Bodies that look like markdown are now converted; pass storage format verbatim if you need the old behaviour"; link to the new docs.
- [ ] Update tool descriptions in `src/server/index.ts` for `create_page`, `update_page`, `get_page` (note markdown support, recommend `update_page_section`, mention `confirm_deletions` flag).
- [ ] Update top-level `README.md` to reference markdown support.

**Acceptance:** All four docs exist and are reviewed; CHANGELOG entry merged.

---

## Stream 14 — Phase 4: optional helper tools (Sonnet 4.6)

**Depends on:** Stream 0 only (can run any time).

- [ ] `lookup_user(query)` tool: query Atlassian user-search API; return `{ accountId, displayName, email }`.
- [ ] `resolve_page_link(title, space)` tool: query Confluence content API; return `{ contentId, url }`.
- [ ] Tool descriptions explain when to use these vs inline directives.
- [ ] Tests: mocked API responses; error paths.

**Acceptance:** ≥80% coverage. Tools registered and callable.

---

## Coverage strategy — meeting the 80% target

| File / module | Coverage target | Test type |
|--------------|----------------|-----------|
| `escape.ts` | 95% | Unit + regression |
| `url-parser.ts` | 95% | Unit + spoofing regression |
| `account-id-validator.ts`, `filename-validator.ts`, `allowlist.ts` | 95% | Unit |
| `tokeniser.ts`, `restore.ts`, `diff.ts` | 95% | Unit + property |
| `md-to-storage.ts` | 80% | Unit + golden + regression |
| `storage-to-md.ts` | 80% | Unit + round-trip |
| `update-orchestrator.ts` (or `confluence-client.ts` changes) | 80% | Unit + integration + property (1000+ samples) |
| `index.ts` handler changes | 80% | Integration |
| Phase 2 plugins (Streams 7-11) | 80% | Golden-file |
| Phase 4 tools (Stream 14) | 80% | Unit + mocked API |

**Enforcement:** `vitest.config.ts` thresholds set per-file (vitest supports `coverage.thresholds.perFile`); each stream's PR fails CI if its owned files drop below target. Aggregate project coverage gate raised to ≥80% post-merge (currently lower based on existing config — verify and adjust).

## Launch sequence (for a coordinator agent)

1. Launch **Stream 0** alone. Wait for merge. Coverage scaffolding in place.
2. Launch **Streams 1 + 13** in parallel. Stream 13 runs to completion independently of code; Stream 1 blocks Window B.
3. Launch **Streams 2 + 3 + 14** in parallel after Stream 1 merges (Stream 14 only needs Stream 0).
4. Launch **Streams 7 + 8 + 9 + 10 + 11** in parallel after Stream 2 merges. Five-way parallelism, all golden-file work.
5. Launch **Stream 4** after both Streams 2 and 3 merge. This is the data-preservation logic — single agent, Opus, no parallelism with other Stream-4 work.
6. Launch **Streams 5 + 6** in parallel after Stream 4 merges.
7. Launch **Stream 12** last, after all of the above. Single agent runs the full regression suite, fixes any cross-cutting issues found, and signs off the SemVer-major release.

**Total wall-clock estimate (with parallelism):** ~5 windows of work. With agent-execution times of ~30-60 minutes per stream, roughly 3-5 hours end-to-end vs. ~15-20 hours sequential.
