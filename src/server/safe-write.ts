/**
 * Centralised write-safety pipeline for Confluence page mutations.
 *
 * PRINCIPLE: the only way to write to Confluence is through this pipeline;
 * handlers opt out of guards explicitly, never opt in. Every guard fires by
 * default; each opt-out flag is visible at the call site and reviewable.
 * Adding a new guard automatically enforces it everywhere.
 *
 * Two functions compose the pipeline:
 *   - safePrepareBody: pure; caller input (markdown or storage) →
 *     submit-ready storage. No API calls.
 *   - safeSubmitPage: the only authorised caller of the raw HTTP wrappers.
 *     Owns duplicate-title check (creates), post-transform body guard, and
 *     both success- and failure-path mutation logging.
 *
 * ---------------------------------------------------------------------------
 * DeletedToken.fingerprint format (resolved open question from A1).
 *
 * Rule: `${tagName}${name ? `[${name}]` : ""}` where:
 *   - `tagName` is the stripped tag name (no `ac:`/`ri:` prefix).
 *   - `name` is drawn from the most specific identifying attribute:
 *     * For `ac:structured-macro` whose `ac:name="drawio"`, the value of the
 *       inner `<ac:parameter ac:name="diagramDisplayName">` (filename) if
 *       present; otherwise `diagramName`; otherwise `drawio`.
 *     * For other `ac:structured-macro`, the value of the outer `ac:name`
 *       attribute (panel, info, warning, code, ...).
 *     * For `ac:emoticon`, the value of the outer `ac:name` attribute.
 *     * For any other token, no name suffix is emitted.
 *
 * Examples:
 *   drawio[architecture.drawio]
 *   structured-macro[panel]
 *   structured-macro[code]
 *   emoticon[smile]
 *   link
 *
 * The rule matches what the example row in plans/centralized-write-safety.md
 * §"Surface deletions in the success response" already shows
 * ("drawio[architecture.drawio], structured-macro[panel]"), so callers that
 * format these for users can do so without guessing.
 * ---------------------------------------------------------------------------
 *
 * confirm_deletions handling (design plan §"confirm_deletions UX"):
 *   - string[]   : itemised ack; mismatch against the actual deletion set
 *     throws a structured error listing the actual IDs.
 *   - true       : deprecated blanket ack; accepted with a console.warn that
 *     enumerates the specific token IDs for the caller to paste back on the
 *     next call. Removed in v5.7.
 *   - undefined  : deletions fail with the current DELETIONS_NOT_CONFIRMED
 *     error shape (phrasing reused from planUpdate).
 *
 * versionMessage composition. Reuses the message from planUpdate verbatim
 * when available; falls back to an empty string so the handler can combine
 * it with its own message without the pipeline preempting handler copy.
 *
 * Rationale: see plans/centralized-write-safety.md.
 */

import {
  createPage as _rawCreatePage,
  updatePage as _rawUpdatePage,
  getPageByTitle,
  looksLikeMarkdown,
  type PageData,
} from "./confluence-client.js";
import { markdownToStorage } from "./converter/md-to-storage.js";
import { planUpdate } from "./converter/update-orchestrator.js";
import { enforceContentSafetyGuards } from "./converter/content-safety-guards.js";
import {
  ConverterError,
  type TokenId,
  type TokenSidecar,
} from "./converter/types.js";
import {
  logMutation,
  bodyHash,
  errorRecord,
  type MutationRecord,
} from "./mutation-log.js";
import { tokeniseStorage } from "./converter/tokeniser.js";

/**
 * Scope of the body being prepared. Controls which guards fire and at what
 * threshold.
 *
 * - "full" (default): complete replacement page body; page-scale guards.
 * - "section": a section that will be spliced into a larger body by the
 *   handler. Guards thresholded for section-scale changes; the full-body
 *   post-transform guard still runs in safeSubmitPage after splicing.
 * - "additive": prepared output will be concatenated onto currentBody
 *   unchanged (prepend/append). Token diff and deletion checks are skipped
 *   (nothing is being transformed); content guards still run post-concat
 *   inside safeSubmitPage.
 */
