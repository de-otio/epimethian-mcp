# 6. Usability review

A review of the proposal in [01-proposal.md](01-proposal.md) against one
goal: the feature should be as easy as possible to turn on, to live with,
and to recover from when it blocks.

A protection that is hard to use gets switched off. For this feature that
means the usable version is also the safer one.

## Who uses it

| User | Touches the feature when | Needs |
|---|---|---|
| The person who sets up a profile | Once, at setup; again when blocked | Few decisions, in the vocabulary of the organisation's policy |
| The person in the chat | Every time the agent is refused | To understand what happened and what to do, from the agent's relay |
| The agent | On every read | To know the limits before planning, and a refusal it can act on |
| Whoever owns the policy in an organisation | When rolling it out to many people | To write it once and distribute it |
| Whoever scopes an incident | Rarely, under pressure | To answer "what was read" without parsing files |

The proposal is written from the first row only.

## Findings

### 1. Too many decisions to turn it on

The sketch asks for a classification ceiling, a personal-data tier, a space
allow list, a deny list, two budgets and, implicitly, a default for unmarked
pages and a detector action. Each is a policy judgement, and a wrong value
either blocks work or protects nothing.

- Turning the feature on should be one question with named presets, and
  every other value should have a default that the preset sets.
- An organisation should be able to ship a policy file that a person imports
  with one command, so the individual makes no policy decision at all.
- Step A alone has one concept: a list of spaces. That is a further reason
  to ship it first.

### 2. Vocabulary is the tool's, not the user's

"Clearance", "tier_a" and "max_classification" are internal terms. A person
knows the words the organisation's policy uses and the labels on the pages.

- Level names should be the organisation's own, declared as an ordered list
  with the label that marks each level.
