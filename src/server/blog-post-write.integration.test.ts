/**
 * Blog-post writes (plans/blog-post-writes.md, stages A2-A4 and B).
 *
 *   - A2: the space allowlist resolves a blog post's space, and fails closed
 *     when it cannot (including a pages 404 followed by a blogposts 500).
 *   - A3: side writes (labels, status, attachments, comments) are allowed on
 *     a blog post, with and without an allowlist; a new top-level footer
 *     comment names the post with `blogPostId`.
 *   - A4: add_drawio_diagram reads the page before uploading.
 *   - B: create_blog_post (draft by default, publishing always confirmed) and
 *     update_blog_post (the update_page pipeline against /blogposts).
 *
 * The real confluence-client, safe-write, confirmation-token and elicitation
 * modules run against a stubbed `fetch`. Assertions are on the requests on
 * the wire (method, path, query, JSON body), not only on tool output.
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
  // The publish gate must be live: no ungated / bypass overrides.
  delete process.env.EPIMETHIAN_ALLOW_UNGATED_WRITES;
  delete process.env.EPIMETHIAN_BYPASS_ELICITATION;
  delete process.env.EPIMETHIAN_DISABLE_SOFT_CONFIRM;
});

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: vi.fn().mockResolvedValue(null),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

const mockRegisterTool = vi.fn();
const mockElicitInput = vi.fn();

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(function () {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      registerTool: mockRegisterTool,
      server: {
        getClientVersion: () => ({ name: "test-client", version: "1.0.0" }),
        // No elicitation: confirmations take the soft (token) path.
        getClientCapabilities: () => ({}),
        elicitInput: mockElicitInput,
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

let mockSettings: Record<string, unknown> | undefined;

vi.mock("../shared/profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/profiles.js")>();
  return { ...actual, getProfileSettings: vi.fn(async () => mockSettings) };
});

const mockLogMutation = vi.fn();
vi.mock("./mutation-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mutation-log.js")>();
  return { ...actual, logMutation: (...args: unknown[]) => mockLogMutation(...args) };
});

// add_attachment reads a local file; the path rules are tested elsewhere.
vi.mock("./upload-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./upload-file.js")>();
  return {
    ...actual,
    readUploadFile: vi.fn(async (p: string) => ({ path: p, data: Buffer.from("file-bytes") })),
  };
});

const CLOUD_ID = "cloud-blog-test";

// Real client. The handlers' own getConfig() sees a profile (so the profile
// settings, and with them the allowlist, apply) and a sealed cloudId (so the
// soft-confirmation path can mint tokens). The client's internal requests
// still use the env-var configuration.
vi.mock("./confluence-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./confluence-client.js")>();
  return {
    ...actual,
    validateStartup: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn(async () => ({
      ...(await actual.getConfig()),
      profile: "blog-test",
      sealedCloudId: CLOUD_ID,
    })),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DOCS_ID = "1001";
const OPS_ID = "1002";
const PAGE_ID = "5001"; // page in DOCS
const BLOG_ID = "7001"; // published post in DOCS
const BLOG_OPS = "7002"; // published post in OPS
const DRAFT_ID = "7003"; // draft in DOCS: visible only with status=draft
const BLOG_500 = "7004"; // /pages 404, /blogposts 500
const MISSING = "7999"; // nothing anywhere
const NEW_POST_ID = "7100";

const LONG_PARA = "<p>" + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(6) + "</p>";
const MACRO = `<ac:structured-macro ac:name="info" ac:schema-version="1" ac:macro-id="m-1"><ac:rich-text-body><p>Note</p></ac:rich-text-body></ac:structured-macro>`;
/** One body for both the page and the blog post, so guard outcomes compare. */
const BODY =
  `<h1>Intro</h1>${LONG_PARA}<h2>Details</h2>${LONG_PARA}${MACRO}` +
  `<h2>More</h2>${LONG_PARA}<h2>End</h2>${LONG_PARA}`;

