/**
 * Pure helpers for the draw.io macro in Confluence storage format.
 *
 * Updating a diagram's attachment in place leaves the page's macro pointing at
 * a stale `revision`; `bumpDrawioRevision` raises it with minimal edits.
 * `countMxCells` and `looksLikeDrawioXml` sanity-check an uploaded file.
 *
 * No XML parser anywhere: storage is scanned with indexOf so a multi-MB page
 * costs linear time and offsets stay exact. Every edit is a splice of a value
 * span, so all other bytes of the page survive untouched.
 */

import { inflateRawSync } from "node:zlib";

/** Offsets are of the raw (undecoded) text value inside the storage string. */
export interface ValueSpan {
  value: string;
  start: number;
  end: number;
}

export interface DrawioMacroRef {
  /** Offsets of the whole `<ac:structured-macro …>…</ac:structured-macro>`. */
  start: number;
  end: number;
  /** Entity-decoded `diagramName` parameter ("" if absent). */
  diagramName: string;
  pageIdParam?: string;
  revision?: ValueSpan;
  contentVer?: ValueSpan;
  /** A non-empty custContentId or contentId parameter: the diagram is not a plain attachment. */
  hasCustomContent: boolean;
}

export type BumpSkipReason =
  | "other-page"
  | "no-revision-param"
  | "non-numeric-revision"
  | "revision-ahead"
  | "custom-content";

export interface BumpResult {
  /** The input string itself when nothing changed. */
  body: string;
  /** Macros whose revision was raised. */
  updated: number;
  /** Matching macros whose revision already equals newRevision. */
  alreadyCurrent: number;
  skipped: { reason: BumpSkipReason }[];
}

export type CellCount = { ok: true; count: number } | { ok: false; reason: string };
export type DrawioXmlCheck = { ok: true } | { ok: false; reason: string };

/** Upper bound on one compressed diagram once inflated (zip-bomb guard). */
export const MAX_INFLATED_DIAGRAM_BYTES = 64 * 1024 * 1024;

const MACRO_OPEN = "<ac:structured-macro";
const MACRO_CLOSE = "</ac:structured-macro>";
const PARAM_OPEN = "<ac:parameter";
const PARAM_CLOSE = "</ac:parameter>";

const isTagBoundary = (ch: string | undefined): boolean =>
  ch === ">" || ch === "/" || (ch !== undefined && /\s/.test(ch));

/**
 * Replace CDATA and comment spans with spaces of equal length so offsets are
 * preserved and markup inside code blocks or comments is never matched. An
 * unterminated span is masked to the end of the string.
 */
function maskOpaque(s: string): string {
  const parts: string[] = [];
  let pos = 0;
  let nextCdata = s.indexOf("<![CDATA[");
  let nextComment = s.indexOf("<!--");
  while (nextCdata !== -1 || nextComment !== -1) {
    const isCdata = nextComment === -1 || (nextCdata !== -1 && nextCdata < nextComment);
    const open = isCdata ? nextCdata : nextComment;
    const opener = isCdata ? "<![CDATA[" : "<!--";
    const closer = isCdata ? "]]>" : "-->";
    const close = s.indexOf(closer, open + opener.length);
    const end = close === -1 ? s.length : close + closer.length;
    parts.push(s.slice(pos, open), " ".repeat(end - open));
    pos = end;
    if (nextCdata !== -1 && nextCdata < pos) nextCdata = s.indexOf("<![CDATA[", pos);
    if (nextComment !== -1 && nextComment < pos) nextComment = s.indexOf("<!--", pos);
  }
  parts.push(s.slice(pos));
  return parts.join("");
}

/** Index of the `>` closing the start tag at `from`, skipping quoted attribute values. */
function findTagEnd(s: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

const NAME_ATTR_RE = /\sac:name\s*=\s*(?:"([^"]*)"|'([^']*)')/;

function nameAttr(tag: string): string | undefined {
  const m = NAME_ATTR_RE.exec(tag);
  return m === null ? undefined : (m[1] ?? m[2]);
}

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Single-pass decode, so `&amp;lt;` yields `&lt;`. Invalid code points stay as written. */
function decodeEntities(s: string): string {
  return s.replace(ENTITY_RE, (whole, body: string) => {
    if (body[0] !== "#") return NAMED_ENTITIES[body];
    const cp = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    const valid = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
    return valid ? String.fromCodePoint(cp) : whole;
  });
}

