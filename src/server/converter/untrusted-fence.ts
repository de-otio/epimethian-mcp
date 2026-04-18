/**
 * Untrusted-content fence helper (Track B2 of `plans/security-audit-fixes.md`).
 * Spec: `plans/untrusted-content-fence-spec.md`.
 *
 * Wraps tenant-authored Confluence content in visibly-delimited fences so the
 * LLM receiving the content can distinguish it from instructions it should
 * act on. The fences are paired with tool-description paragraphs (see B3) that
 * instruct the model to treat fenced content as data.
 *
 * This is a **behavioural** defence, not a cryptographic one. An agent that
 * ignores its tool-description instructions can still be hijacked by fenced
 * content. The fence exists to make the data / instruction boundary visible.
 */

/** Opening fence prefix. Full fence: `<<<CONFLUENCE_UNTRUSTED key=value...>>>`. */
export const OPEN_FENCE_PREFIX = "<<<CONFLUENCE_UNTRUSTED";

/** Closing fence (fixed, no attributes). */
export const CLOSE_FENCE = "<<<END_CONFLUENCE_UNTRUSTED>>>";

/**
 * Defined attribute keys and their accepted `field` values. Values outside the
 * ASCII alphanumeric + `_.-` subset fall back to `unknown` before rendering.
 */
export type FenceField =
  | "body"
  | "title"
  | "excerpt"
  | "comment"
  | "label"
  | "displayName"
  | "section"
  | "headings"
  | "markdown"
  | "diff"
  | "versionNote"
  | "statusName";

export interface FenceAttrs {
  pageId?: string | number;
  field: FenceField;
  version?: string | number;
  commentId?: string | number;
  sectionIndex?: string | number;
}

const SAFE_ATTR_VALUE_RE = /^[A-Za-z0-9_.-]+$/;

function sanitiseAttrValue(raw: string | number | undefined): string {
  if (raw === undefined || raw === null) return "unknown";
  const s = String(raw);
  if (s.length === 0) return "unknown";
  return SAFE_ATTR_VALUE_RE.test(s) ? s : "unknown";
}

function renderAttrs(attrs: FenceAttrs): string {
  const parts: string[] = [];
  if (attrs.pageId !== undefined) parts.push(`pageId=${sanitiseAttrValue(attrs.pageId)}`);
  parts.push(`field=${attrs.field}`);
  if (attrs.version !== undefined) parts.push(`version=${sanitiseAttrValue(attrs.version)}`);
  if (attrs.commentId !== undefined) parts.push(`commentId=${sanitiseAttrValue(attrs.commentId)}`);
  if (attrs.sectionIndex !== undefined) parts.push(`sectionIndex=${sanitiseAttrValue(attrs.sectionIndex)}`);
  return parts.join(" ");
}

/**
 * Escape any embedded fence markers so an attacker cannot close the fence from
 * inside. Doubles the leading `<` to `<<<<` for either fence prefix — the
 * result is no longer a valid fence, regardless of syntax. Idempotent once per
 * wrap; callers must NOT double-apply.
 *
 * Spec §2: escape rule.
 */
export function escapeFenceContent(content: string): string {
  // Replace the close fence first to avoid cascading rewrites if the open
  // prefix appears inside an attempt to close. Both replacements are
  // plain-string, not regex, so special characters in other positions are
  // untouched.
  const withCloseEscaped = content.split(CLOSE_FENCE).join(`<${CLOSE_FENCE}`);
  const withOpenEscaped = withCloseEscaped
    .split(OPEN_FENCE_PREFIX)
    .join(`<${OPEN_FENCE_PREFIX}`);
  return withOpenEscaped;
}

/**
 * Wrap tenant-controlled content in an untrusted-content fence. Empty content
 * still emits the fence (uniform format; makes B4 regression tests assertable).
 *
 * Example output:
 * ```
 * <<<CONFLUENCE_UNTRUSTED pageId=123 field=body>>>
 * …content…
 * <<<END_CONFLUENCE_UNTRUSTED>>>
 * ```
 */
export function fenceUntrusted(content: string, attrs: FenceAttrs): string {
  const escaped = escapeFenceContent(content);
  const header = `${OPEN_FENCE_PREFIX} ${renderAttrs(attrs)}>>>`;
  // Ensure the closing fence starts on its own line even when content does
  // not end with a newline.
  const trailer = escaped.endsWith("\n") ? "" : "\n";
  return `${header}\n${escaped}${trailer}${CLOSE_FENCE}`;
}
