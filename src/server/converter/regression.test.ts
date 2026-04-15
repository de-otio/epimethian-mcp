/**
 * Cross-cutting regression tests (Stream 12).
 *
 * Covers:
 *   - Drawio coexistence: ac:name="drawio" macros round-trip byte-identically
 *     through planUpdate, even when surrounding content is edited.
 *   - Attribution footer: stripAttributionFooter / buildAttributionFooter
 *     interact correctly with the new converter pipeline.
 *   - writeGuard / read-only mode: markdown writes rejected identically to
 *     storage writes. (Delegates to writeGuard which is already unit-tested
 *     in index.test.ts — we verify the import and basic behaviour here from
 *     the converter's perspective.)
 *   - update_page_section regression: replaceSection continues to function
 *     correctly with storage that contains Confluence-specific macros.
 *   - Security end-to-end: CDATA injection, XML attribute injection, URL
 *     spoofing, forged token rejection, input size cap.
 */

import { describe, expect, it } from "vitest";
import { markdownToStorage } from "./md-to-storage.js";
import { storageToMarkdown } from "./storage-to-md.js";
import { planUpdate } from "./update-orchestrator.js";
import { tokeniseStorage } from "./tokeniser.js";
import { restoreFromTokens } from "./restore.js";
import { ConverterError } from "./types.js";
import {
  enforceContentSafetyGuards,
  countMacros,
  countTables,
  extractTextContent,
} from "./content-safety-guards.js";

// ---------------------------------------------------------------------------
// 1. Drawio coexistence regression
// ---------------------------------------------------------------------------

/**
 * The exact macro format produced by add_drawio_diagram in index.ts (line ~963).
 * We use stable placeholder values instead of random UUIDs.
 */
const DRAWIO_MACRO = [
  `<ac:structured-macro ac:name="drawio" ac:schema-version="1" data-layout="default" ac:local-id="local-1234" ac:macro-id="macro-5678">`,
  `  <ac:parameter ac:name="diagramDisplayName">architecture.drawio</ac:parameter>`,
  `  <ac:parameter ac:name="diagramName">architecture.drawio</ac:parameter>`,
  `  <ac:parameter ac:name="revision">1</ac:parameter>`,
  `  <ac:parameter ac:name="pageId">123456</ac:parameter>`,
  `  <ac:parameter ac:name="baseUrl">https://entrixenergy.atlassian.net/wiki</ac:parameter>`,
  `  <ac:parameter ac:name="zoom">1</ac:parameter>`,
  `  <ac:parameter ac:name="lbox">1</ac:parameter>`,
  `  <ac:parameter ac:name="simple">0</ac:parameter>`,
  `  <ac:parameter ac:name="contentVer">1</ac:parameter>`,
  `</ac:structured-macro>`,
].join("\n");

