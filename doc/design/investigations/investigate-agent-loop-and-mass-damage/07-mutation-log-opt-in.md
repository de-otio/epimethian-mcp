# 7. Mutation log is opt-in

[← back to index](README.md)

`src/server/mutation-log.ts` + `src/server/index.ts:2367-2370`:

```ts
if (process.env.EPIMETHIAN_MUTATION_LOG === "true") {
  const logDir = join(homedir(), ".epimethian", "logs");
  initMutationLog(logDir);
}
```

If the user never set `EPIMETHIAN_MUTATION_LOG=true`, a catastrophic
run leaves no client-side trace. Recovery depends entirely on
Confluence's version history, which:
- captures what changed but not *which MCP client* did it,
- captures content but not the exact `confirm_shrinkage` /
  `confirm_structure_loss` / `replace_body` flags that bypassed guards,
- does not capture failed attempts (useful for detecting a loop
  that hit 500 errors partway through).

[`doc/design/security/06-limitations.md`](../../security/06-limitations.md)
§13 acknowledges this. The remaining question is whether "opt-in" is
the right default for a tool that is explicitly designed to take
destructive action on shared content.

## Possible mitigation

Flip the default. Log by default; respect
`EPIMETHIAN_MUTATION_LOG=false` as an explicit opt-out. The log is
already metadata-only (lengths and hashes, no bodies, no titles) — see
[`doc/design/security/03-write-safety.md`](../../security/03-write-safety.md).
Privacy cost is low; forensic value of a default-on log is high.
