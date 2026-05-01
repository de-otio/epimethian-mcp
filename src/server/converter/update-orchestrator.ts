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

// ---------------------------------------------------------------------------
// Stable code-macro IDs (C1).
//
// Context: when a caller re-emits a fenced code block in their markdown,
// `markdownToStorage` produces a brand-new `<ac:structured-macro ac:name="code"
// ac:macro-id="{fresh UUID}">` element. The old code macro from the page's
// current storage has a different `ac:macro-id`. Structurally this looks like
// "old code token deleted, new untracked code macro inserted" — `planUpdate`
// reports a deletion and demands `confirm_deletions: true`.
//
// That confirmation requirement is non-semantic churn: the caller did not
// change anything meaningful. Worse, `confirm_deletions: true` is a blanket
// ack that silently also accepts *unrelated* deletions (e.g. an embedded
// drawio macro the caller never noticed) — see the 5.5.x incident in
// plans/centralized-write-safety.md.
//
// The fix (narrow, code-macro specific): when a newly-emitted code macro's
// normalised body text matches a sidecar entry for a code macro that the
// diff classified as "deleted", treat that as the SAME macro. Swap the new
// macro in the converted output for the old sidecar XML (preserving the old
// `ac:macro-id`), and remove that token ID from the deletion list.
//
// Intentionally NOT extended to other macros (drawio, panel, info, etc.) —
// those legitimately need `confirm_deletions` when removed. C1 narrows the
// deletion signal, it does not broaden it.
// ---------------------------------------------------------------------------

/**
 * Matches a self-contained code macro: `<ac:structured-macro ac:name="code" ...>
 * ...<ac:plain-text-body><![CDATA[...]]></ac:plain-text-body>...</ac:structured-macro>`.
 *
 * Attribute order on the opening tag may differ between an emission from
 * `md-to-storage`'s fence renderer (attrs in one order) and a Confluence
 * sidecar entry (attrs in a potentially different order). The regex anchors
 * on `ac:name="code"` appearing anywhere in the opening tag's attribute list,
 * and treats the body up to the matching close tag as a unit.
 *
 * Non-greedy up to the *first* `</ac:structured-macro>` — code macros don't
 * nest other structured macros (their body is CDATA), so first-close is
 * always the right close.
 */
const CODE_MACRO_RE =
  /<ac:structured-macro\b[^>]*\bac:name="code"[^>]*>[\s\S]*?<\/ac:structured-macro>/g;

/**
 * Extract the plain-text body (the text inside `<![CDATA[...]]>`) from a
 * code macro's outer XML. Returns `undefined` if the macro has no
 * `<ac:plain-text-body>` or no `<![CDATA[...]]>` inside it — those shapes
 * can't be safely matched for reuse.
 *
 * Confluence-emitted code macros may emit `<![CDATA[...]]]]><![CDATA[...]]>`
 * sequences to escape literal `]]>` in the body; we concatenate all CDATA
 * runs inside `<ac:plain-text-body>` so the round-tripped body is captured
 * as a single string.
 */
function extractCodeMacroBody(macroXml: string): string | undefined {
  const bodyMatch = macroXml.match(
    /<ac:plain-text-body>([\s\S]*?)<\/ac:plain-text-body>/
  );
  if (!bodyMatch) return undefined;
  const bodyInner = bodyMatch[1]!;
  // Concatenate all CDATA runs; non-CDATA content between them (usually the
  // `]]` split trick) is dropped per the CDATA escape convention.
  const cdataRe = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let body = "";
  let sawCdata = false;
  for (const m of bodyInner.matchAll(cdataRe)) {
    sawCdata = true;
    body += m[1]!;
  }
  if (!sawCdata) return undefined;
  return body;
}

/**
 * Normalise a code macro body for reuse matching. Per the C1 spec: trim
 * leading/trailing whitespace on the body text; preserve internal
 * whitespace exactly; compare case-sensitively.
 */
