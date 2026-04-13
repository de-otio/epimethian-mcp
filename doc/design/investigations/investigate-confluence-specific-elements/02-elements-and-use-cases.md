# Elements and use cases

[← Back to index](README.md)

| Element | When agents need it | Why plain HTML/markdown is insufficient |
|--------|---------------------|----------------------------------------|
| **Info / Note / Warning / Tip / Success panels** | Highlighting prerequisites, gotchas, breaking changes in design docs and runbooks | Markdown blockquotes are visually weak; readers skim past them. Native panels have icons and colour, signalling priority. |
| **Generic panel (titled, custom colour)** | "Open Questions" boxes, callouts that don't fit the standard semantics | No markdown equivalent. |
| **Code blocks with syntax highlighting** | All technical pages | Plain `<pre><code>` renders without syntax colour and looks dull next to native code macros. |
| **Table of Contents (ToC)** | Long pages (incidents, design docs, runbooks) | Auto-generated ToC reflects current headings — manual ToC rots. |
| **Expand** | Progressive disclosure of long error messages, raw JSON, full schemas | Without it, long pages become unreadable walls of text. |
| **Status badges** | Workflow state ("In progress", "Blocked", "Done"), severity tags ("P1", "P2") inline in tables | Plain text loses colour/affordance; readers have to read every cell. |
| **Page links via `<ac:link>`** | Cross-references that survive page rename / move | Plain `<a href="...">` breaks on rename. Confluence's native link uses content ID. |
| **User mentions** | Assigning owners in tables, @-ing reviewers in comments | Markdown has no notion of accounts. |
| **Image / attachment refs** | Embedding screenshots, diagrams, exported reports | Markdown `![](url)` works for external URLs; for attachments uploaded via `add_attachment`, requires `<ac:image><ri:attachment/>`. |
| **Layout / columns** | Side-by-side comparison (before/after, two-column lists) | Markdown can't express layout. |
| **Excerpt / excerpt-include** | Content reuse across pages (single source of truth for shared definitions) | Without it, agents copy-paste and content drifts. |
| **Task lists (`<ac:task-list>`)** | Action items with checkboxes that surface in user task view | GFM checkboxes (`- [ ]`) render statically; native task lists integrate with Confluence's task feed. |
| **Date macro** | "Last updated: 2026-04-13" badges, due dates in tables | Plain text dates are not machine-readable for filters/macros. |
| **Anchor macro** | Jump-to targets distinct from headings | Without it, `ac:anchor` page links can only reference headings. |
| **Emoticon** | Inline emojis (`:smile:`) common in LLM output | Without conversion, raw `:smile:` text appears literally on the page. |
| **Jira issue link** | Engineering pages reference issues constantly | Plain text key (`PROJ-123`) loses the rich card with status, assignee, type. The single biggest miss for an engineering-focused MCP. |
| **Dynamic-content macros (`children`, `recently-updated`, `content-by-label`)** | Index pages, "what's new" sections, label-driven dashboards | Static lists rot; dynamic macros stay current automatically. |
