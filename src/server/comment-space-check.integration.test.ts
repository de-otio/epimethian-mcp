/**
 * F3 on the comment tools: resolve_comment, delete_comment, and create_comment
 * replies are checked against the space allowlist by the space of the page the
 * comment belongs to. A comment outside the allowlist, or one whose page cannot
 * be found, is refused with no PUT/POST/DELETE on the wire.
 *
 * The real confluence-client runs against a stubbed `fetch`; only
 * validateStartup and the profile settings are stubbed. Each scenario boots a
 * fresh server module, because settings are resolved once per `main()`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://test.atlassian.net";
  process.env.CONFLUENCE_EMAIL = "user@test.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
  process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "0";
  process.env.EPIMETHIAN_WRITE_BUDGET_HOURLY = "0";
  process.env.EPIMETHIAN_ALLOW_UNGATED_WRITES = "true";
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

let mockSettings: Record<string, unknown> | undefined;

vi.mock("../shared/profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/profiles.js")>();
  return { ...actual, getProfileSettings: vi.fn(async () => mockSettings) };
});

// Real client; only the startup probe (network) is stubbed, and the server
// sees a named profile so that its settings are loaded.
vi.mock("./confluence-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./confluence-client.js")>();
  return {
    ...actual,
    validateStartup: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn(async () => ({ ...(await actual.getConfig()), profile: "scope-test" })),
  };
});

const SPACES: Record<string, string> = { "1001": "DOCS", "1002": "OPS" };
const PAGES: Record<string, string> = { "5001": "1001", "5002": "1002" };

/** Comments by id: what GET /{type}-comments/{id} returns. */
const COMMENTS: Record<string, Record<string, unknown>> = {
  // inline, on a page in DOCS (allowed)
  "9102": { id: "9102", pageId: "5001", version: { number: 1 } },
  // inline, on a page in OPS (not allowed)
  "9101": { id: "9101", pageId: "5002", version: { number: 1 } },
  // footer, on a page in OPS
  "9201": { id: "9201", pageId: "5002", version: { number: 1 } },
  // footer reply with no container id of its own; its parent is in OPS
  "9202": { id: "9202", parentCommentId: "9201", version: { number: 1 } },
  // footer comment on an attachment: no page or blog post container
  "9203": { id: "9203", version: { number: 1 } },
  // footer, on a page in DOCS
  "9204": { id: "9204", pageId: "5001", version: { number: 1 } },
};

type Req = { method: string; path: string };
const requests: Req[] = [];

const fetchMock = vi.fn(async (input: unknown, init?: { method?: string }) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  requests.push({ method, path: url.pathname });
  const json = (data: unknown) =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const p = url.pathname;
  let m: RegExpMatchArray | null;
  if ((m = p.match(/\/spaces\/(\d+)$/)) && SPACES[m[1]]) {
    return json({ id: m[1], key: SPACES[m[1]] });
  }
  if ((m = p.match(/\/pages\/(\d+)$/)) && PAGES[m[1]]) {
    return json({ id: m[1], title: "T", spaceId: PAGES[m[1]], version: { number: 3 } });
  }
  if ((m = p.match(/\/(footer|inline)-comments\/(\d+)$/)) && COMMENTS[m[2]]) {
    if (method === "GET") return json(COMMENTS[m[2]]);
    if (method === "PUT") return json({ ...COMMENTS[m[2]], version: { number: 2 } });
    if (method === "DELETE") return new Response(null, { status: 204 });
  }
  if (method === "POST" && p.endsWith("/footer-comments")) {
    return json({ id: "9999", version: { number: 1 } });
  }
  return new Response("not found", { status: 404 });
});

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;
let handlers = new Map<string, Handler>();

async function boot(settings: Record<string, unknown> | undefined): Promise<void> {
  mockSettings = settings;
  mockRegisterTool.mockClear();
  vi.resetModules();
  const { main } = await import("./index.js");
  await main();
  handlers = new Map();
  for (const [name, , handler] of mockRegisterTool.mock.calls) handlers.set(name, handler);
}

