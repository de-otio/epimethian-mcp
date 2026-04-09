/**
 * In-memory, version-keyed page cache for reducing redundant API fetches
 * during iterative editing sessions.
 *
 * Safety: keyed by page_id only because the multi-tenant architecture
 * enforces one process per profile (one Confluence tenant per process).
 * See investigate-token-efficiency.md Phase 4 for the full safety analysis.
 */
export class PageCache {
  private cache = new Map<string, { version: number; body: string }>();
  private maxSize: number;

  constructor(maxSize: number = 50) {
    this.maxSize = maxSize;
  }

  /** Return cached body if page_id exists and version matches. */
  get(pageId: string, version: number): string | undefined {
    const entry = this.cache.get(pageId);
    if (entry && entry.version === version) {
      // Promote to most-recently-used (delete + re-insert)
      this.cache.delete(pageId);
      this.cache.set(pageId, entry);
      return entry.body;
    }
    return undefined;
  }

  /** Store a page body. Evicts the oldest entry if at capacity. */
  set(pageId: string, version: number, body: string): void {
    // Delete first so re-insert moves to end (most recent)
    this.cache.delete(pageId);
    if (this.cache.size >= this.maxSize) {
      // Evict oldest (first key in Map iteration order)
      const oldest = this.cache.keys().next().value!;
      this.cache.delete(oldest);
    }
    this.cache.set(pageId, { version, body });
  }

  /** Check if a page is cached; returns its version or undefined. */
  has(pageId: string): { version: number } | undefined {
    const entry = this.cache.get(pageId);
    return entry ? { version: entry.version } : undefined;
  }

  /**
   * Return cached body for a specific historical version.
   * Uses composite key `${pageId}:v${version}` to coexist with current-version entries.
   */
  getVersioned(pageId: string, version: number): string | undefined {
    const key = `${pageId}:v${version}`;
    const entry = this.cache.get(key);
    if (entry) {
      // Promote to most-recently-used
      this.cache.delete(key);
      this.cache.set(key, entry);
      return entry.body;
    }
    return undefined;
  }

  /**
   * Store a historical version body.
   * Uses composite key `${pageId}:v${version}` so multiple versions of the
   * same page can coexist alongside the current-version entry.
   */
  setVersioned(pageId: string, version: number, body: string): void {
    const key = `${pageId}:v${version}`;
    this.cache.delete(key);
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value!;
      this.cache.delete(oldest);
    }
    this.cache.set(key, { version, body });
  }

  /** Remove a specific page from the cache. */
  delete(pageId: string): void {
    this.cache.delete(pageId);
  }

  /** Empty the cache. */
  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

export const pageCache = new PageCache();
