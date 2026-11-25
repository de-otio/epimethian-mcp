# 5. Risks, assumptions, open questions, rollback

Status: design, reviewed 2026-11-25. Not built.

## 1. Risks

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| R1 | One metadata GET per distinct page per 5 minutes on a cache miss (100–300 ms) | Certain / first read of a page | Content cache seeded by listings and handlers; batched `contents`; negative cache; per-process space caches; no extra call when the policy is off; `extraGets` in `session_end` |
| R2 | TOCTOU inside the 5-min content→space cache: a page moved out of scope stays readable until its entry expires | Rare / one page | Same bound as the write allowlist today; handlers that hold the response `spaceId` attach an optional manifest item that the release check compares; documented in `06-limitations.md` |
| R3 | A listing or title-tool handler bug withholds the whole result | Low / annoying | Manifest post-check fails closed by design; behavioural matrix tests every manifest tool |
| R4 | D15 refuses writes in spaces outside the read scope; profiles with `spaces` wider than `read_spaces` break | Medium for those profiles | Separate "Changed" entry; `policy` shows the effective write set; the refusal names the fix |
| R5 | A hand edit of the registry during a CLI write | Rare / one edit re-applied or the command refuses | Lock serialises CLI writers; pre-rename `lstat` re-applies up to three times (D12) |
| R6 | A same-user agent with file or keychain access edits the policy, the anchor or the logs; hot reload removes the restart speed bump | Possible / tamper-evident only | Threat model stated (accidents); file edits cannot widen past the anchor; CLI edits logged with old and new fingerprint; "changed outside the CLI" flagged; `policy allow` needs a terminal (speed bump, defeated by `script`/`expect`) |
| R7 | An edit that preserves inode, size and both nanosecond times is not detected | Rare | Accepted; the CLI always changes the inode and `utimes` after the anchor write |
| R8 | A policy change between the wrapper's `refresh()` and a handler's `current()` makes the handler's narrowing newer than the gate's decision | Rare / both valid | Each narrows; the release post-check uses the wrapper's snapshot |
| R9 | A tool registered without a spec or `inputSchema` stops the server at startup | Caught in CI | Mapped type (compile), registration throw, `tool-surface.test.ts` boot |
| R10 | A scoped token without space read makes every content read `POLICY_SPACE_UNRESOLVED` in gateway mode | Possible / feature unusable there | P1 live check before the build; setup's empty-list text names the space-read scope |
| R11 | Keys outside the new charset, symlinked, group-writable or foreign-owned registries, `read_spaces_enforced` without `read_spaces`: configurations that worked now stop the server | Low / visible | Charset applies only to enforcing profiles (D28); "Fixed" and "Changed" entries name each case and its fix command; recovery text names the fix |
| R12 | Invalid gate settings on an enforcing profile start recovery mode instead of disabling search | Low / stricter | "Changed" entry; recovery text names the setting path and `policy setup`, which proceeds over them |
| R13 | Budget is process-local; a restart clears it | Certain / cap per process | Documented; threat model is accidents |
| R14 | Read-log volume on a heavy user | Low / disk | 10 MB cap per file, 90-day sweep, `log --purge-older-than` (D29) |
| R15 | Step A lands after 8.0.0, so the read boundary reaches users about two months later; until then `read_spaces_enforced` keeps its 7.6.0 meaning | Certain / delay | D22; README and CHANGELOG of 7.6.1 and 8.0.0 keep saying it is not a read boundary |
| R16 | A refusal names the canonical space key of content outside the scope, revealing where it lives | Certain / identifier only | Rule 6 allows identifiers; the key is needed for `policy allow`; never an agent-supplied string; never a personal key (D37) |
| R17 | `~*` cannot be expressed in CQL; personal spaces are not searched or search is refused | Depends on Q5 | Never unscoped (D24); the result says personal spaces were not searched |
| R18 | One `lstat` per tool call in profile mode, even with no policy | Certain / microseconds | Accepted; none in env-var mode |
| R19 | Personal space keys in local logs and `policy` output can contain an account ID | Certain | Agent-facing text says "a personal space" (D37); logs are owner-only and never transmitted; stated in `05-observability.md` |
| R20 | Descriptions are fixed at registration; the five that name spaces go stale after a mid-session change | Certain after a change | Change note supersedes; agent guide says so |
| R21 | A legitimate hand edit that widens the scope is not applied: the anchor keeps the intersection | Likely for people who edit the file / annoying | Change note, instructions line and `policy` say why and name `policy setup`; README says to use the CLI |
| R22 | A stalled keychain read costs up to 2,000 ms at startup and on each detected file change | Rare / latency | Timeout; at most one read per change; last anchor kept on error |
| R23 | The first access to the new keychain item prompts on macOS, or a locked keychain makes the anchor unreadable | Possible / denies while the file says on | `anchor-unreadable` names the fix; retried at most every 5 s; the item is written and read by the same `security` binary |
| R24 | A crashed CLI writer leaves a lock that blocks other CLI writers | Rare / up to 60 s | Stale after 60 s with a dead pid; the message says to try again |
| R25 | Step-A deny lines past 1,000 per process are not written | Rare (runaway loop) / record gap | One suppression line marks the gap; step B's read log has its own cap and gap reporting |
| R26 | A session that reaches 10 MB of read log stops recording reads | Rare / record gap | `capped` record, receipt suffix, `log` reports the gap (D29) |
| R27 | `lookup_user` returns tenant-wide contact data outside the space scope | Certain until step E | Logged from B; documented as outside the scope (D27) |
| R28 | Space caches have no TTL; Cloud allows a space key to change | Rare / old key until restart | Accepted and documented; the content cache stays 5 min |
| R29 | The keychain tool's "not found" result is misread, so an error counts as `absent` and an anchored policy switches off | Low / policy lost silently | Assumption 9 verified on macOS and Linux in A-T12; anything other than the documented not-found result is `error` |
| R30 | An invalid budget or entry on a non-enforcing profile is ignored | Low / fails open for that setting | Warned on stderr and in `policy` (D28) |

