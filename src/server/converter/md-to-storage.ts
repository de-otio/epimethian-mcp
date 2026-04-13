/**
 * GFM markdown → Confluence storage format converter.
 *
 * Uses markdown-it with a security-conservative configuration
 * (html: false by default), GFM extensions, and post-processing to
 * emit Confluence-native macros where appropriate (code blocks, ac:link
 * rewriting for Confluence URLs, allowlisted raw passthrough).
 *
 * Stream 2: full implementation.
 * Streams 7-11: Phase 2 macro plugins (GitHub alerts, containers,
 *   inline directives, frontmatter/ToC, heading anchor slugger).
 */

import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import container from "markdown-it-container";
import matter from "gray-matter";
import { randomUUID } from "crypto";
import { escapeXmlAttr, escapeXmlText, escapeCdata } from "./escape.js";
import { parseConfluenceUrl } from "./url-parser.js";
import { isMacroAllowed } from "./allowlist.js";
import { isValidAccountId } from "./account-id-validator.js";
import { ConverterError, type ConverterOptions } from "./types.js";

/** Hard size cap: 1 MB. */
const MAX_INPUT_BYTES = 1_048_576;

// ---------------------------------------------------------------------------
// Stream 11 — Heading anchor slugger
// ---------------------------------------------------------------------------

/**
 * Confluence heading ID algorithm (observed from Confluence Cloud editor output
 * and documented community resources):
 *
 * 1. Take the plain-text of the heading (strip any HTML tags).
 * 2. Lowercase the text.
 * 3. Replace runs of non-alphanumeric characters with a single '-'.
 * 4. Collapse multiple '-' into one (already handled by step 3 if the run
 *    replacement is greedy, but we do it explicitly for safety).
 * 5. Trim leading and trailing '-'.
 * 6. Handle duplicates on the same page by appending '.1', '.2', etc.
 *    (Confluence uses a dot-number suffix, not the GitHub #-2, #-3 style.)
 *
 * This function returns a NEW slugger instance (call factory once per page
 * render) to track duplicate heading IDs within the page.
 */
function createHeadingSlugger(): (text: string) => string {
  const seen = new Map<string, number>();

  return function slugify(text: string): string {
    // Strip any HTML tags to get plain text.
    const plain = text.replace(/<[^>]+>/g, "");

    // Lowercase.
    let slug = plain.toLowerCase();

    // Replace runs of non-alphanumeric characters with a single '-'.
    slug = slug.replace(/[^a-z0-9]+/g, "-");

    // Trim leading and trailing '-'.
    slug = slug.replace(/^-+|-+$/g, "");

    if (!slug) {
      slug = "heading";
    }

    // Handle duplicates: first occurrence = bare slug; subsequent = slug.N.
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);

    if (count === 0) {
      return slug;
    }
    return `${slug}.${count}`;
  };
}

// ---------------------------------------------------------------------------
// Stream 7 — GitHub-alert panel syntax
// ---------------------------------------------------------------------------

/**
 * Mapping from GitHub alert type keyword to Confluence macro name.
 */
const ALERT_TYPE_MAP: Record<string, string> = {
  INFO: "info",
  NOTE: "note",
  WARNING: "warning",
  TIP: "tip",
  SUCCESS: "success",
};

/**
 * Apply GitHub-style alert blockquote rule to a markdown-it instance.
 *
 * Recognises:  > [!TYPE]
 *              > [!TYPE] Optional title
 *
 * The `[!TYPE]` marker must appear on the FIRST line of the blockquote's
 * first paragraph. Two formats are handled:
 *
 * 1. Compact (no empty line between marker and body):
 *    > [!INFO]
 *    > Body content.
 *    → The first inline token has content `[!INFO]\nBody content.`
 *      The body is the text after the first newline, rendered as a paragraph.
 *
 * 2. Separated (empty line between marker and body):
 *    > [!INFO]
 *    >
 *    > Body content.
 *    → The first inline token has content `[!INFO]`; body is in subsequent
 *      paragraph tokens.
 *
 * Implementation: core rule that inspects blockquote tokens and rewrites to
 * a raw html_block containing the Confluence macro XML.
 */
