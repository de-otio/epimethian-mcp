/**
 * search_pages read scoping, excerpts, redaction and fencing (S5, T5), driven
 * through the real handler with the Confluence client mocked.
 *
 * Profile settings are resolved once per `main()`, so each scenario boots a
 * fresh copy of the server module with its own settings.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://test.atlassian.net";
  process.env.CONFLUENCE_EMAIL = "user@example.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
  process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "0";
  process.env.EPIMETHIAN_WRITE_BUDGET_HOURLY = "0";
  process.env.EPIMETHIAN_ALLOW_UNGATED_WRITES = "true";
  // search_pages never writes; keep main() from touching ~/.epimethian.
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

vi.mock("./provenance.js", () => ({
  markPageUnverified: vi.fn().mockResolvedValue({}),
}));

let mockSettings: Record<string, unknown> | undefined;

vi.mock("../shared/profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/profiles.js")>();
  return { ...actual, getProfileSettings: vi.fn(async () => mockSettings) };
});

const mockSearchPages = vi.fn();

vi.mock("./confluence-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./confluence-client.js")>();
  return {
    ...actual,
    searchPages: (...args: unknown[]) => mockSearchPages(...args),
    getConfig: vi.fn().mockResolvedValue({
      url: "https://test.atlassian.net",
      email: "user@example.com",
      profile: "scope-test",
      readOnly: false,
      attribution: true,
      apiV2: "https://test.atlassian.net/wiki/api/v2",
      apiV1: "https://test.atlassian.net/wiki/rest/api",
      authHeader: "Basic dGVzdA==",
      jsonHeaders: {},
    }),
    validateStartup: vi.fn().mockResolvedValue(undefined),
    ensureAttributionLabel: vi.fn().mockResolvedValue({}),
  };
});

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

/** Boot a fresh server module with `settings` and return its search_pages handler. */
async function bootSearchPages(settings: Record<string, unknown> | undefined): Promise<Handler> {
  mockSettings = settings;
  mockRegisterTool.mockClear();
  vi.resetModules();
  const { main } = await import("./index.js");
  await main();
  const call = mockRegisterTool.mock.calls.find(([name]) => name === "search_pages");
  if (call === undefined) throw new Error("search_pages was not registered");
  return call[2] as Handler;
}

const ARGS = { cql: 'title ~ "plan"', limit: 25, all_spaces: false, excerpts: true };

const RESULT_A = {
  id: "101",
  title: "Plan for @@@hl@@@Falcon@@@endhl@@@",
  excerpt: "the @@@hl@@@plan@@@endhl@@@ mentions Project Falcon",
};
const RESULT_B = { id: "102", title: "Other plan", excerpt: "nothing special" };

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

beforeEach(() => {
  mockSearchPages.mockReset();
  mockSearchPages.mockResolvedValue([RESULT_A, RESULT_B]);
});

describe("search_pages without read-scope settings", () => {
  it("passes the query through unchanged", async () => {
    const handler = await bootSearchPages(undefined);
    await handler(ARGS);
    expect(mockSearchPages).toHaveBeenCalledWith('title ~ "plan"', 25);
  });

  it("T5: emits exactly one fence and one canary per result", async () => {
    const handler = await bootSearchPages(undefined);
    const text = (await handler(ARGS)).content[0].text;
    expect(count(text, "<<<CONFLUENCE_UNTRUSTED")).toBe(2);
    expect(count(text, "<<<END_CONFLUENCE_UNTRUSTED>>>")).toBe(2);
    expect(count(text, "canary:")).toBe(2);
  });

  it("keeps title, excerpt and metadata inside the result's fence", async () => {
    const handler = await bootSearchPages(undefined);
    const text = (await handler(ARGS)).content[0].text;
    const firstFence = text.slice(
      text.indexOf("<<<CONFLUENCE_UNTRUSTED"),
      text.indexOf("<<<END_CONFLUENCE_UNTRUSTED>>>"),
    );
    expect(firstFence).toContain("pageId=101");
    expect(firstFence).toContain("ID: 101");
    expect(firstFence).toContain("Title: Plan for Falcon");
    expect(firstFence).toContain("Excerpt: the plan mentions Project Falcon");
  });

  it("always strips highlight markers", async () => {
    const handler = await bootSearchPages(undefined);
    const text = (await handler(ARGS)).content[0].text;
    expect(text).not.toContain("@@@hl@@@");
    expect(text).not.toContain("@@@endhl@@@");
  });

  it("excerpts: false omits excerpts and still fences once per result", async () => {
    const handler = await bootSearchPages(undefined);
    const text = (await handler({ ...ARGS, excerpts: false })).content[0].text;
    expect(text).not.toContain("Excerpt:");
    expect(text).not.toContain("nothing special");
    expect(text).toContain("Title: Other plan");
    expect(count(text, "canary:")).toBe(2);
  });

  it("ignores all_spaces when no read_spaces is configured", async () => {
    const handler = await bootSearchPages(undefined);
    const result = await handler({ ...ARGS, all_spaces: true });
    expect(result.isError).toBeUndefined();
    expect(mockSearchPages).toHaveBeenCalledWith('title ~ "plan"', 25);
  });

  it("reports no results plainly", async () => {
    const handler = await bootSearchPages(undefined);
    mockSearchPages.mockResolvedValue([]);
    expect((await handler(ARGS)).content[0].text).toBe("No pages found matching the query.");
  });
});