/** Direct-text parameters between `from` and `to`; the first of a repeated name wins. */
function readParameters(
  original: string,
  masked: string,
  from: number,
  to: number,
): Map<string, ValueSpan | null> {
  const params = new Map<string, ValueSpan | null>();
  let pos = from;
  for (;;) {
    const open = masked.indexOf(PARAM_OPEN, pos);
    if (open === -1 || open >= to) break;
    pos = open + PARAM_OPEN.length;
    if (!isTagBoundary(masked[pos])) continue;
    const tagEnd = findTagEnd(masked, pos);
    if (tagEnd === -1 || tagEnd >= to) break;
    if (masked[tagEnd - 1] === "/") continue;
    const close = masked.indexOf(PARAM_CLOSE, tagEnd + 1);
    if (close === -1 || close > to) break;
    pos = close + PARAM_CLOSE.length;
    const name = nameAttr(original.slice(open, tagEnd));
    if (name === undefined || params.has(name)) continue;
    const value = original.slice(tagEnd + 1, close);
    params.set(
      name,
      value.includes("<") ? null : { value, start: tagEnd + 1, end: close },
    );
  }
  return params;
}

/**
 * Locate every `drawio` macro. Macros inside CDATA or comments, `inc-drawio`
 * and other macros are never returned, and nested or ambiguous matches are
 * dropped rather than guessed at.
 */
export function findDrawioMacros(storage: string): DrawioMacroRef[] {
  const masked = maskOpaque(storage);
  const refs: DrawioMacroRef[] = [];
  let pos = 0;
  for (;;) {
    const start = masked.indexOf(MACRO_OPEN, pos);
    if (start === -1) break;
    pos = start + MACRO_OPEN.length;
    if (!isTagBoundary(masked[pos])) continue;
    const tagEnd = findTagEnd(masked, pos);
    if (tagEnd === -1) break;
    if (masked[tagEnd - 1] === "/") continue;
    if (nameAttr(storage.slice(start, tagEnd)) !== "drawio") continue;
    const close = masked.indexOf(MACRO_CLOSE, tagEnd + 1);
    if (close === -1) continue;
    const innerStart = tagEnd + 1;
    const nested = masked.indexOf(MACRO_OPEN, innerStart);
    if (nested !== -1 && nested < close) continue;

    const params = readParameters(storage, masked, innerStart, close);
    const text = (name: string): string | undefined => {
      const p = params.get(name);
      return p ? decodeEntities(p.value) : undefined;
    };
    const present = (name: string): boolean => (text(name) ?? "").trim() !== "";
    refs.push({
      start,
      end: close + MACRO_CLOSE.length,
      diagramName: text("diagramName") ?? "",
      pageIdParam: text("pageId"),
      revision: params.get("revision") ?? undefined,
      contentVer: params.get("contentVer") ?? undefined,
      hasCustomContent: present("custContentId") || present("contentId"),
    });
    pos = close + MACRO_CLOSE.length;
  }
  return refs;
}

/**
 * Raise the `revision` of every macro showing `diagramName` on `pageId` to
 * `newRevision`. Never lowers a revision and never edits custom-content
 * diagrams. `contentVer` follows only when it equalled the old revision.
 */
export function bumpDrawioRevision(
  storage: string,
  opts: { diagramName: string; pageId: string; newRevision: number },
): BumpResult {
  const { diagramName, pageId, newRevision } = opts;
  if (!Number.isSafeInteger(newRevision) || newRevision < 1) {
    throw new RangeError(`newRevision must be a positive safe integer, got ${newRevision}`);
  }
  const next = String(newRevision);
  const edits: ValueSpan[] = [];
  const skipped: { reason: BumpSkipReason }[] = [];
  let updated = 0;
  let alreadyCurrent = 0;

  for (const ref of findDrawioMacros(storage)) {
    if (ref.diagramName !== diagramName) continue;
    if (ref.pageIdParam !== undefined && ref.pageIdParam !== pageId) {
      skipped.push({ reason: "other-page" });
    } else if (ref.hasCustomContent) {
      skipped.push({ reason: "custom-content" });
    } else if (ref.revision === undefined) {
      skipped.push({ reason: "no-revision-param" });
    } else if (!/^\d+$/.test(ref.revision.value)) {
      skipped.push({ reason: "non-numeric-revision" });
    } else {
      const current = BigInt(ref.revision.value);
      const target = BigInt(next);
      if (current > target) {
        skipped.push({ reason: "revision-ahead" });
      } else if (current === target) {
        alreadyCurrent++;
      } else {
        updated++;
        edits.push(ref.revision);
        if (ref.contentVer !== undefined && ref.contentVer.value === ref.revision.value) {
          edits.push(ref.contentVer);
        }
      }
    }
  }

  if (edits.length === 0) return { body: storage, updated, alreadyCurrent, skipped };

  const ordered = [...edits].sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let pos = 0;
  for (const e of ordered) {
    parts.push(storage.slice(pos, e.start), next);
    pos = e.end;
  }
  parts.push(storage.slice(pos));
  return { body: parts.join(""), updated, alreadyCurrent, skipped };
}

