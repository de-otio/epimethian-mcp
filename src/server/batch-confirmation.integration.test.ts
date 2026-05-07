/**
 * Integration tests for batch authorisation tokens (v6.8.0 / Option C of
 * `plans/parallel-subagent-batch-confirmation.md`).
 *
 * Scope: end-to-end composition of the new `authorise_destructive_writes`
 * tool + batch-tokens.ts + the per-call `batch_token` field on
 * `update_page` / `update_page_section` / `update_page_sections` /
 * `delete_page`. The Confluence HTTP layer is mocked at the same boundary
 * as `soft-elicitation.integration.test.ts`.
 *
 * Test list (cross-references the plan and the post-review invariants
 * added in §3 / §C):
 *
 *  1. Mint via soft-confirm path — first call returns
 *     SOFT_CONFIRMATION_REQUIRED, second call (with the inner
 *     confirm_token) returns a batch_token.
 *  2. Batch token covers N updates with ONE prompt — three update_page
 *     calls succeed against three pages without further soft-confirms.
 *  3. Page outside the allowlist falls through to the per-call gate
 *     (returns SOFT_CONFIRMATION_REQUIRED, NOT a different error class).
 *  4. Exhaustion falls through — using a 1-op token twice falls through
 *     on the second call.
 *  5. Cross-tenant rejection — token minted for cloudId A is rejected
 *     when the active config's sealedCloudId is B (audit only).
 *  6. EPIMETHIAN_BATCH_REQUIRES_ELICITATION=true refuses to mint via the
 *     soft-confirm fallback when the client lacks elicitation.
 *  7. chained_tool_output source on authorise_destructive_writes is
 *     rejected outright (DESTRUCTIVE_FLAG_FROM_TOOL_OUTPUT).
 *  8. Validation-failure invariant — granular failure reasons do NOT
 *     surface to the agent (the SOFT_CONFIRMATION_REQUIRED / per-call
 *     fallback is what the agent sees).
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
// Environment bootstrap
// ---------------------------------------------------------------------------

vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://test.atlassian.net";
  process.env.CONFLUENCE_EMAIL = "user@test.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
  process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "0";
  process.env.EPIMETHIAN_WRITE_BUDGET_HOURLY = "0";
  delete process.env.EPIMETHIAN_ALLOW_UNGATED_WRITES;
  delete process.env.EPIMETHIAN_DISABLE_SOFT_CONFIRM;
  delete process.env.EPIMETHIAN_BYPASS_ELICITATION;
  delete process.env.EPIMETHIAN_BATCH_REQUIRES_ELICITATION;
});

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: vi.fn().mockResolvedValue(null),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockRegisterTool = vi.fn();
const mockElicitInput = vi.fn();
const mockGetClientCapabilities = vi.fn(() => ({})); // no elicitation by default

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

const DEFAULT_CLOUD_ID = "cloud-batch-test-001";
const PAGE_A = "page-A";
const PAGE_B = "page-B";
const PAGE_C = "page-C";

const activeConfig = {
  url: "https://test.atlassian.net",
  email: "user@test.com",
  profile: "batch-test",
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
  return {
    ...actual,
    resolveSpaceId: vi.fn().mockResolvedValue("TEST"),
    getPage: mockGetPage,
    _rawCreatePage: vi.fn(),
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
    formatPage: vi.fn().mockResolvedValue(""),
    extractSection: vi.fn().mockReturnValue(null),
    extractSectionBody: vi.fn().mockReturnValue(null),
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

function pageStub(pageId: string, version: number, body: string = "<p>Hi</p>") {
  return {
    id: pageId,
    title: `Page ${pageId}`,
    version: { number: version },
    body: { storage: { value: body } },
    space: { key: "TEST" },
    _links: { webui: `/pages/${pageId}` },
  };
}

function updateResponseStub(pageId: string, version: number) {
  return {
    page: {
      id: pageId,
      title: `Page ${pageId}`,
      version: { number: version },
      space: { key: "TEST" },
      _links: { webui: `/pages/${pageId}` },
    },
    newVersion: version,
  };
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

let registeredTools: Map<string, { handler: Function; schema: unknown }>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  const { main } = await import("./index.js");
  await main();

  registeredTools = new Map();
  for (const call of mockRegisterTool.mock.calls) {
    const [name, config, handler] = call as [string, unknown, Function];
    registeredTools.set(name, { handler, schema: config });
  }
});

afterAll(() => {
  stderrSpy.mockRestore();
});

beforeEach(async () => {
  const { _resetForTest } = await import("./confirmation-tokens.js");
  _resetForTest();
  const { _resetBatchTokensForTest } = await import("./batch-tokens.js");
  _resetBatchTokensForTest();
  const { _resetStartupWarningForTest } = await import("./elicitation.js");
  _resetStartupWarningForTest();

  mockGetClientCapabilities.mockReturnValue({});
  delete process.env.EPIMETHIAN_ALLOW_UNGATED_WRITES;
  delete process.env.EPIMETHIAN_DISABLE_SOFT_CONFIRM;
  delete process.env.EPIMETHIAN_BYPASS_ELICITATION;
  delete process.env.EPIMETHIAN_BATCH_REQUIRES_ELICITATION;

  activeConfig.sealedCloudId = DEFAULT_CLOUD_ID;

  mockGetPage.mockReset();
  mockGetPage.mockImplementation(async (pageId: string) => pageStub(pageId, 7));

  mockRawUpdatePage.mockReset();
  mockRawUpdatePage.mockImplementation(async (input: { pageId: string; version: number }) =>
    updateResponseStub(input.pageId, input.version + 1),
  );

  mockDeletePage.mockReset();
  mockDeletePage.mockResolvedValue(undefined);

  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Common args builder for authorise_destructive_writes
// ---------------------------------------------------------------------------

function authoriseArgs(overrides: Record<string, unknown> = {}) {
  return {
    page_ids: [PAGE_A, PAGE_B, PAGE_C],
    ttl_seconds: 900,
    max_operations: 3,
    reason: "Bulk doc refresh integration test",
    source: "user_request" as const,
    ...overrides,
  };
}

// ===========================================================================
// 1. Mint via soft-confirm path
// ===========================================================================

describe("authorise_destructive_writes — mint via soft-confirm path", () => {
  it("first call returns SOFT_CONFIRMATION_REQUIRED with confirm_token; second call returns a batch_token", async () => {
    const handler = registeredTools.get("authorise_destructive_writes")!.handler;

    const r1 = await handler(authoriseArgs());
    expect(r1.isError).toBe(true);
    expect(r1.content[0].text).toContain("SOFT_CONFIRMATION_REQUIRED");
    const confirmToken = r1.structuredContent?.confirm_token;
    expect(typeof confirmToken).toBe("string");
    expect(confirmToken!.length).toBeGreaterThan(10);

    const r2 = await handler(authoriseArgs({ confirm_token: confirmToken }));
    expect(r2.isError).toBeUndefined();
    expect(r2.structuredContent.kind).toBe("batch_authorised");
    expect(typeof r2.structuredContent.batch_token).toBe("string");
    expect(r2.structuredContent.batch_token).toMatch(/^btk_[0-9a-f]{64}$/);
    expect(r2.structuredContent.authorised_page_ids).toEqual([PAGE_A, PAGE_B, PAGE_C]);
    expect(r2.structuredContent.remaining_operations).toBe(3);
  });
});

// ===========================================================================
// 2. Batch token covers N updates with ONE prompt
// ===========================================================================

describe("batch_token — covers N writes without further soft-confirms", () => {
  it("update_page on each authorised page succeeds with the batch_token alone (no per-call SOFT_CONFIRMATION_REQUIRED)", async () => {
    const auth = registeredTools.get("authorise_destructive_writes")!.handler;
    const update = registeredTools.get("update_page")!.handler;

    // Mint via soft-confirm.
    const r1 = await auth(authoriseArgs());
    const r2 = await auth(authoriseArgs({ confirm_token: r1.structuredContent!.confirm_token }));
    const batchToken = r2.structuredContent.batch_token;

    // Three writes with the same batch_token, NO per-call confirm_token.
    for (const pageId of [PAGE_A, PAGE_B, PAGE_C]) {
      mockGetPage.mockImplementationOnce(async () => pageStub(pageId, 7));
      const w = await update({
        page_id: pageId,
        title: `Page ${pageId}`,
        version: 7,
        body: "<p>Refreshed</p>",
        replace_body: true,
        source: "user_request",
        batch_token: batchToken,
      });
      expect(w.isError).toBeUndefined();
      expect(w.content[0].text).toContain("Updated:");
    }
    expect(mockRawUpdatePage).toHaveBeenCalledTimes(3);
  });
});

// ===========================================================================
// 3. Page outside allowlist falls through to per-call gate
// ===========================================================================

describe("batch_token — page outside allowlist falls through to per-call gate (not a distinct error class)", () => {
  it("update_page on an unauthorised page returns SOFT_CONFIRMATION_REQUIRED, not a batch-specific error", async () => {
    const auth = registeredTools.get("authorise_destructive_writes")!.handler;
    const update = registeredTools.get("update_page")!.handler;

    const r1 = await auth(authoriseArgs({ page_ids: [PAGE_A] }));
    const r2 = await auth(
      authoriseArgs({
        page_ids: [PAGE_A],
        confirm_token: r1.structuredContent!.confirm_token,
      }),
    );
    const batchToken = r2.structuredContent.batch_token;

    // Try to use the token on PAGE_B (not in the allowlist).
    mockGetPage.mockResolvedValueOnce(pageStub(PAGE_B, 7));
    const w = await update({
      page_id: PAGE_B,
      title: `Page ${PAGE_B}`,
      version: 7,
      body: "<p>x</p>",
      replace_body: true,
      source: "user_request",
      batch_token: batchToken,
    });
    expect(w.isError).toBe(true);
    expect(w.content[0].text).toContain("SOFT_CONFIRMATION_REQUIRED");
    // No mention of batch_token / allowlist / etc. in the error text —
    // validation-failure invariant.
    expect(w.content[0].text).not.toMatch(/batch[_\s-]?token/i);
    expect(w.content[0].text).not.toContain("page_id_not_authorised");
    expect(mockRawUpdatePage).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 4. Exhaustion falls through
// ===========================================================================

describe("batch_token — exhaustion falls through to per-call gate", () => {
  it("the (max_operations+1)th call returns SOFT_CONFIRMATION_REQUIRED rather than a batch-specific error", async () => {
    const auth = registeredTools.get("authorise_destructive_writes")!.handler;
    const update = registeredTools.get("update_page")!.handler;

    // Mint a 1-op token for PAGE_A.
    const r1 = await auth(authoriseArgs({ page_ids: [PAGE_A], max_operations: 1 }));
    const r2 = await auth(
      authoriseArgs({
        page_ids: [PAGE_A],
        max_operations: 1,
        confirm_token: r1.structuredContent!.confirm_token,
      }),
    );
    const batchToken = r2.structuredContent.batch_token;

    // First call consumes the slot.
    mockGetPage.mockResolvedValueOnce(pageStub(PAGE_A, 7));
    const w1 = await update({
      page_id: PAGE_A,
      title: `Page ${PAGE_A}`,
      version: 7,
      body: "<p>1</p>",
      replace_body: true,
      source: "user_request",
      batch_token: batchToken,
    });
    expect(w1.isError).toBeUndefined();

    // Second call: exhausted → fall through.
    mockGetPage.mockResolvedValueOnce(pageStub(PAGE_A, 8));
    const w2 = await update({
      page_id: PAGE_A,
      title: `Page ${PAGE_A}`,
      version: 8,
      body: "<p>2</p>",
      replace_body: true,
      source: "user_request",
      batch_token: batchToken,
    });
    expect(w2.isError).toBe(true);
    expect(w2.content[0].text).toContain("SOFT_CONFIRMATION_REQUIRED");
    expect(w2.content[0].text).not.toContain("exhausted");
  });
});

// ===========================================================================
// 5. Cross-tenant rejection
// ===========================================================================

describe("batch_token — cross-tenant rejection", () => {
  it("a token minted under cloudId A is rejected when the active config flips to cloudId B", async () => {
    const auth = registeredTools.get("authorise_destructive_writes")!.handler;
    const update = registeredTools.get("update_page")!.handler;

    // Mint under cloud-A.
    activeConfig.sealedCloudId = "cloud-A";
    const r1 = await auth(authoriseArgs({ page_ids: [PAGE_A] }));
    const r2 = await auth(
      authoriseArgs({
        page_ids: [PAGE_A],
        confirm_token: r1.structuredContent!.confirm_token,
      }),
    );
    const batchToken = r2.structuredContent.batch_token;

    // Flip active tenant to cloud-B.
    activeConfig.sealedCloudId = "cloud-B";

    mockGetPage.mockResolvedValueOnce(pageStub(PAGE_A, 7));
    const w = await update({
      page_id: PAGE_A,
      title: `Page ${PAGE_A}`,
      version: 7,
      body: "<p>x</p>",
      replace_body: true,
      source: "user_request",
      batch_token: batchToken,
    });
    expect(w.isError).toBe(true);
    expect(w.content[0].text).toContain("SOFT_CONFIRMATION_REQUIRED");
    // Granular reason MUST NOT leak.
    expect(w.content[0].text).not.toMatch(/cloud[_\s-]?id|tenant/i);
  });
});

// ===========================================================================
// 6. EPIMETHIAN_BATCH_REQUIRES_ELICITATION refuses soft-confirm fallback
// ===========================================================================

describe("EPIMETHIAN_BATCH_REQUIRES_ELICITATION", () => {
  it("refuses to mint a batch token via soft-confirm when the client lacks elicitation", async () => {
    process.env.EPIMETHIAN_BATCH_REQUIRES_ELICITATION = "true";
    const auth = registeredTools.get("authorise_destructive_writes")!.handler;

    // No elicitation client (default in this suite).
    const r = await auth(authoriseArgs());
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("EPIMETHIAN_BATCH_REQUIRES_ELICITATION");
    // Should not have minted a confirm_token either — the strict-mode
    // refusal happens before gateOperation is called.
    expect(r.structuredContent?.kind).not.toBe("confirmation_required");
  });
});

// ===========================================================================
// 7. chained_tool_output rejection
// ===========================================================================

describe("authorise_destructive_writes — source provenance", () => {
  it("source='chained_tool_output' is rejected outright (DESTRUCTIVE_FLAG_FROM_TOOL_OUTPUT)", async () => {
    const auth = registeredTools.get("authorise_destructive_writes")!.handler;
    const r = await auth(authoriseArgs({ source: "chained_tool_output" }));
    expect(r.isError).toBe(true);
    // Error wrapping is "Error: <message>"; the source-policy block
    // surfaces a SOURCE_POLICY_BLOCKED message that mentions the source.
    expect(r.content[0].text).toContain("chained_tool_output");
    // No confirmation token was minted.
    expect(r.structuredContent?.kind).not.toBe("confirmation_required");
  });
});

// ===========================================================================
// 8. Validation-failure invariant — also covered above; explicit assertion
// ===========================================================================

describe("validation-failure invariant", () => {
  it("a malformed batch_token (right shape, never minted) falls through to per-call gate without leaking the failure reason", async () => {
    const update = registeredTools.get("update_page")!.handler;

    const fakeToken = "btk_" + "0".repeat(64);
    mockGetPage.mockResolvedValueOnce(pageStub(PAGE_A, 7));
    const w = await update({
      page_id: PAGE_A,
      title: `Page ${PAGE_A}`,
      version: 7,
      body: "<p>x</p>",
      replace_body: true,
      source: "user_request",
      batch_token: fakeToken,
    });
    expect(w.isError).toBe(true);
    expect(w.content[0].text).toContain("SOFT_CONFIRMATION_REQUIRED");
    // The agent never sees "unknown" / "expired" / "page_id_not_authorised".
    expect(w.content[0].text).not.toContain("unknown");
    expect(w.content[0].text).not.toContain("page_id_not_authorised");
    expect(w.content[0].text).not.toContain("BATCH_TOKEN_INVALID");
  });
});
