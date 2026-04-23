# Design: Agent Safety Hardening

**Status:** design (pre-implementation)
**Date:** 2026-04-23
**Source investigations:**
  [`doc/design/investigations/investigate-agent-loop-and-mass-damage/`](../doc/design/investigations/investigate-agent-loop-and-mass-damage/README.md)
  and
  [`doc/design/investigations/investigate-prompt-injection-hardening/`](../doc/design/investigations/investigate-prompt-injection-hardening/README.md)
**Implementation plan:** [`agent-safety-hardening-implementation.md`](agent-safety-hardening-implementation.md)

---

## Goal

Raise the floor on what a misaligned, hijacked, or accidentally-looping
agent can do to a Confluence tenant through Epimethian. The existing
per-call safety pipeline (see
[`doc/design/security/03-write-safety.md`](../doc/design/security/03-write-safety.md))
is strong but orthogonal to two real concerns:

1. **Rate / volume.** Guards fire per call; a loop of 1 000 individually-
   valid calls gets through with zero friction.
2. **Provenance.** Guards and fences defend the agent *behaviourally*
   against tenant-authored injection payloads, but the server has no
   structural way to tell "this flag came from the user" from "this
   flag came from a poisoned page".

This design consolidates the recommendations from the two
investigations into a single, themed set of workstreams that can be
implemented in parallel.

## Non-goals

- **Model alignment tuning** or client-side hardening. Not our layer.
- **ML-based injection classification.** Regex signal-scanning is
  sufficient; ML has too-high false-positive cost for a content-editing
  tool.
- **Cross-tenant threat protection.** Already covered by the cloudId
  seal.
- **Supply-chain hardening.** Already covered by
  [`doc/design/security/06-limitations.md`](../doc/design/security/06-limitations.md) §14.
- **Signed / cryptographic fence.** The content-floor guard plus
  elicitation achieve the same defensive property at lower complexity.
- **OAuth scope granularity.** Blocked on Atlassian roadmap; capability
  scoping (WS6) is the interim substitute.

## What this design changes (at a glance)

| Workstream | Theme                              | Reduces blast radius? | Reduces injection surface?    |
| ---------- | ---------------------------------- | --------------------- | ----------------------------- |
| WS1        | Per-call guard tightening          | Modest                | —                             |
| WS2        | Destructive-op version gating      | Yes                   | —                             |
| WS3        | Forensics-by-default               | No                    | Indirect (detection)          |
| WS4        | Content-layer injection hardening  | No                    | Yes                           |
| WS5        | Call-layer injection hardening     | Yes (elicitation)     | Yes                           |
| WS6        | Capability scoping                 | Yes                   | Yes                           |

---

## Workstreams

### WS1 — Per-call guard tightening

Small surgical changes to the existing guard pipeline. Each item is
independent; each lands in its own PR.

1. **Byte-identical update short-circuit.** `safeSubmitPage` compares
   the normalised `pageBody` (post strip-attribution, post
   markdown→storage) against `previousBody`. If byte-identical, return
   the existing page without writing. Kills the no-op-rewrite version-
   churn loop
   ([mass-damage 04](../doc/design/investigations/investigate-agent-loop-and-mass-damage/04-update-version-churn.md)).
2. **`set_page_status` dedup.** Handler calls `getContentState` first;
   if `(name, color)` match, return success without writing. Kills the
   most egregious version-bloat vector
   ([mass-damage 03](../doc/design/investigations/investigate-agent-loop-and-mass-damage/03-status-version-churn.md)).
3. **Input body-size cap.** Top-level `MAX_INPUT_BODY = 2_000_000`
   constant checked at the entry of `safePrepareBody`. Matches the
   existing cap in `concatPageContent`. Prevents self-DOS on 100 MB
   markdown inputs
   ([mass-damage 06](../doc/design/investigations/investigate-agent-loop-and-mass-damage/06-unbounded-body-size.md)).
