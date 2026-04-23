# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [6.0.1] - 2026-04-23 - confluence:// content-id link fix

### Fixed

- **`confluence://CONTENT_ID` markdown links now produce a working
  hyperlink.** The `resolve_page_link` tool description has long
  advertised the bare-content-id form (e.g.
  `[text](confluence://918847500)`), but the converter only ever
  recognised the `confluence://SPACE_KEY/PAGE_TITLE` form and silently
  passed the bare-id form through to markdown-it, producing a literal
  `<a href="confluence://918847500">…</a>` — a dead link in the
  browser. The bare-id form is now rewritten to an absolute Confluence
  URL (`{base}/wiki/pages/viewpage.action?pageId={id}`) and rendered as
  a plain anchor, matching the B2 strategy already used for absolute
  internal URLs. The legacy `<ri:page ri:content-id="…"/>` storage
  shape is deliberately not emitted (it doesn't render anchor text on
  Confluence Cloud — see the comment on `rewriteConfluenceLinks`).
  - Throws `CONFLUENCE_LINK_NO_BASE_URL` if a bare-id link is
    encountered when no Confluence base URL is configured (the harness
    normally injects one).
  - Affected both write paths equally — using `replace_body: true` did
    not change the bug's surface area, despite earlier suspicion.

### Documentation

- **`resolve_page_link` description now documents both supported
  link forms** (`confluence://SPACE_KEY/PAGE_TITLE` preferred,
  `confluence://CONTENT_ID` supported) with the rendering trade-offs
  spelled out.

## [6.0.0] - 2026-04-23 - agent-safety hardening

Consolidates the findings from the 2026-04-23 agent-loop / mass-damage
investigation and the prompt-injection hardening investigation (see
`doc/design/investigations/`). Major version bump for two breaking
changes: `delete_page` now requires `version`, and `get_page` applies a
default `max_length`. See "Migration" at the bottom.

### Changed (breaking)

- **`delete_page` now requires a `version` parameter.** Mirrors
  `update_page`'s optimistic-concurrency check; a stale-context replay
  cannot delete a page someone else edited since you read it.
  - Existing behaviour restorable for one release via
    `EPIMETHIAN_LEGACY_DELETE_WITHOUT_VERSION=true` (emits a stderr
    warning on each call). Removed in the next minor release.
- **`get_page` / `get_page_by_title` now apply a default
  `max_length=50_000`.** Caps context-saturation attacks where a
  poisoned page floods the agent's context window. Callers who need the
  full body can pass `max_length: 0` as a sentinel for "no limit", or
  supply a larger explicit value. Responses include a
  `[truncated: full body is N chars; pass max_length=N to see more]`
  suffix when truncation occurs.

### Changed

- **Mutation log is enabled by default.** Previously opt-in via
  `EPIMETHIAN_MUTATION_LOG=true`; now on by default with explicit
  opt-out via `EPIMETHIAN_MUTATION_LOG=false`. The log is metadata-only
  (lengths, SHA-256 hashes, flag values, client labels) — never page
  bodies, titles, or credentials.
- **`set_page_status` is now a no-op when the current state matches.**
  Kills the version-churn pattern where an agent in a retry loop wrote
  the same status 1000 times, each creating a Confluence version.
- **`update_page` short-circuits when the submitted body is
  byte-identical to the current body.** Saves a version bump on the
  common "agent re-submits its own read-back unchanged" loop.
- **`update_page_section` now returns `isError: true` when the section
  is not found.** Previously returned a text-only "not found" message
  that agents monitoring `isError` treated as success.
- **Tightened markdown-format detection (`looksLikeMarkdown`).** Removed
  inline `**bold**` and `[text](url)` patterns from the strong-markdown
  signal list. Fixes a round-trip corruption where storage HTML with
  inline links was misclassified as markdown.

### Added — prompt-injection hardening

See `doc/design/investigations/investigate-prompt-injection-hardening/`
for the full threat model.

- **Unicode sanitisation inside `fenceUntrusted`** (Track D1). NFKC
  normalisation + stripping of Unicode tag characters
  (U+E0000–U+E007F), bidi controls, zero-width joiners, and C0/C1
  controls (preserving `\t`, `\n`, `\r`). Closes fullwidth-bracket
  fence spoofing, tag-character steganography, and RTL-override
  obfuscation.
- **Injection-signal scanning on fenced content** (Track D2). Scans for
  tool names, destructive flag names, instruction framing
  (`IGNORE ABOVE`, `NEW INSTRUCTIONS`, `<|im_start|>`, `SYSTEM:`), and
  fence-string references. Fence header gets
  `injection-signals=<comma-list>`; stderr emits
  `[INJECTION-SIGNAL]` line; correlated into mutation-log
  `precedingSignals` field.
- **Per-session canary + write-path echo detector** (Track D3). Every
  fence carries a `<!-- canary:EPI-… -->` comment. Writes whose body
  contains the canary or fence markers are rejected with
  `WRITE_CONTAINS_UNTRUSTED_FENCE`. Catches agents that copy a read
  response verbatim into a write.
