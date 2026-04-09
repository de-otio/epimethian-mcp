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
});
