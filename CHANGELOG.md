# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed (BREAKING)

- **`create_page` and `update_page` now convert markdown bodies to Confluence storage format.**
  
  Bodies that were previously passed through the trivial `<p>…</p>` wrapper are now parsed as GitHub Flavored Markdown and converted to native Confluence storage XML. This applies to:
  - Headings, paragraphs, lists, tables, code blocks, blockquotes, links
  - Confluence-specific elements: info/warning/note/tip/success panels, expand, columns, inline directives (status, mention, date, emoji, Jira, anchor)
  - Frontmatter directives for page configuration (ToC, heading offset)
  
  **Migration:** To preserve the old behaviour (pass storage format directly without conversion), ensure your body begins with `<` and contains Confluence storage tags (`<ac:`, `<ri:`, etc.), or use the new `replace_body: true` flag to opt out of token preservation.
  
  **SemVer major version bump:** 4.x → 5.0.0

### Added

- **`update_page` accepts `confirm_deletions: boolean`** (default: `false`)
  
  When updating an existing page via markdown, if the converter detects that macros or elements have been removed (by omitting token comments), the update errors with a list of what would be deleted. Set `confirm_deletions: true` to explicitly acknowledge the removal. The deleted tokens are then logged in the page version message for auditing.

- **`create_page` and `update_page` accept `replace_body: boolean`** (default: `false`)
  
  When `replace_body: true`, token preservation is disabled. Your markdown body completely replaces the page content. Use this for wholesome page rewrites where you don't want to preserve existing macros. This is an explicit opt-out and is logged.

- **`create_page` and `update_page` accept `allow_raw_html: boolean`** (default: `false`)
  
  By default, the markdown converter rejects raw HTML. Set `allow_raw_html: true` to enable inline HTML tags. This is disabled by default for security.

- **Markdown extensions in `create_page` and `update_page` bodies:**
  - GitHub-style alert syntax for panels: `> [!INFO]`, `> [!WARNING]`, `> [!NOTE]`, `> [!TIP]`, `> [!SUCCESS]`
  - Fenced divs for containers: `::: panel`, `::: expand`, `::: columns / ::: column`
  - Inline directives: `:status[…]`, `:mention[…]`, `:date[…]`, `:emoji[…]`, `:jira[…]`, `:anchor[…]`
  - Frontmatter for page configuration: `toc`, `headingOffset`, `numbered`, `excerpt`
  - Confluence page link rewrites: markdown links to Confluence URLs are converted to `<ac:link>` automatically; explicit `confluence://` scheme for title-based links
  - Automatic heading anchor generation matching Confluence's algorithm

- **Opaque token preservation for page round-trips**
  
  `get_page(format: markdown)` returns markdown with `<!--epi:T####-->` tokens inline, representing any macros or elements the converter doesn't represent. `update_page` restores these tokens byte-for-byte, guaranteeing lossless round-trips. See [doc/data-preservation.md](doc/data-preservation.md) for the contract.

- **16 allowlisted macros for raw `<ac:…>` passthrough:**
  - `info`, `note`, `warning`, `tip`, `success`, `panel`, `code`, `expand`, `toc`, `status`, `anchor`, `excerpt`, `excerpt-include`, `drawio`, `children`, `jira`
  
  Non-allowlisted macros in raw HTML are rejected with an error pointing to the supported markdown syntax.

### Fixed

- **`create_page` no longer silently corrupts pages when given markdown input**
  
  Previously, markdown bodies were wrapped in a single `<p>` paragraph tag, producing broken pages with literal `#`, `|`, `-` characters visible. The new converter properly parses and renders markdown to Confluence storage format.

- **`update_page` no longer rejects valid markdown input via the `looksLikeMarkdown()` heuristic**
  
  The heuristic has been strengthened to correctly distinguish markdown from storage format, and markdown bodies are now routed to the converter instead of being rejected outright.

## Documentation

- **[doc/markdown-cheatsheet.md](doc/markdown-cheatsheet.md)** — Complete reference for every supported markdown construct with resulting Confluence rendering.
- **[doc/data-preservation.md](doc/data-preservation.md)** — Tokenisation contract for tool callers; explains `confirm_deletions`, `replace_body`, and how to safely round-trip pages via markdown.

---

*For design details, see the investigation [doc/design/investigations/investigate-confluence-specific-elements/](doc/design/investigations/investigate-confluence-specific-elements/).*
