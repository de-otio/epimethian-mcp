# 12. Recommended next steps & out of scope

[← back to index](README.md)

## Recommended next steps (for review)

Ranked by expected damage-prevented-per-line-of-code:

1. **Flip mutation log default to on**
   ([finding 7](07-mutation-log-opt-in.md)). One-line change in
   `src/server/index.ts`. Zero risk, high forensic value.
2. **Dedup `set_page_status` against current state**
   ([finding 3](03-status-version-churn.md)). One GET + equality check
   in the handler. Kills the most egregious version-bloat vector.
3. **Short-circuit `update_page` when body is byte-identical**
   ([finding 4](04-update-version-churn.md)). One comparison in
   `safeSubmitPage`. Kills the no-op-rewrite loop.
4. **Promote section-not-found to `toolError`**
   ([finding 9](09-section-not-found-non-error.md)). One-line change in
   two places.
5. **Require `version` on `delete_page`**
   ([finding 2](02-mass-deletion.md)). Breaking change to tool
   signature; but halves the blast radius of stale-context loops.
6. **Body-size cap on `update_page` / `create_page`**
   ([finding 6](06-unbounded-body-size.md)). Five-line addition;
   matches existing concat behaviour.
7. **Tighten `looksLikeMarkdown`**
   ([finding 8](08-format-misdetection.md)). Moderate refactor;
   requires new test coverage for the inline-pattern corruption case.
8. **Session write budget**
   (findings [1](01-mass-creation.md), [2](02-mass-deletion.md),
   [5](05-comment-pollution.md)). Architectural; probably belongs
   behind an env var rather than a default. Deserves its own
   investigation.

Findings [8](08-format-misdetection.md) and the session budget are the
only items that need real design work. The rest are small, surgical
changes that narrow the blast radius without altering the pipeline's
shape.

## Out of scope for this investigation

- **Prompt-injection hardening** beyond what the fencing convention
  already does. That is
  `plans/untrusted-content-fence-spec.md` /
  [`doc/design/security/06-limitations.md`](../../security/06-limitations.md)
  §15 territory.
- **Supply-chain hardening** of the npm package itself
  ([`06-limitations.md`](../../security/06-limitations.md) §14).
- **Data Center parity**
  ([`06-limitations.md`](../../security/06-limitations.md) §5).
- **Attachment content scanning** — uploads are file-bytes and the
  `add_attachment` path trusts the caller.
- **Multi-tenant credential isolation** — already addressed by the
  cloudId seal mechanism and
  [`doc/design/security/02-multi-tenant.md`](../../security/02-multi-tenant.md).
