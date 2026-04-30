# Investigation — Claude Code does not surface `structuredContent.confirm_token` to the agent

Date: 2026-04-30
Reporter: smoke test of v6.6.1 against Claude Code VS Code extension
Status: open — affects every MCP client that does not pass `structuredContent`
back to the agent on `isError: true` tool results
Predecessor: [investigate-claude-code-smoke-test-issues.md](investigate-claude-code-smoke-test-issues.md)
(2026-04-30 — original v6.6.0 silent-decline finding, fixed in v6.6.1)
Tenant: jambit.atlassian.net
Test page: id `887881730`, last seen at version 8

---

## TL;DR

v6.6.1 successfully detects Claude Code's fake-elicitation (50 ms
fast-decline → soft-confirm path), correctly mints a 5-field-bound
confirmation token, and returns the canonical
`SOFT_CONFIRMATION_REQUIRED` tool result with the full token in
`structuredContent.confirm_token`. **But the agent never sees the
full token.** Claude Code surfaces only the `content[0].text` block,
which contains just the last 8 characters of the token (the "tail" —
for human inspection only).

**Root cause:** epimethian's mutating tools never declared an
`outputSchema`. Per the MCP spec
(`@modelcontextprotocol/sdk` types), clients are obliged to forward
`structuredContent` to the agent only when the tool defines an
`outputSchema` whose schema the structured payload conforms to.
Without one, `structuredContent` is informational metadata that the
client MAY drop. Claude Code dropping it is spec-compliant.

This means the **second half of the v6.6.0 soft-elicitation
round-trip** — the agent re-invoking the tool with the
`confirm_token` parameter — is unreachable in clients that exercise
the spec-permitted liberty of ignoring `structuredContent`.

The first half works perfectly. The fast-decline detector fires, the
token is minted, the audit log records it, the page is protected.
But the operation cannot be completed.

**Fix (recommended for v6.6.2):** declare an `outputSchema` on each
mutating tool with a discriminated union covering both the success
and `confirmation_required` shapes. This makes `structuredContent`
canonical and clients MUST forward it. No security trade-off — the
token still lives only in `structuredContent`. See §5.0 / §6.

---

## 1. What we observed

### 1.1 Smoke-test inputs

After installing v6.6.1 (`npm install -g @de-otio/epimethian-mcp@6.6.1`,
verified bundle has 17 hits on the new symbols
`FAST_DECLINE | TREAT_ELICITATION_AS_UNSUPPORTED |
effectiveSupportsElicitation | versionField`) and reloading the VS
Code window, three failure cases from the v6.6.0 smoke test were
re-run:

1. `append_to_page` with `version: "7"` (string) — non-destructive,
   exercises Issue 2 / `versionField` coercion. **Pass.** Page
   advanced 7 → 8.
2. `update_page` with `replace_body=true` at `version: 8` —
   destructive, exercises Issue 1 / fast-decline detection. **Pass
   server-side**, returns `SOFT_CONFIRMATION_REQUIRED`.
3. `delete_page` at `version: 8` — destructive, gated by default.
   **Pass server-side**, returns `SOFT_CONFIRMATION_REQUIRED`.

### 1.2 Tool result actually received by the agent

For the destructive calls, the tool-result `content[0].text` block I
saw was:

```
⚠️  Confirmation required (SOFT_CONFIRMATION_REQUIRED)

Update page 887881730 with destructive flags?

Your MCP client does not support in-protocol elicitation. This
confirmation is being routed through you (the agent). Please ASK
THE USER before retrying. If the user approves, re-call this tool
with the same parameters plus the `confirm_token` from
structuredContent.

Token tail: ...Gu0Emjmx    Expires: 2026-04-30T04:49:48.091Z    Audit ID: 723430e8-edfa-4e32-a1a5-03a9e73cbcfb

The token is single-use, bound to this exact diff and page version,
and invalidated by any competing write to this page. If validation
fails, mint a new one by re-calling without `confirm_token`.
```

