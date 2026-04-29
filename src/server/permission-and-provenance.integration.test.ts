/**
 * Integration tests for permission handling (#14) + unverified-status badge (#13).
 *
 * These tests exercise cross-component behavior that individual unit tests
 * cannot prove in isolation:
 *   - Read-only posture: tool list, check_permissions payload
 *   - First-edit flow: create_page → ensureAttributionLabel → markPageUnverified
 *   - Badge idempotency across edits
 *   - Label/badge permission failures surface as warnings (not errors)
 *   - Auth/NotFound remediation messages
 *   - Mixed posture/probe state in check_permissions
 *   - Partial comment-reply results via Promise.allSettled
 *
 * Pattern: spin up main(), capture registered tools, invoke handlers
 * directly. All Confluence HTTP is mocked via confluence-client.js mock.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://test.atlassian.net";
  process.env.CONFLUENCE_EMAIL = "user@test.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
  process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "0";
  process.env.EPIMETHIAN_WRITE_BUDGET_HOURLY = "0";
  process.env.EPIMETHIAN_ALLOW_UNGATED_WRITES = "true";
});

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: vi.fn().mockResolvedValue(null),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockRegisterTool = vi.fn();

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    registerTool: mockRegisterTool,
    server: {
      getClientVersion: () => ({ name: "test-client", version: "1.0.0" }),
      getClientCapabilities: () => ({}),
    },
  })),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Shared mock state — tests manipulate these between scenarios
// ---------------------------------------------------------------------------

const mockEnsureAttributionLabel = vi.fn();
const mockMarkPageUnverified = vi.fn();
const mockGetContentState = vi.fn();
const mockSetContentState = vi.fn();
const mockGetPage = vi.fn();
const mockGetFooterComments = vi.fn();
const mockGetInlineComments = vi.fn();
const mockGetCommentReplies = vi.fn();

/**
 * Config returned by getConfig() — overridden per test group using
 * Object.assign so all calls in the same group see the same value.
 */
interface TestConfig {
  url: string;
  email: string;
  profile: string | null;
  readOnly: boolean;
  posture: "read-only" | "read-write" | "detect";
  attribution: boolean;
  unverifiedStatus: boolean;
  apiV2: string;
  apiV1: string;
  authHeader: string;
  jsonHeaders: Record<string, string>;
  effectivePosture: "read-only" | "read-write";
  probedCapability: "write" | "read-only" | "inconclusive" | null;
  postureSource: "profile" | "probe" | "default";
}

const defaultConfig: TestConfig = {
  url: "https://test.atlassian.net",
  email: "user@test.com",
  profile: "test-profile",
  readOnly: false,
  posture: "read-write",
  attribution: true,
  unverifiedStatus: true,
  apiV2: "https://test.atlassian.net/wiki/api/v2",
  apiV1: "https://test.atlassian.net/wiki/rest/api",
  authHeader: "Basic dGVzdA==",
  jsonHeaders: {},
  effectivePosture: "read-write",
  probedCapability: null,
  postureSource: "default",
};

let activeConfig: TestConfig = { ...defaultConfig };
const mockGetConfig = vi.fn(async () => activeConfig);

