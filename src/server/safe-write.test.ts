/**
 * Tests for the centralised write-safety pipeline (safePrepareBody +
 * safeSubmitPage). See plans/centralized-write-safety.md for the design.
 *
 * Structure:
 *   - Section A: table-driven permutation suite for safePrepareBody. Every
 *     opt-out flag gets at least one "fired" row and one "skipped" row.
 *     Adding a new flag REQUIRES adding a new row — forgetting to wire the
 *     flag surfaces as a test miss. This is the regression net for "guard
 *     silently skipped" across all future changes.
 *   - Section B: duplicate-title error byte-identity test (safeSubmitPage).
 *   - Section C: mutation-log shape tests (success + failure paths).
 *   - Section D: deletedTokens round-trip (fingerprint format documented in
 *     safe-write.ts).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Env vars must be set before confluence-client imports getConfig.
vi.hoisted(() => {
  process.env.CONFLUENCE_URL = "https://test.atlassian.net";
  process.env.CONFLUENCE_EMAIL = "user@test.com";
  process.env.CONFLUENCE_API_TOKEN = "test-token";
});

vi.mock("../shared/keychain.js", () => ({
  readFromKeychain: vi.fn().mockResolvedValue(null),
  PROFILE_NAME_RE: /^[a-z0-9][a-z0-9-]{0,62}$/,
}));

// Mock the confluence-client for safeSubmitPage tests. We keep the real
// module's extractSection/looksLikeMarkdown/etc by re-exporting them via
// importOriginal, then overriding only the HTTP-touching functions.
vi.mock("./confluence-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./confluence-client.js")>();
  return {
    ...actual,
    getPageByTitle: vi.fn(),
    createPage: vi.fn(),
    updatePage: vi.fn(),
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
  };
});

// Mock the mutation log — the module attaches to a file descriptor on
// init; we intercept logMutation / errorRecord calls for assertion.
vi.mock("./mutation-log.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./mutation-log.js")>();
  return {
    ...actual,
    logMutation: vi.fn(),
    errorRecord: vi.fn(actual.errorRecord),
  };
});

import {
  safePrepareBody,
  safeSubmitPage,
  type SafePrepareBodyInput,
  type DeletedToken,
  DELETION_ACK_MISMATCH,
  POST_TRANSFORM_BODY_REJECTED,
  READ_ONLY_MARKDOWN_ROUND_TRIP,
} from "./safe-write.js";
import {
  getPageByTitle,
  createPage,
  updatePage,
} from "./confluence-client.js";
import { logMutation, errorRecord } from "./mutation-log.js";
import { ConverterError } from "./converter/types.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** A structured-macro (info). */
const MACRO_INFO =
  `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>I</p></ac:rich-text-body></ac:structured-macro>`;
/** A drawio macro with a diagram display name — used for fingerprinting. */
const MACRO_DRAWIO =
  `<ac:structured-macro ac:name="drawio" ac:macro-id="d-1">` +
  `<ac:parameter ac:name="diagramDisplayName">architecture.drawio</ac:parameter>` +
  `<ac:parameter ac:name="diagramName">architecture.drawio</ac:parameter>` +
  `</ac:structured-macro>`;
/** Substantial original body so the shrinkage guard can fire. */
const BIG_STORAGE_BODY = `<p>${"x".repeat(1500)}</p>`;

// ---------------------------------------------------------------------------
// Section A: Table-driven permutation suite for safePrepareBody
// ---------------------------------------------------------------------------

type Outcome =
  | { kind: "success"; finalStorageContains?: RegExp; deletedIds?: string[] }
  | { kind: "error"; code: string; messageContains?: RegExp };

