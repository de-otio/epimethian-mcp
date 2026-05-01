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
  };
});

import { getPage } from "./confluence-client.js";
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
      spaceId: "DOCS",
    });
    await expect(
      assertSpaceAllowed({ spaces: ["DOCS"], pageId: "42" }),
    ).resolves.toBeUndefined();
    expect(getPage).toHaveBeenCalledOnce();
  });

  it("F3: rejects pageId whose space is outside the allowlist", async () => {
    (getPage as any).mockResolvedValueOnce({
      id: "42",
      title: "P",
      spaceId: "OPS",
    });
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
      spaceId: "DOCS",
    });
    await assertSpaceAllowed({ spaces: ["DOCS"], pageId: "42" });
    await assertSpaceAllowed({ spaces: ["DOCS"], pageId: "42" });
    await assertSpaceAllowed({ spaces: ["DOCS"], pageId: "42" });
    // Only the first resolve hits the network; subsequent hit the cache.
    expect(getPage).toHaveBeenCalledOnce();
  });

  it("F3: empty spaces array rejects all pageIds (paranoid no-write profile)", async () => {
    (getPage as any).mockResolvedValueOnce({
      id: "42",
      title: "P",
      spaceId: "DOCS",
    });
    await expect(
      assertSpaceAllowed({ spaces: [], pageId: "42" }),
    ).rejects.toBeInstanceOf(SpaceNotAllowedError);
  });
});

describe("resolvePageSpace (F3)", () => {
  beforeEach(() => {
    pageSpaceCache._resetForTest();
    (getPage as any).mockReset();
  });

  it("F3: reads spaceId from v2 page metadata", async () => {
    (getPage as any).mockResolvedValueOnce({
      id: "1",
      title: "T",
      spaceId: "DOCS",
    });
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
