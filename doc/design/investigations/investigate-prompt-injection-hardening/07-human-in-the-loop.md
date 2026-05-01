# 7. Human-in-the-loop on destructive actions

[← back to index](README.md)

## Why this is the highest-value proposal

Every other layer in this investigation (fencing, signal scanning,
Unicode sanitisation, provenance, floor guards) raises the bar for a
successful injection but does not make one impossible. A coerced agent
can still pass the guards by setting the right flags in the right
shape.

**The one defence that robustly breaks the injection chain is a
real-time human check.** If the agent must surface its plan to a human
and wait for approval before a destructive tool call, the attacker
needs to compromise the human as well — a much higher bar than
compromising the model.

MCP supports this natively via
**[elicitation](https://modelcontextprotocol.io/specification/2025-06-18/server/elicitation)**:
a server-initiated prompt that asks the user a question mid-call.
Claude Code, Cursor, and the MCP Inspector implement it; the `elicit`
method is part of the spec. Servers that call it on unsupported
clients get a structured error they can degrade on.

## Proposal

Define a set of **gated operations** — tool calls whose effect is
non-trivially destructive. For each gated operation, the handler calls
`server.elicit(...)` before the Confluence API call, surfacing:

- The tool name and the page ID.
- The current page title (fenced — see [04](04-unicode-sanitisation.md)).
- A summary of the change: byte delta, heading delta, macro delta,
  which preservation tokens will be removed.
- The exact `confirm_*` / `replace_body` flag values.
- Any `injection-signals=…` detected on recent reads.
- A free-text "reason" the agent supplied (required when any gated
  flag is set — see [03](03-flag-provenance.md)).

The elicitation shape is a structured-form request whose result is
`{ confirm: boolean, note?: string }`. A `false` or timeout aborts
the call with `USER_DENIED_GATED_OPERATION`.

## Gated operations (initial list)

| Tool                   | Gate condition                                              |
| ---------------------- | ----------------------------------------------------------- |
| `delete_page`          | Always                                                      |
| `update_page`          | `replace_body=true` OR any `confirm_*=true`                 |
| `update_page_section`  | `confirm_deletions=true`                                    |
| `revert_page`          | Always                                                      |
| `delete_comment`       | When N in last 60s > 3 (bulk threshold)                     |
| `remove_label`         | Targeting `epimethian-*` (system labels)                    |
| `create_page`          | When N in last 60s > 5 (bulk threshold)                     |

Bulk thresholds complement the [mass-damage](../investigate-agent-loop-and-mass-damage/README.md)
concerns directly: the first 3 deletes in a minute are unchecked, the
4th triggers a gate.

## Degradation on unsupported clients

Not every client supports elicitation today. The server detects
capability via the `initialize` handshake's `capabilities.elicitation`
field (added in MCP 2025-06-18). Behaviour matrix:

| Client                         | Default posture                                       |
| ------------------------------ | ----------------------------------------------------- |
| Supports elicitation           | Always elicit on gated operations                     |
| Does not support elicitation   | Configurable; default **refuse**, opt-out via env var |

The opt-out (`EPIMETHIAN_ALLOW_UNGATED_WRITES=true`) restores today's
behaviour. The name is deliberately unflattering — setting it should
feel like a decision, not a shrug.

## Interaction with `readOnly` mode

`readOnly` is the existing coarse-grained defence. Elicitation is
finer-grained: same mechanism, per-call rather than per-profile.
Profiles used for customer-editable wikis should be `readOnly`; the
elicit layer protects profiles that must be read-write but where
bulk edits are rare.

## Costs

- Adds ~150 LOC across the pipeline (handler wrappers, capability
  detection, env-var handling, one set of tests per gate).
- Adds latency to every gated call: one MCP round-trip between
  server and client. Usually < 100 ms in local clients; can be
  seconds in remote ones.
- Unsupported clients degrade to "refuse" by default, which will
  break workflows for users who have not set the opt-out. Ship with
  clear error messaging pointing to the env var.

## What this does *not* do

- A user who blindly approves every prompt is not protected. The
  elicitation payload includes the page title, byte delta, and any
  injection signals so the user has the information to decide — but
  decision quality is on the user.
- Elicitation is not available inside a "run this CI job and
  non-interactively edit Confluence" workflow. For those, the
  unsupported-client opt-out is the escape hatch; combine with
  [capability scoping](08-capability-scoping.md) to constrain the
  blast radius of what the non-interactive job can do.