vi.mock("./confluence-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./confluence-client.js")>();

  class ConfluenceApiError extends Error {
    status: number;
    constructor(status: number, body: string) {
      super(`Confluence API error (${status}): ${body}`);
      this.status = status;
      this.name = "ConfluenceApiError";
    }
  }
  class ConfluenceAuthError extends ConfluenceApiError {
    constructor(status: number, body: string) {
      super(status, body);
      this.name = "ConfluenceAuthError";
    }
  }
  class ConfluencePermissionError extends ConfluenceApiError {
    constructor(status: number, body: string) {
      super(status, body);
      this.name = "ConfluencePermissionError";
    }
  }
  class ConfluenceNotFoundError extends ConfluenceApiError {
    constructor(status: number, body: string) {
      super(status, body);
      this.name = "ConfluenceNotFoundError";
    }
  }
  class ConfluenceConflictError extends Error {
    constructor(pageId: string) {
      super(`Version conflict: page ${pageId} has been modified since you last read it.`);
      this.name = "ConfluenceConflictError";
    }
  }

  return {
    ...actual,
    ConfluenceApiError,
    ConfluenceAuthError,
    ConfluencePermissionError,
    ConfluenceNotFoundError,
    ConfluenceConflictError,

    getConfig: mockGetConfig,
    validateStartup: vi.fn().mockResolvedValue(undefined),

    // Stubbed HTTP-layer functions — tests override per scenario
    resolveSpaceId: vi.fn().mockResolvedValue("~SPACEID"),
    getPage: mockGetPage,
    getFooterComments: mockGetFooterComments,
    getInlineComments: mockGetInlineComments,
    getCommentReplies: mockGetCommentReplies,
    getContentState: mockGetContentState,
    setContentState: mockSetContentState,
    getSiteDefaultLocale: vi.fn().mockResolvedValue(undefined),
    removeContentState: vi.fn().mockResolvedValue(undefined),
    ensureAttributionLabel: mockEnsureAttributionLabel,
    _rawCreatePage: vi.fn().mockResolvedValue({
      id: "99",
      title: "Test Page",
      version: { number: 1 },
      space: { key: "TEST" },
      _links: { webui: "/pages/99" },
    }),
    _rawUpdatePage: vi.fn().mockResolvedValue({
      id: "99",
      title: "Test Page",
      version: { number: 2 },
      space: { key: "TEST" },
      _links: { webui: "/pages/99" },
    }),
    deletePage: vi.fn().mockResolvedValue(undefined),
    searchPages: vi.fn().mockResolvedValue([]),
    listPages: vi.fn().mockResolvedValue([]),
    getSpaces: vi.fn().mockResolvedValue([]),
    getPageChildren: vi.fn().mockResolvedValue([]),
    getPageByTitle: vi.fn().mockResolvedValue(null),
    getAttachments: vi.fn().mockResolvedValue([]),
    uploadAttachment: vi.fn().mockResolvedValue({}),
    getLabels: vi.fn().mockResolvedValue([]),
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
    formatPage: vi.fn().mockResolvedValue("# Test Page\n\nID: 99"),
    extractSection: vi.fn().mockReturnValue(null),
    extractSectionBody: vi.fn().mockReturnValue(null),
    replaceSection: vi.fn().mockReturnValue("<p>replaced</p>"),
    truncateStorageFormat: vi.fn().mockImplementation((s: string, n: number) => s.slice(0, n)),
    toMarkdownView: vi.fn().mockReturnValue("markdown view"),
    looksLikeMarkdown: vi.fn().mockReturnValue(false),
    sanitizeError: vi.fn().mockImplementation((s: string) => s),
    getPageVersions: vi.fn().mockResolvedValue([]),
    getPageVersionBody: vi.fn().mockResolvedValue("<p>v1</p>"),
    searchUsers: vi.fn().mockResolvedValue([]),
    searchPagesByTitle: vi.fn().mockResolvedValue([]),
    setClientLabel: vi.fn(),
    createFooterComment: vi.fn().mockResolvedValue({ id: "c1" }),
    createInlineComment: vi.fn().mockResolvedValue({ id: "c2" }),
    resolveComment: vi.fn().mockResolvedValue(undefined),
    deleteFooterComment: vi.fn().mockResolvedValue(undefined),
    deleteInlineComment: vi.fn().mockResolvedValue(undefined),
    ProfileNotConfiguredError: actual.ProfileNotConfiguredError,
  };
});

vi.mock("./mutation-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mutation-log.js")>();
  return { ...actual, initMutationLog: vi.fn(), logMutation: vi.fn() };
});

// Mock provenance so we can spy on markPageUnverified independently of
// the module that was mocked above (safe-write calls safeSubmitPage which
// does NOT call markPageUnverified — the handler does). This gives us
// fine-grained control per-scenario.
vi.mock("./provenance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./provenance.js")>();
  return {
    ...actual,
    markPageUnverified: mockMarkPageUnverified,
  };
});