export type SafePrepareScope = "full" | "section" | "additive";

/**
 * A preserved token (macro) removed between currentBody and the prepared
 * output. Surfaced in the SafeSubmitPageOutput so the handler can echo the
 * removals into the tool response.
 */
export interface DeletedToken {
  /** Stable token ID from planUpdate (e.g. "T0003"). */
  id: string;
  /** Storage-format tag name (e.g. "ac:structured-macro", "ac:emoticon"). */
  tag: string;
  /**
   * Short human-readable fingerprint for disambiguation in tool output
   * (e.g. "drawio[architecture.drawio]", "structured-macro[panel]").
   * See the top-of-file comment for the exact derivation rule.
   */
  fingerprint: string;
}

/**
 * Input to safePrepareBody. Pure transformation; no API calls.
 */
export interface SafePrepareBodyInput {
  /**
   * Caller's input body — markdown or Confluence storage format. The
   * pipeline detects markdown via looksLikeMarkdown; storage is pass-through.
   * Markdown is converted via planUpdate when currentBody has preserved
   * tokens, via markdownToStorage otherwise.
   */
  body: string;

  /**
   * The page's current storage-format body. Required for token-aware
   * conversion and structural-guard comparisons.
   *
   * - updates: the full page body at the current version.
   * - creates: undefined.
   * - sections (scope: "section"): the current section body.
   *
   * Note: in section flows this is the SECTION body, but
   * SafeSubmitPageInput.previousBody must be the FULL page body — the two
   * fields serve different purposes.
   */
  currentBody: string | undefined;

  /** Scope of the body. Defaults to "full". See SafePrepareScope. */
  scope?: SafePrepareScope;

  /**
   * Acknowledge deletion of preserved tokens between currentBody and the
   * prepared output.
   *
   * - `string[]`: itemised token IDs the caller acknowledges (e.g.
   *   ["T0003", "T0007"]). If the actual deletion set differs, the pipeline
   *   errors with the correct list. Preferred, reviewable shape.
   * - `true`: deprecated blanket ack. Accepted in **v5.5** with a warning
   *   that enumerates the specific token IDs (so the caller can paste them
   *   back itemised on the next call). **Removed in v5.7.**
   * - `undefined` (default): pipeline errors DELETIONS_NOT_CONFIRMED if any
   *   preserved tokens are missing.
   *
   * Distinct from `replaceBody`: confirmDeletions acknowledges specific
   * deletions against a diff; replaceBody skips the diff entirely.
   */
  confirmDeletions?: string[] | true;

  /** Acknowledge body shrinkage over the guard's threshold (>40%). */
  confirmShrinkage?: boolean;

  /** Acknowledge heading/macro structure reduction. */
  confirmStructureLoss?: boolean;

  /**
   * Intent to overwrite the whole body (e.g. revert_page). Bypasses
   * **token deletion** and **structure-loss** checks — diffing tokens is
   * not meaningful when the caller is replacing everything.
   *
   * **Does not bypass** shrinkage, empty-body, or macro/table-loss guards —
   * those catch accidental catastrophic overwrites even when replacement is
   * intentional.
   *
   * Distinct from `confirmDeletions: true`:
   *   - replaceBody: "I'm replacing everything; don't diff tokens at all."
   *   - confirmDeletions: true: "I've reviewed the specific deletions."
   */
  replaceBody?: boolean;

  /**
   * Permit raw HTML in the input that the looksLikeMarkdown / raw-HTML
   * tripwire would otherwise reject. Opt-in because raw HTML in a markdown
   * context is a common source of malformed storage.
   */
  allowRawHtml?: boolean;

  /**
   * Configured Confluence base URL. When set, enables the link rewriter so
   * that markdown links matching this host are rewritten appropriately.
   * When unset, link rewriting is skipped (not an error). Pass-through from
   * the handler; the module does not resolve credentials internally.
   */
  confluenceBaseUrl?: string;
}

/**
 * Output of safePrepareBody. Feeds directly into safeSubmitPage.
 */
