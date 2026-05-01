# Investigation: Agent-Loop & Mass-Damage Risks

**STATUS: 🟡 REVIEW** (risk assessment; no code changes proposed yet)

**Date:** 2026-04-23
**Scope:** `src/server/index.ts`, `src/server/safe-write.ts`,
`src/server/confluence-client.ts`,
`src/server/converter/content-safety-guards.ts`.

## Contents

1. [Mass creation (`create_page`)](01-mass-creation.md)
2. [Mass deletion (`delete_page`)](02-mass-deletion.md)
3. [Version churn via `set_page_status`](03-status-version-churn.md)
4. [Version churn via `update_page`](04-update-version-churn.md)
5. [Comment pollution](05-comment-pollution.md)
6. [Unbounded body size on `create_page` / `update_page`](06-unbounded-body-size.md)
7. [Mutation log is opt-in](07-mutation-log-opt-in.md)
8. [Format misdetection in `looksLikeMarkdown`](08-format-misdetection.md)
9. [`update_page_section` missing-section returns as non-error](09-section-not-found-non-error.md)
10. [Additive tools skip content-safety guards](10-additive-skip-guards.md)
11. [What the guards already catch](11-cross-cutting-guards.md)
12. [Recommended next steps & out of scope](12-recommendations.md)

## Problem

Confluence is a system of record. The existing write-safety pipeline is
excellent at protecting **a single page** from an accidentally-destructive
call (shrinkage, empty body, token deletion, content floor, read-only
markdown round-trip). See
[`doc/design/security/03-write-safety.md`](../../security/03-write-safety.md).

It does **not** address what happens when an agent does the wrong thing
*many times in a row, successfully*. The per-call guards are orthogonal to
the "blast radius" concern. An agent that can make 10 non-destructive
writes can also make 10,000; each one individually passes every guard.

The question this document asks: **what is the worst outcome an
intentionally- or accidentally-looping agent can inflict on a Confluence
tenant before a human notices?**

The audience is the person evaluating whether to grant Epimethian write
access to a production tenant. The answer today is "mass creation, mass
deletion, mass version churn, and mass comment pollution are all
unconstrained."

## Summary of findings

| #  | Class               | Finding                                                                     | Severity | Bounded by                                           |
| -- | ------------------- | --------------------------------------------------------------------------- | -------- | ---------------------------------------------------- |
| 1  | Mass creation       | `create_page` has no per-session / per-tenant budget                        | High     | Confluence API rate limits only                      |
| 2  | Mass deletion       | `delete_page` has no confirmation, no budget, no descendant preview         | High     | Confluence trash retention (tenant-controlled)       |
| 3  | Version churn       | `set_page_status` writes a version every call even when status is unchanged | Medium   | Description warning only (not enforced)              |
| 4  | Version churn       | Repeated `update_page` on the same page bloats version history              | Medium   | None                                                 |
| 5  | Comment pollution   | `create_comment` / `delete_comment` have no budget                          | Medium   | None                                                 |
| 6  | Input body size     | `update_page` / `create_page` accept unbounded markdown/storage bodies      | Low      | Confluence rejects eventually; local OOM possible    |
| 7  | Forensics absent    | Mutation log is opt-in (`EPIMETHIAN_MUTATION_LOG`)                          | Medium   | Confluence version history (no flag/client capture)  |
| 8  | Format misdetection | `looksLikeMarkdown` can classify storage-format input as markdown           | Medium   | Mixed-input guard (only fires when `<ac:>` present)  |
| 9  | Section splicing    | `update_page_section` failures return a non-error `toolResult`              | Low      | —                                                    |
| 10 | Concat additive     | `prepend_to_page` / `append_to_page` skip the content-safety guards         | Low      | `assertGrowth` invariant + 2 MB cap                  |

Numbered findings map 1-to-1 to the files above.

## References

- `src/server/index.ts` — tool registration, handlers.
- `src/server/safe-write.ts` — `safePrepareBody`, `safeSubmitPage`.
- `src/server/confluence-client.ts` — raw HTTP wrappers, format
  detection, sanitisation.
- `src/server/converter/content-safety-guards.ts` — the per-call
  guards.
- `src/server/mutation-log.ts` — forensic log.
- [`doc/design/security/03-write-safety.md`](../../security/03-write-safety.md) — current guard inventory.
- [`doc/design/security/06-limitations.md`](../../security/06-limitations.md) §7, §10, §13, §15.
- [`doc/data-preservation.md`](../../../data-preservation.md) — token-preservation contract.
- `plans/centralized-write-safety.md` — pipeline rationale.
