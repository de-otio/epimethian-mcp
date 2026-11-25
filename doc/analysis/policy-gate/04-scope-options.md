# 4. Scope options

This file is the consolidated recommendation. It takes the proposal in
[01-proposal.md](01-proposal.md) and applies the corrections from
[03-gaps-and-risks.md](03-gaps-and-risks.md), the design rules from
[05-lessons-from-repo-aegis.md](05-lessons-from-repo-aegis.md) and the
usability findings from [06-usability-review.md](06-usability-review.md).

## Design rules for every step

1. **One decision function.** All read handlers call one `decideRead`, and
   one loader supplies the effective policy. A test fails for any registered
   tool without a declared gate decision.
2. **Off by default, on with one command.** A profile without a policy
   behaves as today. Turning the feature on needs no hand-edited file.
3. **Report before enforce.** Every rule that can block on a property of the
   content (classification, detectors) ships with a report-only mode, and
   report-only is the first-run state.
4. **Limits are announced, not discovered.** The effective scope and budget
   are stated in the server instructions and tool descriptions at startup.
5. **Refusals have a fixed shape:** what was withheld and that it is final
   for this call; the rule and the setting behind it; one exact command for
   the person; what the agent can do instead; whether a restart is needed.
6. **No content in refusals, receipts or logs.** A rule name, a level, a
   category and a count; never the matched text.
7. **Ask degrades to deny.** Only MCP elicitation or an approval minted at a
   terminal counts as a person. The soft-confirmation token does not.
8. **Each rule has a written fail direction** (table in
   [05-lessons-from-repo-aegis.md](05-lessons-from-repo-aegis.md)). An
   unreadable policy refuses; it never means "no policy".
9. **The user's vocabulary.** Level names are the organisation's own; the
   output of `policy` is plain sentences, not settings.

## Steps

| Step | Content | Proposal features | Risk |
|---|---|---|---|
| 0 | Preconditions: unreadable registry fails closed and is reported through recovery mode; fix the refusal that names a non-existent CLI flag | – | Low |
| A | Read scope on every read tool; `policy` and `policy setup`; scope in server instructions; refusal shape | 2, 9 | Low |
| B | Read audit log, receipts, read budget, `log` command | 5, 8 | Low |
| C | Approvals minted at a terminal | 9 | Medium |
| D | Classification: dry-run report, report-only mode, declared clearance, labels and per-space default, `policy import`, `policy explain` | 1, 3, 7 | Medium |
| E | Metadata: omit fields by default (E1); placeholders in bodies as opt-in (E2) | 4 | E1 low, E2 high (write path) |
| F | Content detectors: redact in place, thresholds per category, report-only first | 6 | Medium (false assurance) |
| G | Local-model classifier | 6 | Not analysed |

Steps 0, A and B need no detection and no policy judgement beyond a list of
spaces and a number. Together they give scoping, a record and a cap.

Order against the 8.0.0 release (decision 13): step 0 now as a patch; step A
before 8.0.0 if that work can run in parallel; step B onwards after it.

### Step 0: preconditions

- A profile registry that exists but cannot be read (parse error, unsafe
  permissions, symlink) is a refusal, distinct from a missing file. See
  "Registry read failures" in [02-code-findings.md](02-code-findings.md);
  the behaviour is to be reproduced first.
- MCP clients usually hide stderr. The server starts in its existing
  recovery mode, and every tool answers with what is wrong and the command
  that fixes it.
- The write-allowlist refusal (`src/server/space-allowlist.ts:48`) names
  `profiles --add-space`, which the CLI does not implement. Either the flag
  is added or the message is corrected. Step A adds the command it should
  name.

### Step A: read scope

Behaviour:

- Every handler that takes a content ID, a space key, a title plus space, or
  a comment ID resolves the space and checks it before returning content.
  `assertSpaceAllowed` already does the resolution and fails closed.
- An allow list, with optional deny patterns for exceptions. Personal spaces
  need a pattern form in addition to exact keys.
- Listing tools state that the result was narrowed by policy, as
  `search_pages` does today. `get_spaces` shows allowed spaces only.
- No extra API call on a cache hit.
- `lookup_user` has no space; it is decided in step E.

Configuration:

- `epimethian-mcp policy` prints the effective policy in plain sentences,
  the state of the policy file, and whether a restart is pending.
- `epimethian-mcp policy setup` lists the tenant's spaces and lets the
  person tick the readable ones. Keys are never typed. It ends with one
  sentence describing the result.
- No new setting for the scope (decision 7): `read_spaces` with
  `read_spaces_enforced` becomes the read boundary for every read tool, and
  `spaces` stays the write boundary. `policy setup` writes them; `policy`
  shows the effective result in sentences.
- The read policy is re-read when the file changes (decision 9). The next
  tool result says that the policy changed since session start.
- Both API modes (decision 14), with one live check of space resolution
  under a scoped token.

First-run flow: see "Recommended shape" in
[06-usability-review.md](06-usability-review.md).

### Step B: record and cap

- One audit record per read: content ID, version, space, byte count,
  profile, MCP client name, decision and rule. A hash of the effective
  policy at startup and on every change.
- A log that cannot be written does not block reads (decision 12). The gap
  is shown in the receipt line and in `policy` output.
