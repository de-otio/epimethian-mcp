import { z } from "zod";

/**
 * Reusable Zod schema for the `version` field on mutation tools.
 *
 * Accepts:
 *   - a positive integer (the page version number from get_page);
 *   - the string literal "current" to skip the read;
 *   - a string-encoded positive integer (e.g. "6"), which is coerced to
 *     a number. This handles a known LM serialisation quirk where an
 *     integer inside a tagged union with a string-literal alternative
 *     is occasionally emitted as a JSON string. Coercion is narrow:
 *     only matches `^\d+$` and only when the raw value is a string.
 *
 * Rejected inputs (not coerced):
 *   - empty string, whitespace-padded strings (" 6 "), decimal strings
 *     ("6.0"), negative strings ("-6"), zero (0), negative integers,
 *     non-integer floats (6.5), and any other string not matching `^\d+$`.
 */
export const versionField: z.ZodType<number | "current"> = z.union([
  z.preprocess(
    (v) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v),
    z.number().int().positive(),
  ),
  z.literal("current"),
]);
