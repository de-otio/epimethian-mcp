# Implementation Plan: Epimethian MCP Server Safety Improvements

This plan covers all server-side changes from the post-mortem. Orchestrator workflow changes (Layers 4-5) are behavioral — they don't require code changes in Epimethian.

---

## Change Summary

| ID  | Change                                     | Files                                                | Priority | Effort  |
| --- | ------------------------------------------ | ---------------------------------------------------- | -------- | ------- |
| 1A  | Content-shrinkage guard                    | update-orchestrator.ts, index.ts, types.ts           | CRITICAL | Small   |
| 1B  | Structural integrity check                 | update-orchestrator.ts, index.ts                     | HIGH     | Small   |
| 1C  | Empty-body rejection                       | update-orchestrator.ts                               | HIGH     | Trivial |
| 1D  | Return body lengths in update response     | index.ts                                             | HIGH     | Trivial |
| 1E  | Write-ahead log                            | new: mutation-log.ts, index.ts, confluence-client.ts | MEDIUM   | Medium  |
| 1F  | Pre-write snapshot in page cache           | page-cache.ts, confluence-client.ts                  | MEDIUM   | Small   |
| 2A  | `prepend_to_page` / `append_to_page` tools | index.ts, confluence-client.ts                       | HIGH     | Medium  |
| 2B  | `revert_page` tool                         | index.ts, confluence-client.ts                       | MEDIUM   | Medium  |
| 2C  | Enrich `update_page` description           | index.ts                                             | LOW      | Trivial |
| 2D  | Document `get_page_version` limitations    | index.ts                                             | LOW      | Trivial |

---

## Suggested PR Sequence

Changes are grouped into PRs that are independently shippable. Each PR should pass all existing tests plus new ones.

### PR 1: Content-safety guards (1A + 1B + 1C + 1D + 2C + 2D) — ship first

The highest-value PR. Three deterministic guards that would each independently have blocked the original incident, plus low-cost description improvements. No new tools, no new modules — purely additive logic in existing code paths.

### PR 2: Additive mutation tools (2A)

New `prepend_to_page` and `append_to_page` tools. Eliminates the need for `replace_body: true` for additive operations.

### PR 3: Pre-write snapshots + write-ahead log (1E + 1F)

Recovery infrastructure. Pre-write body snapshots in the page cache and a persistent mutation log for forensics and automated rollback.

### PR 4: Revert tool (2B)

Purpose-built `revert_page` tool that uses raw storage from the v1 API. Depends on the shrinkage guard (PR 1) being in place so the revert itself is protected.

---

## PR 1: Content-Safety Guards

### 1A. Content-shrinkage guard

**Concept:** When `replace_body: true` and the new body is drastically smaller than the old body, reject the update unless the caller passes `confirm_shrinkage: true`.

**File: `src/server/converter/types.ts`**

Add new error code constant (near line 66, after `ConverterError` class):

```typescript
export const SHRINKAGE_NOT_CONFIRMED = 'SHRINKAGE_NOT_CONFIRMED';
```

**File: `src/server/converter/update-orchestrator.ts`**

Extend `PlanUpdateInput` (line 33) with a new optional field:

```typescript
export interface PlanUpdateInput {
  currentStorage: string;
  callerMarkdown: string;
  confirmDeletions?: boolean;
  confirmShrinkage?: boolean; // NEW — default false
  replaceBody?: boolean;
  converterOptions?: ConverterOptions;
}
```

Modify the `replaceBody` path in `planUpdate()` (lines 201-204). Currently:

```typescript
if (replaceBody) {
  const newStorage = markdownToStorage(callerMarkdown, converterOptions);
  return { newStorage, deletedTokens: [] };
}
```

Replace with:

```typescript
if (replaceBody) {
  const newStorage = markdownToStorage(callerMarkdown, converterOptions);

  // 1A: Content-shrinkage guard
  const oldLen = currentStorage.length;
  const newLen = newStorage.length;
  if (oldLen > 500 && newLen < oldLen * 0.5 && !confirmShrinkage) {
    throw new ConverterError(
      `Body would shrink from ${oldLen} to ${newLen} characters ` +
        `(${Math.round((1 - newLen / oldLen) * 100)}% reduction). ` +
        `This may indicate accidental content loss. ` +
        `Re-submit with confirm_shrinkage: true to proceed, ` +
        `or omit replace_body to use token-aware preservation.`,
      SHRINKAGE_NOT_CONFIRMED,
    );
  }

  return { newStorage, deletedTokens: [] };
}
```

