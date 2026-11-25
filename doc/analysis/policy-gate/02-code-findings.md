# 2. Code findings

State of `master` at 7.6.0. Line numbers are from that state.

## Read scope

- `read_spaces`, `read_spaces_enforced` and `redact_patterns` are resolved
  once at startup by `resolveReadScope` (`src/server/read-scope.ts:38`).
- The result is used in two tools only: `search_pages`
  (`src/server/index.ts:3604`) and `get_recent_changes`
  (`src/server/index.ts:5756`).
- `get_page` (`src/server/index.ts:1478`) calls `getContent(page_id, …)` and
  renders the result. It performs no space check.
- The setting's doc comment (`src/shared/profiles.ts:152`), the README and
  `doc/design/security/06-limitations.md` §17 state this limit openly: "To
  keep an agent out of a space, use a token with no access to it."
- `plans/field-session-findings-2026-10.md` lists "enforce
  `read_spaces_enforced` on reads that take a space key" as open follow-up
  work. The question whether the scope should also restrict `get_page` was
  raised in `doc/design/investigations/investigate-field-session-findings-2026-10.md`
  (question 4) and not decided in favour of a boundary.

## Write-side space allowlist

- `assertSpaceAllowed` (`src/server/space-allowlist.ts:195`) takes a space
  key, a content ID or a comment reference.
- A content ID is resolved to its type and space key by
  `resolveContentSpace`, with a 5-minute cache. Pages and blog posts are both
  covered; a comment is resolved through its container.
- An unresolvable space fails closed with `SpaceNotAllowedError`.
- The profile setting is `spaces`. Only write handlers call the check
  (`checkSpaceAllowed`, `src/server/index.ts:1131`).

## Read tools

The read surface is larger than `get_page`:

| Tool | Returns |
|---|---|
| `get_page`, `get_page_by_title` | Body (storage or markdown), metadata |
| `list_pages`, `get_page_children` | Titles and IDs |
| `search_pages` | Titles, excerpts, last editor |
| `get_recent_changes` | Titles, editor names, change summaries |
| `get_page_versions`, `get_page_version`, `diff_page_versions` | Historical bodies, diffs, editor names |
| `get_comments` | Comment bodies, author IDs |
| `get_attachments`, `download_attachment` | File names; file content written to disk |
| `get_labels`, `get_page_status` | Labels, status |
| `resolve_page_link` | Page identity from a URL |
| `lookup_user` | Account ID, display name, e-mail |
| `get_spaces` | Space list |

## User identities in output

- `search_pages` prints `Last editor: <name>` (`src/server/index.ts:3668`).
- The version list prints the display name, or the account ID when the name
  is unavailable (`src/server/index.ts:5450`).
- `get_recent_changes` collects editor display names
  (`src/server/recent-changes.ts:277`).
- Comments print `version.authorId` (`src/server/index.ts:939`).
- `lookup_user` returns account ID, display name and e-mail by design; the
  mention directive needs the account ID.
- Storage-format bodies carry `ri:account-id` attributes inside user
  mentions.
- `redact_patterns` is applied to search titles and excerpts and to
  recent-changes titles. It is never applied to bodies and is documented as
  hygiene, not a boundary (`src/server/search-redact.ts`).

## Logs and budgets

- `src/server/mutation-log.ts` appends one JSONL record per write: operation,
  content ID, versions, body lengths and SHA-256 hashes, client label, flag
  provenance. No titles, no content. Files are owner-only, symlink-checked,
  and swept after 30 days. There is no record type for reads.
- `src/server/write-budget.ts` holds a session counter and a 15-minute
  rolling counter for writes, configured through environment variables in
  the MCP config. There is no read counter.

## Human confirmation

- `gateOperation` (`src/server/elicitation.ts:527`) asks the human through
  MCP elicitation when the client supports it.
- For clients without elicitation, a soft-confirmation path exists
  (`SOFT_CONFIRMATION_REQUIRED`): the tool returns a token and the model
  passes it back after showing the change to the user.
- Fast-decline detection treats a client that answers elicitations
  implausibly quickly as not supporting them.

## Policy storage

- Profile settings live in `~/.config/epimethian-mcp/profiles.json`
  (`src/shared/profiles.ts:68`), mode 0600, read through a symlink-safe open.
- The file is owned by the OS user who runs the MCP client.
- Credentials are in the OS keychain, separate from the settings.

## Registry read failures

Read from the code; not yet reproduced with a running server.

- `readFullRegistry` (`src/shared/profiles.ts:177`) returns an empty registry
  when the file does not parse, has an unexpected top-level shape, has
  group- or world-writable permissions, or is a symlink. It prints a warning
  to stderr and continues.
- `getProfileSettings` (`src/shared/profiles.ts:265`) then returns
  `undefined`.
- The server does not check that the profile is registered. Its two callers
  (`src/server/index.ts:1124`, `src/server/confluence-client.ts:259`) treat
  `undefined` as "no settings".
- With no settings, `resolveSpaceFilter` reports the allowlist as inactive,
  `resolveReadScope` yields no scope, and the tool filter has no list. The
  restrictions a profile configured stop applying, and the only signal is a
  stderr line that an MCP client usually does not show.
- A missing file and an unreadable file are handled the same way. Only the
  first is a legitimate "no settings" state.
- `read_spaces`, `read_spaces_enforced` and `redact_patterns` are validated
  at runtime and fail closed when malformed. That protection applies to
  malformed values inside a readable registry, not to an unreadable one.

To verify before step A: start the server against a registry with a syntax
error and a profile that sets `spaces`, and check whether a write outside
the allowlist is refused. The effect on `posture` needs the same check.