- Personal-data tiers need plain names in prompts and messages ("names of
  colleagues only", "personal records"), with the tier letter as the key in
  the file at most.

### 3. Configuration is hand-edited JSON

Today `spaces`, `read_spaces` and `read_spaces_enforced` are set by editing
the profile registry by hand. The CLI has flags for posture and attribution
only. The refusal for a write outside the allowlist tells the reader to run
`epimethian-mcp profiles --add-space <KEY>`
(`src/server/space-allowlist.ts:48`); `src/cli/profiles.ts` implements no
such flag.

- The setup wizard already asks for the access posture. The policy question
  belongs in the same flow.
- Spaces should be picked from the list the tenant returns, not typed. Space
  keys are case-sensitive, and a typed key that matches nothing produces an
  allow list that silently blocks everything, or a deny list that silently
  blocks nothing.
- Every write of a policy value should validate it and say what the
  resulting policy means in one sentence.
- The message that names a non-existent flag should be fixed regardless of
  this feature.

### 4. Three settings for one idea

With the proposal there would be `spaces` (writes), `read_spaces` (a search
default), `read_spaces_enforced` (search only) and a new allow/deny pair.
The difference between a scope that is "hygiene" and one that is "enforced"
already needs a paragraph in the README.

- One read scope and one write scope, each meaning what its name says.
- If the old settings stay for compatibility, `status` should show the
  effective result, not the inputs.

### 5. A profile that stands for a model

The proposal binds the clearance to the profile because the server cannot
see the model. A person who uses one wiki account with two models then needs
two profiles, each with its own stored credential, and must pick the right
one in each client's configuration. Choosing the wrong profile is silent.

- Separate the policy from the credential: one credential, several named
  policies, selected by the client configuration.
- The server does know the MCP client's name. `status` and the audit record
  can show it, so a mismatch between a policy's intent and the client using
  it is at least visible.

### 6. Changes need a restart

The CLI notes that running servers must be restarted for a settings change.
In most MCP clients that means restarting the session and losing its
context. A person who is blocked, fixes the policy and still sees the block
will conclude the feature is broken.

- Either the policy is re-read when the file changes, with the change
  recorded in the audit log, or the short-lived approval from
  [05-lessons-from-repo-aegis.md](05-lessons-from-repo-aegis.md) covers the
  mid-session case. One of the two is needed.
- A refusal should say whether a restart is required.

### 7. The agent discovers the limits by being refused

Nothing in the proposal tells the agent the policy in advance. An agent that
plans "read the twenty pages under X" learns at page one, or at page
fifty-one, that it cannot.

- State the effective scope in the server instructions and in the relevant
  tool descriptions at startup: readable spaces, budget, what a withheld
  page looks like. `search_pages` already does this for its scope.
- Feature 7, the preflight tool, becomes unnecessary for the agent: a read
  that is not permitted already returns title, level and reason. One tool
  fewer to describe, choose and call. The same check is useful to a person
  as a CLI command (`policy explain <page>`).

### 8. Refusals are the user interface

Most contact with this feature is a refusal relayed by an agent. The
proposal says refusals "say why and what to do instead"; that needs a fixed
shape, because the reader is a model that will paraphrase it for a person.

Each refusal should carry, in this order:

1. What was withheld, and that this is final for this call (do not retry,
   do not try another tool).
2. The rule, in the policy's vocabulary, and the setting that caused it.
3. What the person can do, as one exact command.
4. What the agent can do instead within the policy.
5. Whether a restart is needed.

A refusal that leaves out point 1 invites the agent to try
`get_page_by_title` after `get_page` failed. A refusal that leaves out point
3 ends in "I can't access that" with no way forward.

### 9. Blocking by default without knowing the wiki

The default for unmarked pages decides whether the feature is usable. A
strict default on a wiki where most pages are unmarked blocks nearly
everything on the first day, and the person turns the feature off.

- A report-only mode: the gate decides and logs, but releases the content.
  A person can run with it for a week and see what would have been blocked.
- A dry-run report per space before enabling: how many pages per level, how
  many unmarked.
- The first-run experience should be report-only, with enforcement as the
  explicit second step.

### 10. Budgets fail at the worst moment

A cap is hit in the middle of a task, when most of the cost is already
spent. "Session" is the lifetime of a server process, which a person cannot
see.

- Count distinct pages, not calls. Reading the outline, then one section,
  then the page again is one page.
- Show the count on every read (the receipt line) and warn before the cap,
  so the agent can tell the person in advance.
- Make the cap extendable by an approval, not only by editing the policy.
- Say in the refusal when the budget resets.

### 11. Placeholders reach the person, not only the model

Feature 4 replaces names with `[[user:1]]` and resolves them on write. The
write path can resolve them because it passes through the server. The
agent's answer in the chat does not. A person who asks "who changed this
page?" gets "`[[user:3]]`".

- Common tasks depend on names: asking a page's owner, mentioning a
  colleague, summarising who decided what. `lookup_user` exists for exactly
  this.
- Minimising by omission is easier to live with than placeholders: drop the
  last-editor line from search results, drop author fields nobody asked for.
  That needs no map and cannot break a write.
- Placeholders in bodies remain a policy option, but as an explicit choice
  with its cost stated, not as the default.
- If placeholders are used, a person needs a local command that resolves
  one.

### 12. Detectors on ordinary pages

E-mail addresses and phone numbers appear on most team and contact pages. A
detector that blocks on a hit blocks ordinary work; one that asks on a hit
trains the person to click yes.

- Redact the match in place and release the rest, and say that something
  was redacted and of which category.
- Use thresholds per category (one address is a contact line, two hundred
  are a list of people).
- Run new detectors in report-only mode first.

### 13. Misconfiguration must be visible in the client

MCP clients usually hide the server's stderr. A policy that fails to load
would, with the present loader, vanish silently (see "Registry read
failures" in [02-code-findings.md](02-code-findings.md)); a server that
refuses to start shows the person a generic connection error.

- The server already has a recovery mode. A policy that cannot be loaded
  should start the server in a state where every tool answers with the same
  message: what is wrong and the command that fixes it.

### 14. Latency

The classification gate adds API calls to every read. A person does not see
the reason, only a slower tool.

- Cache label lookups for a short time, as the space lookup already is.
- Keep step A free of extra calls on a cache hit.

### 15. The audit log needs a reader

A JSONL file answers no question by itself. The incident-scoping user needs
`log` commands: reads in a time range, by space, by level, with a summary,
and an export.

## Recommended shape

Three commands cover the person's side:

```
epimethian-mcp policy            # show the effective policy in plain sentences
epimethian-mcp policy setup      # guided: preset, spaces from a list, report-only first
epimethian-mcp policy import <file>   # take an organisation's policy as is
```

Plus `log` (step B), `policy approve …` (step C) and `policy explain <page>`
(step D) when the steps that need them arrive.

The first experience, for step A:

1. `policy setup` lists the tenant's spaces; the person ticks the ones the
   agent may read.
2. The command prints one sentence describing the result and whether a
   restart is needed.
3. The agent sees the scope in the server instructions.
4. A read outside the scope returns a refusal in the fixed shape, ending in
   the one command that would add the space.

## Where the findings went

All findings are applied in [04-scope-options.md](04-scope-options.md):

| Finding | Applied as |
|---|---|
| 1, 2 | Design rules 2 and 9; presets and `policy import` in step D |
| 3, 4 | Step 0 (message fix); `policy` and `policy setup` in step A |
| 5, 6 | Decisions 8 and 9; approvals in step C |
| 7 | Design rule 4; no preflight tool (decision 3) |
| 8 | Design rule 5 |
| 9 | Design rule 3; dry-run report and report-only mode in step D |
| 10 | Step B (distinct pages, receipt, warning); approvals in step C |
| 11 | Step E split into E1 and E2 (decision 4) |
| 12 | Step F |
| 13 | Step 0 (recovery mode) |
| 14 | Steps A and D (caching) |
| 15 | `log` command in step B |