**Thresholds:** `oldLen > 500` avoids guarding trivial pages. `newLen < oldLen * 0.5` (50% reduction) catches catastrophic replacements (the incident was 99.2%) while allowing legitimate rewrites that trim content. These should be constants at the top of the file for tunability:

```typescript
const SHRINKAGE_GUARD_MIN_OLD_LEN = 500;
const SHRINKAGE_GUARD_MAX_RATIO = 0.5;
```

**File: `src/server/index.ts`**

Add `confirm_shrinkage` parameter to the `update_page` input schema (after `replace_body`, around line 452):

```typescript
confirm_shrinkage: z
  .boolean()
  .default(false)
  .describe(
    "Set to true to acknowledge that the new body is significantly smaller than the existing body. " +
    "Required when replace_body is true and the body would shrink by more than 50%."
  ),
```

Thread it through to `planUpdate()` (around line 478):

```typescript
const plan = planUpdate({
  currentStorage,
  callerMarkdown: body,
  confirmDeletions: confirm_deletions,
  confirmShrinkage: confirm_shrinkage, // NEW
  replaceBody: replace_body,
  converterOptions: {
    /* ... */
  },
});
```

Update the tool description (line 417-424) to mention the new parameter:

```
"- confirm_shrinkage: set to true to acknowledge a >50% body size reduction when using replace_body (default false).\n" +
```

**Tests: `src/server/converter/update-orchestrator.test.ts`**

Add a new `describe("planUpdate — shrinkage guard")` block:

```typescript
describe('planUpdate — shrinkage guard', () => {
  const bigStorage = '<p>' + 'x'.repeat(1000) + '</p>';

  it('throws SHRINKAGE_NOT_CONFIRMED when replaceBody shrinks by >50%', () => {
    expect(() =>
      planUpdate({
        currentStorage: bigStorage,
        callerMarkdown: 'tiny',
        replaceBody: true,
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'SHRINKAGE_NOT_CONFIRMED',
      }),
    );
  });

  it('allows shrinkage when confirm_shrinkage is true', () => {
    const result = planUpdate({
      currentStorage: bigStorage,
      callerMarkdown: 'tiny',
      replaceBody: true,
      confirmShrinkage: true,
    });
    expect(result.newStorage).toBeTruthy();
  });

  it('does not trigger on small pages (< 500 chars)', () => {
    const result = planUpdate({
      currentStorage: '<p>small</p>',
      callerMarkdown: 'x',
      replaceBody: true,
    });
    expect(result.newStorage).toBeTruthy();
  });

  it('does not trigger when reduction is < 50%', () => {
    const result = planUpdate({
      currentStorage: bigStorage,
      callerMarkdown: 'x'.repeat(600), // > 50% of 1000
      replaceBody: true,
    });
    expect(result.newStorage).toBeTruthy();
  });

  it('does not trigger without replaceBody', () => {
    // Normal path — shrinkage guard is only for replaceBody
    // (normal path has its own deletion confirmation)
    // This test uses a simple page without macros to avoid token issues
    const result = planUpdate({
      currentStorage: bigStorage,
      callerMarkdown: 'x'.repeat(600),
    });
    expect(result.newStorage).toBeTruthy();
  });
});
```

**Integration test: `src/server/index.test.ts`**

Add test near the existing `replace_body` tests (~line 2023):

```typescript
it('replace_body: true rejects >50% shrinkage unless confirm_shrinkage is set', async () => {
  // Mock getPage to return a page with large body
  // Call update_page with replace_body: true and a tiny body
  // Assert error contains "confirm_shrinkage"
});
```

---

### 1B. Structural integrity check

**Concept:** Count structural elements (`<h1>`–`<h6>` tags) in old vs new storage. If heading count drops by more than 50%, reject unless acknowledged.

**File: `src/server/converter/update-orchestrator.ts`**

Add a helper function (before `planUpdate`):

```typescript
const HEADING_RE = /<h[1-6][^>]*>/gi;

function countHeadings(storage: string): number {
  return (storage.match(HEADING_RE) || []).length;
}
```

Add new error code in `types.ts`:

```typescript
export const STRUCTURE_LOSS_NOT_CONFIRMED = 'STRUCTURE_LOSS_NOT_CONFIRMED';
```

Add to `PlanUpdateInput`:

```typescript
confirmStructureLoss?: boolean;  // NEW — default false
```

Add the check in the `replaceBody` path, after the shrinkage guard (1A):

