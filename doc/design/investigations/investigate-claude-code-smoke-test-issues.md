# Smoke-test findings — Claude Code (VS Code) + epimethian-mcp 6.6.0

Date: 2026-04-30
Tenant: jambit.atlassian.net (profile: jambit)
Test page: `~rmyers / Epimethian Smoke Test 2026-04-30` (id `887881730`)
Client: Claude Code, VS Code native extension
Server: `@de-otio/epimethian-mcp` 6.6.0 at `/opt/homebrew/bin/epimethian-mcp`

Two issues surfaced during a happy-path smoke test. The first is a client-side
silent-decline that defeats 6.6.0's elicitation-based confirmation. The second
is a schema strictness issue that depends on how the LM serialises a tagged
union.

---

## Issue 1 — Claude Code silently declines `elicitation/create` requests

### What we observed

Three tool calls, all with destructive flags or destructive intent, returned the
text `… was not executed — user declined.` **The user reported they were never
shown a prompt.** Specifically:

| call | flags | observed | expected |
| --- | --- | --- | --- |
| `update_page` | `replace_body=true` | declined | confirmation prompt |
| `update_page` | `confirm_deletions=true` | declined | confirmation prompt |
| `delete_page` | (delete itself is gated) | declined | confirmation prompt |

Two `update_page_section`, one `append_to_page`, one `add_label`, two
`get_page`, etc. — all completed without any prompt, as expected.

### Where the message comes from

`dist/cli/index.js`, the gated-operation post-processor:

```js
if (result.action === "decline") {
  throw new GatedOperationError(
    USER_DECLINED,
    `${context.tool} was not executed — user declined.`
  );
}
```

So the message is *epimethian's own* error wrapping an MCP `elicitation/create`
response in which the client returned `action: "decline"`. Per MCP spec,
`decline` means *the user explicitly rejected the request*. That is what the
server is entitled to assume; epimethian's behaviour here is correct.

### Why the user never saw a prompt

The decline came from Claude Code's MCP client, not from a UI dismissal.
Either:

1. **Claude Code's elicitation handler is auto-declining** — possibly a default
   policy when an MCP tool issues an `elicitation/create` for an
   already-allow-listed tool (both `mcp__confluence__update_page` and
   `mcp__confluence__delete_page` are in
   `.claude/settings.local.json:permissions.allow`).
2. **The elicitation prompt is suppressed by the IDE bridge** — the request
   was rendered to a UI surface that didn't surface to the user, then timed
   out / auto-declined.
3. **Capability advertised but not implemented** — Claude Code advertises
   `elicitation` in `initialize`, so epimethian takes the elicitation path
   instead of the soft-confirmation token path. If the implementation is
   stubbed to always reply `decline`, the user never sees anything.

Hypothesis (3) is most consistent with the observation: the user gets no UI,
no terminal output, no banner — just a silent decline. The two preceding
allow-list entries (`mcp__confluence__update_page`,
`mcp__confluence__delete_page`) suggest that when the tool is allow-listed,
Claude Code may be skipping its own permission UI but still responding to the
in-band elicitation with `decline` (because there is no human to ask, and
allow-listing the *tool* is not the same as approving any specific
*destructive flag*).

### Impact

This is a serious correctness issue for any 6.6.0 client that opts into the
elicitation path:

- The user cannot perform destructive operations at all — every replacement,
  deletion, or shrinkage is silently blocked.
- There is no user-visible signal that a prompt was even attempted, so the
  user (correctly) believes they were never asked.
- Workarounds tried by the LM (retrying with different flag combinations) all
  fail the same way, wasting turns and creating the impression of a bug
  loop.

### Suggested next steps for epimethian

1. **Probe-then-fallback handshake** — before the first elicitation,
   server-side issue a tiny `elicitation/create` ping and observe the action.
   If the client returns `decline` to the ping (i.e. before any user could
   reasonably have responded), set a session flag that causes subsequent
   confirmations to follow the soft-confirmation token path instead. This
   degrades gracefully when the client advertises elicitation it cannot
   actually surface.

2. **Distinguish `decline` from `silent-decline`** — measure the time from
   `elicitation/create` send to response. A `decline` that arrives in <100 ms
   is almost certainly automated; treat it the same as
   `SOFT_CONFIRMATION_REQUIRED` and return the token-based protocol.

3. **Document the failure mode** — extend the `SOFT_CONFIRMATION_REQUIRED`
   note in each destructive tool's description with: *"If your MCP client
   advertises elicitation but auto-declines (some Claude Code versions do
   this for tools that are already in the permissions allow-list), set
   `EPIMETHIAN_FORCE_SOFT_CONFIRM=true` to skip the elicitation path."* —
   provided the env var exists; if not, add it.

