# Alternatives considered

[← Back to index](README.md)

## Library choice

| Alternative | Verdict |
|------------|---------|
| **`markdown-it`** (chosen) | Plugin architecture is materially better for the per-element extensions in Phase 2 (panels, containers, inline directives, frontmatter). Active maintenance, TypeScript types, stable plugin API. ~80 KB bundled with the four plugins we need. |
| `marked` | Faster and lighter (~30 KB) but plugin API is weaker for the directive/container patterns we need. The performance difference is irrelevant at our scale. |
| `remark` | The most extensible markdown ecosystem; native AST manipulation. But the learning curve and bundle size (~150 KB+) are out of proportion to the use case. |
| Roll our own markdown parser | Reinventing the wheel; markdown is fiddly; no upside. |

## Conversion strategy

| Alternative | Verdict |
|------------|---------|
| **markdown-it + post-processing** (chosen) | Local conversion, no extra API call, full control over storage XML output. |
| Use Confluence's `/rest/api/contentbody/convert/storage` endpoint with `wiki` source | Rejected. The endpoint takes Confluence's own wiki markup (a non-CommonMark dialect), not GFM. Two lossy hops (md → wiki → storage) and no native panel/macro support beyond what Confluence wiki syntax exposes. Adds an API call per write, with rate-limit and latency cost. |

## Macro authoring surface

| Alternative | Verdict |
|------------|---------|
| **Markdown extensions for authoring + tokenised raw passthrough for preservation** (chosen) | Best DX for full-page authoring; preserves arbitrary existing content. |
| MCP-side abstraction tools (one tool per macro: `render_panel`, `render_status_badge`, etc.) | Rejected for full-page authoring; agents would have to compose dozens of tool calls per page. Acceptable as a *supplement* (Phase 4) for cases that need server-side resolution like `lookup_user`. |
| Document storage format and require callers to write it directly | Rejected. Storage format is verbose, error-prone, hard for LLMs to produce reliably. The whole point of the MCP is to abstract Atlassian's quirks. |

## Data-preservation strategy

| Alternative | Verdict |
|------------|---------|
| **Opaque-token preservation with byte-by-reference restoration** (chosen) | Bit-perfect round-trip; forward-compatible with new Confluence macros; explicit deletion semantics. See [01-data-preservation.md](01-data-preservation.md). |
| AST-diff + best-effort merge | Rejected. "Best-effort" merges are lossy by definition; cannot guarantee the no-loss invariant. |
| Sidecar managed by the caller (read returns markdown + sidecar; write requires sidecar back) | Rejected as the default contract; caller burden is too high. Available implicitly for offline/batch flows since `get_page` returns the sidecar in its result. |
| Refuse markdown writes on pages containing unknown macros | Rejected. Punishes callers for content they didn't author; defeats the purpose of conversion. |
| Reject every deletion unconditionally (no `confirm_deletions` flag) | Considered. Too rigid — sometimes agents legitimately need to remove macros (e.g. cleanup). The `confirm_deletions` flag with explicit version-message logging strikes the balance. |

## Authoring shim alternatives for panels

| Alternative | Verdict |
|------------|---------|
| **GitHub-style `> [!INFO]` for the five named panels + Pandoc fenced div for generic** (chosen) | Familiar to LLMs (GitHub uses it widely); composable. |
| Pandoc-style fenced div for everything (no GitHub alert syntax) | More uniform but less recognisable. The GitHub alert syntax is a strong industry signal. |
| HTML comment-based authoring (`<!-- info: title -->\n...\n<!-- /info -->`) | Rejected. Hostile to read; doesn't compose well; not a standard. |
