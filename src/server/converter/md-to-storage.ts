/**
 * GFM markdown → Confluence storage format converter.
 *
 * Uses markdown-it with a security-conservative configuration
 * (html: false by default), GFM extensions, and post-processing to
 * emit Confluence-native macros where appropriate (code blocks, ac:link
 * rewriting for Confluence URLs, allowlisted raw passthrough).
 *
 * Stream 2: full implementation.
 */

import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import { randomUUID } from "crypto";
import { escapeXmlAttr, escapeCdata } from "./escape.js";
import { parseConfluenceUrl } from "./url-parser.js";
import { isMacroAllowed } from "./allowlist.js";
import { ConverterError, type ConverterOptions } from "./types.js";

/** Hard size cap: 1 MB. */
const MAX_INPUT_BYTES = 1_048_576;

/**
 * Self-close void HTML elements that Confluence storage format requires as
 * self-closing XHTML (br, hr, img, input).
 */
function selfCloseVoidElements(html: string): string {
  // Match opening tags for void elements that are NOT already self-closed.
  return html.replace(/<(br|hr|img|input)(\s[^>]*)?>(?!\s*<\/\1>)/gi, (_match, tag, attrs) => {
    const a = attrs ?? "";
    return `<${tag}${a}/>`;
  });
}

/**
 * Extract the macro name from an opening <ac:structured-macro ...> tag.
 * Returns null if not found.
 */
function extractMacroName(tag: string): string | null {
  const m = tag.match(/ac:name="([^"]+)"/);
  return m ? m[1] : null;
}

/**
 * Validate raw <ac:structured-macro> tags embedded in the output.
 * Throws ConverterError for disallowed macros; passes everything else
 * through unchanged.
 *
 * This is called after the raw passthrough blocks have been restored.
 */
function validateRawPassthrough(html: string): string {
  // Find all <ac:structured-macro ...> tags and validate their names.
  const macroTagRe = /<ac:structured-macro\s+[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = macroTagRe.exec(html)) !== null) {
    const name = extractMacroName(match[0]);
    if (name !== null && !isMacroAllowed(name)) {
      throw new ConverterError(
        `Macro '${name}' is not in the allowlist for raw passthrough. Use the markdown shim instead, or contact maintainers to allowlist this macro.`,
        "MACRO_NOT_ALLOWED"
      );
    }
  }
  return html;
}

/**
 * Extract raw <ac:...> and <ri:...> blocks from markdown before markdown-it
 * processes them. These blocks would otherwise be escaped or mangled.
 *
 * Returns the markdown with ac:/ri: blocks replaced by unique placeholder
 * tokens, plus a map from placeholder → original block.
 *
 * Detection: any contiguous run of lines that starts with <ac: or <ri:
 * (at the start of the line) and ends when we reach the matching close tag.
 */
