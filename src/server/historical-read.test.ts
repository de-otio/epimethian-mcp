/**
 * W-HIST (plans/next-release-sdk2-and-v2-api.md section 5.2): historical
 * bodies from v2 with a fail-closed version assertion.
 *
 * What these tests defend against: a historical read that is not the requested
 * version of the requested content. Shown to an agent it is a wrong "diff" (or
 * "No changes"); written by `revert_page` it is a wrong page. Every mismatch
 * must throw, and a throwing read must leave `revert_page` with NO write
 * request at all.
 *
 * Stubbed `fetch` only; no live Confluence. Client functions are called
 * directly for the read rules; the real handlers run for `revert_page`,
 * `get_page_version` and `diff_page_versions`.
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

/** Handlers see this config; `apiV1: null` is gateway mode as the handlers read it. */
const handlerConfig = vi.hoisted(() => ({ gateway: false }));

vi.mock("./confluence-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./confluence-client.js")>();
  return {
    ...actual,
    validateStartup: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn(async () => {
      const cfg = await actual.getConfig();
      return {
        ...cfg,
        profile: "hist-test",
        sealedCloudId: "cloud-hist-test",
        ...(handlerConfig.gateway ? { apiV1: null } : {}),
      };
    }),
  };
});

import {
  HistoricalReadMismatchError,
  getHistoricalStorage,
  getPageVersionBody,
  getVersionStorage,
  ConfluenceNotFoundError,
  _resetContentTypeMemoForTests,
  _resetHttpStateForTests,
} from "./confluence-client.js";
import { REVERT_HISTORICAL_SOURCE_SITE, revertHistoricalSource } from "./historical-source.js";
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
  }
  const req = { method, url, body };
  requests.push(req);
  return route(req) ?? parentMeta(req) ?? json({ message: `unexpected ${method} ${url.pathname}` }, 404);
});

/**
 * The fixtures' objects (page 10, blog post 20), answered unless a test routes
 * them itself: a read of an id of unknown type first reads the object (B1).
 */
function parentMeta(req: { method: string; url: URL }): Response | undefined {
  if (req.method !== "GET" || req.url.searchParams.has("version")) return undefined;
  if (req.url.pathname === "/wiki/api/v2/pages/10") return json({ id: "10", title: "Page ten", version: { number: 9 } });
  if (req.url.pathname === "/wiki/api/v2/blogposts/20") return json({ id: "20", title: "Post twenty", version: { number: 9 } });
  return undefined;
}

const V2 = "/wiki/api/v2";
const V1 = "/wiki/rest/api";
const paths = () => requests.map((r) => r.url.pathname);
/** Historical reads only (`?version=`), without the object's metadata read. */
const histPaths = () => requests.filter((r) => r.url.pathname.startsWith(V1) || r.url.searchParams.has("version")).map((r) => r.url.pathname);
const writes = () => requests.filter((r) => r.method !== "GET" && r.method !== "HEAD");

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
  handlerConfig.gateway = false;
  _resetHttpStateForTests();
  _resetContentTypeMemoForTests();
  pageCache.clear();
});

/** A v2 historical answer for content `id` at `n`. */
const hist = (id: string, n: number, body = `<p>v${n}</p>`, over: Record<string, unknown> = {}) => ({
  id,
  title: `Title at v${n}`,
  version: { number: n },
  body: { storage: { representation: "storage", value: body } },
  ...over,
});

const histRoute =
  (segment: "pages" | "blogposts", id: string, answer: (n: number) => unknown) =>
  (r: Req): Response | undefined =>
    r.method === "GET" && r.url.pathname === `${V2}/${segment}/${id}` && r.url.searchParams.has("version")
      ? json(answer(Number(r.url.searchParams.get("version"))))
      : undefined;

// ===========================================================================
// getHistoricalStorage: the read and its assertions
// ===========================================================================