/**
 * Observable guard signatures:
 *   - "readOnlyMarkdown": read-only-markdown rejection fired iff error code
 *     READ_ONLY_MARKDOWN_ROUND_TRIP is thrown.
 *   - "shrinkage": shrinkage guard fired iff SHRINKAGE_NOT_CONFIRMED.
 *   - "structureLoss": STRUCTURE_LOSS_NOT_CONFIRMED.
 *   - "emptyBody": EMPTY_BODY_REJECTED.
 *   - "macroLoss": MACRO_LOSS_NOT_CONFIRMED.
 *   - "tableLoss": TABLE_LOSS_NOT_CONFIRMED.
 *   - "deletions": DELETIONS_NOT_CONFIRMED (planUpdate's) OR
 *     DELETION_ACK_MISMATCH (our itemised check).
 *   - "rawHtml": markdown-it's html:true doesn't refuse raw HTML; when
 *     allowRawHtml is set, raw HTML passes through to finalStorage.
 *   - "postTransform": POST_TRANSFORM_BODY_REJECTED.
 *
 * The table below asserts outcomes (error code or success + structural
 * properties). Guard-granularity is assertable via the error code alone
 * because each guard has a unique code.
 */
interface Row {
  name: string;
  input: Partial<SafePrepareBodyInput> & { body: string };
  outcome: Outcome;
}

