# 6. Cross-call payload propagation

[← back to index](README.md)

Attack classes D (second-order) and F (context saturation) from
[01-threat-model.md](01-threat-model.md) share a common property:
the payload *moves* between calls. This chapter addresses both.

## 6.1 Context saturation

`get_page` has an optional `max_length`; if the caller omits it, the
full body is returned. A 2 MB poisoned page fills the agent's context
and displaces whatever the user asked for.

### Proposal: default `max_length`

- Enforce `DEFAULT_MAX_READ_BODY = 50_000` chars inside `get_page`
  and `get_page_by_title` when the caller does not pass `max_length`.
- The tool response includes a `[truncated: full body is N chars; pass
  max_length=N to see more]` suffix outside the fence.
- The agent must make an explicit second call with a larger
  `max_length` to ingest more. That second call is an opportunity for
  the user's approval UI to fire (in clients that surface
  read-tool calls to the user).

50 000 chars is large enough for typical documentation pages and
small enough that a single poisoned page doesn't dominate a 200k
context window.

### Proposal: read-response size watermark

In the mutation log, record the sum of characters returned by read
tools in the last 5 minutes. When a destructive write fires, the log
entry carries `preceding_read_bytes=N`. Doesn't prevent anything, but
a forensic audit can correlate "the delete was preceded by 1.8 MB of
reads" with "the agent was probably steered by fenced content".

## 6.2 Second-order propagation

Attacker writes payload P to page A. The agent:

1. Reads page A — content fenced, signal-scanned.
2. Summarises A (or rewrites it), including P.
3. Writes the summary to page B via `create_page` / `update_page`.

Page B now carries P, but P's provenance is lost: B's content is
agent-authored, so a future read of B detects the signals (see
[05](05-content-signal-scanning.md)) but cannot tell who originally
wrote them.

### Proposal: write-path fence detection

Inside `safePrepareBody`, scan the caller's `body` for:

- `<<<CONFLUENCE_UNTRUSTED` / `<<<END_CONFLUENCE_UNTRUSTED>>>` — the
  agent should never submit content that contains Epimethian's own
  fence markers. If it does, the agent has almost certainly copied a
  tool response verbatim.
- `injection-signals=…` — same rationale.
- The random-per-session canary (see 6.3).

Finding any of these in a write input: hard reject with error code
`WRITE_CONTAINS_UNTRUSTED_FENCE`. The rejection message tells the
agent exactly which marker was found and which input field carried
it, so a well-aligned agent can remove the offending span and retry.

### Why this helps

An agent that has been hijacked into round-tripping a payload has to
either:
- Reproduce the payload *with fences* (caught here), or
- Reproduce the payload *without fences*, which requires the agent
  to have reasoned about "I am intentionally reconstructing tenant
  content I read earlier" — a higher bar than "pass through".

The attacker can still write a *similar* payload that the model
composes freshly, but that requires the model to *author* an
injection attack, not just relay one.

## 6.3 Per-session canary

A random 24-char string (`EPI-${uuid}`) is generated at server startup
and embedded inside every fence as a closing-line comment:

```
<<<CONFLUENCE_UNTRUSTED pageId=42 field=body>>>
…content…
<!-- canary:EPI-abc123…xyz -->
<<<END_CONFLUENCE_UNTRUSTED>>>
```

Any write input whose body contains `EPI-abc123…xyz` is rejected:
the agent has demonstrably just copied a read response into a write.

Session-scoped (regenerated per MCP startup) so that:
- Canaries are not persistent across restarts (no collision with
  long-term stored content).
- A compromised session cannot carry the canary forward.

## 6.4 Write-tool `currentBody` preservation check

For `update_page` specifically, the token-preservation pipeline
already computes a diff. When the new body contains tokens that are
**not** in the current body's sidecar, `planUpdate` throws
`INVENTED_TOKEN`. That's the right shape — the caller invented a
token that doesn't exist on the target page.

The same shape should apply to fence markers: if the caller's
`body` contains tokens that match the **read-side** fence vocabulary
(not `[[epi:T####]]` but the `<<<CONFLUENCE_UNTRUSTED` / canary
markers above), reject. Same mechanism, different vocabulary.

## Threat-model coverage

| Attack class             | Covered by         |
| ------------------------ | ------------------ |
| D (second-order)         | 6.2 + 6.3          |
| F (context saturation)   | 6.1                |

## Costs

- Default `max_length`: changes an existing tool's default behaviour.
  Users who relied on "full body always" will need to pass
  `max_length=0` (or a sentinel) explicitly. Semver-minor breaking.
- Canary + write-path scan: ~50 LOC; zero perf impact.
- Per-session canary requires generating a random string at startup
  — no persistent storage.

## Alternatives considered

- **Content-hash comparison instead of canary**: hash the read
  response, store it server-side, reject writes whose input
  fuzzy-matches the hash. Would catch *any* read-to-write copy,
  including summaries. Too aggressive — legitimate "copy this page
  to a new space" workflows use exactly this pattern.
- **Token-level watermark in fence attributes only**: lower blast
  radius but requires the agent to strip our own attribute lines,
  which most agents will do naturally when composing new content.
  Misses the common case.
- **Reject all writes with ANY fence-shaped text**: simplest,
  probably wrong — `<<<END>>>` is a valid substring in many legitimate
  contexts (shell, YAML, examples). Keep the canary variant.