describe("getHistoricalStorage", () => {
  it("page: GET /pages/{id}?version=N&body-format=storage", async () => {
    route = histRoute("pages", "10", (n) => hist("10", n));
    const out = await getHistoricalStorage("10", "page", 3);
    expect(requests).toHaveLength(1);
    expect(requests[0].url.pathname).toBe(`${V2}/pages/10`);
    expect(requests[0].url.searchParams.get("version")).toBe("3");
    expect(requests[0].url.searchParams.get("body-format")).toBe("storage");
    expect(out).toEqual({ title: "Title at v3", rawBody: "<p>v3</p>", version: 3 });
  });

  it("blog post: GET /blogposts/{id}?version=N&body-format=storage", async () => {
    route = histRoute("blogposts", "20", (n) => hist("20", n));
    await getHistoricalStorage("20", "blogpost", 2);
    expect(paths()).toEqual([`${V2}/blogposts/20`]);
    expect(requests[0].url.searchParams.get("version")).toBe("2");
  });

  it.each([
    ["N+1", (n: number) => hist("10", n + 1)],
    ["N-1", (n: number) => hist("10", n - 1)],
    ["the current version (server ignored ?version=)", () => hist("10", 9)],
  ])("version.number is %s: throws, and nothing is cached", async (_name, answer) => {
    route = histRoute("pages", "10", answer);
    await expect(getHistoricalStorage("10", "page", 3)).rejects.toBeInstanceOf(HistoricalReadMismatchError);
    await expect(getVersionStorage("10", 3)).rejects.toBeInstanceOf(HistoricalReadMismatchError);
    expect(pageCache.getVersioned("10", 3, "v2")).toBeUndefined();
  });

  it("a mismatch is never papered over by falling back to the current body (no second request)", async () => {
    route = histRoute("pages", "10", () => hist("10", 9, "<p>CURRENT</p>"));
    await expect(getPageVersionBody("10", 3)).rejects.toThrow(/Refusing to use the historical read/);
    expect(histPaths()).toEqual([`${V2}/pages/10`]);
  });

  it.each([
    ["no body at all", (n: number) => ({ id: "10", title: "t", version: { number: n } })],
    ["body without storage", (n: number) => ({ id: "10", title: "t", version: { number: n }, body: {} })],
    ["storage without a value", (n: number) => ({ id: "10", title: "t", version: { number: n }, body: { storage: { representation: "storage" } } })],
    ["no version at all", () => ({ id: "10", title: "t", body: { storage: { representation: "storage", value: "<p>x</p>" } } })],
  ])("%s: throws (a missing body is not an empty page)", async (_name, answer) => {
    route = histRoute("pages", "10", answer);
    await expect(getHistoricalStorage("10", "page", 3)).rejects.toBeInstanceOf(HistoricalReadMismatchError);
  });

  it("an empty-string body is a real (empty) historical body, not an error", async () => {
    route = histRoute("pages", "10", (n) => hist("10", n, ""));
    expect((await getHistoricalStorage("10", "page", 3)).rawBody).toBe("");
  });

  it.each([["atlas_doc_format"], ["view"], [""]])("representation %j: throws", async (representation) => {
    route = histRoute("pages", "10", (n) => ({ ...hist("10", n), body: { storage: { representation, value: "<p>x</p>" } } }));
    await expect(getHistoricalStorage("10", "page", 3)).rejects.toThrow(/not storage/);
  });

  it("an answer about different content: throws", async () => {
    route = histRoute("pages", "10", (n) => hist("99", n));
    await expect(getHistoricalStorage("10", "page", 3)).rejects.toThrow(/different content/);
  });

  it.each([[0], [-1], [1.5], [Number.NaN]])("version %s is refused before any request", async (v) => {
    await expect(getHistoricalStorage("10", "page", v)).rejects.toThrow(/Invalid version/);
    expect(requests).toHaveLength(0);
  });

  it("a non-numeric id is refused before any request", async () => {
    await expect(getHistoricalStorage("10/../x", "page", 1)).rejects.toThrow(/Invalid content id/);
    expect(requests).toHaveLength(0);
  });

  it("property: any version number other than the requested one is refused (fixed seed)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 500 }), fc.integer({ min: 1, max: 500 }), async (asked, answered) => {
        requests.length = 0;
        pageCache.clear();
        route = histRoute("pages", "10", () => hist("10", answered));
        const run = getHistoricalStorage("10", "page", asked);
        if (asked === answered) await expect(run).resolves.toMatchObject({ version: asked });
        else await expect(run).rejects.toBeInstanceOf(HistoricalReadMismatchError);
      }),
      { seed: 20261122, numRuns: 80 }
    );
  });
});

