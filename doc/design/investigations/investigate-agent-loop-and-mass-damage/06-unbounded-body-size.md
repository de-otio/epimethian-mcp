# 6. Unbounded body size on `create_page` / `update_page`

[← back to index](README.md)

`src/server/index.ts:396-464` (`create_page`) and `:569-697`
(`update_page`) accept arbitrary-length strings for `body`.
`concatPageContent` (`:326-393`) has an explicit 2 MB combined-size
check before submission. `create_page` / `update_page` do not.

Practical impact:
- A 100 MB markdown input passes through `markdownToStorage`
  (`src/server/converter/md-to-storage.ts`), tokenisation, and guards
  before Confluence rejects it.
- Server process memory spikes; depending on the MCP client harness,
  that may be attributable to the agent's stdio buffer, not to the
  tool.
- Not a data-loss vector — the page isn't written — but a self-inflicted
  DOS in a large-workload environment.

## Possible mitigation

Add a top-level `MAX_INPUT_BODY = 2_000_000` constant checked before
`safePrepareBody` runs. Matches the existing concat cap.
