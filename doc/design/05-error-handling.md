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
| Rate limited | 429 | `isError: true` with API message |
| Server error | 5xx | `isError: true` with API message |
| File path outside CWD | N/A | `isError: true` with path restriction message |
| Missing config | N/A | stderr message + exit(1) at startup |