describe("search_pages with read_spaces (hygiene mode)", () => {
  const settings = { read_spaces: ["DOCS", "TEAM"] };

  it("conjoins the query with the configured spaces and says so", async () => {
    const handler = await bootSearchPages(settings);
    const result = await handler(ARGS);
    expect(mockSearchPages).toHaveBeenCalledWith(
      '(title ~ "plan") AND space in ("DOCS","TEAM")',
      25,
    );
    expect(result.content[0].text).toContain("restricted to spaces: DOCS, TEAM");
    expect(result.content[0].text).toContain("all_spaces: true");
  });

  it("keeps a trailing ORDER BY after the restriction", async () => {
    const handler = await bootSearchPages(settings);
    await handler({ ...ARGS, cql: 'title ~ "plan" ORDER BY lastmodified DESC' });
    expect(mockSearchPages).toHaveBeenCalledWith(
      '(title ~ "plan") AND space in ("DOCS","TEAM") ORDER BY lastmodified DESC',
      25,
    );
  });

  it("all_spaces: true searches unscoped", async () => {
    const handler = await bootSearchPages(settings);
    const result = await handler({ ...ARGS, all_spaces: true });
    expect(result.isError).toBeUndefined();
    expect(mockSearchPages).toHaveBeenCalledWith('title ~ "plan"', 25);
    expect(result.content[0].text).not.toContain("restricted to spaces");
  });

  it("refuses a query that would escape the wrapper, without searching", async () => {
    const handler = await bootSearchPages(settings);
    const result = await handler({ ...ARGS, cql: 'title ~ "x") OR (space = "OPS"' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("parentheses");
    expect(mockSearchPages).not.toHaveBeenCalled();
  });

  it("an empty read_spaces list blocks scoped search but not all_spaces", async () => {
    const handler = await bootSearchPages({ read_spaces: [] });
    const blocked = await handler(ARGS);
    expect(blocked.isError).toBe(true);
    expect(mockSearchPages).not.toHaveBeenCalled();

    const widened = await handler({ ...ARGS, all_spaces: true });
    expect(widened.isError).toBeUndefined();
    expect(mockSearchPages).toHaveBeenCalledWith('title ~ "plan"', 25);
  });
});

describe("search_pages with read_spaces_enforced", () => {
  const settings = { read_spaces: ["DOCS"], read_spaces_enforced: true };

  it("rejects all_spaces: true and never searches", async () => {
    const handler = await bootSearchPages(settings);
    const result = await handler({ ...ARGS, all_spaces: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("read_spaces_enforced");
    expect(mockSearchPages).not.toHaveBeenCalled();
  });

  it("still scopes ordinary queries", async () => {
    const handler = await bootSearchPages(settings);
    const result = await handler(ARGS);
    expect(mockSearchPages).toHaveBeenCalledWith('(title ~ "plan") AND space in ("DOCS")', 25);
    // Enforced scope is not advertised as widenable.
    expect(result.content[0].text).not.toContain("all_spaces");
  });

  it("an unscopable query is an error that does not suggest all_spaces", async () => {
    const handler = await bootSearchPages(settings);
    const result = await handler({ ...ARGS, cql: 'title ~ "x' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain("all_spaces");
    expect(mockSearchPages).not.toHaveBeenCalled();
  });
});

describe("search_pages with redact_patterns", () => {
  it("redacts titles and excerpts, including encoded and highlighted forms", async () => {
    mockSearchPages.mockResolvedValue([
      {
        id: "101",
        title: "Plan for Pro@@@hl@@@ject@@@endhl@@@ Falcon",
        excerpt: "mentions project&#32;falcon and PROJECT FALCON again",
      },
    ]);
    const handler = await bootSearchPages({ redact_patterns: ["project falcon"] });
    const text = (await handler(ARGS)).content[0].text;
    expect(text).toContain("Title: Plan for [redacted]");
    expect(text).toContain("Excerpt: mentions [redacted] and [redacted] again");
    expect(text.toLowerCase()).not.toContain("project falcon");
    expect(text).not.toContain("project&#32;falcon");
  });

  it("leaves text alone when no pattern matches", async () => {
    const handler = await bootSearchPages({ redact_patterns: ["zzz-no-match"] });
    const text = (await handler(ARGS)).content[0].text;
    expect(text).toContain("Title: Other plan");
    expect(text).not.toContain("[redacted]");
  });
});

describe("search_pages with invalid read-scope settings", () => {
  it("refuses every call and never searches", async () => {
    const handler = await bootSearchPages({ read_spaces_enforced: true });
    const result = await handler(ARGS);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("read_spaces_enforced");
    expect(mockSearchPages).not.toHaveBeenCalled();
  });

  it("does not echo a malformed pattern in the error", async () => {
    const pattern = "Q".repeat(250);
    const handler = await bootSearchPages({ redact_patterns: [pattern] });
    const result = await handler(ARGS);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain(pattern);
    expect(mockSearchPages).not.toHaveBeenCalled();
  });
});
