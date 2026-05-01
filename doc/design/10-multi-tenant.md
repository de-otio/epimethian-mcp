# Multi-Tenant Atlassian Support

## Problem

Consultants routinely work across multiple Atlassian tenants -- one per customer. A typical workflow involves several VS Code instances open in different project directories, each bound to a different tenant, plus occasional use of Claude Code CLI. The current single-credential architecture cannot support this safely. Writing to the wrong Confluence instance is a catastrophic security breach: confidential customer content would leak to an unauthorized tenant.

### Threat Model

| Scenario | How it happens today | Severity |
|----------|---------------------|----------|
| Wrong token in keychain | User runs `setup` for tenant B, overwriting tenant A credentials. Next VS Code window still has tenant A's URL in `.mcp.json` but now uses tenant B's token. | **Critical** -- auth may succeed if user has accounts on both tenants, routing writes to the wrong instance |
| Wrong URL in `.mcp.json` | User copies `.mcp.json` between projects without updating the URL. Token in keychain authenticates against the wrong tenant. | **Critical** -- silent cross-tenant data leak |
| Partial env var credential mixing | `.mcp.json` sets `CONFLUENCE_URL` but not `CONFLUENCE_API_TOKEN`. Current `getConfig()` silently fills missing fields from keychain, mixing URL from one tenant with token from another. | **Critical** -- exists today in production code (`confluence-client.ts:20-33`) |
| Stale keychain after rotation | User rotates token for tenant A. Keychain still has old token. Server falls back or fails silently. | Medium -- likely auth failure, but confusing |
| Ambiguous active tenant | Multiple terminal sessions, unclear which Confluence instance each is targeting. | High -- human error leading to any of the above |
| MCP tool disambiguation in multi-root workspace | VS Code multi-root workspace loads two `.mcp.json` files, both registering identical tool names (`create_page`, etc.). AI routes call to wrong server instance. | **High** -- silent cross-tenant write |
| Credential leak via error messages | Confluence API error body echoed verbatim to AI conversation. Response may contain internal hostnames, request IDs, or in edge cases, reflected headers. | Medium -- information disclosure |
| DNS hijacking / URL reassignment | Tenant URL resolves to a different Confluence instance (DNS attack, or Atlassian reassigns a deprovisioned subdomain). Startup validation passes because the token authenticates. | Medium -- unlikely but catastrophic if exploited |
| Prompt injection via page content | Malicious content in a retrieved Confluence page manipulates the AI into calling tools targeting the wrong profile or leaking data cross-tenant. | Medium -- defense is in the MCP client, not this server |

## Design

### Named Profiles

Replace the single keychain entry with **named profiles**. Each profile stores the complete credential set (URL, email, API token) as a unit in the OS keychain. The profile name is the sole selector -- there is no mixing of env-var URL with keychain token from a different profile.

**Keychain addressing:**

| | Current | New |
|---|---------|-----|
| Service | `epimethian-mcp` | `epimethian-mcp` |
| Account | `confluence-credentials` | `confluence-credentials/{profile-name}` |
| Data | `{url, email, apiToken}` | `{url, email, apiToken}` |

Profile names are lowercase alphanumeric with hyphens (validated: `/^[a-z0-9][a-z0-9-]{0,62}$/`). Short, human-readable identifiers like `globex`, `acme-corp`, `client-x`.

### Configuration

Projects select a profile via the `CONFLUENCE_PROFILE` environment variable in `.mcp.json`:

```json
{
  "mcpServers": {
    "confluence": {
      "command": "/opt/homebrew/bin/epimethian-mcp",
      "env": {
        "CONFLUENCE_PROFILE": "globex"
      }
    }
  }
}
```

A second project targeting a different tenant:

```json
{
  "mcpServers": {
    "confluence": {
      "command": "/opt/homebrew/bin/epimethian-mcp",
      "env": {
        "CONFLUENCE_PROFILE": "acme-corp"
      }
    }
  }
}
```

The profile name is the **only** configuration that varies between projects. URL, email, and token are all resolved from the keychain entry for that profile. `CONFLUENCE_URL` and `CONFLUENCE_EMAIL` are no longer needed in `.mcp.json` when using profiles.

