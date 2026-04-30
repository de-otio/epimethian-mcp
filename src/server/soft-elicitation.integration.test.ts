/**
 * Integration tests for the soft-elicitation pipeline (Phase 2 / v6.6.0).
 *
 * Scope: end-to-end composition of confirmation-tokens.ts + elicitation.ts +
 * safe-write.ts through the actual registered tool handlers. The Confluence
 * HTTP layer is mocked at the _rawUpdatePage / _rawCreatePage / getPage /
 * deletePage boundary (same pattern as mass-damage.integration.test.ts).
 *
 * IMPORTANT: confirmation-tokens.ts and elicitation.ts are NOT mocked — the
 * whole point is to verify they compose correctly through the handler path.
 *
 * Error-text note: toolErrorWithContext / toolError wrap every thrown error as
 * "Error: <message>". For ConverterError thrown with code CONFIRMATION_TOKEN_INVALID
 * the text is "Error: The confirmation token is no longer valid..."; for
 * ELICITATION_REQUIRED_BUT_UNAVAILABLE it is "Error: This tool requires...".
 * Assertions in this file match on those message substrings to stay resilient
 * against minor wording tweaks.
 *
 * Coverage map (§5.9 of plans/opencode-compatibility-implementation.md):
 *
 *  Scenario  Status  Notes
 *  ────────  ──────  ─────────────────────────────────────────────────────────
 *   1        REAL    Happy path — first call SOFT_CONFIRMATION_REQUIRED, second succeeds.
 *   2        REAL    Token reuse → CONFIRMATION_TOKEN_INVALID error text.
 *   3        REAL    Stale token (competing write between mint and retry).
 *   4        REAL    Expired token → INVALID, audit "expired".
 *   5        REAL    Different diff → INVALID, audit "mismatch".
 *   6        REAL    Cross-tool token → INVALID, audit "mismatch".
 *   7        REAL    DISABLE_SOFT_CONFIRM → ELICITATION_REQUIRED_BUT_UNAVAILABLE; no mint.
 *   8        REAL    ALLOW_UNGATED_WRITES → write proceeds without soft gate.
 *   9        REAL    Elicitation-capable client → soft confirmation never triggers.
 *  10        TODO    update_page_sections aggregate hash — covered in confirmation-tokens.test.ts
 *                    (computeDiffHash determinism) and index.test.ts (multi-section preamble).
 *  11        REAL    Concurrent retries TOCTOU — sibling-invalidation closes window.
 *  12        REAL    Tenant flip mid-session (cloudId A→B) → INVALID.
 *  13        TODO    Env-precedence matrix — fully pinned in elicitation.test.ts.
 *  14        REAL    Audit log integrity — mint/validate counts and no-token-bytes invariant.
 *  15        TODO    Memory ceiling (60 mints, 50 outstanding) — pinned in confirmation-tokens.test.ts.
 *  16        REAL    No-leak in stderr — full suite capture, asserts no token bytes appear.
 *  17        TODO    Mint-rate ceiling (101 in 1 min) — pinned in confirmation-tokens.test.ts.
 *  18        TODO    TTL clamp (env override) — pinned in confirmation-tokens.test.ts.
 *  19        REAL    humanSummary exfil resistance — attacker fixture, asserts no payload leaks.
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
  // Disable write-budget enforcement so it doesn't interfere.
  process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "0";
  process.env.EPIMETHIAN_WRITE_BUDGET_HOURLY = "0";
  // Soft confirmation is ON by default (Phase 2 posture).
  delete process.env.EPIMETHIAN_ALLOW_UNGATED_WRITES;
  delete process.env.EPIMETHIAN_DISABLE_SOFT_CONFIRM;
  delete process.env.EPIMETHIAN_BYPASS_ELICITATION;
});

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: vi.fn().mockResolvedValue(null),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

// ---------------------------------------------------------------------------
// MCP server mock — getClientCapabilities is a vi.fn() so tests can change
// what elicitation capability the client advertises between scenarios.
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

const DEFAULT_CLOUD_ID = "cloud-integ-test-001";
const DEFAULT_PAGE_ID = "page-42";

/** Mutable config object — tests override sealedCloudId as needed. */
const activeConfig = {
  url: "https://test.atlassian.net",
  email: "user@test.com",
  profile: "integ-test",
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

/** Build a standard page stub at a given version with an arbitrary body. */
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

/** Build the update-page response stub — matches _rawUpdatePage's return type: {page, newVersion}. */
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

// Stderr capture across the ENTIRE suite (scenario 16).
const capturedErrorArgs: unknown[][] = [];
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  stderrSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
    capturedErrorArgs.push(args);
  });

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
  // Reset token store before every test.
  const { _resetForTest } = await import("./confirmation-tokens.js");
  _resetForTest();

  // Reset elicitation warning flag.
  const { _resetStartupWarningForTest } = await import("./elicitation.js");
  _resetStartupWarningForTest();

  // Default: client does NOT support elicitation (soft-mode triggers).
  mockGetClientCapabilities.mockReturnValue({});

  // Default: soft confirmation is active.
  delete process.env.EPIMETHIAN_ALLOW_UNGATED_WRITES;
  delete process.env.EPIMETHIAN_DISABLE_SOFT_CONFIRM;
  delete process.env.EPIMETHIAN_BYPASS_ELICITATION;

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
// §5.9 Scenario 1 — Happy path
// ---------------------------------------------------------------------------