The text deliberately contains *only the last 8 chars of the token*
(`Gu0Emjmx`). The full token is documented to live in
`structuredContent.confirm_token`.

### 1.3 What the server actually emitted

`dist/cli/index.js` line 47881 (`formatSoftConfirmationResult`):

```js
return {
  content: [{ type: "text", text: text2 }],
  isError: true,
  structuredContent: {
    confirm_token: err.token,                 // FULL token here
    audit_id: err.auditId,
    expires_at: isoExpires,
    page_id: params.pageId,
    // optional: deletion_summary
  }
};
```

So the server is doing exactly what the §3.3 / §3.5 design
specified: **the full token is in `structuredContent`, never in
free-text**. This was a deliberate security choice in v6.6.0 —
keeping the token out of agent scratchpad / chat history / model
traces / multi-tenant audit logs avoids:

- Token replay if scratchpad ends up in another tenant's session.
- Token leaking into conversation transcripts that may be exported
  or fed back to other LMs.
- Prompt-injection vectors where a malicious page body could
  observe and exfiltrate a token visible in the agent's text
  context.

### 1.4 What Claude Code passed to the agent

Only the `content[0].text` block. `structuredContent` was not
visible to the agent in any form I could find — not in the tool
result, not in a separate tool message, not as a metadata field.

This is consistent with how Claude Code surfaces normal tool results
in my experience: the agent sees `content` blocks; `structuredContent`
is either dropped or rendered into a UI surface that the LM does not
see. Whether this is intentional, a bug, or an unimplemented spec
detail in the VS Code extension is unclear without source access.

---

## 2. Why this breaks v6.6.x soft-elicitation in Claude Code

### 2.1 The intended round-trip

```
agent calls update_page(replace_body=true)
              ↓
server: row 6 elicitInput → fast-decline (5 ms) → flag client as faking
              ↓
server: row 4 mintToken → SOFT_CONFIRMATION_REQUIRED
              ↓
client returns { content: [...], isError: true, structuredContent: { confirm_token: "..." } }
              ↓
agent reads structuredContent.confirm_token   ←  BREAKS HERE in Claude Code
agent asks user: "destructive write, OK?"
user says yes
              ↓
agent calls update_page(replace_body=true, confirm_token="...")
              ↓
server: validateToken → ok → safeSubmitPage → success
```

The arrow at "agent reads structuredContent.confirm_token" is the
load-bearing assumption. In Claude Code today that arrow is broken.

### 2.2 What the agent sees instead

I (the agent) see:

- A clear human-readable description of what happened.
- The audit ID (useful for log correlation).
- The expiry timestamp.
- The **last 8 characters of the token** — not the full token.

The "Token tail" is a deliberate nudge for human inspection: a user
glancing at the agent transcript can see *some* token-like value to
correlate with audit logs. It is **not** sufficient to retry the
call: `validateToken` requires the full byte sequence.

### 2.3 Net effect on the user