export interface SafePrepareBodyOutput {
  /**
   * Submit-ready Confluence storage. For "full"/"section" this is the
   * transformed body; for "additive" this is the prepared-but-unconcatenated
   * addition that the handler must splice onto currentBody before passing
   * to safeSubmitPage.
   */
  finalStorage: string;

  /**
   * Suggested version message — surfaces deletion metadata and other
   * pipeline observations. Handler forwards this unchanged to
   * safeSubmitPage, which combines it with attribution.
   */
  versionMessage: string;

  /**
   * Preserved tokens removed by this preparation; empty when nothing was
   * removed. Threaded through safeSubmitPage to the final tool response.
   */
  deletedTokens: DeletedToken[];
}

/**
 * Input to safeSubmitPage. The sole authorised caller of the raw
 * _rawUpdatePage / _rawCreatePage wrappers.
 *
 * Create vs. update branching:
 *   - `pageId: undefined` → **create**. `spaceId` is required; `previousBody`
 *     and `version` must be omitted. `parentId` is optional.
 *   - `pageId: string` → **update**. `previousBody` and `version` are
 *     required; `spaceId` / `parentId` are not used.
 *
 * One submit function (rather than separate create/update) is intentional:
 * the shared post-transform guard and mutation-log shape are the whole
 * point of the centralisation.
 */
export interface SafeSubmitPageInput {
  /** `undefined` → create; string → update. */
  pageId: string | undefined;

  /** Required for create; ignored on update. */
  spaceId?: string;

  /** Optional on create; ignored on update. */
  parentId?: string;

  /** Page title. Required for both create and update. */
  title: string;

  /**
   * Submit-ready storage from safePrepareBody (or a handler-spliced full
   * body, for scope "section"). The post-transform body guard runs on this
   * value inside safeSubmitPage — so handler-side splicing damage is caught
   * before the HTTP call.
   */
  finalStorage: string;

  /**
   * The full page body at the current version. Required for updates; must
   * be omitted for creates.
   *
   * IMPORTANT: even in section flows where SafePrepareBodyInput.currentBody
   * was only the section, previousBody here MUST be the full page body. It
   * is used for diff/attribution logging and the post-transform comparison.
   */
  previousBody?: string;

  /**
   * Current page version (the write will be version+1). Required for
   * updates; must be omitted for creates.
   */
  version?: number;

  /**
   * Version message from safePrepareBody. safeSubmitPage combines this with
   * attribution and client-label formatting.
   */
  versionMessage: string;

  /**
   * Tokens removed during preparation, from safePrepareBody.deletedTokens.
   * Echoed into SafeSubmitPageOutput verbatim so the handler has one
   * consolidated object to format for the tool response.
   */
  deletedTokens: DeletedToken[];

  /**
   * Client label (e.g. "claude-code@3.2.1") for attribution and
   * mutation-log entries. Pass-through from the handler — resolved via
   * getClientLabel(server) at the call site.
   */
  clientLabel: string | undefined;

  /**
   * Optional override for the mutation-log operation name. Defaults to
   * `"update_page"` (update branch) or `"create_page"` (create branch).
   * Pass an explicit name for handlers whose tool identity differs from the
   * API method — e.g. `"prepend_to_page"`, `"append_to_page"`,
   * `"revert_page"`. The same name is used for both the success and
   * failure mutation-log records.
   */
  operation?: MutationRecord["operation"];
}

/**
 * Output of safeSubmitPage. The handler shapes this into the tool response.
 *
 * `newVersion` is the version just written (1 for creates). `oldLen` is 0
 * for creates. `deletedTokens` is echoed from the input and never modified
 * inside safeSubmitPage.
 */
