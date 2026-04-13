# Markdown Cheatsheet for Confluence

A complete reference for every markdown construct that the epimethian-mcp converter transforms into Confluence storage format.

## Basic formatting

### Headings

```markdown
# Heading 1
## Heading 2
### Heading 3
#### Heading 4
##### Heading 5
###### Heading 6
```

Result: Standard Confluence heading levels `<h1>` through `<h6>`.

### Paragraphs and line breaks

```markdown
This is a paragraph.

This is another paragraph (separated by blank line).

Line breaks:
Hard break with two spaces at end of line  
Creates a `<br/>` tag.

Soft line break (single newline) does not create break.
```

Result: `<p>` tags for paragraphs; `<br/>` for explicit breaks.

### Inline text formatting

```markdown
**bold text** or __bold text__
*italic text* or _italic text_
***bold and italic***
~~strikethrough~~
`inline code`
```

Result: `<strong>`, `<em>`, `<del>`, `<code>` tags as appropriate.

## Links

### External links

```markdown
[Google](https://google.com)
[Link with title](https://example.com "Hover text")
```

Result: Standard `<a href="...">` tags.

### Confluence page links (auto-rewrite)

```markdown
[Page Title](https://entrixenergy.atlassian.net/wiki/spaces/ETD/pages/875954196/EX-3946+Overview)
```

Result: Automatically converted to `<ac:link><ri:page ri:content-id="875954196"/><ac:plain-text-link-body><![CDATA[Page Title]]></ac:plain-text-link-body></ac:link>`. The converter recognises the Confluence host and extracts the page ID.

### Confluence page links (explicit by title)

```markdown
[Overview](confluence://ETD/EX-3946 Overview & Motivation)
```

Result: `<ac:link><ri:page ri:content-title="EX-3946 Overview &amp; Motivation" ri:space-key="ETD"/>...</ac:link>`. Use this when the page ID is unknown.

## Lists

### Unordered lists

```markdown
- Item 1
- Item 2
  - Nested item 2.1
  - Nested item 2.2
- Item 3
```

Result: `<ul>` and `<li>` tags with nesting preserved.

### Ordered lists

```markdown
1. First item
2. Second item
   1. Nested item 2.1
   2. Nested item 2.2
3. Third item
```

Result: `<ol>` and `<li>` tags with nesting preserved.

### Task lists

```markdown
- [x] Completed task
- [ ] Incomplete task
- [ ] Another task
```

Result: `<li>` items with checkbox state encoded as `<ac:task-list-item ac:checked="true|false">`.

## Code

### Fenced code blocks

````markdown
```python
def hello():
    print("world")
```
````

Result: `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">python</ac:parameter><ac:plain-text-body><![CDATA[def hello():\n    print("world")]]></ac:plain-text-body></ac:structured-macro>`. The language is extracted from the fence info string.

````markdown
```
Plain text without language tag
```
````

Result: Code macro with no `language` parameter.

## Tables

```markdown
| Header 1 | Header 2 | Header 3 |
|----------|----------|----------|
| Cell 1.1 | Cell 1.2 | Cell 1.3 |
| Cell 2.1 | Cell 2.2 | Cell 2.3 |
```

Result: `<table><thead>`, `<tbody>`, `<tr>`, `<th>`, `<td>` tags.

Alignment (GitHub Flavored Markdown):

```markdown
| Left | Center | Right |
|:---|:---:|---:|
| L | C | R |
```

Result: Confluence renders alignment via `<table>` (alignment attributes may vary).

## Blockquotes

```markdown
> This is a blockquote.
> It can span multiple lines.
>
> And multiple paragraphs.
```

Result: `<blockquote>` wrapping `<p>` tags.

## Horizontal rule

```markdown
---
```

Result: `<hr/>` tag.

## Images

### External images

```markdown
![Alt text](https://example.com/image.png)
![Alt with title](https://example.com/image.png "Image title")
```

Result: `<img src="..." alt="..."/>` tags.

### Attachment references

```markdown
![Local file](attachment:my-image.png)
```

Result: `<ac:image><ri:attachment ri:filename="my-image.png"/></ac:image>`.

## Confluence-specific elements

### Alert panels (GitHub-style)

```markdown
> [!INFO]
> This is an info panel.

> [!WARNING] Optional title
> This is a warning panel with a custom title.

> [!NOTE]
> This is a note panel.

> [!TIP]
> This is a tip panel.

> [!SUCCESS]
> This is a success panel.
```