function applyGitHubAlertRule(mdi: MarkdownIt): void {
  mdi.core.ruler.push("github_alerts", (state) => {
    const tokens = state.tokens;
    let i = 0;
    while (i < tokens.length) {
      if (tokens[i].type !== "blockquote_open") {
        i++;
        continue;
      }

      // Find the matching blockquote_close.
      const bqOpen = i;
      let bqClose = -1;
      let depth = 0;
      for (let j = i; j < tokens.length; j++) {
        if (tokens[j].type === "blockquote_open") depth++;
        if (tokens[j].type === "blockquote_close") {
          depth--;
          if (depth === 0) {
            bqClose = j;
            break;
          }
        }
      }
      if (bqClose === -1) {
        i++;
        continue;
      }

      // Look for the first inline token inside the blockquote to detect [!TYPE].
      let firstInlineIdx = -1;
      for (let j = bqOpen + 1; j < bqClose; j++) {
        if (tokens[j].type === "inline") {
          firstInlineIdx = j;
          break;
        }
      }

      if (firstInlineIdx === -1) {
        i++;
        continue;
      }

      const firstInline = tokens[firstInlineIdx];
      // The inline content may be "[!INFO]" or "[!INFO] Optional title"
      // or "[!INFO]\nBody text on same paragraph line".
      const alertMatch = firstInline.content.match(
        /^\[!(INFO|NOTE|WARNING|TIP|SUCCESS)\]([^\n]*)([\s\S]*)/i
      );

      if (!alertMatch) {
        i++;
        continue;
      }

      const alertType = alertMatch[1].toUpperCase();
      const macroName = ALERT_TYPE_MAP[alertType];
      if (!macroName) {
        i++;
        continue;
      }

      const rawTitle = alertMatch[2].trim();
      // Any text after the first line of the [!TYPE] marker is body content
      // that was on the same paragraph (compact format).
      const inlineBodyText = alertMatch[3].replace(/^\n/, "").trim();

      // Find the first paragraph_close to identify where body tokens start.
      let firstParaClose = -1;
      for (let j = bqOpen + 1; j < bqClose; j++) {
        if (tokens[j].type === "paragraph_close") {
          firstParaClose = j;
          break;
        }
      }

      // Body tokens: tokens after the first paragraph_close.
      const bodyTokens: MarkdownIt.Token[] = [];
      if (firstParaClose !== -1) {
        for (let j = firstParaClose + 1; j < bqClose; j++) {
          bodyTokens.push(tokens[j]);
        }
      }

      // Build body HTML.
      let bodyHtml = "";

      // Case 1: body text was on the same paragraph as [!TYPE] (compact format).
      // The inline body text is still inside the first inline token and needs
      // to be rendered as a paragraph.
      if (inlineBodyText) {
        // Use mdi.renderInline to process the inline body text properly —
        // this handles bold, italic, code, links, etc. inside alert bodies.
        // Wrap in <p> tags to form a block paragraph.
        bodyHtml += `<p>${mdi.renderInline(inlineBodyText, state.env)}</p>\n`;
      }

      // Case 2: body tokens from separate paragraphs.
      if (bodyTokens.length > 0) {
        bodyHtml += mdi.renderer.render(bodyTokens, mdi.options, state.env);
      }

      // Build the macro XML.
      let macro = `<ac:structured-macro ac:name="${macroName}" ac:schema-version="1">`;
      if (rawTitle) {
        macro += `<ac:parameter ac:name="title">${escapeXmlAttr(rawTitle)}</ac:parameter>`;
      }
      macro += `<ac:rich-text-body>${bodyHtml}</ac:rich-text-body>`;
      macro += `</ac:structured-macro>`;

      // Replace the entire blockquote token range with a single html_block token.
      const htmlToken = new state.Token("html_block", "", 0);
      htmlToken.content = macro;
      tokens.splice(bqOpen, bqClose - bqOpen + 1, htmlToken);

      // Don't advance i — the replacement token may be something else.
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Stream 8 — Container fenced divs (panel, expand, columns/column)
// ---------------------------------------------------------------------------

/**
 * Parse key=value pairs from a container params string.
 * Supports:  key="value with spaces"  key='value'  key=value
 */
function parseContainerParams(params: string): Record<string, string> {
  const result: Record<string, string> = {};
  // key="..." or key='...' or key=non-space
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(params)) !== null) {
    const key = m[1];
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    result[key] = value;
  }
  return result;
}

/**
 * Register container plugins on the markdown-it instance for panel and expand.
 * Columns are handled via a pre-processor (see extractColumnsBlocks) because
 * markdown-it-container does not correctly handle mixed-type nesting
 * (e.g. ::: columns containing ::: column), since the inner close marker :::
 * prematurely satisfies the outer container's end condition.
 */
function applyContainerPlugins(mdi: MarkdownIt): void {
  // --- panel ---
  mdi.use(container, "panel", {
    validate(params: string) {
      return params.trim().split(/\s/)[0] === "panel";
    },
    render(tokens: MarkdownIt.Token[], idx: number) {
      const token = tokens[idx];
      if (token.nesting === 1) {
        // Opening: parse params.
        const params = token.info.trim().slice("panel".length).trim();
        const kvs = parseContainerParams(params);

        let macro = `<ac:structured-macro ac:name="panel" ac:schema-version="1">`;
        if (kvs["title"]) {
          macro += `<ac:parameter ac:name="title">${escapeXmlAttr(kvs["title"])}</ac:parameter>`;
        }
        if (kvs["bgColor"]) {
          macro += `<ac:parameter ac:name="bgColor">${escapeXmlAttr(kvs["bgColor"])}</ac:parameter>`;
        }
        if (kvs["borderColor"]) {
          macro += `<ac:parameter ac:name="borderColor">${escapeXmlAttr(kvs["borderColor"])}</ac:parameter>`;
        }
        macro += `<ac:rich-text-body>`;
        return macro;
      } else {
        // Closing.
        return `</ac:rich-text-body></ac:structured-macro>`;
      }
    },
  });

  // --- expand ---
  mdi.use(container, "expand", {
    validate(params: string) {
      return params.trim().split(/\s/)[0] === "expand";
    },
    render(tokens: MarkdownIt.Token[], idx: number) {
      const token = tokens[idx];
      if (token.nesting === 1) {
        const params = token.info.trim().slice("expand".length).trim();
        const kvs = parseContainerParams(params);
        const macroId = randomUUID();

        let macro = `<ac:structured-macro ac:name="expand" ac:schema-version="1" ac:macro-id="${escapeXmlAttr(macroId)}">`;
        if (kvs["title"]) {
          macro += `<ac:parameter ac:name="title">${escapeXmlAttr(kvs["title"])}</ac:parameter>`;
        }
        macro += `<ac:rich-text-body>`;
        return macro;
      } else {
        return `</ac:rich-text-body></ac:structured-macro>`;
      }
    },
  });
}

/**
 * Pre-process ::: columns / ::: column blocks BEFORE markdown-it sees them.
 *
 * Rationale: markdown-it-container's nesting detection uses marker-count
 * matching without awareness of different container types. When ::: columns
 * contains ::: column blocks, the inner ::: close marker prematurely
 * satisfies the outer columns container's end scan, producing garbled output.
 *
 * We solve this by extracting the entire ::: columns ... ::: block via a
 * line-by-line scanner before markdown-it runs, converting each column's
 * body to HTML inline, and replacing the whole block with a single placeholder.
 *
 * The scanner uses an explicit depth counter to correctly pair open/close
 * markers regardless of nesting depth.
 */
function extractColumnsBlocks(
  md: string,
  mdi: MarkdownIt
): { processed: string; blocks: Map<string, string> } {
  const blocks = new Map<string, string>();
  let idx = 0;

  const lines = md.split("\n");
  const outputLines: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Detect `::: columns` opening line.
    if (/^:::\s+columns\b/.test(line.trim())) {
      const allBlockLines: string[] = [line];
      i++;
      let depth = 1;

      // Collect all lines until the matching `:::` close.
      while (i < lines.length && depth > 0) {
        const l = lines[i];
        if (/^:::\s+\w/.test(l.trim())) {
          depth++;
        } else if (/^:::$/.test(l.trim()) || /^:::\s*$/.test(l.trim())) {
          depth--;
        }
        allBlockLines.push(l);
        i++;
      }

      // Now parse the collected lines into column bodies.
      // The structure is:
      //   ::: columns
      //   ::: column
      //   ...body...
      //   :::
      //   ::: column
      //   ...body...
      //   :::
      //   :::
      const columnsXml = buildColumnsXml(allBlockLines, mdi);

      const placeholder = `@@@EPICOLUMNS${idx++}@@@`;
      blocks.set(placeholder, columnsXml);
      outputLines.push(placeholder);
    } else {
      outputLines.push(line);
      i++;
    }
  }

  return { processed: outputLines.join("\n"), blocks };
}

/**
 * Parse the collected lines of a ::: columns block and produce <ac:layout> XML.
 * Throws ConverterError if column count is not 2 or 3.
 */
function buildColumnsXml(lines: string[], mdi: MarkdownIt): string {
  // Extract column bodies: scan between ::: column ... ::: markers.
  const columnBodies: string[] = [];
  let j = 1; // skip the "::: columns" line

  while (j < lines.length) {
    const l = lines[j].trim();
    if (/^:::\s+column\b/.test(l)) {
      // Collect body lines until matching close.
      j++;
      const bodyLines: string[] = [];
      let depth = 1;
      while (j < lines.length && depth > 0) {
        const bl = lines[j].trim();
        if (/^:::\s+\w/.test(bl)) depth++;
        else if (/^:::$/.test(bl) || /^:::\s*$/.test(bl)) {
          depth--;
          if (depth === 0) { j++; break; }
        }
        if (depth > 0) bodyLines.push(lines[j]);
        j++;
      }
      // Render the body markdown.
      const bodyMd = bodyLines.join("\n");
      columnBodies.push(mdi.render(bodyMd));
    } else {
      j++;
    }
  }

  const columnCount = columnBodies.length;
  if (columnCount < 2 || columnCount > 3) {
    throw new ConverterError(
      `columns container must contain exactly 2 or 3 ::: column blocks (found ${columnCount}). ` +
        `Only two_equal and three_equal layouts are supported.`,
      "INVALID_COLUMN_COUNT"
    );
  }

  const sectionType = columnCount === 2 ? "two_equal" : "three_equal";
  const cells = columnBodies.map((body) => `<ac:layout-cell>${body}</ac:layout-cell>`).join("");

  return (
    `<ac:layout>` +
    `<ac:layout-section ac:type="${sectionType}">` +
    cells +
    `</ac:layout-section>` +
    `</ac:layout>`
  );
}


// ---------------------------------------------------------------------------
// Stream 9 — Inline directives
// ---------------------------------------------------------------------------

/**
 * Valid Confluence emoticon names.
 * Source: Confluence storage format reference doc, confirmed against
 * the Confluence Cloud editor output.
 */
const VALID_EMOTICONS = new Set([
  "smile",
  "sad",
  "cheeky",
  "laugh",
  "wink",
  "thumbs-up",
  "thumbs-down",
  "information",
  "tick",
  "cross",
  "warning",
  "light-on",
  "light-off",
  "yellow-star",
  "red-star",
  "green-star",
  "blue-star",
  "question",
]);

/**
 * Valid Confluence status badge colours (British spelling, per Confluence API quirk).
 */
const VALID_STATUS_COLOURS = new Set(["Grey", "Red", "Yellow", "Green", "Blue", "Purple"]);

/**
 * ISO 8601 calendar-date pattern: YYYY-MM-DD.
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Jira issue key pattern: one-or-more uppercase letters, hyphen, one-or-more digits.
 */
const JIRA_KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;

/**
 * Parse inline directive attrs string: {key=value key2="val 2"}.
 * The braces are already stripped by the caller.
 */
function parseDirectiveAttrs(attrs: string): Record<string, string> {
  const result: Record<string, string> = {};
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s}]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrs)) !== null) {
    const key = m[1];
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    result[key] = value;
  }
  return result;
}

