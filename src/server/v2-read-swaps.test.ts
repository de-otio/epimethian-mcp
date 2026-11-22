/**
 * W-V2READ (plans/next-release-sdk2-and-v2-api.md section 5.2): the v1 reads
 * that moved to v2 — attachments list and lookup, version list, labels.
 *
 * Two layers, both with a stubbed `fetch` (no live Confluence):
 *   - client functions called directly, asserting the REQUEST URL for page and
 *     blog post ids as well as the output;
 *   - real tool handlers (add_attachment overwrite, get_page_versions) over a
 *     small fake server, for what the handlers do with the answers.
 *
 * Each test is written to fail on the pre-change (v1) code or on a plausible
 * wrong implementation (substring match, first-of-two match, unchecked cursor,
 * oldest-first order, failing read when the author lookup fails).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://test.atlassian.net";
  process.env.CONFLUENCE_EMAIL = "user@test.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
  process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "0";
  process.env.EPIMETHIAN_WRITE_BUDGET_HOURLY = "0";
  process.env.EPIMETHIAN_MUTATION_LOG = "false";
  delete process.env.EPIMETHIAN_ALLOW_UNGATED_WRITES;
  delete process.env.EPIMETHIAN_BYPASS_ELICITATION;
  delete process.env.EPIMETHIAN_DISABLE_SOFT_CONFIRM;
});

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: vi.fn().mockResolvedValue(null),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

const mockRegisterTool = vi.fn();

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(function () {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      registerTool: mockRegisterTool,
      server: {
        getClientVersion: () => ({ name: "test-client", version: "1.0.0" }),
        // No elicitation: confirmations take the soft (token) path.
        getClientCapabilities: () => ({}),
        elicitInput: vi.fn(),
      },
    };
  }),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

vi.mock("../shared/update-check.js", () => ({
  checkForUpdates: vi.fn().mockResolvedValue(null),
  getPendingUpdate: vi.fn().mockResolvedValue(null),
  clearPendingUpdate: vi.fn().mockResolvedValue(undefined),
  performUpgrade: vi.fn().mockResolvedValue("installed"),
}));

vi.mock("../shared/profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/profiles.js")>();
  return { ...actual, getProfileSettings: vi.fn(async () => undefined) };
});

vi.mock("./mutation-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mutation-log.js")>();
  return { ...actual, initMutationLog: vi.fn(), logMutation: vi.fn() };
});

vi.mock("./upload-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./upload-file.js")>();
  return {
    ...actual,
    readUploadFile: vi.fn(async (p: string) => ({ path: p, data: Buffer.from("file-bytes") })),
  };
});

vi.mock("./confluence-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./confluence-client.js")>();
  return {
    ...actual,
    validateStartup: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn(async () => ({
      ...(await actual.getConfig()),
      profile: "v2-read-test",
      sealedCloudId: "cloud-v2-read-test",
    })),
  };
});

import {
  findAttachmentByName,
  getAttachments,
  getLabels,
  getPageVersions,
  exactAttachmentMatches,
  uploadAttachmentVersion,
  MAX_V2_LIST_PAGES,
  _resetContentTypeMemoForTests,
  _resetUserNameCacheForTests,
  _resetHttpStateForTests,
} from "./confluence-client.js";
import { resolveV2NextLink } from "./pagination-cursor.js";
import { pageCache } from "./page-cache.js";

// ---------------------------------------------------------------------------
// Stub fetch
// ---------------------------------------------------------------------------

type Req = { method: string; url: URL; body: unknown };
const requests: Req[] = [];
let route: (req: Req) => Response | undefined = () => undefined;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = (init?.method ?? "GET").toUpperCase();
  let body: unknown;
  if (typeof init?.body === "string") {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
  } else if (init?.body !== undefined) {
    body = "(form-data)";
  }
  const req = { method, url, body };
  requests.push(req);
  return route(req) ?? json({ message: `unexpected ${method} ${url.pathname}` }, 404);
});

const V2 = "/wiki/api/v2";
const V1 = "/wiki/rest/api";
const paths = () => requests.map((r) => r.url.pathname);

let errSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", fetchMock);
});

afterAll(() => {
  vi.unstubAllGlobals();
  errSpy.mockRestore();
});

beforeEach(() => {
  requests.length = 0;
  route = () => undefined;
  fetchMock.mockClear();
  _resetHttpStateForTests();
  _resetContentTypeMemoForTests();
  _resetUserNameCacheForTests();
  pageCache.clear();
});

const att = (n: number, over: Record<string, unknown> = {}) => ({
  id: `att${n}`,
  title: `f${n}.png`,
  mediaType: "image/png",
  fileSize: 100 + n,
  version: { number: 1 },
  downloadLink: `/download/attachments/1/f${n}.png`,
  ...over,
});

/** Answer `GET {path}` with `results`, and only that path. */
const listRoute =
  (path: string, results: unknown[]) =>
  (r: Req): Response | undefined =>
    r.method === "GET" && r.url.pathname === path ? json({ results }) : undefined;