function normaliseCodeBody(body: string): string {
  return body.replace(/^\s+|\s+$/g, "");
}

/**
 * Heuristic: is this sidecar entry a code macro? A code macro's outer XML
 * has `ac:structured-macro` as its top tag and carries `ac:name="code"`
 * in its attribute list. We check the OPENING tag only — nested macros
 * can't appear inside a code body (the body is CDATA), so a nested match
 * inside a panel wouldn't survive tokenisation (the panel tokenises
 * outermost-first and its inner code macro is opaque under the panel).
 */
function isCodeMacro(sidecarXml: string): boolean {
  const openTagMatch = sidecarXml.match(/^<ac:structured-macro\b[^>]*>/);
  if (!openTagMatch) return false;
  return /\bac:name="code"(?:\s|>|$)/.test(openTagMatch[0]);
}

/**
 * Build a lookup table for code-macro reuse: for every deleted token whose
 * sidecar entry is a code macro with an extractable body, map the
 * normalised body text to that token ID. Multiple deleted code macros
 * with the same normalised body collapse into the *first* (stable, in
 * document order); subsequent matches won't be reused because the first
 * one will already be claimed.
 */
function buildDeletedCodeBodyIndex(
  deleted: TokenId[],
  sidecar: TokenSidecar
): Map<string, TokenId> {
  const index = new Map<string, TokenId>();
  for (const id of deleted) {
    const xml = sidecar[id];
    if (!xml) continue;
    if (!isCodeMacro(xml)) continue;
    const body = extractCodeMacroBody(xml);
    if (body === undefined) continue;
    const key = normaliseCodeBody(body);
    if (!index.has(key)) {
      index.set(key, id);
    }
  }
  return index;
}

/**
 * Result of the code-macro rescue pass.
 */
interface CodeMacroRescueResult {
  /** Storage with matched new code macros swapped for their old sidecar XML. */
  rewrittenStorage: string;
  /** Token IDs that were "rescued" — claimed by a matching new code macro and therefore no longer deleted. */
  rescuedIds: Set<TokenId>;
}

/**
 * Scan the converted storage for newly-emitted code macros and, for each
 * one whose normalised body matches a deleted code-macro sidecar entry,
 * replace the new macro's outer XML with the old sidecar XML. This
 * reuses the old `ac:macro-id` so the diff no longer reports a deletion.
 *
 * Reuse is 1:1 — each deleted sidecar entry can only rescue a single
 * new emission. If the caller re-emitted the same code body twice, the
 * second emission keeps its new UUID (there's no old sidecar entry left
 * to swap it for). This is the right behaviour: a caller who duplicated
 * a code block is adding content, not preserving it.
 */
