# Markdown syntax design — exposing Confluence elements through markdown

[← Back to index](README.md)

Five orthogonal authoring channels, in order of preference.

## Channel 1 — Markdown extensions (preferred for content)

Use **GitHub-style alert syntax** (now widely supported by markdown ecosystems and natural to write) for the five named panels:

```markdown
> [!INFO]
> Body content here.
> Multiple paragraphs work.

> [!WARNING] Optional title
> Body.

> [!NOTE]
> ...

> [!TIP]
> ...

> [!SUCCESS]
> ...
```

Mapping: `[!INFO]` → `ac:name="info"`, etc. The line after `[!TYPE]` (if any text remains) becomes the panel title.

For **generic panels** with custom title/colour, use a Pandoc-style fenced div:

```markdown
::: panel title="Open Questions" bgColor=#FFF7E0
- Question 1
- Question 2
:::
```

For **expand**, fenced div with the keyword:

````markdown
::: expand title="Full error trace"
```text
Stack trace here.
```
:::
````

For **layout / columns**, nested fenced divs:

```markdown
::: columns
::: column
Left content.
:::
::: column
Right content.
:::
:::
```

## Channel 2 — Inline directives (for status badges, mentions, dates, emoji, Jira, anchors)

Use the standard **directive syntax** (`:name[label]{params}`) common to remark/markdown-it directive plugins:

```markdown
Owner: :mention[Richard Myers]{accountId=557058:abc}
Status: :status[In Progress]{colour=Blue}
Due: :date[2026-04-30]
:emoji[smile]
See :jira[PROJ-123] for details.
:anchor[my-section]
```

This composes naturally inside table cells, list items, and paragraphs without breaking GFM table rendering.

## Channel 3 — Page links (auto + explicit)

Two forms:

- **Auto**: a markdown link to a Confluence page URL that the converter recognises (host equality after canonicalisation against the configured Confluence base URL — see [Security](06-security.md)) is rewritten to `<ac:link>` automatically. This is zero-friction for pasting URLs from the browser.
  - Input: `[Overview](https://entrixenergy.atlassian.net/wiki/spaces/ETD/pages/875954196/EX-3946+Overview)`
  - Output: `<ac:link><ri:page ri:content-id="875954196"/><ac:plain-text-link-body><![CDATA[Overview]]></ac:plain-text-link-body></ac:link>`
- **Explicit by title** (when ID isn't known): a custom `confluence:` scheme.
  - Input: `[Overview](confluence://ETD/EX-3946 Overview & Motivation)`
  - Output: `<ac:link><ri:page ri:content-title="EX-3946 Overview &amp; Motivation" ri:space-key="ETD"/>...</ac:link>`

External links remain plain `<a href>`.

## Channel 4 — Allowlisted raw storage format (escape hatch for new content)

For elements without a markdown shim *and* on the allowlist, raw `<ac:...>` blocks may appear inline. The converter passes them through unchanged.

**Allowlist** (initial): `info`, `note`, `warning`, `tip`, `success`, `panel`, `code`, `expand`, `toc`, `status`, `anchor`, `excerpt`, `excerpt-include`, `drawio`, `children`, `jira`. Anything else **errors** with a message pointing at the supported markdown syntax. The allowlist exists because raw passthrough is a [macro-injection vector](06-security.md#macro-injection-via-raw-passthrough); restricting it to known-safe macros caps the blast radius.

This is **not** a substitute for the [tokeniser](01-data-preservation.md) — token preservation handles unknown macros that already exist on the page; this channel is only for inline authoring of new macros that the converter knows but doesn't yet have a markdown shim for.

Implementation: detect any line that begins with `<ac:` or `<ri:` and treat the run until the matching close tag as a raw-XML block. Validate the macro name against the allowlist before passthrough.

## Channel 5 — Frontmatter directives (per-page configuration)

For ToC, the converter accepts a frontmatter directive instead of inline syntax — most pages either want a ToC or don't, and putting it in frontmatter avoids cluttering the body:

```markdown
---
toc: { maxLevel: 3, minLevel: 1 }
---
# Page Title
```

Other frontmatter keys reserved for future use: `headingOffset`, `numbered`, `excerpt`. See [design decisions](07-design-decisions.md) for proposed defaults.