```typescript
// 1B: Structural integrity check
const oldHeadings = countHeadings(currentStorage);
const newHeadings = countHeadings(newStorage);
if (
  oldHeadings > 2 &&
  newHeadings < oldHeadings * 0.5 &&
  !confirmStructureLoss
) {
  throw new ConverterError(
    `Heading count would drop from ${oldHeadings} to ${newHeadings}. ` +
      `This may indicate accidental content loss. ` +
      `Re-submit with confirm_structure_loss: true to proceed.`,
    STRUCTURE_LOSS_NOT_CONFIRMED,
  );
}
```

**Note:** This check runs on the **converted** `newStorage` (post-`markdownToStorage`), not the raw markdown — so heading detection operates on the same representation (storage XML) for both old and new.

**File: `src/server/index.ts`**

Add `confirm_structure_loss` parameter to the schema and thread it through, same pattern as `confirm_shrinkage`.

**Tests:** Same pattern as 1A — test that heading drop triggers error, that `confirmStructureLoss: true` bypasses it, and that small heading counts (< 3 old headings) don't trigger.

---

### 1C. Empty-body rejection

**Concept:** Reject `update_page` when the new body is trivially small and the old body is substantial. This is a strict, no-opt-out guard — there is no legitimate reason to replace a full page with near-empty content via `update_page`.

**File: `src/server/converter/update-orchestrator.ts`**

Add after the structural integrity check in the `replaceBody` path:

```typescript
// 1C: Empty-body rejection (no opt-out)
const textContent = newStorage.replace(/<[^>]*>/g, '').trim();
if (oldLen > 500 && textContent.length < 100) {
  throw new ConverterError(
    `New body contains only ${textContent.length} characters of text content ` +
      `(old body: ${oldLen} characters). This almost certainly indicates ` +
      `accidental content loss. To intentionally clear a page, use delete_page ` +
      `and re-create it.`,
    'EMPTY_BODY_REJECTED',
  );
}
```

**Note:** This strips HTML/XML tags and checks the remaining text length. A page that is just `<ac:structured-macro ac:name="toc"/>` would have 0 chars of text content. No `confirm_` opt-out — this is a hard guard.

**Design decision:** This guard has **no opt-out parameter** because the failure mode it catches (replacing a page with a single macro or empty content) has no legitimate use case via `update_page`. If a user truly needs to clear a page, they should `delete_page` and `create_page`.

**Tests:** Test that a body with only a macro is rejected, that a body with only whitespace/tags is rejected, and that a body with >100 chars of text passes.

---

### 1D. Return body lengths in update response

**Concept:** Include old and new body character counts in the `update_page` success message so callers can detect anomalies without an extra `get_page` call.

**File: `src/server/index.ts`**

The current return (line 494-496):

```typescript
return toolResult(
  `Updated: ${page.title} (ID: ${page.id}, version: ${newVersion})` + echo,
);
```

Change to:

```typescript
return toolResult(
  `Updated: ${page.title} (ID: ${page.id}, version: ${newVersion}, ` +
    `body: ${currentStorage.length}→${plan.newStorage.length} chars)` +
    echo,
);
```

For the storage-format path (line 498-507), add the same. This requires fetching the current body first — currently the storage path does NOT call `getPage`. Two options:

**Option A (recommended):** Only include body lengths when the markdown path is used (where `currentStorage` is already available). The storage-format path is a legacy backward-compat path and rarely used. Add a comment explaining why it doesn't include lengths.

**Option B:** Fetch the current page in the storage path too. Adds one API call. Not worth it for a legacy path.

Go with Option A. Add a note to the storage-format response:

```typescript
return toolResult(
  `Updated: ${page.title} (ID: ${page.id}, version: ${newVersion})` + echo,
);
// Note: body lengths not available in storage-format path (legacy).
// Use markdown body format for full safety reporting.
```

**Tests:** Assert that the markdown-path response string contains `body: \d+→\d+ chars`.

---

### 2C. Enrich `update_page` description

**File: `src/server/index.ts`**

Append to the existing description string (around line 417-424):

```typescript
'\n\n' +
  '⚠ replace_body skips all safety nets (token preservation, deletion confirmation). ' +
  'For additive changes (prepending, appending), prefer prepend_to_page / append_to_page. ' +
  'When delegating update_page to a subagent, ensure the agent includes the full existing body — ' +
  'replace_body replaces ALL content with only what you provide.';
```

No test needed — this is a description string change.

---

### 2D. Document `get_page_version` limitations

**File: `src/server/index.ts`**

Find the `get_page_version` tool description (around line 1438) and append:

```typescript
'\n\n' +
  '⚠ Returns sanitized read-only markdown, NOT raw Confluence storage format. ' +
  'Macros are replaced with placeholders. This content is NOT suitable for round-trip ' +
  'updates via update_page — the conversion is lossy. ' +
  'Use get_page(format: "storage") for editable content. ' +
  'To revert a page to a previous version, use revert_page instead of ' +
  'feeding get_page_version output to update_page.';
```

No test needed.

---

## PR 2: Additive Mutation Tools (2A)

### `prepend_to_page`

**Concept:** Insert content before the existing page body. The server handles the concatenation — the caller never touches the existing content.

**File: `src/server/index.ts`**

Register new tool (insert after the `update_page_section` tool registration, ~line 595):

```typescript
server.registerTool(
  'prepend_to_page',
  {
    description: describeWithLock(
      'Insert content at the beginning of an existing Confluence page, before all existing content. ' +
        'The caller provides only the new content to prepend — the server fetches the existing body ' +
        'and handles concatenation. This is safer than update_page with replace_body for additive ' +
        'operations like adding a table of contents, banner, or notice.\n\n' +
        'Content can be GFM markdown or Confluence storage format (auto-detected). ' +
        'You must provide the version number from your most recent get_page call.',
      config,
    ),
    inputSchema: {
      page_id: z.string().describe('The Confluence page ID'),
      version: z
        .number()
        .int()
        .positive()
        .describe(
          'The page version number from your most recent get_page call',
        ),
      content: z
        .string()
        .describe(
          'Content to insert before the existing body. GFM markdown or Confluence storage format (auto-detected). ' +
            'For a Confluence TOC macro: <ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter></ac:structured-macro>',
        ),
      separator: z
        .string()
        .optional()
        .describe(
          'Optional separator between prepended content and existing body. Defaults to a blank line (markdown) or empty string (storage format).',
        ),
      version_message: z
        .string()
        .optional()
        .describe('Optional version comment'),
      allow_raw_html: z
        .boolean()
        .default(false)
        .describe('Allow raw HTML inside markdown content (default false).'),
      confluence_base_url: z
        .string()
        .url()
        .optional()
        .describe(
          'Override the Confluence base URL used by the link rewriter.',
        ),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async ({
    page_id,
    version,
    content,
    separator,
    version_message,
    allow_raw_html,
    confluence_base_url,
  }) => {
    const blocked = writeGuard('prepend_to_page', config);
    if (blocked) return blocked;
    try {
      const cfg = await getConfig();
      const currentPage = await getPage(page_id, true);
      const currentStorage =
        currentPage.body?.storage?.value ?? currentPage.body?.value ?? '';

      // Convert prepend content to storage if markdown
      let prependStorage: string;
      if (looksLikeMarkdown(content)) {
        prependStorage = markdownToStorage(content, {
          allowRawHtml: allow_raw_html,
          confluenceBaseUrl: confluence_base_url ?? cfg.url,
        });
      } else {
        prependStorage = content;
      }

      // Concatenate: prepend + separator + existing
      const sep = separator ?? (looksLikeMarkdown(content) ? '\n\n' : '');
      const newBody = prependStorage + sep + currentStorage;

      const { page, newVersion } = await updatePage(page_id, {
        title: currentPage.title,
        body: newBody,
        version,
        versionMessage: version_message ?? 'Prepend content',
      });

      return toolResult(
        `Prepended to: ${page.title} (ID: ${page.id}, version: ${newVersion}, ` +
          `body: ${currentStorage.length}→${newBody.length} chars)` +
          echo,
      );
    } catch (err) {
      return toolError(err);
    }
  },
);
```

**Important implementation detail:** The concatenation operates on **storage format**. The prepend content is converted to storage first (if markdown), then concatenated with the existing storage body. The combined body is passed directly to `updatePage()` without going through `planUpdate()` — this avoids token preservation issues since we're operating on raw storage.

This means `prepend_to_page` bypasses the token-aware write path intentionally. It uses the storage-format path of `updatePage()`. The concatenation is a string operation — simple and deterministic.

### `append_to_page`

Identical to `prepend_to_page` except the concatenation is reversed:

```typescript
const newBody = currentStorage + sep + appendStorage;
```

Register as a separate tool with `"append_to_page"` name and a description that says "Insert content at the end."

### Shared implementation

Since the two tools differ only in concatenation order, extract a shared helper:

**File: `src/server/index.ts`** (or a new `src/server/page-concat.ts` if preferred)