interface Item {
  id: string;
  title: string;
  spaceId: string;
  status: string;
  version: number;
  body: string;
}

let pages: Map<string, Item>;
let posts: Map<string, Item>;
/** Next PUT to /blogposts/{id} answers 409 and bumps the stored version. */
let conflictOnNextBlogPut = false;

function resetFixtures(): void {
  pages = new Map([
    [PAGE_ID, { id: PAGE_ID, title: "Runbook", spaceId: DOCS_ID, status: "current", version: 4, body: BODY }],
  ]);
  posts = new Map([
    [BLOG_ID, { id: BLOG_ID, title: "Release notes", spaceId: DOCS_ID, status: "current", version: 4, body: BODY }],
    [BLOG_OPS, { id: BLOG_OPS, title: "Ops news", spaceId: OPS_ID, status: "current", version: 2, body: BODY }],
    [DRAFT_ID, { id: DRAFT_ID, title: "Coming soon", spaceId: DOCS_ID, status: "draft", version: 1, body: BODY }],
  ]);
  conflictOnNextBlogPut = false;
}

type Req = { method: string; path: string; query: URLSearchParams; body: unknown };
const requests: Req[] = [];

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

function view(item: Item, withBody: boolean) {
  return {
    id: item.id,
    title: item.title,
    spaceId: item.spaceId,
    status: item.status,
    version: { number: item.version },
    ...(withBody ? { body: { storage: { value: item.body } } } : {}),
  };
}

