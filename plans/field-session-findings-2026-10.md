# Plan: implement the 2026-10 field-session findings

**Input:** [doc/design/investigations/investigate-field-session-findings-2026-10.md](../doc/design/investigations/investigate-field-session-findings-2026-10.md)
(IDs S1–S7, R1–R5, T1–T6, A1–A5 refer to that document).
**Base:** `master` at f03ee8a (6.10.1).
**Status:** revision 2. A security review and a correctness/parallelisation review of revision 1
were folded in (§9 lists every finding and where it went). Release 7.0.0 is executed by this
plan; 7.1.0 and 7.2.0 are specified here and run later.

## 1. Releases

The investigation's full scope (an HTTP-layer rewrite, offset-mapped matching on the write path,
four new tools, breaking read changes) is more than one verifiable release. Split by risk:

| Release | Contents | Why grouped |
|---|---|---|
| **7.0.0** (this run) | S1 + placeholder/restore fixes, S2, S7, R1, R3, S5, T5, S6, S3/S4/R5/A3/T6 metadata sweep, A5, dependency and vulnerability fixes | Safety fixes and the breaking changes ship together; no new tools, so the metadata sweep sees the final tool set |
| 7.1.0 (later) | A2 (`move_page` same-space, `delete_attachment` trash-only, attachment new version), T3 (`insert_section`, `rename_heading`), T2 (`grep`), R2 (label memo only), A1 low-risk reads (`/direct-children`, versions list, attachments list) | Additive tools; get annotations from `tool-meta.ts` from the start |
| 7.2.0 (later) | T1 `compact` (strip `local-id`/`ac:local-id` only, with a read-only marker), T4 entity-tolerant matching on the tokenised canonical, R4 if the badge-version issue is resolved | Write-path matching changes, isolated so they can be verified alone |

**Deferred indefinitely (with reason):** A1 historical-body reads (`revert_page` writes what this
read returns; open question 2 needs live verification); attachment purge (irreversible); A4
(unverified); the 2026-07-28 protocol spike (no SDK support yet); fast-accept elicitation
detection (security review L6, no reliable signal yet); `excerpts` default stays on.

**Version:** 7.0.0. `find_replace` now rejects calls 6.x accepted (multiple matches without
`replace_all`, duplicated macros), and section/markdown reads are now fenced (output shape
change). Precedent: 6.0.0 "agent-safety hardening".

## 2. 7.0.0 dependency DAG

```
Phase 0 (orchestrator, sequential, on branch release/7.0.0)
  │  deps + audit, fast-check, tool-meta.ts, commit plan + investigation
  ▼
Wave 1: 4 lanes, ≤4 concurrent agents, each in its own worktree off release/7.0.0
  lane A: W-FR (S1, placeholders, restore, fence-equivalent match) ──► W-MULTI (R3, aggregate guard)   [same agent, two commits]
  lane B: W-HTTP (R1, S7) ──► W-DIFF (S6)
  lane C: W-SCOPE (S5, T5, space-id fix) ──► W-DEPS (gray-matter replacement)
  lane D: W-READ (S2)
  ▼
I1 integration barrier: merge HTTP, DIFF, DEPS, SCOPE, READ, FR in that order; build + typecheck +
   scoped tests after each, full suite with coverage at the end
  ▼
Wave 2: W-META (single agent, whole tree: S3, S4, R5, A3, T6, download_attachment rule)
  ▼
Wave 3: coverage gate + test-critic on FR/MULTI, HTTP, SCOPE, READ → fix agent
  ▼
Wave 4 (parallel): W-DOCS (D1, D2, D3)  ∥  W-REVIEW (security + data-loss, read-only)
  ▼
Review fixes → docs touch-up → full suite
  ▼
Human checkpoint: push, GitHub release, npm publish (CI), install, alert check
```

Why each edge exists:

- **Lanes are sequential inside** so at most four agents run tests at once (fan-out rule: CPU
  saturates before RAM).
- **W-MULTI after W-FR**: R3 calls the find engine W-FR builds and shares its gate.
- **W-DIFF after W-HTTP**: both edit `confluence-client.ts`; serialising them in one lane avoids
  a merge in neighbouring hunks.