### Credential Resolution Order

```
1. If CONFLUENCE_PROFILE is set:
   a. Validate profile name matches /^[a-z0-9][a-z0-9-]{0,62}$/
   b. Read {url, email, apiToken} from keychain entry for that profile
   c. If any field is missing → hard error, refuse to start
   d. Proceed to startup validation (see below)

2. Else if CONFLUENCE_URL + CONFLUENCE_EMAIL + CONFLUENCE_API_TOKEN are ALL set:
   a. Use them directly (existing behavior, no keychain involved)
   b. This path exists for CI/CD pipelines and Docker containers where
      keychain is unavailable

3. Else if any partial combination of env vars is set (1 or 2 of 3):
   a. Hard error, refuse to start:
      "Error: Partial credentials detected. Either set CONFLUENCE_PROFILE
       or provide all three environment variables (CONFLUENCE_URL,
       CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN).
       Run `epimethian-mcp setup --profile <name>` for guided setup."
   b. No merging of env vars with keychain values. This is a deliberate
      safety decision -- mixing credential sources is the primary cause
      of cross-tenant data leaks.

4. Else if no env vars are set:
   a. Read the "default" profile from keychain (backward compat)
   b. If found, emit deprecation warning to stderr:
      "Warning: Using legacy default keychain entry.
       Run `epimethian-mcp setup --profile <name>` to migrate."
   c. If not found → hard error with setup instructions
```

**Critical: no credential merging.** The current `getConfig()` implementation silently merges env-var URL with keychain token -- this is the exact cross-tenant mixing bug the design exists to eliminate. Step 3 above replaces the merge with a hard error. Credentials always come from a single atomic source: either a named profile (step 1), all three env vars (step 2), or the legacy default keychain entry (step 4).

### Startup Validation

On every server start, before accepting any tool calls:

1. **URL-token binding check**: Make a lightweight API call (`GET /wiki/api/v2/spaces?limit=1`) to confirm the token authenticates against the configured URL. If this returns 401/403, the server refuses to start with a clear error:
   ```
   Error: Confluence credentials rejected by https://globex.atlassian.net
   The API token stored in profile "globex" is not valid for this instance.
   Run `epimethian-mcp setup --profile globex` to update credentials.
   ```

2. **Tenant identity verification**: After successful authentication, call `GET /wiki/rest/api/user/current` and verify the returned email matches the email stored in the profile. This guards against DNS hijacking or URL reassignment scenarios where the URL resolves to a different tenant but the token still authenticates. A mismatch is a hard error:
   ```
   Error: Tenant identity mismatch for profile "globex".
   Expected user: richard.myers@globex.com
   Authenticated as: someone.else@othertenant.com
   This may indicate a DNS or configuration issue. Run `epimethian-mcp setup --profile globex` to reconfigure.
   ```

3. **Tenant identity log**: Emit to stderr (visible to MCP clients that surface server logs):
   ```
   epimethian-mcp: connected to https://globex.atlassian.net as richard.myers@globex.com (profile: globex)
   ```

4. **Freeze validated config**: The `_config` singleton records the confirmed tenant URL and is frozen with `Object.freeze()`. All subsequent operations use this validated, immutable config. No code path can modify it at runtime.

### Write-Operation Tenant Echo

Every mutating tool response (create, update, delete, add_attachment, add_drawio_diagram) includes a tenant confirmation line in its output:

```
Page created: "Sprint 42 Retrospective" (ID: 123456)
URL: https://globex.atlassian.net/wiki/spaces/DEV/pages/123456
Tenant: globex.atlassian.net (profile: globex)
```

This makes the target tenant visible in the AI assistant's conversation, giving the user a final opportunity to catch a mismatch before the conversation continues.

### CLI Changes

#### `epimethian-mcp setup --profile <name>`

Interactive credential setup for a named profile:

```
$ epimethian-mcp setup --profile globex

Epimethian MCP - Credential setup for profile "globex"

Confluence URL (e.g. https://yoursite.atlassian.net): https://globex.atlassian.net
Email: richard.myers@globex.com
API token: ************************************

Testing connection to https://globex.atlassian.net...
Connected. 14 spaces accessible.

Credentials saved to OS keychain (profile: globex).
```

