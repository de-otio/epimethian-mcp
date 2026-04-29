/**
 * Macro canonicaliser for byte-equivalent deletion suppression (Track C1).
 *
 * Given a token's verbatim XML, returns a stable string key. Two tokens with
 * the same key are considered byte-equivalent after canonicalisation —
 * meaning the agent regenerated identical content with different attribute
 * ordering / whitespace / etc.
 *
 * EQUIVALENCE RULES (per design plan §C1):
 *
 *  - `<ac:link>`: equal if the resolved page-target (page-id or
 *    space+title), the link body display text, and the anchor (if any)
 *    all match. Order of attributes does not matter.
 *
 *  - `<ac:structured-macro ac:name="toc">`: equal if all `ac:parameter`
 *    children render identically after parameter sort.
 *
 *  - Generic `<ac:structured-macro>` (any other ac:name): equal if
 *    `ac:name`, parameter set (sorted), and CDATA body are equal.
 *
 *  - Plain elements (e.g. `<ac:emoticon>`): byte-equal after attribute
 *    sort.
 *
 * DEFAULT STRICT: anything the canonicaliser cannot interpret returns the
 * sentinel `OPAQUE` key — which is INTENTIONALLY never equal to itself across
 * tokens (each call returns a distinct sentinel). This guarantees that
 * unknown shapes are treated as non-equivalent, so the deletion gate fires.
 *
 * SECURITY: a buggy equivalence test would let genuinely lost content slip
 * past the user-confirmation gate. Every rule below is anchored on
 * "every meaningful attribute matches"; ambiguous or partially-parsed
 * inputs always fall through to the OPAQUE sentinel.
 */

import { parse } from "node-html-parser";
import type { HTMLElement } from "node-html-parser";

/**
 * Sentinel for inputs the canonicaliser refuses to interpret. Each call
 * returns a unique string so two opaque tokens never compare equal —
 * ensuring the deletion gate fires for anything we don't understand.
 */
let opaqueCounter = 0;
function opaqueSentinel(): string {
  return `OPAQUE:${++opaqueCounter}`;
}

/**
 * Macro kind, surfaced on regenerated pairs so the audit log can describe
 * what was suppressed without leaking content.
 */
export type MacroKind =
  | "ac:link"
  | "ac:structured-macro:toc"
  | "ac:structured-macro"
  | "ac:emoticon"
  | "plain-element"
  | "opaque";

/**
 * Result of canonicalising a single token. `key` is the stable equivalence
 * key; `kind` is the macro classification.
 */
export interface CanonicalisedToken {
  key: string;
  kind: MacroKind;
}

/**
 * Sort an attribute object's keys alphabetically and emit `key="value"`
 * pairs. Guarantees a stable serialisation regardless of input order.
 */
function sortedAttrs(attrs: Record<string, string>): string {
  const keys = Object.keys(attrs).sort();
  return keys.map((k) => `${k}="${attrs[k]}"`).join(" ");
}

/**
 * Mask `<![CDATA[…]]>` regions out of an XML string before handing it to
 * node-html-parser (which has no native CDATA support). Returns the
 * masked string with same byte length as the original (so byte offsets
 * still line up if we ever need them).
 *
 * Each CDATA payload becomes a same-length run of spaces; the original
 * payloads are stored in `bodies` keyed by their absolute byte offset so
 * the canonicaliser can read them back via {@link readCdataAt}.
 */
function maskCdata(xml: string): {
  masked: string;
  bodies: Map<number, string>;
} {
  const bodies = new Map<number, string>();
  const masked = xml.replace(
    /<!\[CDATA\[([\s\S]*?)\]\]>/g,
    (m, inner: string, offset: number) => {
      bodies.set(offset, inner);
      return " ".repeat(m.length);
    },
  );
  return { masked, bodies };
}

/**
 * Extract the text content of all CDATA bodies that fall inside the byte
 * range [start, end) of the original XML. Used to read
 * `<ac:plain-text-link-body><![CDATA[…]]></…>` and similar payloads
 * without losing them through the parser. CDATA payloads are concatenated
 * in document order.
 */
function readCdataInRange(
  bodies: Map<number, string>,
  start: number,
  end: number,
): string {
  const offsets = Array.from(bodies.keys())
    .filter((o) => o >= start && o < end)
    .sort((a, b) => a - b);
  return offsets.map((o) => bodies.get(o)!).join("");
}

/**
 * Read the outer element from a parsed XML fragment. Returns undefined if
 * the input doesn't start with a single element node.
 */
function getRootElement(xml: string): HTMLElement | undefined {
  if (!xml || typeof xml !== "string") return undefined;
  const root = parse(xml, { lowerCaseTagName: false });
  // Find the first element child (skip whitespace text nodes).
  for (const child of root.childNodes) {
    if (child.nodeType === 1) {
      return child as HTMLElement;
    }
  }
  return undefined;
}

