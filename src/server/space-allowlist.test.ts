import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://test.atlassian.net";
  process.env.CONFLUENCE_EMAIL = "user@test.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
});

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: vi.fn().mockResolvedValue(null),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

vi.mock("./confluence-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./confluence-client.js")>();
  return {
    ...actual,
    getPage: vi.fn(),
    getSpaceKeyById: vi.fn(),
  };
});

import { getPage, getSpaceKeyById } from "./confluence-client.js";
import {
  SPACE_NOT_ALLOWED,
  SpaceNotAllowedError,
  assertSpaceAllowed,
  pageSpaceCache,
  resolvePageSpace,
  resolveSpaceFilter,
} from "./space-allowlist.js";

describe("resolveSpaceFilter (F3)", () => {
  it("F3: undefined spaces → inactive filter (all pass)", () => {
    const f = resolveSpaceFilter(undefined);
    expect(f.active).toBe(false);
    expect(f.allowed("ANY")).toBe(true);
  });

  it("F3: empty array → active filter that rejects every space", () => {
    const f = resolveSpaceFilter([]);
    expect(f.active).toBe(true);
    expect(f.allowed("DOCS")).toBe(false);
  });

  it("F3: populated list → allowed iff in set", () => {
    const f = resolveSpaceFilter(["DOCS", "SANDBOX"]);
    expect(f.active).toBe(true);
    expect(f.allowed("DOCS")).toBe(true);
    expect(f.allowed("OPS")).toBe(false);
  });

  it("F3: case-sensitive match (no implicit uppercasing)", () => {
    const f = resolveSpaceFilter(["docs"]);
    expect(f.allowed("docs")).toBe(true);
    expect(f.allowed("DOCS")).toBe(false);
  });
});