### Data-loss assessment

| Path | Before | After |
|---|---|---|
| CLI write on an unreadable registry | Rebuilt from `{profiles: []}`, overwrote every profile's settings (`src/shared/profiles.ts:275-315`) | Refused before any temp file; byte-equality and property tests |
| Crash during a CLI write | `writeFile` + `rename` without fsync: possible empty or torn file after power loss | fsync file and directory (best effort); `.bak` of the version before the last CLI change; stale temps swept |
| Unknown top-level keys in the registry | Dropped on the next write (only `profiles`, `settings` kept, `:191-194`) | Preserved |
| CLI write with the registry absent | Created from `{profiles: []}` | Same; `.bak` (possibly the only copy of other profiles) is not touched |
| `setup` on an unreadable registry | Keychain written (`src/cli/setup.ts:288`, `:491`), then the registry overwritten | Preflight refuses before the keychain write |
| `profiles --remove` on an unreadable registry | Keychain entry deleted (`src/cli/profiles.ts:178`), then the registry overwritten | Preflight refuses before the delete; the anchor item is cleared with the credentials |
| Keychain seal re-save | Drops fields `readFromKeychain` does not copy | The anchor is a separate item; the re-save cannot touch it |
| `policy setup` / `policy allow` | – | `writeWithAnchor` on a readable file only, under the lock; other profiles and unrelated keys kept; validated before writing; anchor written after a read-back |
| Concurrent CLI writers | Lost update possible | Serialised by the lock |
| Wiki content | – | The gate only withholds; write refusals happen before any request other than GET |
| Local files | – | `download_attachment` refused before any file is created, also with `overwrite` |
| Logs | – | Read-log sweep deletes only `reads-*` older than 90 days and ignores `ENOENT`; mutation logs untouched (tested); `log --purge-older-than` needs a terminal |

## 2. Assumptions

1. The design covers steps 0, A and B to build grade; steps C–G appear only as extension points.
2. The design lives in `doc/design/policy-gate/` (project convention: designs in `doc/design/`),
   not in a top-level `design/` directory.
3. Threat model: accidents, not a deliberate agent (analysis 03, 05).
4. `KNOWN_TOOLS` has 41 names at 7.6.0 (`src/server/tool-allowlist.ts`); `setup_profile` is
   registered only by the recovery server, outside the shim.
5. SDK 2.x keeps `registerTool(name, config, handler)` with a per-request `ctx`; the 8.0.0 plan
   keeps the wrapper semantics (plan `:449`).
6. v2 page and blog-post metadata reads return `spaceId` under a scoped token, `GET
   /spaces/{id}` returns `key` and `type`, `/spaces?keys=K` returns the space for an exact key,
   and `GET /pages?id=…` accepts a list of ids (all verified by P1 before the build).
7. One server process per client session; process-local state is session state.
8. MCP clients show tool results, not stderr; every signal the person needs is in a tool result,
   `policy`, `log` or `audit.log`.
9. "Not found" is distinguishable from other keychain failures: macOS `security
   find-generic-password` exits 44; Linux `secret-tool lookup` exits 1 with empty output
   (verified locally in A-T12 before `readPolicyAnchor` is merged).

## 3. Open questions

Resolved on 2026-11-25 and removed: Q1 (D15), Q4 (D22), Q7 (D29), Q11 (D18); Q13 is decided
(row below, kept for the version numbers); and the review's
questions on the anchor (D23, D26), `lookup_user` (D27), recovery for non-enforcing profiles
(D28), Windows fsync (D30), Node engines (D31), write-only `policy allow` (D32) and listing IDs
(D33).