```typescript
async function concatPageContent(
  page_id: string,
  version: number,
  newContent: string,
  position: 'prepend' | 'append',
  opts: {
    separator?: string;
    versionMessage?: string;
    allowRawHtml?: boolean;
    confluenceBaseUrl?: string;
  },
): Promise<{
  page: PageData;
  newVersion: number;
  oldLen: number;
  newLen: number;
}> {
  const cfg = await getConfig();
  const currentPage = await getPage(page_id, true);
  const currentStorage =
    currentPage.body?.storage?.value ?? currentPage.body?.value ?? '';

  let contentStorage: string;
  if (looksLikeMarkdown(newContent)) {
    contentStorage = markdownToStorage(newContent, {
      allowRawHtml: opts.allowRawHtml,
      confluenceBaseUrl: opts.confluenceBaseUrl ?? cfg.url,
    });
  } else {
    contentStorage = newContent;
  }

  const sep = opts.separator ?? (looksLikeMarkdown(newContent) ? '\n\n' : '');
  const newBody =
    position === 'prepend'
      ? contentStorage + sep + currentStorage
      : currentStorage + sep + contentStorage;

  const { page, newVersion } = await updatePage(page_id, {
    title: currentPage.title,
    body: newBody,
    version,
    versionMessage:
      opts.versionMessage ??
      `${position === 'prepend' ? 'Prepend' : 'Append'} content`,
  });

  return {
    page,
    newVersion,
    oldLen: currentStorage.length,
    newLen: newBody.length,
  };
}
```

Both tool handlers call this with `position: "prepend"` or `position: "append"`.

### Tests

**File: `src/server/index.test.ts`**

```typescript
describe('prepend_to_page', () => {
  it('inserts content before existing body', async () => {
    // Mock getPage to return page with body "<p>existing</p>"
    // Call prepend_to_page with content "<p>new</p>"
    // Assert updatePage was called with body "<p>new</p>\n\n<p>existing</p>"
  });

  it('converts markdown content to storage before prepending', async () => {
    // Call with markdown content "# New heading"
    // Assert the prepended content is in storage format
  });

  it('respects custom separator', async () => {
    // Call with separator: "<hr/>"
    // Assert separator appears between prepend and existing
  });

  it('includes body lengths in response', async () => {
    // Assert response contains "body: X→Y chars"
  });
});

describe('append_to_page', () => {
  it('inserts content after existing body', async () => {
    // Same as prepend but content appears after existing
  });
});
```

---

## PR 3: Recovery Infrastructure (1E + 1F)

### 1F. Pre-write snapshot in page cache

**Concept:** Before each write, store the old body in the cache so it can be used for lossless recovery without relying on Confluence's lossy `get_page_version`.

**File: `src/server/page-cache.ts`**

Add a new method to `PageCache`:

```typescript
/**
 * Store a pre-write snapshot. Key: `${pageId}:pre:${version}`.
 * Retained alongside normal cache entries but with a different key
 * namespace so they aren't overwritten by post-write caching.
 */
setSnapshot(pageId: string, version: number, body: string): void {
  const key = `${pageId}:pre:${version}`;
  this.cache.set(key, { version, body });
  this.evictIfNeeded();
}

/**
 * Retrieve a pre-write snapshot.
 */
getSnapshot(pageId: string, version: number): string | undefined {
  const key = `${pageId}:pre:${version}`;
  const entry = this.cache.get(key);
  if (entry && entry.version === version) {
    // Promote to MRU
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.body;
  }
  return undefined;
}
```

**File: `src/server/confluence-client.ts`**

In `updatePage()`, before the v2 PUT call (around line 548), add:

```typescript
// 1F: Snapshot the current body before overwriting
if (opts.body) {
  // Cache the pre-write body at the old version for potential recovery
  pageCache.setSnapshot(pageId, opts.version, existingBody);
}
```

**Problem:** `updatePage()` currently doesn't receive the old body. It only receives the new body. The old body is available in the `update_page` handler (index.ts line 473) but isn't passed down.

**Solution:** Add an optional `previousBody` field to `updatePage`'s options:

```typescript
async function updatePage(
  pageId: string,
  opts: {
    title: string;
    body?: string;
    version: number;
    versionMessage?: string;
    previousBody?: string; // NEW — for pre-write snapshot
  },
): Promise<{ page: PageData; newVersion: number }>;
```

In the `update_page` handler (index.ts), pass `currentStorage` through:

```typescript
const { page, newVersion } = await updatePage(page_id, {
  title,
  body: plan.newStorage,
  version,
  versionMessage: effectiveVersionMessage,
  previousBody: currentStorage, // NEW
});
```

In `updatePage()`, snapshot before the PUT:

```typescript
if (opts.previousBody) {
  pageCache.setSnapshot(pageId, opts.version, opts.previousBody);
}
```

