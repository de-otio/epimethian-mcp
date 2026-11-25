# 5. Lessons from repo-aegis

[repo-aegis](https://github.com/de-otio/repo-aegis) guards the mirror-image
problem: bytes leaving a repository towards a publishing destination, where
the policy gate is about bytes entering a model context. Its egress-guard
design records decisions that were each paid for with an incident or a
finding. This file lists the ones that transfer, and what each would mean
here.

Source: the egress-guard design and the agent guide that ship with
repo-aegis (`repo-aegis docs egress-guard`, `repo-aegis docs agent-guide`).

## Two axes: content and destination

repo-aegis started with one question, "are these bytes safe in this
repository?", and had two incidents that were "right bytes, wrong boundary".
It added a second axis: where the bytes are going.

The gate has the same two axes. Classification and detectors are the content
axis; the declared model clearance is the destination axis. Both must be
decided in one place, and neither replaces the other.

## One pure decision function

Every repo-aegis enforcement point calls the same `decideEgress`, which
returns `allow`, `ask` or `deny` with a code and a reason. Registry state
comes from one non-throwing loader "so they cannot disagree".

For the gate: one `decideRead(request, policy, capabilities)` that all read
handlers call, and one loader for the effective policy. This is the choke
point named in [03-gaps-and-risks.md](03-gaps-and-risks.md).

## Ask degrades to deny, never to allow

The caller declares whether its host can put a real prompt in front of a
person. Where it cannot, `ask` becomes `deny`. repo-aegis also learned that
a prompt answered by an automatic classifier is not a person's answer.

For the gate: MCP elicitation counts as a prompt. The soft-confirmation
token does not, because the model passes it back itself. An override on a
client without elicitation is a deny.

## An explicit fail direction per rule

repo-aegis separates rules that need no context (unconditional) from rules
that need context (fail open when the context is missing, so a defect in the
guard does not block all work). It then names deliberate exceptions: where
the unknown is itself the risk, the rule fails closed. An unknown destination
visibility is treated as public; a live lookup "can only lift the refusal,
never impose or skip it".

For the gate, each rule needs its direction written down:

| Situation | Direction |
|---|---|
| Space of a content ID cannot be resolved | Closed (as for writes today) |
| Profile declares no clearance | Lowest clearance |
| Page carries no classification | The configured unmarked default; never silently "public" |
| Policy cannot be read or parsed | Closed (see the next section) |
| Label lookup fails (network, permission) | Closed for the body; title and reason only |
| Audit log cannot be written | Open: reads continue and the gap is reported (decision 12 in [04-scope-options.md](04-scope-options.md)) |

## An unreadable policy must not switch the policy off

repo-aegis treats a registry that exists but cannot be read as a refusal,
"because an agent that can write the file could otherwise switch the rule off
with one bad line". A registry that is simply absent is a different state
with a different answer.

Epimethian currently does the opposite; see "Registry read failures" in
[02-code-findings.md](02-code-findings.md). A policy gate built on the
present loader would be disabled by a syntax error.

## Approvals instead of flags

Where repo-aegis needs a person, the person mints an approval from a
terminal:

- scoped (one destination, optionally one ref) and short-lived (15 minutes
  by default, 24 hours at most);
- not consumed on use, because one action passes several layers; the
  lifetime is the bound;
- valid for exactly one rule, the "needs a human" rule. Shape rules,
  boundary rules and the content scan still refuse;
- audited at mint, at every use and at revocation;
- named in the refusal text, so the person reading it knows the one command
  to type.

For the gate, this is the recommended override mechanism (step C in
[04-scope-options.md](04-scope-options.md)): an approval for one page
or one space, for a few minutes. It could lift a budget block or an
unmarked-page block. It should not lift the space deny list or a
classification above the declared clearance; those are changed by editing
the policy, which is a different act.

## Honesty about a same-user agent

repo-aegis states that its human-presence checks are "advisory outside the
agent's sandbox": a same-user agent can forge an environment variable or
write the approvals file. It responds in three ways that transfer:

- Its installer adds its own state files to the agent sandbox's write-deny
  list. Epimethian's `setup` could offer the same for the profile registry.
- Its `doctor` warns when a file that enforcement depends on is writable by
  the agent.
- It names the lasting fix (a signal the agent cannot forge) as a follow-up
  rather than claiming the present checks are proof.

It also states its threat model in one phrase: accidents, not a deliberate
agent. The gate's documentation should make the same statement, and call
detectors what repo-aegis calls some of its rules: speed bumps, not proofs.

## Receipts

After a permitted publish, repo-aegis prints one line naming the destination
and its visibility, because a model skims long output but not one line with
an unexpected name in it. It requires positive evidence that the publish
happened and otherwise says "unconfirmed".

For the gate: each read that returns content could end with one line stating
space, classification, bytes released and budget used. The same fields go
into the read audit record.

## Refusals: a code, a fix, no content

Every repo-aegis refusal has a code, a reason that names the destination,
and one fix line; `repo-aegis explain <CODE>` prints the long form. Matched
markers are never echoed, and the decision log "never holds a token, a path,
a URL, a command or a marker". The stated reason is recency pressure: a
value shown to a model is likely to be repeated by it.

For the gate: a refusal names the rule and the page's level, not the text
that triggered it. A detector hit reports a category and a count. This
matches the existing rule that `redact_patterns` values never appear in
errors or logs.

## Decision only, never a silent rewrite

repo-aegis never rewrites a command into a safe one; the agent re-issues an
explicit command or a person approves. A silent rewrite hides the fact that
the original intent was wrong.

For the gate: when a listing or search is narrowed by policy, the result
says so, as `search_pages` already does for `read_spaces`. A withheld body
is an explicit result with a reason, not an empty one.

## Layers do not degrade into each other

repo-aegis found that one of its three layers was silently absent in agent
shells, and that the remaining layer's answer (`ask`) was not a refusal
there. Its fix: each layer checks whether the layer below is reachable and
denies if it is not, and `doctor` reports the gap.

An MCP server has no layer below it; it is the only choke point for its data
path. That makes two things more important here than there:

- the test that fails for any registered tool without a declared gate
  decision;
- a `status` output that shows the effective policy, the state of the policy
  file, and whether the file is writable by the current user.

## What does not transfer

- Choke points outside the agent (a git hook, a `PATH` shim). There is none
  for wiki reads.
- Process-ancestry checks for human presence. An MCP server runs as a child
  of the agent host by design.
