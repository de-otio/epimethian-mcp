# Error Handling

Every tool handler is wrapped in a try/catch block. Errors are returned as structured MCP responses with `isError: true` rather than propagating as unhandled exceptions. This ensures the LLM client always receives a clean error message.

```typescript
// Pattern used in all tool handlers
try {
  // ... tool logic ...
  return { content: [{ type: "text", text: result }] };
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}
```

API responses are validated at runtime using Zod schemas (`PageSchema`, `SpacesResultSchema`, etc.) in `confluence-client.ts`. A malformed API response will produce a Zod parse error returned to the client via the same `isError: true` pattern.

| Error | HTTP Status | Behavior |
|-------|-------------|----------|
| Bad input | N/A | Zod input validation error (from MCP SDK) |
| Malformed API response | N/A | Zod parse error returned as `isError: true` |
| Confluence 400 | 400 | `isError: true` with API message |
| Auth invalid | 401 | `isError: true` with API message |
| Forbidden | 403 | `isError: true` with API message |
| Not found | 404 | `isError: true` with API message |
| Version conflict | 409 | `isError: true` with `ConfluenceConflictError`. Message includes current server version when parseable from response or via follow-up `getPage`; error carries `currentVersion` field (v6.3.0+) |
| Rate limited | 429 | `isError: true` with API message |
| Server error | 5xx | `isError: true` with API message |
| File path outside CWD | N/A | `isError: true` with path restriction message |
| Content shrinkage (>50%) | N/A | `isError: true` with `SHRINKAGE_NOT_CONFIRMED` — re-submit with `confirm_shrinkage: true` |
| Structural loss (>50% headings) | N/A | `isError: true` with `STRUCTURE_LOSS_NOT_CONFIRMED` — re-submit with `confirm_structure_loss: true` |
| Empty body | N/A | `isError: true` with `EMPTY_BODY_REJECTED` — no opt-out, must delete and recreate |
| Invented token | N/A | `isError: true` with `INVENTED_TOKEN` — caller markdown contains unknown token IDs |
| Deletions not confirmed | N/A | `isError: true` with `DELETIONS_NOT_CONFIRMED` — re-submit with `confirm_deletions: true` |
| Separator invalid | N/A | `isError: true` — separator exceeds 100 chars or contains XML tags |
| Combined body too large | N/A | `isError: true` — combined body exceeds 2MB limit |
| Version mismatch (revert) | N/A | `isError: true` — page version changed since caller's read (TOCTOU guard) |
| User declined elicitation | N/A | `USER_DECLINED` (v6.2.3+) — user explicitly clicked "decline" / answered no |
| User cancelled elicitation | N/A | `USER_CANCELLED` (v6.2.3+) — user dismissed the prompt without choosing |
| No user response | N/A | `NO_USER_RESPONSE` (v6.2.3+) — elicitation timed out, transport error, unknown action, or client advertises capability but never honours it (returns action but `confirm: false`) |
| Elicitation unavailable | N/A | `ELICITATION_REQUIRED_BUT_UNAVAILABLE` (v6.2.3+, renamed from `ELICITATION_UNSUPPORTED`) — client did not advertise elicitation capability during MCP `initialize` handshake. Error message points to `update_page_section` as workaround, or `EPIMETHIAN_ALLOW_UNGATED_WRITES=true` for unsupported-client branch, or `EPIMETHIAN_BYPASS_ELICITATION=true` for clients advertising capability but never honouring it |
| Destructive flag from tool output | N/A | `SOURCE_POLICY_BLOCKED` (v6.3.0+) — fires when `source === "chained_tool_output"` is paired with any destructive flag, or when `EPIMETHIAN_REQUIRE_SOURCE=true` and `source` is omitted. Replaces older `DESTRUCTIVE_FLAG_FROM_TOOL_OUTPUT` and `SOURCE_REQUIRED` codes. Error message: "...blocked by source policy: source=chained_tool_output, but tool-chained outputs cannot authorise content deletion. Confirm interactively or rephrase request." |
| Multi-section apply failed | N/A | `MULTI_SECTION_FAILED` (v6.4.0+) — from `update_page_sections` when one or more sections cannot be applied atomically. Error message lists EVERY per-section failure (missing heading, ambiguous heading, duplicate section name in input list, sub-prepare error) so caller sees all problems in one round-trip. Page is NOT modified |
| Find/replace match failed | N/A | `FIND_REPLACE_MATCH_FAILED` (v6.4.0+) — from `update_page_section` find_replace mode when a `find` string does not appear in the section body. Error names the missing find string. Page is NOT modified |
| Write budget exceeded | N/A | `WRITE_BUDGET_EXCEEDED` — message body is structured four-section block (count/scope, "Why this exists", "What to tell the user", "How to raise or disable the cap"). Scope field uses `"rolling"` (15-min window) as of v6.2.3; legacy fixtures may show `"hourly"` |
| Missing config | N/A | stderr message + exit(1) at startup |

## Migration Notes

The following error codes have been renamed or split across releases:

### v6.2.3: Elicitation error code split

`USER_DENIED_GATED_OPERATION` is removed. Callers now receive one of four more specific codes:

- `USER_DECLINED` — user explicitly clicked "decline" or answered no
- `USER_CANCELLED` — user dismissed the prompt without choosing
- `NO_USER_RESPONSE` — timeout, transport error, unknown action, or client advertises capability but returns action with `confirm: false`
- `ELICITATION_REQUIRED_BUT_UNAVAILABLE` (renamed from `ELICITATION_UNSUPPORTED`) — client did not advertise elicitation capability during MCP `initialize`

### v6.3.0: Source policy consolidation

`DESTRUCTIVE_FLAG_FROM_TOOL_OUTPUT` and `SOURCE_REQUIRED` are consolidated under `SOURCE_POLICY_BLOCKED`, which fires when:
- `source === "chained_tool_output"` is paired with any destructive flag (e.g., `confirm_shrinkage: true`)
- `EPIMETHIAN_REQUIRE_SOURCE=true` and the caller omitted the `source` parameter

This code replaces the older codes when blocking destructive operations before elicitation can run.

### v6.3.0: ConfluenceConflictError.currentVersion

On a 409 response from `update_page` or `delete_page`, `ConfluenceConflictError` now carries a `currentVersion` field when the server's current page version can be determined (either by parsing the conflict response body or via a follow-up `getPage` lookup). The error message is updated to include the version, allowing callers to retry without needing a separate `get_page` round-trip.
