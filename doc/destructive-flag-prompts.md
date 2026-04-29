# Why "Allowlisted" Tools Still Get Confirmation Prompts

When using epimethian-mcp from inside Claude Code (VS Code extension or CLI),
users sometimes hit this confusing pattern:

- They've allowlisted `mcp__confluence__update_page` in
  `.claude/settings.local.json`.
- A call to `update_page` with `replace_body: true` (or with `confirm_*`
  flags set) **still** gets rejected with `"Error: update_page was not
  executed — user declined."`
- The user reports they never saw a prompt to decline — or saw one and
  isn't sure what triggered it.

This document explains what's happening and how to work around or fix it.

## What's actually going on

Two separate permission systems are involved.

### Layer 1 — Claude Code's tool-call allowlist

`.claude/settings.local.json` controls **whether the tool can be called
at all**. When the allowlist contains `"mcp__confluence__update_page"`,
Claude Code will dispatch a call to that tool name without prompting
the user first.

This is the layer most users are aware of, and it works as expected.

### Layer 2 — destructive-parameter handling

`update_page` accepts several parameters that explicitly acknowledge
destructive intent:

- `replace_body: true` — bypass token-aware preservation and overwrite
  the entire page body
- `confirm_deletions: true` — acknowledge that preserved macros or
  rich elements will be removed
- `confirm_shrinkage: true` — acknowledge a >50% body-size reduction
- `confirm_structure_loss: true` — acknowledge a >50% heading-count drop

When destructive flags are set, the `source` parameter records where the flag
originated: `user_request` (the user's direct instruction), `file_or_cli_input`
(from local files), `elicitation_response` (from a confirmed interactive prompt),
or `chained_tool_output` (from prior tool results—strictly forbidden). The tool's own description states:

> *"Destructive flags and parameters on this tool (including
> `confirm_shrinkage`, `confirm_structure_loss`, `replace_body`,
> version targets, and body content) must come from the user's
> original request."*

In practice, when one of these flags is set, the call is treated by
the surrounding harness as a higher-risk operation than a vanilla
`update_page`, and an additional confirmation step gets requested
before it executes. That second confirmation is **not** governed by
the tool-name allowlist — the allowlist already approved invocation
of the tool; this is about approving the destructive intent of *this
specific call*.

If the confirmation prompt isn't visible to the user (UI focus, modal
hidden behind another window, IDE auto-decline behaviour, prompt
timeout, etc.), the call returns as `"user declined"` even though the
user never knowingly declined anything.

## The two layers, as a chain

```
Claude calls update_page with replace_body: true
  │
  ├─► Layer 1: tool-name allowlist check
  │     "mcp__confluence__update_page" ∈ allowlist  →  pass
  │
  ├─► Layer 2: destructive-parameter check
  │     replace_body: true present  →  request per-call confirmation
  │       │
  │       ├─► User sees prompt and approves   →  call executes
  │       └─► Prompt times out or is hidden   →  "user declined"
```

## Why `update_page_section` mostly avoids this

`update_page_section` does not have a `replace_body` flag. As long as
the section body update doesn't trip the server-side shrinkage check
(see [data-preservation.md](data-preservation.md)) and doesn't need
`confirm_deletions` for preserved-macro removal, no destructive flag
is set, so layer 2 doesn't fire and the call goes through cleanly.

The practical workaround for bulk write workflows: prefer
`update_page_section` per heading over a single `replace_body: true`
on `update_page`. If a section update needs to remove a preserved
macro, pad the new section body with substantive content so the new
size stays above 50% of the old size — that keeps `confirm_shrinkage`
out of play, and a lone `confirm_deletions: true` typically does not
trigger the layer-2 prompt.

## How to debug a "user declined" you didn't intend to send

1. **Look in the VS Code notifications panel** (bottom-right bell icon).
   The destructive-action prompt is sometimes shown as a transient
   notification rather than a modal dialog.
2. **Check the Claude Code output channel** in VS Code's Output panel.
   Permission prompts and their outcomes are logged there with the
   full parameter set being requested.
3. **Try the operation with the destructive flag removed.** If
   `update_page` works without `replace_body` and fails with it, layer
   2 is the cause.
4. **Run with the parameters `update_page_section` instead** if the
   change is scoped to a single heading. Most "I just need to fix one
   section" cases never need to touch `update_page` at all.

## What we could do server-side

This file is informational; the current behaviour is intentional.
Nonetheless, options if we wanted to tune it:

- **Configurable destructive-action policy.** An env var (parallel to
  `EPIMETHIAN_WRITE_BUDGET_HOURLY`) along the lines of
  `EPIMETHIAN_DESTRUCTIVE_POLICY=prompt|allow|deny` that lets the
  operator pick whether destructive flags trigger a prompt at all.
  Default `prompt` (current behaviour).
- **Better signal in the rejection message.** Today the user-visible
  message is just `"user declined"`. Including which specific
  destructive flag triggered the prompt would shorten the
  troubleshooting cycle considerably.
- **Surface the prompt source clearly.** A note in the prompt itself
  along the lines of *"This call sets `replace_body: true` — approve
  to proceed."* would let users distinguish a destructive-action
  prompt from an ordinary tool-name prompt.

## Related

- [data-preservation.md](data-preservation.md) — the token-preservation
  system and the shrinkage / deletion guards that drive most of the
  layer-2 logic.
- [design/11-safety-guards.md](design/11-safety-guards.md) — the
  internal design document that introduces the destructive-flag
  parameters discussed here.