async function call(tool: string, args: Record<string, unknown>) {
  const result = await handlers.get(tool)!(args);
  return { text: result.content[0].text, isError: result.isError === true };
}

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
});

describe("comment tools with a spaces allowlist", () => {
  beforeAll(async () => {
    await boot({ spaces: ["DOCS"] });
  });

  it("resolve_comment refuses a comment on a page outside the allowlist, with no PUT", async () => {
    const r = await call("resolve_comment", { comment_id: "9101", resolved: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Space "OPS" is not in this profile\'s allowlist');
    expect(writes()).toEqual([]);
  });

  it("resolve_comment goes through for a comment inside the allowlist", async () => {
    const r = await call("resolve_comment", { comment_id: "9102", resolved: true });
    expect(r.isError).toBe(false);
    expect(writes()).toEqual([
      { method: "PUT", path: "/wiki/api/v2/inline-comments/9102" },
    ]);
  });

  it("delete_comment refuses a footer comment outside the allowlist, with no DELETE", async () => {
    const r = await call("delete_comment", { comment_id: "9201", type: "footer" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('"OPS"');
    expect(writes()).toEqual([]);
  });

  it("delete_comment resolves a reply's space through its parent", async () => {
    const r = await call("delete_comment", { comment_id: "9202", type: "footer" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('"OPS"');
    expect(requests.map((q) => q.path)).toContain("/wiki/api/v2/footer-comments/9201");
    expect(writes()).toEqual([]);
  });

  it("delete_comment refuses a comment whose container cannot be found", async () => {
    const r = await call("delete_comment", { comment_id: "9203", type: "footer" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("(unresolvable)");
    expect(writes()).toEqual([]);
  });

  it("delete_comment refuses when the comment cannot be read", async () => {
    const r = await call("delete_comment", { comment_id: "9404", type: "inline" });
    expect(r.isError).toBe(true);
    expect(writes()).toEqual([]);
  });

  it("delete_comment goes through for a comment inside the allowlist", async () => {
    const r = await call("delete_comment", { comment_id: "9102", type: "inline" });
    expect(r.isError).toBe(false);
    expect(writes()).toEqual([
      { method: "DELETE", path: "/wiki/api/v2/inline-comments/9102" },
    ]);
  });

  it("create_comment refuses a reply whose parent is outside the allowlist, even with an allowed page_id", async () => {
    const r = await call("create_comment", {
      page_id: "5001",
      body: "reply",
      type: "footer",
      parent_comment_id: "9201",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('"OPS"');
    expect(writes()).toEqual([]);
  });

  it("create_comment posts a reply whose parent is inside the allowlist", async () => {
    const r = await call("create_comment", {
      page_id: "5001",
      body: "reply",
      type: "footer",
      parent_comment_id: "9204",
    });
    expect(r.isError).toBe(false);
    expect(writes()).toEqual([{ method: "POST", path: "/wiki/api/v2/footer-comments" }]);
  });
});

describe("comment tools without an allowlist", () => {
  beforeAll(async () => {
    await boot(undefined);
  });

  it("delete_comment sends only the DELETE, as before", async () => {
    const r = await call("delete_comment", { comment_id: "9201", type: "footer" });
    expect(r.isError).toBe(false);
    expect(requests).toEqual([{ method: "DELETE", path: "/wiki/api/v2/footer-comments/9201" }]);
  });

  it("resolve_comment reads and writes the comment only, as before", async () => {
    const r = await call("resolve_comment", { comment_id: "9101", resolved: true });
    expect(r.isError).toBe(false);
    expect(requests).toEqual([
      { method: "GET", path: "/wiki/api/v2/inline-comments/9101" },
      { method: "PUT", path: "/wiki/api/v2/inline-comments/9101" },
    ]);
  });
});
