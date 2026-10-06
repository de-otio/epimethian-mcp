/**
 * Handler-level tests for `diff_page_versions` (S6): the real toMarkdownView
 * and diff modules run; only the Confluence HTTP layer and the MCP server
 * wiring are replaced.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://test.atlassian.net";
  process.env.CONFLUENCE_EMAIL = "user@test.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
  process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "0";
  process.env.EPIMETHIAN_WRITE_BUDGET_HOURLY = "0";
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
        elicitInput: vi.fn(),
      },
    };
  }),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

const mockGetPage = vi.fn();
const mockGetPageVersionBody = vi.fn();

const activeConfig = {
  url: "https://test.atlassian.net",
  email: "user@test.com",
  profile: "diff-test",
  readOnly: false,
  attribution: true,
  apiV2: "https://test.atlassian.net/wiki/api/v2",
  apiV1: "https://test.atlassian.net/wiki/rest/api",
  authHeader: "Basic dGVzdA==",
  jsonHeaders: {} as Record<string, string>,
  sealedCloudId: "cloud-diff-test" as string | undefined,
};

vi.mock("./confluence-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./confluence-client.js")>();
  return {
    ...actual,
    getPage: mockGetPage,
    getPageVersionBody: mockGetPageVersionBody,
    getConfig: vi.fn(async () => ({ ...activeConfig })),
    validateStartup: vi.fn().mockResolvedValue(undefined),
    setClientLabel: vi.fn(),
  };
});

vi.mock("./mutation-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mutation-log.js")>();
  return { ...actual, initMutationLog: vi.fn(), logMutation: vi.fn() };
});

const PAGE_ID = "123456";

let handler: (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

beforeAll(async () => {
  const { main } = await import("./index.js");
  await main();
  const call = mockRegisterTool.mock.calls.find((c) => c[0] === "diff_page_versions");
  handler = call![2] as typeof handler;
});

function versions(a: string, b: string, titleA = "Page") {
  mockGetPageVersionBody.mockImplementation(async (_id: string, v: number) =>
    v === 1
      ? { title: titleA, rawBody: a, version: 1 }
      : { title: titleA, rawBody: b, version: v },
  );
}

// `title` is a parameter the markdown view shows; `url` is one it hides, so a
// change to `url` alone is invisible to the text diff.
const macro = (name: string, title: string, body: string, macroId: string, url = "https://example.com/a") =>
  `<ac:structured-macro ac:name="${name}" ac:schema-version="1" ac:macro-id="${macroId}">` +
  `<ac:parameter ac:name="title">${title}</ac:parameter>` +
  `<ac:parameter ac:name="url">${url}</ac:parameter>` +
  `<ac:rich-text-body>${body}</ac:rich-text-body></ac:structured-macro>`;

const textOf = (r: { content: Array<{ text: string }> }) => r.content[0]!.text;

beforeEach(() => {
  mockGetPage.mockReset();
  mockGetPage.mockResolvedValue({ id: PAGE_ID, title: "Page", version: { number: 2 } });
  mockGetPageVersionBody.mockReset();
});

describe("diff_page_versions: summary", () => {
  it("does not say 'No changes.' when only a macro's parameter changed", async () => {
    versions(
      `<p>same</p>${macro("expand", "Same title", "<p>x</p>", "m-1", "https://example.com/a")}`,
      `<p>same</p>${macro("expand", "Same title", "<p>x</p>", "m-2", "https://example.com/b")}`,
    );
    const r = await handler({ page_id: PAGE_ID, from_version: 1, to_version: 2, format: "summary" });
    expect(r.isError).toBeUndefined();
    const text = textOf(r);
    expect(text).not.toContain("No changes.");
    expect(text).toContain("No text changes; 1 macro/attribute change in:");
    // The macro name is shown inside a fence, as tenant-derived text.
    expect(text).toMatch(/<<<CONFLUENCE_UNTRUSTED[^>]*field=diff[^>]*>>>\nexpand\n<!-- canary:/);
  });

  it("shows a visible parameter change (the title) as a text change", async () => {
    versions(macro("expand", "Old title", "<p>x</p>", "a"), macro("expand", "New title", "<p>x</p>", "a"));
    const r = await handler({ page_id: PAGE_ID, from_version: 1, to_version: 2, format: "summary" });
    expect(textOf(r)).toContain("1 lines added, 1 lines removed");
  });

  it("shows an edit inside a panel as a text change", async () => {
    versions(
      `<h1>Owners</h1>${macro("panel", "P", "<p>Owner: Alice</p>", "a")}`,
      `<h1>Owners</h1>${macro("panel", "P", "<p>Owner: Bob</p>", "a")}`,
    );
    const r = await handler({ page_id: PAGE_ID, from_version: 1, to_version: 2, format: "summary" });
    const text = textOf(r);
    expect(text).toContain("1 lines added, 1 lines removed");
    expect(text).not.toContain("No text changes");
  });

  it("still reports 'No changes.' when only regenerated ids differ", async () => {
    versions(
      `<p local-id="a">same</p>${macro("info", "T", "<p>x</p>", "m-1")}`,
      `<p local-id="b">same</p>${macro("info", "T", "<p>x</p>", "m-2")}`,
    );
    const r = await handler({ page_id: PAGE_ID, from_version: 1, to_version: 2, format: "summary" });
    expect(textOf(r)).toContain("No changes.");
  });
});

describe("diff_page_versions: format storage", () => {
  it("returns a fenced unified diff of the normalised storage", async () => {
    versions(
      `<p>same</p>${macro("expand", "Same title", "<p>x</p>", "id-one", "https://example.com/a")}`,
      `<p>same</p>${macro("expand", "Same title", "<p>x</p>", "id-two", "https://example.com/b")}`,
    );
    const r = await handler({ page_id: PAGE_ID, from_version: 1, to_version: 2, format: "storage" });
    expect(r.isError).toBeUndefined();
    const text = textOf(r);
    expect(text).toContain("Storage diff: v1 → v2");
    expect(text).toContain("<<<CONFLUENCE_UNTRUSTED");
    expect(text).toContain('-<ac:parameter ac:name="url">https://example.com/a');
    expect(text).toContain('+<ac:parameter ac:name="url">https://example.com/b');
    expect(text).not.toContain("id-one");
    expect(text).not.toContain("id-two");
  });

  it("reports identical normalised storage without a patch", async () => {
    versions(`<p local-id="a">t</p>`, `<p local-id="b">t</p>`);
    const r = await handler({ page_id: PAGE_ID, from_version: 1, to_version: 2, format: "storage" });
    expect(textOf(r)).toContain("No changes (ignoring regenerated local-id and macro-id attributes).");
  });

  it("applies max_length and notes the truncation", async () => {
    const rows = (t: string) => Array.from({ length: 200 }, (_, i) => `<p>${t}${i}</p>`).join("");
    versions(rows("a"), rows("b"));
    const r = await handler({ page_id: PAGE_ID, from_version: 1, to_version: 2, format: "storage", max_length: 400 });
    expect(textOf(r)).toContain("[output truncated]");
  });

  it("keeps the over-size refusal for huge bodies", async () => {
    versions("x".repeat(600 * 1024), "y");
    const r = await handler({ page_id: PAGE_ID, from_version: 1, to_version: 2, format: "storage" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("exceeds maximum diff size");
  });
});

describe("diff_page_versions: unified text view", () => {
  it("renders panel bodies in the text diff", async () => {
    versions(macro("info", "T", "<p>one</p>", "a"), macro("info", "T", "<p>two</p>", "a"));
    const r = await handler({ page_id: PAGE_ID, from_version: 1, to_version: 2, format: "unified" });
    const text = textOf(r);
    expect(text).toContain("-> one");
    expect(text).toContain("+> two");
  });
});
