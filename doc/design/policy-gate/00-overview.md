# Policy gate: design overview (steps 0, A, B)

Status: design, reviewed 2026-11-25. Not built. The design review (nine reviewers) found no
redesign; its blockers X1–X7 and should-fix items S1–S38 are folded in, and the resolutions of
its open questions and blockers are decisions D15, D18, D20, D22, D23 and D26–D37
([04-decisions.md](04-decisions.md)).

Inputs: [doc/analysis/policy-gate/](../../analysis/policy-gate/README.md) (decisions 1–14 and
design rules 1–9 in [04-scope-options.md](../../analysis/policy-gate/04-scope-options.md) are
final). Line numbers are from `master` at 7.6.0 (`15d5ebe`); step A re-anchors them against the
8.0.0 tag. Examples use the placeholder space keys `HR`, `DEV`, `DOCS`.

## 1. Problem

The server is the last point before wiki content enters the model context, and it has no read
boundary:

- `read_spaces_enforced` covers `search_pages` and `get_recent_changes` only
  (`src/server/read-scope.ts:38`, used at `src/server/index.ts:1141`); every other read tool
  returns any page the token can read (`README.md:188`, `src/shared/profiles.ts:152-156`).
- An unreadable profile registry is read as an empty one (`src/shared/profiles.ts:177-238`):
  configured restrictions stop applying, posture falls back to `detect`, and the CLI writers
  rebuild the file from `{profiles: []}` and overwrite every other profile
  (`src/shared/profiles.ts:275-315`).
- There is no record of reads and no read cap.
- The write-allowlist refusal names `epimethian-mcp profiles --add-space`, which the CLI does
  not implement (`src/server/space-allowlist.ts:48`).

## 2. Goals

| # | Goal | Step |
|---|---|---|
| G1 | An unreadable registry fails closed at startup (recovery mode) and no CLI command writes over it; registry writes are durable (fsync, backup, lock) | 0 |
| G1a | Mid-session: an unreadable registry denies; a policy set with the CLI cannot be widened or dropped by editing or removing the file (keychain anchor: the file may narrow, never widen) | A |
| G2 | `read_spaces` + `read_spaces_enforced` bound every read tool, through one choke point that a new tool cannot bypass and that never allows by default | A |
| G3 | The person turns the scope on with one command and sees the result in plain sentences | A |
| G4 | The agent learns the limits at startup; every refusal has the fixed five-part shape and no dead end | A |
| G5 | A policy change applies on the next tool call and is announced once | A |
| G6 | One read-log record per read, a receipt line per released result, a distinct-page budget, a `log` reader | B |
| G7 | Steps C–G can be added without changing the shape of A/B (extension points only) | A |

## 3. Non-goals

