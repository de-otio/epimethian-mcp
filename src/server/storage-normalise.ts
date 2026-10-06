/**
 * Pure helpers that normalise Confluence storage format for COMPARISON ONLY.
 *
 * Nothing here may feed a write: the output drops attributes that a write
 * must preserve. `diff_page_versions` uses it today; the 7.2 `compact` and
 * entity-tolerant matching work reuses `stripVolatileAttributes`.
 */

/** Attributes Confluence regenerates or reshuffles between versions without a content change. */
const VOLATILE_ATTRIBUTES: ReadonlySet<string> = new Set([
  "local-id",
  "ac:local-id",
  "ac:macro-id",
]);

interface Segment {
  text: string;
  /** CDATA payloads and comments: copied verbatim, never inspected as markup. */
  opaque: boolean;
}

const OPAQUE_OPEN_RE = /<!\[CDATA\[|<!--/g;

/**
 * Split into markup and opaque (CDATA / comment) segments. An opener with no
 * closer is plain text. Once one CDATA (or comment) opener has no closer, no
 * later opener of that kind has one either, so the search stops: many
 * unterminated openers cost one scan, not one scan each.
 */
function segmentStorage(storage: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  let cdataClosable = true;
  let commentClosable = true;
  OPAQUE_OPEN_RE.lastIndex = 0;
  for (let m = OPAQUE_OPEN_RE.exec(storage); m !== null; m = OPAQUE_OPEN_RE.exec(storage)) {
    const at = m.index;
    const isCdata = m[0] === "<![CDATA[";
    if (isCdata ? !cdataClosable : !commentClosable) continue;
    const closer = isCdata ? "]]>" : "-->";
    const closeAt = storage.indexOf(closer, at + m[0].length);
    if (closeAt < 0) {
      if (isCdata) cdataClosable = false;
      else commentClosable = false;
      continue;
    }
    const end = closeAt + closer.length;
    if (at > last) out.push({ text: storage.slice(last, at), opaque: false });
    out.push({ text: storage.slice(at, end), opaque: true });
    last = end;
    OPAQUE_OPEN_RE.lastIndex = end;
  }
  if (last < storage.length) out.push({ text: storage.slice(last), opaque: false });
  return out;
}

/**
 * An opening or self-closing start tag. Quoted attribute values may contain
 * `<` and `>`; the two alternatives start with different characters, so the
 * match is linear.
 */
const START_TAG_RE = /<[A-Za-z][^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*>/g;

/** One attribute: leading whitespace, a name, and an optional quoted or bare value. */
const ATTRIBUTE_RE = /\s+([^\s=/>"']+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/g;

function stripFromTag(tag: string): string {
  const nameEnd = tag.search(/[\s/>]/);
  if (nameEnd < 0) return tag;
  // Attributes are consumed whole (value included), so text that merely looks
  // like `local-id="..."` inside another attribute's value is never touched.
  return (
    tag.slice(0, nameEnd) +
    tag
      .slice(nameEnd)
      .replace(ATTRIBUTE_RE, (whole, name: string) =>
        VOLATILE_ATTRIBUTES.has(name.toLowerCase()) ? "" : whole,
      )
  );
}

/**
 * Remove `local-id`, `ac:local-id` and `ac:macro-id` from every start tag.
 *
 * CDATA payloads and comments are left untouched, so a code macro whose body
 * happens to contain `<p local-id="x">` is not altered. Whole-attribute
 * matching means `data-local-id` and attribute VALUES are never stripped.
 */
export function stripVolatileAttributes(storage: string): string {
  return segmentStorage(storage)
    .map((seg) => (seg.opaque ? seg.text : seg.text.replace(START_TAG_RE, stripFromTag)))
    .join("");
}

/**
 * Block-level boundaries: a newline goes before each of these tags, opening
 * or closing, so a line diff localises a change to one block or macro part.
 */
const BLOCK_TAG_RE =
  /<\/?(?:p|h[1-6]|ul|ol|li|table|thead|tbody|tfoot|tr|th|td|blockquote|pre|div|hr|ac:structured-macro|ac:parameter|ac:rich-text-body|ac:plain-text-body|ac:layout|ac:layout-section|ac:layout-cell|ac:task-list|ac:task|ac:task-body)(?=[\s/>])/gi;

/**
 * Insert a newline at block-tag boundaries so storage (usually one long
 * line) can be line-diffed. CDATA payloads and comments are copied verbatim.
 * Never adds a blank line: nothing is inserted at the very start or right
 * after an existing newline.
 */
export function splitStorageBlocks(storage: string): string {
  let out = "";
  for (const seg of segmentStorage(storage)) {
    if (seg.opaque) {
      out += seg.text;
      continue;
    }
    out += seg.text.replace(BLOCK_TAG_RE, (tag, offset: number) => {
      const prev = offset > 0 ? seg.text[offset - 1] : out[out.length - 1];
      return prev === undefined || prev === "\n" ? tag : `\n${tag}`;
    });
  }
  return out;
}

/** Macro names are reported to the agent; only this alphabet is ever shown. */
const SAFE_MACRO_NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * A macro start tag. `[^<>]*` stops at the next `<`, so a failed attempt never
 * rescans text that a later attempt covers: the scan is linear however many
 * unterminated start tags the input holds. Confluence escapes `<` in attribute
 * values; an unescaped `>` inside one would end the tag early, which only
 * affects this comparison-only name report.
 */
const MACRO_OPEN_RE = /<ac:structured-macro(?=[\s/>])([^<>]*)>/gi;
const MACRO_NAME_ATTR_RE = /(?:^|\s)ac:name="([^"]*)"/i;
const MACRO_CLOSE_RE = /<\/ac:structured-macro\s*>/gi;

interface MacroEvent {
  readonly at: number;
  readonly open: boolean;
  readonly name?: string;
  readonly selfClosing?: boolean;
}

/** Macro open and close tags in source order. CDATA payloads and comments are skipped. */
function macroEvents(text: string): readonly MacroEvent[] {
  const events: MacroEvent[] = [];
  let base = 0;
  for (const seg of segmentStorage(text)) {
    if (!seg.opaque) {
      for (const m of seg.text.matchAll(MACRO_OPEN_RE)) {
        const attrs = m[1] ?? "";
        events.push({
          at: base + (m.index ?? 0),
          open: true,
          name: MACRO_NAME_ATTR_RE.exec(attrs)?.[1],
          selfClosing: attrs.endsWith("/"),
        });
      }
      for (const m of seg.text.matchAll(MACRO_CLOSE_RE)) {
        events.push({ at: base + (m.index ?? 0), open: false });
      }
    }
    base += seg.text.length;
  }
  return events.sort((a, b) => a.at - b.at);
}

/**
 * For each line of block-split storage, the names of the macros it belongs
 * to: the macro open at the line's start plus any macro opened on the line.
 * A change to a macro's parameter, which sits on its own line, is therefore
 * attributed to that macro rather than to nothing.
 *
 * Tags are found over the whole text, not line by line, so a CDATA payload or
 * comment that spans lines is skipped as a unit: a macro inside one is not a
 * macro.
 *
 * Names outside `[A-Za-z0-9_-]` are reported as `undefined` slots and dropped
 * by the caller, so tenant-authored text never reaches the output.
 */
export function macroNamesPerLine(lines: readonly string[]): readonly (readonly string[])[] {
  const events = macroEvents(lines.join("\n"));
  // Mutated across lines on purpose: the open-macro stack is the scan's state.
  const open: (string | undefined)[] = [];
  let next = 0;
  let lineEnd = -1;
  return lines.map((line) => {
    lineEnd += line.length + 1; // offset of this line's newline (or the end)
    const names: string[] = [];
    const top = open[open.length - 1];
    if (top !== undefined) names.push(top);
    for (; next < events.length && events[next]!.at <= lineEnd; next++) {
      const ev = events[next]!;
      if (ev.open) {
        const safe = ev.name !== undefined && SAFE_MACRO_NAME_RE.test(ev.name) ? ev.name : undefined;
        if (safe !== undefined) names.push(safe);
        if (!ev.selfClosing) open.push(safe);
      } else {
        open.pop();
      }
    }
    return names;
  });
}
