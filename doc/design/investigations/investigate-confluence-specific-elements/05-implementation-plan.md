# Implementation plan

[← Back to index](README.md)

Four phases. Phase 1 is mandatory before any markdown body is accepted by `create_page` or `update_page`; Phases 2–4 can be sequenced based on team appetite.

## Phase 1 — Core converter + token preservation (unblocks the bug, satisfies the data-preservation invariant)

1. Add `markdown-it` (preferred over `marked` for plugin extensibility — see [alternatives](08-alternatives-considered.md)) as a runtime dep.
2. Replace `toStorageFormat()` with a `markdownToStorage()` function that runs `markdown-it` with GFM (tables, strikethrough, autolinks, task lists) and post-processes:
   - Self-close void elements (`<br/>`, `<hr/>`, `<img/>`).
   - Convert fenced code blocks → `<ac:structured-macro ac:name="code">` with language parameter (CDATA-safe: split `]]>` into `]]]]><![CDATA[>` — see [Security #1](06-security.md#1-cdata-injection-in-code-blocks)).
   - Convert inline `<a href>` to a strictly-parsed Confluence base URL (host equality after canonicalisation) → `<ac:link>` with `ri:content-id`.
   - Escape `&`, `<`, `>`, `"` in every attribute value and `<ac:parameter>` text (panel titles, status labels, mention display text, expand titles, page-link titles, image filenames).
3. Disable raw HTML in markdown-it (`html: false`) by default. Add an opt-in `allow_raw_html` flag for trusted callers that documents the XSS implications.
4. Detect markdown via `looksLikeMarkdown()`; strengthen the heuristic so that `<ac:`/`<ri:`/`<ac:layout>` are treated as strong storage signals while bare `<br/>` is not. Route to the converter instead of rejecting.
5. Apply symmetrically to `create_page` and `update_page`.
6. **Implement the storage→token tokeniser**: walk the storage XML, replace every `<ac:>`/`<ri:>` element (and any other element the converter can't represent) with `<!--epi:T####-->` tokens; build the sidecar map. This is required for safe `update_page` and for `get_page` markdown mode.
7. **Implement the markdown→token write path inside `update_page`**: fetch current storage, tokenise, diff caller's markdown against the canonical pre-edit markdown, restore tokens by reference, log explicit deletions in the version message, gate large deletions behind `confirm_deletions: true`.
8. **Allowlisted raw-storage passthrough** for new content (see [Channel 4](04-markdown-syntax-design.md#channel-4--allowlisted-raw-storage-format-escape-hatch-for-new-content)). This is **not** a substitute for the tokeniser.
9. **Failure mode is fail-loud, never silent**: malformed markdown, unknown directive, unbalanced container fence, or any conversion that would lose data → error with actionable message. No fallback to plain `<p>` wrap.
10. Unit tests against representative samples covering every transformation; round-trip property tests asserting bit-identical preservation; CDATA-injection regression test (`]]>` in code body); attribute-injection regression test (`<`, `&`, `"` in panel title); URL-spoofing regression tests; fuzz inputs.

This phase fixes the bug, produces correct pages for new content, **and** guarantees no data loss on updates.

## Phase 2 — Native macros via markdown extensions (richer authoring)

11. Add markdown-it plugin for **GitHub alert syntax** (`> [!INFO]` etc.) → panel macros.
12. Add markdown-it-container plugin → support `::: panel`, `::: expand`, `::: columns`/`::: column`.
13. Add markdown-it-directive plugin → support `:status[...]{}`, `:mention[...]{}`, `:date[...]`, `:emoji[smile]` (→ `<ac:emoticon>`), `:jira[KEY-123]` (→ Jira issue macro), `:anchor[name]` (→ `<ac:structured-macro ac:name="anchor">`).
14. Frontmatter support (gray-matter) → ToC injection, future per-page config.
15. Tests per macro type, including round-trip preservation (Phase 1 tokens still apply for pre-existing instances; the new shims only affect freshly-authored content).

## Phase 3 — Editor-fidelity and dynamic-content macros

16. Heading anchor IDs: pin the slugger to Confluence's algorithm (not markdown-it's) so `<ac:link ac:anchor="…">` jumps work after read→edit→write. Document the algorithm.
17. `add_drawio_diagram` interaction contract: drawio macros are tokenised by Phase 1 (preserved by reference); confirm `add_drawio_diagram`'s update path uses the same token machinery rather than reading-and-rewriting.
18. Dynamic-content macros (`children`, `recently-updated`, `content-by-label`) — markdown shim for emitting these in new content. Existing instances are already preserved by Phase 1 tokens.
19. `attribution footer` interaction: confirm `stripAttributionFooter` still recognises footers produced through the new converter; add a regression test.
20. `writeGuard`/read-only mode: confirm the new converter sits inside the existing write guard and does not bypass it; add a regression test asserting that read-only mode rejects markdown writes the same way it rejects storage writes.
21. Documentation: add a top-level `doc/markdown-cheatsheet.md` listing every supported element with input/output examples; add `doc/data-preservation.md` documenting the tokenisation contract for tool callers.

## Phase 4 — Optional: dedicated tools for stateful elements

For elements that benefit from MCP-side resolution (e.g. mentions need account-ID lookup):

22. `lookup_user(query)` — returns `accountId` for inline use.
23. `resolve_page_link(title, space)` — returns `contentId` for stable links without round-tripping.

These are nice-to-have, not blocking.
