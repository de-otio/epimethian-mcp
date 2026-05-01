# Investigation: OpenCode Compatibility

**STATUS: 🟡 REVIEW** (analysis only; no code changes proposed for merge)

**Date:** 2026-04-29
**Scope:** every code path triggered when an MCP client that does not
support the `elicitation` capability connects to epimethian-mcp; the
setup CLI's per-client onboarding; tool descriptions and the agent
guide as they relate to clients without in-protocol confirmation.

## Why this investigation exists

OpenCode (the SST coding agent at <https://opencode.ai>) is a
first-class MCP host: it loads servers from `opencode.json`, talks the
2025-11-25 MCP wire protocol via the official TypeScript SDK, and
forwards tool calls to its agents. **It does not advertise the
`elicitation` capability** during the MCP `initialize` handshake — its
SDK `Client` is constructed with no `capabilities` object, so the
`clientInfo.capabilities.elicitation` field is absent. Source:
`@modelcontextprotocol/sdk` requires explicit opt-in for elicitation,
and OpenCode's `packages/opencode/src/mcp/index.ts` does not pass it.

The practical effect for an OpenCode user installing
`@de-otio/epimethian-mcp`:

- Read tools (`get_page`, `search_pages`, `get_page_versions`, etc.)
  work out of the box.
- Additive writes that don't fire the `confirm_*` gates — `create_page`
  on a new title, `prepend_to_page`, `append_to_page` without
  destructive flags, `add_label`, `add_attachment` — also work.
- Any tool call with `confirm_deletions: true`, `replace_body: true`,
  `confirm_shrinkage: true`, or that would otherwise trip
  `gateOperation()` fails with
  [`ELICITATION_REQUIRED_BUT_UNAVAILABLE`](../../../src/server/elicitation.ts).
- The user can set `EPIMETHIAN_ALLOW_UNGATED_WRITES=true` in their
  `opencode.json` `environment` block to bypass the gate, but this
  removes the human-in-the-loop confirmation entirely. The harness
  allow-list and every server-side guard (provenance, source policy,
  write-budget, byte-equivalence) still apply, but the user no longer
  sees a prompt before each destructive operation.

There is **no tracking issue** at <https://github.com/sst/opencode>
requesting elicitation support (verified 2026-04-29 via the GitHub
issues search API). OpenCode's SDK version (`1.27.1` at the time of
writing) does support elicitation; the application layer simply hasn't
wired it up.

The question this investigation answers: **what changes inside
epimethian-mcp would make the OpenCode experience smoother without
waiting for an upstream change?** Several of the proposals also benefit
other elicitation-less MCP clients (Cursor, Windsurf, Zed, custom
in-house hosts), so the framing is "any client without elicitation",
not "OpenCode specifically".

## Where the friction lives today

| Phase | Friction | What goes wrong |
|---|---|---|
| Install | Config shape is different (`mcp` vs `mcpServers`, `command` array vs string, `environment` vs `env`). | The user copy-pastes the standard `.mcp.json` snippet from the README, OpenCode silently ignores it, the user can't figure out why the server didn't load. |
| First write | First `confirm_deletions` call fails with `ELICITATION_REQUIRED_BUT_UNAVAILABLE`. | The error message points the user at "switch to Claude Code ≥ 2.x or Claude Desktop ≥ 0.10" — unhelpful for someone who specifically chose OpenCode. |
| Workaround | `EPIMETHIAN_ALLOW_UNGATED_WRITES=true` removes the gate entirely. | The user trades all interactive confirmation for a working workflow. The next data-loss incident has no in-protocol pause. |
| Ongoing | Each new write tool that uses `gateOperation` adds another tripwire. | A user who configured `_ALLOW_UNGATED_WRITES` to fix `confirm_deletions` is silently bypassing future gates they may not know about. |

