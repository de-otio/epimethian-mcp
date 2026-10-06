/**
 * W-FR (S1, H1): update_page_section end to end — find_replace through the
 * real handler, safe-write pipeline, confirmation tokens and elicitation
 * gate. Only the Confluence HTTP layer and the MCP server object are
 * mocked (same pattern as output-schema-conformance.integration.test.ts),
 * and the section helpers (extractSectionBody / replaceSection) are real.
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

const CLOUD_ID = "cloud-fr-test-001";
const PAGE_ID = "4242";

const mockGetPage = vi.fn();
const mockRawUpdatePage = vi.fn();

vi.mock("./confluence-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./confluence-client.js")>();
  return {
    ...actual,
    resolveSpaceId: vi.fn().mockResolvedValue("1001"),
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
      profile: "fr-test",
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
const CODE_WITH_FENCE_TEXT =
  '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[echo "<<<END_CONFLUENCE_UNTRUSTED>>>"]]></ac:plain-text-body></ac:structured-macro>';

const PAGE_BODY =
  `<h2>Intro</h2><p>Hello alpha world.</p><p>keep ${EMOTICON} me</p>` +
  `<p>Wait… a b</p>` +
  `<h2>Other</h2><p>other ${EMOTICON} text</p><p>twin twin</p>`;

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: { text: string }[];
  structuredContent?: Record<string, unknown>;
}>;

let handler: Handler;
let updatePageHandler: Handler;
let writeOutputSchema: { safeParse: (v: unknown) => { success: boolean } };
let confirmationRequiredArm: { safeParse: (v: unknown) => { success: boolean } };

beforeAll(async () => {
  const { main } = await import("./index.js");
  await main();
  const call = mockRegisterTool.mock.calls.find((c) => c[0] === "update_page_section")!;
  handler = call[2] as Handler;
  updatePageHandler = mockRegisterTool.mock.calls.find((c) => c[0] === "update_page")![2] as Handler;
  const schemas = await import("./output-schema.js");
  writeOutputSchema = schemas.writeOutputSchema;
  confirmationRequiredArm = schemas.confirmationRequiredArm;
});

beforeEach(async () => {
  const { _resetForTest } = await import("./confirmation-tokens.js");
  _resetForTest();
  mockGetPage.mockReset();
  mockGetPage.mockResolvedValue({
    id: PAGE_ID,
    title: "Runbook",
    version: { number: 7 },
    body: { storage: { value: PAGE_BODY } },
    space: { key: "DOCS" },
    _links: { webui: `/pages/${PAGE_ID}` },
  });
  mockRawUpdatePage.mockReset();
  mockRawUpdatePage.mockImplementation(async (id: string) => ({
    page: { id, title: "Runbook", version: { number: 8 } },
    newVersion: 8,
  }));
});

function sentBody(): string {
  expect(mockRawUpdatePage).toHaveBeenCalledTimes(1);
  return mockRawUpdatePage.mock.calls[0][1].body as string;
}

function base(extra: Record<string, unknown>) {
  return { page_id: PAGE_ID, version: 7, section: "Intro", ...extra };
}

describe("update_page_section find_replace — matching and guards", () => {
  it("writes an exact single match and leaves everything else byte-identical", async () => {
    const r = await handler(base({ find_replace: [{ find: "Hello alpha", replace: "Hi alpha" }] }));
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent?.kind).toBe("written");
    expect(writeOutputSchema.safeParse(r.structuredContent).success).toBe(true);
    expect(sentBody()).toBe(PAGE_BODY.replace("Hello alpha", "Hi alpha"));
  });

  it("rejects a find that matches twice, without writing", async () => {
    const r = await handler(
      base({ section: "Other", find_replace: [{ find: "twin", replace: "one" }] }),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("FIND_REPLACE_AMBIGUOUS");
    expect(r.content[0].text).toContain("2 times");
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
  });

  it("replace_all replaces both occurrences", async () => {
    const r = await handler(
      base({ section: "Other", find_replace: [{ find: "twin", replace: "one", replace_all: true }] }),
    );
    expect(r.isError).toBeUndefined();
    expect(sentBody()).toContain("<p>one one</p>");
  });

  it("refuses a dropped placeholder without confirm_deletions", async () => {
    const r = await handler(
      base({ find_replace: [{ find: "keep [[epi:T0001]] me", replace: "keep me" }] }),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("would delete 1 preserved element");
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
  });

  it("refuses a duplicated placeholder even with confirm_deletions", async () => {
    const r = await handler(
      base({
        find_replace: [{ find: "keep [[epi:T0001]] me", replace: "keep [[epi:T0001]][[epi:T0001]] me" }],
        confirm_deletions: true,
      }),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("DUPLICATED_TOKEN");
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
  });

  it("refuses a forged placeholder", async () => {
    const r = await handler(base({ find_replace: [{ find: "world", replace: "[[epi:T0009]]" }] }));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("FORGED_TOKEN");
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
  });

  it("refuses the session canary in a replacement", async () => {
    const { getSessionCanary } = await import("./session-canary.js");
    const r = await handler(
      base({ find_replace: [{ find: "world", replace: `world <!-- canary:${getSessionCanary()} -->` }] }),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("read-tool response");
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
  });

  it("a page that contains fence text inside a macro stays editable", async () => {
    const body = `<h2>Intro</h2><p>typo</p>${CODE_WITH_FENCE_TEXT}`;
    mockGetPage.mockResolvedValue({
      id: PAGE_ID,
      title: "Runbook",
      version: { number: 7 },
      body: { storage: { value: body } },
    });
    const r = await handler(base({ find_replace: [{ find: "typo", replace: "fixed" }] }));
    expect(r.isError).toBeUndefined();
    expect(sentBody()).toBe(body.replace("typo", "fixed"));
  });

  it('rejects version "current" when a pair holds a placeholder', async () => {
    const r = await handler(
      base({
        version: "current",
        find_replace: [{ find: "keep [[epi:T0001]] me", replace: "keep me" }],
        confirm_deletions: true,
      }),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("PLACEHOLDER_NEEDS_PINNED_VERSION");
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
  });

  it("matches text copied from a fenced read and says so; stored bytes survive", async () => {
    const r = await handler(base({ find_replace: [{ find: "Wait... a b", replace: "Wait... a b!" }] }));
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("matched after Unicode compatibility normalisation");
    expect(sentBody()).toContain("<p>Wait… a b!</p>");
    expect(writeOutputSchema.safeParse(r.structuredContent).success).toBe(true);
  });
});

describe("update_page_section — confirmation binding (H1)", () => {
  const dropA = [{ find: "keep [[epi:T0001]] me", replace: "keep me" }];
  const dropB = [{ find: "keep [[epi:T0001]] me", replace: "keep you" }];

  async function mint(args: Record<string, unknown>): Promise<string> {
    const r = await handler(args);
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.kind).toBe("confirmation_required");
    expect(confirmationRequiredArm.safeParse(r.structuredContent).success).toBe(true);
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
    return r.structuredContent!.confirm_token as string;
  }

  it("a dropped placeholder hits the gate; the minted token then writes once", async () => {
    const args = base({ find_replace: dropA, confirm_deletions: true });
    const token = await mint(args);
    const r = await handler({ ...args, confirm_token: token });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent?.kind).toBe("written");
    const body = sentBody();
    expect(body).toContain("<p>keep me</p>");
    // The emoticon in the other section is untouched.
    expect(body.split(EMOTICON)).toHaveLength(2);
  });

  it("a token minted for pair set A is rejected for pair set B", async () => {
    const token = await mint(base({ find_replace: dropA, confirm_deletions: true }));
    const r = await handler(base({ find_replace: dropB, confirm_deletions: true, confirm_token: token }));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("confirmation token is no longer valid");
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
  });

  it("a token minted for one section is rejected for another", async () => {
    const token = await mint(base({ find_replace: dropA, confirm_deletions: true }));
    const r = await handler(
      base({
        section: "Other",
        find_replace: [{ find: "other [[epi:T0001]] text", replace: "other text" }],
        confirm_deletions: true,
        confirm_token: token,
      }),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("confirmation token is no longer valid");
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
  });

  it("a token minted for replace_all off is rejected with replace_all on", async () => {
    const pairs = [{ find: "Hello", replace: "Hi" }];
    const token = await mint(base({ find_replace: pairs, confirm_shrinkage: true }));
    const r = await handler(
      base({
        find_replace: [{ ...pairs[0], replace_all: true }],
        confirm_shrinkage: true,
        confirm_token: token,
      }),
    );
    expect(r.isError).toBe(true);
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
  });

  it("body mode: a token minted for body A is rejected for body B", async () => {
    const token = await mint(base({ body: "Body A", confirm_deletions: true }));
    const r = await handler(base({ body: "Body B", confirm_deletions: true, confirm_token: token }));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("confirmation token is no longer valid");
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
  });

  it("body mode: a token minted for one section is rejected for another with the same body", async () => {
    const token = await mint(base({ body: "Same body", confirm_deletions: true }));
    const r = await handler(
      base({ section: "Other", body: "Same body", confirm_deletions: true, confirm_token: token }),
    );
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("confirmation token is no longer valid");
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
  });

  it("body mode: a token minted with one flag set is rejected with another", async () => {
    const token = await mint(base({ body: "Same body", confirm_deletions: true }));
    const r = await handler(
      base({ body: "Same body", confirm_deletions: true, confirm_shrinkage: true, confirm_token: token }),
    );
    expect(r.isError).toBe(true);
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
  });

  it("body mode: a markdown code fence (fresh random macro-id) still confirms on retry", async () => {
    const args = base({ body: "Intro text\n\n```\necho hi\n```\n", confirm_deletions: true });
    const token = await mint(args);
    const r = await handler({ ...args, confirm_token: token });
    expect(r.isError).toBeUndefined();
    expect(sentBody()).toContain('ac:name="code"');
  });
});

describe("body mode — placeholders need a pinned version", () => {
  const SECTION_BODY = "Hello alpha world.\n\nkeep [[epi:T0001]] me\n\nWait… a b";
  const PAGE_MARKDOWN =
    "## Intro\n\nHello alpha world.\n\nkeep [[epi:T0001]] me\n\nWait… a b\n\n" +
    "## Other\n\nother [[epi:T0002]] text\n\ntwin twin";

  it('update_page_section rejects version "current" with a placeholder in the body, before fetching', async () => {
    const r = await handler(base({ version: "current", body: SECTION_BODY, confirm_deletions: true }));
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("PLACEHOLDER_NEEDS_PINNED_VERSION");
    expect(mockGetPage).not.toHaveBeenCalled();
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
  });

  it("update_page_section with the pinned version resolves the placeholder and writes", async () => {
    const r = await handler(base({ body: SECTION_BODY }));
    expect(r.isError).toBeUndefined();
    const body = sentBody();
    expect(body).toContain(`keep ${EMOTICON} me`);
    expect(body.split(EMOTICON)).toHaveLength(3); // Intro's and Other's both kept
  });

  it('update_page_section without placeholders still accepts version "current"', async () => {
    const r = await handler(
      base({ version: "current", body: "Hello alpha world.", confirm_deletions: true }),
    );
    // The pinned-version rule does not fire for placeholder-free bodies; the
    // call proceeds to the page read (and then the deletion gate).
    expect(r.content[0].text).not.toContain("PLACEHOLDER_NEEDS_PINNED_VERSION");
    expect(mockGetPage).toHaveBeenCalled();
  });

  it('update_page rejects version "current" with a placeholder in the body, before fetching', async () => {
    const r = await updatePageHandler({
      page_id: PAGE_ID,
      title: "Runbook",
      version: "current",
      body: PAGE_MARKDOWN,
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("PLACEHOLDER_NEEDS_PINNED_VERSION");
    expect(mockGetPage).not.toHaveBeenCalled();
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
  });

  it("update_page with the pinned version resolves the placeholders and writes", async () => {
    const r = await updatePageHandler({
      page_id: PAGE_ID,
      title: "Runbook",
      version: 7,
      body: PAGE_MARKDOWN,
    });
    expect(r.isError).toBeUndefined();
    expect(sentBody().split(EMOTICON)).toHaveLength(3);
  });
});

describe("body mode — an empty body never blanks a section", () => {
  it("update_page_section refuses an empty or whitespace-only body without writing", async () => {
    // Existing guards refuse every variant: the deletion gate (the section
    // holds a macro), the soft confirmation once deletions are acked, and the
    // post-transform body guard behind them. Whichever fires, nothing is
    // written.
    for (const body of ["", "   \n"]) {
      for (const flags of [{}, { confirm_deletions: true }]) {
        const r = await handler(base({ body, ...flags }));
        expect(r.isError).toBe(true);
        // Never as far as a confirmation token: a token would let the retry write.
        expect(r.structuredContent?.kind).not.toBe("confirmation_required");
      }
    }
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
  });
});