function extractRawAcBlocks(
  md: string
): { processed: string; blocks: Map<string, string> } {
  const blocks = new Map<string, string>();
  let idx = 0;

  const lines = md.split("\n");
  const outputLines: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Detect the start of a raw ac:/ri: block.
    if (/^<ac:|^<ri:/i.test(line.trimStart())) {
      // Collect lines until the matching close tag.
      // Strategy: collect lines until we see a line that ends a top-level tag.
      // Specifically, look for a line that ends with </ac:...> or is self-closing.
      const blockLines: string[] = [];
      const startLine = line;

      // Extract top-level tag name from the opening tag.
      const openTagMatch = startLine.match(/^<(ac:[a-zA-Z0-9:_-]+|ri:[a-zA-Z0-9:_-]+)/i);
      const topLevelTag = openTagMatch ? openTagMatch[1] : null;

      blockLines.push(line);
      i++;

      if (topLevelTag) {
        // Collect until we see the closing tag for this top-level element.
        const closePattern = new RegExp(`</${escapeRegex(topLevelTag)}\\s*>`, "i");
        while (i < lines.length) {
          blockLines.push(lines[i]);
          if (closePattern.test(lines[i])) {
            i++;
            break;
          }
          i++;
        }
      }

      const raw = blockLines.join("\n");
      const placeholder = `@@@EPIACBLOCK${idx++}@@@`;
      blocks.set(placeholder, raw);
      // Emit the placeholder as a paragraph by itself so markdown-it
      // treats it as a block element.
      outputLines.push(placeholder);
    } else {
      outputLines.push(line);
      i++;
    }
  }

  return { processed: outputLines.join("\n"), blocks };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Preprocess markdown to handle confluence:// scheme links.
 *
 * markdown-it's linkify doesn't recognise custom schemes and won't turn
 * [text](confluence://...) into an <a href>. We pre-render these to
 * ac:link XML before markdown-it sees them, using placeholder tokens,
 * then restore after rendering.
 */
function extractConfluenceSchemeLinks(
  md: string
): { processed: string; links: Map<string, string> } {
  const links = new Map<string, string>();
  let idx = 0;

  // Match markdown links with confluence:// scheme: [text](confluence://...)
  const processed = md.replace(
    /\[([^\]]*)\]\((confluence:\/\/[^)]*)\)/g,
    (_match, text, href) => {
      const rest = href.slice("confluence://".length);
      const slashIdx = rest.indexOf("/");
      if (slashIdx === -1) return _match;

      const spaceKey = rest.slice(0, slashIdx);
      let pageTitle: string;
      try {
        pageTitle = decodeURIComponent(rest.slice(slashIdx + 1));
      } catch {
        pageTitle = rest.slice(slashIdx + 1);
      }

      const acLink =
        `<ac:link>` +
        `<ri:page ri:space-key="${escapeXmlAttr(spaceKey)}" ri:content-title="${escapeXmlAttr(pageTitle)}"/>` +
        `<ac:plain-text-link-body><![CDATA[${escapeCdata(text)}]]></ac:plain-text-link-body>` +
        `</ac:link>`;

      const placeholder = `@@@EPICONFLINK${idx++}@@@`;
      links.set(placeholder, acLink);
      return placeholder;
    }
  );

  return { processed, links };
}

/**
 * Rewrite <a href="..."> links to <ac:link> when the URL is recognised as an
 * internal Confluence page link. External links are left unchanged.
 */
function rewriteConfluenceLinks(html: string, confluenceBaseUrl: string): string {
  return html.replace(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (fullMatch, href, innerHtml) => {
    // Strip tags from inner HTML to get display text.
    const displayText = innerHtml.replace(/<[^>]+>/g, "");

    const ref = parseConfluenceUrl(href, confluenceBaseUrl);
    if (!ref) return fullMatch;

    let riPage = `<ri:page ri:content-id="${escapeXmlAttr(ref.contentId)}"`;
    if (ref.spaceKey) {
      riPage += ` ri:space-key="${escapeXmlAttr(ref.spaceKey)}"`;
    }
    riPage += "/>";

    let link = `<ac:link>`;
    if (ref.anchor) {
      link += `<ri:anchor ri:value="${escapeXmlAttr(ref.anchor)}"/>`;
    }
    link +=
      riPage +
      `<ac:plain-text-link-body><![CDATA[${escapeCdata(displayText)}]]></ac:plain-text-link-body>` +
      `</ac:link>`;
    return link;
  });
}

/**
 * Parse the fence info string to extract language and optional parameters.
 *
 * Handles:
 *   language
 *   language title=value
 *   language title="value with spaces"
 *   language title='value with spaces'
 */
function parseFenceInfo(info: string): { language: string; title: string } {
  const trimmed = info.trim();
  if (!trimmed) return { language: "", title: "" };

  // Split on first whitespace to get the language.
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) {
    return { language: trimmed, title: "" };
  }

  const language = trimmed.slice(0, firstSpace);
  const rest = trimmed.slice(firstSpace + 1).trim();

  let title = "";

  // Parse key=value pairs, handling quoted values.
  const keyValRe = /([a-zA-Z_][a-zA-Z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = keyValRe.exec(rest)) !== null) {
    const key = m[1];
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    if (key === "title") {
      title = value;
    }
  }

  return { language, title };
}

/**
 * Override the default markdown-it fence renderer to emit Confluence code macros.
 */