/**
 * Inline directive pre-processor.
 *
 * Approach: regex-based pre-processor applied to the markdown string before
 * markdown-it sees it. This avoids the complexity of a full markdown-it
 * directive plugin while composing naturally inside table cells, list items,
 * and paragraphs.
 *
 * Directive syntax: :name[label]{attrs}
 * - name: one of status, mention, date, emoji, jira, anchor
 * - label: the text inside [...]
 * - attrs: optional key=value pairs inside {...}
 *
 * Each directive is replaced by a unique placeholder, which is then restored
 * after markdown-it renders to HTML. This prevents markdown-it from escaping
 * the XML we emit.
 *
 * Returns:
 * - processed: the markdown with directives replaced by placeholders
 * - directives: map from placeholder → resolved XML
 * - errors: any ConverterErrors encountered (thrown after processing so the
 *   caller can report the first error)
 */
function extractInlineDirectives(md: string): {
  processed: string;
  directives: Map<string, string>;
} {
  const directives = new Map<string, string>();
  let idx = 0;

  // Pattern: :name[label]{attrs}  or  :name[label]  (no attrs)
  // We match them in one pass.
  const directiveRe =
    /:(status|mention|date|emoji|jira|anchor)\[([^\]]*)\](?:\{([^}]*)\})?/g;

  const processed = md.replace(
    directiveRe,
    (_match, name: string, label: string, rawAttrs: string | undefined) => {
      const attrs = rawAttrs ? parseDirectiveAttrs(rawAttrs) : {};
      let xml: string;

      switch (name) {
        case "status": {
          const colour = attrs["colour"] ?? attrs["color"] ?? "";
          if (!VALID_STATUS_COLOURS.has(colour)) {
            throw new ConverterError(
              `Invalid status colour '${colour}'. Valid values are: ${[...VALID_STATUS_COLOURS].join(", ")}.`,
              "INVALID_STATUS_COLOUR"
            );
          }
          xml =
            `<ac:structured-macro ac:name="status" ac:schema-version="1">` +
            `<ac:parameter ac:name="title">${escapeXmlAttr(label)}</ac:parameter>` +
            `<ac:parameter ac:name="colour">${escapeXmlAttr(colour)}</ac:parameter>` +
            `</ac:structured-macro>`;
          break;
        }

        case "mention": {
          const accountId = attrs["accountId"] ?? "";
          if (!isValidAccountId(accountId)) {
            throw new ConverterError(
              `Invalid Atlassian account ID '${accountId}' in :mention directive. ` +
                `Use the modern format '557058:uuid' or legacy 24-char hex.`,
              "INVALID_ACCOUNT_ID"
            );
          }
          xml =
            `<ac:link>` +
            `<ri:user ri:account-id="${escapeXmlAttr(accountId)}"/>` +
            `</ac:link>`;
          break;
        }

        case "date": {
          if (!ISO_DATE_RE.test(label)) {
            throw new ConverterError(
              `Invalid date '${label}' in :date directive. Use ISO 8601 format: YYYY-MM-DD.`,
              "INVALID_DATE"
            );
          }
          xml = `<time datetime="${escapeXmlAttr(label)}"/>`;
          break;
        }

        case "emoji": {
          if (!VALID_EMOTICONS.has(label)) {
            throw new ConverterError(
              `Unknown emoticon name '${label}'. Valid names are: ${[...VALID_EMOTICONS].join(", ")}.`,
              "INVALID_EMOTICON"
            );
          }
          xml = `<ac:emoticon ac:name="${escapeXmlAttr(label)}"/>`;
          break;
        }

        case "jira": {
          if (!JIRA_KEY_RE.test(label)) {
            throw new ConverterError(
              `Invalid Jira issue key '${label}'. Expected format: PROJ-123.`,
              "INVALID_JIRA_KEY"
            );
          }
          xml =
            `<ac:structured-macro ac:name="jira" ac:schema-version="1">` +
            `<ac:parameter ac:name="key">${escapeXmlAttr(label)}</ac:parameter>`;
          if (attrs["server"]) {
            xml += `<ac:parameter ac:name="server">${escapeXmlAttr(attrs["server"])}</ac:parameter>`;
          }
          xml += `</ac:structured-macro>`;
          break;
        }

        case "anchor": {
          if (!label.trim()) {
            throw new ConverterError(
              `:anchor directive requires a non-empty anchor name.`,
              "EMPTY_ANCHOR_NAME"
            );
          }
          xml =
            `<ac:structured-macro ac:name="anchor" ac:schema-version="1">` +
            `<ac:parameter ac:name="">${escapeXmlText(label)}</ac:parameter>` +
            `</ac:structured-macro>`;
          break;
        }

        default: {
          // Should never reach here due to the regex pattern.
          throw new ConverterError(`Unknown directive ':${name}'.`, "UNKNOWN_DIRECTIVE");
        }
      }

      const placeholder = `@@@EPIDIRECTIVE${idx++}@@@`;
      directives.set(placeholder, xml);
      return placeholder;
    }
  );

  return { processed, directives };
}