const fetchMock = vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
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
  requests.push({ method, path: url.pathname, query: url.searchParams, body });
  const p = url.pathname.replace(/^\/wiki\/api\/v2/, "v2:").replace(/^\/wiki\/rest\/api/, "v1:");
  const withBody = url.searchParams.has("body-format");
  let m: RegExpMatchArray | null;

  if (p === "v2:/spaces") {
    const key = url.searchParams.get("keys");
    const id = key === "DOCS" ? DOCS_ID : key === "OPS" ? OPS_ID : undefined;
    return json({ results: id ? [{ id, key, name: key, type: "global" }] : [] });
  }
  if ((m = p.match(/^v2:\/spaces\/(\d+)$/))) {
    const key = m[1] === DOCS_ID ? "DOCS" : m[1] === OPS_ID ? "OPS" : undefined;
    return key ? json({ id: m[1], key, name: key, type: "global" }) : json({ message: "nf" }, 404);
  }
  if ((m = p.match(/^v2:\/pages\/(\d+)$/))) {
    const item = pages.get(m[1]);
    if (method === "GET") return item ? json(view(item, withBody)) : json({ message: "nf" }, 404);
    if (method === "PUT" && item) {
      const sent = body as { version: { number: number }; title: string; body?: { value: string } };
      item.version = sent.version.number;
      item.title = sent.title;
      if (sent.body) item.body = sent.body.value;
      return json(view(item, false));
    }
  }
  if ((m = p.match(/^v2:\/blogposts\/(\d+)$/))) {
    const id = m[1];
    if (method === "GET") {
      if (id === BLOG_500) return json({ message: "boom" }, 500);
      const item = posts.get(id);
      if (!item) return json({ message: "nf" }, 404);
      // A never-published draft is only returned when asked for by status.
      if (item.status === "draft" && url.searchParams.get("status") !== "draft") {
        return json({ message: "nf" }, 404);
      }
      return json(view(item, withBody));
    }
    if (method === "PUT") {
      const item = posts.get(id);
      if (!item) return json({ message: "nf" }, 404);
      if (conflictOnNextBlogPut) {
        conflictOnNextBlogPut = false;
        item.version += 1;
        return json({ message: "Version must be incremented" }, 409);
      }
      const sent = body as { version: { number: number }; title: string; status: string; body?: { value: string } };
      item.version = sent.version.number;
      item.title = sent.title;
      item.status = sent.status;
      if (sent.body) item.body = sent.body.value;
      return json(view(item, false));
    }
  }
  if (p === "v2:/blogposts" && method === "POST") {
    const sent = body as { title: string; spaceId: string; status: string; body: { value: string } };
    const item: Item = {
      id: NEW_POST_ID,
      title: sent.title,
      spaceId: sent.spaceId,
      status: sent.status,
      version: 1,
      body: sent.body.value,
    };
    posts.set(NEW_POST_ID, item);
    return json(view(item, false));
  }
  if (p === "v2:/footer-comments" && method === "POST") {
    return json({ id: "9100", version: { number: 1 } });
  }
  if ((m = p.match(/^v1:\/content\/(\d+)\/label$/))) {
    return json({ results: [] });
  }
  if ((m = p.match(/^v1:\/content\/(\d+)\/state$/))) {
    if (method === "GET") return json({ contentState: null });
    return json({});
  }
  if ((m = p.match(/^v1:\/content\/(\d+)\/child\/attachment$/)) && method === "POST") {
    return json({ results: [{ id: "att-1", title: "file.txt", version: { number: 1 } }] });
  }
  if ((m = p.match(/^v1:\/content\/(\d+)\/child\/attachment$/)) && method === "GET") {
    return json({ results: [] });
  }
  if (p === "v1:/settings/lookandfeel" || p.startsWith("v1:/settings")) {
    return json({});
  }
  return json({ message: `unexpected ${method} ${p}` }, 404);
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Result = {
  content: { type: string; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};
type Handler = (args: Record<string, unknown>) => Promise<Result>;
let handlers = new Map<string, Handler>();

async function boot(settings: Record<string, unknown> | undefined): Promise<void> {
  mockSettings = settings;
  mockRegisterTool.mockClear();
  vi.resetModules();
  const { main } = await import("./index.js");
  await main();
  handlers = new Map();
  for (const c of mockRegisterTool.mock.calls) {
    const [name, , handler] = c as [string, unknown, Handler];
    handlers.set(name, handler);
  }
  // Fresh module instances after the reset: clear their state too.
  (await import("./page-cache.js")).pageCache.clear();
  (await import("./space-allowlist.js")).pageSpaceCache._resetForTest();
  (await import("./confluence-client.js"))._resetSpaceKeyCacheForTests();
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

const writes = () => requests.filter((r) => r.method !== "GET" && r.method !== "HEAD");
const v2 = (path: string) => `/wiki/api/v2${path}`;
const v1 = (path: string) => `/wiki/rest/api${path}`;

/** Zod defaults are applied by the SDK, not the handler, so pass them. */
const UPDATE_DEFAULTS = {
  confirm_deletions: false,
  replace_body: false,
  confirm_shrinkage: false,
  confirm_structure_loss: false,
  allow_raw_html: false,
};
const createBlog = (args: Record<string, unknown>) =>
  call("create_blog_post", { space_key: "DOCS", title: "Hello", body: "<p>Hello world</p>", publish: false, allow_raw_html: false, ...args });
const updateBlog = (args: Record<string, unknown>) =>
  call("update_blog_post", { blog_post_id: BLOG_ID, title: "Release notes", version: 4, publish: false, ...UPDATE_DEFAULTS, ...args });
const updatePage = (args: Record<string, unknown>) =>
  call("update_page", { page_id: PAGE_ID, title: "Runbook", version: 4, ...UPDATE_DEFAULTS, ...args });

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
  resetFixtures();
  fetchMock.mockClear();
  mockLogMutation.mockClear();
  mockElicitInput.mockClear();
  requests.length = 0;
});

// ---------------------------------------------------------------------------
// Stage A
// ---------------------------------------------------------------------------

