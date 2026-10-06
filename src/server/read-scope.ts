/**
 * Resolve the read-scope profile settings (`read_spaces`,
 * `read_spaces_enforced`, `redact_patterns`) into what `search_pages` and `get_recent_changes` need.
 *
 * Unlike `spaces`, these are validated at runtime: a malformed value must not
 * silently drop a boundary the operator thought they had configured. An
 * invalid combination yields `{ ok: false }` and `search_pages` refuses every
 * call (and so does `get_recent_changes`) with the message, while the rest of the server keeps working. Messages
 * name the offending field and never echo values (patterns in particular).
 */

import { z } from "zod";
import type { ProfileSettings } from "../shared/profiles.js";
import { readScopeShape } from "./config.js";
import {
  compileRedactor,
  normaliseRedactPattern,
  type Redactor,
} from "./search-redact.js";

const ReadScopeSchema = z.object(readScopeShape);

export type ReadScope =
  | {
      readonly ok: true;
      /** Undefined: no search scoping configured. */
      readonly readSpaces: readonly string[] | undefined;
      readonly enforced: boolean;
      readonly redactor: Redactor | undefined;
    }
  | { readonly ok: false; readonly error: string };

const invalid = (error: string): ReadScope => ({
  ok: false,
  error: `Invalid read-scope profile settings: ${error} Search is disabled until the profile is fixed.`,
});

export function resolveReadScope(settings: ProfileSettings | undefined): ReadScope {
  const parsed = ReadScopeSchema.safeParse({
    read_spaces: settings?.read_spaces,
    read_spaces_enforced: settings?.read_spaces_enforced,
    redact_patterns: settings?.redact_patterns,
  });
  if (!parsed.success) {
    // path + zod's generic message only; issues never carry the offending value.
    const issue = parsed.error.issues[0];
    return invalid(`\`${issue.path.join(".")}\`: ${issue.message}.`);
  }
  const { read_spaces, read_spaces_enforced, redact_patterns } = parsed.data;

  if (read_spaces_enforced === true && read_spaces === undefined) {
    return invalid("`read_spaces_enforced` requires `read_spaces`.");
  }

  const patterns = redact_patterns ?? [];
  if (patterns.some((p) => normaliseRedactPattern(p) === undefined)) {
    return invalid("a `redact_patterns` entry is empty after Unicode normalisation.");
  }

  return {
    ok: true,
    readSpaces: read_spaces === undefined ? undefined : [...new Set(read_spaces)],
    enforced: read_spaces_enforced === true,
    redactor: compileRedactor(patterns),
  };
}