// ===========================================================================
// getAttachments
// ===========================================================================

describe("getAttachments on v2", () => {
  it("page id: one GET to /pages/{id}/attachments, never the v1 endpoint", async () => {
    route = listRoute(`${V2}/pages/11/attachments`, [att(1)]);
    const out = await getAttachments("11", 25);
    expect(paths()).toEqual([`${V2}/pages/11/attachments`]);
    expect(requests[0].url.searchParams.get("limit")).toBe("25");
    expect(paths().some((p) => p.includes("/rest/api/"))).toBe(false);
    expect(out).toEqual([
      {
        id: "att1",
        title: "f1.png",
        version: { number: 1 },
        extensions: { fileSize: 101, mediaType: "image/png" },
        _links: { download: "/download/attachments/1/f1.png" },
      },
    ]);
  });

  it("blog post id: tries pages, gets a 404, then reads /blogposts/{id}/attachments", async () => {
    route = listRoute(`${V2}/blogposts/12/attachments`, [att(2)]);
    const out = await getAttachments("12", 25);
    expect(paths()).toEqual([`${V2}/pages/12/attachments`, `${V2}/blogposts/12/attachments`]);
    expect(out.map((a) => a.title)).toEqual(["f2.png"]);
  });

  it("a known content type goes straight to its endpoint (blog post: no /pages request)", async () => {
    route = listRoute(`${V2}/blogposts/12/attachments`, [att(2)]);
    await getAttachments("12", 25, { contentType: "blogpost" });
    expect(paths()).toEqual([`${V2}/blogposts/12/attachments`]);
  });

  it("an id that is neither: one combined not-found", async () => {
    await expect(getAttachments("13", 25)).rejects.toThrow(/No page or blog post with id 13/);
    expect(paths()).toEqual([`${V2}/pages/13/attachments`, `${V2}/blogposts/13/attachments`]);
  });

  it("a non-numeric id never reaches a URL", async () => {
    await expect(getAttachments("11/../../x", 25)).rejects.toThrow(/Invalid content id/);
    expect(requests).toHaveLength(0);
  });

  it("a blog post draft keeps the v1 listing with status=draft (v2 has no draft listing)", async () => {
    route = (r) =>
      r.url.pathname === `${V1}/content/14/child/attachment`
        ? json({ results: [{ id: "att7", title: "d.png", version: { number: 1 } }] })
        : undefined;
    const out = await getAttachments("14", 25, { draft: true });
    expect(paths()).toEqual([`${V1}/content/14/child/attachment`]);
    expect(requests[0].url.searchParams.get("status")).toBe("draft");
    expect(out[0].title).toBe("d.png");
  });

  it("follows the cursor through three pages and returns them in order", async () => {
    route = (r) => {
      if (r.url.pathname !== `${V2}/pages/11/attachments`) return undefined;
      const cursor = r.url.searchParams.get("cursor");
      if (cursor === null) {
        return json({ results: [att(1), att(2)], _links: { next: `${V2}/pages/11/attachments?cursor=c2&limit=2` } });
      }
      if (cursor === "c2") {
        return json({ results: [att(3), att(4)], _links: { next: `${V2}/pages/11/attachments?cursor=c3&limit=2` } });
      }
      return json({ results: [att(5)], _links: {} });
    };
    const out = await getAttachments("11", 10);
    expect(out.map((a) => a.title)).toEqual(["f1.png", "f2.png", "f3.png", "f4.png", "f5.png"]);
    expect(requests.map((r) => r.url.searchParams.get("cursor"))).toEqual([null, "c2", "c3"]);
  });

  it("stops following the cursor once `limit` items are in hand", async () => {
    route = (r) =>
      r.url.pathname === `${V2}/pages/11/attachments`
        ? json({ results: [att(1), att(2)], _links: { next: `${V2}/pages/11/attachments?cursor=c2` } })
        : undefined;
    const out = await getAttachments("11", 2);
    expect(out).toHaveLength(2);
    expect(requests).toHaveLength(1);
  });

  it.each([
    ["another origin", "https://evil.example/wiki/api/v2/pages/11/attachments?cursor=x"],
    ["a host that merely starts with the site host", "https://test.atlassian.net.evil.example/wiki/api/v2/pages/11/attachments?cursor=x"],
    ["credentials in the URL", "https://test.atlassian.net@evil.example/wiki/api/v2/pages/11/attachments?cursor=x"],
    ["a protocol-relative link", "//evil.example/wiki/api/v2/pages/11/attachments?cursor=x"],
    ["a downgrade to http", "http://test.atlassian.net/wiki/api/v2/pages/11/attachments?cursor=x"],
    ["the v1 API on the same origin", "/wiki/rest/api/content/11/child/attachment?cursor=x"],
    ["another page's attachments", "/wiki/api/v2/pages/99/attachments?cursor=x"],
  ])("refuses a cursor pointing at %s, and sends nothing to it", async (_name, next) => {
    route = (r) =>
      r.url.pathname === `${V2}/pages/11/attachments`
        ? json({ results: [att(1)], _links: { next } })
        : undefined;
    await expect(getAttachments("11", 10)).rejects.toThrow(/Refusing to follow a pagination link/);
    // Only the first request was made: the credential never went to the cursor.
    expect(requests).toHaveLength(1);
    expect(requests[0].url.origin).toBe("https://test.atlassian.net");
  });

  it("a cursor chain longer than the page cap stops instead of walking forever", async () => {
    route = (r) =>
      r.url.pathname === `${V2}/pages/11/attachments`
        ? json({ results: [att(1)], _links: { next: `${V2}/pages/11/attachments?cursor=${requests.length}` } })
        : undefined;
    const out = await getAttachments("11", 1_000_000);
    expect(requests).toHaveLength(MAX_V2_LIST_PAGES);
    expect(out.length).toBe(MAX_V2_LIST_PAGES);
  });
});