export interface SafeSubmitPageOutput {
  /** The page returned by the Confluence API. */
  page: PageData;
  /** New version number after the write (1 for creates). */
  newVersion: number;
  /** Length of previousBody for updates; 0 for creates. */
  oldLen: number;
  /** Length of finalStorage (the body just written). */
  newLen: number;
  /** Tokens removed during preparation (echoed from the input). */
  deletedTokens: DeletedToken[];
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/** Thrown when confirmDeletions list doesn't match the actual deletion set. */
export const DELETION_ACK_MISMATCH = "DELETION_ACK_MISMATCH";
/** Thrown when the post-transform output body is empty or suspiciously small. */
export const POST_TRANSFORM_BODY_REJECTED = "POST_TRANSFORM_BODY_REJECTED";
/** Thrown when the caller passes read-only markdown. */
export const READ_ONLY_MARKDOWN_ROUND_TRIP = "READ_ONLY_MARKDOWN_ROUND_TRIP";

// ---------------------------------------------------------------------------
// Post-transform body guard
// ---------------------------------------------------------------------------

/**
 * The post-transform body guard is a last-line-of-defense check that runs
 * after all conversion, link rewriting, and guard steps. It catches:
 *   - an output that is empty or whitespace-only (e.g. regex transform
 *     wiping the whole body),
 *   - a >90% reduction when the caller provided a substantial body
 *     (threshold matches the original v5.4.0 post-transform guard in
 *     confluence-client.ts — see commit d066b4f).
 *
 * The shrinkage threshold here is intentionally more aggressive than the
 * content-safety shrinkage guard (>90% vs >50%) because this guard has no
 * opt-out and fires only on catastrophic cases. The content-safety guard
 * handles the nuanced 40–90% range with the explicit confirmShrinkage flag.
 */
const POST_TRANSFORM_MIN_INPUT_LEN = 500;
const POST_TRANSFORM_MAX_REDUCTION_RATIO = 0.9; // reject if > 90% reduction

function assertPostTransformBody(inputLen: number, outputBody: string): void {
  // 1. Empty/whitespace-only output: always reject. An empty body is never
  //    valid as the target of a create/update — the caller should use
  //    delete_page instead.
  if (outputBody.trim().length === 0) {
    throw new ConverterError(
      "Post-transform body is empty — refusing to submit. " +
        "This indicates a regex / conversion bug that wiped the body. " +
        "To intentionally clear a page, use delete_page and re-create it.",
      POST_TRANSFORM_BODY_REJECTED,
    );
  }

  // 2. Catastrophic reduction: >90% drop from an input that was >500 chars
  //    is almost certainly a transform bug, not a legitimate rewrite.
  if (
    inputLen > POST_TRANSFORM_MIN_INPUT_LEN &&
    outputBody.length < inputLen * (1 - POST_TRANSFORM_MAX_REDUCTION_RATIO)
  ) {
    const pct = Math.round((1 - outputBody.length / inputLen) * 100);
    throw new ConverterError(
      `Post-transform body shrank by ${pct}% (from ${inputLen} to ${outputBody.length} chars). ` +
        "This almost certainly indicates a conversion bug that wiped content. " +
        "If the shrinkage is intentional, the content-safety shrinkage guard " +
        "(confirm_shrinkage) handles the 40–90% range with an explicit opt-in.",
      POST_TRANSFORM_BODY_REJECTED,
    );
  }
}

// ---------------------------------------------------------------------------
// Deletion fingerprinting
// ---------------------------------------------------------------------------

/**
 * Strip the namespace prefix from a tag name: "ac:structured-macro" → "structured-macro".
 */
function stripNamespacePrefix(tag: string): string {
  const colonIdx = tag.indexOf(":");
  return colonIdx >= 0 ? tag.slice(colonIdx + 1) : tag;
}

/**
 * Extract the opening tag's full string from a sidecar XML entry, or
 * undefined when the entry doesn't begin with a recognisable tag.
 */
function extractOpeningTag(xml: string): string | undefined {
  const m = xml.match(/^<([a-zA-Z][a-zA-Z0-9:_-]*)([^>]*)>/);
  return m ? m[0] : undefined;
}

function extractTagName(xml: string): string | undefined {
  const m = xml.match(/^<([a-zA-Z][a-zA-Z0-9:_-]*)/);
  return m ? m[1] : undefined;
}

/**
 * Compute the fingerprint for a sidecar entry. See the top-of-file comment
 * for the derivation rule.
 */
function computeFingerprint(xml: string | undefined): { tag: string; fingerprint: string } {
  if (!xml) return { tag: "unknown", fingerprint: "unknown" };
  const tagName = extractTagName(xml);
  if (!tagName) return { tag: "unknown", fingerprint: "unknown" };

  const tag = tagName; // full tag incl. namespace (for the `tag` field of DeletedToken)
  const bareTag = stripNamespacePrefix(tagName);

  const openTag = extractOpeningTag(xml);

  // Helper: read ac:name attribute off the opening tag.
  const acNameFromOpenTag = openTag?.match(/\bac:name="([^"]+)"/)?.[1];