describe("A2: the space allowlist resolves blog posts", () => {
  beforeAll(async () => {
    await boot({ spaces: ["DOCS"] });
  });
  beforeEach(async () => {
    (await import("./space-allowlist.js")).pageSpaceCache._resetForTest();
  });

  it("a blog post in an allowed space goes through", async () => {
    const { isError } = await call("add_label", { page_id: BLOG_ID, labels: ["x"] });
    expect(isError).toBe(false);
    // Resolution: /pages 404, then /blogposts, then the space id → key.
    const reads = requests.filter((r) => r.method === "GET").map((r) => r.path);
    expect(reads.slice(0, 3)).toEqual([
      v2(`/pages/${BLOG_ID}`),
      v2(`/blogposts/${BLOG_ID}`),
      v2(`/spaces/${DOCS_ID}`),
    ]);
    expect(writes()).toEqual([
      expect.objectContaining({ method: "POST", path: v1(`/content/${BLOG_ID}/label`), body: [{ prefix: "global", name: "x" }] }),
    ]);
  });

  it("a blog post in a disallowed space is refused with no write", async () => {
    const { text, isError } = await call("add_label", { page_id: BLOG_OPS, labels: ["x"] });
    expect(isError).toBe(true);
    expect(text).toContain('Space "OPS" is not in this profile\'s allowlist');
    expect(writes()).toEqual([]);
  });

  it("an id that resolves to nothing is refused with no write", async () => {
    const { isError } = await call("add_label", { page_id: MISSING, labels: ["x"] });
    expect(isError).toBe(true);
    expect(writes()).toEqual([]);
    // Every lookup was tried: pages, blogposts, then the draft read.
    expect(requests.map((r) => `${r.path}${r.query.get("status") ? `?status=${r.query.get("status")}` : ""}`)).toEqual([
      v2(`/pages/${MISSING}`),
      v2(`/blogposts/${MISSING}`),
      v2(`/blogposts/${MISSING}?status=draft`),
    ]);
  });

  it("a /pages 404 and a /blogposts 500 refuse the write; the post is not treated as unknown", async () => {
    const { text, isError } = await call("add_label", { page_id: BLOG_500, labels: ["x"] });
    expect(isError).toBe(true);
    expect(text).toContain("500");
    expect(writes()).toEqual([]);
    expect(requests.map((r) => r.path)).toEqual([v2(`/pages/${BLOG_500}`), v2(`/blogposts/${BLOG_500}`)]);
  });

  it("a draft blog post is resolved through the draft read and judged by its space", async () => {
    const { isError } = await call("add_label", { page_id: DRAFT_ID, labels: ["x"] });
    expect(isError).toBe(false);
    expect(requests.some((r) => r.path === v2(`/blogposts/${DRAFT_ID}`) && r.query.get("status") === "draft")).toBe(true);
    expect(writes().map((w) => w.path)).toEqual([v1(`/content/${DRAFT_ID}/label`)]);
  });

  it("a page keeps its page-only checks: update_page on an allowed blog post id still writes nothing", async () => {
    const { text, isError } = await updatePage({ page_id: BLOG_ID, body: "<p>x</p>" });
    expect(isError).toBe(true);
    expect(text).toContain(`id ${BLOG_ID} is a blog post`);
    expect(writes()).toEqual([]);
  });
});

/**
 * A3 decision: allow side writes on blog posts. Each tool, with a blog post
 * id, sends the same request it sends for a page, with or without an
 * allowlist (the allowlist only adds the space check).
 */