Result: `<ac:structured-macro ac:name="info|warning|note|tip|success">` with the body rendered as rich content.

### Generic panels (custom title and colour)

```markdown
::: panel title="Custom Title" bgColor=#FFF7E0
- Item 1
- Item 2
:::
```

Result: `<ac:structured-macro ac:name="panel"><ac:parameter ac:name="title">Custom Title</ac:parameter><ac:parameter ac:name="bgColor">#FFF7E0</ac:parameter><ac:rich-text-body>...</ac:rich-text-body></ac:structured-macro>`.

### Expand (disclosure/accordion)

````markdown
::: expand title="Click to expand"
```
Collapsed content here.
```
:::
````

Result: `<ac:structured-macro ac:name="expand"><ac:parameter ac:name="title">Click to expand</ac:parameter><ac:rich-text-body>...</ac:rich-text-body></ac:structured-macro>`.

### Columns layout

```markdown
::: columns
::: column
Left column content.
:::
::: column
Right column content.
:::
:::
```

Result: `<ac:layout><ac:layout-section ac:type="two_equal"><ac:layout-cell>...</ac:layout-cell><ac:layout-cell>...</ac:layout-cell></ac:layout-section></ac:layout>`. Column count determines layout type (`two_equal`, `three_equal`, etc.).

## Inline directives

### Status badge

```markdown
Status: :status[In Progress]{colour=Blue}
```

Result: `<ac:structured-macro ac:name="status"><ac:parameter ac:name="title">In Progress</ac:parameter><ac:parameter ac:name="colour">Blue</ac:parameter></ac:structured-macro>`. Valid colours: `Grey`, `Red`, `Yellow`, `Green`, `Blue`, `Purple`.

### User mention

```markdown
Owner: :mention[Richard Myers]{accountId=557058:abc}
```

Result: `<ac:structured-macro ac:name="mention"><ac:parameter ac:name="accountId">557058:abc</ac:parameter></ac:structured-macro>`. The account ID is validated before conversion.

### Date/time

```markdown
Due: :date[2026-04-30]
```

Result: `<time datetime="2026-04-30T00:00:00.000+0000"/>`.

### Emoji

```markdown
Feeling :emoji[smile] today.
```

Result: `<ac:emoticon ac:name="smile"/>`. The emoji name is validated against Confluence's emoticon set.

### Jira issue link

```markdown
See :jira[PROJ-123] for details.
```

Result: `<ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">PROJ-123</ac:parameter>...</ac:structured-macro>`. Includes server/instance ID from config.

### Anchor (heading link target)

```markdown
:anchor[my-section]
# My Section
```

Result: `<ac:anchor>my-section</ac:anchor>` placed before the heading, allowing other pages to link to `[link text](#my-section)`.

## Frontmatter configuration

### Table of Contents

```markdown
---
toc: { maxLevel: 3, minLevel: 1 }
---
# Page Title

## Section 1
...
```

Result: `<ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter><ac:parameter ac:name="minLevel">1</ac:parameter></ac:structured-macro>` injected at the top of the converted body.

### Heading offset

```markdown
---
headingOffset: 1
---
# This becomes <h2>
## This becomes <h3>
```

Result: All heading levels shifted down by the offset during conversion.

## Raw HTML passthrough (allowlisted macros only)

The following 16 macro names are allowed when written as raw Confluence storage XML inline:

- `info`
- `note`
- `warning`
- `tip`
- `success`
- `panel`
- `code`
- `expand`
- `toc`
- `status`
- `anchor`
- `excerpt`
- `excerpt-include`
- `drawio`
- `children`
- `jira`

Example:

```markdown
<ac:structured-macro ac:name="code">
  <ac:parameter ac:name="language">javascript</ac:parameter>
  <ac:plain-text-body><![CDATA[
  const x = 1;
  ]]></ac:plain-text-body>
</ac:structured-macro>
```

Result: The XML is passed through unchanged. Non-allowlisted macro names will be rejected with an error pointing to the supported markdown syntax.

## Token preservation (opaque elements)

When updating an existing page via markdown, any Confluence storage elements not in the converter's known set are replaced with tokens:

```markdown
<!--epi:T0042-->
```

These tokens are automatically restored to their original XML when you update the page. See [data-preservation.md](data-preservation.md) for the full contract.