  // Special case: drawio — prefer the inner diagramDisplayName / diagramName
  // parameter over the outer ac:name (which is always "drawio").
  if (tagName === "ac:structured-macro" && acNameFromOpenTag === "drawio") {
    const displayName = xml.match(
      /<ac:parameter\s+ac:name="diagramDisplayName"[^>]*>([^<]+)<\/ac:parameter>/,
    )?.[1];
    const diagramName = xml.match(
      /<ac:parameter\s+ac:name="diagramName"[^>]*>([^<]+)<\/ac:parameter>/,
    )?.[1];
    const name = displayName ?? diagramName ?? "drawio";
    return { tag, fingerprint: `drawio[${name}]` };
  }

  // Generic structured-macro or emoticon with an ac:name attribute.
  if (acNameFromOpenTag) {
    return { tag, fingerprint: `${bareTag}[${acNameFromOpenTag}]` };
  }

  // Any other token: no name suffix available.
  return { tag, fingerprint: bareTag };
}

/**
 * Convert planUpdate's `deletedTokens: TokenId[]` (plus the sidecar the
 * tokeniser produced) into the DeletedToken[] surfaced on the public API.
 */
function buildDeletedTokens(
  ids: readonly TokenId[],
  sidecar: TokenSidecar,
): DeletedToken[] {
  return ids.map((id) => {
    const { tag, fingerprint } = computeFingerprint(sidecar[id]);
    return { id, tag, fingerprint };
  });
}

// ---------------------------------------------------------------------------
// confirm_deletions handling
// ---------------------------------------------------------------------------

/**
 * Compare the caller's itemised acknowledgement list against the actual
 * deletion set. On mismatch, throws a structured error that lists the
 * actual IDs so the caller can paste them back on the next attempt.
 *
 * Rules:
 *   - Order doesn't matter; compare as sets.
 *   - Any ID in `ack` that isn't in `actual` → mismatch (the caller
 *     acknowledged a deletion that isn't happening; this usually indicates
 *     stale input from a previous attempt and is worth flagging).
 *   - Any ID in `actual` that isn't in `ack` → mismatch (the standard
 *     "did not ack this deletion" case).
 */
function assertDeletionAckMatches(
  ack: string[],
  actual: DeletedToken[],
): void {
  const ackSet = new Set(ack);
  const actualSet = new Set(actual.map((d) => d.id));
  const missing = actual.filter((d) => !ackSet.has(d.id)).map((d) => d.id);
  const extra = ack.filter((id) => !actualSet.has(id));
  if (missing.length === 0 && extra.length === 0) return;

  const actualList = actual
    .map((d) => `${d.id} (${d.fingerprint})`)
    .join(", ");
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(
      `missing acknowledgement for: ${missing.join(", ")}`,
    );
  }
  if (extra.length > 0) {
    parts.push(`unexpected acknowledgement for: ${extra.join(", ")}`);
  }
  throw new ConverterError(
    `confirm_deletions mismatch — ${parts.join("; ")}. ` +
      `Actual deletion set: [${actualList || "(none)"}]. ` +
      `Re-submit with confirm_deletions set to the exact list of IDs shown above, ` +
      `or omit the deletion entirely.`,
    DELETION_ACK_MISMATCH,
  );
}

/**
 * Emit the deprecation warning for `confirmDeletions: true`. The message
 * names the specific token IDs so callers can migrate to the itemised form
 * on their next call.
 */
