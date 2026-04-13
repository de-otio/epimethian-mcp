/**
 * Token-aware write path for `update_page`.
 *
 * This module orchestrates the data-preservation invariant defined in
 * doc/design/investigations/investigate-confluence-specific-elements/
 * 01-data-preservation.md: when a caller submits a markdown body to
 * update an existing page, every pre-existing `<ac:>`/`<ri:>`/`<time>`
 * element is either preserved byte-for-byte (if its token survived in
 * the caller's markdown) or reported as an explicit deletion (if the
 * caller removed its token). New tokens the caller invents are treated
 * as forgery and rejected; unconfirmed deletions are rejected by
 * default so the agent is forced to acknowledge what's being dropped.
 *
 * The function is pure — no HTTP, no Confluence client calls. Stream 5
 * will wire it into `update_page`.
 */

import { tokeniseStorage } from "./tokeniser.js";
import { restoreFromTokens } from "./restore.js";
import { markdownToStorage } from "./md-to-storage.js";
import { diffTokens } from "./diff.js";
import {
  ConverterError,
  type ConverterOptions,
  type TokenDiff,
  type TokenId,
  type TokenSidecar,
} from "./types.js";

/**
 * Inputs accepted by the `planUpdate` orchestrator.
 */
export interface PlanUpdateInput {
  /** The page's current storage XML, as returned by a prior `get_page` call. */
  currentStorage: string;
  /** The markdown body the caller submitted on this update. */
  callerMarkdown: string;
  /**
   * If `true`, the caller has acknowledged they are deleting some of
   * the preserved elements. Default `false` — any deletion triggers
   * a `DELETIONS_NOT_CONFIRMED` error.
   */
  confirmDeletions?: boolean;
  /**
   * If `true`, skip preservation entirely and treat the caller's
   * markdown as a wholesale replacement. Default `false`.
   */
  replaceBody?: boolean;
  /**
   * Options forwarded to `markdownToStorage`. See that module for
   * supported fields (`allowRawHtml`, `confluenceBaseUrl`).
   */
  converterOptions?: ConverterOptions;
}

/**
 * Plan produced by `planUpdate`: the final storage body to submit,
 * plus metadata about what was changed for the version-message log.
 */
export interface UpdatePlan {
  /** Final storage XML to submit to Confluence. */
  newStorage: string;
  /**
   * Token IDs that were present in the pre-edit canonical but absent
   * from the caller's markdown, i.e. the elements that will disappear
   * from the page as a result of this update. Empty when the caller
   * preserved everything.
   */
  deletedTokens: TokenId[];
  /**
   * Human-readable version message summarising deletions. Only set when
   * `deletedTokens.length > 0`; undefined otherwise so the caller can
   * decide whether to override the default commit message.
   */
  versionMessage?: string;
}

/**
 * Matches a paragraph that contains only tokens and whitespace.
 *
 * The markdown→storage converter wraps every standalone token in a
 * `<p>[[epi:T####]]</p>` paragraph because markdown-it treats a bare
 * token on its own line as a paragraph. For block-level tokenised
 * elements (the common case — `<ac:structured-macro>`, `<ac:layout>`,
 * etc.) this wrapper is incorrect: the original storage had the macro
 * at block level, not inside a paragraph. This regex identifies those
 * token-only paragraphs so they can be unwrapped before the tokens are
 * restored — preserving byte-identity on the round trip.
 *
 * Paragraphs that contain text in addition to tokens (e.g. inline
 * `<ac:emoticon>` alongside words) are NOT matched; the `<p>` wrap is
 * correct in that case.
 */
const TOKEN_ONLY_PARAGRAPH_RE =
  /<p>((?:\s*\[\[epi:T\d+\]\])+\s*)<\/p>\n?/g;

/**
 * Strip the `<p>` wrapper around paragraphs that contain only tokens
 * and whitespace. See {@link TOKEN_ONLY_PARAGRAPH_RE}.
 */
function unwrapTokenOnlyParagraphs(storage: string): string {
  return storage.replace(TOKEN_ONLY_PARAGRAPH_RE, (_match, inner: string) => {
    // Strip surrounding whitespace inside the paragraph so that
    // adjacent block-level tokens end up concatenated, matching the
    // tokeniser's canonical form for siblings.
    return inner.trim();
  });
}

/**
 * Extract the top-level tag name from a sidecar entry, for use in
 * user-facing version messages. For `<ac:structured-macro ac:name="info">…`
 * returns `ac:structured-macro ac:name="info"`. For a plain `<ac:emoticon/>`
 * returns `ac:emoticon`. Returns `unknown` if the entry doesn't start
 * with a recognisable tag.
 *
 * SECURITY: this function extracts ONLY the tag name and, for
 * structured-macro, the `ac:name` attribute — never the inner content.
 * See 06-security.md §11: error/log messages must not leak sidecar
 * content to callers.
 */
function describeSidecarEntry(xml: string | undefined): string {
  if (!xml) return "unknown";
  const tagMatch = xml.match(/^<([a-zA-Z][a-zA-Z0-9:_-]*)/);
  if (!tagMatch) return "unknown";
  const tag = tagMatch[1]!;
  // For structured-macro, surface the macro name too — it's part of
  // the identity of the element, not its content.
  const nameMatch = xml.match(/\bac:name="([^"]+)"/);
  if (tag === "ac:structured-macro" && nameMatch) {
    return `${tag} ac:name="${nameMatch[1]}"`;
  }
  return tag;
}

