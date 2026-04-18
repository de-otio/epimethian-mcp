# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] - security audit fixes

This release implements the fixes from the 2026-04-18 security audit
(see `plans/security-audit-fixes.md`). No user data migration is required.

### Changed (breaking)

- **Auto-update is now check-and-notify only by default.** Previously the
  server silently ran `npm install -g` when a patch release was detected.
  The audit flagged this as Critical: a compromise of the npm publisher
  account or a registry MITM would execute code on every user's machine
  within 24 hours.
  - **Default behaviour:** the daily check records a pending update in
    `~/.config/epimethian-mcp/update-check.json`. The stderr startup banner
    and the `get_version` MCP tool surface the "update available" signal.
    The user installs with the new `epimethian-mcp upgrade` command (from
    their terminal, not via the agent).
  - **Opt-in:** set `EPIMETHIAN_AUTO_UPGRADE=patches` to restore automatic
    installation for **patch releases only**. The startup banner logs a
    loud supply-chain warning when this is active.
  - **Integrity check:** every install (manual or opt-in) now calls
    `npm audit signatures` and refuses to install unless the npm provenance
    attestation verifies. Failure leaves the pending-update record intact
    so the banner keeps nagging.
  - **Migration:** users who relied on silent auto-update must either run
    `epimethian-mcp upgrade` manually (recommended) or opt in with the
    env var above.

### Added

- **`epimethian-mcp upgrade` CLI subcommand** — runs the integrity-verified
  install path. Non-zero exit on integrity or install failure so scripts /
  CI can detect.
- **Prompt-injection fencing on read tools** — every tenant-authored piece
  of text returned to the agent is wrapped in
  `<<<CONFLUENCE_UNTRUSTED … >>>` / `<<<END_CONFLUENCE_UNTRUSTED>>>`
  markers. The fence is a behavioural defence (not cryptographic);
  tool-description paragraphs instruct the agent to treat fenced content
  as data, never as instructions. Applies to: `get_page`,
  `get_page_by_title`, `get_page_versions`, `get_page_version`,
  `diff_page_versions`, `search_pages`, `get_comments`, `get_labels`,
  `lookup_user`, `resolve_page_link`, `get_page_status`.
- **Destructive-flag warning on write tools** — tool descriptions of the
  16 write tools gain a paragraph telling the agent that destructive
  flags (`confirm_shrinkage`, `confirm_structure_loss`, `replace_body`,
  etc.) must come from the user's original request, never from page
  content.
- **`CONTENT_FLOOR_BREACHED` guard (no opt-out)** — rejects writes that
  shrink the body below 10 % of the original (>500-char pages) or below
  10 visible characters (>200-char text pages), even with every
  `confirm_*` flag set. Backstop against prompt-injection chains that
  talk the agent into passing the opt-out flags.

### Security

- **Tenant seal fails closed on sealed profiles when `/_edge/tenant_info`
  is unreachable.** Previously the server logged a warning and continued
  even when a seal existed. An attacker who could selectively block the
  endpoint (network MITM, egress filter) thereby bypassed the seal.
  Profiles without a stored seal (pre-5.5 upgrade paths) still degrade
  gracefully with a warning.
- **Filesystem TOCTOU hardening** — replaced `stat + readFile` patterns
  on `profiles.json` and `update-check.json` with `open(O_NOFOLLOW)` +
  `fstat`-on-fd + read. `audit.log` appends now use `O_NOFOLLOW` too.
  Mutation-log file creation adds `O_NOFOLLOW` to the existing `O_EXCL`.
  A new `verifyDirChain` helper walks parent directories lstat-checking
  each for symlinks / wrong ownership / group-world-writable modes.
- **MCP client label sanitisation** — `setClientLabel()` now strips
  characters outside `[A-Za-z0-9 _./()\-]` before truncation, so a
  malicious MCP client cannot inject ANSI escapes, newlines, or control
  characters into the server's log output or comment attribution.
- **Deep-frozen `Config.jsonHeaders`** — `Object.freeze` is shallow, so
  `config.jsonHeaders.Authorization` was mutable at runtime despite the
  frozen outer object. Now frozen explicitly.

### Documentation

- `doc/design/security/` updated to describe the new trust model,
  fencing convention, floor guard, seal fail-closed semantics, and
  filesystem-hardening helpers. See the index at
  `doc/design/security/README.md`.

## [5.1.0] - 2026-04-14

### Added

- **Three new tools: `prepend_to_page`, `append_to_page`, `revert_page`**
  - `prepend_to_page` / `append_to_page`: Additive-only mutations that concatenate content before/after the existing page body. Safer than `update_page` with `replace_body` for additive operations.
  - `revert_page`: Lossless revert to a previous version using raw storage format from the v1 API. Avoids the lossy markdown conversion of `get_page_version` → `update_page`.

- **Content-safety guards on `update_page`**
  - `confirm_shrinkage: boolean` (default: false) — rejects >50% body size reduction unless explicitly acknowledged.
  - `confirm_structure_loss: boolean` (default: false) — rejects >50% heading count drop unless explicitly acknowledged.
  - Empty-body rejection — hard guard with no opt-out; rejects writes that would produce near-empty pages.
  - Guards apply to both the markdown and storage-format code paths.

- **Write-ahead mutation log (opt-in)**
  - Enable via `EPIMETHIAN_MUTATION_LOG=true` environment variable.
  - Appends JSONL records to `~/.epimethian/logs/` for every write operation.
  - Security: 0o600 file perms, 0o700 directory perms, symlink checks, sanitized error messages.
  - Auto-cleanup: log files older than 30 days are deleted on startup.

- **Pre-write page snapshots** — page cache stores body snapshots before writes for recovery.

- **Body-length reporting** — all write responses now include `body: N→M chars`.

### Changed

- `get_page_version` description now warns that returned markdown is lossy and recommends `revert_page` for lossless reverts.
- `update_page` description documents the safety guards and warns about `replace_body` risks.

## [5.0.0] - 2026-04-13

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
