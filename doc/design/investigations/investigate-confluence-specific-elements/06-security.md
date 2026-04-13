# Security analysis

[← Back to index](README.md)

The markdown→storage converter sits on the write path of every Confluence page change made through the MCP. Its inputs originate, increasingly often, from LLMs processing third-party content (issue bodies, scraped pages, user prompts containing prompt-injected payloads). The threat model assumes inputs are **untrusted** by default.

This file consolidates every security concern surfaced during review and the mitigation expected in implementation.

## 1. CDATA injection in code blocks

**Threat.** A code block whose body contains the literal string `]]>` will structurally close the `<ac:plain-text-body><![CDATA[...]]></ac:plain-text-body>` wrapper, allowing the rest of the body to be interpreted as storage XML. An attacker can inject arbitrary macros, redirect users, or exfiltrate context.

**Mitigation.** Apply the canonical CDATA escape: split every `]]>` in the body into `]]]]><![CDATA[>`. This is the only correct way; do not use string substitution alone (e.g. replacing `>` after `]]` is brittle). Implement as a single dedicated function with a regression test asserting the literal `]]>` survives a round-trip without escape.

## 2. Macro injection via raw passthrough

**Threat.** A naïve "any line starting with `<ac:` passes through" rule lets prompt-injected content emit macros with side effects:
- `<ac:structured-macro ac:name="html">` (renders raw HTML on Confluence configurations that have the HTML macro enabled — historically a major XSS vector)
- `<ac:structured-macro ac:name="iframe">` (loads attacker-controlled URL inside the page; can frame login forms or session-bound dashboards)
- Marketplace macros with side effects (`webhook`, `redirect`, `external-content-import`)