describe("getPageVersionBody / getVersionStorage routing", () => {
  it("page id: the page's metadata, then one historical read of /pages, none to v1", async () => {
    route = histRoute("pages", "10", (n) => hist("10", n));
    await getPageVersionBody("10", 3);
    expect(paths()).toEqual([`${V2}/pages/10`, `${V2}/pages/10`]);
    expect(requests[0].url.searchParams.has("version")).toBe(false);
    expect(requests[1].url.searchParams.get("version")).toBe("3");
  });

  it("blog post id: the page read 404s, the blog post read succeeds, then /blogposts with the same assertions", async () => {
    route = histRoute("blogposts", "20", (n) => hist("20", n));
    const out = await getPageVersionBody("20", 2);
    expect(paths()).toEqual([`${V2}/pages/20`, `${V2}/blogposts/20`, `${V2}/blogposts/20`]);
    expect(histPaths()).toEqual([`${V2}/blogposts/20`]);
    expect(out.rawBody).toBe("<p>v2</p>");
    // and a blog post answer for the wrong version is refused just the same
    pageCache.clear();
    requests.length = 0;
    route = histRoute("blogposts", "20", () => hist("20", 7));
    await expect(getVersionStorage("20", 2)).rejects.toBeInstanceOf(HistoricalReadMismatchError);
  });

  it("a mismatch on /pages is not a 404: the blog post path is not tried", async () => {
    route = histRoute("pages", "10", () => hist("10", 9));
    await expect(getVersionStorage("10", 3)).rejects.toBeInstanceOf(HistoricalReadMismatchError);
    expect(histPaths()).toEqual([`${V2}/pages/10`]);
    expect(paths().some((p) => p.includes("/blogposts/"))).toBe(false);
  });

  it("neither a page nor a blog post: one combined not-found", async () => {
    await expect(getVersionStorage("30", 1)).rejects.toBeInstanceOf(ConfluenceNotFoundError);
  });
});

// ===========================================================================
// Cache key carries the source
// ===========================================================================

describe("the versioned cache never mixes v1 and v2 bodies", () => {
  it("a body read from v1 is not served for a v2 read of the same version (and vice versa)", async () => {
    route = (r) => {
      if (r.url.pathname === `${V1}/content/10`) {
        return json({ id: "10", title: "t", version: { number: 3 }, body: { storage: { value: "<p>from v1</p>" } } });
      }
      return histRoute("pages", "10", (n) => hist("10", n, "<p>from v2</p>"))(r);
    };
    const a = await getPageVersionBody("10", 3, { source: "v1" });
    const b = await getPageVersionBody("10", 3, { source: "v2" });
    expect(a.rawBody).toBe("<p>from v1</p>");
    expect(b.rawBody).toBe("<p>from v2</p>");
    // two fetches: the v1 entry did not answer the v2 read
    expect(histPaths()).toEqual([`${V1}/content/10`, `${V2}/pages/10`]);
    expect(pageCache.getVersioned("10", 3, "v1")).toBe("<p>from v1</p>");
    expect(pageCache.getVersioned("10", 3, "v2")).toBe("<p>from v2</p>");
  });

  it("getVersionStorage (used by get_recent_changes) reads v2 even when a v1 body is cached", async () => {
    pageCache.setVersioned("10", 3, "<p>from v1</p>", "v1");
    route = histRoute("pages", "10", (n) => hist("10", n, "<p>from v2</p>"));
    expect(await getVersionStorage("10", 3)).toBe("<p>from v2</p>");
  });
});

// ===========================================================================
// The v1 path asserts the version too
// ===========================================================================

describe("v1 historical read (revert_page, site mode)", () => {
  it("a v1 answer for another version throws and is not cached", async () => {
    route = (r) =>
      r.url.pathname === `${V1}/content/10`
        ? json({ id: "10", title: "t", version: { number: 9 }, body: { storage: { value: "<p>CURRENT</p>" } } })
        : undefined;
    await expect(getPageVersionBody("10", 3, { source: "v1" })).rejects.toBeInstanceOf(HistoricalReadMismatchError);
    expect(pageCache.getVersioned("10", 3, "v1")).toBeUndefined();
  });
});

// ===========================================================================
// revertHistoricalSource: the single named constant
// ===========================================================================

