/**
 * Integration tests for mass-damage / volume bounds (Track G3).
 *
 * Each scenario exercises a distinct defensive layer at the tool-
 * handler boundary so a regression in the wiring surfaces as a
 * failing assertion, not silent bypass:
 *
 *   - Write-budget ceiling (F4)
 *   - set_page_status dedup (A2)
 *   - Byte-identical update short-circuit (A1)
 *   - delete_page version gating (B1)
 *   - Per-space allowlist rejection (F3)
 *
 * These are NOT unit tests of the individual modules (which live in
 * their own *.test.ts files); they're end-to-end tests of the full
 * handler call path through the registered MCP tools.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://test.atlassian.net";
  process.env.CONFLUENCE_EMAIL = "user@test.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
  // The individual test blocks set budget / opt-outs as needed.
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

vi.mock("./confluence-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./confluence-client.js")>();
  class ConfluenceConflictError extends Error {
    constructor(pageId: string) {
      super(
        `Version conflict: page ${pageId} has been modified since you last read it. ` +
          `Call get_page to fetch the latest version, then retry your update with the new version number.`,
      );
      this.name = "ConfluenceConflictError";
    }
  }
  return {
    ...actual,
    resolveSpaceId: vi.fn(),
    getPage: vi.fn(),
    _rawCreatePage: vi.fn(),
    _rawUpdatePage: vi.fn(),
    deletePage: vi.fn(),
    getContentState: vi.fn(),
    setContentState: vi.fn(),
    removeContentState: vi.fn(),
    getPageByTitle: vi.fn(),
    getConfig: vi.fn().mockResolvedValue({
      url: "https://test.atlassian.net",
      email: "user@test.com",
      profile: null,
      readOnly: false,
      attribution: true,
      apiV2: "https://test.atlassian.net/wiki/api/v2",
      apiV1: "https://test.atlassian.net/wiki/rest/api",
      authHeader: "Basic dGVzdA==",
      jsonHeaders: {},
    }),
    validateStartup: vi.fn().mockResolvedValue(undefined),
    ConfluenceConflictError,
  };
});

vi.mock("./mutation-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mutation-log.js")>();
  return {
    ...actual,
    initMutationLog: vi.fn(),
    logMutation: vi.fn(),
  };
});

let registeredTools: Map<string, { handler: Function; schema: any }>;

beforeAll(async () => {
  const { main } = await import("./index.js");
  await main();
  registeredTools = new Map();
  for (const call of mockRegisterTool.mock.calls) {
    const [name, config, handler] = call;
    registeredTools.set(name, { handler, schema: config });
  }
});

describe("mass-damage integration (G3)", () => {
  // ---------------------------------------------------------------------------
  // F4: write budget
  // ---------------------------------------------------------------------------
  describe("F4: write-budget ceiling", () => {
    beforeEach(async () => {
      const { writeBudget } = await import("./write-budget.js");
      writeBudget._resetForTest();
    });

    it("G3/F4: halts a delete_page loop after the hourly budget is exhausted", async () => {
      process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "0";
      process.env.EPIMETHIAN_WRITE_BUDGET_HOURLY = "3";

      const { deletePage } = await import("./confluence-client.js");
      (deletePage as any).mockReset();
      (deletePage as any).mockResolvedValue(undefined);

      const handler = registeredTools.get("delete_page")!.handler;

      // Three consecutive deletes — all succeed.
      for (const id of ["1", "2", "3"]) {
        const r = await handler({ page_id: id, version: 5 });
        expect(r.isError).toBeUndefined();
      }

      // Fourth is rejected by the budget, BEFORE the HTTP call.
      const r = await handler({ page_id: "4", version: 5 });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/hourly write budget exhausted/i);
      expect(deletePage).toHaveBeenCalledTimes(3);

      // Reset for other tests.
      process.env.EPIMETHIAN_WRITE_BUDGET_HOURLY = "0";
    });
  });

  // ---------------------------------------------------------------------------
  // A2: set_page_status dedup
  // ---------------------------------------------------------------------------
  describe("A2: set_page_status dedup", () => {
    it("G3/A2: 10 identical set_page_status calls result in zero PUTs when state matches", async () => {
      const { getContentState, setContentState } = await import(
        "./confluence-client.js"
      );
      (setContentState as any).mockClear();
      // Return the matching state on every read.
      (getContentState as any).mockResolvedValue({
        name: "Ready for review",
        color: "#57D9A3",
      });

      const handler = registeredTools.get("set_page_status")!.handler;
      for (let i = 0; i < 10; i++) {
        const r = await handler({
          page_id: "123",
          name: "Ready for review",
          color: "#57D9A3",
        });
        expect(r.isError).toBeUndefined();
        expect(r.content[0].text).toContain("no-op: status unchanged");
      }
      expect(setContentState).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // A1: byte-identical update short-circuit
  // ---------------------------------------------------------------------------
  describe("A1: byte-identical update short-circuit", () => {
    it("G3/A1: 5 identical update_page calls result in zero _rawUpdatePage writes", async () => {
      const { getPage, _rawUpdatePage } = await import(
        "./confluence-client.js"
      );
      (_rawUpdatePage as any).mockClear();
      const identicalBody = "<p>Unchanged content</p>";
      // Each iteration fetches the page to get current body + version.
      (getPage as any).mockImplementation(async () => ({
        id: "7",
        title: "T",
        version: { number: 5 },
        body: { storage: { value: identicalBody } },
      }));

      const handler = registeredTools.get("update_page")!.handler;
      for (let i = 0; i < 5; i++) {
        const r = await handler({
          page_id: "7",
          title: "T",
          version: 5,
          body: identicalBody,
        });
        expect(r.isError).toBeUndefined();
      }
      expect(_rawUpdatePage).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // B1: delete_page version gating
  // ---------------------------------------------------------------------------
  describe("B1: delete_page version gating", () => {
    beforeEach(async () => {
      const { writeBudget } = await import("./write-budget.js");
      writeBudget._resetForTest();
      delete process.env.EPIMETHIAN_LEGACY_DELETE_WITHOUT_VERSION;
    });

    it("G3/B1: stale version → ConfluenceConflictError surfaces to the handler", async () => {
      const { deletePage, ConfluenceConflictError } = await import(
        "./confluence-client.js"
      );
      (deletePage as any).mockReset();
      (deletePage as any).mockRejectedValueOnce(
        new ConfluenceConflictError("42"),
      );
      const handler = registeredTools.get("delete_page")!.handler;

      const r = await handler({ page_id: "42", version: 3 });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("Version conflict");
    });

    it("G3/B1: omitted version fails fast (no HTTP call) under default policy", async () => {
      const { deletePage } = await import("./confluence-client.js");
      (deletePage as any).mockClear();
      const handler = registeredTools.get("delete_page")!.handler;

      const r = await handler({ page_id: "42" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("requires a `version`");
      expect(deletePage).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // F3: per-space allowlist
  // ---------------------------------------------------------------------------
  describe("F3: per-space allowlist rejection", () => {
    it("G3/F3: assertSpaceAllowed rejects a pageId whose space is outside the list", async () => {
      const { getPage } = await import("./confluence-client.js");
      const { pageSpaceCache, assertSpaceAllowed, SpaceNotAllowedError } =
        await import("./space-allowlist.js");
      pageSpaceCache._resetForTest();
      (getPage as any).mockResolvedValueOnce({
        id: "999",
        title: "Restricted",
        spaceId: "OPS",
      });

      try {
        await assertSpaceAllowed({ spaces: ["DOCS"], pageId: "999" });
        expect.unreachable("F3 gate should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SpaceNotAllowedError);
        expect((err as Error).message).toContain("OPS");
        expect((err as Error).message).toContain("DOCS");
      }
    });

    it("G3/F3: assertSpaceAllowed bypassed when no spaces setting is present", async () => {
      const { assertSpaceAllowed } = await import("./space-allowlist.js");
      await expect(
        assertSpaceAllowed({ spaces: undefined, spaceKey: "ANYTHING" }),
      ).resolves.toBeUndefined();
    });
  });
});