// ---------------------------------------------------------------------------
// Stream 10 — Frontmatter + ToC injection
// ---------------------------------------------------------------------------

/**
 * Recognised frontmatter keys:
 * - toc: { maxLevel?: number, minLevel?: number, style?: string }
 *   Inject a Confluence ToC macro at the top of the converted body.
 * - headingOffset: number
 *   Shift all heading levels by N (e.g. headingOffset:1 turns # into <h2>).
 *
 * Reserved for future use (documented here, not yet implemented):
 * - numbered: boolean — numbered headings in the ToC
 * - excerpt: string — mark an excerpt region
 */
interface ParsedFrontmatter {
  toc?: {
    maxLevel?: number;
    minLevel?: number;
    style?: string;
  };
  headingOffset?: number;
}

/**
 * Build the ToC macro XML from the parsed frontmatter toc object.
 */
function buildTocMacro(toc: ParsedFrontmatter["toc"]): string {
  if (!toc) return "";

  let macro = `<ac:structured-macro ac:name="toc" ac:schema-version="1">`;
  if (toc.maxLevel !== undefined) {
    macro += `<ac:parameter ac:name="maxLevel">${escapeXmlAttr(String(toc.maxLevel))}</ac:parameter>`;
  }
  if (toc.minLevel !== undefined) {
    macro += `<ac:parameter ac:name="minLevel">${escapeXmlAttr(String(toc.minLevel))}</ac:parameter>`;
  }
  if (toc.style !== undefined) {
    macro += `<ac:parameter ac:name="style">${escapeXmlAttr(toc.style)}</ac:parameter>`;
  }
  macro += `</ac:structured-macro>`;
  return macro;
}

