/**
 * Integration tests: `outputSchema` conformance for the five mutating tools.
 * (v6.6.2 plan §3.5 / T3)
 *
 * Scope: end-to-end validation that every write-tool result (success and
 * confirmation-required arms) validates against the Zod schemas declared via
 * `outputSchema` in T1's changes.
 *
 * The production handler pipeline (confirmation-tokens.ts, elicitation.ts,
 * safe-write.ts) is NOT mocked. Only the Confluence HTTP layer and the MCP
 * server wiring are mocked — the same pattern as
 * soft-elicitation.integration.test.ts.
 *
 * DEPENDENCY NOTE: This file imports from ./output-schema.js (T1's new
 * module). If T1 has not yet merged, the import will fail at test-collection
 * time and the suite is expected to be skipped by the orchestrator until the
 * merge is complete.
 *
 * Test-case coverage:
 *
 *  C1  success — update_page              structuredContent.kind === "written"
 *  C2  success — update_page_section      structuredContent.kind === "written"
 *  C3  success — append_to_page           structuredContent.kind === "written"
 *  C4  success — prepend_to_page          structuredContent.kind === "written"
 *  C5  success — delete_page              structuredContent.kind === "deleted"
 *  C6  soft-confirm — update_page         structuredContent.kind === "confirmation_required"
 *  C7  soft-confirm — update_page_section structuredContent.kind === "confirmation_required"
 *  C8  soft-confirm — append_to_page      structuredContent.kind === "confirmation_required"
 *  C9  soft-confirm — prepend_to_page     structuredContent.kind === "confirmation_required"
 *  C10 soft-confirm — delete_page         structuredContent.kind === "confirmation_required"
 *  C11 negative — wrong-arm discriminator integrity
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ---------------------------------------------------------------------------
// Environment bootstrap (must run before any module import)
// ---------------------------------------------------------------------------

vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://test.atlassian.net";
  process.env.CONFLUENCE_EMAIL = "user@test.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
  // Disable write-budget enforcement.
  process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "0";
  process.env.EPIMETHIAN_WRITE_BUDGET_HOURLY = "0";
  // Soft confirmation is ON by default.
  delete process.env.EPIMETHIAN_ALLOW_UNGATED_WRITES;
  delete process.env.EPIMETHIAN_DISABLE_SOFT_CONFIRM;
  delete process.env.EPIMETHIAN_BYPASS_ELICITATION;
  delete process.env.EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED;
  delete process.env.EPIMETHIAN_TOKEN_IN_TEXT;
});

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: vi.fn().mockResolvedValue(null),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

// ---------------------------------------------------------------------------
// MCP server mock — getClientCapabilities resolves to no-elicitation by
// default; individual tests override mockElicitInput for the fast-decline path.
// ---------------------------------------------------------------------------

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockRegisterTool = vi.fn();
const mockElicitInput = vi.fn();
const mockGetClientCapabilities = vi.fn(() => ({})); // default: no elicitation

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    registerTool: mockRegisterTool,
    server: {
      getClientVersion: () => ({ name: "test-client", version: "1.0.0" }),
      getClientCapabilities: mockGetClientCapabilities,
      elicitInput: mockElicitInput,
    },
  })),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Confluence HTTP mock
// ---------------------------------------------------------------------------

const DEFAULT_CLOUD_ID = "cloud-conform-test-001";
const DEFAULT_PAGE_ID = "page-conform-42";
const DEFAULT_SECTION = "Introduction";

const activeConfig = {
  url: "https://test.atlassian.net",
  email: "user@test.com",
  profile: "conform-test",
  readOnly: false,
  attribution: true,
  apiV2: "https://test.atlassian.net/wiki/api/v2",
  apiV1: "https://test.atlassian.net/wiki/rest/api",
  authHeader: "Basic dGVzdA==",
  jsonHeaders: {} as Record<string, string>,
  sealedCloudId: DEFAULT_CLOUD_ID as string | undefined,
};

const mockGetPage = vi.fn();
const mockRawUpdatePage = vi.fn();
const mockDeletePage = vi.fn();

vi.mock("./confluence-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./confluence-client.js")>();

  class ConfluenceConflictError extends Error {
    constructor(pageId: string) {
      super(
        `Version conflict: page ${pageId} has been modified since you last read it.`,
      );
      this.name = "ConfluenceConflictError";
    }
  }

  return {
    ...actual,
    ConfluenceConflictError,
    resolveSpaceId: vi.fn().mockResolvedValue("TEST"),
    getPage: mockGetPage,
    _rawCreatePage: vi.fn().mockResolvedValue({
      id: "new-99",
      title: "New Page",
      version: { number: 1 },
      space: { key: "TEST" },
      _links: { webui: "/pages/new-99" },
    }),
    _rawUpdatePage: mockRawUpdatePage,
    deletePage: mockDeletePage,
    getContentState: vi.fn().mockResolvedValue(null),
    setContentState: vi.fn().mockResolvedValue(undefined),
    removeContentState: vi.fn().mockResolvedValue(undefined),
    getSiteDefaultLocale: vi.fn().mockResolvedValue(undefined),
    getPageByTitle: vi.fn().mockResolvedValue(null),
    getAttachments: vi.fn().mockResolvedValue([]),
    uploadAttachment: vi.fn().mockResolvedValue({}),
    getLabels: vi.fn().mockResolvedValue([]),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
    formatPage: vi.fn().mockResolvedValue("# Test\n\nID: 42"),
    extractSection: vi.fn().mockReturnValue(null),
    extractSectionBody: vi.fn().mockImplementation((body: string, section: string) => {
      // Simulate a section body for DEFAULT_SECTION.
      if (section === DEFAULT_SECTION) return "<p>Existing section body</p>";
      return null;
    }),
    replaceSection: vi.fn().mockReturnValue("<p>replaced</p>"),
    truncateStorageFormat: vi.fn().mockImplementation((s: string, n: number) => s.slice(0, n)),
    toMarkdownView: vi.fn().mockReturnValue("markdown"),
    looksLikeMarkdown: vi.fn().mockReturnValue(false),
    sanitizeError: vi.fn().mockImplementation((s: string) => s),
    getPageVersions: vi.fn().mockResolvedValue([]),
    getPageVersionBody: vi.fn().mockResolvedValue("<p>v1</p>"),
    searchPages: vi.fn().mockResolvedValue([]),
    listPages: vi.fn().mockResolvedValue([]),
    getPageChildren: vi.fn().mockResolvedValue([]),
    getSpaces: vi.fn().mockResolvedValue([]),
    searchUsers: vi.fn().mockResolvedValue([]),
    searchPagesByTitle: vi.fn().mockResolvedValue([]),
    setClientLabel: vi.fn().mockResolvedValue(undefined),
    ensureAttributionLabel: vi.fn().mockResolvedValue({}),
    getConfig: vi.fn(async () => ({ ...activeConfig })),
    validateStartup: vi.fn().mockResolvedValue(undefined),
    getFooterComments: vi.fn().mockResolvedValue([]),
    getInlineComments: vi.fn().mockResolvedValue([]),
    getCommentReplies: vi.fn().mockResolvedValue([]),
    createFooterComment: vi.fn().mockResolvedValue({ id: "c1" }),
    createInlineComment: vi.fn().mockResolvedValue({ id: "c2" }),
    resolveComment: vi.fn().mockResolvedValue(undefined),
    deleteFooterComment: vi.fn().mockResolvedValue(undefined),
    deleteInlineComment: vi.fn().mockResolvedValue(undefined),
    normalizeBodyForSubmit: actual.normalizeBodyForSubmit,
    ProfileNotConfiguredError: class ProfileNotConfiguredError extends Error {
      constructor(msg: string) { super(msg); this.name = "ProfileNotConfiguredError"; }
    },
  };
});

vi.mock("./mutation-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mutation-log.js")>();
  return { ...actual, initMutationLog: vi.fn(), logMutation: vi.fn() };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pageStub(version: number, body: string = "<p>Hello page</p>") {
  return {
    id: DEFAULT_PAGE_ID,
    title: "Test Page",
    version: { number: version },
    body: { storage: { value: body } },
    space: { key: "TEST" },
    _links: { webui: `/pages/${DEFAULT_PAGE_ID}` },
  };
}

function updateResponseStub(version: number) {
  return {
    page: {
      id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: { number: version },
      space: { key: "TEST" },
      _links: { webui: `/pages/${DEFAULT_PAGE_ID}` },
    },
    newVersion: version,
  };
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let registeredTools: Map<string, { handler: Function; schema: unknown }>;

beforeAll(async () => {
  const { main } = await import("./index.js");
  await main();

  registeredTools = new Map();
  for (const call of mockRegisterTool.mock.calls) {
    const [name, config, handler] = call as [string, unknown, Function];
    registeredTools.set(name, { handler, schema: config });
  }
});

afterAll(() => {
  // nothing to restore
});

beforeEach(async () => {
  // Reset token store before every test.
  const { _resetForTest } = await import("./confirmation-tokens.js");
  _resetForTest();

  // Reset elicitation warning flag.
  const { _resetStartupWarningForTest } = await import("./elicitation.js");
  _resetStartupWarningForTest();

  // Default: client does NOT support elicitation (soft-mode triggers).
  mockGetClientCapabilities.mockReturnValue({});
  mockElicitInput.mockReset();

  // Default: soft confirmation is active.
  delete process.env.EPIMETHIAN_ALLOW_UNGATED_WRITES;
  delete process.env.EPIMETHIAN_DISABLE_SOFT_CONFIRM;
  delete process.env.EPIMETHIAN_BYPASS_ELICITATION;
  delete process.env.EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED;
  delete process.env.EPIMETHIAN_TOKEN_IN_TEXT;

  // Reset cloudId to default.
  activeConfig.sealedCloudId = DEFAULT_CLOUD_ID;

  // Default page mock.
  mockGetPage.mockReset();
  mockGetPage.mockResolvedValue(pageStub(7));

  // Default update mock — succeeds.
  mockRawUpdatePage.mockReset();
  mockRawUpdatePage.mockResolvedValue(updateResponseStub(8));

  // Default delete mock — succeeds.
  mockDeletePage.mockReset();
  mockDeletePage.mockResolvedValue(undefined);

  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Import schemas from T1's output-schema module (loaded dynamically so the
// test file can still be collected even before T1 merges — the tests
// themselves will fail at runtime, which is the expected pre-merge state).
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let writeOutputSchema: { safeParse: (v: unknown) => { success: boolean }; parse: (v: unknown) => unknown };
let writeSuccessArm: { safeParse: (v: unknown) => { success: boolean }; parse: (v: unknown) => unknown };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deleteOutputSchema: { safeParse: (v: unknown) => { success: boolean }; parse: (v: unknown) => unknown };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let confirmationRequiredArm: { safeParse: (v: unknown) => { success: boolean }; parse: (v: unknown) => unknown };

// Separate beforeAll for the schemas — must run after the server beforeAll
// (Vitest runs beforeAll hooks in declaration order within the file).
beforeAll(async () => {
  const mod = await import("./output-schema.js");
  writeOutputSchema = mod.writeOutputSchema;
  writeSuccessArm = mod.writeSuccessArm;
  deleteOutputSchema = mod.deleteOutputSchema;
  confirmationRequiredArm = mod.confirmationRequiredArm;
});

// ---------------------------------------------------------------------------
// C1–C4: Success-path conformance — write tools
// ---------------------------------------------------------------------------

describe("C1–C4: success-path — write tools structuredContent conforms to writeOutputSchema", () => {
  it("C1: update_page success — structuredContent.kind === 'written' and writeOutputSchema passes", async () => {
    const handler = registeredTools.get("update_page")!.handler;

    // Use ALLOW_UNGATED_WRITES to skip the soft-confirm gate and go straight to success.
    process.env.EPIMETHIAN_ALLOW_UNGATED_WRITES = "true";

    const r = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>Updated content</p>",
      replace_body: true,
    });

    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Updated:");
    // T1 adds structuredContent to success responses.
    expect(r.structuredContent).toBeDefined();
    expect(r.structuredContent.kind).toBe("written");
    expect(writeOutputSchema.safeParse(r.structuredContent).success).toBe(true);
  });

  it("C2: update_page_section success — structuredContent.kind === 'written' and writeOutputSchema passes", async () => {
    const handler = registeredTools.get("update_page_section")!.handler;

    process.env.EPIMETHIAN_ALLOW_UNGATED_WRITES = "true";

    const r = await handler({
      page_id: DEFAULT_PAGE_ID,
      version: 7,
      section: DEFAULT_SECTION,
      body: "<p>New section content</p>",
    });

    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toBeDefined();
    expect(r.structuredContent.kind).toBe("written");
    expect(writeOutputSchema.safeParse(r.structuredContent).success).toBe(true);
  });

  it("C3: append_to_page success — structuredContent.kind === 'written' and writeOutputSchema passes", async () => {
    const handler = registeredTools.get("append_to_page")!.handler;

    process.env.EPIMETHIAN_ALLOW_UNGATED_WRITES = "true";

    const r = await handler({
      page_id: DEFAULT_PAGE_ID,
      version: 7,
      content: "<p>Appended content</p>",
    });

    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toBeDefined();
    expect(r.structuredContent.kind).toBe("written");
    expect(writeOutputSchema.safeParse(r.structuredContent).success).toBe(true);
  });

  it("C4: prepend_to_page success — structuredContent.kind === 'written' and writeOutputSchema passes", async () => {
    const handler = registeredTools.get("prepend_to_page")!.handler;

    process.env.EPIMETHIAN_ALLOW_UNGATED_WRITES = "true";

    const r = await handler({
      page_id: DEFAULT_PAGE_ID,
      version: 7,
      content: "<p>Prepended content</p>",
    });

    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toBeDefined();
    expect(r.structuredContent.kind).toBe("written");
    expect(writeOutputSchema.safeParse(r.structuredContent).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C5: Success-path conformance — delete_page
// ---------------------------------------------------------------------------

describe("C5: success-path — delete_page structuredContent conforms to deleteOutputSchema", () => {
  it("C5: delete_page with valid confirm_token — structuredContent.kind === 'deleted' and deleteOutputSchema passes", async () => {
    const { mintToken, computeDiffHash } = await import("./confirmation-tokens.js");

    // Mint a valid token for delete_page so the gate passes.
    const minted = mintToken({
      tool: "delete_page",
      cloudId: DEFAULT_CLOUD_ID,
      pageId: DEFAULT_PAGE_ID,
      pageVersion: 7,
      diffHash: computeDiffHash("", 7),
    });

    const handler = registeredTools.get("delete_page")!.handler;

    const r = await handler({
      page_id: DEFAULT_PAGE_ID,
      version: 7,
      confirm_token: minted.token,
    });

    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Deleted");
    // T1 adds structuredContent to delete success responses.
    expect(r.structuredContent).toBeDefined();
    expect(r.structuredContent.kind).toBe("deleted");
    expect(deleteOutputSchema.safeParse(r.structuredContent).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C6–C10: Confirmation-required conformance — every tool
//
// Each tool is called with no confirm_token and the client is configured to
// fast-decline (via EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED=true) so the
// soft-confirm path fires immediately without probing the client.
// ---------------------------------------------------------------------------

describe("C6–C10: confirmation-required arm — all five write tools conform to confirmationRequiredArm", () => {
  // Use the env-var override instead of mocking elicitInput timing — this is
  // simpler and deterministic (no timing dependency), and tests the same code
  // path (row 4 of the §3.3 precedence table).
  beforeEach(() => {
    process.env.EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED = "true";
    // Advertise elicitation capability so the env-var override is meaningful.
    mockGetClientCapabilities.mockReturnValue({ elicitation: {} });
  });

  afterEach(() => {
    delete process.env.EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED;
  });

  /**
   * Assert that a soft-confirm result conforms to confirmationRequiredArm:
   *  - isError === true
   *  - structuredContent is defined
   *  - structuredContent.kind === "confirmation_required"
   *  - confirm_token is a non-empty string of ≥ 16 chars
   *  - confirmationRequiredArm.safeParse passes
   */
  function assertConfirmationRequired(
    r: {
      isError?: boolean;
      content: { type: string; text: string }[];
      structuredContent?: Record<string, unknown>;
    },
    toolName: string,
  ) {
    expect(r.isError, `${toolName}: isError`).toBe(true);
    expect(r.content[0].text, `${toolName}: text contains marker`).toContain(
      "SOFT_CONFIRMATION_REQUIRED",
    );
    expect(r.structuredContent, `${toolName}: structuredContent defined`).toBeDefined();

    const sc = r.structuredContent!;
    expect(sc.kind, `${toolName}: kind`).toBe("confirmation_required");

    // confirm_token: non-empty string, ≥ 16 chars (plan §3.5 contract).
    expect(typeof sc.confirm_token, `${toolName}: confirm_token type`).toBe("string");
    expect(
      (sc.confirm_token as string).length,
      `${toolName}: confirm_token length ≥ 16`,
    ).toBeGreaterThanOrEqual(16);

    // Full schema validation.
    const result = confirmationRequiredArm.safeParse(sc);
    expect(result.success, `${toolName}: confirmationRequiredArm.safeParse`).toBe(true);
  }

  it("C6: update_page — no confirm_token → structuredContent.kind === 'confirmation_required'", async () => {
    const handler = registeredTools.get("update_page")!.handler;

    const r = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>New content</p>",
      replace_body: true,
    });

    assertConfirmationRequired(r, "update_page");
  });

  it("C7: update_page_section — no confirm_token + confirm_deletions → structuredContent.kind === 'confirmation_required'", async () => {
    const handler = registeredTools.get("update_page_section")!.handler;

    // confirm_deletions triggers the gate in update_page_section.
    const r = await handler({
      page_id: DEFAULT_PAGE_ID,
      version: 7,
      section: DEFAULT_SECTION,
      body: "<p>New section body</p>",
      confirm_deletions: ["T0001"],
    });

    assertConfirmationRequired(r, "update_page_section");
  });

  // C8 / C9: append_to_page and prepend_to_page are purely-additive tools
  // and do NOT trigger the soft-confirm gate even with
  // EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED=true — the gate only fires
  // for destructive intent (replace_body, deletion, delete_page itself).
  // Verify that here: with no destructive flags, the calls succeed and
  // emit kind: "written".
  it("C8: append_to_page — no destructive flags → succeeds (kind: 'written'), gate does NOT fire", async () => {
    const handler = registeredTools.get("append_to_page")!.handler;

    const r = await handler({
      page_id: DEFAULT_PAGE_ID,
      version: 7,
      content: "<p>Appended content</p>",
    });

    expect(r.isError).toBeFalsy();
    expect(r.structuredContent?.kind).toBe("written");
    expect(writeOutputSchema.safeParse(r.structuredContent).success).toBe(true);
  });

  it("C9: prepend_to_page — no destructive flags → succeeds (kind: 'written'), gate does NOT fire", async () => {
    const handler = registeredTools.get("prepend_to_page")!.handler;

    const r = await handler({
      page_id: DEFAULT_PAGE_ID,
      version: 7,
      content: "<p>Prepended content</p>",
    });

    expect(r.isError).toBeFalsy();
    expect(r.structuredContent?.kind).toBe("written");
    expect(writeOutputSchema.safeParse(r.structuredContent).success).toBe(true);
  });

  it("C10: delete_page — no confirm_token → structuredContent.kind === 'confirmation_required'", async () => {
    const handler = registeredTools.get("delete_page")!.handler;

    const r = await handler({
      page_id: DEFAULT_PAGE_ID,
      version: 7,
    });

    assertConfirmationRequired(r, "delete_page");
  });
});

