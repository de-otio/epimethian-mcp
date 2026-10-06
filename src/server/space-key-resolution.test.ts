/**
 * M13: the v2 pages API returns `spaceId`, a NUMERIC space id, never the key.
 * The `spaces` allowlist holds keys, so before this fix every page_id-based
 * write check compared "98765" against ["DOCS"] and failed closed. These tests
 * use the real client with a mocked `fetch`, so they exercise the actual
 * id -> key resolution rather than a fixture that hides it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://test.atlassian.net";
  process.env.CONFLUENCE_EMAIL = "user@example.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
});

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: vi.fn().mockResolvedValue(null),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

import {
  ConfluenceNotFoundError,
  _resetSpaceKeyCacheForTests,
  getSpaceKeyById,
} from "./confluence-client.js";
import {
  SpaceNotAllowedError,
  assertSpaceAllowed,
  pageSpaceCache,
} from "./space-allowlist.js";

const API_V2 = "https://test.atlassian.net/wiki/api/v2";

type Route = { status?: number; body: unknown };

/** Mock fetch keyed by URL path; unmatched requests fail the test. */
function stubFetch(routes: Record<string, Route>) {
  const fn = vi.fn(async (input: unknown) => {
    const path = new URL(String(input)).pathname.replace("/wiki/api/v2", "");
    const route = routes[path];
    if (route === undefined) throw new Error(`unexpected fetch: ${path}`);
    const status = route.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route.body,
      text: async () => JSON.stringify(route.body),
    };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const calledPaths = (fn: ReturnType<typeof stubFetch>): string[] =>
  fn.mock.calls.map(([u]) => new URL(String(u)).pathname.replace("/wiki/api/v2", ""));

const PAGE_42 = { id: "42", title: "Page", spaceId: "98765", version: { number: 3 } };
const SPACE_98765 = { id: "98765", key: "DOCS", name: "Documentation", type: "global" };

beforeEach(() => {
  _resetSpaceKeyCacheForTests();
  pageSpaceCache._resetForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getSpaceKeyById", () => {
  it("resolves a numeric id through GET /spaces/{id}", async () => {
    const fetchFn = stubFetch({ "/spaces/98765": { body: SPACE_98765 } });
    await expect(getSpaceKeyById("98765")).resolves.toBe("DOCS");
    expect(calledPaths(fetchFn)).toEqual(["/spaces/98765"]);
    expect(String(fetchFn.mock.calls[0][0])).toBe(`${API_V2}/spaces/98765`);
  });

  it("caches hits per tenant: a second lookup makes no request", async () => {
    const fetchFn = stubFetch({ "/spaces/98765": { body: SPACE_98765 } });
    await getSpaceKeyById("98765");
    await getSpaceKeyById("98765");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("does not cache failures", async () => {
    const fetchFn = stubFetch({ "/spaces/98765": { status: 404, body: { message: "gone" } } });
    await expect(getSpaceKeyById("98765")).rejects.toBeInstanceOf(ConfluenceNotFoundError);
    await expect(getSpaceKeyById("98765")).rejects.toBeInstanceOf(ConfluenceNotFoundError);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("refuses a non-numeric id without making a request (the id is spliced into a path)", async () => {
    const fetchFn = stubFetch({});
    for (const bad of ["DOCS", "../pages/1", "12 34", "", "1/2"]) {
      await expect(getSpaceKeyById(bad)).resolves.toBeUndefined();
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns undefined when the response carries an empty key", async () => {
    stubFetch({ "/spaces/98765": { body: { ...SPACE_98765, key: "" } } });
    await expect(getSpaceKeyById("98765")).resolves.toBeUndefined();
  });
});

describe("assertSpaceAllowed with a real v2 page response (M13)", () => {
  it("accepts a page whose numeric spaceId resolves to an allowlisted key", async () => {
    stubFetch({
      "/pages/42": { body: PAGE_42 },
      "/spaces/98765": { body: SPACE_98765 },
    });
    await expect(assertSpaceAllowed({ spaces: ["DOCS"], pageId: "42" })).resolves.toBeUndefined();
  });

  it("rejects a page whose resolved key is not on the allowlist, naming the key", async () => {
    stubFetch({
      "/pages/42": { body: PAGE_42 },
      "/spaces/98765": { body: SPACE_98765 },
    });
    const err = await assertSpaceAllowed({ spaces: ["TEAM"], pageId: "42" }).catch((e) => e);
    expect(err).toBeInstanceOf(SpaceNotAllowedError);
    expect((err as SpaceNotAllowedError).spaceKey).toBe("DOCS");
  });

  it("does not treat the numeric id as a key: an allowlist of ids matches nothing", async () => {
    stubFetch({
      "/pages/42": { body: PAGE_42 },
      "/spaces/98765": { body: SPACE_98765 },
    });
    await expect(assertSpaceAllowed({ spaces: ["98765"], pageId: "42" })).rejects.toBeInstanceOf(
      SpaceNotAllowedError,
    );
  });

  it("fails closed when the space lookup fails", async () => {
    stubFetch({
      "/pages/42": { body: PAGE_42 },
      "/spaces/98765": { status: 403, body: { message: "no permission" } },
    });
    await expect(assertSpaceAllowed({ spaces: ["DOCS"], pageId: "42" })).rejects.toThrow();
  });

  it("fails closed when the spaceId is not a numeric id", async () => {
    stubFetch({ "/pages/42": { body: { ...PAGE_42, spaceId: "DOCS" } } });
    const err = await assertSpaceAllowed({ spaces: ["DOCS"], pageId: "42" }).catch((e) => e);
    expect(err).toBeInstanceOf(SpaceNotAllowedError);
    expect((err as SpaceNotAllowedError).spaceKey).toBe("(unresolvable)");
  });

  it("looks a space up once for many pages in it", async () => {
    const fetchFn = stubFetch({
      "/pages/42": { body: PAGE_42 },
      "/pages/43": { body: { ...PAGE_42, id: "43" } },
      "/spaces/98765": { body: SPACE_98765 },
    });
    await assertSpaceAllowed({ spaces: ["DOCS"], pageId: "42" });
    await assertSpaceAllowed({ spaces: ["DOCS"], pageId: "43" });
    expect(calledPaths(fetchFn).filter((p) => p.startsWith("/spaces/"))).toEqual(["/spaces/98765"]);
  });

  it("an empty allowlist still rejects every page", async () => {
    stubFetch({
      "/pages/42": { body: PAGE_42 },
      "/spaces/98765": { body: SPACE_98765 },
    });
    await expect(assertSpaceAllowed({ spaces: [], pageId: "42" })).rejects.toBeInstanceOf(
      SpaceNotAllowedError,
    );
  });
});