**Cache size consideration:** Snapshots consume cache capacity. With `maxSize: 50` and each snapshot taking one slot, 16 parallel page updates would consume 16 slots (32 with the post-write entries). The default 50 is tight. Consider increasing to 100, or using a separate cache/map for snapshots with its own eviction.

**Tests:** Test that `setSnapshot`/`getSnapshot` round-trip correctly, that snapshots don't collide with normal cache entries, and that LRU eviction works across both namespaces.

---

### 1E. Write-ahead log

**Concept:** Append a JSON record to a local file for every mutation. Survives process crashes. Enables forensics and recovery.

**New file: `src/server/mutation-log.ts`**

```typescript
import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

export interface MutationRecord {
  timestamp: string;
  operation:
    | 'create_page'
    | 'update_page'
    | 'delete_page'
    | 'prepend_to_page'
    | 'append_to_page'
    | 'revert_page';
  pageId: string;
  title: string;
  oldVersion?: number;
  newVersion?: number;
  oldBodyLen?: number;
  newBodyLen?: number;
  replaceBody?: boolean;
  versionMessage?: string;
  error?: string;
}

let logPath: string | null = null;

/**
 * Initialize the mutation log. Call once at server startup.
 * @param dir — directory for log files (e.g., ~/.epimethian/logs/)
 */
export function initMutationLog(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // One log file per server process, named by start time
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  logPath = join(dir, `mutations-${ts}.jsonl`);
}

/**
 * Append a mutation record. Synchronous to ensure the record
 * is flushed before the API response is returned to the caller.
 */
export function logMutation(record: MutationRecord): void {
  if (!logPath) return; // Logging not initialized (tests, etc.)
  try {
    appendFileSync(logPath, JSON.stringify(record) + '\n');
  } catch {
    // Non-critical — don't break the write operation for a log failure.
    // Consider stderr logging here.
  }
}
```

**Integration points:**

**File: `src/server/index.ts`**

At server startup (near the top of the main function), initialize the log:

```typescript
import { initMutationLog, logMutation } from './mutation-log.js';

// In server initialization:
const logDir = join(os.homedir(), '.epimethian', 'logs');
initMutationLog(logDir);
```

In the `update_page` handler, after the `updatePage()` call succeeds:

```typescript
logMutation({
  timestamp: new Date().toISOString(),
  operation: 'update_page',
  pageId: page_id,
  title: page.title,
  oldVersion: version,
  newVersion,
  oldBodyLen: currentStorage.length,
  newBodyLen: plan.newStorage.length,
  replaceBody: replace_body,
  versionMessage: effectiveVersionMessage,
});
```

On error:

```typescript
logMutation({
  timestamp: new Date().toISOString(),
  operation: 'update_page',
  pageId: page_id,
  title,
  oldVersion: version,
  replaceBody: replace_body,
  error: err instanceof Error ? err.message : String(err),
});
```

Same pattern for `create_page`, `delete_page`, `prepend_to_page`, `append_to_page`, and `revert_page`.

**Log rotation:** The per-process naming (`mutations-2026-04-14T10-30-00Z.jsonl`) means each server session gets its own file. Old files accumulate. Either:

- Document that users should periodically clean `~/.epimethian/logs/`
- Add a startup sweep that deletes files older than 30 days
- Make logging opt-in via config (`EPIMETHIAN_MUTATION_LOG=true`)

**Recommendation:** Make logging opt-in initially. Add a config flag. Default off. This avoids surprising users with disk writes they didn't expect.

**Tests:** Test that `logMutation` appends valid JSONL. Test that `initMutationLog` creates the directory. Test that logging failures don't throw. Use a temp directory for tests.

---

## PR 4: Revert Tool (2B)

### `revert_page`

**Concept:** Fetch a historical version's **raw storage body** from the v1 API and push it as the new version. Unlike the `get_page_version` → `update_page` flow, this preserves the original storage format without lossy markdown conversion.

**File: `src/server/confluence-client.ts`**

The existing `getPageVersionBody()` (line 775) already fetches raw storage from the v1 API and returns it as `rawBody`. This is exactly what we need — the tool just needs to pass `rawBody` directly to `updatePage()` without converting it through `toMarkdownView()`.

Add a new function:

```typescript
/**
 * Fetch the raw Confluence storage body for a specific page version.
 * Unlike getPageVersionBody() (which converts to markdown for display),
 * this returns the exact storage XML for use in reverts.
 */
export async function getPageVersionRawStorage(
  pageId: string,
  version: number,
): Promise<{ title: string; rawBody: string; version: number }> {
  // Check versioned cache first
  const cached = pageCache.getVersioned(pageId, version);
  if (cached) {
    // Still need the title — fetch metadata only
    const meta = await v2Get(`/pages/${pageId}`, {});
    const page = PageSchema.parse(meta);
    return { title: page.title, rawBody: cached, version };
  }

  // Fetch from v1 API with body.storage expansion
  const cfg = await getConfig();
  const url = new URL(`${cfg.apiV1}/content/${pageId}`);
  url.searchParams.set('version', String(version));
  url.searchParams.set('expand', 'body.storage,version');
  const data = V1PageVersionSchema.parse(
    await confluenceRequest(url.toString()),
  );
  const rawBody = data.body.storage.value;

  // Cache for reuse
  pageCache.setVersioned(pageId, version, rawBody);

  return { title: data.title, rawBody, version };
}
```

**Note:** This function is nearly identical to the existing `getPageVersionBody()` (lines 775-802) but returns the raw storage body without calling `toMarkdownView()`. Consider refactoring `getPageVersionBody()` to call this internally and then apply the markdown conversion.

**File: `src/server/index.ts`**

Register the new tool:

```typescript
server.registerTool(
  'revert_page',
  {
    description: describeWithLock(
      'Revert a Confluence page to a previous version. Fetches the exact storage-format body ' +
        'from the historical version and pushes it as a new version. This is a lossless revert — ' +
        'unlike manually reading get_page_version (which returns sanitized markdown) and passing it ' +
        'to update_page, this preserves all macros, formatting, and rich elements exactly.\n\n' +
        'The shrinkage guard applies: if the reverted content is significantly smaller than the ' +
        'current content, you will be asked to confirm. The revert target version must exist ' +
        "in the page's version history.",
      config,
    ),
    inputSchema: {
      page_id: z.string().describe('The Confluence page ID'),
      target_version: z
        .number()
        .int()
        .positive()
        .describe(
          'The version number to revert to (1-based). Must be less than the current version.',
        ),
      current_version: z
        .number()
        .int()
        .positive()
        .describe(
          'The current page version number from your most recent get_page call (for optimistic locking).',
        ),
      confirm_shrinkage: z
        .boolean()
        .default(false)
        .describe(
          'Set to true if the historical version is expected to be significantly smaller than the current version.',
        ),
      version_message: z
        .string()
        .optional()
        .describe(
          "Optional version comment. Defaults to 'Revert to version N'.",
        ),
    },
    annotations: { destructiveHint: false, idempotentHint: false },
  },
  async ({
    page_id,
    target_version,
    current_version,
    confirm_shrinkage,
    version_message,
  }) => {
    const blocked = writeGuard('revert_page', config);
    if (blocked) return blocked;
    try {
      // 1. Fetch current page for metadata and body length
      const currentPage = await getPage(page_id, true);
      const currentStorage =
        currentPage.body?.storage?.value ?? currentPage.body?.value ?? '';

      // 2. Fetch historical version's raw storage
      const historical = await getPageVersionRawStorage(
        page_id,
        target_version,
      );

      // 3. Shrinkage guard (reuse the same logic)
      const oldLen = currentStorage.length;
      const newLen = historical.rawBody.length;
      if (oldLen > 500 && newLen < oldLen * 0.5 && !confirm_shrinkage) {
        return toolError(
          new ConverterError(
            `Revert target (v${target_version}) is ${newLen} chars vs current ${oldLen} chars ` +
              `(${Math.round((1 - newLen / oldLen) * 100)}% reduction). ` +
              `Re-submit with confirm_shrinkage: true if this is expected.`,
            'SHRINKAGE_NOT_CONFIRMED',
          ),
        );
      }

      // 4. Push the historical body as a new version
      const { page, newVersion } = await updatePage(page_id, {
        title: currentPage.title,
        body: historical.rawBody,
        version: current_version,
        versionMessage:
          version_message ?? `Revert to version ${target_version}`,
        previousBody: currentStorage, // For pre-write snapshot (1F)
      });

      // 5. Log the mutation (1E)
      logMutation({
        timestamp: new Date().toISOString(),
        operation: 'revert_page',
        pageId: page_id,
        title: page.title,
        oldVersion: current_version,
        newVersion,
        oldBodyLen: oldLen,
        newBodyLen: newLen,
      });

      return toolResult(
        `Reverted: ${page.title} (ID: ${page.id}, version: v${target_version}→v${newVersion}, ` +
          `body: ${oldLen}→${newLen} chars)` +
          echo,
      );
    } catch (err) {
      return toolError(err);
    }
  },
);
```

