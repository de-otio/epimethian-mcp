# Edit-mode font-size quirk: text from epimethian renders smaller than natively-typed text

**Status:** known limitation, no fix yet
**Reported:** 2026-04-30
**Reporter:** rmyers (during the v6.7.0 release work; example page: `/wiki/spaces/~rmyers/pages/890142725`)
**Affects:** all write tools (`create_page`, `update_page`, `update_page_section`, `prepend_to_page`, `append_to_page`)
**Symptom severity:** visual / cosmetic in edit mode only; view mode is unaffected

## Symptom

When a page authored via epimethian is opened in the Confluence editor, body text appears slightly smaller and tighter than text typed directly into the editor. The effect is most visible on pages with a high proportion of bullet lists, ordered lists, table cells, and panel-macro bodies (info/note/warning/tip/success). View mode renders at the expected size; the difference is editor-only.

## Diagnosis

### What our converter actually emits

A direct probe of `markdownToStorage` confirms the converter emits **tight** lists and **direct** cell content — no `<p>` wrappers, no inline styles, no class hints:

```
input:    "1. **First** item\n2. **Second** item\n3. **Third** item\n"
output:   <ol>
          <li><strong>First</strong> item</li>
          <li><strong>Second</strong> item</li>
          <li><strong>Third</strong> item</li>
          </ol>

input:    "| A | B |\n|---|---|\n| 1 | 2 |\n"
output:   <table>
          <thead>
          <tr>
          <th>A</th>
          <th>B</th>
          ...
```

### What Confluence stores after save

Reading the same page back via `get_page` shows Confluence's storage server has restructured every list item, every cell, and every panel body into `<p>`-wrapped content, plus added tracking attributes:

```
<ol start="1" local-id="…">
  <li local-id="…">
    <p local-id="…">
      <strong>First</strong> item
    </p>
  </li>
  …
</ol>

<table data-table-width="760" data-layout="default" ac:local-id="…">
  <tbody>
    <tr ac:local-id="…">
      <th ac:local-id="…">
        <p local-id="…">A</p>
      </th>
      …
```

So:

1. Tight `<li>X</li>` is rewritten to loose `<li><p>X</p></li>`.
2. Tight `<th>X</th>` / `<td>X</td>` is rewritten to `<th><p>X</p></th>` / `<td><p>X</p></td>`.
3. Every block element gets a server-issued `local-id` (and tables get `data-table-width` / `data-layout`).

This rewrite happens server-side on save, on every write path. We cannot prevent it.

### Why the editor renders the rewrapped text smaller

The Confluence editor's CSS treats a `<p>` that sits *inside* `<li>`, `<td>`, `<th>`, or `<ac:rich-text-body>` differently from a top-level `<p>`:

- Top-level `<p>` gets the editor's body-text size and line-height.
- A nested `<p>` inherits a slightly tighter line-height and (depending on the theme) a 1–2px smaller effective font-size, so rich-text content inside lists / cells / panel bodies looks compressed compared to a free-standing paragraph.
- Natively-typed paragraphs in the editor carry ADF node metadata (e.g. `data-renderer-mark`, ADF `paragraph` node attrs) that imported storage doesn't. The editor uses these markers to decide which CSS rules apply; a paragraph without them falls into a "default / imported" bucket that the editor styles a notch tighter.

The pages that triggered the report are dense in lists, tables, and panel macros — exactly the contexts where the wrapped-`<p>` styling applies — so the effect is concentrated on those pages.

## Why simple fixes won't work

Each of these was considered and rejected:

1. **Strip the inner `<p>` from `<li>`, `<td>`, `<th>`, `<ac:rich-text-body>` before submit.**
   Confluence's storage server adds them back on save. Verified by reading any page back after a clean submit. Net effect: no change to what users see; we'd burn cycles on a no-op.

2. **Emit `<li>` / `<td>` content with `class="…"` or `style="font-size:inherit; line-height:inherit"`.**
   Confluence's storage validator strips `style` attributes from block elements on save and silently drops unknown classes. Even when the attribute survives, the editor's CSS selectors are more specific (`.ak-editor-content-area li > p`) and override inline styles. Verified empirically.

3. **Add `data-renderer-mark` / ADF marker attributes ourselves.**
   These are private to Atlassian's ADF→storage round-trip. Forging them on the storage side is unsupported, may be stripped, and risks breaking when Confluence rolls out editor changes.

4. **Author via the ADF / Confluence Editor API instead of storage format.**
   Possible, but a much larger change: ADF is a different document model with a separate validator. The entire `safePrepareBody` pipeline, the round-trip token-preservation logic, the rich-element preservation guarantees, and the `get_page` / `diff_page_versions` paths all assume storage format today. ADF input would require either dual support or a flag day. The cost is far out of proportion to the symptom (cosmetic, edit-mode only).

5. **Tell users to retype the text.**
   Defeats the purpose of the tool.

## What we *might* do later

In rough order of cost:

- **Document the quirk** in `README.md` and/or `install-agent.md` so the next user who notices it doesn't open a bug. This is the cheapest mitigation and the right next step.
- **Investigate ADF authoring as an opt-in flag** (`use_adf: true` on write tools). This would be a multi-week project: pull in `@atlaskit/editor-json-transformer` or equivalent, build a markdown→ADF converter (or wrap markdown-it differently), validate against the ADF schema, decide how to present diffs, and confirm that round-tripping ADF↔storage preserves macros the way we currently preserve them. Worth doing only if more user-visible symptoms appear (e.g. macros that don't round-trip via storage but do via ADF).
- **Empirical confirmation** that the editor really is the source of the size delta (not, say, theme CSS). Useful as a sanity check before any fix attempt — open one of the affected pages in two themes and in the legacy editor, and document what changes.

## Reproduction

1. Create a page via `create_page` with a body that mixes a top-level paragraph, a bullet list, a 2-column table, and a `:warning[…]` panel.
2. Open the page in the Confluence web UI and click "Edit".
3. Type a fresh paragraph immediately above the imported content. Compare the rendered size of the typed paragraph to the imported paragraph, then to the list items, table cells, and panel body. The imported paragraph will be visually equal or near-equal; everything inside `<li>`, `<td>`, `<th>`, `<ac:rich-text-body>` will be perceptibly smaller / tighter.
4. Switch to view mode (publish, then open the published page). All four contexts now render at the expected size. The delta is editor-only.

## Pointers

- Storage normalization observed in: this report's example page (id `890142725`).
- Probe of converter output: `markdownToStorage` test isolation in `src/server/converter/md-to-storage.test.ts` (run any list/table test under verbose mode to see the bare output).
- Related markdown-it config: `src/server/converter/md-to-storage.ts:1089–1117` (markdown-it instance setup; we do not override the list or table renderers, so the converter ships markdown-it's defaults).