// ---------------------------------------------------------------------------
// Self-closing void elements (from Stream 2)
// ---------------------------------------------------------------------------

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
 * Build a heading renderer that emits IDs matching Confluence's slug algorithm.
 *
 * The slugger is created fresh per page render to track duplicates correctly.
 */
function buildHeadingRenderer(
  slugify: (text: string) => string,
  headingOffset: number
): MarkdownIt.Renderer.RenderRule {
  return function (tokens, idx, options, _env, slf) {
    const token = tokens[idx];
    if (token.nesting === 1) {
      // Find the inline token (heading content).
      const inlineToken = tokens[idx + 1];
      const rawContent = inlineToken?.content ?? "";

      // Render the inline content to get display HTML.
      // We need to create a temporary renderer for this.
      const displayHtml = inlineToken
        ? slf.render([inlineToken], options, _env)
        : "";

      // Parse the heading level from the token tag.
      const origLevel = parseInt(token.tag.slice(1), 10);
      const level = Math.min(6, Math.max(1, origLevel + headingOffset));

      // Generate Confluence-compatible slug from raw text.
      const id = slugify(rawContent);

      // We return the opening tag with id; the inline content will be
      // rendered by the normal inline rules, and heading_close will close it.
      // However, we need to manage state carefully here.
      // Instead, we intercept only the heading_open token and modify it
      // to add the id attribute and adjust the level.
      token.tag = `h${level}`;
      token.attrSet("id", id);
    } else {
      // heading_close — adjust level here too.
      const origLevel = parseInt(token.tag.slice(1), 10);
      const level = Math.min(6, Math.max(1, origLevel + headingOffset));
      token.tag = `h${level}`;
    }
    return slf.renderToken(tokens, idx, options);
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

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

  // --- Stream 10: Parse and strip frontmatter ---
  let bodyMd = md;
  let frontmatter: ParsedFrontmatter = {};

  // Only parse frontmatter if the string starts with '---' followed by
  // a newline and has a closing '---' or '...' delimiter. This prevents
  // a bare '---' (horizontal rule in markdown) from being swallowed by
  // gray-matter as an empty frontmatter block.
  const frontmatterRe = /^---\r?\n[\s\S]*?\r?\n(---|\.\.\.)(\r?\n|$)/;
  if (frontmatterRe.test(md.trimStart())) {
    try {
      const parsed = matter(md);
      bodyMd = parsed.content;
      // Extract recognized keys.
      const data = parsed.data as Record<string, unknown>;
      if (data["toc"] && typeof data["toc"] === "object") {
        frontmatter.toc = data["toc"] as ParsedFrontmatter["toc"];
      }
      if (typeof data["headingOffset"] === "number") {
        frontmatter.headingOffset = data["headingOffset"];
      }
    } catch {
      // If frontmatter parsing fails, proceed with the original content.
      bodyMd = md;
    }
  }

  const headingOffset = frontmatter.headingOffset ?? 0;

  // --- Build markdown-it instance (early, needed for columns pre-processing) ---
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

  // Stream 7: GitHub alert rule (applied before rendering).
  applyGitHubAlertRule(mdi);

  // Stream 8: Container plugins (panel, expand only — columns handled by pre-processor).
  applyContainerPlugins(mdi);

  // Override fence renderer to emit Confluence code macros.
  mdi.renderer.rules.fence = buildFenceRenderer();

  // Stream 11: Heading anchor slugger.
  const slugify = createHeadingSlugger();
  mdi.renderer.rules.heading_open = buildHeadingRenderer(slugify, headingOffset);
  mdi.renderer.rules.heading_close = buildHeadingRenderer(slugify, headingOffset);

  // --- Stream 9: Extract inline directives before markdown-it sees them ---
  // Directives like :status[...]{...} are replaced by placeholders that
  // survive markdown-it rendering, then restored afterward.
  const { processed: mdAfterDirectives, directives } = extractInlineDirectives(bodyMd);

  // --- Stream 8 (columns): Extract ::: columns blocks before markdown-it ---
  // This avoids the mixed-type nesting problem in markdown-it-container.
  const { processed: mdWithoutColumns, blocks: columnsBlocks } = extractColumnsBlocks(
    mdAfterDirectives,
    mdi
  );

  // --- Pre-processing: extract raw ac:/ri: blocks before markdown-it ---
  // These need to be pulled out before markdown-it escapes their angle-brackets.
  const { processed: mdWithoutAcBlocks, blocks: acBlocks } = extractRawAcBlocks(mdWithoutColumns);

  // Pre-process confluence:// scheme links into ac:link XML (stored in placeholders).
  const { processed: mdWithoutConfluenceLinks, links: confluenceLinks } =
    extractConfluenceSchemeLinks(mdWithoutAcBlocks);

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

  // 5. Restore inline directive placeholders.
  for (const [placeholder, directiveXml] of directives) {
    html = html.replace(new RegExp(escapeRegex(placeholder), "g"), directiveXml);
  }

  // 6. Restore columns block placeholders.
  for (const [placeholder, columnsXml] of columnsBlocks) {
    html = html.replace(new RegExp(`<p>\\s*${escapeRegex(placeholder)}\\s*</p>`, "g"), columnsXml);
    html = html.replace(new RegExp(escapeRegex(placeholder), "g"), columnsXml);
  }

  // 7. Validate raw <ac:...> passthrough (detect disallowed macros).
  if (html.includes("<ac:") || html.includes("<ri:")) {
    html = validateRawPassthrough(html);
  }

  // 8. Stream 10: Prepend ToC macro if frontmatter requested it.
  if (frontmatter.toc) {
    const tocMacro = buildTocMacro(frontmatter.toc);
    html = tocMacro + html;
  }

  return html;
}
