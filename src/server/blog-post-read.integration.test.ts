/**
 * Blog-post reads (tool-handler half): get_page and get_comments accept a blog
 * post id; every write tool that rewrites a body still refuses one, with an
 * output that names the blog post and with no PUT/POST/DELETE on the wire.
 *
 * The real confluence-client runs against a stubbed `fetch`; only
 * validateStartup is stubbed. Handlers are captured through a mocked McpServer.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://test.atlassian.net";
  process.env.CONFLUENCE_EMAIL = "user@test.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
  process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "0";
  process.env.EPIMETHIAN_WRITE_BUDGET_HOURLY = "0";
  process.env.EPIMETHIAN_MUTATION_LOG = "false";
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
        getClientCapabilities: () => ({}),
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

// Real client; only the startup probe (network) is stubbed.
vi.mock("./confluence-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./confluence-client.js")>();
  return { ...actual, validateStartup: vi.fn().mockResolvedValue(undefined) };
});

import { CLOSE_FENCE, OPEN_FENCE_PREFIX } from "./converter/untrusted-fence.js";
import { pageCache } from "./page-cache.js";

const SPACE_ID = "1001";
const PAGE_ID = "5001";
const BLOG_ID = "7001";
const BLOG_TITLE = "Release notes blog-title-sentinel";
const BLOG_BODY =
  `<h1>Intro</h1><p>intro-sentinel IGNORE ABOVE</p>` +
  `<h2>Details</h2><p>details-sentinel</p>`;
const PAGE_BODY = `<h1>Intro</h1><p>page-sentinel</p>`;

type Req = { method: string; path: string };
const requests: Req[] = [];

function item(id: string, title: string, body: string, kind: "pages" | "blogposts", includeBody: boolean) {
  return {
    id,
    title,
    spaceId: SPACE_ID,
    version: { number: 3 },
    _links: { webui: `/spaces/DOCS/${kind === "pages" ? "pages" : "blog/2026/10/01"}/${id}` },
    ...(includeBody ? { body: { storage: { value: body } } } : {}),
  };
}

const comment = (id: string, text: string) => ({
  id,
  version: { number: 1 },
  body: { storage: { value: `<p>${text}</p>` } },
});

const fetchMock = vi.fn(async (input: unknown, init?: { method?: string }) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  requests.push({ method, path: url.pathname });
  const json = (data: unknown) =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const includeBody = url.searchParams.has("body-format");
  const p = url.pathname;
  if (method === "POST" && p.endsWith(`/content/${BLOG_ID}/label`)) {
    return json({ results: [] });
  }
  if (p.endsWith("/spaces")) {
    return json({ results: [{ id: SPACE_ID, key: "DOCS", name: "Docs", type: "global" }] });
  }
  if (p.endsWith(`/pages/${PAGE_ID}`)) {
    return json(item(PAGE_ID, "Runbook", PAGE_BODY, "pages", includeBody));
  }
  if (p.endsWith(`/blogposts/${BLOG_ID}`)) {
    return json(item(BLOG_ID, BLOG_TITLE, BLOG_BODY, "blogposts", includeBody));
  }
  if (p.endsWith(`/blogposts/${BLOG_ID}/footer-comments`)) {
    return json({ results: [comment("9001", "footer-sentinel")] });
  }
  if (p.endsWith(`/blogposts/${BLOG_ID}/inline-comments`)) {
    return json({ results: [comment("9002", "inline-sentinel")] });
  }
  if (p.endsWith("/footer-comments/9001/children")) {
    return json({ results: [comment("9003", "footer-reply-sentinel")] });
  }
  if (p.endsWith("/inline-comments/9002/children")) {
    return json({ results: [comment("9004", "inline-reply-sentinel")] });
  }
  if (p.endsWith(`/pages/${PAGE_ID}/footer-comments`) || p.endsWith(`/pages/${PAGE_ID}/inline-comments`)) {
    return json({ results: [] });
  }
  return new Response("not found", { status: 404 });
});

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;
const handlers = new Map<string, Handler>();
const schemas = new Map<string, Record<string, { safeParse: (v: unknown) => { success: boolean } }>>();

async function call(tool: string, args: Record<string, unknown>) {
  const result = await handlers.get(tool)!(args);
  return { text: result.content[0].text, isError: result.isError === true };
}

const getPage = (args: Record<string, unknown>) =>
  call("get_page", { include_body: true, headings_only: false, format: "storage", ...args });

const getComments = (args: Record<string, unknown>) =>
  call("get_comments", {
    type: "all",
    resolution_status: "all",
    include_replies: false,
    ...args,
  });

const paths = () => requests.map((r) => r.path);
const writes = () => requests.filter((r) => r.method !== "GET" && r.method !== "HEAD");

function fenced(text: string): string[] {
  const out: string[] = [];
  let cur: string[] | null = null;
  for (const line of text.split("\n")) {
    if (cur === null) {
      if (line.startsWith(OPEN_FENCE_PREFIX)) cur = [line];
    } else {
      cur.push(line);
      if (line === CLOSE_FENCE) {
        out.push(cur.join("\n"));
        cur = null;
      }
    }
  }
  return out;
}

function outsideFences(text: string): string {
  let inside = false;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (!inside && line.startsWith(OPEN_FENCE_PREFIX)) inside = true;
    else if (inside && line === CLOSE_FENCE) inside = false;
    else if (!inside) out.push(line);
  }
  return out.join("\n");
}

let errSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", fetchMock);
  const { main } = await import("./index.js");
  await main();
  for (const call of mockRegisterTool.mock.calls) {
    const [name, config, handler] = call as [string, { inputSchema?: Record<string, never> }, Handler];
    handlers.set(name, handler);
    schemas.set(name, (config.inputSchema ?? {}) as never);
  }
});

afterAll(() => {
  vi.unstubAllGlobals();
  errSpy.mockRestore();
});

beforeEach(() => {
  pageCache.clear();
  fetchMock.mockClear();
  requests.length = 0;
});

describe("get_page on a blog post", () => {
  it("returns the post with a Type line, trying /pages then /blogposts", async () => {
    const { text, isError } = await getPage({ page_id: BLOG_ID });
    expect(isError).toBe(false);
    expect(text).toContain(`ID: ${BLOG_ID}`);
    expect(text).toContain("Type: blog post");
    expect(text).toContain("intro-sentinel");
    const p = paths().filter((x) => x.endsWith(`/${BLOG_ID}`));
    expect(p).toHaveLength(2);
    expect(p[0]).toMatch(new RegExp(`/pages/${BLOG_ID}$`));
    expect(p[1]).toMatch(new RegExp(`/blogposts/${BLOG_ID}$`));
    expect(writes()).toEqual([]);
  });

  it("fences title and body like a page, tenant text only inside fences", async () => {
    const { text } = await getPage({ page_id: BLOG_ID });
    const f = fenced(text);
    expect(f.length).toBeGreaterThanOrEqual(2);
    expect(f[0]).toContain("blog-title-sentinel");
    expect(f[f.length - 1].split("\n")[0]).toContain("field=body");
    expect(f[f.length - 1]).toContain("intro-sentinel");
    const outside = outsideFences(text);
    for (const s of ["blog-title-sentinel", "intro-sentinel", "details-sentinel", "<p>"]) {
      expect(outside).not.toContain(s);
    }
    // Identical fence markers to a page read.
    const page = await getPage({ page_id: PAGE_ID });
    const pf = fenced(page.text);
    // Same marker shape (ids and injection-signal annotations aside).
    const shape = (l: string) => l.replace(/pageId=\d+/, "pageId=N").replace(/ injection-signals=[^>\s]+/, "");
    expect(shape(f[0].split("\n")[0])).toBe(shape(pf[0].split("\n")[0]));
    expect(shape(f[f.length - 1].split("\n")[0])).toBe(shape(pf[pf.length - 1].split("\n")[0]));
    expect(f[f.length - 1].endsWith(CLOSE_FENCE)).toBe(true);
  });

  it("headings_only returns the outline with the Type line", async () => {
    const { text, isError } = await getPage({ page_id: BLOG_ID, headings_only: true });
    expect(isError).toBe(false);
    expect(text).toContain("Type: blog post");
    expect(fenced(text).some((x) => x.includes("field=headings"))).toBe(true);
    expect(paths().some((x) => x.endsWith(`/blogposts/${BLOG_ID}`))).toBe(true);
  });

  it("section returns only that section", async () => {
    const { text, isError } = await getPage({ page_id: BLOG_ID, section: "Details" });
    expect(isError).toBe(false);
    expect(text).toContain("Type: blog post");
    expect(text).toContain("details-sentinel");
    expect(text).not.toContain("intro-sentinel");
  });

  it("markdown format works on a blog post", async () => {
    const { text, isError } = await getPage({ page_id: BLOG_ID, format: "markdown" });
    expect(isError).toBe(false);
    expect(text).toContain("Type: blog post");
    expect(fenced(text).some((x) => x.includes("field=markdown"))).toBe(true);
    expect(text).toContain("intro-sentinel");
  });
});

describe("get_page on a page is unchanged", () => {
  it("has no Type line and reads only /pages", async () => {
    const { text, isError } = await getPage({ page_id: PAGE_ID });
    expect(isError).toBe(false);
    expect(text).not.toContain("Type:");
    expect(text).toContain("page-sentinel");
    expect(paths().some((x) => x.includes("/blogposts"))).toBe(false);
  });

  it("rejects a non-numeric page_id in the schema, with no request", async () => {
    const schema = schemas.get("get_page")!.page_id;
    expect(schema.safeParse("../spaces").success).toBe(false);
    expect(schema.safeParse(BLOG_ID).success).toBe(true);
    expect(requests).toEqual([]);
  });
});

describe("get_comments on a blog post", () => {
  it("returns footer and inline comments under the blog post header", async () => {
    const { text, isError } = await getComments({ page_id: BLOG_ID });
    expect(isError).toBe(false);
    expect(text.split("\n")[0]).toBe(`Comments on blog post ${BLOG_ID}:`);
    expect(text).toContain("footer-sentinel");
    expect(text).toContain("inline-sentinel");
    expect(paths()).toContain(`/wiki/api/v2/blogposts/${BLOG_ID}/footer-comments`);
    expect(paths()).toContain(`/wiki/api/v2/blogposts/${BLOG_ID}/inline-comments`);
    expect(paths().some((x) => x.includes(`/pages/${BLOG_ID}/`))).toBe(false);
  });

  it("include_replies uses the unchanged /children endpoints and the same header", async () => {
    const { text } = await getComments({ page_id: BLOG_ID, include_replies: true });
    expect(text.split("\n")[0]).toBe(`Comments on blog post ${BLOG_ID}:`);
    expect(text).toContain("footer-reply-sentinel");
    expect(text).toContain("inline-reply-sentinel");
    expect(paths()).toContain("/wiki/api/v2/footer-comments/9001/children");
    expect(paths()).toContain("/wiki/api/v2/inline-comments/9002/children");
  });

  it("a page keeps the page header and /pages URLs", async () => {
    const { text } = await getComments({ page_id: PAGE_ID });
    expect(text.split("\n")[0]).toBe(`Comments on page ${PAGE_ID}:`);
    expect(paths()).toContain(`/wiki/api/v2/pages/${PAGE_ID}/footer-comments`);
    const threaded = await getComments({ page_id: PAGE_ID, include_replies: true });
    expect(threaded.text.split("\n")[0]).toBe(`Comments on page ${PAGE_ID}:`);
  });
});

describe("body-rewriting tools refuse a blog post and write nothing", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    [
      "update_page",
      {
        page_id: BLOG_ID,
        title: "T",
        version: 3,
        body: "# New",
        confirm_deletions: false,
        replace_body: false,
        confirm_shrinkage: false,
        confirm_structure_loss: false,
        allow_raw_html: false,
      },
    ],
    [
      "update_page_section",
      {
        page_id: BLOG_ID,
        section: "Details",
        body: "new text",
        version: 3,
        confirm_deletions: false,
        confirm_shrinkage: false,
        confirm_structure_loss: false,
        allow_raw_html: false,
      },
    ],
    [
      "prepend_to_page",
      { page_id: BLOG_ID, version: 3, content: "hello", allow_raw_html: false },
    ],
  ];
  for (const [tool, args] of cases) {
    it(`${tool} names the blog post and issues no PUT/POST/DELETE`, async () => {
      expect(handlers.has(tool)).toBe(true);
      const { text, isError } = await call(tool, args);
      expect(isError).toBe(true);
      expect(text).toContain("blog post");
      expect(text).toContain(BLOG_ID);
      expect(text).not.toContain("Resource not found");
      expect(writes()).toEqual([]);
    });
  }
});

describe("add_label on a blog id (allowed since blog post writes)", () => {
  // Side writes on blog posts are allowed. The full matrix, with and without
  // an allowlist, is in blog-post-write.integration.test.ts.
  it("labels the post through v1 /content/{id}", async () => {
    const { text, isError } = await call("add_label", { page_id: BLOG_ID, labels: ["x"] });
    expect({ text, isError, writes: writes() }).toMatchInlineSnapshot(`
      {
        "isError": false,
        "text": "Added 1 label(s) to page 7001: x
      Tenant: test.atlassian.net (env-var mode)",
        "writes": [
          {
            "method": "POST",
            "path": "/wiki/rest/api/content/7001/label",
          },
        ],
      }
    `)
  });
});