**Mitigation.** Maintain an **explicit allowlist** of macros permitted via raw passthrough (Channel 4 in the [markdown design](04-markdown-syntax-design.md#channel-4--allowlisted-raw-storage-format-escape-hatch-for-new-content)). Initial allowlist: `info`, `note`, `warning`, `tip`, `success`, `panel`, `code`, `expand`, `toc`, `status`, `anchor`, `excerpt`, `excerpt-include`, `drawio`, `children`, `jira`. Anything else → error with a message identifying the rejected macro and pointing at the supported markdown syntax.

The allowlist must be a **constant in the converter source**, not a config value — runtime configuration of the allowlist would let an attacker who controls config widen the attack surface.

## 3. HTML escaping inside attribute values and `<ac:parameter>` text

**Threat.** Panel titles, status labels, expand titles, mention display text, page-link titles, image filenames, and Jira keys all become `<ac:parameter>` text or attribute values built by the converter. Without proper XML escaping, an attacker can break the XML structure (`</ac:parameter>` in a title) or inject attributes (`" onmouseover="evil()`) and pivot to XSS.

**Mitigation.** Escape `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`, `'` → `&#39;` in all converter-emitted attribute values and `<ac:parameter>` text. Use a single dedicated escape function; do not build XML by string concatenation without it. Regression test: every macro shim is fed an input containing all five characters and asserted to round-trip safely.

## 4. Raw HTML in markdown body

**Threat.** markdown-it allows raw HTML by default. An LLM processing third-party content might produce markdown containing `<script>`, `<img onerror=...>`, `<iframe src=...>`, etc. Confluence Cloud's storage-format renderer sanitises some of this at display time, but the safe assumption is that unsanitised HTML passes through.

**Mitigation.** Disable raw HTML in markdown-it by default (`html: false`). For trusted callers who need to embed HTML (rare; usually misuse), provide an explicit `allow_raw_html: true` opt-in that:
- Logs the call (caller, page ID, byte count of HTML) so usage can be audited.
- Carries a description noting the XSS implications, so the choice is informed.
- Is rejected in environments where `config.security.strict = true` (a future config knob).

## 5. URL-rewrite spoofing

**Threat.** Auto-rewrite of "Confluence base URL" links to `<ac:link>` lets pasted URLs become stable internal references — but if the host check uses substring or `startsWith` semantics, an attacker can craft URLs that bypass it: `https://entrixenergy.atlassian.net.attacker.com/wiki/...`, `https://attacker.com/wiki/spaces/ETD/?@entrixenergy.atlassian.net`, percent-encoded variants, etc. A misclassified URL would be emitted as `<ac:link>` with attacker-controlled `ri:content-id` — the rendered link looks internal to readers and bypasses any external-link warnings.

**Mitigation.** Parse both the configured base URL and every candidate link with a real URL parser (`new URL(...)`); compare *only* the resolved hostname after canonicalisation, not the string. Regression tests for:
- `entrixenergy.atlassian.net.attacker.com` — different host, must not match.
- `attacker.com:443/...?host=entrixenergy.atlassian.net` — different host, must not match.
- `entrixenergy.atlassian.net:8080` — same host, different port: decide explicitly (recommend match if scheme+host+port-or-default match).
- Percent-encoded host (`%65ntrixenergy.atlassian.net`) — must canonicalise before comparison.
- `userinfo@host` (`anything@entrixenergy.atlassian.net`) — must compare host, not authority.

## 6. Account-ID injection in mentions

**Threat.** `:mention[Display]{accountId=...}` writes the `accountId` value into `ri:account-id` as an XML attribute. An unvalidated value can break out of the attribute and inject XML structure.

**Mitigation.** Validate the account ID matches Atlassian's format before emission (current Cloud format: `557058:` followed by a UUID-shaped string, or `5b…` opaque IDs for older accounts). On format mismatch → error. The escape rule from #3 still applies as defence in depth.

## 7. Image filename / attachment-name injection

**Threat.** `ri:filename` attribute values come from caller input. Same XML-attribute-injection vector as #3 and #6.

**Mitigation.** Apply the standard escape from #3. Reject filenames containing path-traversal sequences (`../`) — Confluence stores attachments by name within the page, but the converter shouldn't normalise/strip path segments silently; reject and let the caller fix.

## 8. Token-ID forgery

**Threat.** The token-preservation [mechanism](01-data-preservation.md#mechanism--opaque-token-preservation) keys macros by `T####` IDs. An attacker who can submit markdown containing forged token IDs could attempt to:
- Reference a token from a different page they don't have write access to (cross-page leakage if the converter looks up by token without verifying ownership).
- Trigger lookups against an internal ID space, probing for valid IDs.

**Mitigation.** Token IDs are scoped to `(page_id, version)`. The sidecar built during the pre-fetch is the only trusted token table; tokens in caller's markdown that aren't in that sidecar → error. The converter does not maintain a global token registry; there is nothing to probe.

## 9. Resource exhaustion (large bodies, deeply-nested structures)

**Threat.** Markdown bodies with pathological nesting (10,000-deep blockquotes, recursive container fences, billion-laughs-style entity expansion in tables) can blow stack or take quadratic time.

**Mitigation.**
- markdown-it has built-in nesting limits (`maxNesting`, default 100). Confirm enabled.
- Set a hard size cap on input markdown (recommend 1 MB).
- Set a hard token-count cap on output (recommend 5 MB worth of storage XML).
- Reject inputs exceeding either cap with a clear error before parsing.
- Round-trip tests include a 100 KB pathological input (deep nesting + many tokens) to verify performance bounds in the [acceptance criteria](09-acceptance-criteria.md#performance).

## 10. Stored-XSS via attribution footer

**Threat.** The attribution footer is appended to every page write ([confluence-client.ts:484-486](../../../../src/server/confluence-client.ts#L484-L486)). If the footer template ever incorporates caller input, the same escape rule from #3 applies. Currently the footer is a constant; flag any future PR that templatises it for security review.

**Mitigation.** Code review checklist item; not a runtime mitigation. Document in `doc/data-preservation.md`.

## 11. Information disclosure via error messages

**Threat.** Detailed error messages from the converter ("malformed token T0042 in caller markdown — expected sidecar entry not found") could leak page structure to a caller who shouldn't have visibility (e.g., a caller who has write access but not read access on a page they're attempting to update — a contrived but possible Atlassian permission combo).

**Mitigation.** Errors that originate from the pre-fetched storage refer to tokens by ID only, never by content. The version-message log of explicit deletions follows the same rule (`"Removed T0042 (info macro)"` not `"Removed info macro 'Internal credentials'"`).

## Summary — security checklist for the implementation PR

- [ ] CDATA escape for `]]>` in code bodies (function + test)
- [ ] Macro allowlist constant in source; non-allowlisted macros → error (function + test)
- [ ] XML attribute/text escape function used everywhere; never raw concat (linter rule + tests)
- [ ] markdown-it `html: false` default; opt-in flag logged
- [ ] URL host check via `new URL(...)` host equality; spoofing regression tests
- [ ] Account-ID format validation
- [ ] Filename path-traversal rejection
- [ ] Token IDs scoped per `(page_id, version)`; forgery rejection test
- [ ] Input size cap and `maxNesting` limit
- [ ] Attribution footer flagged in code review checklist
- [ ] Error messages refer to tokens by ID only
