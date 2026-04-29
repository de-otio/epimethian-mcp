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
  // F4: disable the write budget in this test suite — many tests
  // exercise safeSubmitPage and would otherwise collectively exhaust
  // the default budget across the suite.
  process.env.EPIMETHIAN_WRITE_BUDGET_SESSION = "0";
  process.env.EPIMETHIAN_WRITE_BUDGET_HOURLY = "0";
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
    // `getPage` is kept as a vi.fn so the A1 short-circuit test can assert
    // it was NOT called (the short-circuit synthesises its response and
    // must not issue a metadata fetch).
    getPage: vi.fn(),
    getPageByTitle: vi.fn(),
    _rawCreatePage: vi.fn(),
    _rawUpdatePage: vi.fn(),
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
  emitDestructiveBanner,
  findReplaceInSection,
  MultiSectionError,
  safePrepareBody,
  safePrepareMultiSectionBody,
  safeSubmitPage,
  type SafePrepareBodyInput,
  type DeletedToken,
  type RegeneratedTokenPair,
  DELETION_ACK_MISMATCH,
  FIND_REPLACE_MATCH_FAILED,
  INPUT_BODY_TOO_LARGE,
  MAX_INPUT_BODY,
  MIXED_INPUT_DETECTED,
  MULTI_SECTION_FAILED,
  POST_TRANSFORM_BODY_REJECTED,
  READ_ONLY_MARKDOWN_ROUND_TRIP,
  WRITE_CONTAINS_UNTRUSTED_FENCE,
  maybeConsumeConfirmToken,
  formatSoftConfirmationResult,
} from "./safe-write.js";
import {
  canonicaliseToken,
  _resetOpaqueCounterForTests,
} from "./safe-write-canonicaliser.js";
import {
  getPage,
  getPageByTitle,
  _rawCreatePage,
  _rawUpdatePage,
} from "./confluence-client.js";
import { logMutation, errorRecord } from "./mutation-log.js";
import { ConverterError } from "./converter/types.js";
import {
  mintToken,
  validateToken,
  invalidateForPage,
  computeDiffHash,
  onValidate,
  _resetForTest,
} from "./confirmation-tokens.js";

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
  input: Partial<SafePrepareBodyInput> & { body: string | undefined };
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
  // --- Mixed-input hard-reject (no opt-out): the canonical case is an
  //     agent inlining <ac:structured-macro ac:name="toc"/> at the top of
  //     a markdown body. The format detector would treat the whole body
  //     as storage and Confluence would render the markdown as literal
  //     text. The error must teach the YAML-frontmatter / directive fix.
  {
    name: "mixed: inline TOC macro at top of markdown body rejected (the canonical agent error)",
    input: {
      body:
        `<ac:structured-macro ac:name="toc"></ac:structured-macro>\n\n` +
        `## Section one\n\n- bullet\n- bullet\n`,
      currentBody: undefined,
    },
    outcome: {
      kind: "error",
      code: MIXED_INPUT_DETECTED,
      messageContains: /toc:[\s\S]*maxLevel/,
    },
  },
  {
    name: "mixed: inline <ri: tag plus markdown headings rejected",
    input: {
      body: `<p>See <ri:page ri:content-title="Home"/></p>\n\n# Heading\n\nBody.`,
      currentBody: undefined,
    },
    outcome: { kind: "error", code: MIXED_INPUT_DETECTED },
  },
  {
    name: "mixed: rejection lists matched markdown patterns by name",
    input: {
      body:
        `<ac:structured-macro ac:name="info"></ac:structured-macro>\n\n` +
        `# Heading\n- list\n`,
      currentBody: undefined,
    },
    outcome: {
      kind: "error",
      code: MIXED_INPUT_DETECTED,
      messageContains: /ATX heading[\s\S]*unordered list/,
    },
  },
  {
    name: "mixed: not triggered when <ac:> appears only inside fenced code (markdown documenting storage)",
    input: {
      body:
        `# Documenting macros\n\n` +
        '```xml\n<ac:structured-macro ac:name="toc"/>\n```\n\n' +
        `Plain markdown body with no inline storage tags.`,
      currentBody: undefined,
    },
    outcome: { kind: "success" },
  },
  {
    name: "mixed: not triggered when <ac:> appears only inside CDATA (storage code-macro body)",
    input: {
      body:
        `<ac:structured-macro ac:name="code"><ac:plain-text-body>` +
        `<![CDATA[\n## python comment style\n- not a list\n]]>` +
        `</ac:plain-text-body></ac:structured-macro>`,
      currentBody: undefined,
    },
    outcome: { kind: "success" },
  },
  {
    name: "mixed: not triggered when <ac:> appears only inside ac:plain-text-body (storage code-macro body)",
    input: {
      body:
        `<ac:structured-macro ac:name="code"><ac:plain-text-body>\n` +
        `## comment\n- item\n` +
        `</ac:plain-text-body></ac:structured-macro>`,
      currentBody: undefined,
    },
    outcome: { kind: "success" },
  },
  {
    name: "mixed: pure storage with hash mid-line (legacy test) is NOT mixed",
    input: {
      body:
        `<ac:structured-macro ac:name="info"><p># not markdown</p></ac:structured-macro>`,
      currentBody: undefined,
    },
    outcome: { kind: "success" },
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
      currentBody: `<h1>A</h1><h2>B</h2><h3>C</h3><p>${"x".repeat(500)}</p>`,
      replaceBody: true,
    },
    outcome: { kind: "error", code: "SHRINKAGE_NOT_CONFIRMED" },
  },
  {
    name: "replaceBody + confirmShrinkage skips structure-loss too",
    input: {
      body: `<p>${"y".repeat(200)}</p>`,
      currentBody: `<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><p>${"x".repeat(500)}</p>`,
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
  // --- Gap 1 (A2.1): forgery detection when currentBody has no preserved tokens. ---
  // planUpdate doesn't run in this branch (no <ac:>/<ri:>/<time> in currentBody),
  // but the pipeline must still catch invented [[epi:T####]] IDs in caller markdown.
  {
    name: "forged token in caller markdown against tokenless currentBody is rejected",
    input: {
      body: "# Updated\n\n[[epi:T9999]]\n\nMore text.",
      currentBody: "<p>Simple page with no macros</p>",
    },
    outcome: {
      kind: "error",
      code: "INVENTED_TOKEN",
      messageContains: /T9999/,
    },
  },
  {
    name: "forged token in caller markdown against empty currentBody (create path) is rejected",
    input: {
      body: "# New\n\n[[epi:T0042]]\n\nBody text.",
      currentBody: undefined,
    },
    outcome: {
      kind: "error",
      code: "INVENTED_TOKEN",
      messageContains: /T0042/,
    },
  },
  {
    name: "forged token skipped when replaceBody: true (wholesale rewrite path)",
    input: {
      body: `# Updated\n\n[[epi:T9999]]\n\nMore text.\n\n${"y".repeat(200)}`,
      currentBody: `<p>Simple page with no macros ${"x".repeat(1500)}</p>`,
      replaceBody: true,
      confirmShrinkage: true,
    },
    // No throw — the literal `[[epi:T####]]` passes through as text into
    // the stored body, which is consistent with replaceBody's stated
    // "discard token semantics" contract in planUpdate.
    outcome: { kind: "success", finalStorageContains: /\[\[epi:T9999\]\]/ },
  },
  {
    name: "non-forged markdown against tokenless currentBody still succeeds",
    input: {
      body: "# Updated\n\nA plain paragraph, no tokens.",
      currentBody: "<p>Simple page with no macros</p>",
    },
    outcome: { kind: "success", finalStorageContains: /<h1/ },
  },
  // --- Gap 2 (A2.1): title-only updates (body === undefined). ---
  {
    name: "title-only update: body undefined on update returns finalStorage undefined",
    input: {
      body: undefined,
      currentBody: "<p>Existing body with content</p>",
    },
    outcome: { kind: "success" },
  },
  {
    name: "title-only update: body undefined errors for create (currentBody undefined)",
    input: {
      body: undefined,
      currentBody: undefined,
    },
    outcome: {
      kind: "error",
      code: "MISSING_BODY_FOR_CREATE",
    },
  },
  // --- Content floor guard (1F) — no opt-out, security audit Finding 3. ---
  // The floor is the last line of defence against prompt-injection chains
  // that talk an agent into setting every confirm_* flag. These rows prove
  // the floor fires regardless of confirm_shrinkage / confirm_structure_loss
  // / confirmDeletions / replaceBody combinations.
  {
    name: "floor guard fires with confirmShrinkage + confirmStructureLoss set",
    input: {
      body: "<h1>Hello world</h1>", // ~20 chars, 11 visible — survives 1C
      currentBody: `<h1>Old</h1><p>${"x".repeat(1500)}</p>`,
      confirmShrinkage: true,
      confirmStructureLoss: true,
    },
    outcome: { kind: "error", code: "CONTENT_FLOOR_BREACHED" },
  },
  {
    name: "floor guard fires with every confirm flag set (the injection attack)",
    input: {
      body: "<h1>Hello world</h1>",
      currentBody: `<h1>Old</h1>${MACRO_INFO}<p>${"x".repeat(1500)}</p>`,
      confirmShrinkage: true,
      confirmStructureLoss: true,
      confirmDeletions: true,
    },
    outcome: { kind: "error", code: "CONTENT_FLOOR_BREACHED" },
  },
  {
    name: "floor guard fires with replaceBody + confirmShrinkage too",
    input: {
      body: "<h1>Hello world</h1>",
      currentBody: `<h1>A</h1><h2>B</h2><p>${"x".repeat(1500)}</p>`,
      replaceBody: true,
      confirmShrinkage: true,
    },
    outcome: { kind: "error", code: "CONTENT_FLOOR_BREACHED" },
  },
  {
    name: "floor guard does NOT fire on legitimate moderate rewrites with confirms",
    input: {
      body: `<p>${"replaced content here. ".repeat(20)}</p>`, // ~460 chars
      currentBody: `<h1>Old</h1><p>${"x".repeat(2000)}</p>`,
      confirmShrinkage: true,
      confirmStructureLoss: true,
    },
    outcome: { kind: "success" },
  },
  {
    name: "floor guard does NOT pre-empt 1A's actionable error when no confirms set",
    // Ordering: 1A (gated) fires first; 1F runs last as backstop.
    input: {
      body: "<p>tiny</p>",
      currentBody: `<p>${"x".repeat(1500)}</p>`,
    },
    outcome: { kind: "error", code: "SHRINKAGE_NOT_CONFIRMED" },
  },
  {
    name: "pre-existing 1C empty-body guard still fires when text drops <3 chars",
    input: {
      // Structure unchanged, but body wiped to empty tags. 1C fires because
      // oldLen>100 and newText<3. Floor guard would also fire, but 1C runs
      // earlier in the ordering.
      body: "<p></p><p></p>",
      currentBody: `<p>${"x".repeat(500)}</p>`,
      confirmShrinkage: true,
    },
    outcome: { kind: "error", code: "EMPTY_BODY_REJECTED" },
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

  // --- Gap 2: title-only update returns finalStorage: undefined (whole
  // pipeline short-circuited; all guards are no-ops). ---
  it("title-only update: body undefined returns finalStorage undefined with no guards", async () => {
    const result = await safePrepareBody({
      body: undefined,
      currentBody: "<p>Existing body that would trip shrinkage etc. if a guard fired.</p>",
    });
    expect(result.finalStorage).toBeUndefined();
    expect(result.versionMessage).toBe("");
    expect(result.deletedTokens).toEqual([]);
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
    (_rawUpdatePage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
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
    (_rawCreatePage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
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
    (_rawUpdatePage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
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
    (_rawUpdatePage as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
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

  // --- Gap 2: title-only updates (finalStorage: undefined) flow through
  // safeSubmitPage without a body field and with newBody* fields omitted
  // from the mutation log. ---
  it("title-only update: submits without body field and omits newBody* in mutation log", async () => {
    (_rawUpdatePage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: { id: "77", title: "New Title", version: { number: 3 } },
      newVersion: 3,
    });

    const previousBody = "<p>current body, unchanged</p>";
    const result = await safeSubmitPage({
      pageId: "77",
      title: "New Title",
      finalStorage: undefined, // title-only
      previousBody,
      version: 2,
      versionMessage: "",
      deletedTokens: [],
      clientLabel: "claude-code",
    });

    // The HTTP wrapper was called with body undefined (title-only).
    const updateCall = (_rawUpdatePage as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(updateCall[0]).toBe("77");
    expect(updateCall[1].body).toBeUndefined();
    expect(updateCall[1].title).toBe("New Title");

    // Mutation log omits newBody*; carries oldBody* (the body we didn't write).
    const record = (logMutation as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(record.operation).toBe("update_page");
    expect(record.pageId).toBe("77");
    expect(record.oldVersion).toBe(2);
    expect(record.oldBodyLen).toBe(previousBody.length);
    expect(record.oldBodyHash).toBeDefined();
    expect(record.newBodyLen).toBeUndefined();
    expect(record.newBodyHash).toBeUndefined();

    // Output newLen is 0 (nothing was written).
    expect(result.newLen).toBe(0);
    expect(result.oldLen).toBe(previousBody.length);
  });

  it("create with finalStorage undefined errors (title-only creates are invalid)", async () => {
    let thrown: Error | undefined;
    try {
      await safeSubmitPage({
        pageId: undefined, // create
        spaceId: "space-1",
        title: "Whatever",
        finalStorage: undefined,
        versionMessage: "",
        deletedTokens: [],
        clientLabel: undefined,
      });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toMatch(/finalStorage is required when creating/);
    expect(_rawCreatePage).not.toHaveBeenCalled();
  });

  // --- Gap 3: replaceBody forensic pass-through to the mutation log. ---
  it("replaceBody: true is threaded into the success MutationRecord", async () => {
    (_rawUpdatePage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: { id: "42", title: "T", version: { number: 2 } },
      newVersion: 2,
    });

    await safeSubmitPage({
      pageId: "42",
      title: "T",
      finalStorage: "<p>wholesale rewrite</p>",
      previousBody: "<p>old content</p>",
      version: 1,
      versionMessage: "",
      deletedTokens: [],
      clientLabel: undefined,
      replaceBody: true,
    });

    const record = (logMutation as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(record.replaceBody).toBe(true);
    expect(record.operation).toBe("update_page");
  });

  it("replaceBody unset or false is NOT present in the MutationRecord", async () => {
    (_rawUpdatePage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: { id: "42", title: "T", version: { number: 2 } },
      newVersion: 2,
    });

    await safeSubmitPage({
      pageId: "42",
      title: "T",
      finalStorage: "<p>normal update</p>",
      previousBody: "<p>old content</p>",
      version: 1,
      versionMessage: "",
      deletedTokens: [],
      clientLabel: undefined,
      // replaceBody not set
    });

    const record = (logMutation as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(record.replaceBody).toBeUndefined();
  });

  it("replaceBody: true is threaded into the failure MutationRecord too", async () => {
    const apiErr = new Error("boom");
    (_rawUpdatePage as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      apiErr,
    );

    let thrown: unknown;
    try {
      await safeSubmitPage({
        pageId: "42",
        title: "T",
        finalStorage: "<p>wholesale rewrite</p>",
        previousBody: "<p>old content</p>",
        version: 1,
        versionMessage: "",
        deletedTokens: [],
        clientLabel: undefined,
        replaceBody: true,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(apiErr);
    expect(errorRecord).toHaveBeenCalledWith(
      "update_page",
      "42",
      apiErr,
      expect.objectContaining({ oldVersion: 1, replaceBody: true }),
    );
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
    expect(_rawUpdatePage).not.toHaveBeenCalled();
  });

  it("assertGrowth accepts finalStorage larger than previousBody (happy path)", async () => {
    (_rawUpdatePage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: { id: "99", title: "T", version: { number: 4 } },
      newVersion: 4,
    });

    const prev = "<p>existing</p>";
    const next = "<p>existing</p>\n\n<p>appended</p>";

    const result = await safeSubmitPage({
      pageId: "99",
      title: "T",
      finalStorage: next,
      previousBody: prev,
      version: 3,
      versionMessage: "",
      deletedTokens: [],
      clientLabel: undefined,
      operation: "append_to_page",
      assertGrowth: true,
    });

    expect(result.newVersion).toBe(4);
    expect(_rawUpdatePage).toHaveBeenCalled();
  });

  it("assertGrowth rejects finalStorage smaller than previousBody (handler forgot to concat)", async () => {
    // Simulates the handler bug where scope:"additive" prepare returned a
    // small delta and the handler submitted the delta alone instead of
    // concatenating it onto previousBody. assertGrowth catches this before
    // the API call, so the page is never overwritten.
    const prev = `<p>${"x".repeat(500)}</p>`;
    const deltaOnly = "<p>new line</p>"; // dramatically smaller — bug case

    let thrown: unknown;
    try {
      await safeSubmitPage({
        pageId: "99",
        title: "T",
        finalStorage: deltaOnly,
        previousBody: prev,
        version: 3,
        versionMessage: "",
        deletedTokens: [],
        clientLabel: undefined,
        operation: "append_to_page",
        assertGrowth: true,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/Additive-scope invariant violated/);
    expect((thrown as Error).message).toMatch(/forgot to concatenate/);
    expect(_rawUpdatePage).not.toHaveBeenCalled();
  });

  it("assertGrowth is a no-op when flag is unset", async () => {
    // Without the flag, submit does not enforce growth — some non-additive
    // flows legitimately shrink (e.g. replaceBody, revert_page).
    (_rawUpdatePage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: { id: "99", title: "T", version: { number: 4 } },
      newVersion: 4,
    });

    // previousBody > finalStorage but within the post-transform >90% limit
    const prev = `<p>${"x".repeat(500)}</p>`;
    const next = `<p>${"x".repeat(100)}</p>`;

    const result = await safeSubmitPage({
      pageId: "99",
      title: "T",
      finalStorage: next,
      previousBody: prev,
      version: 3,
      versionMessage: "",
      deletedTokens: [],
      clientLabel: undefined,
      // assertGrowth deliberately omitted
    });

    expect(result.newVersion).toBe(4);
    expect(_rawUpdatePage).toHaveBeenCalled();
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
      `<ac:structured-macro ac:name="panel"><ac:rich-text-body><p>X</p></ac:rich-text-body></ac:structured-macro><p>${"x".repeat(500)}</p>`;
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
    const current = `${MACRO_DRAWIO}<p>${"x".repeat(500)}</p>`;
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
    const current = `<p><ac:emoticon ac:name="smile"/></p><p>${"x".repeat(500)}</p>`;
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

// ---------------------------------------------------------------------------
// Section E: A1 — byte-identical update short-circuit
// ---------------------------------------------------------------------------

describe("safeSubmitPage — byte-identical short-circuit (A1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not call _rawUpdatePage when body is byte-identical to previousBody", async () => {
    const body = "<p>Unchanged content</p>";

    const result = await safeSubmitPage({
      pageId: "42",
      title: "Some Page",
      finalStorage: body,
      previousBody: body,
      version: 7,
      versionMessage: "",
      deletedTokens: [],
      clientLabel: undefined,
    });

    expect(_rawUpdatePage).not.toHaveBeenCalled();
    // A1 synthesises the response — it does not re-fetch.
    expect(getPage).not.toHaveBeenCalled();
    expect(result.newVersion).toBe(7);
    expect(result.page.id).toBe("42");
    expect(result.page.title).toBe("Some Page");
    expect(result.oldLen).toBe(body.length);
    expect(result.newLen).toBe(body.length);
    // Mutation log is not written for no-ops — there is nothing to record.
    expect(logMutation).not.toHaveBeenCalled();
  });

  it("still writes when body differs by a single character", async () => {
    const prev = "<p>Unchanged content</p>";
    const next = "<p>Unchanged content.</p>"; // added a period
    (_rawUpdatePage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: { id: "42", title: "Some Page", version: { number: 8 } },
      newVersion: 8,
    });

    await safeSubmitPage({
      pageId: "42",
      title: "Some Page",
      finalStorage: next,
      previousBody: prev,
      version: 7,
      versionMessage: "",
      deletedTokens: [],
      clientLabel: undefined,
    });

    expect(_rawUpdatePage).toHaveBeenCalledOnce();
  });

  it("treats attribution-footer-only delta as no-op (normalisation parity)", async () => {
    // previousBody carries a legacy attribution footer; finalStorage is the
    // same body without it. Post-normalisation they are identical.
    const clean = "<p>Some content</p>";
    const withFooter =
      clean +
      `<p>Edited by <a href="https://github.com/de-otio/epimethian-mcp"><em>Epimethian</em></a></p>`;

    await safeSubmitPage({
      pageId: "42",
      title: "Some Page",
      finalStorage: clean,
      previousBody: withFooter,
      version: 7,
      versionMessage: "",
      deletedTokens: [],
      clientLabel: undefined,
    });

    expect(_rawUpdatePage).not.toHaveBeenCalled();
  });

  it("D3: rejects write body that contains the open-fence marker", async () => {
    const body =
      "<p>Some content</p>\n<<<CONFLUENCE_UNTRUSTED pageId=42 field=body>>>\n";
    await expect(
      safePrepareBody({ body, currentBody: "<p>anything</p>" }),
    ).rejects.toMatchObject({ code: WRITE_CONTAINS_UNTRUSTED_FENCE });
  });

  it("D3: rejects write body that contains the close-fence marker", async () => {
    const body = "<p>body</p>\n<<<END_CONFLUENCE_UNTRUSTED>>>";
    await expect(
      safePrepareBody({ body, currentBody: "<p>anything</p>" }),
    ).rejects.toMatchObject({ code: WRITE_CONTAINS_UNTRUSTED_FENCE });
  });

  it("D3: rejects write body that contains the per-session canary", async () => {
    const { getSessionCanary } = await import("./session-canary.js");
    const canary = getSessionCanary();
    const body = `<p>seemingly-clean body</p><!-- canary:${canary} -->`;
    await expect(
      safePrepareBody({ body, currentBody: "<p>anything</p>" }),
    ).rejects.toMatchObject({ code: WRITE_CONTAINS_UNTRUSTED_FENCE });
  });

  it("D3: clean body passes through (no fence markers, no canary)", async () => {
    const body = "<p>this is a brand new body with no fence artefacts</p>";
    const result = await safePrepareBody({
      body,
      currentBody: "<p>anything</p>",
    });
    expect(result.finalStorage).toBeDefined();
  });

  it("A3: rejects input body exceeding MAX_INPUT_BODY with INPUT_BODY_TOO_LARGE", async () => {
    // Use a body shape that would be classified as storage (starts with `<`)
    // so the check hits MAX_INPUT_BODY before any converter-internal caps.
    const oversized = "<p>" + "x".repeat(MAX_INPUT_BODY) + "</p>";
    await expect(
      safePrepareBody({ body: oversized, currentBody: undefined }),
    ).rejects.toMatchObject({ code: INPUT_BODY_TOO_LARGE });
  });

  it("A3: accepts input body at or below MAX_INPUT_BODY", async () => {
    // Exactly at the cap; storage-format-shaped so the markdown converter's
    // stricter internal 1 MB cap doesn't apply to this path.
    const padded = "<p>" + "x".repeat(MAX_INPUT_BODY - 7) + "</p>";
    expect(padded.length).toBe(MAX_INPUT_BODY);
    const result = await safePrepareBody({
      body: padded,
      currentBody: undefined,
    });
    expect(result.finalStorage).toBeDefined();
  });

  it("C2: emits destructive banner on stderr when replace_body=true", async () => {
    (_rawUpdatePage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: { id: "42", title: "P", version: { number: 8 } },
      newVersion: 8,
    });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await safeSubmitPage({
        pageId: "42",
        title: "P",
        finalStorage: "<p>new body</p>",
        previousBody: "<p>old body</p>",
        version: 7,
        versionMessage: "",
        deletedTokens: [],
        clientLabel: "claude-code",
        replaceBody: true,
      });

      const lines = stderrSpy.mock.calls.map((c) => String(c[0]));
      const banner = lines.find((l) => l.includes("[DESTRUCTIVE]"));
      expect(banner).toBeDefined();
      expect(banner).toContain("tool=update_page");
      expect(banner).toContain("page=42");
      expect(banner).toContain("flags=replace_body");
      expect(banner).toContain("client=claude-code");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("C2: emits banner when both confirm_shrinkage and confirm_structure_loss are true", async () => {
    (_rawUpdatePage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: { id: "42", title: "P", version: { number: 8 } },
      newVersion: 8,
    });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await safeSubmitPage({
        pageId: "42",
        title: "P",
        finalStorage: "<p>different body</p>",
        previousBody: "<p>original body</p>",
        version: 7,
        versionMessage: "",
        deletedTokens: [],
        clientLabel: "cursor",
        confirmShrinkage: true,
        confirmStructureLoss: true,
      });

      const lines = stderrSpy.mock.calls.map((c) => String(c[0]));
      const banner = lines.find((l) => l.includes("[DESTRUCTIVE]"));
      expect(banner).toBeDefined();
      expect(banner).toContain("flags=confirm_shrinkage,confirm_structure_loss");
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("C2: does not emit banner on writes with no destructive flags", async () => {
    (_rawUpdatePage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: { id: "42", title: "P", version: { number: 8 } },
      newVersion: 8,
    });
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await safeSubmitPage({
        pageId: "42",
        title: "P",
        finalStorage: "<p>different body</p>",
        previousBody: "<p>original body</p>",
        version: 7,
        versionMessage: "",
        deletedTokens: [],
        clientLabel: undefined,
      });

      const lines = stderrSpy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("[DESTRUCTIVE]"))).toBe(false);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("C2: emitDestructiveBanner formatter includes all expected fields", () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      emitDestructiveBanner({
        operation: "revert_page",
        pageId: "17",
        flags: ["replace_body"],
        clientLabel: "mcp-inspector",
      });
      expect(stderrSpy).toHaveBeenCalledOnce();
      const line = String(stderrSpy.mock.calls[0][0]);
      expect(line).toBe(
        "epimethian-mcp: [DESTRUCTIVE] tool=revert_page page=17 flags=replace_body client=mcp-inspector",
      );
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("C2: emitDestructiveBanner is a no-op when flags is empty", () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      emitDestructiveBanner({
        operation: "update_page",
        pageId: "1",
        flags: [],
        clientLabel: "x",
      });
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("still writes on title-only updates (finalStorage undefined) — short-circuit does not apply", async () => {
    (_rawUpdatePage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: { id: "42", title: "New Title", version: { number: 8 } },
      newVersion: 8,
    });

    await safeSubmitPage({
      pageId: "42",
      title: "New Title",
      finalStorage: undefined,
      previousBody: "<p>body</p>",
      version: 7,
      versionMessage: "",
      deletedTokens: [],
      clientLabel: undefined,
    });

    expect(_rawUpdatePage).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Section F: C1 — byte-equivalent macro suppression
// ---------------------------------------------------------------------------
//
// Track C1 reframes the deletion-tracking pipeline to distinguish between
// *genuinely* deleted tokens and tokens whose deletion was paired with a
// freshly-emitted byte-equivalent regeneration. This whole feature lives
// behind the EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS env var for one
// release (6.3.0): the flag is OFF by default, so the existing
// confirm_deletions gate fires for every token-id deletion exactly as
// before. With the flag ON, deletions whose canonical key matches a
// freshly-emitted token are moved into `regeneratedTokens` and bypass the
// gate. Every suppression is recorded in the success-path mutation log so
// a postmortem can reconstruct what was bypassed.
//
// DATA-LOSS RISK MITIGATIONS verified by these tests:
//   1. The default rules are *strict*: any input the canonicaliser cannot
//      interpret returns a unique opaque key that never matches anything.
//   2. The feature flag must be explicitly set to "true" or "1"; an unset
//      / false / arbitrary value leaves the existing behaviour intact.
//   3. The audit-log entry on every suppressed pair carries enough info
//      (oldId, newId, kind) for an operator to replay the suppression.
// ---------------------------------------------------------------------------

describe("safe-write-canonicaliser — strict-by-default rules", () => {
  beforeEach(() => {
    _resetOpaqueCounterForTests();
  });

  it("equivalent ac:link with reordered attributes share a canonical key", () => {
    const a =
      `<ac:link ac:anchor="sec1">` +
      `<ri:page ri:space-key="ETD" ri:content-title="Home"/>` +
      `<ac:plain-text-link-body><![CDATA[Click]]></ac:plain-text-link-body>` +
      `</ac:link>`;
    // Same logical link with attributes flipped.
    const b =
      `<ac:link ac:anchor="sec1">` +
      `<ri:page ri:content-title="Home" ri:space-key="ETD"/>` +
      `<ac:plain-text-link-body><![CDATA[Click]]></ac:plain-text-link-body>` +
      `</ac:link>`;
    const ka = canonicaliseToken(a);
    const kb = canonicaliseToken(b);
    expect(ka.kind).toBe("ac:link");
    expect(kb.kind).toBe("ac:link");
    expect(ka.key).toBe(kb.key);
  });

  it("ac:links to different page targets get different keys", () => {
    const a =
      `<ac:link><ri:page ri:content-id="111"/>` +
      `<ac:plain-text-link-body><![CDATA[X]]></ac:plain-text-link-body>` +
      `</ac:link>`;
    const b =
      `<ac:link><ri:page ri:content-id="222"/>` +
      `<ac:plain-text-link-body><![CDATA[X]]></ac:plain-text-link-body>` +
      `</ac:link>`;
    expect(canonicaliseToken(a).key).not.toBe(canonicaliseToken(b).key);
  });

  it("ac:links with the same target but different display text get different keys", () => {
    const a =
      `<ac:link><ri:page ri:content-id="111"/>` +
      `<ac:plain-text-link-body><![CDATA[Click here]]></ac:plain-text-link-body>` +
      `</ac:link>`;
    const b =
      `<ac:link><ri:page ri:content-id="111"/>` +
      `<ac:plain-text-link-body><![CDATA[Read more]]></ac:plain-text-link-body>` +
      `</ac:link>`;
    expect(canonicaliseToken(a).key).not.toBe(canonicaliseToken(b).key);
  });

  it("ac:links with rich link-body fall through to opaque (strict default)", () => {
    // Rich body comparison is not implemented; equality is refused so the
    // gate fires. The two links are otherwise identical.
    const a =
      `<ac:link><ri:page ri:content-id="111"/>` +
      `<ac:link-body><strong>X</strong></ac:link-body>` +
      `</ac:link>`;
    const b =
      `<ac:link><ri:page ri:content-id="111"/>` +
      `<ac:link-body><strong>X</strong></ac:link-body>` +
      `</ac:link>`;
    const ka = canonicaliseToken(a);
    const kb = canonicaliseToken(b);
    expect(ka.kind).toBe("ac:link");
    expect(kb.kind).toBe("ac:link");
    // Two opaque sentinels never compare equal — strict-by-default.
    expect(ka.key).not.toBe(kb.key);
  });

  it("TOC macros with the same parameter set in different order share a key", () => {
    const a =
      `<ac:structured-macro ac:name="toc">` +
      `<ac:parameter ac:name="maxLevel">3</ac:parameter>` +
      `<ac:parameter ac:name="minLevel">1</ac:parameter>` +
      `</ac:structured-macro>`;
    const b =
      `<ac:structured-macro ac:name="toc">` +
      `<ac:parameter ac:name="minLevel">1</ac:parameter>` +
      `<ac:parameter ac:name="maxLevel">3</ac:parameter>` +
      `</ac:structured-macro>`;
    const ka = canonicaliseToken(a);
    const kb = canonicaliseToken(b);
    expect(ka.kind).toBe("ac:structured-macro:toc");
    expect(ka.key).toBe(kb.key);
  });

  it("TOC macro with maxLevel=3 vs maxLevel=4 get different keys", () => {
    const a =
      `<ac:structured-macro ac:name="toc">` +
      `<ac:parameter ac:name="maxLevel">3</ac:parameter>` +
      `</ac:structured-macro>`;
    const b =
      `<ac:structured-macro ac:name="toc">` +
      `<ac:parameter ac:name="maxLevel">4</ac:parameter>` +
      `</ac:structured-macro>`;
    expect(canonicaliseToken(a).key).not.toBe(canonicaliseToken(b).key);
  });

  it("generic structured-macro: name + sorted params + CDATA body equal → same key", () => {
    const a =
      `<ac:structured-macro ac:name="code">` +
      `<ac:parameter ac:name="language">ts</ac:parameter>` +
      `<ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body>` +
      `</ac:structured-macro>`;
    const b =
      `<ac:structured-macro ac:name="code">` +
      `<ac:plain-text-body><![CDATA[const x = 1;]]></ac:plain-text-body>` +
      `<ac:parameter ac:name="language">ts</ac:parameter>` +
      `</ac:structured-macro>`;
    expect(canonicaliseToken(a).key).toBe(canonicaliseToken(b).key);
  });

  it("structured-macro with rich-text-body falls through to opaque (strict)", () => {
    // Rich text bodies are NOT compared (they could contain anything);
    // the canonicaliser refuses to assert equivalence.
    const a =
      `<ac:structured-macro ac:name="info">` +
      `<ac:rich-text-body><p>I</p></ac:rich-text-body>` +
      `</ac:structured-macro>`;
    const b =
      `<ac:structured-macro ac:name="info">` +
      `<ac:rich-text-body><p>I</p></ac:rich-text-body>` +
      `</ac:structured-macro>`;
    expect(canonicaliseToken(a).key).not.toBe(canonicaliseToken(b).key);
  });

  it("plain ac:emoticon: byte-equal after attribute sort", () => {
    const a = `<ac:emoticon ac:name="smile" ac:emoji-id="1f600"/>`;
    const b = `<ac:emoticon ac:emoji-id="1f600" ac:name="smile"/>`;
    expect(canonicaliseToken(a).key).toBe(canonicaliseToken(b).key);
  });

  it("missing meaningful attribute → not equivalent", () => {
    const a = `<ac:emoticon ac:name="smile" ac:emoji-id="1f600"/>`;
    const b = `<ac:emoticon ac:name="smile"/>`;
    expect(canonicaliseToken(a).key).not.toBe(canonicaliseToken(b).key);
  });

  it("malformed XML → opaque (each call unique)", () => {
    // Empty / undefined / garbage all produce opaque sentinels that don't
    // compare equal.
    expect(canonicaliseToken(undefined).kind).toBe("opaque");
    expect(canonicaliseToken("").kind).toBe("opaque");
    const a = canonicaliseToken("not even xml");
    const b = canonicaliseToken("not even xml");
    expect(a.key).not.toBe(b.key);
  });
});

describe("safePrepareBody — C1 byte-equivalent suppression (feature-flag gated)", () => {
  // Toggle the env var per test rather than at module level; the helper
  // function reads process.env on every call so this works.
  let originalFlag: string | undefined;
  beforeEach(() => {
    originalFlag = process.env.EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS;
    vi.clearAllMocks();
  });
  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS;
    } else {
      process.env.EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS = originalFlag;
    }
  });

  /**
   * Build a stored-body fragment containing N <ac:link> macros pointing to
   * pages "Page-1" through "Page-N" in space "ETD".
   *
   * IMPORTANT: emit attributes in `content-title, space-key` order — the
   * markdown converter's canonical form for `confluence://SPACE/Title` is
   * the opposite (`space-key, content-title`). Forcing different attribute
   * orders between the stored XML and the converter output is what
   * exercises the canonicaliser; if both byte-strings were already
   * identical the test would pass trivially.
   */
  function buildStoredLinks(n: number): string {
    const parts: string[] = [];
    for (let i = 1; i <= n; i++) {
      parts.push(
        `<ac:link>` +
          `<ri:page ri:content-title="Page-${i}" ri:space-key="ETD"/>` +
          `<ac:plain-text-link-body><![CDATA[Page ${i}]]></ac:plain-text-link-body>` +
          `</ac:link>`,
      );
    }
    return `<p>${parts.join(" ")}</p>`;
  }

  /**
   * Build the markdown that would re-emit the same N `<ac:link>` macros
   * via the converter's confluence:// scheme handler. We pass the same
   * stored body as currentBody, so planUpdate sees N preserved tokens get
   * deleted (because the markdown contains no [[epi:T####]] references)
   * AND N freshly emitted ac:link macros in the converted output.
   */
  function buildLinksMarkdown(n: number): string {
    const lines: string[] = [];
    for (let i = 1; i <= n; i++) {
      lines.push(`- [Page ${i}](confluence://ETD/Page-${i})`);
    }
    return lines.join("\n") + "\n\n" + "filler text. ".repeat(80);
  }

  it("flag ON: re-submitting 8 byte-equivalent ac:link macros produces 0 deleted, 8 regenerated", async () => {
    process.env.EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS = "true";

    const N = 8;
    const currentBody = `${buildStoredLinks(N)}<p>${"x".repeat(800)}</p>`;
    const markdownBody = buildLinksMarkdown(N);

    const result = await safePrepareBody({
      body: markdownBody,
      currentBody,
      // Flag-ON behaviour is the whole point: no confirmDeletions needed
      // because there are no genuine deletions.
      confirmShrinkage: true,
      confirmStructureLoss: true,
    });

    expect(result.deletedTokens).toEqual([]);
    expect(result.regeneratedTokens).toHaveLength(N);
    for (const pair of result.regeneratedTokens) {
      expect(pair.kind).toBe("ac:link");
      expect(pair.oldId).toMatch(/^T\d{4}$/);
      expect(pair.newId).toMatch(/^T\d{4}$/);
    }
  });

  it("flag OFF (default): same scenario produces 8 deletions (legacy behaviour preserved)", async () => {
    delete process.env.EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS;

    const N = 8;
    const currentBody = `${buildStoredLinks(N)}<p>${"x".repeat(800)}</p>`;
    const markdownBody = buildLinksMarkdown(N);

    // With the flag off, the gate fires: confirm_deletions is required.
    let thrown: ConverterError | undefined;
    try {
      await safePrepareBody({
        body: markdownBody,
        currentBody,
        confirmShrinkage: true,
        confirmStructureLoss: true,
      });
    } catch (e) {
      thrown = e as ConverterError;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.code).toBe("DELETIONS_NOT_CONFIRMED");
    expect(thrown!.message).toMatch(/8 preserved elements/);

    // Now ack and verify the 8 IDs end up in deletedTokens (not regenerated).
    const result = await safePrepareBody({
      body: markdownBody,
      currentBody,
      confirmShrinkage: true,
      confirmStructureLoss: true,
      confirmDeletions: true,
    });
    expect(result.deletedTokens).toHaveLength(N);
    expect(result.regeneratedTokens).toEqual([]);
  });

  it("flag set to a non-truthy value behaves as OFF", async () => {
    process.env.EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS = "no";

    const N = 2;
    const currentBody = `${buildStoredLinks(N)}<p>${"x".repeat(400)}</p>`;
    const markdownBody = buildLinksMarkdown(N);

    let thrown: ConverterError | undefined;
    try {
      await safePrepareBody({
        body: markdownBody,
        currentBody,
        confirmShrinkage: true,
        confirmStructureLoss: true,
      });
    } catch (e) {
      thrown = e as ConverterError;
    }
    expect(thrown?.code).toBe("DELETIONS_NOT_CONFIRMED");
  });

  it("flag ON: removing one link and rewriting the other 7 produces exactly 1 deletion", async () => {
    process.env.EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS = "true";

    const currentBody = `${buildStoredLinks(8)}<p>${"x".repeat(800)}</p>`;
    // Re-emit links 1, 2, 3, 4, 5, 6, 7 — drop link 8.
    const markdownBody =
      [1, 2, 3, 4, 5, 6, 7]
        .map((i) => `- [Page ${i}](confluence://ETD/Page-${i})`)
        .join("\n") + "\n\n" + "filler. ".repeat(80);

    // Without an ack, the gate fires for the genuine deletion.
    let thrown: ConverterError | undefined;
    try {
      await safePrepareBody({
        body: markdownBody,
        currentBody,
        confirmShrinkage: true,
        confirmStructureLoss: true,
      });
    } catch (e) {
      thrown = e as ConverterError;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.code).toBe("DELETIONS_NOT_CONFIRMED");
    // The error message names exactly one deletion — *not* eight.
    expect(thrown!.message).toMatch(/1 preserved element/);
    expect(thrown!.message).not.toMatch(/8 preserved elements/);

    // Now ack the one deletion and confirm the rest are regenerated.
    const result = await safePrepareBody({
      body: markdownBody,
      currentBody,
      confirmShrinkage: true,
      confirmStructureLoss: true,
      confirmDeletions: true,
    });
    expect(result.deletedTokens).toHaveLength(1);
    expect(result.regeneratedTokens).toHaveLength(7);
    // The deletion's fingerprint should describe an ac:link.
    expect(result.deletedTokens[0].tag).toBe("ac:link");
  });

  it("flag ON: TOC parameter change (maxLevel 3 → 4) is NOT byte-equivalent — gate fires", async () => {
    process.env.EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS = "true";

    // currentBody has a TOC macro with maxLevel=3.
    const oldToc =
      `<ac:structured-macro ac:name="toc" ac:macro-id="t-1">` +
      `<ac:parameter ac:name="maxLevel">3</ac:parameter>` +
      `<ac:parameter ac:name="minLevel">1</ac:parameter>` +
      `</ac:structured-macro>`;
    const currentBody = `${oldToc}<h1>Heading</h1><p>${"x".repeat(800)}</p>`;
    // YAML frontmatter renders to a TOC macro with maxLevel=4 — a real
    // change.
    const markdownBody =
      "---\n" +
      "toc:\n" +
      "  maxLevel: 4\n" +
      "  minLevel: 1\n" +
      "---\n\n" +
      "# Heading\n\n" +
      "Body content. ".repeat(80);

    let thrown: ConverterError | undefined;
    try {
      await safePrepareBody({
        body: markdownBody,
        currentBody,
        confirmShrinkage: true,
        confirmStructureLoss: true,
      });
    } catch (e) {
      thrown = e as ConverterError;
    }
    expect(thrown).toBeDefined();
    expect(thrown!.code).toBe("DELETIONS_NOT_CONFIRMED");
    expect(thrown!.message).toMatch(/1 preserved element/);

    // With ack, the result has 1 deletion and 0 regenerated.
    const result = await safePrepareBody({
      body: markdownBody,
      currentBody,
      confirmShrinkage: true,
      confirmStructureLoss: true,
      confirmDeletions: true,
    });
    expect(result.deletedTokens).toHaveLength(1);
    expect(result.regeneratedTokens).toEqual([]);
  });

  it("flag ON: property test — 50 random TOC parameter permutations always classify as regenerated", () => {
    process.env.EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS = "true";

    // Build a deterministic-but-shuffled TOC macro and assert the canonical
    // key matches the canonical (sorted) form across N permutations.
    const params = [
      ["maxLevel", "3"],
      ["minLevel", "1"],
      ["type", "list"],
      ["printable", "true"],
      ["outline", "false"],
    ];

    const canonical =
      `<ac:structured-macro ac:name="toc">` +
      params
        .map(
          ([k, v]) =>
            `<ac:parameter ac:name="${k}">${v}</ac:parameter>`,
        )
        .join("") +
      `</ac:structured-macro>`;
    const canonicalKey = canonicaliseToken(canonical).key;

    // Linear-congruential PRNG (no external deps; deterministic across runs).
    let seed = 0xc0ffee;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };

    for (let trial = 0; trial < 50; trial++) {
      const shuffled = params.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const xml =
        `<ac:structured-macro ac:name="toc">` +
        shuffled
          .map(
            ([k, v]) =>
              `<ac:parameter ac:name="${k}">${v}</ac:parameter>`,
          )
          .join("") +
        `</ac:structured-macro>`;
      expect(canonicaliseToken(xml).key).toBe(canonicalKey);
    }
  });

  it("flag ON: property test — 50 random ac:link attribute permutations always classify as regenerated", () => {
    process.env.EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS = "true";

    // The two attribute orderings of <ri:page>: space-key first vs
    // content-title first. Plus the optional ac:anchor on the outer link.
    let seed = 0xbadf00d;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };

    const target = { spaceKey: "ETD", contentTitle: "Home" };
    const anchor = "section";
    const body = "Click";

    const canonicalForm =
      `<ac:link ac:anchor="${anchor}">` +
      `<ri:page ri:space-key="${target.spaceKey}" ri:content-title="${target.contentTitle}"/>` +
      `<ac:plain-text-link-body><![CDATA[${body}]]></ac:plain-text-link-body>` +
      `</ac:link>`;
    const canonicalKey = canonicaliseToken(canonicalForm).key;

    for (let trial = 0; trial < 50; trial++) {
      const flipOuter = rnd() < 0.5;
      const flipInner = rnd() < 0.5;
      const linkOpenAttrs = `ac:anchor="${anchor}"`;
      const innerAttrs = flipInner
        ? `ri:content-title="${target.contentTitle}" ri:space-key="${target.spaceKey}"`
        : `ri:space-key="${target.spaceKey}" ri:content-title="${target.contentTitle}"`;
      // flipOuter would change attribute order on the link element itself,
      // but ac:link only has one attr here so it's a no-op for this test;
      // the variation is in the inner ri:page only.
      void flipOuter;
      const xml =
        `<ac:link ${linkOpenAttrs}>` +
        `<ri:page ${innerAttrs}/>` +
        `<ac:plain-text-link-body><![CDATA[${body}]]></ac:plain-text-link-body>` +
        `</ac:link>`;
      expect(canonicaliseToken(xml).key).toBe(canonicalKey);
    }
  });
});

describe("safeSubmitPage — C1 audit log for regenerated tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records regeneratedTokens on the success-path mutation log entry", async () => {
    (_rawUpdatePage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: { id: "42", title: "P", version: { number: 5 } },
      newVersion: 5,
    });

    const regeneratedTokens: RegeneratedTokenPair[] = [
      { oldId: "T0001", newId: "T0001", kind: "ac:link" },
      { oldId: "T0002", newId: "T0002", kind: "ac:link" },
      { oldId: "T0003", newId: "T0003", kind: "ac:structured-macro:toc" },
    ];

    await safeSubmitPage({
      pageId: "42",
      title: "P",
      finalStorage: "<p>different body content here for thresholds</p>",
      previousBody: "<p>previous body content here</p>",
      version: 4,
      versionMessage: "",
      deletedTokens: [],
      regeneratedTokens,
      clientLabel: "claude-code",
    });

    expect(logMutation).toHaveBeenCalledTimes(1);
    const record = (logMutation as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(record.regeneratedTokens).toBeDefined();
    expect(record.regeneratedTokens).toHaveLength(3);
    // Every entry has the three required fields and nothing else leaks.
    for (const entry of record.regeneratedTokens) {
      expect(entry).toHaveProperty("oldId");
      expect(entry).toHaveProperty("newId");
      expect(entry).toHaveProperty("kind");
      expect(typeof entry.oldId).toBe("string");
      expect(typeof entry.newId).toBe("string");
      expect(typeof entry.kind).toBe("string");
    }
  });

  it("omits regeneratedTokens from the mutation log when none were suppressed", async () => {
    (_rawUpdatePage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: { id: "42", title: "P", version: { number: 5 } },
      newVersion: 5,
    });

    await safeSubmitPage({
      pageId: "42",
      title: "P",
      finalStorage: "<p>different body content here for thresholds</p>",
      previousBody: "<p>previous body content here</p>",
      version: 4,
      versionMessage: "",
      deletedTokens: [],
      // regeneratedTokens deliberately omitted (defaults to []).
      clientLabel: "claude-code",
    });

    const record = (logMutation as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(record.regeneratedTokens).toBeUndefined();
  });

  it("end-to-end (prepare → submit): suppressed pairs land in the mutation log", async () => {
    // Restore the env flag for this single test (subsequent tests in this
    // describe restore via beforeEach as needed).
    process.env.EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS = "true";
    try {
      const N = 3;
      const storedLinks = [];
      for (let i = 1; i <= N; i++) {
        storedLinks.push(
          `<ac:link>` +
            `<ri:page ri:content-title="Page-${i}" ri:space-key="ETD"/>` +
            `<ac:plain-text-link-body><![CDATA[Page ${i}]]></ac:plain-text-link-body>` +
            `</ac:link>`,
        );
      }
      const currentBody = `<p>${storedLinks.join(" ")}</p><p>${"x".repeat(400)}</p>`;
      const markdownBody =
        [1, 2, 3]
          .map((i) => `- [Page ${i}](confluence://ETD/Page-${i})`)
          .join("\n") +
        "\n\n" +
        "filler text. ".repeat(80);

      const prepared = await safePrepareBody({
        body: markdownBody,
        currentBody,
        confirmShrinkage: true,
        confirmStructureLoss: true,
      });
      // Pre-condition: byte-equivalent suppression actually fired.
      expect(prepared.regeneratedTokens.length).toBe(N);
      expect(prepared.deletedTokens).toEqual([]);

      (_rawUpdatePage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        page: { id: "777", title: "T", version: { number: 9 } },
        newVersion: 9,
      });

      await safeSubmitPage({
        pageId: "777",
        title: "T",
        finalStorage: prepared.finalStorage,
        previousBody: currentBody,
        version: 8,
        versionMessage: prepared.versionMessage,
        deletedTokens: prepared.deletedTokens,
        regeneratedTokens: prepared.regeneratedTokens,
        clientLabel: "claude-code",
      });

      const record = (logMutation as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      // Audit-log invariant: every regenerated pair surfaces in the mutation
      // log so a postmortem can reconstruct what was suppressed.
      expect(record.regeneratedTokens).toBeDefined();
      expect(record.regeneratedTokens).toHaveLength(N);
      for (const entry of record.regeneratedTokens) {
        expect(entry.kind).toBe("ac:link");
        expect(entry.oldId).toMatch(/^T\d{4}$/);
        expect(entry.newId).toMatch(/^T\d{4}$/);
      }
    } finally {
      delete process.env.EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS;
    }
  });

  it("echoes regeneratedTokens through to SafeSubmitPageOutput", async () => {
    (_rawUpdatePage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: { id: "42", title: "P", version: { number: 5 } },
      newVersion: 5,
    });

    const regeneratedTokens: RegeneratedTokenPair[] = [
      { oldId: "T0001", newId: "T0007", kind: "ac:link" },
    ];

    const result = await safeSubmitPage({
      pageId: "42",
      title: "P",
      finalStorage: "<p>different body content here for thresholds</p>",
      previousBody: "<p>previous body content here</p>",
      version: 4,
      versionMessage: "",
      deletedTokens: [],
      regeneratedTokens,
      clientLabel: "claude-code",
    });

    expect(result.regeneratedTokens).toEqual(regeneratedTokens);
  });
});

// ---------------------------------------------------------------------------
// Section M: safePrepareMultiSectionBody (D1 — update_page_sections)
// ---------------------------------------------------------------------------
//
// Atomicity guarantees verified here:
//   1. Heading missing / ambiguous / duplicate → MultiSectionError thrown
//      BEFORE any splice. Source body is returned untouched (test asserts
//      on the merged storage in success cases only).
//   2. Multiple sections splice into ONE merged document — no partial
//      mutation, no per-section commit.
//   3. Section finders run against the ORIGINAL page (not the cumulative-
//      edited state); a later section in the input cannot match content
//      introduced by an earlier section's body.
//   4. Aggregated deletion list is exposed for the gate to fire ONCE on
//      the union, not per-section. (Gate-call wiring is verified by the
//      handler tests in index.test.ts.)
// ---------------------------------------------------------------------------

describe("safePrepareMultiSectionBody (D1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("splices N sections into one merged document with all replacements applied", async () => {
    const source =
      "<h2>A</h2><p>old A</p>" +
      "<h2>B</h2><p>old B</p>" +
      "<h2>C</h2><p>old C</p>" +
      "<h2>D</h2><p>old D</p>";
    const result = await safePrepareMultiSectionBody({
      currentStorage: source,
      sections: [
        { section: "A", body: "<p>new A</p>" },
        { section: "B", body: "<p>new B</p>" },
        { section: "C", body: "<p>new C</p>" },
        { section: "D", body: "<p>new D</p>" },
      ],
    });
    // Each old body replaced; headings preserved.
    expect(result.finalStorage).toContain("<h2>A</h2><p>new A</p>");
    expect(result.finalStorage).toContain("<h2>B</h2><p>new B</p>");
    expect(result.finalStorage).toContain("<h2>C</h2><p>new C</p>");
    expect(result.finalStorage).toContain("<h2>D</h2><p>new D</p>");
    // Old bodies are gone (note: we only replaced the BODY under each
    // heading, not the heading text itself).
    expect(result.finalStorage).not.toContain("<p>old A</p>");
    expect(result.finalStorage).not.toContain("<p>old B</p>");
    expect(result.finalStorage).not.toContain("<p>old C</p>");
    expect(result.finalStorage).not.toContain("<p>old D</p>");
    expect(result.perSectionResults).toHaveLength(4);
    expect(result.perSectionResults.map((r) => r.section)).toEqual([
      "A", "B", "C", "D",
    ]);
  });

  it("rejects the entire call when a single section's heading is missing", async () => {
    const source = "<h2>A</h2><p>old A</p><h2>B</h2><p>old B</p>";
    let thrown: unknown;
    try {
      await safePrepareMultiSectionBody({
        currentStorage: source,
        sections: [
          { section: "A", body: "<p>new A</p>" },
          { section: "DoesNotExist", body: "<p>x</p>" },
        ],
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MultiSectionError);
    const err = thrown as MultiSectionError;
    expect(err.code).toBe(MULTI_SECTION_FAILED);
    expect(err.failures).toHaveLength(1);
    expect(err.failures[0]).toMatchObject({
      section: "DoesNotExist",
      reason: "missing",
    });
    expect(err.failures[0].message).toContain("not found");
    // The error message itself surfaces the offending section name.
    expect(err.message).toContain("DoesNotExist");
  });

  it("rejects on ambiguous heading (B1's tolerant matcher tripped)", async () => {
    // Two headings both stripping to "Notes" — tolerant matcher throws.
    const source =
      "<h2>1.2. Notes</h2><p>n1</p>" +
      "<h2>2.3. Notes</h2><p>n2</p>";
    let thrown: unknown;
    try {
      await safePrepareMultiSectionBody({
        currentStorage: source,
        sections: [{ section: "Notes", body: "<p>x</p>" }],
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MultiSectionError);
    const err = thrown as MultiSectionError;
    expect(err.failures[0].reason).toBe("ambiguous");
    expect(err.failures[0].message).toContain("ambiguous");
  });

  it("rejects when the input list contains a duplicate section name", async () => {
    const source = "<h2>A</h2><p>old A</p>";
    let thrown: unknown;
    try {
      await safePrepareMultiSectionBody({
        currentStorage: source,
        sections: [
          { section: "A", body: "<p>new1</p>" },
          { section: "A", body: "<p>new2</p>" },
        ],
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MultiSectionError);
    const err = thrown as MultiSectionError;
    expect(err.failures).toHaveLength(1);
    expect(err.failures[0]).toMatchObject({
      section: "A",
      reason: "duplicate",
    });
  });

  it("rejects with empty sections list (defensive — schema enforces .min(1))", async () => {
    let thrown: unknown;
    try {
      await safePrepareMultiSectionBody({
        currentStorage: "<h2>A</h2><p>x</p>",
        sections: [],
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MultiSectionError);
  });

  it("collects EVERY missing-heading failure in one error (not just the first)", async () => {
    const source = "<h2>A</h2><p>old</p>";
    let thrown: unknown;
    try {
      await safePrepareMultiSectionBody({
        currentStorage: source,
        sections: [
          { section: "Missing1", body: "<p>x</p>" },
          { section: "Missing2", body: "<p>y</p>" },
          { section: "A", body: "<p>z</p>" },
        ],
      });
    } catch (e) {
      thrown = e;
    }
    const err = thrown as MultiSectionError;
    const missing = err.failures.filter((f) => f.reason === "missing");
    // Both missing sections reported; the valid "A" entry is not a failure.
    expect(missing.map((f) => f.section).sort()).toEqual(["Missing1", "Missing2"]);
  });

  it("a single-section call produces the same outcome as update_page_section's splice", async () => {
    const source = "<h2>A</h2><p>old A</p><h2>B</h2><p>keep B</p>";
    const result = await safePrepareMultiSectionBody({
      currentStorage: source,
      sections: [{ section: "A", body: "<p>new A</p>" }],
    });
    expect(result.finalStorage).toBe(
      "<h2>A</h2><p>new A</p><h2>B</h2><p>keep B</p>",
    );
  });

  it("matches each section against the ORIGINAL page (not cumulative state)", async () => {
    // Section A's NEW body literally contains the heading text used by a
    // later section search ("Section B"). If the implementation matched
    // each section against the cumulative-edited state, the second match
    // would resolve to whatever appeared inside A's replacement body.
    // Because matching runs against the ORIGINAL page, this is irrelevant —
    // the second section resolves against the original heading.
    const source =
      "<h2>Section A</h2><p>old A</p>" +
      "<h2>Section B</h2><p>old B</p>";
    const result = await safePrepareMultiSectionBody({
      currentStorage: source,
      sections: [
        // A's new body mentions "Section B" as plain text — would confuse
        // a naïve cumulative-state finder.
        { section: "Section A", body: "<p>new A discusses Section B</p>" },
        { section: "Section B", body: "<p>new B</p>" },
      ],
    });
    expect(result.finalStorage).toContain(
      "<h2>Section A</h2><p>new A discusses Section B</p>",
    );
    // Section B's heading-and-body still resolved correctly.
    expect(result.finalStorage).toContain("<h2>Section B</h2><p>new B</p>");
    expect(result.finalStorage).not.toContain("<p>old A</p>");
    expect(result.finalStorage).not.toContain("<p>old B</p>");
  });

  it("aggregates deletedTokens across sections (no per-section gate fires here)", async () => {
    // Section A has an emoticon; the markdown replacement removes it.
    // Section B has an emoticon; the markdown replacement also removes it.
    // confirm_deletions: true makes per-section prepare accept the loss;
    // we then verify the aggregate carries both deletions.
    const EMOTICON_A = `<ac:emoticon ac:name="warning"/>`;
    const EMOTICON_B = `<ac:emoticon ac:name="info"/>`;
    const source =
      `<h2>A</h2><p>note ${EMOTICON_A}</p>` +
      `<h2>B</h2><p>tip ${EMOTICON_B}</p>`;
    const result = await safePrepareMultiSectionBody({
      currentStorage: source,
      sections: [
        { section: "A", body: "note without macro" },
        { section: "B", body: "tip without macro" },
      ],
      confirmDeletions: true,
    });
    // Two emoticons aggregated, one per section. The exact ID (T#) differs
    // because each section is tokenised independently — we assert on count.
    expect(result.aggregatedDeletedTokens).toHaveLength(2);
    expect(
      result.aggregatedDeletedTokens.every((t) => t.tag === "ac:emoticon"),
    ).toBe(true);
  });

  it("propagates per-section deletion-not-confirmed errors as 'prepare' failures (no submit)", async () => {
    // Same setup as above but WITHOUT confirm_deletions — each section's
    // safePrepareBody throws DELETIONS_NOT_CONFIRMED, which we capture as
    // a prepare failure. The whole call rejects.
    const EMOTICON = `<ac:emoticon ac:name="warning"/>`;
    const source =
      `<h2>A</h2><p>note ${EMOTICON}</p>` +
      `<h2>B</h2><p>tip ${EMOTICON}</p>`;
    let thrown: unknown;
    try {
      await safePrepareMultiSectionBody({
        currentStorage: source,
        sections: [
          { section: "A", body: "note without macro" },
          { section: "B", body: "tip without macro" },
        ],
        // confirmDeletions omitted → each per-section prepare throws.
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(MultiSectionError);
    const err = thrown as MultiSectionError;
    // Both sections appear as 'prepare' failures.
    expect(err.failures).toHaveLength(2);
    expect(err.failures.every((f) => f.reason === "prepare")).toBe(true);
    expect(err.failures.map((f) => f.section).sort()).toEqual(["A", "B"]);
  });

  it("perSectionResults exposes the matched heading verbatim from the source", async () => {
    const source = "<h2>1.2. Lesereihenfolge</h2><p>old</p>";
    const result = await safePrepareMultiSectionBody({
      currentStorage: source,
      // Caller supplies the bare form; B1's tolerant matcher resolves it.
      sections: [{ section: "Lesereihenfolge", body: "<p>new</p>" }],
    });
    expect(result.perSectionResults[0].section).toBe("Lesereihenfolge");
    expect(result.perSectionResults[0].matchedHeading).toBe(
      "<h2>1.2. Lesereihenfolge</h2>",
    );
  });
});

// ---------------------------------------------------------------------------
// findReplaceInSection (D2)
// ---------------------------------------------------------------------------

describe("findReplaceInSection (D2)", () => {
  it("replaces a plain-text literal in a simple section body", () => {
    const body = "<p>Hello world. See <strong>1. Overview</strong> for more.</p>";
    const result = findReplaceInSection(body, [
      { find: "<strong>1. Overview</strong>", replace: "<strong>REPLACED</strong>" },
    ]);
    expect(result).toContain("<strong>REPLACED</strong>");
    expect(result).not.toContain("<strong>1. Overview</strong>");
    // Surrounding content is byte-identical.
    expect(result).toContain("<p>Hello world. See ");
    expect(result).toContain(" for more.</p>");
  });

  it("returns body unchanged when the section has no macros and find matches", () => {
    const body = "<p>alpha bravo</p>";
    const result = findReplaceInSection(body, [
      { find: "alpha", replace: "ALPHA" },
    ]);
    expect(result).toBe("<p>ALPHA bravo</p>");
  });

  it("throws FIND_REPLACE_MATCH_FAILED when find string is absent", () => {
    const body = "<p>Hello world.</p>";
    let thrown: unknown;
    try {
      findReplaceInSection(body, [{ find: "MISSING_STRING", replace: "x" }]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe(FIND_REPLACE_MATCH_FAILED);
    expect((thrown as Error).message).toContain("MISSING_STRING");
  });

  it("applies multiple pairs in order (chaining semantics)", () => {
    const body = "<p>alpha bravo charlie</p>";
    const result = findReplaceInSection(body, [
      { find: "alpha", replace: "ALPHA" },
      { find: "bravo", replace: "BRAVO" },
      // Third pair matches the partially-substituted form.
      { find: "BRAVO charlie", replace: "BRAVO-CHARLIE" },
    ]);
    expect(result).toBe("<p>ALPHA BRAVO-CHARLIE</p>");
  });

  it("does NOT replace text inside a macro's attribute value (tokenisation guard)", () => {
    // An ac:link whose ri:page content-title contains "X".
    // After tokenisation the whole <ac:link> is opaque, so "X" inside it is safe.
    const AC_LINK =
      '<ac:link><ri:page ri:content-title="X"/>' +
      "<ac:plain-text-link-body><![CDATA[X]]></ac:plain-text-link-body>" +
      "</ac:link>";
    const body = `<p>See ${AC_LINK} here. Also X in text.</p>`;
    const result = findReplaceInSection(body, [{ find: "X", replace: "Y" }]);
    // The plain-text " X in text" became " Y in text".
    expect(result).toContain("Y in text");
    // The macro's attribute and CDATA are preserved verbatim.
    expect(result).toContain('ri:content-title="X"');
    expect(result).toContain("<![CDATA[X]]>");
    // The ac:link itself is still intact.
    expect(result).toContain("ri:page");
  });

  it("does NOT replace text inside a CDATA body of a structured macro", () => {
    // A code macro whose CDATA body contains the find string.
    const CODE_MACRO =
      '<ac:structured-macro ac:name="code">' +
      "<ac:plain-text-body><![CDATA[find me here]]></ac:plain-text-body>" +
      "</ac:structured-macro>";
    const body = `<p>find me here</p>${CODE_MACRO}`;
    const result = findReplaceInSection(body, [
      { find: "find me here", replace: "REPLACED" },
    ]);
    // Only the text outside the macro is replaced.
    expect(result).toContain("<p>REPLACED</p>");
    // The macro's CDATA is preserved.
    expect(result).toContain("<![CDATA[find me here]]>");
  });

  it("throws with the first failing find when a later pair also fails", () => {
    const body = "<p>Hello.</p>";
    let thrown: unknown;
    try {
      findReplaceInSection(body, [
        { find: "Hello", replace: "Hi" },     // succeeds
        { find: "NOT_HERE", replace: "x" },   // fails
      ]);
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { code?: string }).code).toBe(FIND_REPLACE_MATCH_FAILED);
    expect((thrown as Error).message).toContain("NOT_HERE");
  });

  it("preserves a section body with no macros and no match when find string is absent", () => {
    // This is the 'fails loudly' case. The body is NOT modified.
    const body = "<p>Untouched content.</p>";
    expect(() =>
      findReplaceInSection(body, [{ find: "xyz", replace: "abc" }])
    ).toThrow();
  });

  it("handles empty section body gracefully — find always fails (body is empty)", () => {
    const body = "";
    expect(() =>
      findReplaceInSection(body, [{ find: "anything", replace: "x" }])
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Section E: maybeConsumeConfirmToken (§5.6 — task 2.C helper)
// ---------------------------------------------------------------------------

describe("maybeConsumeConfirmToken", () => {
  beforeEach(() => {
    _resetForTest();
  });

  it("returns 'no_token' when confirm_token is undefined", async () => {
    const result = await maybeConsumeConfirmToken({
      confirm_token: undefined,
      tool: "update_page",
      cloudId: "cloud-abc",
      pageId: "123",
      pageVersion: 5,
      diffHash: computeDiffHash("<p>body</p>", 5),
    });
    expect(result).toBe("no_token");
  });

  it("returns 'no_token' when cloudId is undefined (pre-seal / env-var profile)", async () => {
    const hash = computeDiffHash("<p>body</p>", 5);
    const { token } = mintToken({
      tool: "update_page",
      cloudId: "cloud-abc",
      pageId: "123",
      pageVersion: 5,
      diffHash: hash,
    });
    const result = await maybeConsumeConfirmToken({
      confirm_token: token,
      tool: "update_page",
      cloudId: undefined,
      pageId: "123",
      pageVersion: 5,
      diffHash: hash,
    });
    // validateToken is NOT called; token is untouched.
    expect(result).toBe("no_token");
  });

  it("returns 'no_token' when pageVersion is 0", async () => {
    const hash = computeDiffHash("<p>body</p>", 5);
    const { token } = mintToken({
      tool: "update_page",
      cloudId: "cloud-abc",
      pageId: "123",
      pageVersion: 5,
      diffHash: hash,
    });
    const result = await maybeConsumeConfirmToken({
      confirm_token: token,
      tool: "update_page",
      cloudId: "cloud-abc",
      pageId: "123",
      pageVersion: 0,
      diffHash: hash,
    });
    expect(result).toBe("no_token");
  });

  it("returns 'no_token' when diffHash is undefined", async () => {
    const hash = computeDiffHash("<p>body</p>", 5);
    const { token } = mintToken({
      tool: "update_page",
      cloudId: "cloud-abc",
      pageId: "123",
      pageVersion: 5,
      diffHash: hash,
    });
    const result = await maybeConsumeConfirmToken({
      confirm_token: token,
      tool: "update_page",
      cloudId: "cloud-abc",
      pageId: "123",
      pageVersion: 5,
      diffHash: undefined,
    });
    expect(result).toBe("no_token");
  });

  it("returns 'ok' when a valid token is presented with matching context", async () => {
    const hash = computeDiffHash("<p>body</p>", 7);
    const { token } = mintToken({
      tool: "update_page",
      cloudId: "cloud-abc",
      pageId: "page-42",
      pageVersion: 7,
      diffHash: hash,
    });
    const result = await maybeConsumeConfirmToken({
      confirm_token: token,
      tool: "update_page",
      cloudId: "cloud-abc",
      pageId: "page-42",
      pageVersion: 7,
      diffHash: hash,
    });
    expect(result).toBe("ok");
  });

  it("returns 'invalid' when a token is replayed (single-use enforcement)", async () => {
    const hash = computeDiffHash("<p>body</p>", 3);
    const { token } = mintToken({
      tool: "delete_page",
      cloudId: "cloud-abc",
      pageId: "page-1",
      pageVersion: 3,
      diffHash: hash,
    });
    // First use — ok.
    await maybeConsumeConfirmToken({
      confirm_token: token,
      tool: "delete_page",
      cloudId: "cloud-abc",
      pageId: "page-1",
      pageVersion: 3,
      diffHash: hash,
    });
    // Replay — invalid.
    const result = await maybeConsumeConfirmToken({
      confirm_token: token,
      tool: "delete_page",
      cloudId: "cloud-abc",
      pageId: "page-1",
      pageVersion: 3,
      diffHash: hash,
    });
    expect(result).toBe("invalid");
  });

  it("returns 'invalid' when the underlying validateToken returns invalid (mismatched context)", async () => {
    const hash = computeDiffHash("<p>body</p>", 5);
    const { token } = mintToken({
      tool: "update_page",
      cloudId: "cloud-abc",
      pageId: "page-99",
      pageVersion: 5,
      diffHash: hash,
    });
    // Use with a different pageId — mismatch.
    const result = await maybeConsumeConfirmToken({
      confirm_token: token,
      tool: "update_page",
      cloudId: "cloud-abc",
      pageId: "page-DIFFERENT",
      pageVersion: 5,
      diffHash: hash,
    });
    expect(result).toBe("invalid");
  });
});

// ---------------------------------------------------------------------------
// Section F: safeSubmitPage — invalidateForPage defense-in-depth (§5.6 / 2.E)
// ---------------------------------------------------------------------------

describe("safeSubmitPage — invalidateForPage defense-in-depth (2.E)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTest();
  });

  it("invalidates outstanding tokens for the page after a successful PUT", async () => {
    (_rawUpdatePage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: { id: "page-x", title: "Page X", version: { number: 8 } },
      newVersion: 8,
    });

    const CLOUD_ID = "cloud-tenant-x";
    const PAGE_ID = "page-x";
    const hash = computeDiffHash("<p>content</p>", 7);

    // Mint a token before the write.
    const { token } = mintToken({
      tool: "update_page",
      cloudId: CLOUD_ID,
      pageId: PAGE_ID,
      pageVersion: 7,
      diffHash: hash,
    });

    // Register audit hook to capture all validate outcomes in order.
    const capturedOutcomes: string[] = [];
    onValidate((meta) => { capturedOutcomes.push(meta.outcome); });

    // Perform the write through safeSubmitPage (non-gated path — cloudId supplied).
    await safeSubmitPage({
      pageId: PAGE_ID,
      title: "Page X",
      finalStorage: "<p>after</p>",
      previousBody: "<p>before</p>",
      version: 7,
      versionMessage: "test",
      deletedTokens: [],
      cloudId: CLOUD_ID,
      clientLabel: "test-client",
    });

    // invalidateForPage fires the onValidate hook with outcome "stale" as it
    // removes the token. Then validateToken below fires again with "unknown"
    // (token was already deleted). We assert both events.
    const validateResult = await validateToken(token, {
      tool: "update_page",
      cloudId: CLOUD_ID,
      pageId: PAGE_ID,
      pageVersion: 7,
      diffHash: hash,
    });
    expect(validateResult).toBe("invalid");
    // First hook call: invalidateForPage emits "stale".
    expect(capturedOutcomes[0]).toBe("stale");
    // Second hook call: validateToken finds the token gone → "unknown".
    expect(capturedOutcomes[1]).toBe("unknown");
  });

  it("does NOT call invalidateForPage when cloudId is undefined", async () => {
    (_rawUpdatePage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      page: { id: "page-y", title: "Page Y", version: { number: 2 } },
      newVersion: 2,
    });

    const CLOUD_ID = "cloud-tenant-y";
    const PAGE_ID = "page-y";
    const hash = computeDiffHash("<p>stuff</p>", 1);

    // Mint a token.
    const { token } = mintToken({
      tool: "update_page",
      cloudId: CLOUD_ID,
      pageId: PAGE_ID,
      pageVersion: 1,
      diffHash: hash,
    });

    // Submit WITHOUT cloudId — no invalidation should happen.
    await safeSubmitPage({
      pageId: PAGE_ID,
      title: "Page Y",
      finalStorage: "<p>new</p>",
      previousBody: "<p>old</p>",
      version: 1,
      versionMessage: "test",
      deletedTokens: [],
      clientLabel: "test-client",
      // cloudId intentionally omitted.
    });

    // Token should still be valid (no invalidation occurred).
    const validateResult = await validateToken(token, {
      tool: "update_page",
      cloudId: CLOUD_ID,
      pageId: PAGE_ID,
      pageVersion: 1,
      diffHash: hash,
    });
    expect(validateResult).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Section G: formatSoftConfirmationResult shape (§5.5)
// ---------------------------------------------------------------------------

describe("formatSoftConfirmationResult", () => {
  it("returns isError: true with SOFT_CONFIRMATION_REQUIRED in text content", () => {
    const fakeErr = {
      token: "abcdefgh12345678TAIL1234",
      auditId: "audit-uuid-001",
      expiresAt: Date.now() + 300_000,
      humanSummary: "This update will remove 2 TOC macros.",
      pageId: "page-42",
    };
    const result = formatSoftConfirmationResult(fakeErr, { pageId: "page-42" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("SOFT_CONFIRMATION_REQUIRED");
    expect(result.content[0].text).toContain("This update will remove 2 TOC macros.");
    // Full token must NOT appear in free text.
    expect(result.content[0].text).not.toContain(fakeErr.token);
    // Last 8 chars appear as the tail.
    expect(result.content[0].text).toContain("TAIL1234");
  });

  it("puts the full token in structuredContent.confirm_token", () => {
    const fakeErr = {
      token: "FULL_TOKEN_VALUE_HERE_12345678",
      auditId: "audit-uuid-002",
      expiresAt: Date.now() + 300_000,
      humanSummary: "Confirmation needed.",
      pageId: "page-7",
    };
    const result = formatSoftConfirmationResult(fakeErr, { pageId: "page-7" });
    expect(result.structuredContent.confirm_token).toBe("FULL_TOKEN_VALUE_HERE_12345678");
    expect(result.structuredContent.audit_id).toBe("audit-uuid-002");
    expect(result.structuredContent.page_id).toBe("page-7");
    expect(typeof result.structuredContent.expires_at).toBe("string");
  });

  it("includes deletion_summary in structuredContent when provided", () => {
    const fakeErr = {
      token: "tok",
      auditId: "audit-003",
      expiresAt: Date.now() + 300_000,
      humanSummary: "Will remove macros.",
      pageId: "page-1",
    };
    const deletionSummary = {
      tocs: 1,
      links: 2,
      structuredMacros: 3,
      codeMacros: 0,
      plainElements: 0,
      other: 0,
    };
    const result = formatSoftConfirmationResult(fakeErr, { pageId: "page-1", deletionSummary });
    expect(result.structuredContent.deletion_summary).toEqual(deletionSummary);
  });

  it("omits deletion_summary from structuredContent when not provided", () => {
    const fakeErr = {
      token: "tok",
      auditId: "audit-004",
      expiresAt: Date.now() + 300_000,
      humanSummary: "Summary.",
      pageId: "page-2",
    };
    const result = formatSoftConfirmationResult(fakeErr, { pageId: "page-2" });
    expect(result.structuredContent.deletion_summary).toBeUndefined();
  });
});
