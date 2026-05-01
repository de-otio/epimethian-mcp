/**
 * XML / CDATA escaping for Confluence storage format output.
 *
 * SECURITY: every helper here is on the security boundary — see
 * doc/design/investigations/investigate-confluence-specific-elements/06-security.md.
 */

/**
 * Escape a string for safe inclusion in an XML attribute value.
 *
 * Escapes the five XML predefined entities (`&`, `<`, `>`, `"`, `'`) and all
 * XML control characters (U+0000–U+001F and U+007F–U+009F, excluding the
 * whitespace characters that are legal in XML 1.0 attribute values: TAB,
 * LF, CR — which are themselves normalised by XML parsers, so we encode
 * them numerically to preserve them verbatim).
 *
 * Control characters are emitted as numeric character references
 * (`&#x00;` … `&#x9F;`) rather than dropped, so that the input is fully
 * recoverable.
 */
export function escapeXmlAttr(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    switch (ch) {
      case 0x26: // &
        out += "&amp;";
        break;
      case 0x3c: // <
        out += "&lt;";
        break;
      case 0x3e: // >
        out += "&gt;";
        break;
      case 0x22: // "
        out += "&quot;";
        break;
      case 0x27: // '
        out += "&#39;";
        break;
      default:
        if ((ch >= 0x00 && ch <= 0x1f) || (ch >= 0x7f && ch <= 0x9f)) {
          // Numeric character reference — preserves the value and stops
          // any parser-side whitespace normalisation of attribute values
          // from silently rewriting control chars.
          out += `&#x${ch.toString(16).toUpperCase()};`;
        } else {
          out += s[i];
        }
    }
  }
  return out;
}

/**
 * Escape a string for safe inclusion as XML text content.
 * Escapes `&`, `<`, `>`.
 */
export function escapeXmlText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    switch (ch) {
      case 0x26: // &
        out += "&amp;";
        break;
      case 0x3c: // <
        out += "&lt;";
        break;
      case 0x3e: // >
        out += "&gt;";
        break;
      default:
        out += s[i];
    }
  }
  return out;
}

/**
 * Escape a string for safe inclusion inside a CDATA section.
 *
 * Splits every `]]>` into `]]]]><![CDATA[>` — the only correct escape.
 * Without this, code blocks containing `]]>` structurally close the
 * CDATA wrapper and allow injection of arbitrary storage XML.
 *
 * Works correctly with:
 * - Single `]]>` sequences.
 * - Nested / overlapping sequences such as `]]]]>` (two overlapping
 *   terminators), which must be split recursively from left to right.
 * - Multi-byte UTF-8 text; we operate on the JS string (UTF-16 code
 *   units) and never slice inside a character boundary.
 */
export function escapeCdata(s: string): string {
  // Global regex replace scans left-to-right and is safe against
  // overlapping matches: after the first `]]>` is replaced, the inserted
  // `<![CDATA[` sequence is not re-scanned.
  return s.replace(/\]\]>/g, "]]]]><![CDATA[>");
}
