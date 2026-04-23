# Multi-Tenant Isolation

[← back to index](README.md)

The hardest failure mode for a consultant is a **silent cross-tenant write**:
an AI agent acting on your behalf, believing it is editing tenant A, actually
edits tenant B. This document describes the four independent mechanisms that
defend against it.

## 1. Named profiles with per-profile keychain entries

Each tenant you configure becomes a separate profile with its own keychain
entry, its own server name, and its own read-only flag. Profiles never share
credentials.

Creating profiles:

```bash
epimethian-mcp setup --profile globex
epimethian-mcp setup --profile acme-corp
```

Each MCP config then specifies exactly one profile:

```json
{
  "mcpServers": {
    "confluence": {
      "command": "epimethian-mcp",
      "env": { "CONFLUENCE_PROFILE": "acme-corp" }
    }
  }
}
```

The MCP server registers under a **profile-qualified name**
(`confluence-acme-corp` vs `confluence-globex`) so that if you have multiple
workspace folders open in the same IDE, tool calls cannot be routed to the
wrong server by accident.

See `src/server/index.ts` (`main()` in the file) and
`src/shared/profiles.ts:142-148` for the registry.

## 2. Profile registry (metadata only, no secrets)

`~/.config/epimethian-mcp/profiles.json` tracks known profile names and their
non-secret settings (`readOnly`, `attribution`). It never contains
credentials — those are only in the keychain.

Filesystem hygiene:

- Config directory created with mode `0700` (owner-only).
- Registry file written with mode `0600`.
- On read, the file is `stat`-ed and **rejected** if it is group- or
  world-writable (`(info.mode & 0o022) !== 0`), with a fallback to an empty
  registry so a compromised file cannot be used to enumerate tenants.
- Writes are atomic: content is written to a random-suffixed temp file, then
  `rename`-d into place.

See `src/shared/profiles.ts:18-101`.

## 3. Tenant identity verification (email-level)

On every server startup, `validateStartup()` calls
`GET /wiki/rest/api/user/current` and requires the authenticated email to
match the email stored in the profile (case-insensitive). This catches:

- The token silently starting to authenticate as a different user (unusual
  but possible if a token was rotated and re-issued to someone else).
- DNS hijacking that redirects your Confluence URL to a different tenant
  where the same token also happens to work — **only if** the different
  tenant authenticates you as a different email.

See `src/server/confluence-client.ts:195-210` and
`src/shared/test-connection.ts:1-43`.

This mechanism is **insufficient** by itself for the consultant workflow:
if you have access to two tenants under the same Atlassian email (common),
the check passes against both. The cloudId seal below closes that gap.

## 4. Tenant seal (cloudId)

This is the primary defence against the "same email, wrong tenant" scenario.

### Setup-time: sealing

After `testConnection` succeeds, `setup` fetches
`GET {url}/_edge/tenant_info`, which returns `{ cloudId, cloudName }`. The
user is then shown:

```
Tenant identity:
  Display name : Acme Corp
  Cloud ID     : 11111111-2222-3333-4444-555555555555
  URL          : https://acme.atlassian.net

Is this the tenant you intended? [y/N]
```

If you answer anything other than `y` / `yes`, setup aborts and **no
credentials are saved**. If you confirm, the `cloudId` and `displayName` are
stored alongside `url`/`email`/`apiToken` in the keychain JSON blob.

If `/_edge/tenant_info` is unreachable (self-hosted Confluence, network
error), setup prints a warning and saves without a seal. Startup-time
verification will then skip the seal check.

See `src/cli/setup.ts:146-208` and
`src/shared/test-connection.ts` (`fetchTenantInfo`).

### Startup-time: verifying

When the server starts with a named profile:

1. Live cloudId is fetched from `/_edge/tenant_info`.
2. If the profile has a stored cloudId, the two must match. **Mismatch is a
   hard exit** with a message naming the expected vs live tenant and a
   remediation command.
3. If the profile has no stored cloudId (pre-5.5 upgrade), the live value is
   written back to the keychain entry — "opportunistic seal". From the next
   startup onwards, the seal is enforced. A warning is logged.