- v6.6.0 in Claude Code: silent decline, no UI, write blocked. Status
  quo. (Fixed in v6.6.1's fast-decline detection — sort of.)
- v6.6.1 in Claude Code: fast-decline detected, soft-confirm token
  minted, audit log records the mint, agent says "I need to ask you
  to approve, but I can't actually retry because I don't have the
  full token." Write still blocked.

The user-visible behaviour is *less hostile* (clear message, audit
trail, no false "user declined" claim) but the workflow outcome is
the same: destructive operations cannot complete. The token is a
phantom — it exists, it's bound, it would validate, but no caller
can present it.

The only working escape hatch for Claude Code today remains
`EPIMETHIAN_BYPASS_ELICITATION=true` — which removes the gate
entirely.

---

## 3. Where the gap is, exactly

### 3.1 MCP spec position — **the actual cause**

After reading the MCP SDK source and the OpenCode / Vercel AI SDK
docs, the picture clarified considerably. The gap is a spec-level
issue, not a Claude Code bug.

The MCP `tools/call` response shape:

```ts
type CallToolResult = {
  content: Content[];           // MUST — array of content blocks (when no outputSchema)
  isError?: boolean;            // OPTIONAL — defaults false
  structuredContent?: object;   // structured payload (canonical when outputSchema is declared)
};
```

The spec text in the MCP SDK
(`@modelcontextprotocol/sdk` types module, comments visible in the
installed bundle):

> If the Tool defines an `outputSchema`, this field [`structuredContent`]
> MUST be present in the result, and contain a JSON object that
> matches the schema.
>
> If the Tool does not define an `outputSchema`, this field
> [`content`] MUST be present in the result. For backwards
> compatibility, this field is always present, but it may be empty.

Translation: **clients are obliged to forward `structuredContent` to
the agent only when the tool declares an `outputSchema`.** Without
an `outputSchema`, `structuredContent` is informational metadata
that clients MAY ignore. Render-only behaviour is *spec-compliant*
in that case.

**Epimethian's mutating tools (`update_page`, `update_page_section`,
`append_to_page`, `prepend_to_page`, `delete_page`) do not declare
an `outputSchema`.** Verified: `grep -n outputSchema src/server/index.ts`
returns zero hits; the 17 hits in the compiled bundle are all from
the MCP SDK itself.

So the `structuredContent.confirm_token` field epimethian emits is,
from a spec-compliance standpoint, optional metadata that the client
is free to drop. Claude Code's behaviour of dropping it is not a
bug — it is a spec-permitted choice.

### 3.2 Per-client behaviour (verified via docs/source)