- Classification, approvals, metadata minimisation, detectors, local classifier (steps C–G):
  extension points only ([02-interfaces.md §10](02-interfaces.md#10-extension-points-cg)).
- A boundary against a deliberate agent with shell access. Threat model: accidents, not a
  deliberate agent. On a machine where the agent can write files, the policy is tamper-evident
  at best ([analysis 03](../../analysis/policy-gate/03-gaps-and-risks.md)).
- Compliance. The tool does not make usage GDPR-compliant by itself, cannot verify which model
  or provider receives content, and its read log is not evidence-grade (DOC-5).
- Data paths other than this server's Confluence calls.
- Attachment file content classification.
- A new setting for the scope (decision 7) or named policies (decision 8; deferred to step D).
- User lookups: `lookup_user` stays outside the space scope until step E (D27).

## 4. Constraints

- Decisions 1–14 and design rules 1–9 are binding. Behaviours they do not cover were decided on
  2026-11-25 (D15 write ceiling, D18 hot `spaces`/`redact_patterns`, D20 restart wording).
- Sequencing (D22): step 0 ships now as the 7.6.1 patch on SDK 1.x. Step A lands after 8.0.0
  and is written once against SDK 2.x (`@modelcontextprotocol/server` 2.4.x, `serveStdio(factory)`,
  handler `ctx`, Node ≥ 20); there is no 7.7.0. Step B follows A. 8.0.0 contract C5 (no
  mutation, budget consumption or log write before a gate resolves,
  `plans/next-release-sdk2-and-v2-api.md:169`) applies to the gate.
- The gate lives in new modules with small `index.ts` hunks and does not move the shim (W-SDK
  keeps the wrapper semantics, plan `:449`).
- The decision-14 live check (P1: space resolution under a scoped token, key case,
  personal-space CQL) runs this week, before the test token is revoked around 2026-11-29. It is
  a precondition of the step-A build, not a release step.
- House rules: functional core / imperative shell, immutable data, injected clocks, property
  tests, one-way module dependencies, no new runtime dependency, no content in refusals, receipts
  or logs (rule 6). Agent-facing text never shows a personal space key (it can carry an account
  ID); it says "a personal space".
- Off by default: a profile without a policy and without an anchor behaves byte-identically to
  today (rule 2).

## 5. Design fingerprint

| Aspect | Value |
|---|---|
| Purpose & users | Keep wiki content outside a declared space scope out of the model context; record and cap what enters it. Users: the person who configures a profile (CLI), the person in the chat (reads relayed refusals), the agent (reads instructions, refusals, receipts), the incident scoper (`log`). |
| Stack | TypeScript, zod 4, vitest 4, fast-check 4, esbuild. Step 0: `@modelcontextprotocol/sdk` ^1.32, Node ≥ 18. Steps A/B: `@modelcontextprotocol/server` 2.4.x, Node ≥ 20 (both from 8.0.0). CLI flags via `node:util` `parseArgs`; no CLI argument library. |
| Deployment model | Local stdio process per MCP client session, started by the client; one profile per process. CLI is a separate one-shot process on the same machine and user. |
| Data classification | Wiki content: up to the tenant's highest level (placeholder `secret`). Policy file: `internal` (space keys, settings). Read log: `confidential`, personal data about the operator (who read which content ID when; no titles or bodies); never transmitted. Credentials stay in the OS keychain; the policy anchor is a separate, non-secret keychain item (canonical scope, enforced flag, budget). Personal space keys (`~…`) can contain account IDs. |
| Scale | One user; tens to low thousands of tool calls per session; `read_spaces` ≤ 100 entries (`src/server/config.ts:19`); tenant space list up to a few thousand. |
| Async topology | Single-threaded event loop per process. Gate state (policy snapshot, budget ledger, log fd) is process-local; check-and-commit of the budget is synchronous. No watchers and no background timers: one `lstat` per tool call; two bounded waits (keychain read timeout, one 75 ms re-read after a torn save). |
| External deps | Confluence Cloud REST v2 (`/pages`, `/blogposts`, `/spaces`, comments) in site or gateway mode (decision 14); v1 attachment metadata where already used. Local fs: `~/.config/epimethian-mcp/profiles.json` (+ `.bak`, `.lock`), `~/.epimethian/logs/`. OS keychain (`security`, `secret-tool`). |

## 6. Approach

The existing `registerTool` shim (`src/server/index.ts:1169-1187`) is edited in place to wrap
every handler with the gate; registration throws for a tool without a declared spec. Each
tool's spec is one row of `GATE_SPECS`, typed `satisfies Record<KnownTool, GateSpec>` and looked
up with `Object.hasOwn`; specs read arguments only through combinators, so a test can compare
the argument names against the emitted JSON schema. Before the handler runs, the shell resolves
the target's space from the arguments, canonicalising every space key through the tenant, and
calls the pure `decideRead`, an exhaustive switch whose fall-through denies; a refused call
fetches no body, writes no file, counts nothing. Four listing tools and the two title tools
attach a symbol-keyed release manifest built from response space ids, which the wrapper
post-checks; a missing or out-of-scope manifest withholds the whole result. The policy comes
from one three-state registry loader, read once in `main()` and re-projected when one `lstat`
per call shows the file changed; an unreadable registry starts recovery mode at startup (for
enforcing profiles) and denies mid-session. A keychain anchor, set by the CLI if and only if the
written policy is on, holds the canonical scope, enforced flag and budget; when the file
disagrees with it, the gate enforces the intersection until a person re-anchors at a terminal.
Step B adds a rolling-window distinct-page budget reserved synchronously in the pre phase, a
receipt line outside the untrusted fence, and a capped JSONL read log on the mutation log's
helpers. When the read scope is enforced, writes to a space outside it are refused as well
(D15).

## 7. Files

| File | Content |
|---|---|
| [00-overview.md](00-overview.md) | This file |
| [01-architecture.md](01-architecture.md) | Components, dependency direction, request flow, `index.ts` hunk list, 8.0.0 interplay |
| [02-interfaces.md](02-interfaces.md) | Types and signatures, `GATE_SPECS`, refusal/receipt templates, instructions, CLI synopses and transcripts |
| [03-data-and-flows.md](03-data-and-flows.md) | Settings schema, read-log schema, files, reload, anchor rules, fail directions, flows per tool class, budget semantics |
| [04-decisions.md](04-decisions.md) | Design decisions D1–D37 with alternatives |
| [05-risks-and-open-questions.md](05-risks-and-open-questions.md) | Risks, assumptions, open questions, review items not adopted, rollback |
| [06-deliverables.md](06-deliverables.md) | Deliverables per step with acceptance criteria and tests, including docs |