- **W-DEPS after W-SCOPE**: only for the concurrency cap; no code dependency.
- **W-META after I1**: it edits every `registerTool` block, which every Wave 1 lane touches.
- **W-READ ∥ W-FR** via an explicit contract (§3 "Placeholder base"), not a shared function.
- **W-REVIEW ∥ W-DOCS**: the review is read-only; the docs get a touch-up after review fixes.

## 3. Cross-workstream contracts

1. **Placeholder base.** Placeholders (`[[epi:Tnnnn]]`) are numbered by tokenising the
   **section body with the heading excluded** (`extractSectionBody`). The markdown section view
   (W-READ), the find engine (W-FR) and body-mode `planUpdate` (W-FR) all use this base. The
   markdown section view renders the heading line separately and tokenises only the body.
   The markdown view is the only read that shows placeholders; storage reads show raw macros.
2. **Fence-equivalent matching.** The fence (`sanitiseTenantText`) applies NFKC and strips
   control/zero-width/bidi/tag characters, so text an agent copies from a fenced read can differ
   from the stored bytes. The find engine defines the view transform
   `V(s) = concat over code points c of NFKD(c), minus the fence strip set`, applied to both the
   tokenised canonical and the `find` string. Each original code point maps to a contiguous range
   of the view, which gives the offset map. `NFKD(NFKC(x)) = NFKD(x)`, so text folded by the
   fence matches its source. Rules:
   - Try an exact byte match first. Use the view match only if the exact count is 0.
   - When the exact count is 1 or more, also count in view space. If the view count is higher
     than the exact count and `replace_all` is not set, throw `FIND_REPLACE_AMBIGUOUS` with both
     counts: the agent read the text through the fence and cannot tell the exact copy from a
     folded twin (e.g. NBSP vs space). Exact-first only picks the bytes when the counts agree.
     Exception: a `find` the fence would change (it holds an NBSP, an ellipsis, a zero-width
     character…) was not copied from a read, so its bytes are deliberate and the exact match
     stands. (In practice only an exact count of 1 needs the check; 2+ is already ambiguous.)
   - A view match must start and end on code-point piece boundaries and must not partly overlap
     a placeholder.
   - "Exactly once" is counted in the space that matched, **including overlapping occurrences**.
   - When the view match is used, the result says so ("matched after Unicode compatibility
     normalisation").
   - **Byte preservation:** the longest common prefix and suffix of `find` and `replace`
     (compared in view space) keep the original stored bytes; only the differing middle takes
     the caller's bytes. Anchor-style inserts (`replace = find + new`) therefore never rewrite
     the anchor.
3. **Restore is single-pass.** Every path that restores placeholders uses `restoreFromTokens`
   (restore.ts), not repeated `split/join`.
4. **Results declared with `outputSchema` must carry `structuredContent` on every non-error
   result.** Otherwise the SDK replaces the result with "Output validation error" after the
   write has happened, and the agent retries. Confirmation paths go through
   `formatSoftConfirmationResult`. `output-schema-conformance.integration.test.ts` covers every
   new result path.
5. **Tests for new behaviour go in new test files** named after the workstream
   (`find-replace-engine.test.ts`, `read-fencing.integration.test.ts`, `http-policy.test.ts`,
   `cql-scope.test.ts`, …), not appended to `index.test.ts`. If a handler imports a new export
   from `confluence-client.ts`, add it to the hand-written mock block in `index.test.ts`
   (lines ~63–162); the integrator resolves those small conflicts.
6. **Module singletons** (semaphore, outcome-unknown set, space-key cache) export
   `_resetForTests()`.

## 4. Phase 0 (orchestrator)

1. Branch `release/7.0.0` from master.
2. Investigation doc: drop the content language from the Context paragraph (security review
   L7). Commit it and this plan.
3. Dependencies:
   - `@modelcontextprotocol/sdk` to the latest 1.x (1.32.1), floor `^1.32.1`; zod floor `^3.25.0`
     (the SDK's peer range).
   - `npm audit fix` (non-breaking only) for `proxy-addr` (critical), `source-map-js` (high),
     `fast-uri`, `ip-address`.
   - devDependency `fast-check` (property tests).
   - The `gray-matter → js-yaml@3 → argparse@1 → sprintf-js` chain has no patched release; W-DEPS
     removes gray-matter.
   - Re-run `npm audit`; the only remaining entries may be that chain.
4. `src/server/tool-meta.ts`, pure and unit-tested: `readOnlyTool(title)`,
   `writeTool(title, {idempotent})`, `destructiveTool(title, {requiresUserInteraction})`. Each
   returns `{ title, annotations: {title, readOnlyHint, destructiveHint, idempotentHint,
   openWorldHint: true}, _meta? }`. Top-level `title` is set, because the SDK emits it as
   `Tool.title`. SDK facts verified in review: `registerTool` accepts `annotations` and `_meta`
   and emits both in `tools/list` (sdk `mcp.js:71-86, 703`).
5. `npm ci`, build, full suite, commit. Worktrees get `node_modules` with `npm ci` (offline
   cache) as their first step.

## 5. Workstreams (7.0.0)

Each agent: its own worktree off `release/7.0.0`, branch `ws/<id>`, local commits only.

### W-FR then W-MULTI · Opus, high (lane A, one agent, two commits)

**W-FR (S1 and the placeholder/restore defects).** Files: `safe-write.ts`, `index.ts`
(`update_page_section` find_replace branch and its `computeDiffHash` call), `update-orchestrator.ts`
(body-mode base), `converter/tokeniser.ts` if needed, new tests.

1. New pure engine `applyFindReplace(sectionBody, pairs) → { body, perPair: [{matched: "exact"|"normalised", count}], lostTokens, duplicatedTokens }`
   following contract 2. 0 matches → `FIND_REPLACE_MATCH_FAILED`. More than 1 without
   `replace_all: true` → `FIND_REPLACE_AMBIGUOUS` with the count. Pairs apply in order on the
   running form, and the offset map is rebuilt after each pair.
2. **Literal placeholders on the page (H2).** If the tokenised canonical contains more
   `[[epi:` occurrences than the sidecar has entries, refuse with `PLACEHOLDER_LITERAL_IN_PAGE`.
   No silent duplication.
3. **Restore** with `restoreFromTokens` (contract 3). A placeholder in `replace` that is not in
   the sidecar → `FORGED_TOKEN`.
4. **Placeholder multiset.** Lost placeholders become `DeletedToken[]` and go through the
   existing `confirm_deletions` gate (forecast, elicitation or soft token, `batch_token`),
   exactly as body mode. Duplicated placeholders are always rejected (no escape hatch: copies
   would duplicate `ac:macro-id`).
5. **`version: "current"`** is rejected when any `find` or `replace` contains a placeholder:
   placeholder ids are positional and could shift between read and write.
6. **Guards (M1).** Do not route through `safePrepareBody`: it would markdown-convert bare text
   fragments. Instead:
   - run `detectUntrustedFenceInWrite` and the read-only-markdown check on each `replace` and
     on their concatenation;
   - check that the count of fence markers and canary occurrences does not grow from the old
     body to the new one;
   - run `enforceContentSafetyGuards(oldFull, newFull)` page-relative, with the same
     shrinkage/structure/deletion flags and gate as body mode.

   Pages that merely contain fence text stay editable.
7. **Confirmation binding (H1).** The diff hash for every section write (body mode and
   find_replace) covers canonical JSON of {tool, page id, section name, `find_replace` pairs
   with flags or the body, SHA-256 of the resulting full storage, page version}. A token minted
   for one call is rejected for any other.
8. **Additive bodies (H2).** `safePrepareBody` with `scope: "additive"` rejects `[[epi:` in the
   input (append/prepend could otherwise plant literals).
9. Body-mode `planUpdate` uses the placeholder base from contract 1.
10. Correct the "non-destructive" comment. Every new result path follows contract 4.

Tests (each must fail on the old code):
- two matches rejected; overlapping `"aa"` in `"aaa"` is ambiguous; `replace_all` reports the count;
- dropped placeholder hits the gate; duplicated placeholder rejected; forged placeholder rejected;
- literal `[[epi:T0001]]` in a paragraph refused; literal placeholder inside a code macro's CDATA is not expanded;
- canary or fence marker in `replace` rejected; a page containing fence text is still editable;
- a token minted for pair set A is rejected for pair set B and for another section;
- `version: "current"` with a placeholder rejected;
- markdown section view and body mode agree on ids when the heading contains a macro;
- a fenced section read containing `…`, NBSP, `²` and a zero-width space round-trips into a successful find_replace that leaves those bytes unchanged outside the edited middle;
- property tests (fast-check, fixed seed): the macro multiset is invariant when no placeholder appears in find or replace; bytes outside the mapped range are unchanged; the offset map is monotone.

**W-MULTI (R3 and the multi-section guards), second commit.** Files: `safe-write.ts`
(`safePrepareMultiSectionBody`), `index.ts` (`update_page_sections`).

1. Each entry is `{section, body}` or `{section, find_replace}`, exactly one of the two. Find-replace
   entries use the engine. One PUT, one version. All-or-nothing with the existing
   `MULTI_SECTION_FAILED` shape.
2. **Aggregate guard (M10):** `enforceContentSafetyGuards(currentStorage, merged)` once on the
   merged result, in addition to the per-section checks. This also fixes body-only calls.
3. **Section-qualified ids:** deleted-token ids and itemised acks are qualified by section, because
   `T0001` repeats across entries.
4. The diff hash covers every entry (contract per W-FR item 7).
5. Tests: five sections each removing 15% trip the aggregate guard; R3 happy path makes one PUT;
   a mixed failure writes nothing.

### W-READ · Sonnet, high (lane D)

S2. Files: `index.ts` (`get_page`, `get_page_by_title`), `confluence-client.ts` (`formatPage`
area), `converter/untrusted-fence.ts` (sole owner in this wave), new
`read-fencing.integration.test.ts`.

1. One helper, `renderBodyResult(page, content, {kind, section?, truncation?})`, used by every
   body-returning path of `get_page` and `get_page_by_title`: section (storage and markdown),
   markdown, and truncated. Content always goes inside `fenceUntrusted`.
   (`get_page_version` has none of these options and is already fenced.)
2. Markdown section view per contract 1 (heading rendered separately, body tokenised).
3. `get_page_by_title` applies `effectiveMaxReadLength` like `get_page` (today it skips the
   default cap).
4. Error messages that echo tenant heading text (for example the heading-ambiguity error,
   confluence-client.ts:~2161) pass that text through `sanitiseTenantText` and quote it.
5. Test with the real client and a mocked `fetch` (not `index.test.ts`, where `formatPage` is
   mocked): every combination of `section`, `format`, `max_length` (under/over/0) and
   `headings_only` on both tools asserts that the fence and canary are present and that the body
   appears only inside the fence. Update the existing index tests that depend on the old unfenced
   text.

### W-HTTP then W-DIFF · Sonnet, high (lane B, one agent, two commits)

**W-HTTP (R1, S7).** Files: `confluence-client.ts` (`confluenceRequest`, download loop ~1430,
`uploadAttachment` ~1558, `_rawUpdatePage` 409 handler), new pure `request-policy.ts`,
`index.ts` comment fan-out (~3656), `page-cache.ts` / mutation log only for outcome-unknown.

1. **Timeouts** via `AbortSignal.timeout`: 30 s for reads, 60 s for writes, 120 s for attachment
   transfer. A single env var `EPIMETHIAN_HTTP_TIMEOUT_MS`, bounded to 5 s–300 s, scales the
   read timeout; the others keep their ratio.
2. **Outcome unknown (M6).** A timeout or network error after a write was sent:
   - throws `WriteOutcomeUnknownError` ("the write may have been applied; re-read before retrying");
   - is logged in the mutation log as `outcome: "unknown"`;
   - evicts the page cache entry and calls `invalidateForPage`;
   - marks the page so this process refuses `version: "current"` writes to it until a fresh
     `get_page` (prevents a double append or a double find_replace).
3. **Retry:** GET and HEAD only, on 429 or 503, only with a parseable `Retry-After` (seconds or
   HTTP date) of 60 s or less, at most 3 attempts, full jitter. Clock, sleep and random are
   injectable. Never retry PUT, POST or DELETE. Keep `setContentState`'s existing 409 retry
   (it re-reads the version) and document the exemption.
4. **Concurrency:** a process-wide semaphore (default 6, acquire timeout 30 s) around every
   `fetch`, including the three raw sites.
   - A permit covers the fetch and the body read; it is released in `finally`, also when the
     body is never read (`v2Delete`).
   - The permit is released before any `Retry-After` sleep.
   - No request is made while a permit is held.
   - The comment-reply fan-out is chunked.
   - Fake responses may lack `headers`, so use `res.headers?.get`.
5. **S7:** in `_rawUpdatePage`'s 409 handler, if the re-read version equals the attempted
   version, the 409 is not a stale-version conflict. If, in addition, the body mentions
   approval/publishing, throw `ConfluenceApprovalRequiredError`; otherwise throw a generic
   non-retryable conflict that says the version is current. Body text is only a hint.
   Never surface a "retry with version N" hint in this case.
6. Error bodies stay sanitised; no auth headers in logs.

**W-DIFF (S6), second commit.** Files: `diff.ts`, `confluence-client.ts` (`toMarkdownView`), new
shared pure `storage-normalise.ts` (`stripVolatileAttributes`, reused in 7.2 by T1/T4),
`index.ts` (`diff_page_versions`).

1. `stripVolatileAttributes(storage)` removes `local-id`, `ac:local-id` and `ac:macro-id`.
   It is CDATA-aware (use the existing CDATA masking) and used for comparison only.
2. Always compare the normalised storage too. If the text diff is empty but storage differs,
   report "No text changes; N macro/attribute changes in: <names>". Macro names are restricted
   to `[A-Za-z0-9_-]`. "No changes." only when the normalised storage is equal.
3. `format: "storage"` returns a unified diff of the normalised storage, split at block-tag
   boundaries before `diffLines`. Input is capped before diffing, not only output. The result
   is fenced.
4. `toMarkdownView` renders the rich-text bodies of `info|note|warning|tip|panel|expand` as
   labelled block quotes, built on the HTML parser (the current non-greedy regex mishandles
   nested macros). Add a performance test with nesting. `get_page_version`'s markdown output
   changes too; note it in the CHANGELOG.

### W-SCOPE then W-DEPS · Sonnet, high / medium (lane C, one agent, two commits)

**W-SCOPE (S5, T5, M13).** Files: `src/shared/profiles.ts`, `space-allowlist.ts`, new pure
`cql-scope.ts`, `index.ts` (`search_pages` and its result formatting), new tests.

1. **Space id vs key (M13).** `resolvePageSpace` returns the v2 numeric `spaceId`, but the
   allowlist holds keys. Resolve id → key (cached, tenant-scoped) before comparing. Test with a
   numeric `spaceId` fixture, and fix the existing fixtures that hide the bug. If this shows the
   `spaces` allowlist currently rejects every write, record that in the CHANGELOG as a fix.
2. **Profile settings** (`read_spaces?: string[]`, `read_spaces_enforced?: boolean`), validated
   like `spaces`. They are set by editing the profile registry JSON, as `spaces` is; there is no
   CLI flag to mirror.
   - When `read_spaces` is set, `search_pages` scopes CQL unless the call passes
     `all_spaces: true`.
   - `read_spaces_enforced: true` makes `all_spaces` an error. That mode is the consultant's
     boundary; the default mode is hygiene only.
3. **CQL scoping (M7).**
   - Parse quoted literals in both `'` and `"` with backslash escapes.
   - Reject when the parenthesis depth goes below zero at any point, or ends non-zero, outside
     literals.
   - Split a trailing `ORDER BY` and validate it against `ORDER BY field [ASC|DESC] (, field [ASC|DESC])*`.
   - Emit `(<cql>) AND space in ("K1","K2") <order by>`, with keys escaped by `escapeCqlString`.
   - Property test: no input accepted by the scoper yields results outside the scope, checked
     with a small CQL precedence model.
4. `excerpts: boolean` (default true). Strip `@@@hl@@@` and `@@@endhl@@@`.
5. **`redact_patterns`** (profile; literal strings, 1–200 chars each, at most 100). Order:
   1. strip the highlight markers;
   2. decode entities;
   3. NFKC and the fence strip set;
   4. match an escaped-literal RegExp with flags `giu` (ReDoS-free, no `toLowerCase` length
      drift);
   5. replace matches with `[redacted]`.

   Applies to search titles and excerpts only, never to page bodies. Patterns never appear in
   errors or logs.
6. **T5:** one `fenceUntrusted` call per result block (title, excerpt, metadata), so the canary
   appears once per result. Do not change `fenceUntrusted`'s signature.

**W-DEPS (gray-matter), second commit.** Files: `package.json`, `package-lock.json`,
`converter/md-to-storage.ts`, tests.

Replace `gray-matter` with a small frontmatter splitter (keep the existing `frontmatterRe`
gate) plus `js-yaml@4` `load` with `JSON_SCHEMA`: no custom types, no JS engines. This also
removes gray-matter's latent `---js` engine. Behaviour for `toc` and `headingOffset` is
unchanged. Add tests for malformed YAML, the `...` terminator, a bare `---` horizontal rule, and
YAML anchors/aliases (bounded). `npm audit` must report 0 vulnerabilities afterwards.

### I1 integration (orchestrator; Opus/high integrator agent for any conflict in guard code)

Merge order: HTTP+DIFF, SCOPE+DEPS, READ, FR+MULTI. After each merge: `npm run build`
and the scoped tests of the touched files (`tsc --noEmit` is not a gate: about 20 errors predate this work, mostly in test files; CI never ran it; agents must not add new ones in files they touch). After the last merge: the full
suite with coverage. A conflict in `safe-write.ts`, `untrusted-fence.ts` or the gate code is
never resolved by taking one side wholesale.

### W-META · Sonnet, high (Wave 2, single agent)

1. **Annotations.** Every tool uses `tool-meta.ts`. The exact annotation table lives in the test,
   not just "present". Notable rows:
   - `download_attachment`: `readOnlyHint: false, destructiveHint: true` (H5). It writes local
     files and can overwrite them.
   - `revert_page`: `destructiveHint: true`.
   - `upgrade`: `readOnlyHint: false`. It is a deliberate exception that stays in `READ_ONLY_TOOLS`.
   - `lookup_user`, `resolve_page_link`, `get_version`: read-only (R5).
2. **`_meta["anthropic/requiresUserInteraction"]: true`** on `delete_page`, `revert_page`,
   `delete_comment`, `authorise_destructive_writes` and `upgrade` (M12; `upgrade` runs
   `npm install -g`). Server-side gates are unchanged; annotations are untrusted hints.
3. **`download_attachment` server rule (H5):** refuse destinations under dot-directories
   (`.git`, `.claude`, `.github`, `.vscode`, any `.`-prefixed path segment) and never set
   executable modes. This goes in `safe-fs.ts` with tests.
4. **Descriptions.** Every description, measured *after* `withDestructiveWarning` /
   `withUntrustedNote` in both lock states, is at most 1,800 chars. Those wrappers now
   **prepend** their safety text. Worked examples move to `install-agent.md` (and
   `src/cli/agent-guide.ts` if it mirrors them). Add `all_spaces` and `replace_all` to
   `UNTRUSTED_CONTENT_PARAGRAPH`'s escalation-flag list. The recovery server's instructions are
   also capped at 1,800 chars (the main server sets none).
5. **New `tool-surface.test.ts`**, using a real `McpServer` + `InMemoryTransport` + `Client`:
   - a golden list of tool names in registration order;
   - the exact annotation and `_meta` table;
   - description lengths;
   - `KNOWN_TOOLS` equals the registered set (today it misses `update_page_sections` and
     `authorise_destructive_writes`; fix that);
   - every tool is in exactly one of `READ_ONLY_TOOLS` / `WRITE_TOOLS` or in an explicit
     always-on set;
   - `callTool` with bad arguments returns `isError: true` (a regression test; the SDK already
     does this);
   - the recovery server's `setup_profile`;
   - `src/cli/setup.ts` `TOOLS` matches, or the test documents it as cosmetic;
   - install-agent.md's tool table and count match (the existing check in `install-agent.test.ts`
     stays green).
6. Open question 1 (are parameter descriptions truncated?) is recorded as unresolved in the docs.
   Long parameter descriptions are kept short as a precaution.
7. T6: tool order is registration order (already deterministic); the golden list pins it.
   `structuredContent` stays lean: no full bodies echoed.

### Wave 3: coverage and test critique

1. Orchestrator: `npm test -- --coverage`. The existing thresholds stay (`src/server/**` ≥ 80%).
   Add 95% per-file thresholds for `tool-meta.ts`, `request-policy.ts`, `cql-scope.ts` and
   `storage-normalise.ts`, and for the find engine if it is a separate module.
2. A `test-critic` agent reviews the tests of W-FR/W-MULTI, W-HTTP, W-SCOPE and W-READ. A
   Sonnet/high agent adds what it finds missing, then the suite is re-run.

### Wave 4 (parallel)

- **D1 (Sonnet, medium):**
  - README: token-efficiency list, the R3 claim (now true), find_replace semantics, profile
    settings `read_spaces`, `read_spaces_enforced`, `redact_patterns`;
  - `doc/user-doc/tools-reference.md`;
  - `install-agent.md`.
- **D2 (Sonnet, medium):**
  - `doc/design/03-tools.md` and `11-safety-guards.md`;
  - `security/03-write-safety.md` (find_replace gate, confirmation binding, placeholder literals,
    `requiresUserInteraction`);
  - `security/04-input-validation.md` (CQL scoping, redaction);
  - `security/06-limitations.md` (annotations are untrusted; read scope is hygiene unless
    enforced; outcome-unknown writes; NFKC folding of reads);
  - `CHANGELOG.md` 7.0.0 with a **Breaking** section.
- **D3 (Haiku, low):**
  - the A5 correction in `investigate-bulk-operations.md`;
  - the investigation's status, set to "7.0.0 implemented: …; 7.1.0/7.2.0 planned: …; deferred: …"
    with links to this plan.
- **W-REVIEW (Opus, high, read-only, two agents):** a security review, and a data-loss walk of
  every mutation path in `git diff master...release/7.0.0` (read/write races, API semantics,
  partial writes, conversion loss, guard bypass). Findings are fixed by an Opus/high agent;
  docs are touched up; the full suite runs once more.

## 6. Model and effort summary

| Task | Model | Effort |
|---|---|---|
| Phase 0, integration merges | orchestrator | – |
| W-FR + W-MULTI | Opus | high |
| W-READ, W-HTTP + W-DIFF, W-SCOPE + W-DEPS, W-META, test fixes | Sonnet | high |
| D1, D2 | Sonnet | medium |
| D3 | Haiku | low |
| Integrator (guard-code conflicts), W-REVIEW, review fixes | Opus | high |
| Test critique | test-critic agent | – |

## 7. Engineering rules for every agent

- TypeScript strict; let inference work. New logic goes in pure modules; I/O stays in
  `confluence-client.ts` and the handlers. Data is immutable; any mutation gets a one-line reason.
- Match the surrounding idiom and comment density. Reuse `escapeCqlString`, `tokeniseStorage`,
  `restoreFromTokens`, `enforceContentSafetyGuards`, `detectUntrustedFenceInWrite`, the deletion
  gate, `toolError`, `formatSoftConfirmationResult`. Do not fork them; a one-line `export` of an
  existing private helper is fine.
- Every page **body** write goes through `safeSubmitPage` (`no-direct-raw-writer.test.ts`).
- Tests fail on the pre-change code and cover failure paths and boundaries. Freeze clocks, use
  fixed fast-check seeds, inject random and sleep, mock `fetch`. No live network.
- **One test run at a time per agent:** `npx vitest run --maxWorkers=2 <files>`. Never the full
  suite; the orchestrator runs it. No piping output through `tail`/`head`/`grep`.
- No customer, employer or person names. Fixtures use `example.com` and space keys such as
  `DOCS`/`TEAM`, with numeric space ids.
- Never push, tag, publish or call a live tenant. Never prompt. Resolve ambiguity with the most
  conservative safe default and list it as an assumption in the final report.
- Final report: files changed, test files and names added, assumptions, anything not done.

## 8. Resource budget and human checkpoint

**Resources:** 32 GB RAM, 12 cores. At most 4 concurrent test-running agents (the lane
structure enforces it), scoped vitest only. During each wave the orchestrator runs a watchdog
(`vm.loadavg`, `memory_pressure`). It acts when the 1-minute load stays above 16 or free memory
falls below 15%.

**Human checkpoint** (requested by the user; the egress guard may still ask):

1. Fast-forward `master` to `release/7.0.0` locally; `git push origin master` to
   `de-otio/epimethian-mcp` (public).
2. `gh release create v7.0.0 --repo de-otio/epimethian-mcp`, which triggers `publish.yml`
   (npm with provenance).
3. When npm serves 7.0.0: `npm install -g @de-otio/epimethian-mcp@7.0.0`, then
   `epimethian-mcp --version`.
4. Re-check Dependabot, code-scanning and secret-scanning alerts; dismiss or fix any that remain.

## 9. Review findings and where they went

Security review (S) and correctness review (C):

| Finding | Disposition |
|---|---|
| S-H1 / C3 token not bound to pairs or section | W-FR 7, W-MULTI 4 |
| S-H2 / C5 literal placeholders, multi-pass restore | Contract 3, W-FR 2–3, 8 |
| S-H3 normaliser on raw storage, numeric entities | 7.2.0 T4 on the tokenised canonical; excludes every form of `< > & " '`, invalid code points, bidi/control |
| S-H4 `move_page` exposure | 7.1.0: same-space only, inherited-restriction comparison with gate, `destructiveHint` + `requiresUserInteraction`, evict space cache |
| S-H5 `download_attachment` hints and path | W-META 1, 3 |
| S-M1 / C6 guard routing | W-FR 6 |
| S-M2 overlap counting, "current" + placeholders | Contract 2, W-FR 5 |
| S-M3 / C2 NFKC read vs match | Contract 2 (view transform, byte preservation) |
| S-M4 / C12 compact strips macro-id | 7.2.0: `local-id` only, read-only marker, CDATA-aware |
| S-M5 / C7 badge skip | R2 badge skip dropped; 7.1.0 memoises only the legacy-label check; R4 → 7.2.0, conditional |
| S-M6 outcome unknown, semaphore | W-HTTP 2, 4 |
| S-M7 / C17 CQL depth, redaction | W-SCOPE 3, 5; `read_spaces_enforced` added |
| S-M8 delete_attachment / replace_existing | 7.1.0: container fail-closed, page id + version check, admin-only trash restore stated, sanitised filename in prompt, budget + log for uploads, filename lookup by filter |
| S-M9 / C15 non-body writes | §7 rule restated; 7.1.0 shared wrapper (budget, log, `invalidateForPage`) and raw functions added to `no-direct-raw-writer.test.ts` |
| S-M10 aggregate guard, id collisions | W-MULTI 2–3 |
| S-M11 structural edits | 7.1.0: byte-equal prefix/suffix, `after_heading` = end of that heading's section, no level takeover, tokenised heading rename, escaped and fence-checked headings, duplicate warning |
| S-M12 / C18 wrappers at end, flags, upgrade | W-META 2, 4 |
| S-M13 / C15 spaceId vs key | W-SCOPE 1 |
| S-L1 tenant text in errors | W-READ 4 (rest with each 7.1.0 tool) |
| S-L2 / S-L3 diff names, size, regex | W-DIFF 2–4 |
| S-L4 grep byte cap | 7.1.0 T2 |
| S-L5 R4 cache holds sent body | 7.2.0 note |
| S-L6 fast accept | Deferred (§1) |
| S-L7 language fingerprint | Phase 0 step 2 |
| C1 eight concurrent test agents | Four lanes (§2) |
| C4 numbering location, body mode | Contract 1, W-READ 2, W-FR 9 |
| C8 output-validation trap | Contract 4 |
| C9 shared registries, test mocks, install-agent check | Contract 5, W-META 5; new tools move to 7.1.0 |
| C10 fetch sites, 409 hunk overlap | W-HTTP owns all fetch sites; W-DIFF serialised in the same lane |
| C11 S7 classification | W-HTTP 5 |
| C13 duplicated attribute stripping, nested regex | W-DIFF 1, 4 (`storage-normalise.ts`) |
| C14 W-READ assumptions | W-READ 1, 3, 5 |
| C16 W-STRUCT spec | 7.1.0 (see S-M11), reuse `locateSectionRange` |
| C19 DAG fixes | §2 |
| C20 dropped items | A1 low-risk → 7.1.0; open question 1 → W-META 6; structuredContent → W-META 7; T6 trade-off noted under 7.1.0 (+4 tools) |
| C21 `allow_duplicate_macros` | Dropped (W-FR 4) |
| C22 setup.ts TOOLS | W-META 5 |
| SDK: validation already `isError` | W-META 5 regression test only |
| SDK: zod floor | Phase 0 step 3 |
| C release split | §1 |
| User: Dependabot and vulnerabilities | Phase 0 step 3, W-DEPS, checkpoint 4 |