function rescueStableCodeMacroIds(
  storage: string,
  deleted: TokenId[],
  sidecar: TokenSidecar
): CodeMacroRescueResult {
  const rescuedIds = new Set<TokenId>();
  if (deleted.length === 0) {
    return { rewrittenStorage: storage, rescuedIds };
  }
  const bodyIndex = buildDeletedCodeBodyIndex(deleted, sidecar);
  if (bodyIndex.size === 0) {
    return { rewrittenStorage: storage, rescuedIds };
  }

  const rewrittenStorage = storage.replace(CODE_MACRO_RE, (match) => {
    const body = extractCodeMacroBody(match);
    if (body === undefined) return match;
    const key = normaliseCodeBody(body);
    const hitId = bodyIndex.get(key);
    if (hitId === undefined) return match;
    // Claim this token — each sidecar entry rescues at most one emission.
    bodyIndex.delete(key);
    rescuedIds.add(hitId);
    return sidecar[hitId]!;
  });

  return { rewrittenStorage, rescuedIds };
}

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
 *   4. Convert caller markdown via `markdownToStorage` (tokens pass
 *      through as text for preserved IDs).
 *   5. Code-macro rescue (C1): swap newly-emitted code macros whose
 *      normalised body matches a deleted sidecar code macro for the
 *      old sidecar XML, and drop those IDs from the deletion list.
 *   6. Remaining deletions without `confirmDeletions` →
 *      `ConverterError(DELETIONS_NOT_CONFIRMED)`.
 *   7. Unwrap `<p>`-only paragraphs that contain just tokens (see
 *      {@link TOKEN_ONLY_PARAGRAPH_RE}).
 *   8. Restore preserved tokens from the sidecar byte-for-byte. The
 *      sidecar contains entries for deleted tokens too, but those
 *      tokens are absent from the output, so `restoreFromTokens`
 *      simply doesn't replace them — deletions become silent absences.
 *   9. Compose a version message listing the remaining deleted IDs
 *      and return.
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
    // Tokenise just to discover what will be lost — this information
    // feeds the version message so audits can see what was dropped.
    const { sidecar } = tokeniseStorage(currentStorage);
    const droppedCount = Object.keys(sidecar).length;
    const versionMessage = droppedCount > 0
      ? `Wholesale rewrite (replace_body): dropped ${droppedCount} preserved element(s)`
      : undefined;
    return { newStorage, deletedTokens: [], versionMessage };
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

  // 5. Convert the caller's markdown into storage. For preserved
  //    tokens, the literal `[[epi:T####]]` passes through as text.
  //
  //    Intentionally runs BEFORE the deletions gate (below), because
  //    step 6 (code-macro rescue) can reclassify a would-be deletion
  //    as a reuse, in which case the gate must not fire. See C1.
  const storageFromConverter = markdownToStorage(
    callerMarkdown,
    converterOptions
  );

  // 6. Code-macro rescue (C1): when the caller re-emits a fenced code
  //    block with an unchanged body, `markdownToStorage` generates a
  //    fresh `ac:macro-id` UUID. Without this step the diff would
  //    classify the old code macro as deleted and the new one as
  //    non-token noise, forcing `confirm_deletions: true` for what is
  //    semantically a no-op. The rescue matches new code macros to
  //    deleted sidecar code macros by normalised body text and swaps
  //    the new XML for the old (preserving the old macro-id), then
  //    removes those IDs from the deletion list.
  //
  //    Narrow by design: code macros only. Other macro deletions still
  //    require explicit confirmation.
  const { rewrittenStorage, rescuedIds } = rescueStableCodeMacroIds(
    storageFromConverter,
    diff.deleted,
    sidecar
  );
  const remainingDeleted =
    rescuedIds.size > 0
      ? diff.deleted.filter((id) => !rescuedIds.has(id))
      : diff.deleted;

  // 7. Deletions gate: caller must opt in explicitly to losing any
  //    preserved element (after rescue has settled which tokens are
  //    genuinely going away).
  if (remainingDeleted.length > 0 && !confirmDeletions) {
    throw buildDeletionError(remainingDeleted, sidecar);
  }

  // 8. Unwrap `<p>` wrappers introduced by markdown-it around bare
  //    block-level tokens (so the restored macro ends up at block
  //    level, not inside a paragraph — see TOKEN_ONLY_PARAGRAPH_RE).
  const unwrapped = unwrapTokenOnlyParagraphs(rewrittenStorage);

  // 9. Restore preserved tokens. Remaining deleted tokens have no
  //    presence in `unwrapped`, so their sidecar entries are silently
  //    unused.
  const newStorage = restoreFromTokens(unwrapped, sidecar);

  // 10. Compose the version message (only if there were *genuine*
  //     deletions — rescued code macros are intentionally silent; they
  //     represent a no-op replacement, not a user-visible change).
  const versionMessage =
    remainingDeleted.length > 0
      ? buildVersionMessage(remainingDeleted, sidecar)
      : undefined;

  return {
    newStorage,
    deletedTokens: remainingDeleted,
    ...(versionMessage !== undefined ? { versionMessage } : {}),
  };
}