/**
 * Compose the version message logged when a caller's update drops
 * preserved tokens. Lists the token IDs and tag names, never content.
 */
function buildVersionMessage(
  deleted: TokenId[],
  sidecar: TokenSidecar
): string {
  const parts = deleted.map((id) => `${id} (${describeSidecarEntry(sidecar[id])})`);
  return `Removed ${deleted.length} preserved element${deleted.length === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

/**
 * Build a `DELETIONS_NOT_CONFIRMED` error payload. The message includes
 * tag names (to help the caller understand what would be lost) but
 * never sidecar content (06-security.md §11).
 */
function buildDeletionError(
  deleted: TokenId[],
  sidecar: TokenSidecar
): ConverterError {
  const summary = deleted
    .map((id) => `${id} (${describeSidecarEntry(sidecar[id])})`)
    .join(", ");
  const noun = deleted.length === 1 ? "element" : "elements";
  return new ConverterError(
    `caller markdown would delete ${deleted.length} preserved ${noun}: ${summary}. ` +
      `Re-submit with confirm_deletions: true to acknowledge the removal.`,
    "DELETIONS_NOT_CONFIRMED"
  );
}

/**
 * Compute the final storage body and deletion metadata for an
 * `update_page` call. Pure function — does not touch Confluence.
 *
 * Algorithm:
 *   1. If `replaceBody` is set, skip preservation entirely and just
 *      convert the caller's markdown (wholesale rewrite path).
 *   2. Otherwise, tokenise the current storage and diff the caller's
 *      markdown against the resulting canonical.
 *   3. Invented tokens → `ConverterError(INVENTED_TOKEN)`.
 *   4. Deletions without `confirmDeletions` → `ConverterError(DELETIONS_NOT_CONFIRMED)`.
 *   5. Convert caller markdown via `markdownToStorage` (tokens pass
 *      through as text for preserved IDs).
 *   6. Unwrap `<p>`-only paragraphs that contain just tokens (see
 *      {@link TOKEN_ONLY_PARAGRAPH_RE}).
 *   7. Restore preserved tokens from the sidecar byte-for-byte. The
 *      sidecar contains entries for deleted tokens too, but those
 *      tokens are absent from the output, so `restoreFromTokens`
 *      simply doesn't replace them — deletions become silent absences.
 *   8. Compose a version message listing the deleted IDs and return.
 *
 * @throws ConverterError with codes `INVENTED_TOKEN`, `DELETIONS_NOT_CONFIRMED`,
 *   or any code surfaced by `markdownToStorage` / `restoreFromTokens`.
 */
export function planUpdate(params: PlanUpdateInput): UpdatePlan {
  const {
    currentStorage,
    callerMarkdown,
    confirmDeletions = false,
    replaceBody = false,
    converterOptions,
  } = params;

  // 1. Wholesale rewrite path: no tokenisation, no preservation.
  if (replaceBody) {
    const newStorage = markdownToStorage(callerMarkdown, converterOptions);
    return { newStorage, deletedTokens: [] };
  }

  // 2. Tokenise the current storage to discover what must be preserved.
  const { canonical, sidecar } = tokeniseStorage(currentStorage);

  // 3. Diff caller's markdown against the canonical pre-edit markdown.
  const diff: TokenDiff = diffTokens(canonical, callerMarkdown, sidecar);

  // 4. Invented tokens are forgery — reject unconditionally. Phrasing
  //    matches the contract in the Stream 4 spec; IDs only, never
  //    sidecar content.
  if (diff.invented.length > 0) {
    throw new ConverterError(
      `caller markdown contains unknown token IDs: ${diff.invented.join(", ")}`,
      "INVENTED_TOKEN"
    );
  }

  // 5. Deletions gate: caller must opt in explicitly to losing any
  //    preserved element.
  if (diff.deleted.length > 0 && !confirmDeletions) {
    throw buildDeletionError(diff.deleted, sidecar);
  }

  // 6. Convert the caller's markdown into storage. For preserved
  //    tokens, the literal `[[epi:T####]]` passes through as text.
  const storageFromConverter = markdownToStorage(
    callerMarkdown,
    converterOptions
  );

  // 7. Unwrap `<p>` wrappers introduced by markdown-it around bare
  //    block-level tokens (so the restored macro ends up at block
  //    level, not inside a paragraph — see TOKEN_ONLY_PARAGRAPH_RE).
  const unwrapped = unwrapTokenOnlyParagraphs(storageFromConverter);

  // 8. Restore preserved tokens. Deleted tokens have no presence in
  //    `unwrapped`, so their sidecar entries are silently unused.
  const newStorage = restoreFromTokens(unwrapped, sidecar);

  // 9. Compose the version message (only if there were deletions).
  const versionMessage =
    diff.deleted.length > 0
      ? buildVersionMessage(diff.deleted, sidecar)
      : undefined;

  return {
    newStorage,
    deletedTokens: diff.deleted,
    ...(versionMessage !== undefined ? { versionMessage } : {}),
  };
}
