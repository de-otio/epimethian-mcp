# 9. `update_page_section` missing-section returns as non-error

[← back to index](README.md)

`src/server/index.ts:764-822`:

```ts
const currentSectionBody = extractSectionBody(fullBody, section);
if (currentSectionBody === null) {
  return toolResult(
    `Section "${section}" not found. …`
  );
}
…
const newFullBody = replaceSection(fullBody, section, prepared.finalStorage!);
if (newFullBody === null) {
  return toolResult(
    `Section "${section}" not found. …`
  );
}
```

Both fallbacks use `toolResult` (non-error) rather than `toolError`.
An agent monitoring `isError` may treat "section not found" as success
and move on to the next step of its plan. The response text contains
the error, but the structured flag does not.

Minor data-integrity concern: if the agent is in a "make sure section X
has content Y" loop, a typo or renamed heading turns into a silent no-op
that the agent reports as "updated" to its user.

## Possible mitigation

Swap the two `toolResult(…)` calls to `toolError(new Error(…))`.
One-line change; no semantic risk.
