/**
 * Track F3: per-space profile allowlist enforcement.
 *
 * When a profile's settings carry a `spaces: string[]` allowlist, every
 * write-path tool must verify that the target space is on the list
 * before dispatching the Confluence API call. This bounds the blast
 * radius of a hijacked agent to whichever spaces the user deliberately
 * configured — an agent coerced into "delete the page at ID 12345"
 * cannot reach pages outside the allowlist, regardless of what any
 * fenced content told the model.
 *
 * Two entry points for space resolution:
 *
 *   1. `space_key` supplied directly on the tool call (create_page,
 *      list_pages, get_page_by_title). Constant-time check against the
 *      allowlist set.
 *   2. `page_id` — the page's space is resolved via a cached metadata
 *      fetch, then checked. The cache has a short TTL so a moved page
 *      cannot indefinitely evade the check.
 *
 * Spec:
 *   doc/design/investigations/investigate-prompt-injection-hardening/08-capability-scoping.md
 *   §8.2
 */

import { getPage } from "./confluence-client.js";
import type { Config } from "./confluence-client.js";

/** Error code thrown when a tool targets a space outside the allowlist. */
export const SPACE_NOT_ALLOWED = "SPACE_NOT_ALLOWED";

export class SpaceNotAllowedError extends Error {
  readonly code = SPACE_NOT_ALLOWED;
  readonly spaceKey: string;
  readonly allowed: readonly string[];
  constructor(spaceKey: string, allowed: readonly string[]) {
    super(
      `Space "${spaceKey}" is not in this profile's allowlist ` +
        `[${allowed.join(", ") || "(empty — no writes permitted)"}]. ` +
        `Either configure this space into the profile's \`spaces\` list ` +
        `(CLI: \`epimethian-mcp profiles --add-space ${spaceKey}\`) or ` +
        `retarget the operation to an allowed space.`,
    );
    this.name = "SpaceNotAllowedError";
    this.spaceKey = spaceKey;
    this.allowed = allowed;
  }
}

// -----------------------------------------------------------------------------
// Page → space cache
// -----------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  spaceKey: string;
  at: number;
}

class PageSpaceCache {
  private entries = new Map<string, CacheEntry>();

  get(pageId: string): string | undefined {
    const entry = this.entries.get(pageId);
    if (entry === undefined) return undefined;
    if (Date.now() - entry.at > CACHE_TTL_MS) {
      this.entries.delete(pageId);
      return undefined;
    }
    return entry.spaceKey;
  }

  set(pageId: string, spaceKey: string): void {
    this.entries.set(pageId, { spaceKey, at: Date.now() });
  }

  /** Testing only. */
  _resetForTest(): void {
    this.entries.clear();
  }
}

export const pageSpaceCache = new PageSpaceCache();

/**
 * Resolve the space key for a given page ID, using the cache on a hit
 * and falling back to a metadata `getPage(..., false)` call otherwise.
 *
 * The returned space key is the canonical form Confluence stores — the
 * caller should not mutate it before comparing against the allowlist.
 *
 * Throws whatever `getPage` throws on network / auth errors; the caller
 * surfaces the error to the agent as-is (space check fails closed).
 */
export async function resolvePageSpace(pageId: string): Promise<string | undefined> {
  const cached = pageSpaceCache.get(pageId);
  if (cached !== undefined) return cached;
  const page = await getPage(pageId, false);
  // The v2 API returns `spaceId` on page objects; the v1 search API returns
  // `space.key`. `getPage` uses v2, so consult `spaceId` first. We store
  // whichever key the API actually returned — the allowlist comparison
  // expects callers to use whichever form their tenant uses consistently.
  const spaceKey = page.spaceId ?? page.space?.key;
  if (spaceKey !== undefined) {
    pageSpaceCache.set(pageId, spaceKey);
  }
  return spaceKey;
}

// -----------------------------------------------------------------------------
// Allowlist check
// -----------------------------------------------------------------------------

/**
 * Return a checker that tests a space key against the profile's
 * allowlist. When the profile has no `spaces` configured, the checker
 * always returns `true` (no restriction).
 */
export function resolveSpaceFilter(
  spaces: readonly string[] | undefined,
): { allowed: (spaceKey: string) => boolean; allowedList: readonly string[]; active: boolean } {
  if (spaces === undefined) {
    return { allowed: () => true, allowedList: [], active: false };
  }
  const set = new Set(spaces);
  return {
    allowed: (k) => set.has(k),
    allowedList: spaces,
    active: true,
  };
}

/**
 * Assert that a tool call targeting either `spaceKey` or `pageId` is
 * within the profile's space allowlist. No-op when the profile has no
 * allowlist configured. Throws `SpaceNotAllowedError` otherwise.
 *
 * Callers must pass the settings source (resolved once at handler entry
 * via `getProfileSettings(config.profile)`); this module intentionally
 * does not import the registry to keep the dep graph clean.
 */
export async function assertSpaceAllowed(opts: {
  spaces: readonly string[] | undefined;
  spaceKey?: string;
  pageId?: string;
}): Promise<void> {
  const filter = resolveSpaceFilter(opts.spaces);
  if (!filter.active) return;

  let key: string | undefined;
  if (opts.spaceKey !== undefined) {
    key = opts.spaceKey;
  } else if (opts.pageId !== undefined) {
    key = await resolvePageSpace(opts.pageId);
  }

  if (key === undefined) {
    // We couldn't determine the space — fail closed rather than proceed.
    throw new SpaceNotAllowedError(
      "(unresolvable)",
      filter.allowedList,
    );
  }

  if (!filter.allowed(key)) {
    throw new SpaceNotAllowedError(key, filter.allowedList);
  }
}

/**
 * Unused reference to `Config` to keep the type import in force during
 * future edits that thread a full `config` object through handlers. Not
 * called at runtime.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ConfigRef = Config;