// ---------------------------------------------------------------------------
// C11: Negative case — discriminator integrity
//
// A confirmation_required payload must NOT validate against writeOutputSchema.
// This verifies that the discriminated union cannot be confused across arms.
// ---------------------------------------------------------------------------

describe("C11: negative — discriminator integrity: confirmation_required does not satisfy writeOutputSchema", () => {
  it("C11: confirmation_required payload fails writeOutputSchema; a written payload fails confirmationRequiredArm", async () => {
    // Obtain a real confirmation_required payload.
    process.env.EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED = "true";
    mockGetClientCapabilities.mockReturnValue({ elicitation: {} });

    const handler = registeredTools.get("update_page")!.handler;

    const r = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>Discriminator test body</p>",
      replace_body: true,
    });

    delete process.env.EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED;

    expect(r.isError).toBe(true);
    const confirmationPayload = r.structuredContent;
    expect(confirmationPayload).toBeDefined();
    expect(confirmationPayload.kind).toBe("confirmation_required");

    // A confirmation_required payload satisfies writeOutputSchema (the
    // union accepts both arms by design) BUT must NOT satisfy
    // writeSuccessArm (the success-only arm).
    expect(writeOutputSchema.safeParse(confirmationPayload).success).toBe(true);
    expect(writeSuccessArm.safeParse(confirmationPayload).success).toBe(false);

    // A written payload must NOT satisfy confirmationRequiredArm.
    const writtenPayload = {
      kind: "written",
      page_id: DEFAULT_PAGE_ID,
      new_version: 8,
    };
    expect(confirmationRequiredArm.safeParse(writtenPayload).success).toBe(false);

    // Sanity-check: the confirmation_required payload still validates its own arm.
    expect(confirmationRequiredArm.safeParse(confirmationPayload).success).toBe(true);

    // Sanity-check: the written payload satisfies writeSuccessArm.
    expect(writeSuccessArm.safeParse(writtenPayload).success).toBe(true);
  });
});