/**
 * Read the text content of an element, recovering CDATA payloads from the
 * masked source via byte-offset lookup. Trims surrounding whitespace; the
 * canonicaliser doesn't care about whitespace differences inside text
 * nodes.
 */
function elementText(
  el: HTMLElement,
  bodies: Map<number, string>,
): string {
  const range = el.range;
  if (range && bodies.size > 0) {
    const cdataPart = readCdataInRange(bodies, range[0], range[1]);
    if (cdataPart.length > 0) {
      return cdataPart;
    }
  }
  // Fall back to the parser's text getter. After mask, CDATA regions are
  // empty so the parser's text reflects only non-CDATA character data.
  return (el.text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Collect all `<ac:parameter>` children directly under the given element,
 * keyed by their `ac:name` attribute. Returns undefined if any parameter
 * is missing an `ac:name` (we refuse to canonicalise ambiguous shapes).
 *
 * The body of each parameter is its raw text content (CDATA recovered via
 * the byte-offset map). Multiple parameters with the same name are
 * recorded as an array so we don't silently drop one.
 */
function collectParameters(
  el: HTMLElement,
  bodies: Map<number, string>,
): Record<string, string[]> | undefined {
  const params: Record<string, string[]> = {};
  for (const child of el.childNodes) {
    if (child.nodeType !== 1) continue;
    const c = child as HTMLElement;
    if (c.tagName.toLowerCase() !== "ac:parameter") continue;
    const name = c.getAttribute("ac:name");
    if (!name) {
      // A parameter without an ac:name is a malformed macro; the
      // canonicaliser cannot decide equivalence safely.
      return undefined;
    }
    const value = elementText(c, bodies);
    if (!params[name]) params[name] = [];
    params[name].push(value);
  }
  return params;
}

/**
 * Canonicalise an `<ac:link>` element.
 *
 * Equivalence: resolved page-target (page-id OR space+title), link body
 * display text, and anchor (if any). Other variants (user mentions,
 * attachments, external URLs) fall through to OPAQUE — strict by design.
 */
function canonicaliseAcLink(
  el: HTMLElement,
  bodies: Map<number, string>,
): string {
  // Extract the optional ac:anchor attribute.
  const anchor = el.getAttribute("ac:anchor") ?? "";

  // Find the inner ri: page reference or fall through.
  let target: string | undefined;
  let bodyText: string | undefined;

  for (const child of el.childNodes) {
    if (child.nodeType !== 1) continue;
    const c = child as HTMLElement;
    const tag = c.tagName.toLowerCase();

    if (tag === "ri:page") {
      const contentId = c.getAttribute("ri:content-id");
      const spaceKey = c.getAttribute("ri:space-key") ?? "";
      const contentTitle = c.getAttribute("ri:content-title");
      if (contentId) {
        target = `page-id:${contentId}`;
      } else if (contentTitle) {
        target = `space-title:${spaceKey}|${contentTitle}`;
      } else {
        // Page reference with neither id nor title — undecidable.
        return opaqueSentinel();
      }
    } else if (tag === "ac:plain-text-link-body") {
      // CDATA payload recovered from the byte-offset map.
      bodyText = elementText(c, bodies);
    } else if (tag === "ac:link-body") {
      // Rich link body — fall through to opaque (strict default; we don't
      // attempt to compare inline rich text). A genuine regeneration of a
      // rich-body link will be flagged as a deletion + creation pair.
      return opaqueSentinel();
    } else if (tag === "ri:user" || tag === "ri:attachment") {
      // User mentions / attachment links — strict default.
      return opaqueSentinel();
    }
    // Other element types: fall through to opaque if we never set target.
  }

  if (!target) {
    return opaqueSentinel();
  }
  // bodyText may be undefined (link has no plain-text body); normalise to
  // an empty string so two links with no body compare equal.
  return [
    "ac:link",
    `target=${target}`,
    `anchor=${anchor}`,
    `body=${bodyText ?? ""}`,
  ].join("|");
}

/**
 * Canonicalise an `<ac:structured-macro>` element.
 */
function canonicaliseStructuredMacro(
  el: HTMLElement,
  bodies: Map<number, string>,
): {
  key: string;
  kind: MacroKind;
} {
  const acName = el.getAttribute("ac:name");
  if (!acName) {
    // ac:structured-macro without an ac:name is malformed — strict.
    return { key: opaqueSentinel(), kind: "opaque" };
  }

  const params = collectParameters(el, bodies);
  if (!params) {
    // Ambiguous parameter shape — strict.
    return { key: opaqueSentinel(), kind: "opaque" };
  }

  // Sort parameter names; serialise the (possibly-multi) values stably.
  const paramKeys = Object.keys(params).sort();
  const paramParts: string[] = [];
  for (const k of paramKeys) {
    // Sort values too: a parameter set is order-independent per the
    // equivalence rule.
    const values = params[k]!.slice().sort();
    paramParts.push(`${k}=${JSON.stringify(values)}`);
  }

  // CDATA / plain-text body: macros like <ac:structured-macro ac:name="code">
  // carry their content in <ac:plain-text-body>. Non-CDATA rich-text bodies
  // (`<ac:rich-text-body>`) — strict default: opaque (any change inside
  // rich content is structurally meaningful).
  let cdataBody: string | undefined;
  let hasRichBody = false;
  for (const child of el.childNodes) {
    if (child.nodeType !== 1) continue;
    const c = child as HTMLElement;
    const tag = c.tagName.toLowerCase();
    if (tag === "ac:plain-text-body") {
      cdataBody = elementText(c, bodies);
    } else if (tag === "ac:rich-text-body") {
      hasRichBody = true;
    }
  }
  if (hasRichBody) {
    return { key: opaqueSentinel(), kind: "opaque" };
  }

  const isToc = acName === "toc";
  const kind: MacroKind = isToc ? "ac:structured-macro:toc" : "ac:structured-macro";

  // For TOC, the body should be empty / absent; checking equality of the
  // sorted parameter set is sufficient. For generic structured-macros,
  // include the CDATA body in the key.
  const parts: string[] = [
    "structured-macro",
    `name=${acName}`,
    `params=[${paramParts.join(",")}]`,
  ];
  if (cdataBody !== undefined) {
    parts.push(`body=${JSON.stringify(cdataBody)}`);
  }
  return { key: parts.join("|"), kind };
}

/**
 * Canonicalise a plain element (e.g. `<ac:emoticon>`, `<time>`): byte-equal
 * after attribute sort.
 *
 * Plain elements are leaf-shaped (no children other than incidental
 * whitespace text). If the element has element children, fall through to
 * opaque — leaves don't have children.
 */
function canonicalisePlainElement(el: HTMLElement): {
  key: string;
  kind: MacroKind;
} {
  for (const child of el.childNodes) {
    if (child.nodeType === 1) {
      // Element children — not a leaf; refuse.
      return { key: opaqueSentinel(), kind: "opaque" };
    }
  }
  // Build the attribute map. node-html-parser exposes `attributes` as a
  // plain object string→string. Keys with namespace prefixes are
  // preserved (e.g. "ac:name").
  const attrs = el.attributes ?? {};
  const tag = el.tagName.toLowerCase();
  const kind: MacroKind = tag === "ac:emoticon" ? "ac:emoticon" : "plain-element";
  return {
    key: `plain|${tag}|${sortedAttrs(attrs)}`,
    kind,
  };
}

/**
 * Compute the canonical key + kind for a token's verbatim XML.
 *
 * Returns an OPAQUE sentinel for any input the canonicaliser cannot
 * interpret with confidence. Opaque keys are always unique (no two opaque
 * tokens compare equal), guaranteeing the deletion gate fires for unknown
 * shapes.
 *
 * CDATA HANDLING: node-html-parser doesn't natively support CDATA. The
 * canonicaliser masks CDATA blocks with same-length whitespace before
 * parsing (preserving byte offsets) and recovers the original payloads
 * via a byte-offset map when reading element text (see
 * {@link maskCdata} / {@link readCdataInRange} / {@link elementText}).
 * This preserves the body text of `<ac:plain-text-link-body>` and
 * `<ac:plain-text-body>` macros across the canonicalisation round trip.
 */
export function canonicaliseToken(xml: string | undefined): CanonicalisedToken {
  if (!xml) return { key: opaqueSentinel(), kind: "opaque" };

  const { masked, bodies } = maskCdata(xml);

  let el: HTMLElement | undefined;
  try {
    el = getRootElement(masked);
  } catch {
    return { key: opaqueSentinel(), kind: "opaque" };
  }
  if (!el) return { key: opaqueSentinel(), kind: "opaque" };

  const tag = el.tagName.toLowerCase();

  if (tag === "ac:link") {
    return { key: canonicaliseAcLink(el, bodies), kind: "ac:link" };
  }

  if (tag === "ac:structured-macro") {
    return canonicaliseStructuredMacro(el, bodies);
  }

  if (tag === "ac:emoticon") {
    return canonicalisePlainElement(el);
  }

  // Other tokenised elements — `<ri:*>`, `<time>`, etc. — fall through to
  // the plain-element path. If they have element children, that path
  // returns OPAQUE.
  if (tag.startsWith("ri:") || tag === "time") {
    return canonicalisePlainElement(el);
  }

  // Anything else: strict.
  return { key: opaqueSentinel(), kind: "opaque" };
}

/**
 * Reset the opaque-sentinel counter. Test-only — production callers should
 * never need this. Exposed so deterministic property tests can run.
 */
export function _resetOpaqueCounterForTests(): void {
  opaqueCounter = 0;
}