describe.each([
  ["no allowlist", undefined],
  ["allowlist", { spaces: ["DOCS"] }],
] as const)("A3: side writes on a blog post (%s)", (_label, settings) => {
  beforeAll(async () => {
    await boot(settings === undefined ? undefined : { ...settings });
  });

  it("add_label", async () => {
    const r = await call("add_label", { page_id: BLOG_ID, labels: ["release"] });
    expect(r.isError).toBe(false);
    expect(writes()).toEqual([
      expect.objectContaining({ method: "POST", path: v1(`/content/${BLOG_ID}/label`), body: [{ prefix: "global", name: "release" }] }),
    ]);
  });

  it("remove_label", async () => {
    const r = await call("remove_label", { page_id: BLOG_ID, label: "release" });
    expect(r.isError).toBe(false);
    const w = writes();
    expect(w).toEqual([expect.objectContaining({ method: "DELETE", path: v1(`/content/${BLOG_ID}/label`) })]);
    expect(w[0].query.get("name")).toBe("release");
  });

  it("set_page_status", async () => {
    const r = await call("set_page_status", { page_id: BLOG_ID, name: "Ready", color: "#57D9A3" });
    expect(r.isError).toBe(false);
    expect(writes()).toEqual([
      expect.objectContaining({ method: "PUT", path: v1(`/content/${BLOG_ID}/state`), body: { name: "Ready", color: "#57D9A3" } }),
    ]);
  });

  it("add_attachment", async () => {
    const r = await call("add_attachment", { page_id: BLOG_ID, file_path: "/work/file.txt", overwrite: false });
    expect(r.isError).toBe(false);
    expect(writes()).toEqual([
      expect.objectContaining({ method: "POST", path: v1(`/content/${BLOG_ID}/child/attachment`) }),
    ]);
  });

  it("create_comment: a reply is keyed by the parent comment", async () => {
    const r = await call("create_comment", { page_id: BLOG_ID, body: "thanks", type: "footer", parent_comment_id: "9001", text_selection_match_index: 0 });
    expect(r.isError).toBe(false);
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ method: "POST", path: v2("/footer-comments"), body: { parentCommentId: "9001" } });
    expect(w[0].body).not.toHaveProperty("pageId");
    expect(w[0].body).not.toHaveProperty("blogPostId");
  });

  it("create_comment: a new top-level footer comment sends blogPostId, not pageId", async () => {
    const r = await call("create_comment", { page_id: BLOG_ID, body: "nice post", type: "footer", text_selection_match_index: 0 });
    expect(r.isError).toBe(false);
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ method: "POST", path: v2("/footer-comments"), body: { blogPostId: BLOG_ID } });
    expect(w[0].body).not.toHaveProperty("pageId");
  });

  it("create_comment: a new top-level footer comment on a page still sends pageId", async () => {
    const r = await call("create_comment", { page_id: PAGE_ID, body: "ok", type: "footer", text_selection_match_index: 0 });
    expect(r.isError).toBe(false);
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ method: "POST", path: v2("/footer-comments"), body: { pageId: PAGE_ID } });
    expect(w[0].body).not.toHaveProperty("blogPostId");
  });
});

describe("A4: add_drawio_diagram reads the page before uploading", () => {
  beforeAll(async () => {
    await boot(undefined);
  });

  const drawio = (page_id: string) =>
    call("add_drawio_diagram", {
      page_id,
      diagram_xml: "<mxfile><diagram/></mxfile>",
      diagram_name: "arch",
      append: true,
      return_macro_only: false,
    });

  it("an id that cannot be read: no upload is sent", async () => {
    const r = await drawio(MISSING);
    expect(r.isError).toBe(true);
    expect(writes()).toEqual([]);
    expect(requests.some((x) => x.path.includes("/child/attachment"))).toBe(false);
  });

  it("a blog post id: refused by name, no upload is sent", async () => {
    const r = await drawio(BLOG_ID);
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`id ${BLOG_ID} is a blog post`);
    expect(writes()).toEqual([]);
  });

  it("a readable page still gets the upload and then the page update", async () => {
    const r = await drawio(PAGE_ID);
    expect(r.isError).toBe(false);
    const w = writes().map((x) => `${x.method} ${x.path}`);
    expect(w[0]).toBe(`POST ${v1(`/content/${PAGE_ID}/child/attachment`)}`);
    expect(w[1]).toBe(`PUT ${v2(`/pages/${PAGE_ID}`)}`);
  });
});
