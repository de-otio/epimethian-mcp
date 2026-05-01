# 9. Audit-by-default

[← back to index](README.md)

## Problem

The mutation log (`src/server/mutation-log.ts`) is opt-in
(`EPIMETHIAN_MUTATION_LOG=true`). When a successful injection occurs,
recovery relies on Confluence's own version history, which does not
capture:

- the MCP client name / version,
- the specific `confirm_*` / `replace_body` flag values the caller set,
- the `source` provenance value (once
  [03-flag-provenance.md](03-flag-provenance.md) lands),
- the `injection-signals=…` the read phase detected,
- failed write attempts (e.g. a guard rejection) that indicate a
  probe-and-retry pattern.

This is also raised in the sibling investigation —
[`investigate-agent-loop-and-mass-damage/07-mutation-log-opt-in.md`](../investigate-agent-loop-and-mass-damage/07-mutation-log-opt-in.md).
This chapter adds the injection-specific rationale.

## Proposal: log by default

Flip the default. Reading unset (or any value other than `"false"`):
log. Only `EPIMETHIAN_MUTATION_LOG=false` disables.

Privacy cost:

- The log already stores only **lengths, SHA-256 hashes, and flag
  values** — not titles, not bodies. See
  [`doc/design/security/03-write-safety.md`](../../security/03-write-safety.md)
  §"Mutation log".
- Directory is mode `0700`, files are mode `0600` with `O_EXCL +
  O_NOFOLLOW`, entries older than 30 days auto-expire.
- Nothing that crosses a user's privacy expectation is written
  without their prior action.

Forensic value:

- Every successful injection leaves a record of which flags were
  set, which client produced the call, and (once we add it) which
  injection signals preceded the write.
- Default-on means "the one time you need it" is not "the one time
  you didn't enable it".

## Proposal: stderr warning on destructive flags

In addition to the file-backed log, emit a single line to stderr
when any of these fire:

- `replace_body=true` on any write.
- Any `confirm_*=true` that actually suppressed a guard (not flags
  that were set but didn't need to fire).
- `injection-signals=…` on a read response.
- A `CONTENT_FLOOR_BREACHED` rejection (the final backstop just
  tripped — highly unusual and worth surfacing).
- A `USER_DENIED_GATED_OPERATION` return
  ([07-human-in-the-loop.md](07-human-in-the-loop.md)) — the user
  just rejected an elicited call; worth recording the circumstances.

Format:

```
epimethian-mcp: [DESTRUCTIVE] tool=update_page page=42 flags=replace_body,confirm_shrinkage client=claude-code signals=named-tool,instruction-frame
```

Rationale:

- MCP stdout is reserved for protocol traffic; stderr is the
  convention for human-visible diagnostics.
- Users running Claude Code / Cursor may have stderr visible in the
  "MCP server logs" view. A single-line, grep-friendly format is
  the right shape for that surface.
- Stderr lines don't reach the agent (MCP clients don't forward
  them back), so this doesn't expand the injection surface.

## Proposal: Confluence-side marker on gated writes

When a write lands under any of the suspicious conditions above, the
`version.message` gets an additional machine-readable suffix:

```
Updated by Claude Code (via Epimethian v5.5.0) [destructive: replace_body, signals: named-tool]
```

Humans reviewing Confluence history directly see what flags were set,
even if they can't see the mutation log. No privacy cost — the flags
set on the call are already implied by the diff; making them explicit
just saves the reviewer from inferring.

## What this does not address

- A determined attacker who can reach the log directory can delete
  entries. `O_APPEND` + `O_EXCL` prevents in-place modification but
  not outright deletion. For tamper-evident audit, log forwarding to
  an external syslog / SIEM is out of scope (and would require the
  mutation log to add a network adapter).
- The log is local to the MCP server process. A hostile agent cannot
  read it (it doesn't have a filesystem tool pointed there) but a
  local-privileged attacker can.

## Costs

- Config flip: one line in `src/server/index.ts:2367-2370`.
- Stderr warning: ~20 LOC across `safe-write.ts`.
- Version-message suffix: extend the existing formatter in
  `_rawUpdatePage` / `_rawCreatePage`.
- Changelog entry explaining the default change. Users who opted
  **out** explicitly are unaffected (they already have
  `EPIMETHIAN_MUTATION_LOG=false`).