const cases: Row[] = [
  // --- Default path — all guards armed, no opt-outs. ---
  {
    name: "default: plain markdown over empty currentBody → success (no guards fire)",
    input: { body: "A simple paragraph.", currentBody: undefined },
    outcome: {
      kind: "success",
      finalStorageContains: /<p>A simple paragraph\.<\/p>/,
    },
  },
  {
    name: "default: storage pass-through → success",
    input: {
      body: `<p>Some storage content with ${"x".repeat(100)}</p>`,
      currentBody: undefined,
    },
    outcome: { kind: "success" },
  },
  // --- Read-only markdown hard-reject (no opt-out). ---
  {
    name: "read-only-markdown marker rejected",
    input: {
      body: "<!-- epimethian:read-only-markdown -->\n# Heading",
      currentBody: undefined,
    },
    outcome: { kind: "error", code: READ_ONLY_MARKDOWN_ROUND_TRIP },
  },
  {
    name: "read-only-markdown rejected even with allowRawHtml set",
    input: {
      body: "<!-- epimethian:read-only-markdown -->\nBody",
      currentBody: undefined,
      allowRawHtml: true,
    },
    outcome: { kind: "error", code: READ_ONLY_MARKDOWN_ROUND_TRIP },
  },
  {
    name: "read-only-markdown rejected even with replaceBody set",
    input: {
      body: "<!-- epimethian:read-only-markdown -->\nBody",
      currentBody: BIG_STORAGE_BODY,
      replaceBody: true,
    },
    outcome: { kind: "error", code: READ_ONLY_MARKDOWN_ROUND_TRIP },
  },
  // --- Shrinkage guard fired / skipped. ---
  {
    name: "shrinkage guard fires on >50% reduction",
    input: { body: "<p>tiny</p>", currentBody: BIG_STORAGE_BODY },
    outcome: { kind: "error", code: "SHRINKAGE_NOT_CONFIRMED" },
  },
  {
    name: "shrinkage guard skipped when confirmShrinkage: true",
    input: {
      body: `<p>${"y".repeat(200)}</p>`,
      currentBody: BIG_STORAGE_BODY,
      confirmShrinkage: true,
    },
    outcome: { kind: "success" },
  },
  // --- Structure loss guard fired / skipped. ---
  {
    name: "structure loss guard fires on >50% heading drop",
    input: {
      body: `<h1>Only one</h1><p>${"y".repeat(1500)}</p>`,
      currentBody: `<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><p>${"x".repeat(1500)}</p>`,
    },
    outcome: { kind: "error", code: "STRUCTURE_LOSS_NOT_CONFIRMED" },
  },
  {
    name: "structure loss guard skipped when confirmStructureLoss: true",
    input: {
      body: `<h1>Only one</h1><p>${"y".repeat(1500)}</p>`,
      currentBody: `<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><p>${"x".repeat(1500)}</p>`,
      confirmStructureLoss: true,
    },
    outcome: { kind: "success" },
  },
  // --- Empty-body / post-transform guards fired (no opt-out). ---
  {
    name: "post-transform guard fires on empty body when no currentBody (create path)",
    input: {
      // No currentBody → enforceContentSafetyGuards is skipped; empty
      // markdown reaches the post-transform guard as the sole check.
      body: "   ",
      currentBody: undefined,
    },
    outcome: { kind: "error", code: "POST_TRANSFORM_BODY_REJECTED" },
  },
  {
    name: "content-safety empty-body guard fires on tag-heavy near-empty output",
    input: {
      // Tag-heavy input with almost no text content. Raw-length is high
      // enough not to trip shrinkage (40% of original), but text length is
      // <3 chars so the content-safety empty-body rule (old >100 chars +
      // new text <3 chars) fires. confirmShrinkage ensures the shrinkage
      // guard is out of the way.
      body: `<p><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/><br/></p>`,
      currentBody: BIG_STORAGE_BODY,
      confirmShrinkage: true,
    },
    outcome: { kind: "error", code: "EMPTY_BODY_REJECTED" },
  },
  // --- replaceBody: bypasses token-deletion AND structure-loss, but NOT
  //     shrinkage / empty / macro-loss. ---
  {
    name: "replaceBody skips structure-loss but still enforces shrinkage",
    input: {
      body: "<p>tiny</p>",
      currentBody: `<h1>A</h1><h2>B</h2><h3>C</h3><p>${"x".repeat(2000)}</p>`,
      replaceBody: true,
    },
    outcome: { kind: "error", code: "SHRINKAGE_NOT_CONFIRMED" },
  },
  {
    name: "replaceBody + confirmShrinkage skips structure-loss too",
    input: {
      body: `<p>${"y".repeat(200)}</p>`,
      currentBody: `<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><p>${"x".repeat(2000)}</p>`,
      replaceBody: true,
      confirmShrinkage: true,
    },
    outcome: { kind: "success" },
  },
  // --- Macro-loss guard fired / skipped. ---
  {
    name: "macro-loss guard fires when all macros removed (default)",
    input: {
      // Similar length so the shrinkage guard doesn't trigger first.
      body: `<p>${"y".repeat(1500)}</p>`,
      currentBody: `${MACRO_INFO}<p>${"x".repeat(1500)}</p>`,
    },
    outcome: { kind: "error", code: "MACRO_LOSS_NOT_CONFIRMED" },
  },
  {
    name: "macro-loss guard skipped when confirmDeletions: true (via planUpdate code-macro rescue path)",
    // An isolated inline macro (no <ac:> in current) forces the plain
    // markdownToStorage path, which doesn't produce macros. With
    // confirmDeletions: true the bypass applies to macro-loss.
    input: {
      body: `<p>${"y".repeat(1500)}</p>`,
      currentBody: `${MACRO_INFO}<p>${"x".repeat(1500)}</p>`,
      confirmDeletions: true,
    },
    outcome: { kind: "success" },
  },
  // --- scope: "additive" — token diff skipped; guards run in submit, not here. ---
  {
    name: "additive scope: skips token diff (would otherwise error)",
    input: {
      body: "New paragraph at the end.",
      currentBody: MACRO_INFO,
      scope: "additive",
    },
    outcome: {
      kind: "success",
      finalStorageContains: /<p>New paragraph at the end\.<\/p>/,
    },
  },
  {
    name: "additive scope: storage body passes through unchanged",
    input: {
      body: "<p>A raw paragraph</p>",
      currentBody: MACRO_INFO,
      scope: "additive",
    },
    outcome: { kind: "success" },
  },
  // --- confirmDeletions — itemised, matching set. ---
  {
    name: "itemised confirmDeletions matching actual set → success",
    input: {
      body: "# New content only",
      currentBody: `<h1>Old</h1>${MACRO_INFO}`,
      confirmDeletions: ["T0001"],
      // shrinkage avoided by keeping bodies comparable
      confirmShrinkage: true,
    },
    outcome: { kind: "success", deletedIds: ["T0001"] },
  },
  // --- confirmDeletions — itemised, mismatch. ---
  {
    name: "itemised confirmDeletions with mismatch lists actual IDs",
    input: {
      body: "# New content only",
      currentBody: `<h1>Old</h1>${MACRO_INFO}`,
      confirmDeletions: ["T9999"], // wrong ID
      confirmShrinkage: true,
    },
    outcome: {
      kind: "error",
      code: DELETION_ACK_MISMATCH,
      messageContains: /T0001/,
    },
  },
  // --- confirmDeletions: true — deprecation warning path. ---
  {
    name: "confirmDeletions: true accepts deletions but emits deprecation warning",
    input: {
      body: "# New content only",
      currentBody: `<h1>Old</h1>${MACRO_INFO}`,
      confirmDeletions: true,
      confirmShrinkage: true,
    },
    outcome: { kind: "success", deletedIds: ["T0001"] },
  },
  // --- allowRawHtml — lifts the raw-HTML tripwire. ---
  {
    name: "allowRawHtml: true permits raw HTML in markdown to pass through",
    input: {
      body: "<div class=\"raw\">Hello</div>\n\nMore text",
      currentBody: undefined,
      allowRawHtml: true,
    },
    outcome: {
      kind: "success",
      // The raw div passes through; without allowRawHtml markdown-it would
      // have HTML-escaped it (& → &amp;).
      finalStorageContains: /<div class="raw">Hello<\/div>/,
    },
  },
  // --- confluenceBaseUrl — optional; passed through to converter. ---
  {
    name: "confluenceBaseUrl unset is not an error",
    input: {
      body: "Paragraph with [a link](https://example.com).",
      currentBody: undefined,
    },
    outcome: { kind: "success" },
  },
];