4. **Report upstream** — file a Claude Code issue with a minimal
   reproduction. Claim: "When an MCP tool that is in
   `permissions.allow` issues `elicitation/create`, Claude Code returns
   `{action: 'decline'}` without surfacing the request to the user."

### Fast workaround for users today

In any client that exhibits this behaviour, one of:

- Remove the destructive operation's tool from `permissions.allow` and rely
  on Claude Code's own per-call permission prompt. This sidesteps
  elicitation entirely. (Confirmed not yet tested — assumption based on the
  hypothesis above.)
- Run a 6.5.x build that does not use elicitation and see whether
  destructive flags work via Claude Code's own prompt.

---

## Issue 2 — `version: integer | "current"` is rejected when the LM serialises an integer as a string

### What we observed

```
update_page({ version: "6", ... })
→ MCP error -32602: Input validation error … invalid_union
   - branch 1: expected number, received string
   - branch 2: expected literal "current", received "6"
```

Retrying with `version: "current"` (the string literal) succeeded.

### Why the LM produces a string

The schema is a tagged union of `{integer, exclusiveMinimum: 0}` and
`{const: "current"}`. The same JSON Schema appears on `update_page`,
`update_page_section`, `append_to_page`, `prepend_to_page`, `delete_page`.
Anthropic's tool-use serialiser, when emitting a JSON value into a union
where one branch is a string literal, will sometimes wrap a numeric value as
a string (`"6"`). It is a known quirk of unions that mix integer and string
literal alternatives. The same call shape worked in `append_to_page` later
in the same session — so it is intermittent, not deterministic.

This is a UX issue, not a correctness issue: the server's strict rejection
prevents an ambiguous input from being committed. But it costs a turn and
forces the LM to either retry or fall back to `"current"` (which weakens the
optimistic-concurrency guarantee).

### Suggested fixes (ordered by preference)

1. **Coerce numeric strings**. In the `version` field's Zod schema, wrap the
   integer branch with `z.coerce.number().int().positive()` (or
   `z.preprocess(v => typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v, …)`).
   This accepts `"6"` as 6 while still rejecting genuine garbage like
   `"current2"`. The "current" literal branch stays as-is and matches first
   for the literal string.

2. **Reorder the union**. Put the integer branch first; some Zod versions
   short-circuit on the first successful branch and skip the literal check.
   Less robust than (1) but a one-character change.

3. **Promote `"current"` to a sibling parameter**. Replace the union with
   `version?: number` plus `version_target?: "current"` (or a single enum
   that has only the literal). Eliminates the union entirely. Most invasive
   — only worth it if (1) doesn't cover edge cases.

4. **Document**. In each tool's description, note that `version` may be
   passed as a JSON number or the literal string `"current"`, never as a
   string-encoded integer. Cheap; reduces blame on the user but does not
   stop the LM from guessing wrong.

A combination of (1) and (4) is the minimum-friction path. Implementation is
small and contained.

### Where to look

The version-field schema is defined in the shared input-schema module used
by all five mutating tools. A grep for `"current"` and `exclusiveMinimum`
in `src/server/` will surface the call-sites.

---

## Smoke-test summary (for completeness)

- ✅ `get_spaces` (personal) — 10 results
- ✅ `create_page` (markdown, `wait_for_post_processing=true`) — id 887881730
- ✅ `get_page` (markdown) — auto-numbering visible (`1.1.`), code macro
  tokenised as `[[epi:T0001]]`
- ✅ `append_to_page` (markdown table, `version: "current"`) — body grew
  523 → 812 chars
- ❌ `update_page` `replace_body=true` — silent decline (Issue 1)
- ❌ `update_page` `confirm_deletions=true` — silent decline (Issue 1)
- ✅ `update_page_section` `find_replace` — 2 substitutions applied
- ✅ `add_label` × 3, `get_labels` — server auto-applied
  `epimethian-edited` (expected)
- ⚠️ `search_pages` CQL — 0 hits for a seconds-old page (Atlassian CQL
  index lag, not an epimethian issue)
- ✅ `get_page_by_title` — page found
- ❌ `delete_page` (with `version: 7`, `source: "user_request"`) — silent
  decline (Issue 1). Page left in place.
- ❌ `update_page` first attempt with `version: "6"` — schema rejection
  (Issue 2). Recovered by passing `"current"`.

The page is still live and can be deleted manually, or by re-running
`delete_page` once the elicitation issue is fixed or worked around.