Running `setup --profile globex` again updates only the `globex` entry. Other profiles are untouched.

`setup` without `--profile` writes to the `default` profile (backward compatible with the current single-entry model, but with a migration nudge).

#### `epimethian-mcp profiles`

List all configured profiles:

```
$ epimethian-mcp profiles

  Profile      URL                                Email
  ─────────    ──────────────────────────────      ─────────────────────────
  globex       https://globex.atlassian.net        richard.myers@globex.com
  acme-corp    https://acme.atlassian.net          rmyers@acme-consulting.com
  default      https://globex.atlassian.net        richard.myers@globex.com
```

Implementation: the keychain does not support listing entries by prefix. Instead, maintain a profile registry file at `~/.config/epimethian-mcp/profiles.json`:

```json
{
  "profiles": ["globex", "acme-corp", "default"]
}
```

This file contains only profile names (no secrets). The `setup` command appends to it. The `profiles` command iterates the list and reads each keychain entry to display URL/email. The `profiles --remove <name>` subcommand deletes the keychain entry and removes the name from the registry.

**Registry file security:**

- Create `~/.config/epimethian-mcp/` with mode `0700` and `profiles.json` with mode `0600`. While the file contains no secrets, the profile list reveals which Atlassian tenants the user works with -- for a consultant, this is a confidential client list.
- Use atomic writes (write to a temp file in the same directory, then `rename()`) to prevent corruption from interrupted writes or power loss.
- Validate JSON schema on read. If the file is corrupted, emit a warning and treat it as empty rather than crashing. If a listed profile has no corresponding keychain entry, display "credentials missing" rather than failing.
- The `profiles` command shows URL and email only with `--verbose`. Default output shows profile names only.

#### `epimethian-mcp status`

Show the currently active connection (useful when debugging which profile a terminal session is using):

```
$ CONFLUENCE_PROFILE=globex epimethian-mcp status

Profile:  globex
URL:      https://globex.atlassian.net
Email:    richard.myers@globex.com
Status:   Connected (14 spaces accessible)
```

### Keychain Changes

The `keychain.ts` module gains a `profile` parameter with built-in validation:

```typescript
// Current
const ACCOUNT = 'confluence-credentials';

// New
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function accountForProfile(profile: string): string {
  // Defense-in-depth: validate here regardless of caller-side checks.
  // This is the chokepoint -- all keychain operations flow through it.
  // The regex also prevents names starting with "-" (which could be
  // misinterpreted as flags by the `security` / `secret-tool` CLIs).
  if (!PROFILE_NAME_RE.test(profile)) {
    throw new Error(`Invalid profile name: "${profile}". Use lowercase alphanumeric and hyphens only.`);
  }
  return `confluence-credentials/${profile}`;
}

export async function saveToKeychain(
  creds: KeychainCredentials,
  profile: string = 'default'
): Promise<void> { ... }

export async function readFromKeychain(
  profile: string = 'default'
): Promise<KeychainCredentials | null> {
  // Distinguish "entry not found" (return null) from "entry found but
  // corrupted/unparseable" (throw). Corrupted keychain data indicates
  // tampering or a bug and must not silently fall through to another
  // resolution path.
  ...
}

export async function deleteFromKeychain(
  profile: string = 'default'
): Promise<void> { ... }
```

**Error handling**: Keychain operation errors (from `security` / `secret-tool` stderr) are remapped to generic messages before propagating to the MCP client. System-specific details (keychain paths, OS user names, error codes) are logged to stderr for debugging but never returned in tool output.

### install-agent.md Changes

The agent installation guide is updated to use profiles:

- Step 3 asks for profile name, URL, and email
- Step 4 writes `.mcp.json` with `CONFLUENCE_PROFILE` only
- Step 5 runs `epimethian-mcp setup --profile <name>`
- A new section covers adding additional tenants

### Safety Invariants

These are the non-negotiable safety properties of the design:

1. **Profile credentials are atomic.** URL, email, and token are always stored and retrieved as a unit. There is no code path where a token from profile A is combined with a URL from profile B. Partial env var combinations are a hard error, not a merge.

2. **Startup validation is mandatory.** The server will not accept tool calls until it has confirmed the token authenticates against the configured URL and the authenticated user identity matches the stored email. A 401/403 or identity mismatch is a hard stop.

3. **No operations without a profile.** If `CONFLUENCE_PROFILE` is unset and the server falls back to the legacy default keychain entry, all operations -- including reads -- emit a deprecation warning. Reading from the wrong tenant can surface confidential content into the wrong conversation context, which is also a data leak. A future major version will make `CONFLUENCE_PROFILE` strictly required.

4. **Profile names are inert.** The profile name is a local label for the keychain entry. It is never sent to Confluence, never used in API calls, and never affects which tenant is targeted. Only the URL in the keychain entry determines the target.

5. **Overwrite requires intent.** `setup --profile X` only overwrites profile X. There is no mode that silently replaces one profile with another.

6. **Config is frozen after validation.** The `_config` singleton is `Object.freeze()`-d after startup validation. No code path can mutate the active tenant URL, auth header, or profile binding for the lifetime of the process.

7. **No secrets in tool output.** Error messages from Confluence API responses are sanitized before being returned to the MCP client. The raw API response body is truncated (max 500 chars) and stripped of anything resembling an auth header or base64 token. Full error details are logged to stderr only. The `authHeader` is never stored in a serializable long-lived object -- compute it on demand or ensure the config object excludes it from `JSON.stringify()`.

8. **Profile name validation at the chokepoint.** The `accountForProfile()` function in `keychain.ts` validates the profile name against `/^[a-z0-9][a-z0-9-]{0,62}$/` on every call, regardless of caller-side validation. This prevents injection into the keychain account field and ensures names cannot start with `-` (which would be misinterpreted as CLI flags by `security` / `secret-tool`).

## Migration Path

### Phase 1: Backward-Compatible Introduction

- Add `--profile` flag to `setup`
- Add `CONFLUENCE_PROFILE` env var support to credential resolution
- Add `profiles` and `status` subcommands
- Add startup validation (live API check)
- Add tenant echo to mutating tool responses
- Legacy single-credential path continues to work with deprecation warning

### Phase 2: Encourage Adoption

- `install-agent.md` defaults to profile-based setup
- `setup` without `--profile` prompts: "Enter a profile name (or press Enter for 'default'):"
- CLI emits migration hint when legacy path is used

### Phase 3: Deprecate Legacy Path

- Legacy resolution (step 3) emits a louder warning
- Documentation removes legacy examples
- Consider making `CONFLUENCE_PROFILE` required in a future major version

## Security Testing Requirements

The following tests must exist before multi-tenant support ships. They are the automated proof that the safety invariants hold.

**Credential isolation (invariant 1):**
- Setting 1 or 2 of 3 env vars (without `CONFLUENCE_PROFILE`) produces a hard error, not a silent merge.
- `getConfig()` with `CONFLUENCE_PROFILE=X` reads only from profile X's keychain entry. Env vars `CONFLUENCE_URL` / `CONFLUENCE_EMAIL` / `CONFLUENCE_API_TOKEN` are ignored when a profile is set.

**Profile name validation (invariant 8):**
- Valid names: `a`, `my-tenant`, `client-123`, 63-char max.
- Rejected names: empty string, `-starts-with-dash`, `UPPERCASE`, `has spaces`, `has/slash`, `has..dots`, null bytes, unicode, names longer than 63 chars.
- Validation enforced in `accountForProfile()` regardless of call site.

**Keychain error handling:**
- "Entry not found" returns null.
- "Entry found but unparseable JSON" throws (does not silently return null).
- Keychain operation errors produce generic error messages, not raw stderr.

**Error sanitization (invariant 7):**
- Confluence API error responses containing auth-header-like strings are sanitized before reaching tool output.
- Full error details appear in stderr, not in MCP tool response.

**Startup validation (invariant 2):**
- Server refuses to start on 401/403 from validation call.
- Server refuses to start if authenticated email does not match profile email.

## Architecture Diagram

