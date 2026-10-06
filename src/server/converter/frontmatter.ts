/**
 * Markdown frontmatter splitter (Stream 10).
 *
 * Replaces `gray-matter`, whose YAML dependency chain has no patched release
 * and which also carried a latent `---js` engine that evaluates code. Here:
 *
 *   - the opening line must be exactly `---`, so a language tag (`---js`,
 *     `---json`) is never recognised;
 *   - the block ends at the first line that is exactly `---` or `...`;
 *   - the block is parsed with js-yaml's JSON_SCHEMA (null, booleans, numbers,
 *     strings, maps, sequences; no timestamps, no merge keys, no custom or
 *     JavaScript types);
 *   - a block over MAX_FRONTMATTER_CHARS is not frontmatter.
 *
 * Content is only ever removed from the page when the block parses to a
 * mapping (or is empty / a bare null). Anything else - a parse error, a
 * scalar, a sequence, an oversized block - leaves the markdown untouched, so
 * a document that merely starts with a horizontal rule, some prose and a
 * second rule keeps all of its text. Pure; no I/O.
 *
 * YAML anchors and aliases are accepted by js-yaml; an alias resolves to the
 * same object rather than a copy, so the parse itself cannot blow up, and
 * callers read only a few scalar fields from the result.
 */

import { load, JSON_SCHEMA } from "js-yaml";

/** Frontmatter blocks are a handful of keys; this is far above any real one. */
export const MAX_FRONTMATTER_CHARS = 64 * 1024;

export interface SplitFrontmatter {
  /** The mapping parsed from the block (`{}` for an empty block). */
  readonly data: Readonly<Record<string, unknown>>;
  /** The markdown after the block (and the newline that ends it). */
  readonly body: string;
}

// `---`, a block of lines, then a line that is exactly `---` or `...`. Linear:
// one anchored lazy scan, no nested quantifiers.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Split leading frontmatter off `md`. Returns undefined when `md` has none
 * (or when the block is not safe to strip, see the module comment); the
 * caller then converts `md` as it is.
 */
export function splitFrontmatter(md: string): SplitFrontmatter | undefined {
  // A leading byte-order mark does not stop a document from having frontmatter.
  const src = md.charCodeAt(0) === 0xfeff ? md.slice(1) : md;
  const match = FRONTMATTER_RE.exec(src);
  if (match === null) return undefined;
  const block = match[1];
  if (block.length > MAX_FRONTMATTER_CHARS) return undefined;

  let parsed: unknown;
  try {
    parsed = load(block, { schema: JSON_SCHEMA });
  } catch {
    return undefined; // malformed YAML: leave the document alone
  }
  // An empty or comment-only block loads as undefined; a bare `~` as null.
  if (parsed === undefined || parsed === null) {
    return { data: {}, body: src.slice(match[0].length) };
  }
  if (!isPlainObject(parsed)) return undefined;
  return { data: parsed, body: src.slice(match[0].length) };
}