4. **Section-not-found is a tool error.** `update_page_section`'s two
   `toolResult(…)` fallbacks for missing sections become `toolError`.
   Surfaces the failure via the MCP `isError` flag so agents don't
   silently treat typos as success
   ([mass-damage 09](../doc/design/investigations/investigate-agent-loop-and-mass-damage/09-section-not-found-non-error.md)).
5. **Tighten `looksLikeMarkdown`.** Drop inline-pattern signals
   (`**bold**`, `[text](url)`) from the strong-markdown set; require
   line-anchored structural signals (headings, fenced code, tables, list
   markers) for the markdown verdict. Closes the "plain XHTML with inline
   link misdetected as markdown" corruption vector
   ([mass-damage 08](../doc/design/investigations/investigate-agent-loop-and-mass-damage/08-format-misdetection.md)).

### WS2 — Destructive-op version gating

One concrete change with a larger schema impact:

6. **Require `version` on `delete_page`.** Mirrors `update_page`'s
   optimistic-concurrency check. "Delete only if the page is still at
   version N." Breaking change; needs a version bump and a changelog
   entry. Defends the stale-context replay case that is common in
   long-running agent workflows
   ([mass-damage 02](../doc/design/investigations/investigate-agent-loop-and-mass-damage/02-mass-deletion.md)).

Deferred within this workstream (design work only, no implementation
yet): child-count preview on delete, trash vs hard-delete semantics.

### WS3 — Forensics-by-default

7. **Mutation log on by default.** Flip `EPIMETHIAN_MUTATION_LOG` to
   default-on; `"false"` is an explicit opt-out. The log is already
   metadata-only (lengths + hashes + flag values, no bodies, no titles
   — see
   [`03-write-safety.md`](../doc/design/security/03-write-safety.md)).
   Appears in both investigations'
   recommendations
   ([mass-damage 07](../doc/design/investigations/investigate-agent-loop-and-mass-damage/07-mutation-log-opt-in.md),
   [injection 09](../doc/design/investigations/investigate-prompt-injection-hardening/09-audit-by-default.md)).
8. **Stderr banner on destructive flags.** One-line, grep-friendly
   stderr emission when:
   - `replace_body=true` on any write,
   - any `confirm_*` flag actually suppressed a guard,
   - an `injection-signals=…` attribute was emitted on a read (see WS4),
   - a `CONTENT_FLOOR_BREACHED` rejection fires,
   - a gated-op elicitation is denied (see WS5).
9. **Confluence-side version-message marker.** Append a machine-readable
   suffix to `version.message` on writes that set destructive flags or
   that fired injection signals on preceding reads. Visible in
   Confluence's native history view with no dependency on whether the
   user enabled the local log.

### WS4 — Content-layer injection hardening

Defences applied as tenant content flows *through* Epimethian to the
agent. Independent of call-layer changes.

10. **Unicode sanitisation inside `fenceUntrusted`.** Pre-escape
    step that normalises content to NFKC and strips tag characters
    (U+E0000–U+E007F), bidi controls, zero-width joiners, C0/C1
    control characters (keeping `\n` and `\t`). Closes Unicode
    fence-spoofing and tag-steganography attacks
    ([injection 04](../doc/design/investigations/investigate-prompt-injection-hardening/04-unicode-sanitisation.md)).
11. **Signal scanning + fence attribute.** Scan (sanitised) fenced
    content for:
    - Epimethian tool names as whole words,
    - destructive flag names (`confirm_shrinkage`,
      `confirm_structure_loss`, `confirm_deletions`, `replace_body`),
    - instruction-style framing (`IGNORE ABOVE`, `NEW INSTRUCTIONS`,
      `SYSTEM:`, `<|im_start|>`, …),
    - Epimethian's own fence strings (`CONFLUENCE_UNTRUSTED`,
      `END_CONFLUENCE_UNTRUSTED`),
    - the per-session canary (see 12).
    When any signal fires, append `injection-signals=<comma-list>` to
    the fence header and emit a stderr line + mutation-log entry
    ([injection 05](../doc/design/investigations/investigate-prompt-injection-hardening/05-content-signal-scanning.md)).