// ===========================================================================
// findAttachmentByName
// ===========================================================================

describe("findAttachmentByName on v2", () => {
  it("sends filename= to /pages/{id}/attachments and matches the exact title only", async () => {
    route = listRoute(`${V2}/pages/21/attachments`, [
      att(1, { title: "a.drawio.bak" }),
      att(2, { title: "a.drawio", version: { number: 4 } }),
    ]);
    const r = await findAttachmentByName("21", "a.drawio");
    expect(paths()).toEqual([`${V2}/pages/21/attachments`]);
    expect(requests[0].url.searchParams.get("filename")).toBe("a.drawio");
    expect(r.exact).toMatchObject({ id: "att2", title: "a.drawio", version: 4 });
    expect(r.near).toEqual([]);
  });

  it("blog post id: a.drawio is looked up under /blogposts", async () => {
    route = listRoute(`${V2}/blogposts/22/attachments`, [att(1, { title: "a.drawio" })]);
    const r = await findAttachmentByName("22", "a.drawio");
    expect(paths()).toEqual([`${V2}/pages/22/attachments`, `${V2}/blogposts/22/attachments`]);
    expect(r.exact?.title).toBe("a.drawio");
  });

  it("is case-sensitive: A.drawio is not a.drawio (it is reported as a near match)", async () => {
    route = listRoute(`${V2}/pages/21/attachments`, [att(1, { title: "A.drawio" })]);
    const r = await findAttachmentByName("21", "a.drawio");
    expect(r.exact).toBeNull();
    expect(r.near.map((a) => a.title)).toEqual(["A.drawio"]);
  });

  it("zero matches: not found, no error", async () => {
    route = listRoute(`${V2}/pages/21/attachments`, []);
    expect(await findAttachmentByName("21", "a.drawio")).toEqual({ exact: null, near: [] });
  });

  it("two exact matches: refuses to choose (never the first)", async () => {
    route = listRoute(`${V2}/pages/21/attachments`, [
      att(1, { title: "a.drawio" }),
      att(2, { title: "a.drawio" }),
    ]);
    await expect(findAttachmentByName("21", "a.drawio")).rejects.toThrow(/refusing to choose/);
  });

  it("finds the exact match, and a second one, on a later page", async () => {
    const answer = (cursor: string | null): Response | undefined => {
      if (cursor === null) {
        return json({ results: [att(1, { title: "a.drawio" })], _links: { next: `${V2}/pages/21/attachments?cursor=c2` } });
      }
      return json({ results: [att(2, { title: "a.drawio" })] });
    };
    route = (r) =>
      r.url.pathname === `${V2}/pages/21/attachments` ? answer(r.url.searchParams.get("cursor")) : undefined;
    await expect(findAttachmentByName("21", "a.drawio")).rejects.toThrow(/refusing to choose/);
    expect(requests).toHaveLength(2);
  });

  it("refuses to decide when the list cannot be read to the end", async () => {
    route = (r) =>
      r.url.pathname === `${V2}/pages/21/attachments`
        ? json({ results: [att(1, { title: "other.png" })], _links: { next: `${V2}/pages/21/attachments?cursor=${requests.length}` } })
        : undefined;
    await expect(findAttachmentByName("21", "a.drawio")).rejects.toThrow(/too long to read to the end/);
  });

  it("a foreign cursor is refused: the lookup does not conclude 'absent'", async () => {
    route = (r) =>
      r.url.pathname === `${V2}/pages/21/attachments`
        ? json({ results: [], _links: { next: "https://evil.example/wiki/api/v2/pages/21/attachments?cursor=x" } })
        : undefined;
    await expect(findAttachmentByName("21", "a.drawio")).rejects.toThrow(/Refusing to follow a pagination link/);
    expect(requests).toHaveLength(1);
  });

  it("a v2 `att`-prefixed id round-trips into the v1 upload URL", async () => {
    route = (r) => {
      if (r.url.pathname === `${V2}/pages/21/attachments`) return json({ results: [att(9, { id: "att9001", title: "a.drawio" })] });
      if (r.method === "POST" && r.url.pathname === `${V1}/content/21/child/attachment/att9001/data`) {
        return json({ id: "att9001", title: "a.drawio", version: { number: 2 } });
      }
      return undefined;
    };
    const found = await findAttachmentByName("21", "a.drawio");
    expect(found.exact?.id).toBe("att9001");
    const uploaded = await uploadAttachmentVersion("21", found.exact!.id, Buffer.from("<mxfile/>"), "a.drawio");
    const post = requests.find((r) => r.method === "POST")!;
    expect(post.url.pathname).toBe(`${V1}/content/21/child/attachment/att9001/data`);
    expect(uploaded).toMatchObject({ id: "att9001", version: 2 });
  });

  it("property: the post-filter returns exactly the titles equal to the name (fixed seed)", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 8 })), fc.string({ maxLength: 8 }), (titles, name) => {
        const items = titles.map((title, i) => ({ id: `att${i}`, title }));
        const got = exactAttachmentMatches(items, name);
        expect(got.map((a) => a.title)).toEqual(titles.filter((t) => t === name));
        for (const a of got) expect(a.title === name).toBe(true);
      }),
      { seed: 20261122, numRuns: 300 }
    );
  });

  it("property: through the lookup, a title is `exact` only when it === name (fixed seed)", async () => {
    const alphabet = fc.constantFrom("a", "A", ".", "d", "b", "k");
    const title = fc.array(alphabet, { minLength: 1, maxLength: 5 }).map((cs) => cs.join(""));
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(title, { maxLength: 8 }), title, async (titles, name) => {
        requests.length = 0;
        route = listRoute(
          `${V2}/pages/21/attachments`,
          titles.map((t, i) => att(i, { title: t }))
        );
        const r = await findAttachmentByName("21", name);
        expect(r.exact?.title ?? null).toBe(titles.includes(name) ? name : null);
        for (const n of r.near) {
          expect(n.title).not.toBe(name);
          expect(n.title.toLowerCase()).toBe(name.toLowerCase());
        }
      }),
      { seed: 20261122, numRuns: 60 }
    );
  });
});