describe("revertHistoricalSource", () => {
  it("site mode follows REVERT_HISTORICAL_SOURCE_SITE, which stays v1 until the parity probe", () => {
    expect(REVERT_HISTORICAL_SOURCE_SITE).toBe("v1");
    expect(revertHistoricalSource({ apiV1: "https://x.example/wiki/rest/api" })).toBe(REVERT_HISTORICAL_SOURCE_SITE);
  });

  it("gateway mode (no v1) is always v2", () => {
    expect(revertHistoricalSource({ apiV1: null })).toBe("v2");
  });

  it("property: any v1 base gives the site constant; null gives v2 (fixed seed)", () => {
    fc.assert(
      fc.property(fc.option(fc.webUrl(), { nil: null }), (apiV1) => {
        expect(revertHistoricalSource({ apiV1 })).toBe(apiV1 === null ? "v2" : REVERT_HISTORICAL_SOURCE_SITE);
      }),
      { seed: 20261122, numRuns: 100 }
    );
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

const PAGE_ID = "5001";
const BLOG_ID = "7001";
const LONG_PARA = "<p>" + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(6) + "</p>";
const MACRO = `<ac:structured-macro ac:name="info" ac:schema-version="1" ac:macro-id="m-1"><ac:rich-text-body><p>Note</p></ac:rich-text-body></ac:structured-macro>`;
const sections = (mid: string) =>
  `<h1>Intro</h1>${LONG_PARA}<h2>${mid}</h2>${LONG_PARA}${MACRO}<h2>More</h2>${LONG_PARA}<h2>End</h2>${LONG_PARA}`;
/** The page as it is now (version 5), and as it was at the target version. */
const CURRENT_BODY = sections("Current details");
const OLD_BODY = sections("Original details");
const CURRENT_VERSION = 5;
const TARGET = 2;

type Mode = "ok" | "plusOne" | "ignoresVersion" | "noBody" | "badRepresentation";
let mode: Mode = "ok";

/** The fake wiki for the handler tests: one page at version 5, one blog post. */
function wiki(r: Req): Response | undefined {
  const p = r.url.pathname;
  const asked = r.url.searchParams.get("version");
  if (r.method === "GET" && p === `${V2}/pages/${PAGE_ID}`) {
    if (asked === null) {
      return json({
        id: PAGE_ID,
        title: "Runbook",
        spaceId: "1001",
        status: "current",
        version: { number: CURRENT_VERSION },
        ...(r.url.searchParams.has("body-format")
          ? { body: { storage: { representation: "storage", value: CURRENT_BODY } } }
          : {}),
      });
    }
    const n = Number(asked);
    switch (mode) {
      case "ok":
        return json(hist(PAGE_ID, n, OLD_BODY));
      case "plusOne":
        return json(hist(PAGE_ID, n + 1, OLD_BODY));
      case "ignoresVersion":
        return json(hist(PAGE_ID, CURRENT_VERSION, CURRENT_BODY));
      case "noBody":
        return json({ id: PAGE_ID, title: "t", version: { number: n } });
      case "badRepresentation":
        return json({ ...hist(PAGE_ID, n), body: { storage: { representation: "view", value: OLD_BODY } } });
    }
  }
  if (r.method === "GET" && p === `${V2}/blogposts/${BLOG_ID}`) {
    const n = Number(asked ?? CURRENT_VERSION);
    return json(hist(BLOG_ID, n, OLD_BODY, { status: "current" }));
  }
  if (r.method === "GET" && p === `${V1}/content/${PAGE_ID}` && asked !== null) {
    const n = Number(asked);
    // v1 as the live API answers: the requested version.
    return json({ id: PAGE_ID, title: "Runbook (v1)", version: { number: mode === "plusOne" ? n + 1 : n }, body: { storage: { value: OLD_BODY } } });
  }
  if (r.method === "PUT" && p === `${V2}/pages/${PAGE_ID}`) {
    return json({ id: PAGE_ID, title: "Runbook", spaceId: "1001", version: { number: CURRENT_VERSION + 1 } });
  }
  if (p === `${V2}/spaces/1001`) return json({ id: "1001", key: "DOCS", name: "DOCS", type: "global" });
  if (p === `${V1}/content/${PAGE_ID}/label`) return json({ results: [] });
  if (p === `${V2}/pages/${PAGE_ID}/labels`) return json({ results: [] });
  if (p === `${V1}/content/${PAGE_ID}/state`) return json({ contentState: null });
  return undefined;
}

const revertArgs = {
  page_id: PAGE_ID,
  target_version: TARGET,
  current_version: CURRENT_VERSION,
  confirm_shrinkage: false,
  confirm_structure_loss: false,
};

/** revert_page is always gated: ask, then confirm with the token. */
async function revert(): Promise<{ text: string; isError: boolean }> {
  const first = await call("revert_page", revertArgs);
  const token = first.structured?.confirm_token as string | undefined;
  if (!token) return first;
  return call("revert_page", { ...revertArgs, confirm_token: token });
}

describe("handlers over the historical read", () => {
  beforeAll(async () => {
    await boot();
  });

  beforeEach(() => {
    mode = "ok";
    route = wiki;
  });

  describe("revert_page, site mode (v1 source)", () => {
    it("reverts from the v1 body, and does not touch the v2 historical endpoint", async () => {
      const out = await revert();
      expect(out.isError, out.text).toBe(false);
      const put = writes().find((w) => w.method === "PUT");
      expect(put?.url.pathname).toBe(`${V2}/pages/${PAGE_ID}`);
      expect((put!.body as { body: { value: string } }).body.value).toContain("Original details");
      expect((put!.body as { body: { value: string } }).body.value).not.toContain("Current details");
      expect(requests.some((r) => r.url.pathname === `${V1}/content/${PAGE_ID}` && r.url.searchParams.get("version") === String(TARGET))).toBe(true);
      expect(requests.some((r) => r.url.pathname === `${V2}/pages/${PAGE_ID}` && r.url.searchParams.has("version"))).toBe(false);
    });

    it("a v1 answer for a different version: throws, and NO write request is sent", async () => {
      mode = "plusOne";
      const out = await revert();
      expect(out.isError).toBe(true);
      expect(out.text).toMatch(/Refusing to use the historical read/);
      expect(writes()).toEqual([]);
    });
  });

  describe("revert_page, gateway mode (v2 source)", () => {
    beforeEach(() => {
      handlerConfig.gateway = true;
    });

    it("reverts from the v2 body, asking for version=N&body-format=storage", async () => {
      const out = await revert();
      expect(out.isError, out.text).toBe(false);
      const hread = requests.find((r) => r.url.pathname === `${V2}/pages/${PAGE_ID}` && r.url.searchParams.has("version"));
      expect(hread?.url.searchParams.get("version")).toBe(String(TARGET));
      expect(hread?.url.searchParams.get("body-format")).toBe("storage");
      expect(requests.some((r) => r.url.pathname === `${V1}/content/${PAGE_ID}`)).toBe(false);
      const put = writes().find((w) => w.method === "PUT");
      expect((put!.body as { body: { value: string } }).body.value).toContain("Original details");
    });

    it.each<[string, Mode]>([
      ["v2 answers version N+1", "plusOne"],
      ["v2 ignores ?version= and returns the current page", "ignoresVersion"],
      ["v2 answers without a body", "noBody"],
      ["v2 answers in another representation", "badRepresentation"],
    ])("%s: throws, and NO write request is sent", async (_name, m) => {
      mode = m;
      const out = await revert();
      expect(out.isError).toBe(true);
      expect(out.text).toMatch(/Refusing to use the historical read/);
      // No PUT, no label write, no state write: nothing was changed.
      expect(writes()).toEqual([]);
    });
  });

  describe("get_page_version", () => {
    it("page: reads v2 with version and body-format, shows the historical body", async () => {
      const out = await call("get_page_version", { page_id: PAGE_ID, version: TARGET });
      expect(out.isError, out.text).toBe(false);
      expect(out.text).toContain("Original details");
      expect(out.text).toContain(`Version: ${TARGET}`);
      const h = requests.find((r) => r.url.searchParams.has("version"))!;
      expect(h.url.pathname).toBe(`${V2}/pages/${PAGE_ID}`);
      expect(h.url.searchParams.get("body-format")).toBe("storage");
      expect(requests.some((r) => r.url.pathname.startsWith(V1))).toBe(false);
    });

    it("blog post: reads /blogposts/{id} with the version", async () => {
      const out = await call("get_page_version", { page_id: BLOG_ID, version: TARGET });
      expect(out.isError, out.text).toBe(false);
      const h = requests.find((r) => r.url.pathname === `${V2}/blogposts/${BLOG_ID}` && r.url.searchParams.has("version"));
      expect(h?.url.searchParams.get("version")).toBe(String(TARGET));
    });

    it("v2 ignores ?version=: an error, and the current body is NOT shown as the old version", async () => {
      mode = "ignoresVersion";
      const out = await call("get_page_version", { page_id: PAGE_ID, version: TARGET });
      expect(out.isError).toBe(true);
      expect(out.text).not.toContain("Current details");
    });
  });

  describe("diff_page_versions", () => {
    it("reads both versions from v2 (page)", async () => {
      const out = await call("diff_page_versions", { page_id: PAGE_ID, from_version: 1, to_version: 3, format: "summary" });
      expect(out.isError, out.text).toBe(false);
      const versions = requests
        .filter((r) => r.url.pathname === `${V2}/pages/${PAGE_ID}` && r.url.searchParams.has("version"))
        .map((r) => r.url.searchParams.get("version"))
        .sort();
      expect(versions).toEqual(["1", "3"]);
      expect(requests.some((r) => r.url.pathname.startsWith(V1))).toBe(false);
    });

    it("v2 ignores ?version=: an error, not 'No changes'", async () => {
      mode = "ignoresVersion";
      const out = await call("diff_page_versions", { page_id: PAGE_ID, from_version: 1, to_version: 3, format: "summary" });
      expect(out.isError).toBe(true);
      expect(out.text).not.toMatch(/No changes/i);
      expect(out.text).toMatch(/Refusing to use the historical read/);
    });
  });
});