describe("safePrepareBody — permutation suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const row of cases) {
    it(row.name, async () => {
      const call = () =>
        safePrepareBody({
          currentBody: undefined,
          ...row.input,
        });

      if (row.outcome.kind === "error") {
        let thrown: unknown;
        try {
          await call();
        } catch (e) {
          thrown = e;
        }
        expect(thrown, "expected an error").toBeDefined();
        expect((thrown as ConverterError).code).toBe(row.outcome.code);
        if (row.outcome.messageContains) {
          expect((thrown as Error).message).toMatch(
            row.outcome.messageContains,
          );
        }
      } else {
        const result = await call();
        if (row.outcome.finalStorageContains) {
          expect(result.finalStorage).toMatch(
            row.outcome.finalStorageContains,
          );
        }
        if (row.outcome.deletedIds) {
          expect(result.deletedTokens.map((t) => t.id).sort()).toEqual(
            row.outcome.deletedIds.slice().sort(),
          );
        }
      }
    });
  }

  // --- Out-of-band: capture the deprecation warning emitted by
  // confirmDeletions: true. We assert this separately because spying on
  // console.warn interacts with the table runner's setup. ---
  it("confirmDeletions: true logs a deprecation warning naming the token IDs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await safePrepareBody({
        body: "# New content only",
        currentBody: `<h1>Old</h1>${MACRO_INFO}`,
        confirmDeletions: true,
        confirmShrinkage: true,
      });
    } finally {
      // Restore after the call regardless of outcome.
    }
    const messages = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(messages).toMatch(/confirm_deletions: true is deprecated/);
    expect(messages).toMatch(/v5\.5/);
    expect(messages).toMatch(/v5\.7/);
    expect(messages).toMatch(/\[T0001\]/);
    warn.mockRestore();
  });

  // --- Out-of-band: assert that the confirmDeletions: true warning does
  // NOT fire when there are no deletions (nothing to warn about). ---
  it("confirmDeletions: true does not warn when no tokens are actually deleted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await safePrepareBody({
      body: "Some new paragraph.",
      currentBody: undefined,
      confirmDeletions: true,
    });
    const messages = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(messages).not.toMatch(/confirm_deletions: true is deprecated/);
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Section B: Duplicate-title error byte-identity
// ---------------------------------------------------------------------------

