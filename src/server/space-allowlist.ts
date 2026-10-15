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
 *   2. `page_id` — a content id (page or blog post). Its type and space are
 *      resolved via a cached metadata fetch, then the space is checked. The
 *      cache has a short TTL so a moved page cannot indefinitely evade the
 *      check.
 *
 * Spec:
 *   doc/design/investigations/investigate-prompt-injection-hardening/08-capability-scoping.md
 *   §8.2
 */

import {
  ConfluenceNotFoundError,
  getCommentContainerId,
  getContent,
  getDraftBlogPost,
  getSpaceKeyById,
} from "./confluence-client.js";
import type { Config, ContentType, PageData } from "./confluence-client.js";

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
  type: ContentType;
  spaceKey: string;
  at: number;
}

/** Keyed by content id: pages and blog posts share one id space. */
class PageSpaceCache {
  private entries = new Map<string, CacheEntry>();

  get(pageId: string): ContentSpace | undefined {
    const entry = this.entries.get(pageId);
    if (entry === undefined) return undefined;
    if (Date.now() - entry.at > CACHE_TTL_MS) {
      this.entries.delete(pageId);
      return undefined;
    }
    return { type: entry.type, spaceKey: entry.spaceKey };
  }

  set(pageId: string, type: ContentType, spaceKey: string): void {
    this.entries.set(pageId, { type, spaceKey, at: Date.now() });
  }

  /** Testing only. */
  _resetForTest(): void {
    this.entries.clear();
  }
}

export const pageSpaceCache = new PageSpaceCache();

/** What the allowlist knows about a content id. */
export interface ContentSpace {
  type: ContentType;
  /** Undefined when the content carries no resolvable space. */
  spaceKey: string | undefined;
}

/**
 * Resolve the type and space key of a content id (page or blog post), using
 * the cache on a hit and a metadata read otherwise.
 *
 * Built on the read side's `getContent`: `/pages/{id}` first, `/blogposts/{id}`
 * only after a pages 404, any other error rethrown. One addition for the
 * write path: when both are 404, a never-published blog post draft may only
 * be visible with `status=draft`, so that read is tried before giving up. It
 * only ever turns a not-found into a blog post Confluence actually returned;
 * every failure of it rethrows the original not-found.
 *
 * The space key is always a KEY (never a v2 numeric space id) in the
 * canonical form Confluence stores — the caller should not mutate it before
 * comparing against the allowlist.
 *
 * Throws on network / auth / not-found errors, including a `/blogposts` 5xx
 * after a pages 404; the caller surfaces the error as-is (the space check
 * fails closed).
 */
export async function resolveContentSpace(id: string): Promise<ContentSpace> {
  const cached = pageSpaceCache.get(id);
  if (cached !== undefined) return cached;
  let content: PageData;
  let type: ContentType;
  try {
    const found = await getContent(id, false);
    content = found;
    type = found.contentType;
  } catch (err) {
    if (!(err instanceof ConfluenceNotFoundError)) throw err;
    try {
      content = await getDraftBlogPost(id, false);
    } catch {
      throw err;
    }
    type = "blogpost";
  }
  // The v2 API returns `spaceId` on page and blog post objects: a NUMERIC id
  // such as "98765", not the key. The allowlist holds keys ("DOCS"), so the
  // id must be resolved to its key (cached per tenant) before comparing. The
  // v1 shape carries `space.key` directly, so it is used as-is when present.
  // An id that cannot be resolved yields undefined and the caller fails
  // closed.
  const spaceKey =
    content.space?.key ??
    (content.spaceId !== undefined ? await getSpaceKeyById(content.spaceId) : undefined);
  if (spaceKey !== undefined) {
    pageSpaceCache.set(id, type, spaceKey);
  }
  return { type, spaceKey };
}

/** The space key alone, for callers that do not need the type. */
export async function resolvePageSpace(pageId: string): Promise<string | undefined> {
  return (await resolveContentSpace(pageId)).spaceKey;
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
 * `pageId` may be a page or a blog post id: a blog post is judged by its
 * space, like a page. This decides only which space the allowlist sees;
 * each write tool keeps its own page-only (or blog-only) checks.
 *
 * Callers must pass the settings source (resolved once at handler entry
 * via `getProfileSettings(config.profile)`); this module intentionally
 * does not import the registry to keep the dep graph clean.
 */
export async function assertSpaceAllowed(opts: {
  spaces: readonly string[] | undefined;
  spaceKey?: string;
  pageId?: string;
  /**
   * A comment the write acts on (resolve, delete, or reply to). Its space is
   * the space of the page or blog post it belongs to, found by fetching the
   * comment. Only fetched when an allowlist is active.
   */
  comment?: { id: string; type: "footer" | "inline" };
}): Promise<void> {
  const filter = resolveSpaceFilter(opts.spaces);
  if (!filter.active) return;

  let key: string | undefined;
  if (opts.spaceKey !== undefined) {
    key = opts.spaceKey;
  } else if (opts.pageId !== undefined) {
    key = await resolvePageSpace(opts.pageId);
  } else if (opts.comment !== undefined) {
    const containerId = await getCommentContainerId(opts.comment.id, opts.comment.type);
    key = containerId === undefined ? undefined : await resolvePageSpace(containerId);
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
