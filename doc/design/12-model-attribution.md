# 12 — Client-Aware Attribution

## Goal

Include the MCP client identity in Confluence version messages and comments, and remove the visible page footer.

Currently, version messages say:

```
Updated by Epimethian v5.1.1
```

With client info available:

```
Updated by claude-code (via Epimethian v5.1.1)
```

The on-page footer is removed. It duplicates information already available through better mechanisms (version history, page labels) and creates unnecessary complexity (deduplication logic, regex, agent copy-paste artifacts).

---

## Current State

### Page footer (`confluence-client.ts:849–856`)

```ts
function buildAttributionFooter(action: "created" | "updated"): string {
  return (
    ATTRIBUTION_START +
    '<p style="font-size:9px;color:#999;margin-top:2em;">' +
    `<em>This page was ${action} with ` +
    `<a href="${GITHUB_URL}">Epimethian</a> v${__PKG_VERSION__}.</em></p>` +
    ATTRIBUTION_END
  );
}
```

The footer is wrapped in HTML comment markers (`<!-- epimethian-attribution-start -->` / `<!-- epimethian-attribution-end -->`) for identification.

### Comment attribution (`confluence-client.ts:997, 1021`)

```
<p><em>[AI-generated via Epimethian]</em></p>
```

### Deduplication (`confluence-client.ts:859–873`)

Two regex patterns strip old footers before a fresh one is appended:

1. **Marker-based** — matches `<!-- epimethian-attribution-start -->…<!-- epimethian-attribution-end -->`
2. **Bare paragraph** — matches `<p…>…<a href="…epimethian-mcp">Epimethian</a>…</p>` (catches agent copy-paste artifacts when the HTML comments are lost)

### Version messages (`confluence-client.ts:495, 526–528`)

```ts
// createPage
version: { message: `Created by Epimethian v${__PKG_VERSION__}` }

// updatePage
const versionMessage = opts.versionMessage
  ? `${opts.versionMessage} (via Epimethian v${__PKG_VERSION__})`
  : `Updated by Epimethian v${__PKG_VERSION__}`;
```

### Call sites

| Location | Action | Code |
|---|---|---|
| `createPage()` :484–486 | Appends footer if `cfg.attribution` | `buildAttributionFooter("created")` |
| `updatePage()` :537–540 | Strips then appends | `buildAttributionFooter("updated")` |
| `updatePage()` :564–569 | Cache entry also rebuilt | same |
| `createFooterComment()` :997 | Prepends `[AI-generated via Epimethian]` | literal string |
| `createInlineComment()` :1021 | Same | literal string |
| Version messages :495, 527–528 | `"Created by Epimethian v…"` / `"… (via Epimethian v…)"` | literal strings |

### Existing attribution mechanisms besides the footer

| Mechanism | Visibility | Per-version | Notes |
|---|---|---|---|
| **Version message** | Version history UI | Yes | Already exists, one per edit |
| **`epimethian-managed` label** | Page metadata, CQL-searchable | Page-level | Already exists |
| **Confluence author** | Version history, page header | Yes | Native, automatic |

---

## Why Remove the Footer

The footer is the weakest attribution mechanism:

- **Redundant** — Version messages already appear per-edit in the version history. The `epimethian-managed` label marks the page. Confluence natively tracks the author.
- **Only reflects the last edit** — If a human edits after an AI edit, a stale AI footer persists.
- **Engineering cost** — The entire deduplication subsystem (`stripAttributionFooter`, two regex patterns, `ATTRIBUTION_START`/`ATTRIBUTION_END` constants, multiple test cases for whitespace normalization) exists solely to manage the footer.
- **Agent copy-paste artifacts** — When an AI agent reads a page via `get_page` and passes the body back to `update_page`, the footer gets embedded as content. Pattern 2 in the regex exists to catch this, but it's inherently fragile.

Version messages are the right place for per-edit attribution: they are per-version, timestamped, visible in the history UI, and require zero deduplication.

---

## Where Client Information Comes From

### MCP `initialize` handshake — client identity

The MCP protocol `initialize` request includes `params.clientInfo: Implementation`:

```ts
interface Implementation {
  name: string;     // e.g. "claude-code", "cursor", "continue"
  version: string;  // e.g. "1.2.3"
  title?: string;   // e.g. "Claude Code" (human-friendly)
  description?: string;
}
```

The SDK stores this and exposes it via:

```ts
mcpServer.server.getClientVersion()  // Implementation | undefined
```

This returns `undefined` before the `initialize` handshake completes, but tool calls only arrive after initialization, so it is reliably available inside tool handlers.

**Important**: This identifies the **MCP client application** (e.g. "claude-code"), not the **model** (e.g. "Claude Opus 4.6"). The MCP protocol does not currently expose the model name. The client name is still informative — it tells the reader which tool produced the edit.

---

## Design

### Client label resolution

```
1. clientInfo.title (human-friendly)    → prefer when available (e.g. "Claude Code")
2. clientInfo.name  (machine slug)      → fallback            (e.g. "claude-code")
3. neither available                    → omit client clause
```

### Version messages

| Client available | `versionMessage` provided | Result |
|---|---|---|
| Yes | Yes | `"{versionMessage} (claude-code via Epimethian v5.1.1)"` |
| Yes | No | `"Updated by claude-code (via Epimethian v5.1.1)"` |
| No | Yes | `"{versionMessage} (via Epimethian v5.1.1)"` |
| No | No | `"Updated by Epimethian v5.1.1"` |

Same pattern for `createPage`:

| Client available | Result |
|---|---|
| Yes | `"Created by claude-code (via Epimethian v5.1.1)"` |
| No | `"Created by Epimethian v5.1.1"` |

### Comment attribution

```
[AI-generated by claude-code via Epimethian]   // client known
[AI-generated via Epimethian]                  // client unknown
```

### Page footer

Removed. `buildAttributionFooter()` is deleted. The `cfg.attribution` flag no longer controls footer insertion.

### Footer stripping (legacy cleanup)

`stripAttributionFooter()` is retained but simplified to a **cleanup-only** role. It runs on every `updatePage` call to strip leftover footers from pages written by older versions:

```ts
function stripAttributionFooter(body: string): string {
  return body
    // Legacy: strip old marker-wrapped footers
    .replace(
      /<!--\s*epimethian-attribution-start\s*-->[\s\S]*?<!--\s*epimethian-attribution-end\s*-->/g,
      ""
    )
    // Legacy: strip bare unmarked footers (agent copy-paste artifacts)
    .replace(
      /<p[^>]*>[\s\S]*?<a\s[^>]*href="https:\/\/github\.com\/de-otio\/epimethian-mcp"[^>]*>(?:<em>)?Epimethian(?:<\/em>)?<\/a>[\s\S]*?<\/p>/gi,
      ""
    )
    .trimEnd();
}
```

Both patterns can be removed entirely in a future major version once all managed pages have been re-saved by the new version (which won't re-introduce a footer).

### `attribution` config flag

The `cfg.attribution` flag (profile setting + `CONFLUENCE_ATTRIBUTION` env var) currently controls whether the footer is appended. With the footer removed, this flag controls whether the client name is included in version messages and comments. When `false`, version messages revert to the anonymous form (`"Updated by Epimethian v5.1.1"`).

---

## Plumbing the Client Label

The client label needs to flow from `index.ts` (which has access to the `McpServer` instance) down to `confluence-client.ts` (where version messages are built).

Add an optional `clientLabel?: string` to the write functions:

```ts
export async function createPage(
  spaceId: string, title: string, body: string,
  parentId?: string,
  clientLabel?: string   // ← new
): Promise<PageData>

export async function updatePage(
  pageId: string,
  opts: {
    title: string;
    body?: string;
    version: number;
    versionMessage?: string;
    previousBody?: string;
    clientLabel?: string;   // ← new
  }
): Promise<…>
```

The tool handlers in `index.ts` resolve the label lazily:

```ts
function getClientLabel(server: McpServer): string | undefined {
  const client = server.server.getClientVersion();
  return client?.title || client?.name || undefined;
}
```

And pass it through on every write call. For comments, a module-level setter is acceptable since comments are simpler and write-once:

```ts
let _clientLabel: string | undefined;
export function setClientLabel(label: string | undefined) { _clientLabel = label; }
```

---

## Files Changed

| File | Change |
|---|---|
| `src/server/confluence-client.ts` | Delete `buildAttributionFooter()`, `ATTRIBUTION_START`, `ATTRIBUTION_END`; simplify `stripAttributionFooter()` to legacy-only; remove footer append from `createPage()` / `updatePage()`; add `clientLabel` to version message construction; add `setClientLabel()` + use in comment attribution |
| `src/server/index.ts` | Add `getClientLabel()` helper; pass label into all write-path tool calls; call `setClientLabel()` at startup |
| `src/server/confluence-client.test.ts` | Remove footer-specific tests; add version message tests with/without client label; update `createPage`/`updatePage` tests to verify no footer in body |

---

## Edge Cases

1. **`clientInfo` not yet available** — Cannot happen for tool calls; the MCP spec requires `initialize` before any tool invocation. The SDK enforces this.

2. **`clientInfo.name` is empty** — Treat empty string as absent; fall through to anonymous form. Non-empty strings are used as-is.

3. **HTML-unsafe characters in client name** — Not a concern for version messages (plain text, not HTML). For comment attribution, escape with `escapeHtml()` since comment bodies are storage-format XHTML.

4. **Very long client names** — Truncate at ~80 characters to prevent bloated version messages.

5. **Multiple MCP clients reconnect with different identities** — For stdio transport (current), there is exactly one client per process, so this is not a concern.

---

## Migration / Compatibility

- Old footers are stripped by `stripAttributionFooter()` on the next `updatePage` call. No manual migration needed.
- The legacy strip patterns can be removed in a future major version.
- The `attribution` config flag is repurposed: it now controls whether client identity appears in version messages and comments (not footer insertion).
- `ATTRIBUTION_START` / `ATTRIBUTION_END` / `GITHUB_URL` constants are removed (the GitHub URL is no longer linked from page content; it remains in version messages as plain text if desired, or can be dropped).
- The `epimethian-managed` label continues to be applied as before — it is independent of the footer.

---

## Testing Plan

1. **Unit**: `createPage` body does not contain any attribution footer.
2. **Unit**: `updatePage` body does not contain any attribution footer.
3. **Unit**: `updatePage` strips legacy marker-wrapped footers from incoming body.
4. **Unit**: `updatePage` strips legacy bare unmarked footers from incoming body.
5. **Unit**: Version message includes client label when provided.
6. **Unit**: Version message falls back to anonymous form when client label is absent.
7. **Unit**: Custom `versionMessage` is preserved with client label appended.
8. **Unit**: Comment attribution includes client label when set.
9. **Unit**: Comment attribution falls back to anonymous form when unset.
10. **Unit**: HTML-unsafe characters in client label are escaped in comment bodies.
