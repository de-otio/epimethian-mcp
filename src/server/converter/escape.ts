/**
 * XML / CDATA escaping for Confluence storage format output.
 *
 * SECURITY: every helper here is on the security boundary — see
 * doc/design/investigations/investigate-confluence-specific-elements/06-security.md.
 *
 * Stream 0: stub. Stream 1 implements.
 */

/**
 * Escape a string for safe inclusion in an XML attribute value.
 * Escapes &, <, >, ", ', and control characters.
 */
export function escapeXmlAttr(_s: string): string {
  throw new Error("escapeXmlAttr: not implemented (Stream 1)");
}

/**
 * Escape a string for safe inclusion as XML text content.
 * Escapes &, <, >.
 */
export function escapeXmlText(_s: string): string {
  throw new Error("escapeXmlText: not implemented (Stream 1)");
}

/**
 * Escape a string for safe inclusion inside a CDATA section.
 *
 * Splits every "]]>" into "]]]]><![CDATA[>" — the only correct escape.
 * Without this, code blocks containing "]]>" structurally close the
 * CDATA wrapper and allow injection of arbitrary storage XML.
 */
export function escapeCdata(_s: string): string {
  throw new Error("escapeCdata: not implemented (Stream 1)");
}