describe("safeSubmitPage — duplicate-title create error", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Byte-identical to the current create_page handler error in
   * src/server/index.ts lines 430-437. If this string changes here or
   * there without coordination, migration A6 will be a user-visible
   * regression.
   */
  it("throws byte-identical duplicate-title error when create collides", async () => {
    (getPageByTitle as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "999",
      title: "ExistingTitle",
    });

    let thrown: Error | undefined;
    try {
      await safeSubmitPage({
        pageId: undefined,
        spaceId: "space-1",
        title: "ExistingTitle",
        finalStorage: "<p>body</p>",
        versionMessage: "",
        deletedTokens: [],
        clientLabel: undefined,
      });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    // Byte-identical copy of the string in index.ts:432-435 (the existing
    // create_page duplicate-title error).
    const expected =
      `A page titled "ExistingTitle" already exists in this space (page ID: 999). ` +
      `Creating another page with the same title would produce a confusing duplicate. ` +
      `If you intend to modify the existing page, call get_page with ID 999 first ` +
      `to review its current content before deciding whether to update it.`;
    expect(thrown!.message).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Section C: Mutation log shape
// ---------------------------------------------------------------------------

describe("safeSubmitPage — mutation log", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits a success record with the canonical shape (update)", async () => {
    const previousBody = "<p>before</p>";
    const finalStorage = "<p>after with more content to satisfy any thresholds.</p>";
    (updatePage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: {
        id: "123",
        title: "T",
        version: { number: 5 },
      },
      newVersion: 5,
    });

    const result = await safeSubmitPage({
      pageId: "123",
      title: "T",
      finalStorage,
      previousBody,
      version: 4,
      versionMessage: "updated section",
      deletedTokens: [],
      clientLabel: "claude-code",
    });

    expect(result.newVersion).toBe(5);
    expect(result.oldLen).toBe(previousBody.length);
    expect(result.newLen).toBe(finalStorage.length);

    expect(logMutation).toHaveBeenCalledTimes(1);
    const call = (logMutation as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(call).toEqual(
      expect.objectContaining({
        operation: "update_page",
        pageId: "123",
        oldVersion: 4,
        newVersion: 5,
        oldBodyLen: previousBody.length,
        newBodyLen: finalStorage.length,
        clientLabel: "claude-code",
      }),
    );
    // Timestamp is an ISO string, hashes are nonempty strings.
    expect(typeof call.timestamp).toBe("string");
    expect(new Date(call.timestamp).toString()).not.toBe("Invalid Date");
    expect(typeof call.oldBodyHash).toBe("string");
    expect(typeof call.newBodyHash).toBe("string");
    expect(call.oldBodyHash.length).toBeGreaterThan(0);
    expect(call.newBodyHash.length).toBeGreaterThan(0);
  });

  it("emits a success record for a create (operation: create_page, no oldVersion)", async () => {
    (getPageByTitle as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );
    (createPage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "456",
      title: "New",
      version: { number: 1 },
    });

    await safeSubmitPage({
      pageId: undefined,
      spaceId: "space-1",
      title: "New",
      finalStorage: "<p>body</p>",
      versionMessage: "",
      deletedTokens: [],
      clientLabel: undefined,
    });

    const call = (logMutation as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(call.operation).toBe("create_page");
    expect(call.pageId).toBe("456");
    expect(call.newVersion).toBe(1);
    expect(call.oldVersion).toBeUndefined();
    expect(call.oldBodyLen).toBeUndefined();
  });

  it("honours an explicit operation override (e.g. prepend_to_page)", async () => {
    (updatePage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: { id: "1", title: "T", version: { number: 2 } },
      newVersion: 2,
    });

    await safeSubmitPage({
      pageId: "1",
      title: "T",
      finalStorage: "<p>x</p>",
      previousBody: "<p>y</p>",
      version: 1,
      versionMessage: "",
      deletedTokens: [],
      clientLabel: undefined,
      operation: "prepend_to_page",
    });

    const call = (logMutation as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(call.operation).toBe("prepend_to_page");
  });

  it("emits an error record and rethrows when the API call throws", async () => {
    const apiErr = new Error("boom");
    (updatePage as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      apiErr,
    );

    let thrown: Error | undefined;
    try {
      await safeSubmitPage({
        pageId: "123",
        title: "T",
        finalStorage: "<p>body</p>",
        previousBody: "<p>old</p>",
        version: 1,
        versionMessage: "",
        deletedTokens: [],
        clientLabel: undefined,
      });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBe(apiErr); // rethrown verbatim
    expect(errorRecord).toHaveBeenCalledWith(
      "update_page",
      "123",
      apiErr,
      expect.objectContaining({ oldVersion: 1 }),
    );
    expect(logMutation).toHaveBeenCalledTimes(1);
  });

  it("post-submit body guard rejects a spliced-empty finalStorage", async () => {
    // Simulate handler-side splicing damage: previousBody is large,
    // finalStorage came back empty. The submit-side post-transform guard
    // catches this before the API call, INDEPENDENT of prepare's decision.
    let thrown: unknown;
    try {
      await safeSubmitPage({
        pageId: "123",
        title: "T",
        finalStorage: "", // empty — post-transform guard must fire
        previousBody: BIG_STORAGE_BODY,
        version: 1,
        versionMessage: "",
        deletedTokens: [],
        clientLabel: undefined,
      });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as ConverterError).code).toBe(POST_TRANSFORM_BODY_REJECTED);
    // API was not called.
    expect(updatePage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Section D: deletedTokens round-trip (fingerprint format)
// ---------------------------------------------------------------------------

describe("safePrepareBody — deletedTokens fingerprint format", () => {
  // The deletedTokens list is populated only when planUpdate runs (markdown
  // body + currentBody with <ac:> / <ri:> / <time> elements). For each
  // case, submit a markdown body that drops the existing macro token.
  it("fingerprints structured-macro by ac:name", async () => {
    // Current body has a panel macro + filler; caller's markdown drops the
    // macro and replaces with plain text.
    const current =
      `<ac:structured-macro ac:name="panel"><ac:rich-text-body><p>X</p></ac:rich-text-body></ac:structured-macro><p>${"x".repeat(2000)}</p>`;
    const markdownBody =
      `# Heading\n\nA paragraph replacing everything.\n\n` + "y".repeat(100);
    const result = await safePrepareBody({
      body: markdownBody,
      currentBody: current,
      confirmDeletions: true,
      confirmShrinkage: true,
      confirmStructureLoss: true,
    });
    expect(result.deletedTokens).toHaveLength(1);
    expect(result.deletedTokens[0].id).toBe("T0001");
    expect(result.deletedTokens[0].tag).toBe("ac:structured-macro");
    expect(result.deletedTokens[0].fingerprint).toBe("structured-macro[panel]");
  });

  it("fingerprints drawio macros by diagramDisplayName (filename)", async () => {
    const current = `${MACRO_DRAWIO}<p>${"x".repeat(2000)}</p>`;
    const markdownBody =
      `# Heading\n\nDropped the drawio.\n\n` + "y".repeat(100);
    const result = await safePrepareBody({
      body: markdownBody,
      currentBody: current,
      confirmDeletions: true,
      confirmShrinkage: true,
      confirmStructureLoss: true,
    });
    const t = result.deletedTokens.find(
      (d) => d.fingerprint.startsWith("drawio["),
    );
    expect(t).toBeDefined();
    expect(t!.fingerprint).toBe("drawio[architecture.drawio]");
    expect(t!.tag).toBe("ac:structured-macro");
  });

  it("fingerprints emoticons by ac:name", async () => {
    const current = `<p><ac:emoticon ac:name="smile"/></p><p>${"x".repeat(2000)}</p>`;
    const markdownBody =
      `# Heading\n\nNo more emoticon.\n\n` + "y".repeat(100);
    const result = await safePrepareBody({
      body: markdownBody,
      currentBody: current,
      confirmDeletions: true,
      confirmShrinkage: true,
      confirmStructureLoss: true,
    });
    const t = result.deletedTokens.find((d) => d.tag === "ac:emoticon");
    expect(t).toBeDefined();
    expect(t!.fingerprint).toBe("emoticon[smile]");
  });

  it("no deletions → deletedTokens is empty (no fingerprints invented)", async () => {
    const result = await safePrepareBody({
      body: "A new paragraph.",
      currentBody: undefined,
    });
    expect(result.deletedTokens).toEqual([]);
  });
});
