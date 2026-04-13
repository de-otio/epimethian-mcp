# Storage format reference (the XML targets)

[← Back to index](README.md)

All examples below are minimal — the converter must emit valid XHTML and properly escape user content with CDATA where required (see [Security](06-security.md) for escape rules and CDATA-injection mitigation).

## Schema version

All `<ac:structured-macro>` examples below carry `ac:schema-version="1"`. Confluence Cloud accepts macros without this attribute, but emitting `1` is the safe default and matches what the Confluence editor produces. If a future macro requires `ac:schema-version="2"` (none currently do for the macros in scope), the converter will need a per-macro version table.

## `ac:macro-id`

Several Confluence macros (notably `drawio`, `expand`, `code`) carry an `ac:macro-id` UUID. The Confluence editor generates these on first save; storage submitted without one is generally accepted and the editor backfills it. The converter should:

- Emit a fresh UUID for newly-authored macros where the macro is known to require/benefit from it (`drawio`, `code`).
- Preserve any `ac:macro-id` present in tokenised content verbatim (handled automatically by the [token preservation](01-data-preservation.md) mechanism).

## Info / Note / Warning / Tip / Success panels

```xml
<ac:structured-macro ac:name="info" ac:schema-version="1">
  <ac:parameter ac:name="title">Optional title</ac:parameter>
  <ac:rich-text-body>
    <p>Body content (block-level, may contain other macros).</p>
  </ac:rich-text-body>
</ac:structured-macro>
```

Names: `info`, `note`, `warning`, `tip`, `success` (last is occasionally `check` depending on Confluence version — confirm against current Cloud behaviour during implementation).

## Generic panel

```xml
<ac:structured-macro ac:name="panel" ac:schema-version="1">
  <ac:parameter ac:name="title">My Title</ac:parameter>
  <ac:parameter ac:name="bgColor">#E3FCEF</ac:parameter>
  <ac:parameter ac:name="borderColor">#36B37E</ac:parameter>
  <ac:rich-text-body>
    <p>...</p>
  </ac:rich-text-body>
</ac:structured-macro>
```

## Code block with syntax highlighting

```xml
<ac:structured-macro ac:name="code" ac:schema-version="1">
  <ac:parameter ac:name="language">typescript</ac:parameter>
  <ac:parameter ac:name="title">Optional title</ac:parameter>
  <ac:parameter ac:name="linenumbers">true</ac:parameter>
  <ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body>
</ac:structured-macro>
```

Languages supported: standard set including `bash`, `typescript`, `python`, `json`, `yaml`, `sql`, `xml`, `html`, `java`, `go`, `rust`, etc.

## Table of Contents

```xml
<ac:structured-macro ac:name="toc" ac:schema-version="1">
  <ac:parameter ac:name="maxLevel">3</ac:parameter>
  <ac:parameter ac:name="minLevel">1</ac:parameter>
  <ac:parameter ac:name="style">disc</ac:parameter>
</ac:structured-macro>
```

## Expand

```xml
<ac:structured-macro ac:name="expand" ac:schema-version="1">
  <ac:parameter ac:name="title">Click to expand</ac:parameter>
  <ac:rich-text-body>
    <p>Hidden content.</p>
  </ac:rich-text-body>
</ac:structured-macro>
```

## Status badge (inline)

```xml
<ac:structured-macro ac:name="status" ac:schema-version="1">
  <ac:parameter ac:name="title">In Progress</ac:parameter>
  <ac:parameter ac:name="colour">Blue</ac:parameter>
</ac:structured-macro>
```

Colours: `Grey`, `Red`, `Yellow`, `Green`, `Blue`, `Purple`. Note: `colour` (British spelling), not `color` — Confluence-specific quirk.

## Page link (`<ac:link>`)

By title (most common when source is human-readable):

```xml
<ac:link>
  <ri:page ri:content-title="Target Page Title" ri:space-key="ETD"/>
  <ac:plain-text-link-body><![CDATA[Display text]]></ac:plain-text-link-body>
</ac:link>
```

