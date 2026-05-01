# Out of scope

[← Back to index](README.md)

The following are explicitly **not** addressed by this investigation. Some may be follow-up investigations; some are permanent non-goals.

## Permanent non-goals

- **Confluence Server (Data Center).** Cloud-only. Storage format differs in subtle ways across editions; we don't have Server tenants.
- **Real-time collaborative-editing format (`atlas_doc_format`).** Storage format only. The collaborative format is a different representation used by the Confluence editor's live-collab service; it is not what `/wiki/api/v2/pages` accepts as `body.representation`.
- **Migrating existing pages produced by the old `toStorageFormat()`.** Those pages were saved with the bug; their content is whatever Confluence renders from `<p>raw markdown</p>`. We do not retroactively fix them. New writes go through the new path; affected pages can be manually re-written by their owners.

## Future investigations (worth a separate doc when needed)

- **Mermaid / PlantUML / math (KaTeX, MathJax) diagrams in markdown.** Common in design docs. Confluence has marketplace plugins but no native macro. Could be rendered as code blocks today (`mermaid` language tag yields a code macro that doesn't render the diagram); first-class support would require either an external rendering step (markdown → SVG → attachment → `<ac:image>`) or relying on a Confluence marketplace macro by name. Defer.
- **Confluence-specific elements not in the Phase 2 scope:**
  - `iframe` macro (loads external content; security-sensitive — requires careful allowlist)
  - `widget` macro (third-party widget connector)
  - `gallery` macro (image galleries)
  - `numbered-headings` macro
  - `noformat` macro (alternative to code block, no syntax highlighting)
  - `quote` macro (different from blockquote — visually styled callout)
  - `roadmap-planner` macro
  - `column` macro (single column with width — distinct from `ac:layout-cell`)
  - Marketplace macros generally
- **Custom emoji** beyond the standard Confluence set. Different storage element (`<ac:emoticon ac:emoji-fallback="..." ac:emoji-shortname="...">`); not common enough to prioritise.
- **Footnote rendering parity with the Confluence editor.** markdown footnote extension produces standard HTML; whether Confluence renders it identically to its native footnote element is unverified. Add to Phase 3 if usage emerges.
- **Definition lists.** Markdown DL extension produces `<dl><dt><dd>`; Confluence accepts it but rendering is plain. Defer.
- **Subscript / superscript** via markdown plugins. Confluence renders `<sub>`/`<sup>` natively. Trivial to add when needed.
- **Inline math via `\(...\)` / `$$...$$`.** Same as Mermaid: marketplace dependency.
- **Confluence-side rewrite reconciliation.** When the editor opens-and-saves a page, it may rewrite storage format (whitespace, attribute order, `ac:macro-id`). The data-preservation mechanism handles this correctly (always re-fetch + re-tokenise), but the broader question of "should epimethian round-trip diff against the editor's canonical form" is out of scope.

## Adjacent — handled by other parts of epimethian-mcp

- **Diagram authoring** — handled by `add_drawio_diagram` ([index.ts:785](../../../../src/server/index.ts#L785)); the new converter coexists with it via tokenisation.
- **Attachment upload** — handled by `add_attachment`; markdown image references to attachments are emitted by this investigation's Phase 2.
- **Comments / inline comments** — separate tools (`create_comment`, `createConfluenceFooterComment`, `createConfluenceInlineComment`); markdown conversion of comment bodies is a separate (smaller) follow-up if desired.
- **Status badges on pages** (page lifecycle state — "Rough draft", "In progress") — handled by `set_page_status` ([investigate-content-status.md](../investigate-content-status.md)). Distinct from the inline `<ac:structured-macro ac:name="status">` covered here.
- **Labels** — handled by `add_label`/`remove_label` ([investigate-labels.md](../investigate-labels.md)).
