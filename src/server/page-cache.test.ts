import { describe, it, expect, beforeEach } from "vitest";
import { PageCache } from "./page-cache.js";

describe("PageCache", () => {
  let cache: PageCache;

  beforeEach(() => {
    cache = new PageCache(3); // small capacity for testing eviction
  });

  it("returns undefined for empty cache", () => {
    expect(cache.get("1", 1)).toBeUndefined();
  });

  it("returns body when page_id and version match", () => {
    cache.set("1", 5, "<p>hello</p>");
    expect(cache.get("1", 5)).toBe("<p>hello</p>");
  });

  it("returns undefined when version does not match", () => {
    cache.set("1", 5, "<p>hello</p>");
    expect(cache.get("1", 6)).toBeUndefined();
  });

  it("overwrites entry for same pageId", () => {
    cache.set("1", 5, "<p>old</p>");
    cache.set("1", 6, "<p>new</p>");
    expect(cache.get("1", 5)).toBeUndefined();
    expect(cache.get("1", 6)).toBe("<p>new</p>");
    expect(cache.size).toBe(1);
  });

  it("evicts oldest entry when at capacity", () => {
    cache.set("a", 1, "A");
    cache.set("b", 1, "B");
    cache.set("c", 1, "C");
    // Cache is full (3). Adding "d" should evict "a".
    cache.set("d", 1, "D");
    expect(cache.get("a", 1)).toBeUndefined();
    expect(cache.get("b", 1)).toBe("B");
    expect(cache.get("d", 1)).toBe("D");
    expect(cache.size).toBe(3);
  });

  it("promotes recently accessed entries so they survive eviction", () => {
    cache.set("a", 1, "A");
    cache.set("b", 1, "B");
    cache.set("c", 1, "C");
    // Access "a" to promote it
    cache.get("a", 1);
    // Adding "d" should evict "b" (oldest after "a" was promoted)
    cache.set("d", 1, "D");
    expect(cache.get("a", 1)).toBe("A");
    expect(cache.get("b", 1)).toBeUndefined();
  });

  it("delete removes specific entry", () => {
    cache.set("1", 5, "body");
    cache.delete("1");
    expect(cache.get("1", 5)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("clear empties the cache", () => {
    cache.set("1", 1, "A");
    cache.set("2", 1, "B");
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("1", 1)).toBeUndefined();
  });

  it("has returns version when cached", () => {
    cache.set("1", 7, "body");
    expect(cache.has("1")).toEqual({ version: 7 });
  });

  it("has returns undefined when not cached", () => {
    expect(cache.has("999")).toBeUndefined();
  });

  it("size returns correct count", () => {
    expect(cache.size).toBe(0);
    cache.set("1", 1, "A");
    expect(cache.size).toBe(1);
    cache.set("2", 1, "B");
    expect(cache.size).toBe(2);
    cache.delete("1");
    expect(cache.size).toBe(1);
  });

  // --- Versioned cache methods ---

  describe("getVersioned / setVersioned", () => {
    it("getVersioned returns undefined for empty cache", () => {
      expect(cache.getVersioned("1", 3)).toBeUndefined();
    });

    it("getVersioned returns body when pageId + version match", () => {
      cache.setVersioned("1", 3, "<p>v3</p>");
      expect(cache.getVersioned("1", 3)).toBe("<p>v3</p>");
    });

    it("stores independently from current-version set (same pageId, both accessible)", () => {
      cache.set("1", 5, "<p>current</p>");
      cache.setVersioned("1", 3, "<p>historical</p>");
      // Both accessible
      expect(cache.get("1", 5)).toBe("<p>current</p>");
      expect(cache.getVersioned("1", 3)).toBe("<p>historical</p>");
      expect(cache.size).toBe(2);
    });

    it("versioned entries participate in LRU eviction alongside regular entries", () => {
      cache.set("a", 1, "current-a");         // slot 1
      cache.setVersioned("b", 2, "hist-b-v2"); // slot 2
      cache.setVersioned("b", 3, "hist-b-v3"); // slot 3
      // Cache is full (3). Adding another evicts oldest ("a" current).
      cache.setVersioned("c", 1, "hist-c-v1");
      expect(cache.get("a", 1)).toBeUndefined();
      expect(cache.getVersioned("b", 2)).toBe("hist-b-v2");
    });

    it("two different versions of the same page coexist", () => {
      cache.setVersioned("1", 2, "<p>v2</p>");
      cache.setVersioned("1", 5, "<p>v5</p>");
      expect(cache.getVersioned("1", 2)).toBe("<p>v2</p>");
      expect(cache.getVersioned("1", 5)).toBe("<p>v5</p>");
      expect(cache.size).toBe(2);
    });
  });

  // --- Pre-write snapshot methods (1F) ---

  describe("setSnapshot / getSnapshot (1F)", () => {
    it("stores and retrieves a pre-write snapshot", () => {
      cache.setSnapshot("1", 5, "<p>before</p>");
      expect(cache.getSnapshot("1", 5)).toBe("<p>before</p>");
    });

    it("returns undefined when no snapshot exists", () => {
      expect(cache.getSnapshot("1", 5)).toBeUndefined();
    });

    it("snapshots are isolated from the main cache (Finding 10)", () => {
      cache.set("1", 5, "<p>current</p>");
      cache.setSnapshot("1", 5, "<p>snapshot</p>");
      // Both coexist without collision
      expect(cache.get("1", 5)).toBe("<p>current</p>");
      expect(cache.getSnapshot("1", 5)).toBe("<p>snapshot</p>");
    });

    it("snapshots do not count toward main cache size", () => {
      cache.set("a", 1, "A");
      cache.set("b", 1, "B");
      cache.set("c", 1, "C");
      // Main cache is full (3), but snapshot goes to separate map
      cache.setSnapshot("d", 1, "snap-D");
      expect(cache.size).toBe(3); // main cache unchanged
      expect(cache.snapshotSize).toBe(1);
      // All main entries still accessible
      expect(cache.get("a", 1)).toBe("A");
    });

    it("snapshot eviction is independent of main cache eviction", () => {
      const smallCache = new PageCache(3, 2); // 3 main, 2 snapshots
      smallCache.setSnapshot("a", 1, "snap-A");
      smallCache.setSnapshot("b", 1, "snap-B");
      // Snapshot map is full (2). Adding "c" evicts oldest ("a").
      smallCache.setSnapshot("c", 1, "snap-C");
      expect(smallCache.getSnapshot("a", 1)).toBeUndefined();
      expect(smallCache.getSnapshot("b", 1)).toBe("snap-B");
      expect(smallCache.getSnapshot("c", 1)).toBe("snap-C");
    });

    it("promotes recently accessed snapshots (LRU)", () => {
      const smallCache = new PageCache(3, 2);
      smallCache.setSnapshot("a", 1, "snap-A");
      smallCache.setSnapshot("b", 1, "snap-B");
      // Access "a" to promote it
      smallCache.getSnapshot("a", 1);
      // Adding "c" should evict "b" (oldest after "a" was promoted)
      smallCache.setSnapshot("c", 1, "snap-C");
      expect(smallCache.getSnapshot("a", 1)).toBe("snap-A");
      expect(smallCache.getSnapshot("b", 1)).toBeUndefined();
    });

    it("clear empties both main cache and snapshots", () => {
      cache.set("1", 1, "main");
      cache.setSnapshot("1", 1, "snap");
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.snapshotSize).toBe(0);
      expect(cache.get("1", 1)).toBeUndefined();
      expect(cache.getSnapshot("1", 1)).toBeUndefined();
    });
  });
});