4. **If the endpoint is unreachable for a sealed profile, startup is a hard
   exit** (fail-closed). An attacker who can selectively block
   `/_edge/tenant_info` (network MITM, DNS poisoning, egress filter) would
   otherwise bypass the seal by preventing the live-cloudId comparison.
   The error message distinguishes "unreachable" from "mismatch" so users
   can diagnose network vs tampering.
5. If the endpoint is unreachable for an **unsealed** profile (no stored
   cloudId yet), startup logs a warning and continues. Nothing to compare
   against, and blocking would break upgrade paths from pre-5.5.

See `src/server/confluence-client.ts:227-299`, function `verifyOrSealTenant`.

### What the seal does and does not catch

Catches:

- A corrupted/edited profile JSON where the URL now points at a different
  tenant (the cloudId from that tenant differs).
- A setup-time URL typo that authenticates against the wrong tenant under
  the same email — **only because the user is prompted to confirm the
  display name before save**.
- DNS hijacking that routes traffic to a different tenant.

Does not catch:

- Users who blindly press `y` at the confirmation prompt without reading
  it. The security depends on that prompt being meaningful.
- Tenants that do not expose `/_edge/tenant_info` at **initial setup**
  (the profile is saved without a seal; future startups will try again).
  Once a profile has been sealed, the endpoint must respond — a
  selective block is a hard exit.
- A cloud provider that returns the same `cloudId` from both tenants — not
  a documented Atlassian behaviour and would be a bug on their side.

## 5. Tenant echo on every write

Every mutating tool response includes a human-readable tenant line so the AI
agent (and, when transcripts are reviewed, the user) can see exactly which
tenant was written to. This is defence-in-depth, not a guard per se.

## 6. Per-profile read-only mode

Profiles default to read-only at setup (`--read-write` opts out, interactive
prompt is `[y/N]`). When a profile is marked read-only:

- The registry records `settings.{profile}.readOnly = true`.
- At startup, `getConfig()` resolves `readOnly` as **strict OR** of the
  registry setting and the `CONFLUENCE_READ_ONLY` env var.
  `CONFLUENCE_READ_ONLY=false` does **not** override a registry-level
  `readOnly: true`. Either source saying read-only wins.
- Every write tool (`create_page`, `update_page`, `update_page_section`,
  `delete_page`, `add_attachment`, `add_drawio_diagram`, `add_label`,
  `remove_label`, `create_comment`, `resolve_comment`, `delete_comment`,
  `set_page_status`, `remove_page_status`) refuses the call with a
  remediation command.
- The flag is resolved **at startup** and then frozen. Toggling it requires
  restarting the server.

See `src/server/confluence-client.ts:127-132`.

## 7. What env-var mode does and does not protect

Env-var mode (all three `CONFLUENCE_*` vars set, no profile) exists for
CI/CD where no keychain daemon is running. It **does not participate in the
seal mechanism** — there is no keychain entry to write the cloudId back to.
The email-level identity check still runs.

If you are a consultant running locally, you should never be in env-var
mode. The stderr banner on startup will say `(env-var mode)` instead of
`(profile: ...)` — if you see that unexpectedly, your `CONFLUENCE_PROFILE`
env var was not delivered to the server process.

See also [06-limitations.md § Silent env-var fallback](06-limitations.md).

## 8. v6.0.0: intra-tenant blast-radius limiter (`spaces` allowlist)

The cloudId seal above protects against *cross-tenant* writes. Within a
single tenant, a profile may still have more write access than any given
session actually needs. v6.0.0 adds a per-profile `spaces` allowlist:

```jsonc
{
  "profiles": ["acme-docs"],
  "settings": {
    "acme-docs": {
      "spaces": ["DOCS", "ENG"]
    }
  }
}
```

Every write-path handler resolves the target space (from the
`space_key` argument directly, or from the page's metadata when only
`page_id` is supplied) and rejects writes outside the list with
`SpaceNotAllowedError`. The `page_id → space` mapping is cached for
5 minutes; a page moved into an allowed space during the cache window
remains the blocked-space identity until the TTL expires.

Reads are intentionally NOT gated by `spaces` in this release — a
locked-down posture against exfiltration should rely on Atlassian's
own space permissions, which the per-tenant API token inherits.

See `src/server/space-allowlist.ts` and the investigation
`doc/design/investigations/investigate-prompt-injection-hardening/08-capability-scoping.md`.
