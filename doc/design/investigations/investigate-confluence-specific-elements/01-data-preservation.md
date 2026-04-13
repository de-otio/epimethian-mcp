# Data preservation guarantee (mandatory invariant)

[← Back to index](README.md)

**A page update must never unintentionally remove content from an existing page** — and "content" includes every macro, layout, attachment reference, anchor, comment marker, and embedded element on the page, regardless of whether the converter knows how to represent it in markdown.

This is non-negotiable. It is the design pillar that everything else in this investigation hangs off.

## Failure modes the invariant rules out

1. **Lossy `storageToMarkdown` → `markdownToStorage` round-trip** — the existing [`storageToMarkdown`](../../../../src/server/confluence-client.ts#L1278) replaces macros with summary placeholders. If an agent reads a page in markdown mode, edits it, and writes it back, every macro on the page becomes plain placeholder text. **Forbidden.**
2. **Whole-body replacement when the input does not represent the full body** — `update_page` accepting markdown that is a subset of the page (e.g. "the agent only intended to edit the intro") and writing it as the entire body. **Forbidden.**
3. **Silent stripping of unrecognised storage elements** — converting markdown to storage and dropping any `<ac:>`/`<ri:>` element the converter doesn't model. **Forbidden.**

## Mechanism — opaque-token preservation

Both directions of the converter operate over a **token-augmented markdown** dialect.

### Read path (`get_page` markdown mode, `update_page` pre-fetch)

1. Walk the storage XML.
2. Each element the converter knows how to represent (heading, list, table, fenced code, GFM link, the markdown-shimmed macros) is rendered to its markdown form.
3. Each element the converter does **not** know how to represent — *and the original verbatim XML for every recognised macro* — is replaced with an HTML-comment token: `<!--epi:T0042-->`. The original XML is stored in a sidecar map keyed by the token ID.
4. The markdown returned to the caller contains the tokens in place; the sidecar is returned alongside (or, for `update_page`, kept server-side keyed by `(page_id, version)`).

### Write path (`update_page` with markdown body)

1. Fetch the current storage; tokenise it as in the read path to produce the *canonical pre-edit markdown*.
2. The caller's markdown is parsed; tokens present in the caller's markdown are matched against the sidecar.
3. **Tokens present in the pre-edit canonical and absent from the caller's markdown** are treated as **explicit deletions** — the agent removed the token, so the macro is dropped. This is the only way macros are removed.
4. **Tokens present in both** are restored to their original storage XML byte-for-byte. The converter never re-derives storage XML for a token; preservation is by-reference, not by-equivalence.
5. **New tokens in the caller's markdown** that aren't in the sidecar are an error (the caller cannot invent token IDs).
6. Non-token markdown regions are converted to storage XHTML normally.
7. The result is composed and submitted.

### Create path (`create_page`)

No prior content; no tokens; the converter just renders markdown → storage. The invariant is trivially satisfied.

## Why tokenise even macros the converter *does* know how to render

Two reasons:

- **Bit-perfect preservation.** Confluence editor sometimes produces storage that differs cosmetically from what our converter would emit (whitespace, attribute order, `ac:macro-id` UUIDs). Restoring by-reference avoids spurious diffs that could trip up downstream consumers.
- **Forward compatibility.** New Confluence storage features added between releases are preserved automatically — the converter doesn't need to know about every macro to round-trip it safely.

The markdown form of known macros (e.g. `> [!INFO]`) remains available for *new* content the agent authors. It just isn't used for content that already existed on the page.

## Caller ergonomics

- `get_page` markdown mode: returns markdown with `<!--epi:T####-->` tokens inline. A note at the top of the response lists what each token represents (e.g. `T0042: <ac:structured-macro ac:name="info">`) so an agent can decide whether to keep, remove, or move them. The full sidecar is returned in a structured field of the tool result.
- `update_page` markdown mode: requires the version number (already does); fetches the current storage server-side and rebuilds the sidecar. The caller does not need to round-trip the sidecar — but they must not invent token IDs.
- For agents that want to operate without tokens at all (e.g. wholesale page rewrite): an explicit `replace_body: true` flag opts out of preservation. **Default is off; opting out is loud.**

## Validation gates inside `update_page`

Before submission, the write path enforces:

- Every token in the pre-edit canonical that does *not* appear in the caller's markdown is logged in the version message: `"Removed N preserved elements: T0042 (info macro), T0107 (drawio diagram), …"`. The agent (and any reviewer of page history) can see exactly what was dropped.
- If the dropped count exceeds a configurable threshold (default: any), and `confirm_deletions: true` is not set, the call **errors** with a list of what would be removed and instructions to re-issue with confirmation.
- Token-region edits (text inside a token) are rejected: the agent must remove the token entirely if they want to remove the macro; partial edits to opaque content are ambiguous.
- Token reordering is allowed (an agent moving a panel to a different section is a legitimate edit); reordering is silently accepted, not logged.

## What this does *not* protect against

- A caller passing raw storage format directly (not markdown): they own the body verbatim, no preservation logic runs. This matches the existing contract and is safe because it's explicit.
- [`update_page_section`](../../../../src/server/index.ts#L433): operates on a single section, leaves the rest of the page untouched. This is **the safest path for targeted edits** and should be recommended in tool descriptions.
- Confluence-side automatic rewrites (the editor reformatting storage on save). When a user opens-and-saves a page in the editor, Confluence may rewrite whitespace, attribute order, or `ac:macro-id` UUIDs. A subsequent epimethian round-trip will see those rewrites as "the new canonical" and preserve them — but pre-existing tokenised XML will diverge. This is unavoidable; document it as a known limitation.

## Known limitations of the mechanism

| Limitation | Impact | Mitigation |
|------------|--------|-----------|
| Confluence editor may rewrite storage on save | Tokens generated *before* a human edit may not match storage *after* | Always re-fetch + re-tokenise inside `update_page` (Phase 1 step 7); never cache tokens across calls |
| `ac:macro-id` UUIDs may shift between editor saves | Tokenised XML appears different on next read | Token contents include the UUID; this is part of "byte-identical" preservation. Not lossy, just visible. |
| Tokens inside table cells | GFM tables are sensitive to embedded HTML comments | Use a token form that GFM tables tolerate; verify in tests |
| Very large token sidecar (1000+ macros on a single page) | Memory/wire overhead | Document soft limit (e.g. 500 macros); for pages above that, callers should use `update_page_section` |