// ===========================================================================
// getLabels
// ===========================================================================

describe("getLabels on v2", () => {
  const lab = (n: number) => ({ id: String(n), name: `l${n}`, prefix: "global" });

  it("page id: one GET to /pages/{id}/labels", async () => {
    route = listRoute(`${V2}/pages/31/labels`, [lab(1), lab(2)]);
    const out = await getLabels("31");
    expect(paths()).toEqual([`${V2}/pages/31/labels`]);
    expect(out.map((l) => l.name)).toEqual(["l1", "l2"]);
    expect(out[0]).toEqual({ id: "1", name: "l1", prefix: "global" });
  });

  it("blog post id: /blogposts/{id}/labels", async () => {
    route = listRoute(`${V2}/blogposts/32/labels`, [lab(1)]);
    const out = await getLabels("32");
    expect(paths()).toEqual([`${V2}/pages/32/labels`, `${V2}/blogposts/32/labels`]);
    expect(out).toHaveLength(1);
  });

  it("a blog post id with a known type makes no /pages request", async () => {
    route = listRoute(`${V2}/blogposts/32/labels`, [lab(1)]);
    await getLabels("32", "blogpost");
    expect(paths()).toEqual([`${V2}/blogposts/32/labels`]);
  });

  it("follows the cursor to the end (every label, not the first page)", async () => {
    route = (r) => {
      if (r.url.pathname !== `${V2}/pages/31/labels`) return undefined;
      return r.url.searchParams.get("cursor") === null
        ? json({ results: [lab(1)], _links: { next: `${V2}/pages/31/labels?cursor=c2` } })
        : json({ results: [lab(2)] });
    };
    expect((await getLabels("31")).map((l) => l.name)).toEqual(["l1", "l2"]);
  });

  it("a foreign cursor is refused", async () => {
    route = (r) =>
      r.url.pathname === `${V2}/pages/31/labels`
        ? json({ results: [lab(1)], _links: { next: "https://evil.example/wiki/api/v2/pages/31/labels?cursor=x" } })
        : undefined;
    await expect(getLabels("31")).rejects.toThrow(/Refusing to follow a pagination link/);
  });
});