| # | Question | Unblocks | Proposed answer |
|---|---|---|---|
| Q2 | Are Confluence space keys case-sensitive in v2 lookups (`/spaces?keys=`, `space_key` arguments, CQL `space in`)? P1, site and gateway | `findSpaceByKey` behaviour and the case hint text; `policy --check` suggestions | Keep D6 either way; the check decides only the hint |
| Q3 | Budget default values when `policy setup` offers one; warning threshold | Setup prompt text, README and instruction examples | Suggest 100 pages per 60 minutes; warn at 20 % left |
| Q5 | Does CQL `space.type = "personal"` select personal spaces in both API modes? | `cqlScopeOf(…, personalCql)`; whether `~*` scopes can search | Verify in P1; if not, omit the disjunct and refuse personal-only searches (D24) |
| Q6 | Should `setup` offer to add the registry to an agent sandbox's write-deny list (analysis 05)? | A `setup`/`policy setup` step and doc text | Defer to step C; mention in docs |
| Q8 | Record write-class gate refusals (D15) in a JSONL log? | Mutation-log record kind or read-log `class: "write"` | Step A: `audit.log` line (D25); JSONL deferred |
| Q9 | May `policy allow` add a personal space key (`~…`) directly? | `findSpaceByKey` scope, picker | Yes, validated like any key; refusals never name it (D37) |
| Q10 | Where do `instructions` go in the 2026 protocol era (8.0.0 S0 item 4), and are they shown to the agent? | Whether the five key-naming description suffixes suffice | Known by the time A is built (8.0.0 S0); keep the five suffixes regardless |
| Q12 | New scoped test token for P1: the temporary one is due for revocation around 2026-11-29 | Running P1 | Run P1 this week; otherwise create a new short-lived read-only token |
| Q13 | Version number of the step-A release (8.1.0 holds C6 and W-META-8.1 in the 8.0.0 plan) | CHANGELOG headings, rollback pins | **Decided 2026-11-25** (`plans/policy-gate.md` §1): the first minor after 8.1.0, provisionally 8.2.0; step B the minor after that; the number is fixed at the step-A checkpoint |

## 4. Review items considered, not adopted

| Item | Reason |
|---|---|
| X1 alternative (cost): defer the anchor to step C | Resolution 1 keeps it: without it a deleted or edited registry switches the boundary off silently |
| X2: map an anchor read failure to `io-error` | Adopted with its own kind `anchor-unreadable`, so the fix line names the keychain instead of the file |
| S1: deny an id-less `count` call "in every mode" without a budget | Adopted only while a budget is set; without a budget nothing is counted, and enforced mode already denies an unresolvable target |
| S14: a `requireTerminal` stub in the PG-C7 contract | Adopted in the plan, not the design: W-CONTRACT-A carries the `cli/terminal.ts` stub so lanes can build against it. No design change needed |
| S18: an extra-GET counter in `status` | `status` is a separate process and cannot see a server's counters; the count goes into the `session_end` record and `log` instead |
| S30: drop the enforce prompt from the first run only | Dropped from every run: `o` in the picker is the explicit way to turn the policy off, so a second prompt adds nothing |
| S34 option: `RegisteredTool.update()` after a policy change | Clients handle `list_changed` differently; the change note already reaches the session; revisit with 8.1.0 |
| S37: plan parallelism (one Opus agent plus `security-reviewer` for step 0; lane folding; models) | A plan matter, not a design one: for `plans/policy-gate.md` |
| Nit: skip space resolution for writes if D15 is rejected | Moot: D15 is confirmed |
| Nit: TTL on the space caches | Accepted and documented (R28): a space key change is rare and a restart clears it; the content cache keeps its 5 min |

## 5. Rollback

| Step | Escape hatch without a release | Release rollback |
|---|---|---|
| 0 | Fix the file (the recovery text names the command). `.bak` holds the version before the last CLI change; run `policy --check` (from A) or compare it by hand before restoring it | Pin 7.6.0 (`npx -y @de-otio/epimethian-mcp@7.6.0` in the MCP config). 7.6.0 again reads an unreadable registry as empty, its CLI overwrites such a file, and it never updates `.bak` or the lock |
| A | `policy setup` → `o` turns the policy off: removes `read_spaces_enforced` and `policy`, keeps `read_spaces` as a search default, clears the anchor. Applies on the next call | Pin the last 8.0.x. It enforces no read boundary (`read_spaces_enforced` is search-only again), ignores the anchor item and the `policy` block, and treats `~*`/`!` entries as literal keys in search scoping (no match), so turn the policy off or untick them before pinning. Its CLI writers bypass the lock and the anchor: an edit of policy keys with 8.0.x reads as a mismatch after upgrading again, until `policy setup` runs. Step 0's fail-closed read stays (8.0.x includes 7.6.1) |
| B | Remove `policy.read_budget` with `policy setup`; the read log cannot be turned off (D10) but can be purged with `log --purge-older-than` | Pin the last release before B. Step A already ships the full `policy` block schema (including `read_budget`, parsed and unused) and the anchor's budget field, so a downgrade from B to A does not enter recovery mode. Read-log files stay on disk; A does not sweep `reads-*` |