12. **Per-session canary + write-path echo detector.** At server
    startup, generate `EPI-${uuid}` and embed it inside every fence
    as a trailing `<!-- canary:… -->` line. In `safePrepareBody`,
    reject writes whose `body` contains the canary or the
    `<<<CONFLUENCE_UNTRUSTED` / `<<<END_CONFLUENCE_UNTRUSTED>>>`
    markers. Error code: `WRITE_CONTAINS_UNTRUSTED_FENCE`. Kills the
    round-trip echo attack
    ([injection 06](../doc/design/investigations/investigate-prompt-injection-hardening/06-cross-call-payload-propagation.md)
    §6.2-6.3).
13. **Default `max_length` on `get_page` / `get_page_by_title`.**
    `DEFAULT_MAX_READ_BODY = 50_000` chars when the caller doesn't
    pass `max_length`. Response suffix outside the fence:
    `[truncated: full body is N chars; pass max_length=N to see
    more]`. Semver-minor breaking. Caps context-saturation payloads
    ([injection 06](../doc/design/investigations/investigate-prompt-injection-hardening/06-cross-call-payload-propagation.md)
    §6.1).

### WS5 — Call-layer injection hardening

Defences applied *at* the tool-call boundary — the value the agent
supplies becomes subject to provenance or human approval.

14. **`source` parameter on destructive flags.** Optional enum
    parameter on `update_page`, `update_page_section`, `revert_page`,
    `delete_page`, `create_page`, `create_comment`:

    ```ts
    source: "user_request" | "file_or_cli_input" | "chained_tool_output"
    ```

    Required whenever any `confirm_*`, `replace_body`, or
    `target_version` flag is non-default (or `source` is explicitly
    set). `chained_tool_output` paired with any destructive flag is
    **rejected unconditionally** — tool output is tenant-authored by
    definition. Omitted `source` is inferred to `user_request` and
    logged as "source inferred". Strict mode
    (`EPIMETHIAN_REQUIRE_SOURCE=true`) makes omission an error
    ([injection 03](../doc/design/investigations/investigate-prompt-injection-hardening/03-flag-provenance.md)).
15. **Elicitation on gated operations (human-in-the-loop).**
    Server-initiated `elicit()` before the Confluence call on any
    tool call matching the gate table below. Response shape
    `{ confirm: boolean, note?: string }`; `false` or timeout → reject
    with `USER_DENIED_GATED_OPERATION`. Capability detection via
    MCP `initialize.capabilities.elicitation`; unsupported clients
    default to **refuse**, opt-out via
    `EPIMETHIAN_ALLOW_UNGATED_WRITES=true`
    ([injection 07](../doc/design/investigations/investigate-prompt-injection-hardening/07-human-in-the-loop.md)).

    Initial gate table:

    | Tool                   | Gate condition                                           |
    | ---------------------- | -------------------------------------------------------- |
    | `delete_page`          | Always                                                   |
    | `update_page`          | `replace_body=true` OR any `confirm_*=true`              |
    | `update_page_section`  | `confirm_deletions=true`                                 |
    | `revert_page`          | Always                                                   |
    | `delete_comment`       | > 3 calls in last 60 s                                   |
    | `remove_label`         | Targeting `epimethian-*` (system labels)                 |
    | `create_page`          | > 5 calls in last 60 s                                   |

### WS6 — Capability scoping

Bound the set of tools / spaces a given profile can touch.

16. **Session write budget.** In-process counter per write-class
    operation; reset on restart. Default: 25 writes per hour, 100
    per session. Exceeding the budget emits a structured error
    (`WRITE_BUDGET_EXCEEDED`) that tells the agent to pause. Raised
    via `EPIMETHIAN_WRITE_BUDGET_HOURLY`,
    `EPIMETHIAN_WRITE_BUDGET_SESSION` env vars. Complements the
    bulk-threshold elicitation (WS5 gate table) — budget is a
    background cap; elicitation is an interactive prompt
    ([mass-damage 01, 02, 05](../doc/design/investigations/investigate-agent-loop-and-mass-damage/README.md)).
