# Security & Safety Overview

This document suite is aimed at a prospective user — typically a consultant or
security-conscious team — who needs to evaluate whether this MCP server is safe
to point at a real Atlassian tenant. Every claim below is linked to a specific
file and, where practical, a line reference so you can verify it yourself.

If you are short on time, read this page plus
[06-limitations.md](06-limitations.md). The rest is detail.

## 1. Who this tool is for

- **Consultants** working across multiple client tenants, who need strong
  isolation guarantees so an AI agent acting against "client A" cannot
  accidentally touch "client B".
- **Power users** who want features beyond the official Atlassian MCP server
  (draw.io diagrams, macros, section editing) without accepting an additional
  hosted service in the trust chain.
- **Teams with strict credential-handling policies** that disallow API tokens
  in `.mcp.json`, `.env`, or other plaintext config.

Epimethian is **not** designed for:

- Environments that want to proxy Confluence API traffic through a central
  service for audit/quota/governance. All API calls go direct from the user's
  machine to Atlassian.
- Confluence Data Center / Server. The tool assumes Confluence Cloud
  (`*.atlassian.net`) and relies on endpoints like `/_edge/tenant_info` that
  may not exist on self-hosted deployments. See
  [06-limitations.md](06-limitations.md).

## 2. Threat model

The table below lists the threats the design actively mitigates, the
mitigation, and whether it is a hard guarantee or best-effort.

| Threat | Mitigation | Strength |
| --- | --- | --- |
| API token leaks via plaintext config | Token stored only in OS keychain; masked input during setup | **Hard** |
| API token leaks via shell scrollback | `setup` uses raw-mode masked input (echoes `*`) | **Hard** |
| API token leaks via `/proc/<pid>/environ` / `ps` | `CONFLUENCE_API_TOKEN` deleted from `process.env` immediately after read in env-var mode | Best-effort (race window during startup) |
| Cross-tenant writes from credential misconfiguration | Named profiles + atomic (url, email, token) keychain entry + tenant-identity check + cloudId seal | **Hard** (see caveats in [02-multi-tenant.md](02-multi-tenant.md)) |
| Cross-tenant writes from a setup-time URL typo | Setup prompts the user to confirm tenant display name + cloudId + URL before saving | **Hard** (non-interactive `--yes` weakens this) |
| Silent tenant swap (DNS change, URL reassignment) | Startup re-fetches cloudId and compares to seal; mismatch → hard exit | **Hard** when `/_edge/tenant_info` is reachable; best-effort otherwise |
| AI agent accidentally deletes most of a page | Shrinkage guard (>50% loss), structural integrity guard (>50% heading loss), macro-loss, table-loss guards, post-transform catastrophic-reduction guard | **Hard** (shrinkage/structure/macro/table have opt-outs; post-transform does not) |
| AI agent writes to a page it should only read | Per-profile read-only flag (resolved at startup); all write tools refuse with a remediation command | **Hard** when set |
| Lossy round-trip from markdown view | `get_page(format: "markdown")` emits an HTML-comment marker; `update_page` rejects any body containing it | **Hard** |
| Stale write overwrites concurrent changes | Optimistic concurrency: all updates carry a version number; 409 surfaces as a clear error | **Hard** |
| Shell-metacharacter injection via profile name | Regex `/^[a-z0-9][a-z0-9-]{0,62}$/`; `execFile`/`spawn` (never shell) for keychain CLIs | **Hard** |
| Malicious storage-format content or runaway macros | Source-level macro allowlist (not config-driven); XML attribute/text/CDATA escaping | **Hard** |
| Attacker-writable config directory | `~/.config/epimethian-mcp/` created `0700`, files `0600`; registry reads reject group/world-writable files | **Hard** |
| Attacker symlink swap on mutation log | Log directory rejects symlink, logs opened with `O_EXCL + 0600` | **Hard** |
| Credential leakage through error messages | `sanitizeError()` redacts `Basic …`, `Bearer …`, and `Authorization:` headers in all surfaced errors | **Hard** |

The design does **not** defend against:

- A compromised local user account (reading the keychain with user consent).
- An AI agent given elevated privileges (`CONFLUENCE_READ_ONLY=false` +
  `confirm_shrinkage: true`) deliberately wiping content. Guards catch
  accidents, not adversaries with valid credentials and opt-outs.
- A local attacker who can write to the user's `~/.config/epimethian-mcp/`
  before setup runs (they could plant a profile that points at their own
  tenant — though the tenant identity check and seal would catch it at
  startup).
- `NODE_TLS_REJECT_UNAUTHORIZED=0` or other disabled TLS verification — all
  tenant-isolation guarantees rely on TLS validating the Atlassian hostname.

## 3. Defense in depth at a glance

Every write to Confluence crosses **seven** independent guards:

1. **Startup: authentication** — token accepted by the tenant.
2. **Startup: tenant identity** — `/wiki/rest/api/user/current` confirms the
   authenticated email matches what the profile expects.
3. **Startup: tenant seal** — `/_edge/tenant_info` confirms the cloudId matches
   the one recorded at setup (prevents silent tenant swap).
4. **Request time: read-only flag** — every write tool refuses when the
   profile is marked read-only.
5. **Pre-transform: safe-prepare** — shrinkage, structural-integrity, empty-body,
   macro-loss, and table-loss guards run before markdown → storage conversion.
6. **Post-transform: catastrophic-reduction guard** — `safeSubmitPage` rejects
   whitespace-only output or >90% reduction (no opt-out).
7. **Request time: optimistic concurrency** — stale version numbers surface as
   a 409 with a remediation message, preventing last-writer-wins overwrites.

## 4. Section index

- [01-credentials.md](01-credentials.md) — How tokens are stored, read, and never written to disk.
- [02-multi-tenant.md](02-multi-tenant.md) — Profile isolation, tenant identity check, cloudId seal.
- [03-write-safety.md](03-write-safety.md) — Content-loss guards and mutation log.
- [04-input-validation.md](04-input-validation.md) — Regexes, escaping, allowlists, injection prevention.
- [05-observability.md](05-observability.md) — What is logged where, and what is deliberately *not* logged.
- [06-limitations.md](06-limitations.md) — Known gaps, deferred items, and explicit tradeoffs.

## 5. How to verify any claim in this suite

Every section includes `file:line` references. To verify:

```
git clone https://github.com/de-otio/epimethian-mcp.git
cd epimethian-mcp
# Then open the referenced file at the given line.
```

The test suite (`npm test`) exercises the credential resolver, keychain I/O,
content-safety guards, mutation log, tenant-seal verification, and most
converters — roughly 3,400 tests across ~100 files. Running it is the fastest
way to confirm the guards behave as described.