function buildFenceRenderer(): MarkdownIt.Renderer.RenderRule {
  return function (tokens, idx) {
    const token = tokens[idx];
    const info = token.info ?? "";
    const { language, title } = parseFenceInfo(info);

    const macroId = randomUUID();
    const body = token.content;

    let macro = `<ac:structured-macro ac:name="code" ac:schema-version="1" ac:macro-id="${escapeXmlAttr(macroId)}">`;

    if (language) {
      macro += `<ac:parameter ac:name="language">${escapeXmlAttr(language)}</ac:parameter>`;
    }
    if (title) {
      macro += `<ac:parameter ac:name="title">${escapeXmlAttr(title)}</ac:parameter>`;
    }

    macro += `<ac:plain-text-body><![CDATA[${escapeCdata(body)}]]></ac:plain-text-body>`;
    macro += `</ac:structured-macro>`;

    return macro;
  };
}

/**
 * Convert a markdown string to Confluence storage format XHTML.
 *
 * @throws ConverterError on any input that would lose data, exceed
 *   the size cap, or violate security mitigations
 */
export function markdownToStorage(md: string, opts?: ConverterOptions): string {
  // --- Input validation ---
  if (md === null || md === undefined) {
    throw new ConverterError("Input must be a string", "INVALID_INPUT");
  }
  if (typeof md !== "string") {
    throw new ConverterError("Input must be a string", "INVALID_INPUT");
  }

  // Size cap: reject inputs >1 MB.
  const byteLength = Buffer.byteLength(md, "utf8");
  if (byteLength > MAX_INPUT_BYTES) {
    throw new ConverterError("input exceeds 1 MB cap", "INPUT_TOO_LARGE");
  }

  // --- Pre-processing: extract raw ac:/ri: blocks before markdown-it ---
  // These need to be pulled out before markdown-it escapes their angle-brackets.
  const { processed: mdWithoutAcBlocks, blocks: acBlocks } = extractRawAcBlocks(md);

  // Pre-process confluence:// scheme links into ac:link XML (stored in placeholders).
  const { processed: mdWithoutConfluenceLinks, links: confluenceLinks } =
    extractConfluenceSchemeLinks(mdWithoutAcBlocks);

  // --- Build markdown-it instance ---
  const htmlEnabled = opts?.allowRawHtml === true;
  if (htmlEnabled) {
    console.warn(
      "[epimethian-mcp] markdownToStorage: allowRawHtml=true — raw HTML enabled for this conversion. " +
        "This option opens an XSS / macro-injection surface. Only enable for trusted callers."
    );
  }

  const mdi = new MarkdownIt({
    html: htmlEnabled,
    linkify: true,
    typographer: false,
    breaks: false,
    // markdown-it's built-in nesting limit (default 100). Keeping default.
    maxNesting: 100,
  });

  // Enable GFM extensions.
  mdi.enable("table");
  mdi.enable("strikethrough");

  // Task lists plugin.
  mdi.use(taskLists, { enabled: false });

  // Override fence renderer to emit Confluence code macros.
  mdi.renderer.rules.fence = buildFenceRenderer();

  // --- Render ---
  let html: string;
  try {
    html = mdi.render(mdWithoutConfluenceLinks);
  } catch (err) {
    if (err instanceof Error && err.message.includes("maxNesting")) {
      throw new ConverterError(`Nesting limit exceeded: ${err.message}`, "NESTING_EXCEEDED");
    }
    throw err;
  }

  // --- Post-processing ---

  // 1. Self-close void elements.
  html = selfCloseVoidElements(html);

  // 2. Rewrite internal Confluence links.
  if (opts?.confluenceBaseUrl) {
    html = rewriteConfluenceLinks(html, opts.confluenceBaseUrl);
  }

  // 3. Restore confluence:// scheme link placeholders.
  for (const [placeholder, acLink] of confluenceLinks) {
    // The placeholder may be inside a <p> tag if it appeared inline.
    // Replace it directly in the output.
    html = html.replace(placeholder, acLink);
  }

  // 4. Restore raw ac:/ri: block placeholders.
  for (const [placeholder, raw] of acBlocks) {
    // Placeholders appear as <p>@@@EPIACBLOCKN@@@</p> or similar.
    // Replace the whole paragraph containing the placeholder.
    html = html.replace(new RegExp(`<p>\\s*${escapeRegex(placeholder)}\\s*</p>`, "g"), raw);
    // Also replace bare placeholder (in case it was not wrapped in <p>).
    html = html.replace(placeholder, raw);
  }

  // 5. Validate raw <ac:...> passthrough (detect disallowed macros).
  if (html.includes("<ac:") || html.includes("<ri:")) {
    html = validateRawPassthrough(html);
  }

  return html;
}