17. **Per-tool profile allowlist.** Extend the profile registry with
    `allowed_tools: string[]` or `denied_tools: string[]` (mutually
    exclusive). Unknown tool names rejected at startup. The existing
    `readOnly: true` becomes syntactic sugar for a pre-defined
    allowlist. CLI: `epimethian-mcp profiles --deny-tools
    delete_page,revert_page <profile>`
    ([injection 08](../doc/design/investigations/investigate-prompt-injection-hardening/08-capability-scoping.md)
    §8.1).
18. **Per-space profile allowlist.** Extend with `spaces: string[]`;
    every tool with a `space_key` argument (or whose `page_id`
    resolves to a space) is gated. Cache page→space mapping in
    `pageCache` to avoid double-fetch
    ([injection 08](../doc/design/investigations/investigate-prompt-injection-hardening/08-capability-scoping.md)
    §8.2).

Deferred within this workstream: parent-subtree allowlist,
label-based allowlist. Ship behind a concrete user request.

---

## Design decisions requiring user review

1. **Default `max_length=50 000` on `get_page`.** Breaking change.
   Users relying on full-body reads must pass `max_length=0`
   (sentinel for "no limit") or a large explicit value. Worth the
   context-saturation protection. **Proposed: ship in a
   semver-minor bump with a prominent changelog entry.**

2. **Strict-source default.** Should `EPIMETHIAN_REQUIRE_SOURCE` be
   the default for new installs? Existing installs? **Proposed:
   default false; new interactive `setup` asks the user which mode
   to configure.**

3. **Elicitation unsupported-client posture.** Default refuse vs.
   default allow on clients that don't support the MCP elicitation
   capability. **Proposed: default refuse.** Non-interactive CI
   usage must opt out explicitly via
   `EPIMETHIAN_ALLOW_UNGATED_WRITES=true` — the flag name is
   deliberately unflattering.

4. **Write-budget defaults.** 25/hour + 100/session is a guess;
   true values require telemetry. **Proposed: start with these
   numbers and tune after the first month of user feedback.**

5. **Version-required on `delete_page`.** Breaking change to tool
   signature. **Proposed: ship with
   `EPIMETHIAN_LEGACY_DELETE_WITHOUT_VERSION=true` opt-out for
   one minor release, then remove.**

6. **Scope of `source` parameter.** Six tools is the proposed
   minimum; should `add_attachment`, `set_page_status`,
   `add_label` also carry the source field? **Proposed: no;
   scope the provenance field to tools whose primary effect is
   body mutation or page deletion.**

## Acceptance criteria

Design is complete when:
- [x] Each proposed change has a referenced investigation item.
- [x] Each workstream identifies its independent-ship boundary (PR
      scope).
- [x] Breaking changes are flagged.
- [x] Open questions are listed in the "requiring user review"
      section above.
- [ ] User approval obtained on the six questions above before the
      implementation plan kicks off.

Implementation is complete when the acceptance criteria in
[`agent-safety-hardening-implementation.md`](agent-safety-hardening-implementation.md)
are met.

## Out of scope (recap)

Captured in the "Non-goals" section at the top and in each
investigation's out-of-scope sections. The high-impact deferred
items:

- **Parent-subtree capability scoping** — ship if a user asks.
- **OAuth scope integration** — blocked on Atlassian.
- **External audit-log sink** (syslog / SIEM forwarding) — ship if a
  user asks.
- **Tamper-evident mutation log** — would require cryptographic
  chaining; current `O_APPEND + O_EXCL + O_NOFOLLOW` + mode-0600 is
  sufficient for single-user forensics.
- **Parameter taint tracking across tool calls** — requires session
  state and introduces significant protocol complexity; `source`
  parameter (WS5 #14) is the lightweight approximation.