function warnBlanketDeletionAck(tokens: DeletedToken[]): void {
  if (tokens.length === 0) return; // nothing deleted — no warning
  const ids = tokens.map((t) => t.id).join(", ");
  console.warn(
    `[epimethian-mcp] confirm_deletions: true is deprecated in v5.5 and will be ` +
      `removed in v5.7. Itemise the token IDs instead: [${ids}]`,
  );
}

// ---------------------------------------------------------------------------
// safePrepareBody
// ---------------------------------------------------------------------------

/**
 * Prepare a body for submission. Pure; no API calls.
 *
 * See the top-of-file header for the full pipeline description. Summary:
 *   1. Read-only-markdown rejection (hard guard, no opt-out).
 *   2. Markdown detection (looksLikeMarkdown).
 *   3. Token-aware conversion (planUpdate / markdownToStorage / pass-through).
 *   4. Link rewriting (inside markdownToStorage when confluenceBaseUrl set).
 *   5. Content safety guards (shrinkage, structure, empty, macro/table loss).
 *   6. Post-transform body guard.
 */
export async function safePrepareBody(
  input: SafePrepareBodyInput,
): Promise<SafePrepareBodyOutput> {
  const {
    body,
    currentBody,
    scope = "full",
    confirmDeletions,
    confirmShrinkage,
    confirmStructureLoss,
    replaceBody,
    allowRawHtml,
    confluenceBaseUrl,
  } = input;

  // 1. Read-only-markdown rejection — hard guard, no opt-out. Mirrors the
  //    identical check in create_page / update_page / update_page_section
  //    handlers; consolidating it here lets those handlers drop their copies.
  if (body.includes("epimethian:read-only-markdown")) {
    throw new ConverterError(
      "The body contains content produced by get_page with format: 'markdown', which is a " +
        "read-only rendering not suitable for round-trip updates (tables, macros, and rich " +
        "elements may be lost). Compose new markdown from scratch, or read with " +
        "format: 'storage' and edit the storage XML.",
      READ_ONLY_MARKDOWN_ROUND_TRIP,
    );
  }

  // Converter options threaded into both the planUpdate and
  // markdownToStorage paths. `allowRawHtml` lifts the raw-HTML tripwire in
  // markdown-it; `confluenceBaseUrl` enables internal-link rewriting.
  const converterOptions = {
    allowRawHtml: allowRawHtml === true,
    ...(confluenceBaseUrl ? { confluenceBaseUrl } : {}),
  };

  // 2. Markdown detection.
  const isMarkdown = looksLikeMarkdown(body);

  // 3. Token-aware conversion.
  //
  // Branch matrix:
  //   - scope: "additive"            → skip planUpdate entirely; if markdown,
  //                                    run markdownToStorage on the caller's
  //                                    body in isolation (never touching
  //                                    currentBody). The handler concatenates.
  //   - markdown + currentBody has <ac:>/<ri:>/<time> elements
  //                                  → planUpdate (token-preserving).
  //   - markdown + no tokens to preserve
  //                                  → markdownToStorage.
  //   - storage format               → pass-through.
  let finalStorage: string;
  let versionMessage = "";
  let deletedTokens: DeletedToken[] = [];

  if (scope === "additive") {
    // Token diff doesn't make sense for additive ops (the current body
    // round-trips unchanged). Content guards still run post-concat inside
    // safeSubmitPage. If markdown, convert the caller's addition only.
    finalStorage = isMarkdown ? markdownToStorage(body, converterOptions) : body;
  } else if (isMarkdown) {
    const hasExistingTokens =
      currentBody !== undefined &&
      (/(<ac:|<ri:|<time[\s/>])/i.test(currentBody));
    if (hasExistingTokens && currentBody !== undefined) {
      // planUpdate handles: tokenise currentBody, diff, convert, rescue
      // code-macro IDs (C1), and compose a version message describing any
      // deletions. It throws ConverterError on INVENTED_TOKEN or (when
      // confirmDeletions is not set) DELETIONS_NOT_CONFIRMED.
      //
      // We pass `confirmDeletions: true` to planUpdate so IT doesn't throw
      // on deletions — the checked acknowledgement is the safePrepareBody
      // caller's responsibility via assertDeletionAckMatches below.
      // planUpdate still *reports* the deletion list, so we can build the
      // itemised diff from its result.
      const plan = planUpdate({
        currentStorage: currentBody,
        callerMarkdown: body,
        confirmDeletions: confirmDeletions !== undefined, // any ack form → plan doesn't re-raise
        replaceBody: replaceBody === true,
        converterOptions,
      });
      finalStorage = plan.newStorage;
      versionMessage = plan.versionMessage ?? "";

      // Reconstruct the sidecar for fingerprinting. (planUpdate's output
      // doesn't surface the sidecar directly — we re-tokenise; cheap and
      // keeps the module boundary clean.)
      const { sidecar } = tokeniseStorage(currentBody);
      deletedTokens = buildDeletedTokens(plan.deletedTokens, sidecar);
    } else {
      // No preservation needed — plain markdown conversion.
      finalStorage = markdownToStorage(body, converterOptions);
    }
  } else {
    // Already storage format — pass through unchanged.
    finalStorage = body;
  }

  // Deletion acknowledgement check. `replaceBody` bypasses the token-diff
  // path entirely (planUpdate returns deletedTokens: []), so this block
  // only fires when a genuine diff reported deletions.
  if (deletedTokens.length > 0) {
    if (confirmDeletions === undefined) {
      // Match the current DELETIONS_NOT_CONFIRMED error shape from
      // planUpdate so migrating handlers don't need to update assertions.
      const summary = deletedTokens
        .map((d) => `${d.id} (${d.fingerprint})`)
        .join(", ");
      const noun = deletedTokens.length === 1 ? "element" : "elements";
      throw new ConverterError(
        `caller markdown would delete ${deletedTokens.length} preserved ${noun}: ${summary}. ` +
          `Re-submit with confirm_deletions: true to acknowledge the removal.`,
        "DELETIONS_NOT_CONFIRMED",
      );
    }
    if (confirmDeletions === true) {
      // Deprecated blanket ack — accepted, but the warning lists the
      // specific IDs for the next call.
      warnBlanketDeletionAck(deletedTokens);
    } else {
      // Itemised ack — must exactly match the actual deletion set.
      assertDeletionAckMatches(confirmDeletions, deletedTokens);
    }
  } else if (Array.isArray(confirmDeletions) && confirmDeletions.length > 0) {
    // Caller acked deletions that didn't happen. Surface the mismatch so
    // stale ack lists don't go unnoticed.
    assertDeletionAckMatches(confirmDeletions, deletedTokens);
  }

  // 5. Content safety guards.
  //
  // Additive scope: guards run in safeSubmitPage on the spliced full body.
  // Full/section: guards run here on the prepared body.
  //
  // replaceBody: bypasses token-deletion AND structure-loss checks but NOT
  // shrinkage/empty-body/macro-loss. Token deletion is already handled above
  // via the scope-"additive" branch / planUpdate's replaceBody parameter;
  // we pass confirmStructureLoss-effective to enforceContentSafetyGuards.
  if (scope !== "additive" && currentBody !== undefined) {
    enforceContentSafetyGuards({
      oldStorage: currentBody,
      newStorage: finalStorage,
      confirmShrinkage,
      confirmStructureLoss: confirmStructureLoss || replaceBody === true,
      // confirmDeletions (any truthy form, incl. a non-empty string[]) OR
      // replaceBody both indicate the caller has acknowledged macro/element
      // removal — bypass the macro and table loss guards, but NOT the
      // shrinkage/structure guards.
      confirmDeletions: confirmDeletions !== undefined || replaceBody === true,
    });
  }

  // 6. Post-transform body guard. Measures input → output reduction
  // against the caller-supplied body (not currentBody): this is a
  // transformation-bug guard, not a shrinkage guard. For "additive" scope
  // the handler will concat after prepare; safeSubmitPage re-runs the guard
  // on the spliced full body to catch catastrophic post-concat damage.
  assertPostTransformBody(body.length, finalStorage);

  return { finalStorage, versionMessage, deletedTokens };
}