- A receipt line on each read that returns content: space, bytes released,
  budget used.
- Budget counts distinct pages, not calls. The receipt shows the count; a
  warning precedes the cap; the refusal says when the budget resets.
- `epimethian-mcp log` answers "what was read": by time range and space,
  with a summary and an export.

### Step C: approvals

- `epimethian-mcp policy approve` mints a short-lived approval for one page
  or one space. It needs a terminal; an agent cannot mint one.
- An approval lifts a budget block and, from step D, an unmarked-page block.
  It does not lift the space scope or a classification above the declared
  clearance; those are changed by editing the policy.
- Mint, use and revocation are audit records. The refusal that an approval
  would lift names the command.
- An approval is for a one-off exception. A lasting change is a policy edit,
  which applies without a restart (decision 9).

### Step D: classification

In this order:

1. A dry-run report per space: pages per level and unmarked pages, so the
   default for unmarked pages is chosen on data.
2. Report-only mode: the gate decides and logs, and releases the content.
3. Enforcement: a page above the declared clearance returns title, level
   and reason. That response replaces the proposal's preflight tool for the
   agent; `policy explain <page>` gives a person the same answer.
4. `policy import <file>` takes an organisation's policy as is, including
   its level names and the label that marks each level.

Classification is read from labels and a per-space default first. A status
macro in a page-properties table follows once the label path is proven,
because it requires the body. Label lookups are cached for a short time.

`policy setup` offers presets, so the person answers one question.

### Step E: metadata

- **E1, default:** omit identity fields nobody asked for, such as the
  last-editor line in search results. No map, no effect on writes.
- **E2, opt-in:** placeholders for mentions in bodies, with the cost
  stated: the agent's answers in the chat show placeholders, because only
  the write path can resolve them. Needs its own spec, round-trip property
  tests, and a local command that resolves a placeholder.
- `lookup_user` gets a per-policy switch.

### Step F: detectors

- A hit redacts the match in place and releases the rest; the result names
  the category and the count.
- Thresholds per category, so a contact line differs from a list of people.
- Each new detector runs report-only first.

## Decisions

All decided on 2026-11-25.

| # | Decision | Decided | Reason |
|---|---|---|---|
| 1 | Allow list, deny list, or both | Allow list with optional deny patterns | A deny list alone leaves new spaces readable until someone adds them |
| 2 | Override mechanism | Terminal-minted approvals (step C); elicitation where the client has it; never the soft-confirmation token | The model passes the soft-confirmation token back itself |
| 3 | Preflight tool | No agent tool; the withheld response plus `policy explain` | One tool fewer for the agent to choose and call |
| 4 | Feature 4 | Split into E1 (default) and E2 (opt-in) | Placeholders reach the person in chat answers and touch the write path |
| 5 | First-run state for content rules | Report-only | Blocking before the wiki's labelling is known gets the feature switched off |
| 6 | Unreadable policy | Refuse, through recovery mode | A syntax error must not switch the policy off |
| 7 | Meaning of `read_spaces_enforced` | The existing flag covers all reads. `read_spaces` without it stays a search default. No new setting | The name already promises a boundary. Cost: a profile that sets the flag and reads pages outside the list by ID starts getting refusals; this needs a "Changed" changelog entry |
| 8 | Policy and credential | The policy stays in the credential profile for steps A to C, stored as one `policy` block that can later be referenced by name. The split into named policies is decided at step D | A space scope describes the tenant, not the model. The model matters from step D |
| 9 | Applying a change | The read policy is re-read when the file changes. Each change is logged with its hash, and the next tool result states that the policy changed since session start. Tool registration stays fixed at startup | A fix that needs a restart looks like a broken feature. Cost: the restart was a small speed bump against an agent that edits the file; accepted under the stated threat model (accidents, not a deliberate agent) |
| 10 | Where the policy lives | The profile registry. A separate organisation file that the registry cannot widen arrives with `policy import` in step D; root ownership is then a matter of where that file is placed | Nothing before step D needs a second file |
| 11 | Default for unmarked pages | No built-in default: `policy setup` makes the person choose when a clearance is declared, and presets carry a value. Which value the presets carry is set after the dry-run report exists | The right value depends on how much of a wiki is unmarked |
| 12 | Audit log cannot be written | Continue and report: the gap is shown in the receipt line and in `policy` output. A "log required" option can follow in step D | Matches the mutation log, which does not block on a write failure. Blocking all reads on a full disk is the worse failure |
| 13 | Sequencing against 8.0.0 | Step 0 now, as a patch release. Step A before 8.0.0, on condition that the 8.0.0 work can run in parallel; otherwise A waits. Step B onwards after 8.0.0 | Step 0 fixes today's write allowlist. A and 8.0.0 both touch every tool registration; with A first, the migration moves the final handlers once. 8.0.0 has a fixed date |
| 14 | Gateway mode | The gate runs in both API modes. Gateway mode is the vendor's API gateway with a scoped token, so there is no gateway-side policy. One live check that space resolution behaves the same with a scoped token | – |

## Not in scope of this analysis

- The legal assessment of any particular model platform.
- Classification of attachments' file content.
- Other data paths into the model than this server.