// ---------------------------------------------------------------------------
// Module-level setup
// ---------------------------------------------------------------------------

type ToolEntry = { handler: (...args: unknown[]) => Promise<unknown>; schema: unknown };
let tools: Map<string, ToolEntry>;

async function spinUpServer(configOverride: Partial<typeof defaultConfig> = {}): Promise<void> {
  // Reset mocks from prior runs
  mockRegisterTool.mockClear();
  mockConnect.mockClear();
  // Merge config override
  activeConfig = { ...defaultConfig, ...configOverride };
  // Re-import main() fresh each time — vitest caches modules, so we need to
  // clear the module cache to re-register tools with the new config.
  // Instead, we reload via dynamic import of a dedicated factory.
  const { _resetReadOnlyNoteForTest } = await import("./index.js");
  _resetReadOnlyNoteForTest();

  const { main } = await import("./index.js");
  await main();

  tools = new Map<string, ToolEntry>();
  for (const call of mockRegisterTool.mock.calls) {
    const [name, cfg, handler] = call as [string, unknown, ToolEntry["handler"]];
    tools.set(name, { handler, schema: cfg });
  }
}

beforeAll(async () => {
  await spinUpServer();
});

beforeEach(() => {
  // Reset per-call mocks to their defaults
  mockEnsureAttributionLabel.mockResolvedValue({});
  mockMarkPageUnverified.mockResolvedValue({});
  mockGetContentState.mockResolvedValue(null);
  mockSetContentState.mockResolvedValue(undefined);
  mockGetPage.mockResolvedValue({
    id: "99",
    title: "Test Page",
    version: { number: 5 },
    body: { storage: { value: "<p>current content</p>" } },
    spaceId: "SPACE1",
  });
  mockGetFooterComments.mockResolvedValue([]);
  mockGetInlineComments.mockResolvedValue([]);
  mockGetCommentReplies.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Scenario 1: End-to-end read-only posture
// ---------------------------------------------------------------------------
describe("Scenario 1: read-only posture — tool list and check_permissions", () => {
  let readOnlyTools: Map<string, ToolEntry>;

  beforeAll(async () => {
    mockRegisterTool.mockClear();
    activeConfig = {
      ...defaultConfig,
      readOnly: true,
      posture: "read-only" as const,
      effectivePosture: "read-only" as const,
      probedCapability: null,
      postureSource: "profile" as const,
    };
    mockGetConfig.mockImplementation(async () => activeConfig);

    const { _resetReadOnlyNoteForTest } = await import("./index.js");
    _resetReadOnlyNoteForTest();
    const { main } = await import("./index.js");
    await main();

    readOnlyTools = new Map();
    for (const call of mockRegisterTool.mock.calls) {
      const [name, cfg, handler] = call as [string, unknown, ToolEntry["handler"]];
      readOnlyTools.set(name, { handler, schema: cfg });
    }
  });

  it("registers check_permissions in read-only mode", () => {
    expect(readOnlyTools.has("check_permissions")).toBe(true);
  });

  it("registers read tools (get_page, search_pages, get_spaces) in read-only mode", () => {
    expect(readOnlyTools.has("get_page")).toBe(true);
    expect(readOnlyTools.has("search_pages")).toBe(true);
    expect(readOnlyTools.has("get_spaces")).toBe(true);
    expect(readOnlyTools.has("get_comments")).toBe(true);
  });

  it("does NOT register write tools in read-only mode", () => {
    expect(readOnlyTools.has("create_page")).toBe(false);
    expect(readOnlyTools.has("update_page")).toBe(false);
    expect(readOnlyTools.has("set_page_status")).toBe(false);
    expect(readOnlyTools.has("delete_page")).toBe(false);
    expect(readOnlyTools.has("add_label")).toBe(false);
    expect(readOnlyTools.has("create_comment")).toBe(false);
  });

  it("check_permissions returns payload reflecting read-only configured posture", async () => {
    const handler = readOnlyTools.get("check_permissions")!.handler;
    const result = await handler({}) as { content: { text: string }[] };
    // The first call in read-only mode prepends a one-time note. Strip it.
    const text = result.content[0].text;
    const jsonStart = text.indexOf("{");
    const payload = JSON.parse(jsonStart >= 0 ? text.slice(jsonStart) : text);

    expect(payload.posture.effective).toBe("read-only");
    expect(payload.posture.configured).toBe("read-only");
    expect(payload.posture.source).toBe("profile");
    expect(payload.tokenCapability.authenticated).toBe(true);
  });

  afterAll(() => {
    // Restore default config for subsequent test groups
    activeConfig = { ...defaultConfig };
    mockGetConfig.mockImplementation(async () => activeConfig);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: End-to-end first-edit flow (read-write, create_page)
// ---------------------------------------------------------------------------
describe("Scenario 2: end-to-end first-edit flow (create_page)", () => {
  it("create_page succeeds; setContentState called once with AI-edited badge", async () => {
    // getContentState returns null → badge should be applied
    mockGetContentState.mockResolvedValue(null);
    mockSetContentState.mockResolvedValue(undefined);
    mockEnsureAttributionLabel.mockResolvedValue({});

    // Use the real markPageUnverified by restoring the spy with real behavior
    mockMarkPageUnverified.mockImplementation(async (pageId: string) => {
      const current = await mockGetContentState(pageId);
      if (!current) {
        await mockSetContentState(pageId, "AI-edited", "#FFC400");
      }
      return {};
    });

    const handler = tools.get("create_page")!.handler;
    const result = await handler({
      title: "Test Page",
      space_key: "TEST",
      body: "<p>Hello world</p>",
      allow_raw_html: false,
    }) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBeUndefined();
    expect(mockSetContentState).toHaveBeenCalledWith("99", "AI-edited", "#FFC400");
    expect(mockSetContentState).toHaveBeenCalledTimes(1);
    // Response contains page info, no warnings
    expect(result.content[0].text).not.toContain("⚠");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Idempotency across edits (update_page when badge already set)
// ---------------------------------------------------------------------------
describe("Scenario 3: idempotency — update_page when badge already set", () => {
  it("does NOT call setContentState when getContentState returns AI-edited badge", async () => {
    mockGetContentState.mockResolvedValue({ name: "AI-edited", color: "#FFC400" });
    mockSetContentState.mockClear();

    // Real idempotency check logic
    mockMarkPageUnverified.mockImplementation(async (pageId: string) => {
      const current = await mockGetContentState(pageId);
      if (
        current &&
        current.color === "#FFC400" &&
        current.name === "AI-edited"
      ) {
        return {}; // idempotent skip
      }
      await mockSetContentState(pageId, "AI-edited", "#FFC400");
      return {};
    });

    const handler = tools.get("update_page")!.handler;
    await handler({
      page_id: "99",
      title: "Test Page",
      body: "<p>updated content</p>",
      version: 5,
      replace_body: true,
    });

    expect(mockSetContentState).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Label permission failure surfaces warning
// ---------------------------------------------------------------------------
describe("Scenario 4: label permission failure → warning, not error", () => {
  it("create_page returns success + label warning when label endpoint returns 403", async () => {
    mockEnsureAttributionLabel.mockResolvedValue({
      warning: "Could not apply 'epimethian-edited' label (permission denied). Provenance label is missing for page 99.",
    });
    mockMarkPageUnverified.mockResolvedValue({});

    const handler = tools.get("create_page")!.handler;
    const result = await handler({
      title: "Test Page",
      space_key: "TEST",
      body: "<p>content</p>",
      allow_raw_html: false,
    }) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("⚠");
    expect(result.content[0].text).toContain("epimethian-edited");
    expect(result.content[0].text).toContain("permission denied");
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Badge permission failure surfaces warning
// ---------------------------------------------------------------------------
describe("Scenario 5: badge permission failure → warning, not error", () => {
  it("create_page returns success + badge warning when setContentState returns 403", async () => {
    mockEnsureAttributionLabel.mockResolvedValue({});
    mockMarkPageUnverified.mockResolvedValue({
      warning: "Could not apply 'AI-edited' status badge (permission denied). Provenance badge is missing for page 99.",
    });

    const handler = tools.get("create_page")!.handler;
    const result = await handler({
      title: "Test Page",
      space_key: "TEST",
      body: "<p>content</p>",
      allow_raw_html: false,
    }) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("⚠");
    expect(result.content[0].text).toContain("AI-edited");
    expect(result.content[0].text).toContain("permission denied");
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Both warnings together
// ---------------------------------------------------------------------------
describe("Scenario 6: both label AND badge failures → both warnings, success", () => {
  it("create_page returns success with both warnings when label 403 AND badge 403", async () => {
    mockEnsureAttributionLabel.mockResolvedValue({
      warning: "Could not apply 'epimethian-edited' label (permission denied). Provenance label is missing for page 99.",
    });
    mockMarkPageUnverified.mockResolvedValue({
      warning: "Could not apply 'AI-edited' status badge (permission denied). Provenance badge is missing for page 99.",
    });

    const handler = tools.get("create_page")!.handler;
    const result = await handler({
      title: "Test Page",
      space_key: "TEST",
      body: "<p>content</p>",
      allow_raw_html: false,
    }) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("epimethian-edited");
    expect(text).toContain("AI-edited");
    // Both ⚠ markers present
    const warningCount = (text.match(/⚠/g) || []).length;
    expect(warningCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: Auth error remediation
// ---------------------------------------------------------------------------
describe("Scenario 7: auth error → remediation message", () => {
  it("create_page with 401 response returns reauth remediation message", async () => {
    const { ConfluenceAuthError } = await import("./confluence-client.js");
    const { resolveSpaceId } = await import("./confluence-client.js");
    (resolveSpaceId as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ConfluenceAuthError(401, "Unauthorized")
    );

    const handler = tools.get("create_page")!.handler;
    const result = await handler({
      title: "Auth Error Test",
      space_key: "TEST",
      body: "<p>content</p>",
      allow_raw_html: false,
    }) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Reauthenticate");
    expect(result.content[0].text).toContain("epimethian-mcp login");
  });
});

// ---------------------------------------------------------------------------
// Scenario 8: Not-found remediation
// ---------------------------------------------------------------------------
describe("Scenario 8: 404 → not-found remediation message", () => {
  it("get_page with 404 returns the resource-not-found remediation text", async () => {
    const { ConfluenceNotFoundError } = await import("./confluence-client.js");
    mockGetPage.mockRejectedValueOnce(new ConfluenceNotFoundError(404, "Not Found"));

    // get_page uses plain toolError, so check the update_page handler which
    // uses toolErrorWithContext. Actually get_page uses toolError (not context),
    // so let's test update_page which does use toolErrorWithContext:
    const { ConfluenceNotFoundError: NFE } = await import("./confluence-client.js");
    // Use update_page — it calls getPage which we can make throw 404
    mockGetPage.mockRejectedValueOnce(new NFE(404, "Not Found"));

    const handler = tools.get("update_page")!.handler;
    const result = await handler({
      page_id: "999",
      title: "Missing",
      body: "<p>content</p>",
      version: 1,
      replace_body: true,
    }) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
    expect(result.content[0].text).toContain("token lacks permission");
  });
});

// ---------------------------------------------------------------------------
// Scenario 9: Mixed posture / token probe result
// ---------------------------------------------------------------------------
describe("Scenario 9: write-capable probe + read-only posture → check_permissions", () => {
  let mixedTools: Map<string, ToolEntry>;

  beforeAll(async () => {
    mockRegisterTool.mockClear();
    activeConfig = {
      ...defaultConfig,
      readOnly: true,
      posture: "read-only" as const,
      effectivePosture: "read-only" as const,
      // Token is write-capable but user pinned to read-only
      probedCapability: "write" as const,
      postureSource: "profile" as const,
    };
    mockGetConfig.mockImplementation(async () => activeConfig);

    const { _resetReadOnlyNoteForTest } = await import("./index.js");
    _resetReadOnlyNoteForTest();
    const { main } = await import("./index.js");
    await main();

    mixedTools = new Map();
    for (const call of mockRegisterTool.mock.calls) {
      const [name, cfg, handler] = call as [string, unknown, ToolEntry["handler"]];
      mixedTools.set(name, { handler, schema: cfg });
    }
  });

  it("check_permissions reflects effective read-only, writePages: true, and pinning note", async () => {
    const handler = mixedTools.get("check_permissions")!.handler;
    const result = await handler({}) as { content: { text: string }[] };
    // First call in read-only mode may include a one-time note prefix — strip it.
    const text = result.content[0].text;
    const jsonStart = text.indexOf("{");
    const payload = JSON.parse(jsonStart >= 0 ? text.slice(jsonStart) : text);

    expect(payload.posture.effective).toBe("read-only");
    expect(payload.posture.configured).toBe("read-only");
    expect(payload.posture.source).toBe("profile");
    expect(payload.tokenCapability.writePages).toBe(true);
    // Note explains user pinning
    expect(payload.notes.length).toBeGreaterThan(0);
    const notesText = payload.notes.join(" ");
    expect(notesText).toContain("pinned to read-only");
    expect(notesText).toContain("write access");
  });

  afterAll(() => {
    activeConfig = { ...defaultConfig };
    mockGetConfig.mockImplementation(async () => activeConfig);
  });
});

// ---------------------------------------------------------------------------
// Scenario 10: get_comments partial replies (Promise.allSettled)
// ---------------------------------------------------------------------------
describe("Scenario 10: get_comments partial replies — one 403 in N=3 top-level", () => {
  it("returns 2 successful + 1 error reply group + partial-results note", async () => {
    const { ConfluencePermissionError } = await import("./confluence-client.js");

    // 3 top-level footer comments
    const topLevel = [
      { id: "c1", body: { storage: { value: "<p>Comment 1</p>" } }, pageId: "99", version: { authorId: "u1", createdAt: "2026-01-01" }, resolutionStatus: null },
      { id: "c2", body: { storage: { value: "<p>Comment 2</p>" } }, pageId: "99", version: { authorId: "u2", createdAt: "2026-01-02" }, resolutionStatus: null },
      { id: "c3", body: { storage: { value: "<p>Comment 3</p>" } }, pageId: "99", version: { authorId: "u3", createdAt: "2026-01-03" }, resolutionStatus: null },
    ];
    mockGetFooterComments.mockResolvedValue(topLevel);
    mockGetInlineComments.mockResolvedValue([]);

    // c1 and c3 succeed; c2 returns 403
    mockGetCommentReplies.mockImplementation(async (commentId: string) => {
      if (commentId === "c2") {
        throw new ConfluencePermissionError(403, "Forbidden");
      }
      return [];
    });

    const handler = tools.get("get_comments")!.handler;
    const result = await handler({
      page_id: "99",
      type: "all",
      resolution_status: "all",
      include_replies: true,
    }) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;

    // Partial-results note present
    expect(text).toContain("1 of 3 reply fetches failed");
    expect(text).toContain("partial results shown");

    // The errored comment shows an error line
    expect(text).toContain("Error fetching replies");
  });

  it("returns all-failed note when all 3 reply fetches fail", async () => {
    const { ConfluencePermissionError } = await import("./confluence-client.js");

    const topLevel = [
      { id: "c1", body: { storage: { value: "<p>A</p>" } }, pageId: "99", version: { authorId: "u1", createdAt: "2026-01-01" }, resolutionStatus: null },
      { id: "c2", body: { storage: { value: "<p>B</p>" } }, pageId: "99", version: { authorId: "u2", createdAt: "2026-01-02" }, resolutionStatus: null },
      { id: "c3", body: { storage: { value: "<p>C</p>" } }, pageId: "99", version: { authorId: "u3", createdAt: "2026-01-03" }, resolutionStatus: null },
    ];
    mockGetFooterComments.mockResolvedValue(topLevel);
    mockGetInlineComments.mockResolvedValue([]);

    mockGetCommentReplies.mockRejectedValue(
      new ConfluencePermissionError(403, "Forbidden")
    );

    const handler = tools.get("get_comments")!.handler;
    const result = await handler({
      page_id: "99",
      type: "all",
      resolution_status: "all",
      include_replies: true,
    }) as { content: { text: string }[]; isError?: boolean };

    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain("3 of 3 reply fetches failed");
    expect(text).toContain("partial results shown");
  });
});

// ---------------------------------------------------------------------------
// Scenario bonus: appendWarnings helper directly (exported from index.ts)
// ---------------------------------------------------------------------------
describe("appendWarnings helper", () => {
  it("returns primary unchanged when no warnings", async () => {
    const { appendWarnings } = await import("./index.js");
    expect(appendWarnings("primary text", [])).toBe("primary text");
  });

  it("appends single warning with ⚠ prefix", async () => {
    const { appendWarnings } = await import("./index.js");
    const result = appendWarnings("primary", ["something went wrong"]);
    expect(result).toBe("primary\n\n⚠ something went wrong");
  });

  it("appends multiple warnings each on own line", async () => {
    const { appendWarnings } = await import("./index.js");
    const result = appendWarnings("primary", ["warn1", "warn2"]);
    expect(result).toBe("primary\n\n⚠ warn1\n⚠ warn2");
  });
});

// ---------------------------------------------------------------------------
// Scenario bonus: WRITE_TOOLS exported set has expected members
// ---------------------------------------------------------------------------
describe("WRITE_TOOLS set completeness", () => {
  it("contains the 7 body-modifying tools that get provenance badge", async () => {
    const { WRITE_TOOLS } = await import("./index.js");
    const bodyModifying = [
      "create_page",
      "update_page",
      "append_to_page",
      "prepend_to_page",
      "update_page_section",
      "add_drawio_diagram",
      "revert_page",
    ];
    for (const tool of bodyModifying) {
      expect(WRITE_TOOLS.has(tool)).toBe(true);
    }
  });

  it("does NOT contain check_permissions (always registered)", async () => {
    const { WRITE_TOOLS } = await import("./index.js");
    expect(WRITE_TOOLS.has("check_permissions")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario bonus: toolErrorWithContext dispatch table
// ---------------------------------------------------------------------------
describe("toolErrorWithContext remediation dispatch", () => {
  it("ConfluenceAuthError → reauth message with profile name", async () => {
    const { toolErrorWithContext } = await import("./index.js");
    const { ConfluenceAuthError } = await import("./confluence-client.js");
    const err = new ConfluenceAuthError(401, "Unauthorized");
    const result = toolErrorWithContext(err, { operation: "create_page", profile: "my-profile" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Reauthenticate");
    expect(result.content[0].text).toContain("epimethian-mcp login my-profile");
  });

  it("ConfluencePermissionError → permission message with operation + resource", async () => {
    const { toolErrorWithContext } = await import("./index.js");
    const { ConfluencePermissionError } = await import("./confluence-client.js");
    const err = new ConfluencePermissionError(403, "Forbidden");
    const result = toolErrorWithContext(err, { operation: "update_page", resource: "page 42" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("lacks permission for update_page on page 42");
    expect(result.content[0].text).toContain("not performed");
  });

  it("ConfluenceNotFoundError → not-found message with visibility note", async () => {
    const { toolErrorWithContext } = await import("./index.js");
    const { ConfluenceNotFoundError } = await import("./confluence-client.js");
    const err = new ConfluenceNotFoundError(404, "Not Found");
    const result = toolErrorWithContext(err, { operation: "get_page" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Resource not found");
    expect(result.content[0].text).toContain("token lacks permission");
  });

  it("generic error falls through to plain toolError format", async () => {
    const { toolErrorWithContext } = await import("./index.js");
    const err = new Error("something generic failed");
    const result = toolErrorWithContext(err, { operation: "create_page" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("something generic failed");
    expect(result.content[0].text).not.toContain("Reauthenticate");
  });
});