By page ID (more stable but opaque):

```xml
<ac:link>
  <ri:page ri:content-id="123456789"/>
</ac:link>
```

To an anchor inside a page:

```xml
<ac:link ac:anchor="Heading Text">
  <ri:page ri:content-title="Target Page Title"/>
</ac:link>
```

## User mention

```xml
<ac:link>
  <ri:user ri:account-id="557058:abc-def-..."/>
</ac:link>
```

## Image / attachment

```xml
<ac:image ac:height="400">
  <ri:attachment ri:filename="screenshot.png"/>
</ac:image>
```

External URL variant works as standard `<img src=".." />` — Confluence stores it as `<ac:image><ri:url ri:value=".."/></ac:image>` if you want canonical form.

## Layout (two-column)

```xml
<ac:layout>
  <ac:layout-section ac:type="two_equal">
    <ac:layout-cell><p>Left</p></ac:layout-cell>
    <ac:layout-cell><p>Right</p></ac:layout-cell>
  </ac:layout-section>
</ac:layout>
```

## Excerpt / Excerpt-include

```xml
<!-- Source page: defines the excerpt -->
<ac:structured-macro ac:name="excerpt" ac:schema-version="1">
  <ac:rich-text-body><p>The shared definition.</p></ac:rich-text-body>
</ac:structured-macro>

<!-- Consuming page: pulls the excerpt -->
<ac:structured-macro ac:name="excerpt-include" ac:schema-version="1">
  <ac:parameter ac:name="">Source Page Title</ac:parameter>
  <ac:parameter ac:name="nopanel">true</ac:parameter>
</ac:structured-macro>
```

The empty `ac:name=""` on the first parameter is **not a typo** — the Confluence storage format uses an unnamed positional parameter for the source page reference. The converter must emit it verbatim.

## Task list

```xml
<ac:task-list>
  <ac:task>
    <ac:task-id>1</ac:task-id>
    <ac:task-status>incomplete</ac:task-status>
    <ac:task-body><span>Do the thing <ac:link><ri:user ri:account-id="..."/></ac:link></span></ac:task-body>
  </ac:task>
</ac:task-list>
```

`ac:task-id` must be unique within the page. For new tasks the converter assigns IDs starting at the highest existing ID + 1 (read from the tokenised pre-edit storage).

## Anchor

```xml
<ac:structured-macro ac:name="anchor" ac:schema-version="1">
  <ac:parameter ac:name="">my-anchor-name</ac:parameter>
</ac:structured-macro>
```

Same empty-name positional-parameter quirk as `excerpt-include`.

## Emoticon

```xml
<ac:emoticon ac:name="smile"/>
```

Standard names: `smile`, `sad`, `cheeky`, `laugh`, `wink`, `thumbs-up`, `thumbs-down`, `information`, `tick`, `cross`, `warning`, `light-on`, `light-off`, `yellow-star`, `red-star`, `green-star`, `blue-star`, `question`. Custom emoji use a different element form (out of scope for Phase 2).

## Jira issue

```xml
<ac:structured-macro ac:name="jira" ac:schema-version="1">
  <ac:parameter ac:name="server">System Jira</ac:parameter>
  <ac:parameter ac:name="serverId">00000000-0000-0000-0000-000000000000</ac:parameter>
  <ac:parameter ac:name="key">PROJ-123</ac:parameter>
</ac:structured-macro>
```

The `serverId` parameter is required and is specific to the linked Jira application. The converter reads it from configuration (single-Jira tenants) or accepts it as a directive parameter for multi-Jira setups.

## Children macro (dynamic index)

```xml
<ac:structured-macro ac:name="children" ac:schema-version="1">
  <ac:parameter ac:name="all">true</ac:parameter>
  <ac:parameter ac:name="depth">1</ac:parameter>
</ac:structured-macro>
```

## Date

```xml
<time datetime="2026-04-13"/>
```

(Note: this is one of the few non-`<ac:>` Confluence-specific elements.)
