# 10. Additive tools skip content-safety guards

[← back to index](README.md)

`src/server/safe-write.ts:844-856`:

```ts
if (scope !== "additive" && currentBody !== undefined) {
  enforceContentSafetyGuards({ … });
}
```

For `scope: "additive"` (used by `prepend_to_page` / `append_to_page`),
the guards are skipped. The rationale is reasonable: an additive op
cannot shrink the body, so shrinkage / empty / content-floor / macro-
and table-loss are structurally impossible. `assertGrowth` +
`assertPostTransformBody` still run in `safeSubmitPage`.

The residual risks are:
- A malicious separator or content could push the page past its
  practical-render size. The 2 MB cap
  (`src/server/index.ts:369`) guards against server-side pathology but
  does not guarantee Confluence renders gracefully.
- Repeated append operations can bloat a page to the 2 MB cap one call
  at a time with zero friction — a slower-burn version of
  [finding 1](01-mass-creation.md). Each individual call passes every
  guard.

## Possible mitigation

- Add a soft growth check: warn (don't block) when an additive op
  pushes the body past 500 KB.
- Track cumulative additive writes per page in-session; suggest a
  full-page-replace path when the same page has been appended to
  more than N times.

Low priority; this is the least-risky of the write paths.