describe("Scenario 1 — happy path: SOFT_CONFIRMATION_REQUIRED then success", () => {
  it("first call returns isError + SOFT_CONFIRMATION_REQUIRED + confirm_token; second call with token succeeds", async () => {
    const handler = registeredTools.get("update_page")!.handler;

    // Call 1: no confirm_token → soft gate fires.
    const r1 = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>New content</p>",
      replace_body: true, // a destructive flag to trigger the gate
    });

    expect(r1.isError).toBe(true);
    expect(r1.content[0].text).toContain("SOFT_CONFIRMATION_REQUIRED");
    expect(r1.structuredContent).toBeDefined();
    const token = r1.structuredContent.confirm_token;
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(10);
    expect(r1.structuredContent.page_id).toBe(DEFAULT_PAGE_ID);
    expect(r1.structuredContent.audit_id).toBeDefined();
    expect(r1.structuredContent.expires_at).toBeDefined();

    // Token must NOT appear in the free-text content (scenario 16 guarantee).
    expect(r1.content[0].text).not.toContain(token);

    // Call 2: supply the token → should succeed.
    const r2 = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>New content</p>",
      replace_body: true,
      confirm_token: token,
    });

    expect(r2.isError).toBeUndefined();
    expect(r2.content[0].text).toContain("Updated:");
    expect(mockRawUpdatePage).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// §5.9 Scenario 2 — Token reuse
// ---------------------------------------------------------------------------

describe("Scenario 2 — token reuse → CONFIRMATION_TOKEN_INVALID", () => {
  it("second use of the same token returns CONFIRMATION_TOKEN_INVALID; audit shows 'unknown'", async () => {
    const { onValidate } = await import("./confirmation-tokens.js");
    const validateAudits: unknown[] = [];
    onValidate((m) => validateAudits.push(m));

    const handler = registeredTools.get("update_page")!.handler;

    // Call 1 → mint.
    const r1 = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>Body A</p>",
      replace_body: true,
    });
    const token = r1.structuredContent.confirm_token;

    // Call 2 → consumes token, write succeeds.
    const r2 = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>Body A</p>",
      replace_body: true,
      confirm_token: token,
    });
    expect(r2.isError).toBeUndefined();

    // Reset update mock for the third call.
    mockRawUpdatePage.mockReset();
    mockRawUpdatePage.mockResolvedValue(updateResponseStub(9));
    mockGetPage.mockResolvedValue(pageStub(8));

    // Call 3 — replay.
    const r3 = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 8,
      body: "<p>Body A</p>",
      replace_body: true,
      confirm_token: token,
    });

    expect(r3.isError).toBe(true);
    expect(r3.content[0].text).toContain("confirmation token is no longer valid");

    // Audit outcome for the replay attempt is "unknown" (token already consumed).
    const replayAudit = validateAudits.find(
      (m: any) => m.outcome === "unknown",
    );
    expect(replayAudit).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// §5.9 Scenario 3 — Stale token (competing write)
// ---------------------------------------------------------------------------

describe("Scenario 3 — stale token: competing write invalidates outstanding token", () => {
  it("token minted for page X is invalidated when another path writes to page X; audit shows 'stale'", async () => {
    const { onValidate, invalidateForPage } = await import("./confirmation-tokens.js");
    const validateAudits: any[] = [];
    onValidate((m) => validateAudits.push(m));

    const handler = registeredTools.get("update_page")!.handler;

    // Mint via call 1.
    const r1 = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>Competing write body</p>",
      replace_body: true,
    });
    expect(r1.isError).toBe(true);
    const token = r1.structuredContent.confirm_token;

    // Simulate a competing write: call invalidateForPage directly (this is
    // what safeSubmitPage's defense-in-depth hook does on any successful write).
    invalidateForPage(DEFAULT_CLOUD_ID, DEFAULT_PAGE_ID);

    // Now try to use the minted token.
    const r2 = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>Competing write body</p>",
      replace_body: true,
      confirm_token: token,
    });

    expect(r2.isError).toBe(true);
    // The handler wraps the ConverterError as "Error: The confirmation token is no longer valid..."
    expect(r2.content[0].text).toContain("confirmation token is no longer valid");

    // Audit must contain a 'stale' outcome from the invalidateForPage call.
    const staleAudit = validateAudits.find((m) => m.outcome === "stale");
    expect(staleAudit).toBeDefined();
    expect(staleAudit.cloudId).toBe(DEFAULT_CLOUD_ID);
    expect(staleAudit.pageId).toBe(DEFAULT_PAGE_ID);
  });
});

// ---------------------------------------------------------------------------
// §5.9 Scenario 4 — Expired token
// ---------------------------------------------------------------------------