The current answer ("set the flag, accept the trade-off") is *correct*
but not *smooth*. The investigation is whether epimethian can do
better without becoming OpenCode-specific in its protocol behaviour.

## Options surveyed

### A. Soft elicitation via tool-result error pattern

The principled fix. When `clientSupportsElicitation()` returns false,
instead of throwing `ELICITATION_REQUIRED_BUT_UNAVAILABLE`, return a
**structured tool result** that:

1. Has `isError: true`.
2. Includes a human-readable explanation: "this operation will remove
   N TOC macros and M link macros; please confirm with the user before
   re-calling".
3. Includes a deterministic re-call hint: a fresh `confirmation_token`
   the agent must pass in `confirm_token` on the retry. The token is
   stored in the server (in-memory, TTL ~5 min) and tied to the exact
   diff that was about to apply — replaying with a different body
   invalidates it.

The agent reads the tool result, asks the user (in OpenCode's chat
UI, or whatever the host provides), and re-calls with the token if
the user agrees. The user's answer is captured in the agent's normal
conversation flow, not in a dedicated MCP elicitation channel.

**Pros:**
- Works for **every** MCP client without elicitation, not just
  OpenCode (Cursor, Windsurf, custom hosts, and OpenCode all benefit).
- The user's confirmation is preserved — the gate is not silently
  bypassed.
- The token-binding prevents the agent from "agreeing to one diff and
  applying a different one" — the diff is hashed into the token.
- No protocol change to MCP; this is purely how epimethian shapes its
  tool-result errors.
- The existing `gateOperation` call sites in
  [src/server/index.ts](../../../src/server/index.ts) (lines 930–960,
  1117–1224, 1722, 1763, etc. — see `git grep gateOperation`) all
  funnel through the same elicitation.ts path, so a single change in
  [src/server/elicitation.ts](../../../src/server/elicitation.ts) at
  the unsupported-client branch (~line 125) is the only edit needed
  for the protocol shift. The token store is new code.