// ===========================================================================
// getPageVersions
// ===========================================================================

describe("getPageVersions on v2", () => {
  const ver = (n: number, authorId: string | null = "u1", over: Record<string, unknown> = {}) => ({
    number: n,
    createdAt: `2026-01-${String(n).padStart(2, "0")}T00:00:00Z`,
    message: `m${n}`,
    minorEdit: false,
    ...(authorId === null ? {} : { authorId }),
    ...over,
  });
  const users = (map: Record<string, string>) => (r: Req): Response | undefined =>
    r.method === "POST" && r.url.pathname === `${V2}/users-bulk`
      ? json({ results: Object.entries(map).map(([accountId, displayName]) => ({ accountId, displayName })) })
      : undefined;
  const both =
    (...fns: Array<(r: Req) => Response | undefined>) =>
    (r: Req) => {
      for (const f of fns) {
        const out = f(r);
        if (out) return out;
      }
      return undefined;
    };

  it("page id: GET /pages/{id}/versions with the limit", async () => {
    route = both(listRoute(`${V2}/pages/41/versions`, [ver(2), ver(1)]), users({ u1: "Alice" }));
    await getPageVersions("41", 50);
    expect(requests[0].method).toBe("GET");
    expect(requests[0].url.pathname).toBe(`${V2}/pages/41/versions`);
    expect(requests[0].url.searchParams.get("limit")).toBe("50");
    expect(paths().some((p) => p.includes("/rest/api/"))).toBe(false);
  });

  it("blog post id: GET /blogposts/{id}/versions", async () => {
    route = both(listRoute(`${V2}/blogposts/42/versions`, [ver(1)]), users({ u1: "Alice" }));
    const out = await getPageVersions("42", 25);
    expect(paths().slice(0, 2)).toEqual([`${V2}/pages/42/versions`, `${V2}/blogposts/42/versions`]);
    expect(out.map((v) => v.number)).toEqual([1]);
  });

  it("maps v2 fields to the existing shape (when, message, minorEdit, by)", async () => {
    route = both(
      listRoute(`${V2}/pages/41/versions`, [ver(3, "u1", { minorEdit: true, message: "typo" })]),
      users({ u1: "Alice" })
    );
    const [v] = await getPageVersions("41", 25);
    expect(v).toEqual({
      number: 3,
      by: { displayName: "Alice", accountId: "u1", nameResolved: true },
      when: "2026-01-03T00:00:00Z",
      message: "typo",
      minorEdit: true,
    });
  });

  it("newest first: a server that answers oldest-first is re-ordered (order pinned)", async () => {
    route = both(listRoute(`${V2}/pages/41/versions`, [ver(1), ver(2), ver(3)]), users({ u1: "A" }));
    const out = await getPageVersions("41", 25);
    expect(out.map((v) => v.number)).toEqual([3, 2, 1]);
  });

  it("an oldest-first list that continues is read whole before taking the newest `limit`", async () => {
    // 5 versions, oldest first, 2 per page. A wrong implementation that takes the
    // first `limit` of the first answer would return versions 1-2 as "newest".
    route = both((r) => {
      if (r.url.pathname !== `${V2}/pages/41/versions`) return undefined;
      const c = r.url.searchParams.get("cursor");
      if (c === null) return json({ results: [ver(1), ver(2)], _links: { next: `${V2}/pages/41/versions?cursor=c2` } });
      if (c === "c2") return json({ results: [ver(3), ver(4)], _links: { next: `${V2}/pages/41/versions?cursor=c3` } });
      return json({ results: [ver(5)] });
    }, users({ u1: "A" }));
    const out = await getPageVersions("41", 2);
    expect(out.map((v) => v.number)).toEqual([5, 4]);
  });

  it("a newest-first list is not over-read: limit reached on the first page", async () => {
    route = both(
      (r) =>
        r.url.pathname === `${V2}/pages/41/versions`
          ? json({ results: [ver(5), ver(4)], _links: { next: `${V2}/pages/41/versions?cursor=c2` } })
          : undefined,
      users({ u1: "A" })
    );
    const out = await getPageVersions("41", 2);
    expect(out.map((v) => v.number)).toEqual([5, 4]);
    expect(requests.filter((r) => r.method === "GET")).toHaveLength(1);
  });

  it("resolves authors with ONE deduplicated users-bulk POST, and caches the names", async () => {
    route = both(
      listRoute(`${V2}/pages/41/versions`, [ver(3, "u1"), ver(2, "u2"), ver(1, "u1")]),
      users({ u1: "Alice", u2: "Bob" })
    );
    const out = await getPageVersions("41", 25);
    expect(out.map((v) => v.by.displayName)).toEqual(["Alice", "Bob", "Alice"]);
    const posts = requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].url.pathname).toBe(`${V2}/users-bulk`);
    expect((posts[0].body as { accountIds: string[] }).accountIds.sort()).toEqual(["u1", "u2"]);

    await getPageVersions("41", 25);
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1); // cached for the process
  });

  it("users-bulk failure: versions are still listed, with the account id", async () => {
    route = (r) => {
      if (r.method === "POST") return json({ message: "no" }, 403);
      return listRoute(`${V2}/pages/41/versions`, [ver(2, "712020:abc"), ver(1, "u2")])(r);
    };
    const out = await getPageVersions("41", 25);
    expect(out.map((v) => v.number)).toEqual([2, 1]);
    expect(out[0].by).toMatchObject({ displayName: "712020:abc", accountId: "712020:abc", nameResolved: false });
    expect(out[1].by).toMatchObject({ displayName: "u2", nameResolved: false });
    expect(out[0].message).toBe("m2");
  });

  it("users-bulk that answers for only some ids: the others show their id", async () => {
    route = both(listRoute(`${V2}/pages/41/versions`, [ver(2, "u1"), ver(1, "u2")]), users({ u1: "Alice" }));
    const out = await getPageVersions("41", 25);
    expect(out[0].by).toMatchObject({ displayName: "Alice", nameResolved: true });
    expect(out[1].by).toMatchObject({ displayName: "u2", nameResolved: false });
  });

  it("users-bulk answering with an id nobody asked about adds nothing", async () => {
    route = both(listRoute(`${V2}/pages/41/versions`, [ver(1, "u1")]), users({ u1: "Alice", stranger: "Mallory" }));
    const out = await getPageVersions("41", 25);
    expect(out[0].by.displayName).toBe("Alice");
    // and the stranger is not cached as someone else's name
    route = both(listRoute(`${V2}/pages/41/versions`, [ver(1, "stranger")]), () => json({ message: "no" }, 500));
    const again = await getPageVersions("41", 25);
    expect(again[0].by).toMatchObject({ displayName: "stranger", nameResolved: false });
  });

  it("a version without an author is 'unknown user' and triggers no lookup", async () => {
    route = listRoute(`${V2}/pages/41/versions`, [ver(1, null)]);
    const out = await getPageVersions("41", 25);
    expect(out[0].by).toEqual({ displayName: "unknown user", accountId: "" });
    expect(requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("a foreign cursor is refused", async () => {
    route = (r) =>
      r.url.pathname === `${V2}/pages/41/versions`
        ? json({ results: [ver(2), ver(1)], _links: { next: "https://evil.example/wiki/api/v2/pages/41/versions?cursor=x" } })
        : undefined;
    // limit larger than one page so the cursor is needed
    await expect(getPageVersions("41", 5)).rejects.toThrow(/Refusing to follow a pagination link/);
  });
});

// ===========================================================================
// resolveV2NextLink (pure)
// ===========================================================================

describe("resolveV2NextLink", () => {
  const API = "https://test.atlassian.net/wiki/api/v2";
  const REQ = `${API}/pages/11/attachments?limit=2`;

  it("resolves a relative v2 link against the API base", () => {
    expect(resolveV2NextLink("/wiki/api/v2/pages/11/attachments?cursor=a", API, REQ)).toBe(
      `${API}/pages/11/attachments?cursor=a`
    );
  });

  it("accepts an absolute link on the same API and endpoint", () => {
    expect(resolveV2NextLink(`${API}/pages/11/attachments?cursor=a`, API, REQ)).toBe(
      `${API}/pages/11/attachments?cursor=a`
    );
  });

  it("works with a gateway-style base (the prefix is part of the API base)", () => {
    const gw = "https://api.atlassian.com/ex/confluence/11111111-2222-3333-4444-555555555555/wiki/api/v2";
    const req = `${gw}/pages/11/attachments`;
    expect(resolveV2NextLink("/wiki/api/v2/pages/11/attachments?cursor=a", gw, req)).toBe(
      `${gw}/pages/11/attachments?cursor=a`
    );
    // same origin, but another tenant's prefix
    expect(
      resolveV2NextLink(
        "https://api.atlassian.com/ex/confluence/99999999-2222-3333-4444-555555555555/wiki/api/v2/pages/11/attachments?cursor=a",
        gw,
        req
      )
    ).toBeNull();
  });

  it.each([
    [undefined],
    [null],
    [""],
    [42],
    ["https://evil.example/wiki/api/v2/pages/11/attachments?cursor=a"],
    ["//evil.example/wiki/api/v2/pages/11/attachments"],
    ["/wiki/api/v2/../rest/api/content/11/child/attachment"],
    ["/wiki/api/v2/pages/11/attachments\\..\\x"],
    ["/api/v2/pages/11/attachments?cursor=a"],
    ["javascript:alert(1)"],
    ["pages/11/attachments?cursor=a"],
  ])("refuses %j", (next) => {
    expect(resolveV2NextLink(next, API, REQ)).toBeNull();
  });
});

// ===========================================================================
// Handlers
// ===========================================================================

type Result = { content: { type: string; text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
type Handler = (args: Record<string, unknown>) => Promise<Result>;
let handlers = new Map<string, Handler>();

async function boot(): Promise<void> {
  mockRegisterTool.mockClear();
  vi.resetModules();
  const { main } = await import("./index.js");
  await main();
  handlers = new Map();
  for (const c of mockRegisterTool.mock.calls) {
    const [name, , handler] = c as [string, unknown, Handler];
    handlers.set(name, handler);
  }
  (await import("./page-cache.js")).pageCache.clear();
  (await import("./confirmation-tokens.js"))._resetForTest();
}

async function call(tool: string, args: Record<string, unknown>) {
  const handler = handlers.get(tool);
  if (!handler) throw new Error(`${tool} is not registered`);
  const result = await handler(args);
  return {
    text: result.content.map((c) => c.text).join("\n"),
    isError: result.isError === true,
    structured: result.structuredContent,
  };
}

const writes = () => requests.filter((r) => r.method !== "GET" && r.method !== "HEAD" && r.url.pathname !== `${V2}/users-bulk`);

const PAGE_ID = "5001";
const pageMeta = { id: PAGE_ID, title: "Runbook", spaceId: "1001", status: "current", version: { number: 4 } };

describe("handlers over the v2 reads", () => {
  beforeAll(async () => {
    await boot();
  });

  // The handlers run on the module instance `boot` created; reset its caches.
  beforeEach(async () => {
    const client = await import("./confluence-client.js");
    client._resetUserNameCacheForTests();
    client._resetContentTypeMemoForTests();
  });

  describe("get_page_versions", () => {
    const versions = [
      { number: 2, createdAt: "2026-01-02T00:00:00Z", message: "second", minorEdit: false, authorId: "712020:abc" },
      { number: 1, createdAt: "2026-01-01T00:00:00Z", message: "first", minorEdit: true, authorId: "712020:abc" },
    ];

    it("shows the author's name when the lookup works", async () => {
      route = (r) => {
        if (r.method === "POST") return json({ results: [{ accountId: "712020:abc", displayName: "Alice Example" }] });
        return listRoute(`${V2}/pages/${PAGE_ID}/versions`, versions)(r);
      };
      const out = await call("get_page_versions", { page_id: PAGE_ID, limit: 25 });
      expect(out.isError, out.text).toBe(false);
      expect(out.text).toContain("Alice Example");
      expect(out.text).toContain("v2:");
      expect(out.text.indexOf("v2:")).toBeLessThan(out.text.indexOf("v1:"));
    });

    it("when users-bulk fails, the versions are listed and the account id is shown", async () => {
      route = (r) => {
        if (r.method === "POST") return json({ message: "forbidden" }, 403);
        return listRoute(`${V2}/pages/${PAGE_ID}/versions`, versions)(r);
      };
      const out = await call("get_page_versions", { page_id: PAGE_ID, limit: 25 });
      expect(out.isError, out.text).toBe(false);
      expect(out.text).toContain("712020:abc");
      expect(out.text).toContain("name unavailable");
      expect(out.text).toContain("second");
    });
  });

  describe("add_attachment with overwrite", () => {
    const args = { page_id: PAGE_ID, file_path: "/work/a.drawio", filename: "a.drawio", overwrite: true };
    const base = (r: Req): Response | undefined =>
      r.method === "GET" && r.url.pathname === `${V2}/pages/${PAGE_ID}` ? json(pageMeta) : undefined;

    it("two exact matches: refused, and NO write request of any kind is sent", async () => {
      route = (r) =>
        base(r) ??
        listRoute(`${V2}/pages/${PAGE_ID}/attachments`, [
          att(1, { id: "att1", title: "a.drawio" }),
          att(2, { id: "att2", title: "a.drawio" }),
        ])(r);
      const first = await call("add_attachment", args);
      const token = first.structured?.confirm_token as string | undefined;
      const out = token ? await call("add_attachment", { ...args, confirm_token: token }) : first;
      expect(out.isError).toBe(true);
      expect(out.text).toMatch(/refusing to choose/);
      expect(writes()).toEqual([]);
      expect(requests.some((r) => r.url.pathname.includes("/child/attachment"))).toBe(false);
    });

    it("a.drawio next to a.drawio.bak: the new version goes to a.drawio's id, via the v1 upload URL", async () => {
      route = (r) => {
        const b = base(r);
        if (b) return b;
        if (r.url.pathname === `${V2}/pages/${PAGE_ID}/attachments`) {
          return json({
            results: [
              att(1, { id: "att7001", title: "a.drawio.bak", version: { number: 9 } }),
              att(2, { id: "att7002", title: "a.drawio", version: { number: 3 } }),
            ],
          });
        }
        if (r.method === "POST" && r.url.pathname === `${V1}/content/${PAGE_ID}/child/attachment/att7002/data`) {
          return json({ id: "att7002", title: "a.drawio", version: { number: 4 } });
        }
        if (r.url.pathname === `${V1}/content/${PAGE_ID}/label`) return json({ results: [] });
        if (r.url.pathname === `${V2}/pages/${PAGE_ID}/labels`) return json({ results: [] });
        if (r.url.pathname === `${V1}/content/${PAGE_ID}/state`) return json({ contentState: null });
        return undefined;
      };
      const first = await call("add_attachment", args);
      const token = first.structured?.confirm_token as string | undefined;
      const out = token ? await call("add_attachment", { ...args, confirm_token: token }) : first;
      expect(out.isError, out.text).toBe(false);
      const uploads = requests.filter((r) => r.method === "POST" && r.url.pathname.includes("/child/attachment"));
      expect(uploads.map((u) => u.url.pathname)).toEqual([`${V1}/content/${PAGE_ID}/child/attachment/att7002/data`]);
    });
  });
});
