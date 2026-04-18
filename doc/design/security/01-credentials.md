# Credential Storage & Handling

[← back to index](README.md)

This document describes how your Atlassian URL, email, and API token move
through the system — from the moment you type them at the `setup` prompt to
the moment they're used in an HTTPS request.

## Storage

Credentials live in the **OS keychain**, never on disk in plaintext.

- macOS: uses `security add-generic-password` (Keychain Access)
- Linux: uses `secret-tool store` (libsecret / GNOME Keyring or KWallet)
- Other platforms: unsupported — the server errors on startup rather than
  falling back to a plaintext store.

See `src/shared/keychain.ts:48-107`.

Each profile's credentials are stored as a **single JSON blob** containing
`{ url, email, apiToken, cloudId?, tenantDisplayName? }`. This is deliberate:
it makes it structurally impossible to end up with the URL from profile *A*
paired with the token from profile *B* — they move together or not at all.

See `src/shared/keychain.ts:28-36`.

## Keychain account name

A profile named `globex` is stored under service `epimethian-mcp`, account
`confluence-credentials/globex`. The account name is produced by
`accountForProfile()`, which re-validates the profile name against the strict
regex (see below) regardless of caller-side checks. This is a
chokepoint — no keychain call can bypass it.

See `src/shared/keychain.ts:13, 19-26, 115-120`.

## Profile name regex

```
/^[a-z0-9][a-z0-9-]{0,62}$/
```

- Lowercase alphanumeric plus hyphen, 1–63 chars.
- **Must start with `[a-z0-9]`**, not a hyphen — otherwise the name could be
  mis-parsed as a flag by `security` or `secret-tool` and change the meaning
  of the command.
- Both `execFile` and `spawn` are used (never `exec`), so even a name that
  slipped through the regex could not inject shell metacharacters.

See `src/shared/keychain.ts:13, 19-26, 78-91`.

## Reading credentials at startup

`src/server/confluence-client.ts:51-119`, function `resolveCredentials()`.

Resolution order — **no merging across sources**:

1. `CONFLUENCE_PROFILE` env var set → read *all* fields from that named
   keychain entry. If the name fails validation, hard exit. If the entry is
   missing, hard exit with a `setup --profile <name>` hint.
2. All three of `CONFLUENCE_URL` / `CONFLUENCE_EMAIL` / `CONFLUENCE_API_TOKEN`
   set → use them directly ("env-var mode", intended for CI/CD). The token
   env var is `delete`d from `process.env` immediately after read to reduce
   the exposure window to `/proc/<pid>/environ` and `ps eww`.
3. Partial env vars (1 or 2 of 3 set) → **hard error**. This is deliberate:
   it catches the mistake of forgetting `CONFLUENCE_PROFILE` in a shell that
   happens to have stale `CONFLUENCE_*` exports from another context.
4. No env vars at all → hard error with setup instructions. There is no
   legacy/default-profile fallback in this path.

The token is extracted into the Basic-auth header exactly once, into a
`Config` object that is then `Object.freeze()`-d. There is no public API to
swap credentials at runtime.

See `src/server/confluence-client.ts:142-162`.

## Interactive setup

`src/cli/setup.ts` handles the guided setup flow.

- The command refuses to run without an interactive TTY
  (`stdin.isTTY` check), to prevent non-interactive pipelines from leaking a
  token via an ill-thought-out `echo` or heredoc.
- The API token prompt uses **raw mode** with a custom handler that echoes
  `*` per character, handles backspace (`0x7F` / `0x08`), and treats `Ctrl+C`
  as an abort. The token never appears in shell scrollback.
- The URL is validated: must start with `https://`, must parse as a URL,
  must not contain `user:pass@`-style credentials embedded in the URL, and
  must not contain newlines. A warning (not an error) is printed if the
  hostname is not `*.atlassian.net`.
- On successful connection, the setup command **always** asks you to confirm
  the tenant display name + cloudId before writing to the keychain. This
  is the guard against setup-time URL typos (entering one tenant's URL when
  you meant another where you have the same email). See
  [02-multi-tenant.md](02-multi-tenant.md) for the full seal mechanism.

See `src/cli/setup.ts:27-194`.

## Error messages that touch credentials

All Confluence API errors are passed through `sanitizeError()` before being
surfaced to the MCP client. This replaces:

- `Basic <base64>` → `Basic [REDACTED]`
- `Bearer <token>` → `Bearer [REDACTED]`
- Raw `Authorization: …` headers → `Authorization: [REDACTED]`

Errors are additionally truncated to 500 characters to keep tool output
bounded. Raw API response bodies are still logged to stderr (server logs,
not tool output) for debugging — so if the MCP client exposes the server's
stderr stream, treat that stream as sensitive.

See `src/server/confluence-client.ts:451-497`.

## Where credentials *can* appear in plaintext

Deliberately enumerated so you can audit it:

- In-memory, inside the running Node process, for the lifetime of the
  process — unavoidable; the token is needed to sign HTTPS requests.
- In the OS keychain's encrypted backing store, under your user account's
  unlock authority.
- In stderr logs **if** `sanitizeError` fails to match a novel format — this
  has not been observed in practice but cannot be ruled out; treat server
  stderr as sensitive as a matter of hygiene.

Credentials are **never** written to:

- `.mcp.json` or any other config file (only the profile name goes there).
- The profile registry (`~/.config/epimethian-mcp/profiles.json`), which
  holds only names and non-secret flags.
- The mutation log (`~/.epimethian/logs/*.jsonl`), which stores body hashes
  and lengths, not credentials.
- The audit log (`~/.config/epimethian-mcp/audit.log`), which records
  profile add/remove events by name.

## Supply-chain posture (auto-update)

The server's upgrade path is check-and-notify by default: a daily
background check records a pending update, the stderr banner and
`get_version` tool surface the signal, and the user installs by running
`epimethian-mcp upgrade` from their terminal. The CLI runs
`npm audit signatures` before fetching and refuses to install without a
verified npm provenance attestation — closing both publisher-credential
compromise and registry-tampering attack paths.

Automatic patch installation is opt-in only:
`EPIMETHIAN_AUTO_UPGRADE=patches` restores the old auto-install
behaviour (for patch releases only, after the same provenance check) and
logs a loud warning on every startup. See
[06-limitations.md §14](06-limitations.md) for the full supply-chain
discussion, and the top-of-file design note in
`src/shared/update-check.ts` for the rationale.