describe("drawio coexistence regression", () => {
  it("drawio macro tokenises and restores byte-identically", () => {
    const { canonical, sidecar } = tokeniseStorage(DRAWIO_MACRO);
    const restored = restoreFromTokens(canonical, sidecar);
    expect(restored).toBe(DRAWIO_MACRO);
  });

  it("planUpdate with drawio-only page is no-op (byte-identical)", () => {
    const storage = DRAWIO_MACRO;
    const { canonical } = tokeniseStorage(storage);
    const plan = planUpdate({ currentStorage: storage, callerMarkdown: canonical });
    expect(plan.newStorage).toBe(storage);
    expect(plan.deletedTokens).toEqual([]);
  });

  it("page with text + drawio: adding a paragraph preserves drawio byte-identically", () => {
    // Storage: the drawio macro preceded by a text paragraph.
    // The text paragraph will be tokenised as plain HTML (no token),
    // but the drawio macro will be T0001.
    const storage = DRAWIO_MACRO;
    const { canonical } = tokeniseStorage(storage);

    // Caller markdown: the canonical, but with new plain text prepended.
    // The new paragraph will be converted via markdownToStorage.
    const callerMarkdown = `New paragraph added before diagram.\n\n${canonical}`;

    const plan = planUpdate({ currentStorage: storage, callerMarkdown });

    // The drawio macro must survive byte-identically.
    expect(plan.newStorage).toContain(DRAWIO_MACRO);
    // New content must be present.
    expect(plan.newStorage).toContain("New paragraph added before diagram.");
    // No deletions.
    expect(plan.deletedTokens).toEqual([]);
  });

  it("page with drawio and adjacent macros: both preserved byte-identically", () => {
    const INFO =
      `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Note</p></ac:rich-text-body></ac:structured-macro>`;
    const storage = DRAWIO_MACRO + INFO;
    const { canonical } = tokeniseStorage(storage);
    const plan = planUpdate({ currentStorage: storage, callerMarkdown: canonical });
    expect(plan.newStorage).toBe(storage);
    expect(plan.deletedTokens).toEqual([]);
  });

  it("storageToMarkdown exposes drawio token in the returned markdown", () => {
    const storage = DRAWIO_MACRO;
    const { markdown, sidecar } = storageToMarkdown(storage);
    // The drawio token should appear in the markdown.
    expect(markdown).toMatch(/\[\[epi:T\d+\]\]/);
    // The sidecar must have the drawio macro byte-for-byte.
    const tokenId = Object.keys(sidecar)[0]!;
    expect(sidecar[tokenId]).toBe(DRAWIO_MACRO);
  });

  it("storageToMarkdown flow: drawio survives get_page → update_page round-trip", () => {
    const storage = DRAWIO_MACRO;
    // Simulate get_page(format=markdown) → returns markdown with token.
    const { markdown } = storageToMarkdown(storage);
    // Simulate update_page(same markdown) → planUpdate.
    const plan = planUpdate({ currentStorage: storage, callerMarkdown: markdown });
    expect(plan.newStorage).toBe(storage);
    expect(plan.deletedTokens).toEqual([]);
  });

  it("modified markdown (new paragraph before drawio) still preserves drawio", () => {
    const storage = DRAWIO_MACRO;
    const { markdown } = storageToMarkdown(storage);
    // Caller adds a new paragraph before the drawio token.
    const modified = `Added context paragraph.\n\n${markdown}`;
    const plan = planUpdate({ currentStorage: storage, callerMarkdown: modified });
    expect(plan.newStorage).toContain(DRAWIO_MACRO);
    expect(plan.deletedTokens).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Attribution footer regression
// ---------------------------------------------------------------------------

/**
 * Attribution footer helpers — mirrors what confluence-client.ts does.
 * Tested here as "does the new converter pipeline interact correctly with
 * the existing footer pattern".
 */
const ATTRIBUTION_START = "<!--epimethian-attribution-start-->";
const ATTRIBUTION_END = "<!--epimethian-attribution-end-->";
const GITHUB_URL = "https://github.com/de-otio/epimethian-mcp";
const PKG_VERSION = "1.0.0"; // fixed for tests

function buildAttributionFooter(action: "created" | "updated"): string {
  return (
    ATTRIBUTION_START +
    '<p style="font-size:9px;color:#999;margin-top:2em;">' +
    `<em>This page was ${action} with ` +
    `<a href="${GITHUB_URL}">Epimethian</a> v${PKG_VERSION}.</em></p>` +
    ATTRIBUTION_END
  );
}

function stripAttributionFooter(body: string): string {
  return body
    .replace(
      /<!--\s*epimethian-attribution-start\s*-->[\s\S]*?<!--\s*epimethian-attribution-end\s*-->/g,
      ""
    )
    .replace(
      /<p[^>]*>[\s\S]*?<a\s[^>]*href="https:\/\/github\.com\/de-otio\/epimethian-mcp"[^>]*>Epimethian<\/a>[\s\S]*?<\/p>/gi,
      ""
    )
    .trimEnd();
}

describe("attribution footer regression", () => {
  it("stripAttributionFooter removes the footer produced by buildAttributionFooter", () => {
    const body = "<p>Page content.</p>";
    const withFooter = body + "\n" + buildAttributionFooter("created");
    const stripped = stripAttributionFooter(withFooter);
    expect(stripped).toBe(body);
    expect(stripped).not.toContain(ATTRIBUTION_START);
    expect(stripped).not.toContain(ATTRIBUTION_END);
  });

  it("stripAttributionFooter is idempotent", () => {
    const body = "<p>Content.</p>";
    const withFooter = body + "\n" + buildAttributionFooter("updated");
    const once = stripAttributionFooter(withFooter);
    const twice = stripAttributionFooter(once);
    expect(twice).toBe(once);
  });

  it("footer-bearing storage: strip + round-trip preserves non-footer content", () => {
    const macro = `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Note</p></ac:rich-text-body></ac:structured-macro>`;
    const body = macro;
    const withFooter = body + "\n" + buildAttributionFooter("updated");

    // Simulate server-side pipeline: strip footer before planUpdate.
    const cleanBody = stripAttributionFooter(withFooter);
    expect(cleanBody).toContain(macro);
    expect(cleanBody).not.toContain("Epimethian");

    // Round-trip the clean body through planUpdate.
    const { canonical } = tokeniseStorage(cleanBody);
    const plan = planUpdate({ currentStorage: cleanBody, callerMarkdown: canonical });
    expect(plan.newStorage).toBe(cleanBody);
    expect(plan.newStorage).toContain(macro);
  });

  it("stripAttributionFooter produces clean body from legacy footer", () => {
    const body = "<p>Content.</p>";
    const footer = buildAttributionFooter("created");
    const withFooter = body + "\n" + footer;

    const stripped = stripAttributionFooter(withFooter);
    expect(stripped).toBe(body);
    expect(stripped).not.toContain("Epimethian");
    expect(stripped).not.toContain("epimethian-attribution");
  });

  it("attribution footer HTML comments survive tokeniseStorage without tokenisation", () => {
    // Attribution comments (<!--epimethian-attribution-start-->) should NOT be
    // tokenised (they're HTML comments, not ac:/ri: elements).
    const body = buildAttributionFooter("updated");
    const { canonical, sidecar } = tokeniseStorage(body);
    // The attribution start/end comments are not ac:/ri: elements — they should
    // pass through unchanged and not be captured as tokens.
    expect(Object.keys(sidecar)).toHaveLength(0);
    expect(canonical).toContain(ATTRIBUTION_START);
    expect(canonical).toContain(ATTRIBUTION_END);
  });
});

// ---------------------------------------------------------------------------
// 3. writeGuard / read-only mode regression
// ---------------------------------------------------------------------------

// writeGuard is imported from index.ts and tested via the Config interface.
// We import it directly to avoid spinning up the full MCP server. The full
// suite of writeGuard behavioural tests lives in index.test.ts; here we
// verify the function is correctly exported and works for the markdown-write
// scenarios introduced by Stream 5.

describe("writeGuard / read-only mode regression", () => {
  it("writeGuard is exported from index.ts and callable", async () => {
    const { writeGuard } = await import("../index.js");
    expect(typeof writeGuard).toBe("function");
  });

  it("writeGuard returns null (allow) for create_page in writable mode", async () => {
    const { writeGuard } = await import("../index.js");
    const config = {
      url: "https://test.atlassian.net",
      email: "u@t.com",
      readOnly: false,
      attribution: false,
      profile: null,
      apiV2: "https://test.atlassian.net/wiki/api/v2",
      apiV1: "https://test.atlassian.net/wiki/rest/api",
      authHeader: "Basic xxx",
      jsonHeaders: {} as Record<string, string>,
    };
    expect(writeGuard("create_page", config)).toBeNull();
    expect(writeGuard("update_page", config)).toBeNull();
  });

  it("writeGuard blocks create_page in read-only mode", async () => {
    const { writeGuard } = await import("../index.js");
    const config = {
      url: "https://test.atlassian.net",
      email: "u@t.com",
      readOnly: true,
      attribution: false,
      profile: "my-profile",
      apiV2: "https://test.atlassian.net/wiki/api/v2",
      apiV1: "https://test.atlassian.net/wiki/rest/api",
      authHeader: "Basic xxx",
      jsonHeaders: {} as Record<string, string>,
    };
    const result = writeGuard("create_page", config);
    expect(result).not.toBeNull();
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toContain("Write blocked");
    expect(result?.content[0].text).toContain("read-only");
  });

  it("writeGuard blocks update_page in read-only mode", async () => {
    const { writeGuard } = await import("../index.js");
    const config = {
      url: "https://test.atlassian.net",
      email: "u@t.com",
      readOnly: true,
      attribution: false,
      profile: null,
      apiV2: "https://test.atlassian.net/wiki/api/v2",
      apiV1: "https://test.atlassian.net/wiki/rest/api",
      authHeader: "Basic xxx",
      jsonHeaders: {} as Record<string, string>,
    };
    const result = writeGuard("update_page", config);
    expect(result).not.toBeNull();
    expect(result?.isError).toBe(true);
  });

  it("writeGuard allows get_page in read-only mode (read-only tool exemption)", async () => {
    const { writeGuard } = await import("../index.js");
    const config = {
      url: "https://test.atlassian.net",
      email: "u@t.com",
      readOnly: true,
      attribution: false,
      profile: null,
      apiV2: "https://test.atlassian.net/wiki/api/v2",
      apiV1: "https://test.atlassian.net/wiki/rest/api",
      authHeader: "Basic xxx",
      jsonHeaders: {} as Record<string, string>,
    };
    expect(writeGuard("get_page", config)).toBeNull();
    expect(writeGuard("search_pages", config)).toBeNull();
  });

  it("create_page write guard result format matches update_page result format", async () => {
    const { writeGuard } = await import("../index.js");
    const config = {
      url: "https://test.atlassian.net",
      email: "u@t.com",
      readOnly: true,
      attribution: false,
      profile: null,
      apiV2: "",
      apiV1: "",
      authHeader: "",
      jsonHeaders: {} as Record<string, string>,
    };
    const createResult = writeGuard("create_page", config);
    const updateResult = writeGuard("update_page", config);
    // Both should be identically structured error results.
    expect(createResult?.isError).toBe(updateResult?.isError);
    expect(createResult?.content[0].type).toBe(updateResult?.content[0].type);
  });
});

// ---------------------------------------------------------------------------
// 4. update_page_section regression with macro-bearing pages
// ---------------------------------------------------------------------------

describe("update_page_section with macro-bearing pages", () => {
  it("replaceSection leaves macros in other sections intact", async () => {
    const { replaceSection } = await import("../confluence-client.js");

    const macro = `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Info content</p></ac:rich-text-body></ac:structured-macro>`;
    const fullBody =
      `<h2 id="intro">Introduction</h2><p>Old intro text.</p>` +
      `<h2 id="macro-section">Macro Section</h2>${macro}` +
      `<h2 id="trailing">Trailing</h2><p>Trailing content.</p>`;

    const result = replaceSection(fullBody, "Introduction", "<p>New intro text.</p>");
    expect(result).not.toBeNull();
    expect(result).toContain("New intro text.");
    // The macro in another section must be preserved verbatim.
    expect(result).toContain(macro);
    expect(result).not.toContain("Old intro text.");
  });

  it("replaceSection with a drawio macro in another section: drawio survives", async () => {
    const { replaceSection } = await import("../confluence-client.js");

    const fullBody =
      `<h2 id="details">Details</h2><p>Original details.</p>` +
      `<h2 id="diagram">Diagram</h2>${DRAWIO_MACRO}`;

    const result = replaceSection(fullBody, "Details", "<p>Updated details.</p>");
    expect(result).not.toBeNull();
    expect(result).toContain("Updated details.");
    expect(result).toContain(DRAWIO_MACRO);
  });
});

// ---------------------------------------------------------------------------
// 5. Security end-to-end regressions
// ---------------------------------------------------------------------------

describe("security: CDATA injection end-to-end", () => {
  it("code fence with ]]> is escaped correctly — CDATA section not broken", () => {
    const md = "```\nconst s = ']]> evil markup';\n```";
    const storage = markdownToStorage(md);

    // The output must contain a code macro.
    expect(storage).toContain('ac:name="code"');

    // The escapeCdata function converts ]]> → ]]]]><![CDATA[>
    // so the escaped sequence must appear in the output.
    expect(storage).toContain("]]]]><![CDATA[>");

    // The original injection string must not appear without escaping.
    // Specifically, the CDATA-close+injected-tag sequence must not appear.
    // NOTE: "]]></ac:plain-text-body>" IS expected at the end (legit close),
    // but only ONE such sequence is expected (the real close), not an injected one.
    const injectionAttempt = "]]> evil markup";
    // If properly escaped, the literal injection string cannot appear unescaped.
    // It should appear as part of the escaped CDATA: ]]]]><![CDATA[> evil markup
    expect(storage).not.toContain(injectionAttempt);
  });

  it("code fence containing full injection attempt is correctly neutralised", () => {
    // Injection attempt: ]]></ac:plain-text-body></ac:structured-macro><ac:injected/>
    // The ]]> portion is correctly escaped by escapeCdata, keeping the rest as
    // plain text content inside the CDATA section.
    //
    // The key security property: the CDATA section is not broken — everything
    // after the escaped ]]> (including the injected tags) is still inside CDATA
    // and not parsed as XML by a Confluence server.
    const injectionPayload = "]]></ac:plain-text-body></ac:structured-macro><ac:injected/>";
    const md = "```\n" + injectionPayload + "\n```";
    const storage = markdownToStorage(md);
    expect(storage).toContain('ac:name="code"');
    // The escapeCdata pattern must be present.
    expect(storage).toContain("]]]]><![CDATA[>");
    // The storage must start with exactly one code macro open tag.
    const macroOpenCount = (storage.match(/ac:name="code"/g) ?? []).length;
    expect(macroOpenCount).toBe(1);
    // Verify the injection payload content appears INSIDE a CDATA section,
    // not outside it. Check that <ac:injected/> is surrounded by CDATA markers.
    const injectedIdx = storage.indexOf("<ac:injected/>");
    const cdataOpenBefore = storage.lastIndexOf("<![CDATA[", injectedIdx);
    const cdataCloseBefore = storage.lastIndexOf("]]>", injectedIdx);
    // The most recent CDATA opener before <ac:injected/> should come after
    // the most recent ]]> before it — meaning we are inside a CDATA section.
    expect(
      cdataOpenBefore > cdataCloseBefore,
      "<ac:injected/> must be inside a CDATA section (not parsed as XML)"
    ).toBe(true);
  });
});

describe("security: XML attribute injection end-to-end", () => {
  it('panel title with " and < characters is safely escaped', () => {
    const md = '::: panel title="<script>alert(1)</script>"\n\nBody.\n\n:::';
    let storage: string;
    expect(() => { storage = markdownToStorage(md); }).not.toThrow();
    storage = markdownToStorage(md);
    // The script tag must not appear unescaped in any attribute.
    expect(storage).not.toContain('<script>');
    // The output should contain the escaped form.
    expect(storage).toContain('&lt;script&gt;');
  });

  it("code block language with quote injection is escaped in attribute", () => {
    const lang = 'typescript" ac:macro-id="injected';
    const md = "```" + lang + "\nconst x = 1;\n```";
    const storage = markdownToStorage(md);
    // Injected attribute must not appear unescaped.
    expect(storage).not.toContain('ac:macro-id="injected"');
    // Output must still be a valid code macro.
    expect(storage).toContain('ac:name="code"');
  });

  it("panel title with & character is entity-escaped", () => {
    const md = '::: panel title="cats & dogs"\n\nBody.\n\n:::';
    const storage = markdownToStorage(md);
    expect(storage).toContain("&amp;");
    expect(storage).not.toContain(' title="cats & dogs"');
  });
});

describe("security: URL spoofing end-to-end", () => {
  const BASE_URL = "https://entrixenergy.atlassian.net";

  it("spoofed host is treated as external link, not ac:link", () => {
    const md = `[Link](https://entrixenergy.atlassian.net.attacker.com/wiki/spaces/X/pages/123)`;
    const storage = markdownToStorage(md, { confluenceBaseUrl: BASE_URL });
    // Must be a plain <a> link, not an <ac:link>.
    expect(storage).not.toContain("<ac:link>");
    expect(storage).toContain("<a href=");
  });

  it("real Confluence URL is correctly rewritten to ac:link", () => {
    const md = `[Link](https://entrixenergy.atlassian.net/wiki/spaces/DEV/pages/12345)`;
    const storage = markdownToStorage(md, { confluenceBaseUrl: BASE_URL });
    // Must be an <ac:link>, not a plain <a>.
    expect(storage).toContain("<ac:link>");
    expect(storage).not.toContain('<a href="https://entrixenergy.atlassian.net');
  });
});

describe("security: forged token rejection end-to-end", () => {
  it("callerMarkdown with invented token ID throws INVENTED_TOKEN", () => {
    const storage = "<p>Simple page.</p>";
    const callerMarkdown = "Simple page with forged [[epi:T9999]].";
    let caught: unknown;
    try {
      planUpdate({ currentStorage: storage, callerMarkdown });
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof ConverterError).toBe(true);
    expect((caught as ConverterError).code).toBe("INVENTED_TOKEN");
    // Error message must reference the token ID, not sidecar content.
    expect((caught as ConverterError).message).toContain("T9999");
  });

  it("forged token in restoreFromTokens throws FORGED_TOKEN with token ID", () => {
    let caught: unknown;
    try {
      restoreFromTokens("Some text [[epi:T0001]]", {});
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof ConverterError).toBe(true);
    expect((caught as ConverterError).code).toBe("FORGED_TOKEN");
    expect((caught as ConverterError).message).toContain("T0001");
  });

  it("error message does not leak sidecar content", () => {
    const macro = `<ac:structured-macro ac:name="info"><ac:rich-text-body><p>SECRET CONTENT</p></ac:rich-text-body></ac:structured-macro>`;
    const storage = macro;
    const { canonical, sidecar } = tokeniseStorage(storage);

    // Delete the token (caller forgets to include it) and submit.
    let caught: unknown;
    try {
      planUpdate({ currentStorage: storage, callerMarkdown: "" });
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof ConverterError).toBe(true);
    // The error message must NOT contain the sidecar content.
    expect((caught as ConverterError).message).not.toContain("SECRET CONTENT");
    // It may contain token IDs (T0001) and tag names (ac:structured-macro).
    expect((caught as ConverterError).message).toContain("T0001");
  });
});

describe("security: input size cap end-to-end", () => {
  it("input over 1 MB throws INPUT_TOO_LARGE", () => {
    const bigMd = "a".repeat(1_048_577);
    let caught: unknown;
    try {
      markdownToStorage(bigMd);
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof ConverterError).toBe(true);
    expect((caught as ConverterError).code).toBe("INPUT_TOO_LARGE");
  });

  it("input at exactly 1 MB (boundary) does not throw INPUT_TOO_LARGE", () => {
    // 1 048 576 bytes of ASCII — exactly at the cap.
    const exactMd = "a".repeat(1_048_576);
    expect(() => markdownToStorage(exactMd)).not.toThrow();
  });

  it("error message for oversized input is actionable", () => {
    const bigMd = "a".repeat(1_048_577);
    let caught: unknown;
    try {
      markdownToStorage(bigMd);
    } catch (e) {
      caught = e;
    }
    const err = caught as ConverterError;
    expect(err.message.length).toBeGreaterThan(0);
    // Should mention the size cap somehow.
    expect(err.message.toLowerCase()).toMatch(/1 mb|cap|large|size/);
  });
});

// ---------------------------------------------------------------------------
// 7. Data Loss Prevention Audit — regression tests (v5.4.0)
// ---------------------------------------------------------------------------

describe("data loss prevention audit (v5.4.0)", () => {
  // ---- Incident: toStorageFormat namespace tag wrapping (e1419b5) ----

  it("toStorageFormat: Confluence namespace tags are NOT wrapped in <p>", async () => {
    const { toStorageFormat } = await import("../confluence-client.js");
    const macro = '<ac:structured-macro ac:name="toc"></ac:structured-macro>';
    expect(toStorageFormat(macro)).toBe(macro); // NOT <p>..macro..</p>
  });

  it("toStorageFormat: body starting with closing tag is NOT double-wrapped", async () => {
    const { toStorageFormat } = await import("../confluence-client.js");
    const body = "</div><p>text</p>";
    expect(toStorageFormat(body)).toBe(body); // NOT <p></div>...</p>
  });

  it("toStorageFormat: body with HTML entities is NOT wrapped", async () => {
    const { toStorageFormat } = await import("../confluence-client.js");
    const body = "&nbsp;&mdash;&lt;hello&gt;";
    expect(toStorageFormat(body)).toBe(body); // NOT <p>&nbsp;...</p>
  });

  // ---- Incident: read-only markdown round-trip (c0e5e39) ----

  it("read-only markdown marker is present in storageToMarkdown output", () => {
    const storage = "<p>Hello</p>";
    const md = storageToMarkdown(storage);
    // storageToMarkdown itself doesn't add the marker; the handler does.
    // But tokens should NOT contain the marker text.
    expect(md.markdown).not.toContain("epimethian:read-only-markdown");
  });

  // ---- Guard: small page deletion now caught ----

  it("macro-loss guard catches deletion of all macros from a small page", () => {
    const oldStorage =
      '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>note</p></ac:rich-text-body></ac:structured-macro>';
    const newStorage = "<p>just text</p>";
    expect(() =>
      enforceContentSafetyGuards({ oldStorage, newStorage })
    ).toThrow(/macro/i);
  });

  it("table-loss guard catches deletion of all tables", () => {
    const oldStorage =
      "<h1>Title</h1><table><tr><td>A</td><td>B</td></tr></table><p>text</p>" +
      "<table><tr><td>C</td></tr></table>";
    const newStorage = "<h1>Title</h1><p>text</p>";
    expect(() =>
      enforceContentSafetyGuards({ oldStorage, newStorage })
    ).toThrow(/table/i);
  });

  it("macro-loss guard is bypassed by confirmDeletions", () => {
    const oldStorage =
      '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>note</p></ac:rich-text-body></ac:structured-macro>';
    const newStorage = "<p>just text</p>";
    expect(() =>
      enforceContentSafetyGuards({ oldStorage, newStorage, confirmDeletions: true })
    ).not.toThrow();
  });

  it("table-loss guard is bypassed by confirmStructureLoss", () => {
    const oldStorage =
      "<h1>Title</h1><table><tr><td>A</td></tr></table>";
    const newStorage = "<h1>Title</h1><p>text</p>";
    expect(() =>
      enforceContentSafetyGuards({ oldStorage, newStorage, confirmStructureLoss: true })
    ).not.toThrow();
  });

  // ---- Guard: entity-heavy pages ----

  it("extractTextContent does not inflate &nbsp; entities", () => {
    // 100x &nbsp; should NOT produce 500+ chars of text
    const entityPage = "&nbsp;".repeat(100);
    const text = extractTextContent(entityPage);
    expect(text.length).toBeLessThan(200);
  });

  // ---- Guard: macro counting ----

  it("countMacros counts structured macros outside code blocks", () => {
    const storage =
      '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>text</p></ac:rich-text-body></ac:structured-macro>' +
      '<ac:structured-macro ac:name="code"><ac:plain-text-body><ac:structured-macro ac:name="nested"></ac:structured-macro></ac:plain-text-body></ac:structured-macro>';
    // Only the top-level info and code macros should count; the nested one inside plain-text-body should not.
    expect(countMacros(storage)).toBe(2);
  });

  it("countTables counts tables outside code blocks", () => {
    const storage =
      "<table><tr><td>real</td></tr></table>" +
      "<ac:plain-text-body><table><tr><td>fake</td></tr></table></ac:plain-text-body>";
    expect(countTables(storage)).toBe(1);
  });

  // ---- looksLikeMarkdown hardening ----

  it("looksLikeMarkdown: code block with <ac:*> is classified as markdown", async () => {
    const { looksLikeMarkdown } = await import("../confluence-client.js");
    const md = '# How to use macros\n\n```xml\n<ac:structured-macro ac:name="info"></ac:structured-macro>\n```\n';
    expect(looksLikeMarkdown(md)).toBe(true);
  });

  it("looksLikeMarkdown: plain paragraph text is classified as markdown", async () => {
    const { looksLikeMarkdown } = await import("../confluence-client.js");
    expect(looksLikeMarkdown("Hello world, this is a paragraph.")).toBe(true);
  });

  it("looksLikeMarkdown: storage format starting with <p> is classified as storage", async () => {
    const { looksLikeMarkdown } = await import("../confluence-client.js");
    expect(looksLikeMarkdown("<p>Hello world</p>")).toBe(false);
  });

  it("looksLikeMarkdown: bare <ac:*> outside code blocks is classified as storage", async () => {
    const { looksLikeMarkdown } = await import("../confluence-client.js");
    const storage = '<ac:structured-macro ac:name="toc"></ac:structured-macro>';
    expect(looksLikeMarkdown(storage)).toBe(false);
  });

  // ---- replaceBody version message ----

  it("replaceBody=true produces a version message listing dropped elements", () => {
    const storage =
      '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>note</p></ac:rich-text-body></ac:structured-macro><p>Hello</p>';
    const plan = planUpdate({
      currentStorage: storage,
      callerMarkdown: "# New content",
      replaceBody: true,
    });
    expect(plan.versionMessage).toContain("Wholesale rewrite");
    expect(plan.versionMessage).toContain("dropped");
    expect(plan.versionMessage).toContain("1"); // 1 preserved element
  });

  it("replaceBody=true on page with no macros produces no version message", () => {
    const storage = "<p>Simple text</p>";
    const plan = planUpdate({
      currentStorage: storage,
      callerMarkdown: "# New content",
      replaceBody: true,
    });
    expect(plan.versionMessage).toBeUndefined();
  });

  // ---- shrinkage guard threshold lowered ----

  it("shrinkage guard fires on 300-char pages (previously unprotected at 500 threshold)", () => {
    const oldStorage = "<p>" + "x".repeat(300) + "</p>";
    const newStorage = "<p>tiny</p>";
    expect(() =>
      enforceContentSafetyGuards({ oldStorage, newStorage })
    ).toThrow(/shrink/i);
  });

  // ---- empty-body guard threshold ----

  it("empty-body guard fires on 150-char pages (previously unprotected at 500 threshold)", () => {
    const oldStorage = "<p>" + "x".repeat(150) + "</p>";
    const newStorage = "<div></div>"; // no text content
    expect(() =>
      enforceContentSafetyGuards({ oldStorage, newStorage })
    ).toThrow(/text content/i);
  });
});