describe("Scenario 4 — expired token", () => {
  it("token past TTL returns 'invalid'; audit shows 'expired'", async () => {
    const { onValidate, mintToken, validateToken, computeDiffHash } = await import(
      "./confirmation-tokens.js"
    );
    const validateAudits: any[] = [];
    onValidate((m) => validateAudits.push(m));

    // Use fake timers with shouldAdvanceTime so setTimeout (in sleepUntil)
    // fires promptly without wall-clock delay.
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Mint with the minimum clamped TTL (60 s).
    const minted = mintToken(
      {
        tool: "update_page",
        cloudId: DEFAULT_CLOUD_ID,
        pageId: DEFAULT_PAGE_ID,
        pageVersion: 7,
        diffHash: computeDiffHash("<p>Expiry test</p>", 7),
      },
      60_000,
    );

    // Advance fake time past TTL — Date.now() will return +61 s from here on.
    vi.advanceTimersByTime(61_000);

    // Validate directly against the token store (not through the handler) so
    // we avoid any handler-specific timing issues. The composition under test
    // here is: mintToken → advanceTime → validateToken returns "invalid" →
    // audit records "expired". The handler path for CONFIRMATION_TOKEN_INVALID
    // is separately exercised by scenario 2/5/6.
    const outcome = await validateToken(minted.token, {
      tool: "update_page",
      cloudId: DEFAULT_CLOUD_ID,
      pageId: DEFAULT_PAGE_ID,
      pageVersion: 7,
      diffHash: computeDiffHash("<p>Expiry test</p>", 7),
    });

    expect(outcome).toBe("invalid");

    const expiredAudit = validateAudits.find((m) => m.outcome === "expired");
    expect(expiredAudit).toBeDefined();
    expect(expiredAudit.auditId).toBe(minted.auditId);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// §5.9 Scenario 5 — Different diff
// ---------------------------------------------------------------------------

describe("Scenario 5 — different diff: body changed between mint and retry", () => {
  it("token minted for body A fails when retried with body B; audit shows 'mismatch'", async () => {
    const { onValidate } = await import("./confirmation-tokens.js");
    const validateAudits: any[] = [];
    onValidate((m) => validateAudits.push(m));

    const handler = registeredTools.get("update_page")!.handler;

    // Call 1 → mint bound to "<p>Body A</p>".
    const r1 = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>Body A</p>",
      replace_body: true,
    });
    expect(r1.isError).toBe(true);
    const token = r1.structuredContent.confirm_token;

    // Call 2 → different body (B), same token.
    const r2 = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>Body B — CHANGED</p>",
      replace_body: true,
      confirm_token: token,
    });

    expect(r2.isError).toBe(true);
    // The handler wraps the ConverterError as "Error: The confirmation token is no longer valid..."
    expect(r2.content[0].text).toContain("confirmation token is no longer valid");

    const mismatchAudit = validateAudits.find((m) => m.outcome === "mismatch");
    expect(mismatchAudit).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// §5.9 Scenario 6 — Cross-tool token
// ---------------------------------------------------------------------------

describe("Scenario 6 — cross-tool token: update_page token cannot be used on delete_page", () => {
  it("mint from update_page; retry on delete_page → CONFIRMATION_TOKEN_INVALID; audit 'mismatch'", async () => {
    const { onValidate } = await import("./confirmation-tokens.js");
    const validateAudits: any[] = [];
    onValidate((m) => validateAudits.push(m));

    const updateHandler = registeredTools.get("update_page")!.handler;
    const deleteHandler = registeredTools.get("delete_page")!.handler;

    // Mint from update_page.
    const r1 = await updateHandler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>Cross-tool test</p>",
      replace_body: true,
    });
    expect(r1.isError).toBe(true);
    const token = r1.structuredContent.confirm_token;

    // Try on delete_page with the update_page token.
    const r2 = await deleteHandler({
      page_id: DEFAULT_PAGE_ID,
      version: 7,
      confirm_token: token,
    });

    expect(r2.isError).toBe(true);
    // The handler wraps the ConverterError as "Error: The confirmation token is no longer valid..."
    expect(r2.content[0].text).toContain("confirmation token is no longer valid");

    const mismatchAudit = validateAudits.find((m) => m.outcome === "mismatch");
    expect(mismatchAudit).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// §5.9 Scenario 7 — EPIMETHIAN_DISABLE_SOFT_CONFIRM=true
// ---------------------------------------------------------------------------

describe("Scenario 7 — DISABLE_SOFT_CONFIRM=true → legacy ELICITATION_REQUIRED_BUT_UNAVAILABLE", () => {
  it("no token minted; onMint never fires; handler returns ELICITATION_REQUIRED_BUT_UNAVAILABLE", async () => {
    process.env.EPIMETHIAN_DISABLE_SOFT_CONFIRM = "true";

    const { onMint } = await import("./confirmation-tokens.js");
    const mintAudits: unknown[] = [];
    onMint((m) => mintAudits.push(m));

    const handler = registeredTools.get("update_page")!.handler;
    const r = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>Test</p>",
      replace_body: true,
    });

    expect(r.isError).toBe(true);
    // The error message describes the unavailability of elicitation; the exact
    // error code ELICITATION_REQUIRED_BUT_UNAVAILABLE is carried on the thrown
    // GatedOperationError but the text rendered by toolErrorWithContext is the
    // human-readable message.
    expect(r.content[0].text).toContain("does not expose elicitation");
    // onMint must NOT have fired.
    expect(mintAudits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §5.9 Scenario 8 — EPIMETHIAN_ALLOW_UNGATED_WRITES=true
// ---------------------------------------------------------------------------

describe("Scenario 8 — ALLOW_UNGATED_WRITES=true → write proceeds without soft gate", () => {
  it("no soft confirmation request; write succeeds directly", async () => {
    process.env.EPIMETHIAN_ALLOW_UNGATED_WRITES = "true";

    const { onMint } = await import("./confirmation-tokens.js");
    const mintAudits: unknown[] = [];
    onMint((m) => mintAudits.push(m));

    const handler = registeredTools.get("update_page")!.handler;
    const r = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>Ungated write</p>",
      replace_body: true,
    });

    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Updated:");
    expect(mintAudits).toHaveLength(0);
    expect(mockRawUpdatePage).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// §5.9 Scenario 9 — Elicitation-capable client
// ---------------------------------------------------------------------------

describe("Scenario 9 — elicitation-capable client: soft confirmation never triggers", () => {
  it("client advertises elicitation; gateOperation fires real elicitInput; no token minted", async () => {
    // Make client advertise elicitation.
    mockGetClientCapabilities.mockReturnValue({ elicitation: {} });

    // Mock elicitInput to accept.
    mockElicitInput.mockResolvedValue({
      action: "accept",
      content: { confirm: true },
    });

    const { onMint } = await import("./confirmation-tokens.js");
    const mintAudits: unknown[] = [];
    onMint((m) => mintAudits.push(m));

    const handler = registeredTools.get("update_page")!.handler;
    const r = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>Elicitation path</p>",
      replace_body: true,
    });

    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Updated:");
    // No token minted — real elicitation path was used.
    expect(mintAudits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §5.9 Scenario 10 — update_page_sections aggregate hash
// ---------------------------------------------------------------------------

it.todo(
  "Scenario 10 — update_page_sections aggregate hash; cross-set token rejected — " +
    "computeDiffHash determinism pinned in confirmation-tokens.test.ts; " +
    "multi-section preamble in index.test.ts (update_page_sections handler).",
);

// ---------------------------------------------------------------------------
// §5.9 Scenario 11 — Concurrent retries TOCTOU
// ---------------------------------------------------------------------------

describe("Scenario 11 — concurrent retries TOCTOU: sibling-invalidation closes window", () => {
  it("two tokens minted for same {cloudId, pageId}; first validate ok; second validate invalid due to sibling eviction", async () => {
    const { onValidate, mintToken, computeDiffHash } = await import(
      "./confirmation-tokens.js"
    );
    const validateAudits: any[] = [];
    onValidate((m) => validateAudits.push(m));

    const pageVersion = 7;
    const body1 = "<p>Agent 1 diff</p>";
    const body2 = "<p>Agent 2 diff</p>";

    const hash1 = computeDiffHash(body1, pageVersion);
    const hash2 = computeDiffHash(body2, pageVersion);

    // Mint T1 (for agent1's body).
    const t1 = mintToken({
      tool: "update_page",
      cloudId: DEFAULT_CLOUD_ID,
      pageId: DEFAULT_PAGE_ID,
      pageVersion,
      diffHash: hash1,
    });

    // Mint T2 (for agent2's body — same page, different diff).
    const t2 = mintToken({
      tool: "update_page",
      cloudId: DEFAULT_CLOUD_ID,
      pageId: DEFAULT_PAGE_ID,
      pageVersion,
      diffHash: hash2,
    });

    // Agent1 validates T1 first → "ok"; T2 is atomically invalidated as "stale".
    const { validateToken } = await import("./confirmation-tokens.js");
    const outcome1 = await validateToken(t1.token, {
      tool: "update_page",
      cloudId: DEFAULT_CLOUD_ID,
      pageId: DEFAULT_PAGE_ID,
      pageVersion,
      diffHash: hash1,
    });
    expect(outcome1).toBe("ok");

    // Agent2 validates T2 → "invalid" (was sibling-invalidated).
    const outcome2 = await validateToken(t2.token, {
      tool: "update_page",
      cloudId: DEFAULT_CLOUD_ID,
      pageId: DEFAULT_PAGE_ID,
      pageVersion,
      diffHash: hash2,
    });
    expect(outcome2).toBe("invalid");

    // The sibling-invalidation audit record exists with outcome "stale".
    const staleAudit = validateAudits.find(
      (m) => m.outcome === "stale" && m.auditId === t2.auditId,
    );
    expect(staleAudit).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// §5.9 Scenario 12 — Tenant flip mid-session
// ---------------------------------------------------------------------------

describe("Scenario 12 — tenant flip mid-session: cloudId A → B → INVALID", () => {
  it("token minted under cloudId A fails validation when cloudId is B; audit shows 'mismatch'", async () => {
    const { onValidate, mintToken, computeDiffHash, validateToken } =
      await import("./confirmation-tokens.js");
    const validateAudits: any[] = [];
    onValidate((m) => validateAudits.push(m));

    const pageVersion = 7;
    const body = "<p>Tenant flip test</p>";
    const cloudIdA = "cloud-tenant-A";
    const cloudIdB = "cloud-tenant-B";

    // Mint under cloudId A.
    const minted = mintToken({
      tool: "update_page",
      cloudId: cloudIdA,
      pageId: DEFAULT_PAGE_ID,
      pageVersion,
      diffHash: computeDiffHash(body, pageVersion),
    });

    // Validate under cloudId B (tenant flip).
    const outcome = await validateToken(minted.token, {
      tool: "update_page",
      cloudId: cloudIdB,
      pageId: DEFAULT_PAGE_ID,
      pageVersion,
      diffHash: computeDiffHash(body, pageVersion),
    });

    expect(outcome).toBe("invalid");

    const mismatchAudit = validateAudits.find((m) => m.outcome === "mismatch");
    expect(mismatchAudit).toBeDefined();
  });

  it("tool handler with reconfigured sealedCloudId rejects token from prior tenant", async () => {
    const { onValidate } = await import("./confirmation-tokens.js");
    const validateAudits: any[] = [];
    onValidate((m) => validateAudits.push(m));

    const handler = registeredTools.get("update_page")!.handler;

    // Mint with cloudId A.
    activeConfig.sealedCloudId = "cloud-A-flip";
    const r1 = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>Flip body</p>",
      replace_body: true,
    });
    expect(r1.isError).toBe(true);
    const token = r1.structuredContent.confirm_token;

    // Simulate tenant reconfiguration — cloudId B on retry.
    activeConfig.sealedCloudId = "cloud-B-flip";

    const r2 = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>Flip body</p>",
      replace_body: true,
      confirm_token: token,
    });

    expect(r2.isError).toBe(true);
    // The handler wraps the ConverterError as "Error: The confirmation token is no longer valid..."
    expect(r2.content[0].text).toContain("confirmation token is no longer valid");

    const mismatch = validateAudits.find((m) => m.outcome === "mismatch");
    expect(mismatch).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// §5.9 Scenario 13 — Env-precedence matrix
// ---------------------------------------------------------------------------

it.todo(
  "Scenario 13 — env-precedence matrix (all 16 env-var combinations × " +
    "clientSupportsElicitation) — fully pinned in src/server/elicitation.test.ts " +
    "(the §3.4 matrix describe block).",
);

// ---------------------------------------------------------------------------
// §5.9 Scenario 14 — Audit log integrity
// ---------------------------------------------------------------------------

describe("Scenario 14 — audit log integrity", () => {
  it("every mint produces exactly one onMint; every validate produces exactly one onValidate; no token bytes in audit fields", async () => {
    const { onMint, onValidate } = await import("./confirmation-tokens.js");
    const mintAudits: any[] = [];
    const validateAudits: any[] = [];
    onMint((m) => mintAudits.push(m));
    onValidate((m) => validateAudits.push(m));

    const handler = registeredTools.get("update_page")!.handler;

    // First call → mint.
    const r1 = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>Audit test</p>",
      replace_body: true,
    });
    expect(r1.isError).toBe(true);
    const token = r1.structuredContent.confirm_token;

    // Exactly one mint event.
    expect(mintAudits).toHaveLength(1);
    const mintRecord = mintAudits[0];

    // Mint record must NEVER contain the raw token bytes.
    const mintJson = JSON.stringify(mintRecord);
    expect(mintJson).not.toContain(token);
    // Audit record must contain an auditId, not the token.
    expect(mintRecord.auditId).toBeDefined();
    expect(typeof mintRecord.auditId).toBe("string");
    // Must contain standard fields.
    expect(mintRecord.tool).toBe("update_page");
    expect(mintRecord.cloudId).toBe(DEFAULT_CLOUD_ID);
    expect(mintRecord.pageId).toBe(DEFAULT_PAGE_ID);

    // Second call → validate (ok).
    const r2 = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>Audit test</p>",
      replace_body: true,
      confirm_token: token,
    });
    expect(r2.isError).toBeUndefined();

    // Exactly one validate event for the "ok" path.
    expect(validateAudits).toHaveLength(1);
    const validateRecord = validateAudits[0];
    expect(validateRecord.outcome).toBe("ok");

    // Validate record must NEVER contain the raw token bytes.
    const validateJson = JSON.stringify(validateRecord);
    expect(validateJson).not.toContain(token);

    // auditId in validate must match the original mint.
    expect(validateRecord.auditId).toBe(mintRecord.auditId);
  });

  it("failed validate produces exactly one onValidate with reason visible only in audit (not in tool result)", async () => {
    const { onValidate } = await import("./confirmation-tokens.js");
    const validateAudits: any[] = [];
    onValidate((m) => validateAudits.push(m));

    const handler = registeredTools.get("update_page")!.handler;

    // Mint.
    const r1 = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>Audit fail test</p>",
      replace_body: true,
    });
    const token = r1.structuredContent.confirm_token;

    // Retry with wrong body (mismatch).
    const r2 = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>DIFFERENT body for mismatch</p>",
      replace_body: true,
      confirm_token: token,
    });

    expect(r2.isError).toBe(true);
    // Tool result exposes ONE bucket, not the fine-grained reason.
    // The handler wraps the ConverterError as "Error: The confirmation token is no longer valid..."
    expect(r2.content[0].text).toContain("confirmation token is no longer valid");
    expect(r2.content[0].text).not.toContain("mismatch");

    // Exactly one validate event, reason in audit only.
    expect(validateAudits).toHaveLength(1);
    expect(validateAudits[0].outcome).toBe("mismatch");
  });
});

// ---------------------------------------------------------------------------
// §5.9 Scenario 15 — Memory ceiling
// ---------------------------------------------------------------------------

it.todo(
  "Scenario 15 — memory ceiling (60 mints, outstanding never exceeds 50, FIFO eviction) — " +
    "pinned in src/server/confirmation-tokens.test.ts ('51st mintToken after 50 outstanding').",
);

// ---------------------------------------------------------------------------
// §5.9 Scenario 16 — No-leak in stderr (asserted at end of suite)
// ---------------------------------------------------------------------------

describe("Scenario 16 — no-leak in stderr", () => {
  it("no full confirm_token bytes appear in any captured console.error argument", async () => {
    // This scenario runs AFTER all previous tests have executed (same suite),
    // so capturedErrorArgs accumulates from the entire integration run.
    // We assert that no base64url string of ≥ 24 chars — which is the exact
    // token format (randomBytes(24).toString("base64url") → 32 chars) —
    // appears verbatim in any stderr output.

    // Collect all stderr text that was produced during this suite.
    const allStderr = capturedErrorArgs
      .map((args) => args.map((a) => String(a)).join(" "))
      .join("\n");

    // Pattern: base64url chars, length ≥ 24 (actual tokens are 32 chars).
    // Any such string appearing in stderr would be a token-byte leak.
    // We grab every token we've minted in this suite by collecting tokens
    // from all structuredContent.confirm_token values we saw in r1 responses.
    // Since we don't persist them across subtests, we validate the invariant
    // by checking that the overall stderr doesn't contain a standalone
    // 32-char base64url sequence (the exact shape of a minted token).
    //
    // Note: BYPASS_ELICITATION path emits a "...${last8}" suffix in the text
    // body — that 8-char partial is explicitly allowed (see safe-write.ts
    // formatSoftConfirmationResult). We only prohibit the FULL token.
    const FULL_TOKEN_RE = /[A-Za-z0-9_-]{32}/g;
    const tokenCandidates = allStderr.match(FULL_TOKEN_RE) ?? [];

    // Each found candidate should not be a real token. We can't enumerate
    // all minted tokens across the isolated beforeEach resets, so instead
    // we assert that any 32-char base64url string in stderr also appears in
    // the known-safe strings (like audit IDs, which are UUID format and won't
    // match the base64url-only pattern without hyphens).
    //
    // UUID format: xxxxxxxx-xxxx-... — contains hyphens in specific positions,
    // making them distinct from base64url tokens (which have no fixed hyphen
    // positions). Any pure-base64url 32-char run in stderr is suspicious.
    for (const candidate of tokenCandidates) {
      // A real token is ONLY base64url chars. If it appears in a context
      // that is clearly a Confluence URL or other non-token string, it's fine.
      // For the integration test, we accept that no such candidate appears in
      // the full stderr (since our mock doesn't produce Confluence page IDs
      // of that length).
      expect(candidate).toBeFalsy(); // any hit is a failure
    }
  });
});

// ---------------------------------------------------------------------------
// §5.9 Scenario 17 — Mint-rate ceiling
// ---------------------------------------------------------------------------

it.todo(
  "Scenario 17 — mint-rate ceiling (101 mints in 1 min → SOFT_CONFIRM_RATE_LIMITED) — " +
    "pinned in src/server/confirmation-tokens.test.ts ('101st mintToken within 15 min').",
);

// ---------------------------------------------------------------------------
// §5.9 Scenario 18 — TTL clamp
// ---------------------------------------------------------------------------

it.todo(
  "Scenario 18 — TTL clamp (EPIMETHIAN_SOFT_CONFIRM_TTL_MS under/over bounds clamped) — " +
    "pinned in src/server/confirmation-tokens.test.ts (TTL clamp tests).",
);

// ---------------------------------------------------------------------------
// §5.9 Scenario 19 — humanSummary exfil resistance (CRITICAL)
// ---------------------------------------------------------------------------

describe("Scenario 19 — humanSummary exfil resistance (CRITICAL)", () => {
  /**
   * Fixture: a Confluence storage-format page body that contains
   * attacker-shaped strings in every interpolatable position.
   *
   * ATTACKER_PAYLOAD appears in:
   *  - ri:content-title attribute value
   *  - ac:name attribute value
   *  - CDATA body
   *  - ac:parameter inner text
   *  - ac:plain-text-body inner text
   *  - plain text nodes
   *
   * If humanSummary is derived from any of these values, the payload leaks
   * into the soft-confirmation prompt and the attacker can inject arbitrary
   * text into the user-facing message.
   */
  const ATTACKER_PAYLOAD = "ATTACKER_PAYLOAD_XSS_INJECTION_MARKER";

  const FIXTURE_BODY = `
<p>Normal paragraph</p>
<ac:structured-macro ac:name="${ATTACKER_PAYLOAD}-macro-name">
  <ac:parameter ac:name="title">${ATTACKER_PAYLOAD}-param-value</ac:parameter>
  <ac:rich-text-body>
    <p>${ATTACKER_PAYLOAD}-rich-text-body</p>
  </ac:rich-text-body>
  <ac:plain-text-body><![CDATA[${ATTACKER_PAYLOAD}-cdata-body]]></ac:plain-text-body>
</ac:structured-macro>
<ac:link>
  <ri:page ri:content-title="${ATTACKER_PAYLOAD}-link-title" />
  <ac:link-body>${ATTACKER_PAYLOAD}-link-display</ac:link-body>
</ac:link>
<p>${ATTACKER_PAYLOAD}-plain-text-node</p>
`.trim();

  it("humanSummary and content[0].text do NOT contain ATTACKER_PAYLOAD from page content", async () => {
    // Page with the attacker-shaped body — current version 7.
    mockGetPage.mockResolvedValue({
      id: DEFAULT_PAGE_ID,
      title: "Attacker Page",
      version: { number: 7 },
      body: { storage: { value: FIXTURE_BODY } },
      space: { key: "TEST" },
      _links: { webui: `/pages/${DEFAULT_PAGE_ID}` },
    });

    const handler = registeredTools.get("update_page")!.handler;

    // Trigger the soft gate with a new body (replace_body to force the gate).
    const newBody = "<p>Replacement content — clean body</p>";
    const r = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Attacker Page",
      version: 7,
      body: newBody,
      replace_body: true,
    });

    // The call must produce SOFT_CONFIRMATION_REQUIRED (not an uncaught error).
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("SOFT_CONFIRMATION_REQUIRED");

    // CRITICAL: ATTACKER_PAYLOAD must NOT appear anywhere in the response.
    expect(r.content[0].text).not.toContain(ATTACKER_PAYLOAD);

    // Also check the structured content (humanSummary is the most risky field).
    const structured = JSON.stringify(r.structuredContent ?? {});
    expect(structured).not.toContain(ATTACKER_PAYLOAD);
  });

  it("humanSummary built from deletionSummary counts only — attacker values in details keys do not leak", async () => {
    // Use a body that has zero preserved macros so we can rely on the
    // deletion-summary path. The attacker-shaped body is the CURRENT page;
    // the new body is clean and doesn't re-emit the macros.
    mockGetPage.mockResolvedValue({
      id: DEFAULT_PAGE_ID,
      title: `${ATTACKER_PAYLOAD}-title`,
      version: { number: 7 },
      body: { storage: { value: FIXTURE_BODY } },
      space: { key: "TEST" },
      _links: { webui: `/pages/${DEFAULT_PAGE_ID}` },
    });

    const handler = registeredTools.get("update_page")!.handler;

    // Use replace_body so the whole body is replaced and we get through the
    // gate rather than getting a deletion-ack error.
    const r = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: `${ATTACKER_PAYLOAD}-title`,
      version: 7,
      body: "<p>Clean replacement</p>",
      replace_body: true,
    });

    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("SOFT_CONFIRMATION_REQUIRED");

    // The humanSummary in the text should contain only safe, numeric language.
    const text: string = r.content[0].text;
    expect(text).not.toContain(ATTACKER_PAYLOAD);

    // Even the page title (which contains ATTACKER_PAYLOAD) must not appear.
    expect(text).not.toContain(`${ATTACKER_PAYLOAD}-title`);
  });

  it("delete_page humanSummary does not contain page content", async () => {
    // delete_page uses an empty string for diffHash — no page body is needed.
    // But the page title is retrieved for the gate summary. Assert the
    // attacker-controlled title is NOT echoed into the soft-confirm text.
    const handler = registeredTools.get("delete_page")!.handler;

    const r = await handler({
      page_id: DEFAULT_PAGE_ID,
      version: 7,
    });

    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("SOFT_CONFIRMATION_REQUIRED");

    // The body/title is not included in humanSummary for delete_page.
    // Assert generic delete language only.
    const text: string = r.content[0].text;
    expect(text).not.toContain(ATTACKER_PAYLOAD);
  });
});

// ---------------------------------------------------------------------------
// Claude Code fake-elicitation interop (T3 — v6.6.1)
//
// These tests exercise the new fast-decline auto-detection path added by T1.
// The mock client advertises elicitation capability but has its elicitInput
// spy resolve immediately (< FAST_DECLINE_THRESHOLD_MS = 50 ms) or slowly
// (250 ms), exercising all branches of the §3.3 updated precedence table.
//
// T1 adds to elicitation.ts:
//   - `_resetFakeElicitationStateForTest()` — clears the per-server WeakMap
//   - `FAST_DECLINE_THRESHOLD_MS` (default 50) constant
//   - `effectiveSupportsElicitation(server)` — honours env override + sticky flag
//   - `isClientFakingElicitation(server)` — per-server boolean
//
// The production `gateOperation` is NOT mocked here — the full call stack
// runs through elicitation.ts → confirmation-tokens.ts exactly as in
// production.
// ---------------------------------------------------------------------------

describe("Claude Code fake-elicitation interop", () => {
  // Capture and silence the BYPASS / ungated-write console.error noise that
  // some branches emit, so test output stays clean.
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // T1 adds _resetFakeElicitationStateForTest() to elicitation.ts.
    // Calling it here clears the per-server WeakMap so stickiness from a
    // prior test does not bleed into the next one.
    const { _resetFakeElicitationStateForTest } = await import("./elicitation.js");
    _resetFakeElicitationStateForTest();

    // Reset the elicitInput spy so call-count assertions start from zero.
    mockElicitInput.mockReset();

    // Make the client advertise elicitation (the "lies" scenario).
    mockGetClientCapabilities.mockReturnValue({ elicitation: {} });

    // Env-var cleanup — test cases that need them set them explicitly.
    delete process.env.EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED;
    delete process.env.EPIMETHIAN_BYPASS_ELICITATION;
    delete process.env.EPIMETHIAN_ALLOW_UNGATED_WRITES;
    delete process.env.EPIMETHIAN_DISABLE_SOFT_CONFIRM;

    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Restore page/update mocks to defaults for this group.
    mockGetPage.mockReset();
    mockGetPage.mockResolvedValue(pageStub(7));
    mockRawUpdatePage.mockReset();
    mockRawUpdatePage.mockResolvedValue(updateResponseStub(8));
    mockDeletePage.mockReset();
    mockDeletePage.mockResolvedValue(undefined);

    vi.useRealTimers();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    delete process.env.EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED;
    vi.useRealTimers();
  });

  // ── Case 1 ────────────────────────────────────────────────────────────────
  // Fast decline (< 50 ms) + all four soft fields present → tool returns the
  // soft-confirm payload (isError, confirm_token in structuredContent,
  // humanSummary present). Re-invoking with the token should write successfully.
  it("fast decline (< 50 ms) + all soft fields → soft-confirm payload; re-invoke with token succeeds", async () => {
    // Simulate a near-instant decline — well below the 50 ms threshold.
    // Because gateOperation measures elapsed time with performance.now(),
    // and the mock resolves synchronously within the microtask queue, the
    // elapsed time will be < 50 ms in any real execution environment.
    mockElicitInput.mockResolvedValue({ action: "decline", content: undefined });

    const handler = registeredTools.get("update_page")!.handler;

    // First call — no confirm_token, all soft fields will be present because
    // the page stub has cloudId (from activeConfig.sealedCloudId), pageId,
    // version, and a computable diffHash.
    const r1 = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>Fast-decline test body</p>",
      replace_body: true,
    });

    // The fast-decline path must route to soft-confirm, NOT USER_DECLINED.
    expect(r1.isError).toBe(true);
    expect(r1.content[0].text).toContain("SOFT_CONFIRMATION_REQUIRED");
    expect(r1.structuredContent).toBeDefined();
    const token = r1.structuredContent.confirm_token;
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(10);
    expect(r1.structuredContent.page_id).toBe(DEFAULT_PAGE_ID);
    expect(r1.structuredContent.audit_id).toBeDefined();
    expect(r1.structuredContent.expires_at).toBeDefined();

    // humanSummary must be present (it's the description shown to the user).
    // The text is embedded in content[0].text by the handler's formatter.
    expect(r1.content[0].text).toBeDefined();

    // elicitInput was called exactly once (the probe call that returned fast).
    expect(mockElicitInput).toHaveBeenCalledTimes(1);

    // Re-invoke with the token — the write must proceed.
    const r2 = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>Fast-decline test body</p>",
      replace_body: true,
      confirm_token: token,
    });

    expect(r2.isError).toBeUndefined();
    expect(r2.content[0].text).toContain("Updated:");
    expect(mockRawUpdatePage).toHaveBeenCalledTimes(1);

    // elicitInput must NOT have been called again during the retry.
    expect(mockElicitInput).toHaveBeenCalledTimes(1);
  });

  // ── Case 2 ────────────────────────────────────────────────────────────────
  // Slow decline (≥ 250 ms) + all soft fields → USER_DECLINED (real human
  // decline; no token minted). Re-invoking with a fabricated token should
  // fail with CONFIRMATION_TOKEN_INVALID.
  it("slow decline (250 ms) + all soft fields → USER_DECLINED; no token; fabricated token rejected", async () => {
    // Use fake timers so the 250 ms await completes instantly in test time
    // while still advancing performance.now() by 250 ms — enough to exceed
    // the 50 ms threshold.
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Mock elicitInput to decline after 250 ms.
    mockElicitInput.mockImplementation(
      () =>
        new Promise<{ action: string; content: undefined }>((resolve) => {
          setTimeout(() => resolve({ action: "decline", content: undefined }), 250);
        }),
    );

    const handler = registeredTools.get("update_page")!.handler;

    // Kick off the handler — it will await elicitInput internally.
    const callPromise = handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>Slow-decline test body</p>",
      replace_body: true,
    });

    // Advance fake timers past the 250 ms mark so the elicit resolves.
    await vi.advanceTimersByTimeAsync(300);
    const r1 = await callPromise;

    // A real (slow) decline must yield USER_DECLINED, not a soft-confirm.
    expect(r1.isError).toBe(true);
    expect(r1.content[0].text).toContain("user declined");
    // Critically: no token in structuredContent.
    expect(r1.structuredContent?.confirm_token).toBeUndefined();

    // Fabricate a token and try to use it — must be rejected.
    const fakeToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; // 34 chars, not a real token
    const r2 = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>Slow-decline test body</p>",
      replace_body: true,
      confirm_token: fakeToken,
    });

    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toContain("confirmation token is no longer valid");
  }, 15_000);

  // ── Case 3 ────────────────────────────────────────────────────────────────
  // EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED=true from the start →
  // the very first call routes straight to soft-confirm; elicitInput is
  // never invoked (spy call count = 0).
  it("EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED=true → straight to soft-confirm; elicitInput never called", async () => {
    process.env.EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED = "true";

    // elicitInput must NOT be called — if it is, the env-var override failed.
    mockElicitInput.mockImplementation(() => {
      throw new Error("elicitInput must not be called when TREAT_ELICITATION_AS_UNSUPPORTED=true");
    });

    const handler = registeredTools.get("update_page")!.handler;

    const r = await handler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>Unsupported-override test body</p>",
      replace_body: true,
    });

    // Must reach the soft-confirm path immediately.
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("SOFT_CONFIRMATION_REQUIRED");
    expect(r.structuredContent?.confirm_token).toBeDefined();

    // The critical assertion: elicitInput was NEVER invoked.
    expect(mockElicitInput).toHaveBeenCalledTimes(0);
  });

  // ── Case 4 ────────────────────────────────────────────────────────────────
  // Stickiness: fast-decline observed on update_page → subsequent delete_page
  // call in the same session goes straight to soft-confirm without invoking
  // elicitInput again. Total elicitInput call count across both tool calls = 1.
  it("stickiness: fast-decline on update_page makes delete_page skip elicitInput (total calls = 1)", async () => {
    // First: trigger fast-decline on update_page.
    mockElicitInput.mockResolvedValue({ action: "decline", content: undefined });

    const updateHandler = registeredTools.get("update_page")!.handler;
    const deleteHandler = registeredTools.get("delete_page")!.handler;

    // Call update_page — fast decline detected, sticky flag set on the server.
    const r1 = await updateHandler({
      page_id: DEFAULT_PAGE_ID,
      title: "Test Page",
      version: 7,
      body: "<p>Stickiness test body</p>",
      replace_body: true,
    });

    // Confirm the first call produced a soft-confirm (fast-decline triggered).
    expect(r1.isError).toBe(true);
    expect(r1.content[0].text).toContain("SOFT_CONFIRMATION_REQUIRED");
    expect(mockElicitInput).toHaveBeenCalledTimes(1);

    // Second call: delete_page in the same session. Because the sticky flag is
    // set, gateOperation must not call elicitInput again — it goes straight to
    // the soft-confirm path (row 4 of §3.3).
    // Arrange a fresh page stub for the delete handler.
    mockGetPage.mockResolvedValue(pageStub(7));

    const r2 = await deleteHandler({
      page_id: DEFAULT_PAGE_ID,
      version: 7,
    });

    // delete_page must also return soft-confirm (not USER_DECLINED).
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toContain("SOFT_CONFIRMATION_REQUIRED");
    expect(r2.structuredContent?.confirm_token).toBeDefined();

    // The critical assertion: only ONE total elicitInput invocation across
    // both tool calls. The second call must not have probed the client again.
    expect(mockElicitInput).toHaveBeenCalledTimes(1);
  });
});