**Cons:**
- Requires the agent to actually ask the user. An agent that just
  retries with an ACK token without asking would defeat the purpose.
  (Same risk as today's `EPIMETHIAN_ALLOW_UNGATED_WRITES`, but at
  least the *first* call surfaces the message — the agent has to
  process it.) Mitigation: word the tool-result message in
  imperative language directed at the agent ("Stop and ask the user
  before retrying with this token").
- Token TTL semantics are subtle. Too short and the user has time to
  say no; too long and a stale token might apply against a
  concurrently-edited page. Suggest 5 min default + invalidate on any
  competing write to the same `pageId`.
- Slight increase in tool-call count for confirm-required operations
  (1 → 2 calls). For OpenCode users this is the cost of doing
  business; for elicitation-capable clients the existing fast path
  remains.

**Effort:** medium. ~150 LOC for the token store + the soft-mode
branch in `gateOperation`; ~30 LOC of new test cases; ~50 LOC of
agent-facing message text.

### B. Per-client behaviour from `clientInfo.name`

When `getClientLabel()` returns `"opencode"`, automatically enable a
specific behaviour set. Could be combined with (A) — only switch to
the soft-elicitation path when the client name matches, leaving
existing clients on the `EPIMETHIAN_ALLOW_UNGATED_WRITES` opt-out
path.

`getClientLabel` already exists at
[src/server/index.ts:100](../../../src/server/index.ts#L100). It pulls
`clientInfo.title || clientInfo.name`. OpenCode reports `"opencode"`
via the SDK's default `Client({ name: "opencode", version: ... })`
constructor.

**Pros:**
- Lets us roll out (A) gradually without risk to existing clients.
- Clear behaviour boundary: "opencode plus a hand-curated allow-list of
  other elicitation-less clients".

**Cons:**
- Hard-coding client names is brittle. Forks of OpenCode, custom
  rebrands, or new MCP hosts would not benefit.
- The right test isn't "is this OpenCode?" — it's "does this client
  advertise elicitation?". `clientSupportsElicitation()` already
  answers that. (B) duplicates the test.
- Maintenance overhead: a list of "blessed" client names that needs
  updating each time a new MCP host appears.

**Effort:** trivial (one if-statement) — but the wrong question. (A)
generalises (B) and is preferable. The `clientLabel` value should
remain purely observational (logging, mutation log) — not a behaviour
switch.

### C. Setup CLI: per-client onboarding

`epimethian-mcp setup` ([src/cli/setup.ts](../../../src/cli/setup.ts))
currently asks for profile name + URL + email + token. Add a
**`--client`** flag (or interactive prompt) that, after credential
setup, prints a ready-to-paste config snippet matching the user's MCP
host, with the right keys filled in.

```
epimethian-mcp setup --profile globex --client opencode
```

Output (after successful credential save):

```
✅ Credentials saved for profile "globex".

Add this to your opencode.json (project root or
~/.config/opencode/opencode.json):

{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "confluence-globex": {
      "type": "local",
      "command": ["/usr/local/bin/epimethian-mcp"],
      "enabled": true,
      "environment": {
        "CONFLUENCE_PROFILE": "globex",
        "EPIMETHIAN_ALLOW_UNGATED_WRITES": "true"
      }
    }
  }
}

⚠️  EPIMETHIAN_ALLOW_UNGATED_WRITES=true is set because OpenCode does
    not yet support MCP elicitation. Destructive write operations will
    not prompt for confirmation. Remove this env var if your version
    of OpenCode adds elicitation support, or if you only use read
    tools and additive writes.
```

Equivalent shapes for `--client claude-code`, `--client claude-desktop`,
`--client cursor`, etc. Default (no `--client`) prints all known
shapes side-by-side, matching the current install-agent.md.

**Pros:**
- Pure UX win, completely additive, no protocol change.
- The warning text frames the trade-off correctly at install time —
  the user is making an informed choice rather than discovering the
  flag in a stack trace later.
- Discoverable: `epimethian-mcp setup --help` lists the supported
  clients, naturally surfacing OpenCode as a known target.
- Easy to keep current — adding a new MCP host is a switch case.

**Cons:**
- The CLI knows nothing at runtime about whether the user actually
  configured the env var. If they paste the snippet but strip
  `EPIMETHIAN_ALLOW_UNGATED_WRITES`, they're back to the failure mode
  (A) addresses.
- The `command` absolute path is hard to predict at setup time — the
  CLI would have to call `which epimethian-mcp` itself or shell out
  to `process.argv[1]`. Tractable.

**Effort:** small. ~80 LOC of templating + table of host configs. Tests
are trivial (snapshot the output for each client).

### D. Upstream contribution to OpenCode

The cleanest fix is upstream: register an `elicitation` handler in the
OpenCode `Client` constructor and surface the prompt in the OpenCode
TUI (or whatever interaction surface OpenCode uses for confirmations).

The change in OpenCode is small — pass
`{ capabilities: { elicitation: { form: {} } } }` to the `Client`
constructor and implement an `onElicitation` handler that pipes the
prompt to the user. SDK reference:
<https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/client.md>.

**Pros:**
- Solves the problem at the source for every MCP server, not just
  epimethian.
- No epimethian-side maintenance burden.

**Cons:**
- Outside our control. Requires upstream review, merge, release; the
  user's OpenCode installation also has to be updated.
- Even with this fix, our own code paths still need to gracefully
  handle clients that don't advertise the capability — there will
  always be older OpenCode versions and other elicitation-less hosts.

**Effort:** zero on our side; medium for the upstream PR. Worth
filing the issue (and the PR if appetite exists) regardless of which
local path we choose.

### E. Auto-fall-through when capability is absent

Default `EPIMETHIAN_ALLOW_UNGATED_WRITES=true` whenever
`clientSupportsElicitation()` returns false.

**Strongly not recommended.** This silently removes the protection
the gate exists to provide, for every elicitation-less client, with no
opt-in by the user. It would also silently downgrade safety for users
who installed expecting the gate to fire. The current behaviour
(error → user explicitly sets the flag) is the right default; the
explicit step is the user's "I understand the trade-off" moment.

This option is listed only to be explicitly rejected.

### F. Front-load gate awareness in tool descriptions

Add a sentence to every gated tool's description: *"This tool can
remove preserved macros from the page. If your MCP client does not
support in-protocol confirmation, your agent must ask the user
before calling this tool with `confirm_deletions: true`."*

**Pros:**
- Zero protocol or runtime change.
- The agent sees the description even on first contact (no failure
  needed).
- Useful generally (not OpenCode-specific) — clarifies the
  responsibility model.

**Cons:**
- Relies on the agent reading and respecting the description text,
  which is unreliable (especially on smaller models). The current
  hard error is more reliable.
- Easy to skip in a long tool description; doesn't address the
  fundamental "agent says yes but didn't ask the user" risk.

**Effort:** trivial. Worth doing as a complement to (A), not a
substitute.

## Recommendation

**Ship in this order:**

1. **(C) Setup CLI per-client onboarding** — small, additive, ~1 day
   of work. Immediately lowers install friction for OpenCode users
   and for everyone else. Frame the
   `EPIMETHIAN_ALLOW_UNGATED_WRITES` default as a known, explicit
   trade-off in the CLI output.
2. **(F) Tool-description awareness** — bundle with (C); it's a
   ~30-line edit to the existing destructive-write tool descriptions.
3. **(A) Soft elicitation via tool-result errors** — the principled
   fix. ~1–2 weeks of work including the token store, TTL semantics,
   and the per-pageId invalidation. After this lands, OpenCode users
   get the same human-in-the-loop guarantee as Claude Code users —
   the prompt just goes through the agent instead of through the
   MCP elicitation channel.
4. **(D) Upstream PR to OpenCode** — file the issue early
   (after (C)), regardless of whether we ship the PR ourselves. Even
   if upstream lands elicitation support, (A) is still the right
   long-term posture for any future elicitation-less host.

**Explicitly do not ship:**

- **(B) per-client name dispatch** — the right test is the capability,
  not the name. `clientSupportsElicitation()` is already that test.
- **(E) auto-fall-through** — silently removes safety; users can opt
  in, but the default must be fail-closed.

## Concrete first-step changes (for the (C) + (F) pass)

| File | Change |
|---|---|
| [src/cli/setup.ts](../../../src/cli/setup.ts) at `runSetup` (line ~60) | Accept a `--client` flag; after credential save, dispatch to a `printConfigSnippet(client, profile, binPath)` helper. |
| New: src/cli/client-configs.ts | Table of known MCP hosts and their config templates. Entries: `claude-code`, `claude-desktop`, `claude-code-vscode`, `cursor`, `windsurf`, `zed`, `opencode`. Each entry: config-file path hint, JSON template with `{{PROFILE}}` and `{{BIN}}` placeholders, list of recommended env vars and a one-line warning if any are safety-relevant. |
| [src/cli/setup.test.ts](../../../src/cli/setup.test.ts) | One test per client config: snapshot the rendered output. |
| [install-agent.md](../../../install-agent.md) Step 4 | Reference `epimethian-mcp setup --client <name>` as the canonical way to get a config snippet, instead of hand-typing the JSON. |
| [src/server/index.ts](../../../src/server/index.ts) tool-description string for `update_page`, `update_page_section`, `update_page_sections`, `delete_page`, `revert_page` | Append: *"Agents using MCP clients without elicitation support must ask the user before invoking this tool with destructive flags."* |

## Concrete first-step changes (for the (A) soft-elicitation pass)

| File | Change |
|---|---|
| New: src/server/confirmation-tokens.ts | In-memory token store. Key: `{tool, pageId, diffHash}` → `{token, expiresAt}`. Default TTL 5 min. Invalidate on any write to `pageId` from any tool. |
| [src/server/elicitation.ts](../../../src/server/elicitation.ts) at `gateOperation` lines 122–140 | New branch: when `!supported && !EPIMETHIAN_ALLOW_UNGATED_WRITES`, instead of throwing `ELICITATION_REQUIRED_BUT_UNAVAILABLE`, mint a token and throw a new `SOFT_CONFIRMATION_REQUIRED` error whose message names the token and the human-language deletion summary. The handler in `index.ts` catches this and returns it as `isError: true` with structured guidance. |
| Tool input schemas at gated call sites in [src/server/index.ts](../../../src/server/index.ts) | Add an optional `confirm_token: z.string().optional()` parameter on each gated write tool. When present, validate against the token store; if valid, skip the gate. |
| New tests | Round-trip: first call returns `SOFT_CONFIRMATION_REQUIRED` + token; second call with token succeeds. Token reuse across pages fails. Token after another write to same page fails. Token after TTL expires fails. |

## Out of scope

- **Modifying the MCP protocol.** Soft elicitation is implemented
  inside our tool-result shape, not as a protocol extension.
- **Building UI for OpenCode.** The agent's chat surface is what shows
  the user the confirmation prompt; we just shape the tool result.
- **Elicitation-via-comment trick.** Some servers post a Confluence
  comment asking "approve?" and poll for a reply. Not appropriate
  here — too slow, leaves audit-trail noise, and unclear what
  permission scope writes the comment.
- **Auto-detecting OpenCode's version** to gate features. We don't
  know enough about OpenCode's release cadence to make per-version
  decisions; capability-based detection (already present) is more
  durable.
- **Replacing `EPIMETHIAN_ALLOW_UNGATED_WRITES`.** It remains as the
  power-user escape hatch for headless / batch / CI environments
  where no agent is available to mediate. Soft elicitation is the
  default; the env var is the explicit override.

## Open questions

1. **Token TTL: 5 min the right default?** Long enough that a user
   has time to type "yes please proceed" in OpenCode's chat;
   short enough that a multi-step plan with stale state can't
   accidentally apply. Need to validate with a few real workflows.
2. **What happens if the agent passes the token after a competing
   write?** Strict invalidation (token is dead) is the safe default.
   Surfacing this as a distinct error (`CONFIRMATION_TOKEN_STALE`)
   lets the agent re-fetch + re-confirm without losing context.
3. **Should the token cover the diff specifically, or just the
   `{tool, pageId}` pair?** Diff-scoped is safer (prevents "user
   says yes, agent applies different content") but requires the
   server to compute a stable diff hash before the gate fires.
   `safePrepareBody`'s output already gives us the canonicalised
   storage XML; hashing that is cheap.
4. **Does the agent guide need a new section for the soft path?**
   Yes — `install-agent.md` should explain to the agent: "if you see
   `SOFT_CONFIRMATION_REQUIRED`, stop, ask the user, then re-call
   with the `confirm_token` from the error". Same structure as the
   existing "Write budget" section.
5. **Multi-section atomic update**
   ([`update_page_sections`](../../../src/server/index.ts)) — soft
   confirmation on aggregate is straightforward, but the token must
   bind to the *full set* of sections, not any single one. Worth
   confirming the implementation handles list-ordering deterministic.

## Related work

- [doc/destructive-flag-prompts.md](../../destructive-flag-prompts.md)
  — current gate behaviour and source-policy rules.
- [install-agent.md "MCP client compatibility"](../../../install-agent.md#mcp-client-compatibility)
  — current per-client guidance, including the table of supported
  hosts.
- v6.4.1 changelog entry (`EPIMETHIAN_BYPASS_ELICITATION`) — sister
  feature for the *opposite* failure mode (clients that fake
  elicitation support).