- **`source` parameter on destructive tools** (Track E2). Optional
  enum (`user_request | file_or_cli_input | chained_tool_output`) on
  `update_page`, `update_page_section`, `revert_page`, `delete_page`,
  `create_page`. `source="chained_tool_output"` with any destructive
  flag is rejected unconditionally. Strict mode via
  `EPIMETHIAN_REQUIRE_SOURCE=true`.
- **Elicitation (human-in-the-loop) on gated operations** (Track E4).
  `delete_page`, `revert_page`, and `update_page` with destructive
  flags request user confirmation via MCP elicitation. Unsupported
  clients default to refuse; opt-out via
  `EPIMETHIAN_ALLOW_UNGATED_WRITES=true`.

### Added — mass-damage bounds

See `doc/design/investigations/investigate-agent-loop-and-mass-damage/`.

- **Session write budget** (Track F4). Defaults: 100 writes per
  process lifetime, 25 writes per rolling hour. Raise via
  `EPIMETHIAN_WRITE_BUDGET_SESSION=<n>` /
  `EPIMETHIAN_WRITE_BUDGET_HOURLY=<n>`; set either to `0` to disable.
- **Per-tool profile allowlist** (Track F2). Extend
  `~/.config/epimethian-mcp/profiles.json` with `allowed_tools` or
  `denied_tools` (mutually exclusive) to restrict a profile's tool
  surface. Unknown tool names abort startup.
- **Per-space profile allowlist** (Track F3). Extend the profile
  settings with `spaces: string[]`; every write-path tool (create, update,
  delete, section update, prepend/append, revert, attachment upload,
  label add/remove, page status, comment create) verifies the target
  space is on the list. Page-ID targets resolve the space via a cached
  metadata fetch (5-min TTL). An empty array rejects every write
  (paranoid no-write profile). `SpaceNotAllowedError` (code
  `SPACE_NOT_ALLOWED`) is surfaced to the agent.
- **Input body size cap** (Track A3). Rejects bodies larger than 2 MB
  with `INPUT_BODY_TOO_LARGE` before any conversion work.

### Added — forensics

- **Destructive-flag stderr banner** (Track C2). Writes with any
  destructive flag emit a `[DESTRUCTIVE]` stderr line naming the tool,
  page, flags, and client.
- **Confluence version-message destructive suffix** (Track C3).
  Destructive writes append `[destructive: <flags>]` to the Confluence
  `version.message`, surfaced in Confluence's native history view.
- **`clientSupportsElicitation()` capability detection** (Track E5).

### Migration

1. **`delete_page`**: add a `version` argument to every call. For
   one-off scripts, set
   `EPIMETHIAN_LEGACY_DELETE_WITHOUT_VERSION=true` temporarily.
2. **`get_page` default `max_length`**: agents needing the full body
   must pass `max_length: 0` explicitly.
3. **Mutation log default on**: opt out with
   `EPIMETHIAN_MUTATION_LOG=false` (not recommended).
4. **Elicitation default refuse on unsupported clients**: for
   non-interactive CI, set `EPIMETHIAN_ALLOW_UNGATED_WRITES=true`.
5. **Write budget defaults**: raise limits via env vars rather than
   disabling if your legitimate workflow needs more.

## [5.6.0] - 2026-04-23 - reject mixed markdown + storage input

### Changed

- **Bodies that mix Confluence storage tags with markdown structure are now
  rejected.** Previously, any body containing `<ac:`, `<ri:`, or `<time>`
  tags was classified as storage format and passed through unconverted — so
  callers that inlined a single `<ac:structured-macro>` at the top of an
  otherwise-markdown body had their markdown stored verbatim, rendering as
  literal `##` and `**` characters in Confluence. This was the most common
  way agents produced broken pages with `create_page` / `update_page` /
  `update_page_section`.
  - `safePrepareBody` now fires a `MIXED_INPUT_DETECTED` guard when the
    body contains BOTH a storage tag AND a line-anchored markdown
    structural pattern (ATX heading, fenced code block, GFM table
    separator, unordered/ordered list, GitHub alert, YAML frontmatter
    delimiter).
  - Detection strips fenced code blocks, `<![CDATA[...]]>`, and
    `<ac:plain-text-body>` content first, so markdown that *documents*
    storage format and storage code-macro bodies are not affected.
  - The rejection message points callers at the supported fixes:
    YAML frontmatter (`toc: { maxLevel, minLevel }`) for the TOC macro,
    directive syntax (`:info[...]`, `:mention[...]{...}`, `:date[...]`)
    for other macros, or a full conversion to storage format.
  - Tool descriptions for `create_page`, `update_page`, and
    `update_page_section` now spell out the same guidance up-front.

## [5.5.0] - 2026-04-18 - security audit fixes

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