**Design decisions:**

- The revert passes the historical `rawBody` directly to `updatePage()` as raw storage (not markdown). This hits the storage-format path in `updatePage()`, which passes the body through verbatim — no markdown conversion, no token preservation, no lossy round-trip.
- The shrinkage guard is applied manually (not via `planUpdate`) because we're using the storage-format path. This is intentional — the historical body is already in storage format and shouldn't be processed through the markdown converter.
- `confirm_shrinkage` is exposed because legitimate reverts (e.g., reverting to a shorter early version after a content expansion) may trigger the guard.

**Tests:**

```typescript
describe('revert_page', () => {
  it('fetches raw storage from v1 API and pushes as new version', async () => {
    // Mock getPage, getPageVersionRawStorage, updatePage
    // Assert updatePage receives the raw storage body (not markdown)
  });

  it('applies shrinkage guard', async () => {
    // Mock historical version being much smaller than current
    // Assert error unless confirm_shrinkage: true
  });

  it('includes body lengths in response', async () => {
    // Assert response contains "body: X→Y chars"
  });

  it('logs the mutation', async () => {
    // Assert logMutation was called with operation: "revert_page"
  });
});
```

---

## Implementation Order Within Each PR

### PR 1 (recommended internal order):

1. `types.ts` — add error code constants
2. `update-orchestrator.ts` — add guards to `planUpdate()`
3. `update-orchestrator.test.ts` — unit tests for all three guards
4. `index.ts` — add parameters, thread through, update descriptions
5. `index.test.ts` — integration tests
6. Run full test suite: `npm test`

### PR 2:

1. `index.ts` — add `concatPageContent` helper + two tool registrations
2. `index.test.ts` — tests for both tools
3. Run full test suite

### PR 3:

1. `page-cache.ts` — add `setSnapshot`/`getSnapshot`
2. `page-cache.test.ts` — unit tests for snapshots
3. `mutation-log.ts` — new file
4. `mutation-log.test.ts` — new test file
5. `confluence-client.ts` — add `previousBody` param, call `setSnapshot`
6. `index.ts` — pass `previousBody`, call `logMutation`, init log at startup
7. Run full test suite

### PR 4:

1. `confluence-client.ts` — add `getPageVersionRawStorage()`
2. `index.ts` — register `revert_page` tool
3. `index.test.ts` — integration tests
4. Run full test suite

---

## Files Changed Per PR

| PR   | New files                                 | Modified files                                                                                   |
| ---- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| PR 1 | —                                         | `types.ts`, `update-orchestrator.ts`, `update-orchestrator.test.ts`, `index.ts`, `index.test.ts` |
| PR 2 | —                                         | `index.ts`, `index.test.ts`                                                                      |
| PR 3 | `mutation-log.ts`, `mutation-log.test.ts` | `page-cache.ts`, `page-cache.test.ts`, `confluence-client.ts`, `index.ts`                        |
| PR 4 | —                                         | `confluence-client.ts`, `index.ts`, `index.test.ts`                                              |

---

## Risk Assessment

| Change                                        | Risk                                                                          | Mitigation                                                                                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shrinkage guard false positive                | A legitimate large rewrite (e.g., translating a page) could trigger the guard | The `confirm_shrinkage: true` opt-out exists. Thresholds (>500 chars old, >50% reduction) are conservative.                                                                     |
| Structural integrity false positive           | A page rewrite that restructures headings could trigger                       | The `confirm_structure_loss: true` opt-out exists. Threshold (>50% heading drop) is conservative.                                                                               |
| Empty-body rejection too strict               | No opt-out — could theoretically block a legitimate edge case                 | The threshold is very permissive (100 chars of text content). Hard to hit accidentally with real content. If a real use case surfaces, add an opt-out then.                     |
| `prepend_to_page` bypasses token preservation | Prepending storage-format content to existing storage is a raw concatenation  | This is intentional and correct — the existing body is untouched, and the prepended content is already in final form. No preservation needed because nothing is being replaced. |
| Write-ahead log disk usage                    | Accumulated log files over time                                               | Log files are small (~200 bytes/record). Per-process naming limits individual file size. Document the cleanup expectation or add auto-rotation.                                 |
| `revert_page` version mismatch                | Historical version may not exist (e.g., version 0, or version beyond history) | The v1 API will return 404, which propagates as a clear error message.                                                                                                          |
| Pre-write snapshot cache pressure             | 16 parallel updates = 16 extra cache entries                                  | Consider increasing cache size from 50 to 100, or using a separate map for snapshots.                                                                                           |
