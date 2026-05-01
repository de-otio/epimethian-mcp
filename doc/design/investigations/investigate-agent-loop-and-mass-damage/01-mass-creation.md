# 1. Mass creation (`create_page`)

[← back to index](README.md)

`src/server/index.ts:396-464` — `create_page`:
- Resolves the space.
- Runs `safePrepareBody` then `safeSubmitPage`.
- `safeSubmitPage` performs a **duplicate-title-in-space** check
  (`src/server/safe-write.ts:917-930`): rejects if a page with the same
  title already exists in the target space.
- No per-session counter, no per-space counter, no post-create back-off,
  no confirmation of bulk intent.

## Attack / accident shape

```
for i in range(10_000):
    create_page(
      title=f"Project update {i}",
      space_key="DEV",
      body="# Heading\n\nLorem ipsum…",
    )
```

The duplicate-title check defends only against collisions. An agent that
varies the title by counter, date, or random suffix creates 10 000
distinct pages. Each individual call is:
- tenant-sealed (cloudId verified at startup),
- flagged as `destructiveHint: false, idempotentHint: false`,
- attributed to the calling user (their API token) and the MCP client
  label (e.g. "Claude Code"),
- logged (iff mutation log is enabled — see [finding 7](07-mutation-log-opt-in.md)).

None of those properties *stop the loop*. The only external throttle is
Atlassian's own rate limits on the v2 REST API, which will return
HTTP 429 at some point but do not roll back the pages already created.

## Precedent

- Confluence's own UI does not offer bulk-create. Programmatic mass
  creation is a well-known abuse pattern — see Atlassian support
  threads about third-party sync tools creating thousands of orphan
  pages.
- No other MCP server surveyed (`sooperset/mcp-atlassian`,
  Atlassian Rovo, `aashari/mcp-server-atlassian-confluence`) imposes a
  per-session write budget.

## Possible mitigations (not yet designed)

- **Session write budget**: track number of create/update/delete calls
  in-process; require an explicit opt-in env var
  (`EPIMETHIAN_WRITE_BUDGET=N`) to raise past a small default (e.g. 25).
  Reset on restart.
- **Burst detection**: reject if N writes in the last 60 s exceeds a
  threshold; surface a structured error telling the agent to pause.
- **Human-in-the-loop on burst**: emit a stderr warning + require a
  subsequent tool call to confirm intent (awkward without a
  bidirectional MCP UX).
- **Parent-required**: for `create_page`, consider requiring a
  `parent_id` in write-heavy profiles. A space top-level
  free-for-all is the most common spam pattern.

None of these are uncontroversial. The open question is whether the
default posture should be "trust the agent" (current) or
"cap-and-escalate".