| Client | docs on `structuredContent` | actual behaviour | source |
| --- | --- | --- | --- |
| **Claude Code (CLI / VS Code)** | silent on the topic | version-dependent quirks: in some recent versions `structuredContent` is *prioritised over* `content` and content is silently dropped (issues #15412, #9962); on `isError: true` results, content blocks after the first are dropped (issue #39976); without an `outputSchema` declaration, render behaviour observed in our smoke test was content-only | [docs](https://code.claude.com/docs/en/mcp), [#15412](https://github.com/anthropics/claude-code/issues/15412), [#9962](https://github.com/anthropics/claude-code/issues/9962), [#39976](https://github.com/anthropics/claude-code/issues/39976) |
| **OpenCode** | silent on the topic | passes `CallToolResult` straight to Vercel AI SDK (`convertMcpTool` in DeepWiki); behaviour inherited from AI SDK: without `outputSchema` the raw result is forwarded JSON-stringified, with `outputSchema` `structuredContent` becomes canonical | [opencode.ai docs](https://opencode.ai/docs/mcp-servers/), [DeepWiki sst/opencode 5.6](https://deepwiki.com/sst/opencode/5.6-model-context-protocol), GitHub code search returns 0 hits for `structuredContent` |
| **Vercel AI SDK (downstream from OpenCode + others)** | documented | with `outputSchema`: `structuredContent` is the tool output. Without `outputSchema`: raw `CallToolResult` flows through, JSON-stringified into the chat | [AI SDK MCP tools](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools), [dynamicTool ref](https://ai-sdk.dev/docs/reference/ai-sdk-core/dynamic-tool) |
| **Claude Desktop** | unverified | unverified | — |
| **Cursor / Windsurf / Zed** | unverified | unverified | — |

The unifying principle: **declaring `outputSchema` makes
`structuredContent` canonical and clients MUST forward it.** Without
it, behaviour is undefined per spec, and most clients default to
content-only.

The Claude Code GitHub issues are interesting in their own right —
they suggest that even when `structuredContent` *is* surfaced,
Claude Code does it in a destructive way (drops `content`), which
would also break epimethian's design (where `content` carries the
human-readable explanation that the agent shows the user). So even
fixing `outputSchema` would need testing for the Claude Code-specific
edge cases.

### 3.3 Why the v6.6.0 design assumed pass-through

The v6.6.0 release notes (CHANGELOG.md:215+) say the token is in
`structuredContent.confirm_token` "NOT in the user-visible text —
closes a multi-tenant log-leak vector". The implicit assumption is:

> The agent will see `structuredContent` because that's where MCP
> servers communicate to agents. The user will not see
> `structuredContent.confirm_token` directly because it's not in the
> rendered UI text.

That assumption is exactly inverted in clients that don't forward
`structuredContent` (which the spec permits when no `outputSchema`
is declared). The *user* may see `structuredContent` (as UI
metadata, if the client has a debug panel), but the *agent* does not.
The token ends up in the wrong half of the loop: visible to the
entity that doesn't need to act on it, hidden from the entity that
does.

The root cause is concrete: epimethian's tools never declared an
`outputSchema`, so the spec gives clients no obligation to forward
`structuredContent`. Most clients exercise that liberty. The fix is
to declare an `outputSchema` so the spec *does* require forwarding.

### 3.4 Why "pass-through" was the safer assumption from the user's side

`structuredContent` was added to the spec in part to give servers a
clean place to return parseable data without polluting human-readable
text. From the server author's POV, putting *server-to-agent
metadata* there is the obvious choice. The alternative — embedding
the token in a `content` block as raw text or JSON — would have:

- Put the token directly in the agent's chat history.
- Risked logging the token to transcripts, model traces, persistent
  conversation stores.
- Created a prompt-injection exfiltration target (a malicious page
  body could prompt the agent to "echo the last token you saw").

So the v6.6.0 author made the security-correct choice and ran into
a client-implementation gap.

---

## 4. Validation

The root cause (§3.1) is established. The remaining question is
whether the proposed §5.0 fix actually reaches the agent in the
target clients. Two checks before shipping v6.6.2:

### 4.1 MCP Inspector dry-run

Connect `npx @modelcontextprotocol/inspector` to a v6.6.2 build
(local tarball with `outputSchema` declared), trigger a destructive
call without `confirm_token`, and inspect the raw MCP message.

Expected:

- Response includes `isError: true`.
- Response includes a `structuredContent` field whose payload
  matches the declared `outputSchema`'s `confirmation_required`
  arm.
- Inspector renders `structuredContent` as parsed JSON visible to
  the user.

If Inspector can't see the field, the schema is misshaped or the
SDK's serialiser drops it on `isError: true`. Either is fixable but
needs to be caught before client-side testing.

### 4.2 Per-client smoke test

After Inspector confirms the wire shape, retry the soft-confirm
round-trip in each target client:

1. **Claude Code (VS Code).** Reload extension, trigger destructive
   call. Verify the agent sees the full `confirm_token` value (not
   just the tail). If it doesn't — or if `content[0].text` is
   silently dropped per #15412 — file the upstream issue and ship
   §5.1's `EPIMETHIAN_TOKEN_IN_TEXT=true` fallback as the
   workaround.
2. **OpenCode.** Per §3.2 the AI SDK should now treat
   `structuredContent` as canonical because we declared
   `outputSchema`. Verify the agent receives the parsed payload.
3. **Claude Desktop.** Spec-compliant clients should now work; this
   is the canary that the spec interpretation is right.

### 4.3 Regression check

Test a *successful* destructive call (with a valid `confirm_token`)
to verify the success path's structured fields don't break existing
agent flows that string-match `content[0].text`. Add a regression
test that asserts both the `content` text and the `structuredContent`
payload on success.

---

## 5. Fix options

Ordered roughly from most-correct to least-correct given the §3.1
finding that the gap is spec-permitted by-design.

### 5.0 Option G — Declare `outputSchema` on the affected tools (recommended)

The MCP spec only obliges clients to forward `structuredContent`
when the tool declares an `outputSchema` whose schema the structured
payload conforms to. Currently epimethian's mutating tools declare
no `outputSchema`, so clients are spec-compliant in dropping
`structuredContent`. Declare one and the obligation flips on.

Concretely, on each of `update_page`, `update_page_section`,
`append_to_page`, `prepend_to_page`, `delete_page` add an
`outputSchema` that admits both shapes the tool can return:

```ts
const writeOutputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("written"),
    page_id: z.string(),
    new_version: z.number().int().positive(),
    diff_bytes: z.number().int().nonnegative(),
    // ... any other fields existing success responses contain
  }),
  z.object({
    kind: z.literal("confirmation_required"),
    confirm_token: z.string(),
    audit_id: z.string(),
    expires_at: z.string(),  // ISO 8601
    page_id: z.string(),
    deletion_summary: z.object({...}).optional(),
  }),
]);
```

Then update `formatSoftConfirmationResult` to emit
`structuredContent` matching the `confirmation_required` arm, and
update the success path to emit the `written` arm.

**Pros**

- Aligns with the MCP spec — clients now MUST forward
  `structuredContent` to the agent.
- No security trade-off: the token still lives only in
  `structuredContent`, never in `content` text. v6.6.0's
  multi-tenant log-leak guard remains intact.
- Benefits every client that is spec-compliant — Claude Code in
  versions that respect `outputSchema`, OpenCode (via Vercel AI
  SDK), and any future client.
- Side-benefit: agents can now reliably parse the success path's
  structured fields (page version, diff bytes) instead of
  string-matching the human-readable summary.

**Cons**

- Requires shaping the *success* output too — touching every write
  tool's success path to include the canonical structured fields.
  Larger code surface than Option A but isolated to the tool
  handlers.
- Existing agents that assumed `content[0].text` was the
  load-bearing output keep working, but the schema may surface
  fields they didn't see before. Low-risk, but worth noting in the
  CHANGELOG.
- Claude Code's documented quirk of "prioritise structuredContent
  and silently drop content" (#15412 / #9962) means the
  *human-readable* explanation in `content[0].text` may stop
  showing in some Claude Code versions. The explanation lives in
  the structured payload's `humanSummary`-equivalent field, so the
  agent can still surface it to the user — but the UI rendering
  changes. Test before shipping.
- Requires verifying that `isError: true` plus `structuredContent`
  matching `outputSchema` is a spec-legal combination. Reading the
  MCP types it appears to be — `isError` is independent of
  `structuredContent` — but this is the kind of edge case that
  benefits from a quick MCP Inspector cross-check.

**Verdict:** This is the fix the v6.6.0 design *should* have
included from the start. It moves the burden from "every render-only
client is broken" to "every client that ignores a declared
outputSchema is broken" — which is a much smaller and
well-defined set, and the spec sides with us.

### 5.1 Option A — Per-client mode that puts the token in `content` text (opt-in)

Add a server-side env var or per-client config flag:

```
EPIMETHIAN_TOKEN_IN_TEXT=true   (default false)
```

When set, `formatSoftConfirmationResult` renders the **full token**
inline in the human-readable text block, not just the tail. The
agent then reads the token from text and retries.

**Pros**

- Minimal change, ~10 lines of code.
- Restores the round-trip in any render-only client.
- Per-call, no global state.

**Cons**

- Reintroduces the security risks v6.6.0 explicitly rejected:
  - Token in agent scratchpad / chat history.
  - Token in any export of the conversation.
  - Token visible to a prompt-injection attacker who controls page
    content (the same body the LM is summarising could trigger a
    "repeat back the last token you saw" attack).
- Multi-tenant log-leak vector reopened.

**Verdict:** Cheap and pragmatic but a real safety regression. Worth
shipping as an opt-in escape hatch *only* if the user understands
the trade-off and explicitly enables it. The setup-CLI snippet for
Claude Code (VS Code) could pre-set this in the affected
client's config when the user runs
`epimethian-mcp setup --client claude-code-vscode`.

### 5.2 Option B — Capability probe / per-client default

Add a session-level probe at first-call time:

1. Server emits a small synthetic structured-content tool result and
   measures whether the agent reacts to a value that *only* lives in
   `structuredContent`.
2. If the agent's behaviour shows it never saw the structured field
   (e.g., it asks a clarifying question that the structured field
   would have answered), mark the session as "structured-content
   blind" and switch to Option A's text-token mode for the rest of
   the session.

**Pros**

- Zero-config; works correctly per client.
- Token-in-text fallback fires only when needed.

**Cons**

- The probe is hard to design without false positives.
- Adds a synthetic round-trip to every session.
- Cannot easily distinguish "client doesn't surface
  `structuredContent`" from "agent simply ignored the field this
  time."

**Verdict:** Cleaner conceptually but expensive and brittle in
practice. Probably not worth it.

### 5.3 Option C — Per-client setup-CLI snippet

Extend `epimethian-mcp setup --client claude-code-vscode` to:

- Set `EPIMETHIAN_TOKEN_IN_TEXT=true` automatically.
- Render a warning paragraph in the snippet output that explains the
  trade-off (token visible in agent transcript) and suggests the
  user disable it once Claude Code surfaces `structuredContent`.

**Pros**

- Affected users get working soft-confirm out of the box.
- Trade-off documented at the point of configuration.
- Easy to evolve: when Claude Code fixes structured-content
  surfacing, drop the env var from the template.

**Cons**

- Same security trade-off as Option A; setup-CLI just makes it
  default for the affected client.
- Other render-only clients we haven't yet identified will still
  hit the original gap until their snippets are updated.

**Verdict:** Pairs well with Option A. The env var is the mechanism;
the setup-CLI is the per-client default. This is the cheapest
end-to-end fix that restores Claude Code parity.

### 5.4 Option D — Move the token to a *separate* content block

Instead of returning `{ content: [text], structuredContent: {...} }`,
return:

```js
{
  content: [
    { type: "text", text: humanReadable },
    { type: "text", text: `__EPIMETHIAN_CONFIRM_TOKEN__=${err.token}` },
  ],
  isError: true,
  structuredContent: { ... }  // still emitted for spec-compliant clients
}
```

The agent sees the second `content` block as text but knows to
parse it. Spec-compliant clients that already surface
`structuredContent` ignore the inline copy. Render-only clients
get the token from `content`.

**Pros**

- Works in *every* MCP client without configuration.
- No env var, no setup-CLI per-client logic.

**Cons**

- Same security trade-off as Option A — token is in chat history.
- Worse than A: it's *always* in chat history, even for clients
  that would have surfaced `structuredContent` correctly.
- Reduces the value of the security choice v6.6.0 made.

**Verdict:** Avoid — gives up the v6.6.0 invariant for everyone in
exchange for fixing one client.

### 5.5 Option E — Ship the token via a *second tool call* the agent must issue

Server returns a `next_action` field telling the agent to call a
helper tool like `claim_pending_token({ pending_id })` which
returns the full token in its response text.

**Pros**

- Tokens never appear in the destructive-tool's response.
- Helper tool can throttle, log, or restrict access by audit ID.

**Cons**

- A separate tool round-trip per soft-confirm.
- Agents have to know about and invoke the helper — semantic burden.
- Doesn't actually solve the underlying spec ambiguity; it just
  shifts where the token surfaces.
- More code, more moving parts.

**Verdict:** Architecturally cleaner but heavy. Not worth it for a
patch release; could be considered if we end up in a long-term
support phase for render-only clients.

### 5.6 Option F — File the upstream Claude Code bug and wait

Claim: "Claude Code's MCP tool-call result handler does not surface
`structuredContent` to the underlying LM tool message, breaking any
MCP server that uses `structuredContent` for server-to-agent
metadata."

**Pros**

- Fixes the issue at the right layer.
- Benefits every MCP server that hits the same gap.

**Cons**

- Long latency (weeks to months).
- Doesn't help today's users.
- Cannot be relied on as the primary fix.

**Verdict:** File regardless of which other option we pick. Not a
substitute for shipping a fix.

---

## 6. Recommendation

Ship **G as the primary fix** with **A as a backstop fallback** —
both in v6.6.2:

1. **G — Declare `outputSchema` on the five mutating tools.**
   Add a `z.discriminatedUnion` schema covering both the success
   and `confirmation_required` shapes; emit
   `structuredContent` matching the relevant arm in
   `formatSoftConfirmationResult` and in the success paths. This is
   the spec-correct fix and benefits every client that respects
   `outputSchema`. Estimated ~150 lines across handlers + tests.
2. **A — `EPIMETHIAN_TOKEN_IN_TEXT=true` opt-in.** Even after G
   ships, render-broken clients (e.g. older Claude Code versions
   that never honour `outputSchema`, or future clients with bugs)
   need an escape hatch. Keep this as an opt-in env var so users
   stuck on a broken client can unblock without giving up the gate
   entirely. ~30 lines.
3. **C — Setup-CLI per-client defaults.**
   `epimethian-mcp setup --client claude-code-vscode` should not
   default to A — instead it should print a "if soft-confirm
   doesn't work after upgrading to v6.6.2, set
   `EPIMETHIAN_TOKEN_IN_TEXT=true`" note. Once we know whether the
   target Claude Code versions honour `outputSchema`, the snippet
   can be tightened.
4. **F — File the upstream Claude Code issues.** Specifically: ask
   whether issue #15412's "structuredContent prioritised, content
   dropped" behaviour is intentional, and whether `outputSchema`
   declarations are honoured for `isError: true` results. Track
   the issue IDs in `client-configs.ts`.
5. **Pre-flight verification.** Before shipping G, run an MCP
   Inspector smoke test: declare `outputSchema`, return
   `isError: true` with matching `structuredContent`, confirm the
   raw MCP message is well-formed and that at least one client
   (Claude Desktop or `mcp-inspector` directly) shows the
   structured payload to the agent.

Total work: ~½ day for G, parallel-implementable as 3 tasks (schema
declaration on the five tools + handler updates, A's env-var path,
setup-CLI snippet update + CHANGELOG).

This restores Claude Code parity *and* makes the design spec-
correct, so future clients automatically work without per-client
escape hatches.

---

## 7. Out of scope (for the v6.6.2 fix)

- **MCP spec clarification.** Should `structuredContent` be MUST
  forward-to-agent on `isError: true`? That's an upstream-spec
  conversation, file separately at `modelcontextprotocol/specification`.
- **Survey of other MCP clients.** Build a per-client matrix of
  `structuredContent` pass-through behaviour. Useful for the setup-CLI
  defaults but not blocking 6.6.2.
- **Token-redaction in MCP transcripts.** If we accept tokens-in-text
  via Option A, consider a downstream redactor that strips
  `confirm_token` from any persisted transcript export. Useful for
  multi-tenant hosts. Separate hardening track.
- **Test page cleanup.** Confluence page `887881730` is still live
  at v8 from this smoke test; either expire-the-token + delete via
  whatever mechanism we end up shipping, or delete via
  `EPIMETHIAN_BYPASS_ELICITATION=true` after v6.6.1 is verified.

---

## 8. Appendix — actual server output for the smoke-test calls

```
mcp__confluence__update_page (replace_body=true, version=8)
  → SOFT_CONFIRMATION_REQUIRED
  → token tail: ...Gu0Emjmx
  → audit ID: 723430e8-edfa-4e32-a1a5-03a9e73cbcfb
  → expires: 2026-04-30T04:49:48.091Z

mcp__confluence__delete_page (version=8)
  → SOFT_CONFIRMATION_REQUIRED
  → token tail: ...OwyNBlN9
  → audit ID: de0a7dde-1a56-4709-bf71-26ca8e9a158c
  → expires: 2026-04-30T04:49:48.611Z
```

Both tokens have since expired (TTL = 5 min, default).