// ---------------------------------------------------------------------------
// safeSubmitPage
// ---------------------------------------------------------------------------

/**
 * Submit a prepared body to Confluence via the raw HTTP wrappers. Owns the
 * duplicate-title check (creates), the post-transform body guard, and both
 * success- and failure-path mutation logging.
 */
export async function safeSubmitPage(
  input: SafeSubmitPageInput,
): Promise<SafeSubmitPageOutput> {
  const {
    pageId,
    spaceId,
    parentId,
    title,
    finalStorage,
    previousBody,
    version,
    versionMessage,
    deletedTokens,
    clientLabel,
    operation,
  } = input;

  const isCreate = pageId === undefined;
  const resolvedOperation: MutationRecord["operation"] =
    operation ?? (isCreate ? "create_page" : "update_page");

  // 1. Duplicate-title check (create only).
  //
  // Byte-identical error shape to the current create_page handler in
  // src/server/index.ts — see plans/centralized-write-safety.md §A6 (
  // "Preserve duplicate-title error verbatim"). The wording is asserted by
  // a regression test in safe-write.test.ts.
  if (isCreate) {
    if (!spaceId) {
      throw new Error("safeSubmitPage: spaceId is required for create");
    }
    const existing = await getPageByTitle(spaceId, title, false);
    if (existing) {
      throw new Error(
        `A page titled "${title}" already exists in this space (page ID: ${existing.id}). ` +
          `Creating another page with the same title would produce a confusing duplicate. ` +
          `If you intend to modify the existing page, call get_page with ID ${existing.id} first ` +
          `to review its current content before deciding whether to update it.`,
      );
    }
  }

  // 2. Post-submit safety guard — re-runs the post-transform body guard on
  // finalStorage independent of prepare's decision. Catches section-splicing
  // damage in handlers that splice prepared output into a larger body
  // between calling safePrepareBody and safeSubmitPage.
  const oldLen = previousBody?.length ?? 0;
  assertPostTransformBody(oldLen > 0 ? oldLen : finalStorage.length, finalStorage);

  // 3. API call — wrapped in try/catch so both success and failure are
  //    mutation-logged.
  try {
    let page: PageData;
    let newVersion: number;
    if (isCreate) {
      page = await _rawCreatePage(
        spaceId!,
        title,
        finalStorage,
        parentId,
        clientLabel,
      );
      newVersion = page.version?.number ?? 1;
    } else {
      if (version === undefined) {
        throw new Error("safeSubmitPage: version is required for update");
      }
      const res = await _rawUpdatePage(pageId!, {
        title,
        body: finalStorage,
        version,
        versionMessage,
        previousBody,
        clientLabel,
      });
      page = res.page;
      newVersion = res.newVersion;
    }

    // 4. Mutation log (success). Shape matches the current handler
    //    emissions: { timestamp, operation, pageId, oldVersion, newVersion,
    //    oldBodyLen, newBodyLen, oldBodyHash, newBodyHash, clientLabel }.
    const record: MutationRecord = {
      timestamp: new Date().toISOString(),
      operation: resolvedOperation,
      pageId: page.id,
      newVersion,
      newBodyLen: finalStorage.length,
      newBodyHash: bodyHash(finalStorage),
      clientLabel,
    };
    if (!isCreate) {
      record.oldVersion = version;
      record.oldBodyLen = previousBody?.length ?? 0;
      if (previousBody !== undefined) {
        record.oldBodyHash = bodyHash(previousBody);
      }
    }
    logMutation(record);

    return {
      page,
      newVersion,
      oldLen,
      newLen: finalStorage.length,
      deletedTokens,
    };
  } catch (err) {
    // 5. Mutation log (failure). Reuse the current errorRecord shape; the
    //    operation name is the same one that would have been used on
    //    success, so downstream forensics see a consistent name per tool.
    const errPageId = isCreate ? "unknown" : pageId!;
    logMutation(
      errorRecord(resolvedOperation, errPageId, err, {
        oldVersion: version,
      }),
    );
    throw err;
  }
}