describe("assertSpaceAllowed (F3)", () => {
  beforeEach(() => {
    pageSpaceCache._resetForTest();
    (getPage as any).mockReset();
    (getSpaceKeyById as any).mockReset();
  });

  afterEach(() => {
    pageSpaceCache._resetForTest();
  });

  it("F3: no-op when profile has no spaces allowlist", async () => {
    await expect(
      assertSpaceAllowed({ spaces: undefined, spaceKey: "OPS" }),
    ).resolves.toBeUndefined();
    // No metadata fetch needed when the filter is inactive.
    expect(getPage).not.toHaveBeenCalled();
  });

  it("F3: accepts spaceKey on the allowlist", async () => {
    await expect(
      assertSpaceAllowed({ spaces: ["DOCS"], spaceKey: "DOCS" }),
    ).resolves.toBeUndefined();
  });

  it("F3: rejects spaceKey outside the allowlist", async () => {
    try {
      await assertSpaceAllowed({ spaces: ["DOCS"], spaceKey: "OPS" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SpaceNotAllowedError);
      expect((err as SpaceNotAllowedError).code).toBe(SPACE_NOT_ALLOWED);
      expect((err as SpaceNotAllowedError).spaceKey).toBe("OPS");
    }
  });

  it("F3: resolves pageId to space via getPage and accepts when allowed", async () => {
    (getPage as any).mockResolvedValueOnce({
      id: "42",
      title: "P",
      spaceId: "1001",
    });
    (getSpaceKeyById as any).mockResolvedValueOnce("DOCS");
    await expect(
      assertSpaceAllowed({ spaces: ["DOCS"], pageId: "42" }),
    ).resolves.toBeUndefined();
    expect(getPage).toHaveBeenCalledOnce();
    expect(getSpaceKeyById).toHaveBeenCalledWith("1001");
  });

  it("F3: rejects pageId whose space is outside the allowlist", async () => {
    (getPage as any).mockResolvedValueOnce({
      id: "42",
      title: "P",
      spaceId: "1002",
    });
    (getSpaceKeyById as any).mockResolvedValueOnce("OPS");
    await expect(
      assertSpaceAllowed({ spaces: ["DOCS"], pageId: "42" }),
    ).rejects.toBeInstanceOf(SpaceNotAllowedError);
  });

  it("F3: fails closed when the page's space cannot be determined", async () => {
    (getPage as any).mockResolvedValueOnce({
      id: "42",
      title: "P",
      // spaceId and space.key both missing.
    });
    try {
      await assertSpaceAllowed({ spaces: ["DOCS"], pageId: "42" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SpaceNotAllowedError);
      expect((err as SpaceNotAllowedError).spaceKey).toBe("(unresolvable)");
    }
  });

  it("F3: caches the page→space mapping across consecutive resolves", async () => {
    (getPage as any).mockResolvedValueOnce({
      id: "42",
      title: "P",
      spaceId: "1001",
    });
    (getSpaceKeyById as any).mockResolvedValueOnce("DOCS");
    await assertSpaceAllowed({ spaces: ["DOCS"], pageId: "42" });
    await assertSpaceAllowed({ spaces: ["DOCS"], pageId: "42" });
    await assertSpaceAllowed({ spaces: ["DOCS"], pageId: "42" });
    // Only the first resolve hits the network; subsequent hit the cache.
    expect(getPage).toHaveBeenCalledOnce();
    expect(getSpaceKeyById).toHaveBeenCalledOnce();
  });

  it("F3: the page→space cache is keyed per page id (no cross-page leakage)", async () => {
    (getPage as any).mockImplementation(async (id: string) => ({
      id,
      title: "P",
      spaceId: id === "42" ? "1001" : "1002",
    }));
    (getSpaceKeyById as any).mockImplementation(async (sid: string) =>
      sid === "1001" ? "DOCS" : "OPS",
    );
    expect(await resolvePageSpace("42")).toBe("DOCS");
    expect(await resolvePageSpace("43")).toBe("OPS");
    // Second visits come from the cache and still round-trip independently.
    expect(await resolvePageSpace("42")).toBe("DOCS");
    expect(await resolvePageSpace("43")).toBe("OPS");
    expect(getPage).toHaveBeenCalledTimes(2);
    await expect(assertSpaceAllowed({ spaces: ["DOCS"], pageId: "43" })).rejects.toBeInstanceOf(
      SpaceNotAllowedError,
    );
    await expect(
      assertSpaceAllowed({ spaces: ["DOCS"], pageId: "42" }),
    ).resolves.toBeUndefined();
  });

  describe("cache TTL", () => {
    const TTL_MS = 5 * 60 * 1000;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("F3: still serves the cache at exactly the TTL, then re-resolves a moved page and rejects it", async () => {
      (getPage as any).mockResolvedValueOnce({ id: "42", title: "P", spaceId: "1001" });
      (getSpaceKeyById as any).mockResolvedValueOnce("DOCS");
      expect(await resolvePageSpace("42")).toBe("DOCS");

      // Boundary: exactly TTL old is still fresh.
      vi.setSystemTime(Date.now() + TTL_MS);
      await expect(
        assertSpaceAllowed({ spaces: ["DOCS"], pageId: "42" }),
      ).resolves.toBeUndefined();
      expect(getPage).toHaveBeenCalledOnce();

      // One millisecond past the TTL the entry is expired; the page has moved.
      vi.setSystemTime(Date.now() + 1);
      (getPage as any).mockResolvedValueOnce({ id: "42", title: "P", spaceId: "1002" });
      (getSpaceKeyById as any).mockResolvedValueOnce("OPS");
      await expect(assertSpaceAllowed({ spaces: ["DOCS"], pageId: "42" })).rejects.toBeInstanceOf(
        SpaceNotAllowedError,
      );
      expect(getPage).toHaveBeenCalledTimes(2);
      expect(getSpaceKeyById).toHaveBeenCalledTimes(2);
    });
  });

  it("F3: empty spaces array rejects all pageIds (paranoid no-write profile)", async () => {
    (getPage as any).mockResolvedValueOnce({
      id: "42",
      title: "P",
      spaceId: "1001",
    });
    (getSpaceKeyById as any).mockResolvedValueOnce("DOCS");
    await expect(
      assertSpaceAllowed({ spaces: [], pageId: "42" }),
    ).rejects.toBeInstanceOf(SpaceNotAllowedError);
  });
});

describe("resolvePageSpace (F3)", () => {
  beforeEach(() => {
    pageSpaceCache._resetForTest();
    (getPage as any).mockReset();
    (getSpaceKeyById as any).mockReset();
  });

  it("F3: resolves the v2 numeric spaceId to its space key", async () => {
    (getPage as any).mockResolvedValueOnce({
      id: "1",
      title: "T",
      spaceId: "1001",
    });
    (getSpaceKeyById as any).mockResolvedValueOnce("DOCS");
    expect(await resolvePageSpace("1")).toBe("DOCS");
  });

  it("F3: falls back to space.key when spaceId is absent (v1 shape)", async () => {
    (getPage as any).mockResolvedValueOnce({
      id: "1",
      title: "T",
      space: { key: "LEGACY" },
    });
    expect(await resolvePageSpace("1")).toBe("LEGACY");
  });

  it("F3: returns undefined when page has no space attribute", async () => {
    (getPage as any).mockResolvedValueOnce({ id: "1", title: "T" });
    expect(await resolvePageSpace("1")).toBeUndefined();
  });
});
