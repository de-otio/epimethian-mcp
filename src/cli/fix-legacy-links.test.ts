/**
 * Tests for fix-legacy-links CLI.
 *
 * Structure:
 *   Section A — unit tests for the scanner/rewriter (pure functions, no mocks).
 *   Section B — integration tests for runFixLegacyLinks, mocking:
 *                 - confluence-client (getConfig, getPage, listPages, resolveSpaceId)
 *                 - safe-write (safePrepareBody, safeSubmitPage)
 *                 - profiles/keychain (for multi-tenant detection)
 *
 * Total LoC budget: ≤ 400.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Section A — Pure unit tests (no mocks)
// ---------------------------------------------------------------------------

import {
  countLegacyLinks,
  rewriteLegacyLinks,
} from "./fix-legacy-links.js";

// Fixtures
const LEGACY_WITH_SPACE = [
  '<ac:link>',
  '  <ri:page ri:content-id="123456" ri:space-key="XX"/>',
  '  <ac:plain-text-link-body><![CDATA[Go to the page]]></ac:plain-text-link-body>',
  '</ac:link>',
].join('\n');

const LEGACY_NO_SPACE = [
  '<ac:link>',
  '  <ri:page ri:content-id="789"/>',
  '  <ac:plain-text-link-body><![CDATA[another link]]></ac:plain-text-link-body>',
  '</ac:link>',
].join('\n');

// User-mention: must NOT be rewritten.
const USER_MENTION =
  '<ac:link><ri:user ri:account-id="abc"/></ac:link>';

// Modern ac:link shape: must NOT be rewritten.
const MODERN_LINK = [
  '<ac:link>',
  '  <ri:page ri:content-title="My Page"/>',
  '  <ac:link-body>My Page</ac:link-body>',
  '</ac:link>',
].join('\n');

describe("countLegacyLinks", () => {
  it("counts zero for a clean body", () => {
    expect(countLegacyLinks("<p>No links here.</p>")).toBe(0);
  });

  it("counts one legacy link with ri:space-key", () => {
    expect(countLegacyLinks(LEGACY_WITH_SPACE)).toBe(1);
  });

  it("counts one legacy link without ri:space-key", () => {
    expect(countLegacyLinks(LEGACY_NO_SPACE)).toBe(1);
  });

  it("counts multiple legacy links", () => {
    expect(countLegacyLinks(LEGACY_WITH_SPACE + LEGACY_NO_SPACE)).toBe(2);
  });

  it("does not count user-mention ac:link shapes", () => {
    expect(countLegacyLinks(USER_MENTION)).toBe(0);
  });

  it("does not count modern ac:link-body shapes", () => {
    expect(countLegacyLinks(MODERN_LINK)).toBe(0);
  });
});

describe("rewriteLegacyLinks", () => {
  const BASE = "https://example.atlassian.net";

  it("rewrites link with ri:space-key to canonical URL", () => {
    const { rewritten, count } = rewriteLegacyLinks(LEGACY_WITH_SPACE, BASE);
    expect(count).toBe(1);
    expect(rewritten).toContain(
      `<a href="${BASE}/wiki/spaces/XX/pages/123456">Go to the page</a>`,
    );
    expect(rewritten).not.toContain("ac:link");
    expect(rewritten).not.toContain("ac:plain-text-link-body");
  });

  it("rewrites link without ri:space-key to viewpage URL", () => {
    const { rewritten, count } = rewriteLegacyLinks(LEGACY_NO_SPACE, BASE);
    expect(count).toBe(1);
    expect(rewritten).toContain(
      `<a href="${BASE}/wiki/pages/viewpage.action?pageId=789">another link</a>`,
    );
  });

  it("rewrites multiple legacy links in one pass", () => {
    const body = `<p>See ${LEGACY_WITH_SPACE} and ${LEGACY_NO_SPACE}.</p>`;
    const { rewritten, count } = rewriteLegacyLinks(body, BASE);
    expect(count).toBe(2);
    expect(rewritten).toContain("Go to the page");
    expect(rewritten).toContain("another link");
    expect(rewritten).not.toContain("ac:plain-text-link-body");
  });

  it("leaves user-mention ac:link untouched", () => {
    const body = `<p>${USER_MENTION}</p>`;
    const { rewritten, count } = rewriteLegacyLinks(body, BASE);
    expect(count).toBe(0);
    expect(rewritten).toContain(USER_MENTION);
  });

  it("leaves modern ac:link-body untouched", () => {
    const body = MODERN_LINK;
    const { rewritten, count } = rewriteLegacyLinks(body, BASE);
    expect(count).toBe(0);
    expect(rewritten).toContain("ac:link-body");
  });

  it("returns count=0 and unchanged body when no legacy links", () => {
    const body = "<p>Clean body.</p>";
    const { rewritten, count } = rewriteLegacyLinks(body, BASE);
    expect(count).toBe(0);
    expect(rewritten).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// Section B — Integration tests (mocked dependencies)
// ---------------------------------------------------------------------------

// Hoisted env setup: confluence-client reads env at import time.
vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://test.atlassian.net";
  process.env.CONFLUENCE_EMAIL = "user@test.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
});

// Mock keychain so profiles registry doesn't hit the OS.
vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: vi.fn().mockResolvedValue(null),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

// Mock profiles registry.
vi.mock("../shared/profiles.js", () => ({
  readProfileRegistry: vi.fn().mockResolvedValue([]),
}));

// Mock confluence-client — keep looksLikeMarkdown + other utilities real.
vi.mock("../server/confluence-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/confluence-client.js")>();
  return {
    ...actual,
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
    getPage: vi.fn(),
    listPages: vi.fn(),
    resolveSpaceId: vi.fn().mockResolvedValue("space-id-1"),
  };
});

// Mock the safe-write pipeline.
vi.mock("../server/safe-write.js", () => ({
  safePrepareBody: vi.fn().mockResolvedValue({
    finalStorage: "<p>rewritten</p>",
    versionMessage: "",
    deletedTokens: [],
  }),
  safeSubmitPage: vi.fn().mockResolvedValue({
    page: { id: "p1", title: "My Page", version: { number: 6 } },
    newVersion: 6,
    oldLen: 100,
    newLen: 90,
    deletedTokens: [],
  }),
}));

import { runFixLegacyLinks } from "./fix-legacy-links.js";
import {
  getConfig,
  getPage,
  listPages,
  resolveSpaceId,
} from "../server/confluence-client.js";
import {
  safePrepareBody,
  safeSubmitPage,
} from "../server/safe-write.js";
import { readProfileRegistry } from "../shared/profiles.js";
import { readFromKeychain } from "../shared/keychain.js";

// A page body containing one legacy link.
const LEGACY_BODY =
  '<p>See <ac:link><ri:page ri:content-id="111" ri:space-key="AA"/>' +
  '<ac:plain-text-link-body><![CDATA[Target]]></ac:plain-text-link-body></ac:link>.</p>';

// A page body with no legacy links.
const CLEAN_BODY = "<p>Nothing to fix here.</p>";

function mockPage(
  id: string,
  title: string,
  body: string,
  version = 5,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  return {
    id,
    title,
    version: { number: version },
    body: { storage: { value: body } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Single-tenant by default: only env-var host, no profiles.
  (readProfileRegistry as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (readFromKeychain as ReturnType<typeof vi.fn>).mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runFixLegacyLinks — argument validation", () => {
  it("exits 1 when --client-label is missing", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit:1");
    }) as never);
    const mockErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runFixLegacyLinks(["--page-ids", "p1"]),
    ).rejects.toThrow("process.exit:1");

    expect(mockErr.mock.calls.some((c) => String(c[0]).includes("--client-label"))).toBe(true);
    mockExit.mockRestore();
    mockErr.mockRestore();
  });

  it("exits 1 when neither --page-ids nor --space-key is given", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit:1");
    }) as never);
    const mockErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runFixLegacyLinks(["--client-label", "test"]),
    ).rejects.toThrow("process.exit:1");

    expect(
      mockErr.mock.calls.some((c) =>
        String(c[0]).includes("--page-ids") || String(c[0]).includes("--space-key"),
      ),
    ).toBe(true);
    mockExit.mockRestore();
    mockErr.mockRestore();
  });

  it("exits 1 when both --page-ids and --space-key are given", async () => {
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit:1");
    }) as never);
    const mockErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runFixLegacyLinks([
        "--client-label", "test",
        "--page-ids", "p1",
        "--space-key", "XX",
      ]),
    ).rejects.toThrow("process.exit:1");

    expect(
      mockErr.mock.calls.some((c) =>
        String(c[0]).includes("mutually exclusive"),
      ),
    ).toBe(true);
    mockExit.mockRestore();
    mockErr.mockRestore();
  });
});

describe("runFixLegacyLinks — multi-tenant refusal", () => {
  it("exits 1 when multiple hosts detected without --i-understand-multi-tenant", async () => {
    // Simulate two profiles pointing at different hosts.
    (readProfileRegistry as ReturnType<typeof vi.fn>).mockResolvedValue([
      "tenant-a",
      "tenant-b",
    ]);
    (readFromKeychain as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ url: "https://tenant-a.atlassian.net", email: "a@a.com", apiToken: "x" })
      .mockResolvedValueOnce({ url: "https://tenant-b.atlassian.net", email: "b@b.com", apiToken: "y" });

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit:1");
    }) as never);
    const mockErr = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runFixLegacyLinks(["--client-label", "test", "--page-ids", "p1"]),
    ).rejects.toThrow("process.exit:1");

    expect(
      mockErr.mock.calls.some((c) =>
        String(c[0]).includes("MULTI-TENANT"),
      ),
    ).toBe(true);
    mockExit.mockRestore();
    mockErr.mockRestore();
  });

  it("proceeds when --i-understand-multi-tenant is given with multi-tenant config", async () => {
    // Two distinct hosts but ack flag provided.
    (readProfileRegistry as ReturnType<typeof vi.fn>).mockResolvedValue(["tenant-a"]);
    (readFromKeychain as ReturnType<typeof vi.fn>).mockResolvedValue({
      url: "https://tenant-a.atlassian.net",
      email: "a@a.com",
      apiToken: "x",
    });

    (getPage as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockPage("p1", "Page One", CLEAN_BODY),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runFixLegacyLinks([
      "--client-label", "test",
      "--page-ids", "p1",
      "--i-understand-multi-tenant",
    ]);

    logSpy.mockRestore();
    // Did not exit — test just completing is the assertion.
  });
});

describe("runFixLegacyLinks — dry run", () => {
  it("reports affected pages without calling safeSubmitPage", async () => {
    (getPage as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockPage("p1", "Legacy Page", LEGACY_BODY),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runFixLegacyLinks(["--client-label", "bot", "--page-ids", "p1"]);

    // safeSubmitPage must NOT be called in dry-run mode.
    expect(safeSubmitPage).not.toHaveBeenCalled();
    expect(safePrepareBody).not.toHaveBeenCalled();

    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("DRY RUN");
    expect(output).toContain("1 legacy link");
    expect(output).toContain("p1");
    logSpy.mockRestore();
  });

  it("skips pages with no legacy links and reports correctly", async () => {
    (getPage as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockPage("p2", "Clean Page", CLEAN_BODY),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runFixLegacyLinks(["--client-label", "bot", "--page-ids", "p2"]);

    expect(safeSubmitPage).not.toHaveBeenCalled();
    const output = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    // Skipped pages show up under "No legacy links" count.
    expect(output).toContain("No legacy links");
    logSpy.mockRestore();
  });
});

describe("runFixLegacyLinks — apply mode", () => {
  it("calls safePrepareBody and safeSubmitPage for a page with legacy links", async () => {
    (getPage as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockPage("p1", "Legacy Page", LEGACY_BODY),
    );
    (safeSubmitPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: { id: "p1", title: "Legacy Page", version: { number: 6 } },
      newVersion: 6,
      oldLen: LEGACY_BODY.length,
      newLen: 100,
      deletedTokens: [],
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runFixLegacyLinks([
      "--client-label", "migration-bot",
      "--page-ids", "p1",
      "--apply",
    ]);

    expect(safePrepareBody).toHaveBeenCalledTimes(1);
    const prepareArgs = (safePrepareBody as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(prepareArgs.scope).toBe("full");
    expect(prepareArgs.replaceBody).toBe(false);
    // The prepared body must not contain the legacy ac:link shape.
    expect(prepareArgs.body).not.toContain("ac:plain-text-link-body");

    expect(safeSubmitPage).toHaveBeenCalledTimes(1);
    const submitArgs = (safeSubmitPage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(submitArgs.pageId).toBe("p1");
    expect(submitArgs.version).toBe(5);
    expect(submitArgs.clientLabel).toBe("migration-bot");
    expect(submitArgs.versionMessage).toContain("D1 migration");
    expect(submitArgs.versionMessage).toContain("migration-bot");
    expect(submitArgs.operation).toBe("update_page");

    logSpy.mockRestore();
  });

  it("accumulates per-page errors and exits 2 at the end", async () => {
    (getPage as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(mockPage("p1", "Good Page", LEGACY_BODY))
      .mockResolvedValueOnce(mockPage("p2", "Bad Page", LEGACY_BODY));

    // First page succeeds, second page fails.
    (safePrepareBody as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        finalStorage: "<p>fixed</p>",
        versionMessage: "",
        deletedTokens: [],
      })
      .mockRejectedValueOnce(new Error("boom from prepare"));

    (safeSubmitPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: { id: "p1", title: "Good Page", version: { number: 6 } },
      newVersion: 6,
      oldLen: 10,
      newLen: 8,
      deletedTokens: [],
    });

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit:2");
    }) as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      runFixLegacyLinks([
        "--client-label", "bot",
        "--page-ids", "p1,p2",
        "--apply",
      ]),
    ).rejects.toThrow("process.exit:2");

    // p1 was attempted and succeeded (1 submit call).
    expect(safeSubmitPage).toHaveBeenCalledTimes(1);
    // Summary shows the error.
    const errOutput = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(errOutput).toContain("[ERR]");

    logSpy.mockRestore();
    errSpy.mockRestore();
    mockExit.mockRestore();
  });

  it("uses --space-key to collect pages and processes them", async () => {
    (listPages as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "s1", title: "Space Page 1", version: { number: 1 } },
    ]);
    (getPage as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockPage("s1", "Space Page 1", LEGACY_BODY, 1),
    );
    (safeSubmitPage as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: { id: "s1", title: "Space Page 1", version: { number: 2 } },
      newVersion: 2,
      oldLen: LEGACY_BODY.length,
      newLen: 80,
      deletedTokens: [],
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runFixLegacyLinks([
      "--client-label", "bot",
      "--space-key", "MYSPACE",
      "--apply",
    ]);

    expect(resolveSpaceId).toHaveBeenCalledWith("MYSPACE");
    expect(listPages).toHaveBeenCalled();
    expect(getPage).toHaveBeenCalledWith("s1", true);
    expect(safeSubmitPage).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });
});