function countCells(s: string): number {
  let count = 0;
  let pos = 0;
  for (;;) {
    const at = s.indexOf("<mxCell", pos);
    if (at === -1) return count;
    pos = at + "<mxCell".length;
    if (isTagBoundary(s[pos])) count++;
  }
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Inflate one compressed `<diagram>` payload: base64, raw deflate, URI-encoded XML. */
function inflateDiagram(payload: string): { ok: true; xml: string } | { ok: false; reason: string } {
  const compact = payload.replace(/\s+/g, "");
  if (compact === "" || compact.length % 4 === 1 || !BASE64_RE.test(compact)) {
    return { ok: false, reason: "compressed diagram could not be decoded" };
  }
  try {
    const inflated = inflateRawSync(Buffer.from(compact, "base64"), {
      maxOutputLength: MAX_INFLATED_DIAGRAM_BYTES,
    });
    return { ok: true, xml: decodeURIComponent(inflated.toString("utf8")) };
  } catch (err) {
    const code = (err as { code?: string }).code;
    return {
      ok: false,
      reason:
        code === "ERR_BUFFER_TOO_LARGE"
          ? "compressed diagram exceeds 64 MB when inflated"
          : "compressed diagram could not be decoded",
    };
  }
}

/**
 * Count `<mxCell` elements across the whole file, inflating compressed
 * `<diagram>` pages. Any decode failure is reported, never thrown.
 */
export function countMxCells(xml: string): CellCount {
  let total = 0;
  let pos = 0;
  for (;;) {
    const open = xml.indexOf("<diagram", pos);
    if (open === -1) break;
    const after = open + "<diagram".length;
    if (!isTagBoundary(xml[after])) {
      total += countCells(xml.slice(pos, after));
      pos = after;
      continue;
    }
    const tagEnd = findTagEnd(xml, after);
    if (tagEnd === -1) break;
    if (xml[tagEnd - 1] === "/") {
      total += countCells(xml.slice(pos, tagEnd + 1));
      pos = tagEnd + 1;
      continue;
    }
    const close = xml.indexOf("</diagram>", tagEnd + 1);
    if (close === -1) break;
    total += countCells(xml.slice(pos, tagEnd + 1));
    const content = xml.slice(tagEnd + 1, close);
    if (content.trimStart().startsWith("<")) {
      total += countCells(content);
    } else if (content.trim() !== "") {
      const res = inflateDiagram(content);
      if (!res.ok) return res;
      total += countCells(res.xml);
    }
    pos = close + "</diagram>".length;
  }
  total += countCells(xml.slice(pos));
  return { ok: true, count: total };
}

const XML_DECL_RE = /^<\?xml[^>]*\?>/;

/**
 * Cheap gate before uploading text as a draw.io file: it must open with an
 * mxfile or mxGraphModel root, and must carry no DOCTYPE or ENTITY (no real
 * draw.io file does, and they are the vehicle for entity-expansion attacks).
 */
export function looksLikeDrawioXml(text: string): DrawioXmlCheck {
  const lower = text.toLowerCase();
  if (lower.includes("<!doctype") || lower.includes("<!entity")) {
    return { ok: false, reason: "contains a DOCTYPE or ENTITY declaration" };
  }
  let body = text.replace(/^﻿/, "").trimStart();
  const decl = XML_DECL_RE.exec(body);
  if (decl !== null) body = body.slice(decl[0].length).trimStart();
  for (const root of ["<mxfile", "<mxGraphModel"]) {
    if (body.startsWith(root) && isTagBoundary(body[root.length])) return { ok: true };
  }
  return { ok: false, reason: "does not start with an <mxfile> or <mxGraphModel> element" };
}
