/**
 * W-MULTI (R3, M10, H1): update_page_sections end to end — find_replace
 * entries, the aggregate guard, all-or-nothing behaviour and confirmation
 * binding through the real handler and safe-write pipeline. Only the
 * Confluence HTTP layer and the MCP server object are mocked.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://docs.example.com";
  process.env.CONFLUENCE_EMAIL = "user@example.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
  process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "0";
  process.env.EPIMETHIAN_WRITE_BUDGET_HOURLY = "0";
  delete process.env.EPIMETHIAN_ALLOW_UNGATED_WRITES;
  delete process.env.EPIMETHIAN_DISABLE_SOFT_CONFIRM;
  delete process.env.EPIMETHIAN_BYPASS_ELICITATION;
  delete process.env.EPIMETHIAN_TOKEN_IN_TEXT;
  process.env.EPIMETHIAN_HIDE_TOKEN_IN_TEXT = "true";
  // Route every gate through the soft-confirmation (token) path.
  process.env.EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED = "true";
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
        getClientCapabilities: () => ({ elicitation: {} }),
        elicitInput: vi.fn(),
      },
    };
  }),
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

const CLOUD_ID = "cloud-multi-test-001";
const PAGE_ID = "5151";

const mockGetPage = vi.fn();
const mockRawUpdatePage = vi.fn();

vi.mock("./confluence-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./confluence-client.js")>();
  return {
    ...actual,
    resolveSpaceId: vi.fn().mockResolvedValue("1002"),
    getPage: mockGetPage,
    _rawUpdatePage: mockRawUpdatePage,
    _rawCreatePage: vi.fn(),
    getPageByTitle: vi.fn().mockResolvedValue(null),
    getContentState: vi.fn().mockResolvedValue(null),
    setContentState: vi.fn().mockResolvedValue(undefined),
    removeContentState: vi.fn().mockResolvedValue(undefined),
    getLabels: vi.fn().mockResolvedValue([]),
    addLabels: vi.fn().mockResolvedValue(undefined),
    ensureAttributionLabel: vi.fn().mockResolvedValue({}),
    setClientLabel: vi.fn().mockResolvedValue(undefined),
    validateStartup: vi.fn().mockResolvedValue(undefined),
    getConfig: vi.fn(async () => ({
      url: "https://docs.example.com",
      email: "user@example.com",
      profile: "multi-test",
      readOnly: false,
      attribution: true,
      apiV2: "https://docs.example.com/wiki/api/v2",
      apiV1: "https://docs.example.com/wiki/rest/api",
      authHeader: "Basic dGVzdA==",
      jsonHeaders: {},
      sealedCloudId: CLOUD_ID,
    })),
  };
});

vi.mock("./mutation-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mutation-log.js")>();
  return { ...actual, initMutationLog: vi.fn(), logMutation: vi.fn() };
});

const EMOTICON = '<ac:emoticon ac:name="smile"/>';
const FILLER = "lorem ipsum ".repeat(22);

const PAGE_BODY =
  `<h2>Intro</h2><p>Hello alpha world.</p><p>keep ${EMOTICON} me</p>` +
  `<h2>Other</h2><p>other ${EMOTICON} text</p><p>twin twin</p>` +
  `<h2>Last</h2><p>last words</p>`;

const FIVE_SECTION_BODY = [1, 2, 3, 4, 5]
  .map((i) => `<h2>S${i}</h2><p>KEEP${i} ${"keep text ".repeat(9)} DROP${i}:${FILLER}</p>`)
  .join("");

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: { text: string }[];
  structuredContent?: Record<string, unknown>;
}>;

let handler: Handler;

function pageWith(body: string) {
  return {
    id: PAGE_ID,
    title: "Handbook",
    version: { number: 3 },
    body: { storage: { value: body } },
    space: { key: "TEAM" },
    _links: { webui: `/pages/${PAGE_ID}` },
  };
}

beforeAll(async () => {
  const { main } = await import("./index.js");
  await main();
  const call = mockRegisterTool.mock.calls.find((c) => c[0] === "update_page_sections")!;
  handler = call[2] as Handler;
});

beforeEach(async () => {
  const { _resetForTest } = await import("./confirmation-tokens.js");
  _resetForTest();
  mockGetPage.mockReset();
  mockGetPage.mockResolvedValue(pageWith(PAGE_BODY));
  mockRawUpdatePage.mockReset();
  mockRawUpdatePage.mockImplementation(async (id: string) => ({
    page: { id, title: "Handbook", version: { number: 4 } },
    newVersion: 4,
  }));
});

function call(sections: unknown[], extra: Record<string, unknown> = {}) {
  return handler({ page_id: PAGE_ID, version: 3, sections, ...extra });
}

describe("update_page_sections with find_replace entries (R3)", () => {
  it("applies body and find_replace entries in ONE PUT", async () => {
    const r = await call([
      { section: "Intro", find_replace: [{ find: "Hello alpha", replace: "Hi alpha" }] },
      { section: "Last", body: "<p>final words</p>" },
    ]);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Updated 2 sections");
    expect(mockRawUpdatePage).toHaveBeenCalledTimes(1);
    expect(mockRawUpdatePage.mock.calls[0][1].body).toBe(
      PAGE_BODY.replace("Hello alpha", "Hi alpha").replace("<p>last words</p>", "<p>final words</p>"),
    );
  });

  it("a failing entry writes nothing (all or nothing)", async () => {
    const r = await call([
      { section: "Last", body: "<p>final words</p>" },
      { section: "Other", find_replace: [{ find: "twin", replace: "one" }] },
    ]);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("update_page_sections rejected");
    expect(r.content[0].text).toContain("FIND_REPLACE_AMBIGUOUS");
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
  });

  it("five entries each removing ~15% trip the aggregate guard; nothing is written", async () => {
    mockGetPage.mockResolvedValue(pageWith(FIVE_SECTION_BODY));
    const r = await call(
      [1, 2, 3, 4, 5].map((i) => ({
        section: `S${i}`,
        find_replace: [{ find: ` DROP${i}:${FILLER}`, replace: "" }],
      })),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Across all 5 sections combined");
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
  });

  it('rejects version "current" when an entry holds a placeholder', async () => {
    const r = await call(
      [{ section: "Intro", find_replace: [{ find: "keep [[epi:T0001]] me", replace: "keep me" }] }],
      { version: "current", confirm_deletions: true },
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("PLACEHOLDER_NEEDS_PINNED_VERSION");
    expect(mockGetPage).not.toHaveBeenCalled();
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
  });

  it('rejects version "current" when a BODY entry holds a placeholder', async () => {
    const sections = [
      { section: "Last", body: "<p>final words</p>" },
      { section: "Intro", body: "Hello alpha world.\n\nkeep [[epi:T0001]] me" },
    ];
    const r = await call(sections, { version: "current" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("PLACEHOLDER_NEEDS_PINNED_VERSION");
    expect(mockGetPage).not.toHaveBeenCalled();
    expect(mockRawUpdatePage).not.toHaveBeenCalled();

    // Pinned, the same call resolves T0001 to Intro's emoticon and writes.
    const ok = await call(sections);
    expect(ok.isError).toBeUndefined();
    const sent = mockRawUpdatePage.mock.calls[0][1].body as string;
    expect(sent).toContain(`keep ${EMOTICON} me`);
    expect(sent).toContain("<p>final words</p>");
  });

  it("refuses an empty body entry and writes nothing", async () => {
    const r = await call([{ section: "Last", body: "" }]);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Post-transform body is empty");
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
  });
});

describe("update_page_sections confirmation binding (H1)", () => {
  const dropIntro = { section: "Intro", find_replace: [{ find: "keep [[epi:T0001]] me", replace: "keep me" }] };
  const dropOther = { section: "Other", find_replace: [{ find: "other [[epi:T0001]] text", replace: "other text" }] };

  async function mint(sections: unknown[]): Promise<string> {
    const r = await call(sections, { confirm_deletions: true });
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.kind).toBe("confirmation_required");
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
    return r.structuredContent!.confirm_token as string;
  }

  it("the gate fires once on the aggregate; the token then writes one version", async () => {
    const token = await mint([dropIntro, dropOther]);
    const r = await call([dropIntro, dropOther], { confirm_deletions: true, confirm_token: token });
    expect(r.isError).toBeUndefined();
    // Section-qualified ids in the result: T0001 exists in both sections.
    expect(r.content[0].text).toContain("Intro#T0001");
    expect(r.content[0].text).toContain("Other#T0001");
    expect(mockRawUpdatePage).toHaveBeenCalledTimes(1);
    const body = mockRawUpdatePage.mock.calls[0][1].body as string;
    expect(body).not.toContain(EMOTICON);
  });

  it("a token minted for one entry set is rejected for another", async () => {
    const token = await mint([dropIntro, dropOther]);
    const r = await call(
      [dropIntro, { ...dropOther, find_replace: [{ find: "other [[epi:T0001]] text", replace: "other prose" }] }],
      { confirm_deletions: true, confirm_token: token },
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("confirmation token is no longer valid");
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
  });

  it("a token minted for one entry is rejected when another entry is added", async () => {
    const token = await mint([dropIntro]);
    const r = await call([dropIntro, { section: "Last", body: "<p>more</p>" }], {
      confirm_deletions: true,
      confirm_token: token,
    });
    expect(r.isError).toBe(true);
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
  });
});