```
  ┌──────────────────────┐     ┌──────────────────────┐
  │  VS Code (Project A)  │     │  VS Code (Project B)  │
  │  .mcp.json:           │     │  .mcp.json:           │
  │    CONFLUENCE_PROFILE  │     │    CONFLUENCE_PROFILE  │
  │    = "globex"          │     │    = "acme-corp"       │
  └───────┬──────────────┘     └───────┬──────────────┘
          │ stdio                       │ stdio
          ▼                             ▼
  ┌──────────────────────┐     ┌──────────────────────┐
  │  epimethian-mcp       │     │  epimethian-mcp       │
  │  (process 1)          │     │  (process 2)          │
  │                       │     │                       │
  │  Profile: "globex"    │     │  Profile: "acme-corp" │
  │  Reads keychain:      │     │  Reads keychain:      │
  │  confluence-           │     │  confluence-           │
  │  credentials/globex    │     │  credentials/acme-corp │
  └───────┬──────────────┘     └───────┬──────────────┘
          │ HTTPS                       │ HTTPS
          ▼                             ▼
  ┌──────────────────────┐     ┌──────────────────────┐
  │  globex.atlassian.net  │     │  acme.atlassian.net   │
  └──────────────────────┘     └──────────────────────┘
```

Each MCP server process is fully isolated: separate OS process, separate keychain entry, separate Confluence instance. There is no shared state between them.

## Resolved Design Decisions

1. **`profiles --remove` requires interactive confirmation.** Deleting a profile erases the keychain entry permanently. The CLI prompts `Remove profile "X" and delete its credentials? [y/N]` before proceeding. Pass `--force` to skip the prompt, but only when stdin is not a TTY (actual CI environments). When stdin is a TTY, `--force` is ignored and the interactive prompt is always shown -- this prevents scripted credential destruction via malicious tools running in the user's terminal. All profile deletions are logged to `~/.config/epimethian-mcp/audit.log` with a timestamp.

2. **All operations require a profile -- including reads.** Reading from the wrong tenant is also a security concern: a consultant could inadvertently surface confidential page content from tenant B into a conversation or tool output scoped to tenant A. The server refuses to start without a resolved profile. There is no anonymous or unscoped mode.

3. **Startup validation uses in-memory caching, not filesystem.** The startup API call adds ~200-500ms of latency. A filesystem-based cache (`$TMPDIR`) was considered but rejected due to TOCTOU race conditions, symlink attacks on shared Linux machines, and the difficulty of binding cache validity to specific credentials. Instead, validation results are cached in-memory within the process. Since each MCP server process lives for the duration of the MCP client session (typically hours), the validation cost is paid once per session -- an acceptable trade-off for a security-critical check. If the server process is restarted, it re-validates. This is the correct behavior: a restart may follow a credential rotation.

4. **MCP server name includes the profile.** The server registers with `name: "confluence-{profile}"` (e.g., `confluence-globex`) rather than the generic `confluence`. This causes MCP clients that namespace tools by server name to display `confluence-globex.create_page` vs `confluence-acme-corp.create_page`, preventing tool routing confusion in multi-root VS Code workspaces. Multi-root workspaces with multiple Confluence profiles are supported but should be documented as requiring extra caution.

5. **URL validation beyond `https://`.** The `setup` command parses the URL with `new URL()` and rejects anything containing `@`, newlines, or non-printable characters. If the URL hostname does not match `*.atlassian.net`, emit a warning (not a hard block, for Confluence Data Center users): `"Warning: URL does not match *.atlassian.net. Ensure this is the correct Confluence instance."` The security model depends on TLS certificate validation -- the design explicitly documents that setting `NODE_TLS_REJECT_UNAUTHORIZED=0` undermines all tenant isolation guarantees.

6. **`CONFLUENCE_API_TOKEN` cleared after read.** When credentials are resolved from environment variables (step 2), the server deletes `process.env.CONFLUENCE_API_TOKEN` immediately after reading it. This reduces the window during which the token is visible via `/proc/<pid>/environ` (Linux) or `ps eww` (macOS). Document that env-var authentication should only be used in CI/CD where keychain is unavailable.
