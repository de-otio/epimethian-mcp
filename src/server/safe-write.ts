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
 *   - `name` is tenant text, shown unfenced: it passes through
 *     safeMacroLabel ([A-Za-z0-9 _.-], at most 64 characters, `?` if empty).
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
  _rawCreatePage,
  _rawUpdatePage,
  extractSection,
  extractSectionBody,
  getPageByTitle,
  looksLikeMarkdown,
  normalizeBodyForSubmit,
  type PageData,
} from "./confluence-client.js";
import {
  computeDiffHash,
  validateToken,
  invalidateForPage,
} from "./confirmation-tokens.js";
import {
  isBatchTokenShape,
  validateBatchToken,
} from "./batch-tokens.js";
import { markdownToStorage } from "./converter/md-to-storage.js";
import { planUpdate, safeMacroLabel } from "./converter/update-orchestrator.js";
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
import {
  TOKEN_LITERAL_PREFIX,
  tokeniseStorage,
} from "./converter/tokeniser.js";
import {
  CLOSE_FENCE,
  OPEN_FENCE_PREFIX,
  recentSignalsTracker,
} from "./converter/untrusted-fence.js";
import {
  detectUntrustedFenceInWrite,
  getSessionCanary,
} from "./session-canary.js";
import {
  applyFindReplace,
  countBareCdataDelimiters,
  SECTION_LOCAL_IDS_NOTE,
  type FindReplacePair,
  type FindReplacePairOutcome,
} from "./converter/find-replace-engine.js";
import { createHash } from "node:crypto";
import { writeBudget } from "./write-budget.js";
import {
  canonicaliseToken,
  type MacroKind,
} from "./safe-write-canonicaliser.js";

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
 * Track C1: a (deleted, created) token pair whose post-canonicalisation XML
 * is byte-equivalent. Surfaced when
 * EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS=true and the deletion-tracking
 * pipeline detected the same macro re-emitted with different attribute
 * ordering (or other canonical-form-preserving changes).
 *
 * The user-confirmation gate (assertDeletionAckMatches) treats these pairs
 * as no-ops: the agent didn't lose anything, just re-rendered the same
 * macro. The audit log records the suppression so a postmortem can
 * reconstruct what was bypassed.
 *
 * Carries no content: only the pre-existing-side token ID, the freshly
 * emitted token ID, and the macro kind classification.
 */
export interface RegeneratedTokenPair {
  /** Token ID that existed in the page before the update (sidecar A). */
  oldId: TokenId;
  /** Token ID emitted by the converter for the regenerated equivalent (sidecar B). */
  newId: TokenId;
  /** Macro kind classification — e.g. "ac:link", "ac:structured-macro:toc". */
  kind: MacroKind;
}

/**
 * Feature flag for byte-equivalent deletion suppression (Track C1).
 *
 * When OFF (default for 6.3.0): the deletion-tracking pipeline behaves
 * exactly as it did before — every token-id deletion counts as a semantic
 * deletion and the user-confirmation gate fires for them all.
 *
 * When ON (`EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS=true`): each deletion
 * is paired against any "newly created" token whose canonical key matches.
 * Matched pairs become {@link RegeneratedTokenPair}s, are removed from the
 * deletion set passed to the gate, and are recorded in the audit log.
 *
 * Strict-by-default safety:
 *   - The canonicaliser refuses to interpret unknown shapes (every such
 *     token gets a unique opaque key, so it cannot match anything else).
 *   - Two tokens are equivalent ONLY when every meaningful attribute
 *     matches. See safe-write-canonicaliser.ts for the per-kind rules.
 *
 * Resolved at call time, not at module load, so test suites can toggle
 * the flag with `process.env`.
 */
function suppressEquivalentDeletionsEnabled(): boolean {
  const v = process.env.EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS;
  return v === "true" || v === "1";
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
   *
   * `undefined` is valid only for title-only updates (pageId set,
   * body absent): the whole transformation pipeline is skipped and
   * safeSubmitPage will submit without a `body` field, leaving page
   * content untouched. Creates with `body === undefined` error.
   */
  body: string | undefined;

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
   * Scope "section" only: the COMPLETE current page body (not just the
   * section). When provided, the shrinkage / structure / floor guards are
   * evaluated against the projected full page (the section body swapped in
   * place) rather than the isolated section fragment. This stops a small,
   * benign edit to a small section — e.g. removing one macro — from reading
   * as a >50% "loss" just because the section it lives in is short. Ignored
   * for non-section scopes and when the current section body is not found
   * verbatim inside it (falls back to fragment-relative measurement).
   */
  fullPageBody?: string;

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
   *
   * `undefined` for title-only updates (caller passed `body: undefined`):
   * safeSubmitPage will submit without a `body` field, leaving page content
   * unchanged.
   */
  finalStorage: string | undefined;

  /**
   * Suggested version message — surfaces deletion metadata and other
   * pipeline observations. Handler forwards this unchanged to
   * safeSubmitPage, which combines it with attribution.
   */
  versionMessage: string;

  /**
   * Preserved tokens removed by this preparation; empty when nothing was
   * removed. Threaded through safeSubmitPage to the final tool response.
   *
   * When `EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS=true`, this list excludes
   * any tokens whose deletion was paired with a byte-equivalent
   * regeneration — those move into {@link regeneratedTokens}. With the flag
   * off (default for 6.3.0), every token-id deletion appears here, exactly
   * as before.
   */
  deletedTokens: DeletedToken[];

  /**
   * Track C1: (deleted, created) token pairs whose post-canonicalisation
   * XML is byte-equivalent. Always present; empty when:
   *   - the feature flag `EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS` is unset
   *     or false (default for 6.3.0), or
   *   - no deleted token had a matching regenerated counterpart.
   *
   * The user-confirmation gate (`assertDeletionAckMatches`) is checked
   * against `deletedTokens` only — entries here never reach the gate.
   * safeSubmitPage records them in the success-path mutation log so a
   * postmortem can reconstruct what was suppressed.
   */
  regeneratedTokens: RegeneratedTokenPair[];
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
   *
   * `undefined` means "title-only update — don't change the body". Valid
   * only when `pageId` is set (updates). Creates with `finalStorage:
   * undefined` error.
   */
  finalStorage: string | undefined;

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
   * Track C1: (deleted, created) token pairs whose post-canonicalisation
   * XML is byte-equivalent. Defaults to an empty list. When non-empty,
   * safeSubmitPage emits a `regeneratedTokens` field on the success-path
   * mutation log entry so a postmortem can reconstruct what was suppressed.
   */
  regeneratedTokens?: RegeneratedTokenPair[];

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

  /**
   * Forensic pass-through from the prepare step. When truthy, the emitted
   * MutationRecord carries `replaceBody: true` so an audit of the mutation
   * log can distinguish a wholesale-rewrite write from a normal one. Does
   * not change behaviour otherwise — the actual `replaceBody` semantics
   * happen inside safePrepareBody.
   */
  replaceBody?: boolean;

  /**
   * Forensic pass-through for the C2 destructive-flag banner. Callers may
   * set these to true when the corresponding flag was supplied by the user
   * on the originating tool call. safeSubmitPage emits a single stderr
   * line naming the flags on any write where at least one is true.
   *
   * These are reported to mirror the agent's intent — we do not attempt
   * to compute whether each flag *actually* suppressed a guard, because
   * that would require replaying the guard decision tree.
   */
  confirmShrinkage?: boolean;
  confirmStructureLoss?: boolean;
  confirmDeletions?: boolean;

  /**
   * Track E2: effective source value for provenance logging. Validated by
   * the handler via validateSource() before this call; safeSubmitPage
   * simply threads the value into the mutation-log record.
   */
  source?:
    | "user_request"
    | "file_or_cli_input"
    | "chained_tool_output"
    | "elicitation_response"
    | "inferred_user_request";

  /**
   * Additive-scope invariant check. When truthy, safeSubmitPage asserts
   * `finalStorage.length >= previousBody.length` — catching handler bugs
   * where an additive op (prepend/append) produced a shrunken body instead
   * of a growing one (e.g. the handler forgot to concatenate currentStorage
   * back into the prepared delta).
   *
   * Only meaningful when `previousBody` is set. For non-additive scopes
   * this flag should not be passed; set it explicitly for handlers that
   * called safePrepareBody with `scope: "additive"`.
   */
  assertGrowth?: boolean;

  /**
   * Phase 2 (2.E defense-in-depth): Confluence cloudId of the tenant this
   * write targets. When present, safeSubmitPage calls
   * `invalidateForPage(cloudId, pageId)` after a successful PUT so that
   * any outstanding soft-confirmation tokens for this page are atomically
   * invalidated — even if the write bypassed `validateToken` (e.g. via
   * `EPIMETHIAN_ALLOW_UNGATED_WRITES`).
   *
   * Sourced from `cfg.sealedCloudId`. Omit (leave undefined) when
   * `sealedCloudId` is not available (env-var-mode or pre-seal profiles).
   */
  cloudId?: string;
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
  /**
   * Track C1: (deleted, created) regenerated token pairs (echoed from the
   * input). Empty in the normal case; populated only when
   * EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS is enabled and the
   * canonicaliser detected at least one equivalence.
   */
  regeneratedTokens: RegeneratedTokenPair[];
  /**
   * One-shot deprecation warnings drained from the write-budget singleton
   * after a successful consume(). Handlers should push these into their
   * WarningAccumulator so the agent sees them in the tool result.
   * Empty array in the normal case (no deprecated env vars in use).
   */
  budgetWarnings: string[];
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
/** Substring of the marker get_page puts into `format: markdown` output. */
const READ_ONLY_MARKDOWN_MARKER_TEXT = "epimethian:read-only-markdown";
/** Thrown when body contains BOTH Confluence storage tags and markdown structural patterns. */
export const MIXED_INPUT_DETECTED = "MIXED_INPUT_DETECTED";
/** Thrown when the caller-supplied body exceeds MAX_INPUT_BODY. */
export const INPUT_BODY_TOO_LARGE = "INPUT_BODY_TOO_LARGE";
/** Thrown when a write body contains the per-session canary or fence markers (Track D3). */
export const WRITE_CONTAINS_UNTRUSTED_FENCE = "WRITE_CONTAINS_UNTRUSTED_FENCE";
/**
 * Thrown by safePrepareMultiSectionBody when one or more sections in an
 * `update_page_sections` (D1) call cannot be applied — heading missing,
 * ambiguous, duplicate name, or a sub-prepare failed. The whole call is
 * rejected; no partial writes.
 */
export const MULTI_SECTION_FAILED = "MULTI_SECTION_FAILED";
/**
 * find_replace error codes live with the engine (converter/find-replace-
 * engine.ts); re-exported here so handlers and tests keep one import site.
 */
export {
  DUPLICATED_TOKEN,
  FIND_REPLACE_AMBIGUOUS,
  FIND_REPLACE_INVALID,
  FIND_REPLACE_MATCH_FAILED,
  FORGED_TOKEN,
  MAX_FIND_REPLACE_PAIRS,
  SECTION_LOCAL_IDS_NOTE,
  type FindReplacePair,
  type FindReplacePairOutcome,
} from "./converter/find-replace-engine.js";
export { PLACEHOLDER_LITERAL_IN_PAGE } from "./converter/types.js";

// ---------------------------------------------------------------------------
// confirm_token helpers (Phase 2 / v6.6.0)
// ---------------------------------------------------------------------------

/**
 * Shared helper that checks a `confirm_token` against the token store.
 * Returns:
 *  - `"ok"`       — token valid and consumed; caller should skip gateOperation.
 *  - `"invalid"`  — token present but failed validation; caller should throw
 *                   CONFIRMATION_TOKEN_INVALID.
 *  - `"no_token"` — no token or required context missing; caller should call
 *                   gateOperation (fail-closed: soft-mode unavailable for this
 *                   call if cloudId/pageVersion/diffHash are absent).
 *
 * The function returns `"no_token"` when ANY of the following is true:
 *   - `confirm_token` is undefined.
 *   - `cloudId` is undefined (env-var-mode or pre-seal profile).
 *   - `pageVersion` is 0 (server returned a stub — token semantics unsound).
 *   - `diffHash` is undefined.
 *
 * DATA-LOSS NOTE: This is the call-site trust boundary. A bug here could
 * let a stale token bypass the gate OR call the gate after a successful
 * validate (defeating single-use semantics). The helper extracts the
 * preamble so it lives in ONE auditable place instead of being duplicated
 * seven times across the gated tool handlers.
 */
export async function maybeConsumeConfirmToken(args: {
  confirm_token?: string;
  tool: string;
  cloudId: string | undefined;
  pageId: string;
  pageVersion: number;
  diffHash: string | undefined;
}): Promise<"ok" | "invalid" | "no_token"> {
  const { confirm_token, tool, cloudId, pageId, pageVersion, diffHash } = args;

  // Bindings required for token semantics: any absent field → no_token.
  if (
    confirm_token === undefined ||
    cloudId === undefined ||
    pageVersion <= 0 ||
    diffHash === undefined
  ) {
    return "no_token";
  }

  const outcome = await validateToken(confirm_token, {
    tool,
    cloudId,
    pageId,
    pageVersion,
    diffHash,
  });
  return outcome; // "ok" | "invalid"
}

/**
 * Try to satisfy a destructive write's gate via a pre-authorised
 * `batch_token` (v6.8.0 / Option C). Returns:
 *
 *   - `{ batchReservationId: <id> }` when the token validates for this
 *     {cloudId, pageId} and an operation slot has been atomically
 *     reserved. The handler MUST either:
 *       a) call `finaliseReservation(<id>)` after the underlying write
 *          succeeds OR after a post-dispatch failure (the slot stays
 *          consumed — we cannot prove the remote did not mutate), OR
 *       b) call `refundReservation(<id>)` ONLY for pre-dispatch
 *          failures (schema validation, conversion errors, anything
 *          thrown before `safeSubmitPage` was invoked).
 *
 *   - `{ batchReservationId: undefined }` when the token is absent,
 *     malformed, or fails any validation check. The caller MUST then
 *     fall through to the existing `maybeConsumeConfirmToken` +
 *     `gateOperation` flow — the agent sees the normal
 *     `SOFT_CONFIRMATION_REQUIRED` response, NOT a different error
 *     class. This is the validation-failure invariant from §3 of
 *     `plans/parallel-subagent-batch-confirmation.md`: granular
 *     reasons (`page_id_not_authorised`, `expired`, `exhausted`,
 *     `cloudid_mismatch`, `unknown`) flow only into the audit hook;
 *     the public surface returns one bit. Otherwise a malicious
 *     orchestrator could probe the token store ("is this token
 *     expired or did I never have it?", "which page IDs are
 *     authorised?").
 *
 * `cloudId` undefined → returns `{ batchReservationId: undefined }`
 * regardless of token presence (env-var-mode / pre-seal profiles
 * cannot use batch tokens, the same fail-closed posture as the
 * confirm-token preamble).
 */
export async function tryBatchTokenForWrite(args: {
  batch_token: string | undefined;
  cloudId: string | undefined;
  pageId: string;
}): Promise<{ batchReservationId: string | undefined }> {
  const { batch_token, cloudId, pageId } = args;
  if (
    batch_token === undefined ||
    cloudId === undefined ||
    !isBatchTokenShape(batch_token)
  ) {
    return { batchReservationId: undefined };
  }
  const result = await validateBatchToken({
    token: batch_token,
    cloudId,
    pageId,
  });
  if (result.valid) {
    return { batchReservationId: result.reservationId };
  }
  return { batchReservationId: undefined };
}

/**
 * Format a `SoftConfirmationRequiredError` as the structured tool result
 * defined by `confirmationRequiredArm` in `output-schema.ts` (v6.6.2 §3.2).
 *
 * The full token lives in `structuredContent.confirm_token` — NOT in the
 * free-text content — so it stays out of the agent's scratchpad. The
 * visible message shows only the last 8 chars of the token for human
 * reference.
 *
 * A `deletion_summary` with numeric counts only (snake_case keys) is
 * included in `structuredContent` when the caller passes one via
 * `params.deletionSummary` — the function converts the camelCase
 * `DeletionSummary` shape to the snake_case wire shape declared in the
 * output schema.
 *
 * `human_summary` is sourced solely from `err.humanSummary`, which the
 * elicitation pipeline derives from numeric deletion counts (or the
 * gate's literal one-line summary). It is NEVER built from tenant
 * content — see §3.5 humanSummary content invariant.
 *
 * Discriminator: `kind: "confirmation_required"`. This is the load-
 * bearing field that lets `writeOutputSchema` / `deleteOutputSchema`
 * route a single response shape to either the success or
 * confirmation-required arm.
 *
 * The text generation and structured payload generation are
 * intentionally decoupled below: the token-in-text branch (default-on
 * since v6.7.2; opt-out via `EPIMETHIAN_HIDE_TOKEN_IN_TEXT=true` or the
 * legacy `EPIMETHIAN_TOKEN_IN_TEXT=false`) splices into the text
 * builder without touching the structuredContent emission.
 */
export function formatSoftConfirmationResult(
  err: {
    token: string;
    auditId: string;
    expiresAt: number;
    humanSummary: string;
    pageId: string;
  },
  params: {
    pageId: string;
    deletionSummary?: {
      tocs: number;
      links: number;
      structuredMacros: number;
      codeMacros: number;
      plainElements: number;
      other: number;
    } | null;
  },
): {
  content: { type: "text"; text: string }[];
  isError: true;
  structuredContent: {
    kind: "confirmation_required";
    confirm_token: string;
    audit_id: string;
    expires_at: string;
    page_id: string;
    human_summary: string;
    deletion_summary?: {
      tocs: number;
      links: number;
      structured_macros: number;
      code_macros: number;
      plain_elements: number;
      other: number;
    };
  };
} {
  const last8 = err.token.slice(-8);
  const isoExpires = new Date(err.expiresAt).toISOString();

  // ── Text generation ────────────────────────────────────────────────
  // Agent-facing prose. Decoupled from the structuredContent builder
  // below so the token-in-text branch can splice in here without
  // touching the data payload.
  const text =
    `⚠️  Confirmation required (SOFT_CONFIRMATION_REQUIRED)\n\n` +
    `${err.humanSummary}\n\n` +
    `Your MCP client does not support in-protocol elicitation. This\n` +
    `confirmation is being routed through you (the agent). Please ASK\n` +
    `THE USER before retrying. If the user approves, re-call this tool\n` +
    `with the same parameters plus the \`confirm_token\` from\n` +
    `structuredContent.\n\n` +
    `Token tail: ...${last8}    Expires: ${isoExpires}    Audit ID: ${err.auditId}\n\n` +
    `The token is single-use, bound to this exact diff and page version,\n` +
    `and invalidated by any competing write to this page. If validation\n` +
    `fails, mint a new one by re-calling without \`confirm_token\`.`;

  // Token-in-text behaviour (v6.7.2+): the full token is appended to the
  // text block by default so clients that drop structuredContent or content
  // blocks when outputSchema is present (Claude Code issues #15412, #9962,
  // #39976) still surface the token to the agent. This matches the
  // configuration `install-agent.md` already instructs Claude Code users
  // to set; making it the default closes the under-configured-install gap.
  //
  // Two opt-out shapes are honoured:
  //   - EPIMETHIAN_HIDE_TOKEN_IN_TEXT=true (preferred) — explicit opt-out.
  //   - EPIMETHIAN_TOKEN_IN_TEXT=false — legacy spelling; back-compat with
  //     setups that pinned the v6.6.x opt-in to its disabled state. Any
  //     other value of EPIMETHIAN_TOKEN_IN_TEXT (including unset, "true",
  //     "1", "yes", typos) leaves the default-on behaviour in place.
  //
  // The structured payload is unchanged — this is strictly additive to
  // the text block.
  const explicitlyHidden =
    process.env.EPIMETHIAN_HIDE_TOKEN_IN_TEXT === "true" ||
    process.env.EPIMETHIAN_TOKEN_IN_TEXT === "false";
  const finalText = explicitlyHidden
    ? text
    : text + `\n\n[FALLBACK] Full token: ${err.token}`;

  // ── Structured content generation ──────────────────────────────────
  // Shape matches `confirmationRequiredArm` in output-schema.ts. Keys
  // are snake_case; deletion_summary's inner keys are also converted
  // from the camelCase `DeletionSummary` (elicitation.ts) to snake_case.
  const structuredContent: {
    kind: "confirmation_required";
    confirm_token: string;
    audit_id: string;
    expires_at: string;
    page_id: string;
    human_summary: string;
    deletion_summary?: {
      tocs: number;
      links: number;
      structured_macros: number;
      code_macros: number;
      plain_elements: number;
      other: number;
    };
  } = {
    kind: "confirmation_required",
    confirm_token: err.token,
    audit_id: err.auditId,
    expires_at: isoExpires,
    page_id: params.pageId,
    human_summary: err.humanSummary,
  };

  if (params.deletionSummary) {
    structuredContent.deletion_summary = {
      tocs: params.deletionSummary.tocs,
      links: params.deletionSummary.links,
      structured_macros: params.deletionSummary.structuredMacros,
      code_macros: params.deletionSummary.codeMacros,
      plain_elements: params.deletionSummary.plainElements,
      other: params.deletionSummary.other,
    };
  }

  return {
    content: [{ type: "text", text: finalText }],
    isError: true,
    structuredContent,
  };
}

/**
 * Caller-supplied body size cap (Track A3). Checked at the entry of
 * safePrepareBody, before any conversion work. Matches the combined-size
 * cap enforced by concatPageContent in index.ts (which guards the final
 * submitted body after concatenation); this one guards the *input*.
 *
 * 2 MB of markdown or storage format is already an unrealistically large
 * page — the Confluence storage body limit is well below this. Rejecting
 * here prevents self-inflicted OOMs during conversion of pathological
 * inputs (e.g. a 100 MB markdown paste) before the HTTP layer would
 * reject them anyway.
 */
export const MAX_INPUT_BODY = 2_000_000;

// ---------------------------------------------------------------------------
// Mixed-input detection
// ---------------------------------------------------------------------------

/**
 * Detect "mixed mode" inputs: a body that contains BOTH Confluence storage
 * tags (`<ac:`/`<ri:`/`<time>`) AND line-anchored markdown structural
 * patterns. The format detector (`looksLikeMarkdown`) classifies any body
 * with `<ac:` outside code fences as storage and skips conversion. If the
 * caller meant the body as markdown with one inlined macro (the common
 * agent failure mode — a TOC macro inlined at the top), the markdown gets
 * stored verbatim and Confluence renders it as literal text.
 *
 * The right shape is YAML frontmatter for TOC (`toc: { maxLevel, minLevel }`)
 * or directive syntax for other macros (`:info[...]`, `:mention[...]{...}`).
 *
 * Returns the human-readable list of matched markdown patterns (empty if not
 * mixed). The list goes into the rejection message so the caller can see
 * exactly what tripped the guard.
 *
 * Excluded from detection:
 * - content inside fenced code blocks (markdown documenting storage)
 * - content inside `<![CDATA[...]]>` (storage code-macro bodies)
 * - content inside `<ac:plain-text-body>...</ac:plain-text-body>` (same)
 * - inline patterns like `**bold**` and `[text](url)` — too easy to occur
 *   incidentally inside HTML attribute values to use as a strong signal.
 */
function detectMixedInput(body: string): string[] {
  // Strip regions where markdown-looking text is legitimately present
  // inside otherwise-storage content.
  let stripped = body.replace(
    /^(`{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm,
    "",
  );
  stripped = stripped.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  stripped = stripped.replace(
    /<ac:plain-text-body>[\s\S]*?<\/ac:plain-text-body>/gi,
    "",
  );

  if (!/<ac:|<ri:|<time[\s/>]/i.test(stripped)) {
    return []; // no storage tags after stripping → not mixed
  }

  const STRUCTURAL_MD: { name: string; re: RegExp }[] = [
    { name: "ATX heading (## ...)", re: /^#{1,6}[ \t]+\S/m },
    { name: "fenced code block (```...)", re: /^```/m },
    { name: "GFM table separator (| --- |)", re: /^\|[\s\-:|]+\|\s*$/m },
    { name: "unordered list (- ... or * ...)", re: /^[-*][ \t]+\S/m },
    { name: "ordered list (1. ...)", re: /^\d+\.[ \t]+\S/m },
    {
      name: "GitHub alert (> [!NOTE])",
      re: /^>\s*\[!(INFO|NOTE|TIP|WARNING|CAUTION|IMPORTANT)\]/im,
    },
    { name: "YAML frontmatter delimiter (---)", re: /^---\s*$/m },
  ];

  return STRUCTURAL_MD.filter(({ re }) => re.test(stripped)).map(
    ({ name }) => name,
  );
}

// ---------------------------------------------------------------------------
// Destructive-flag stderr banner (Track C2)
// ---------------------------------------------------------------------------

/**
 * Emit a single stderr line naming the write operation, page, flags, and
 * client whenever a destructive flag was effectively active on a write.
 * Exported only so tests can exercise the formatter shape without calling
 * into the full pipeline.
 *
 * The shape is deliberately grep-friendly:
 *   epimethian-mcp: [DESTRUCTIVE] tool=<op> page=<id> flags=<list> client=<label>
 *
 * Flag content is metadata only — no body content, no titles. A forensic
 * reviewer can scan for `[DESTRUCTIVE]` in MCP-server logs to find every
 * call that bypassed a safety guard.
 */
export function emitDestructiveBanner(input: {
  operation: string;
  pageId: string | undefined;
  flags: string[];
  clientLabel: string | undefined;
}): void {
  if (input.flags.length === 0) return;
  const parts = [
    `epimethian-mcp: [DESTRUCTIVE]`,
    `tool=${input.operation}`,
    `page=${input.pageId ?? "(create)"}`,
    `flags=${input.flags.join(",")}`,
    `client=${input.clientLabel ?? "unknown"}`,
  ];
  console.error(parts.join(" "));
}

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
    return { tag, fingerprint: `drawio[${safeMacroLabel(name)}]` };
  }

  // Generic structured-macro or emoticon with an ac:name attribute.
  if (acNameFromOpenTag) {
    return { tag, fingerprint: `${bareTag}[${safeMacroLabel(acNameFromOpenTag)}]` };
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

/**
 * Track C1: split a deletion set into "genuine deletions" and
 * "regenerated equivalents".
 *
 * STRATEGY. After planUpdate produces `finalStorage`, re-tokenise the new
 * body and pull aside any tokens whose verbatim XML is *not* present in
 * the original sidecar — those are the freshly-emitted candidates for
 * matching against deletions. Compute a canonical key for every deletion
 * and every candidate; pair them up.
 *
 * STRICT-BY-DEFAULT. The canonicaliser returns a unique opaque sentinel for
 * any input it cannot interpret with confidence (see
 * safe-write-canonicaliser.ts). Two opaque keys never compare equal, so
 * unknown shapes always fall through to "genuine deletion" — the gate
 * fires.
 *
 * INVARIANTS:
 *   - Every input deletion ends up in EXACTLY one of the two output lists.
 *   - Each candidate matches at most one deletion (1:1 pairing). If two
 *     deletions share a canonical key with one candidate, only one is
 *     paired; the other remains a deletion. (This is the safe choice — a
 *     duplicate emission of one macro is legitimately one deletion + one
 *     creation, not two equivalences.)
 *   - The function is pure: it does not modify `sidecarA` or `sidecarB`.
 */
function partitionByEquivalence(
  deletions: DeletedToken[],
  sidecarA: TokenSidecar,
  finalStorage: string,
): {
  deleted: DeletedToken[];
  regenerated: RegeneratedTokenPair[];
} {
  if (deletions.length === 0) {
    return { deleted: [], regenerated: [] };
  }

  // Re-tokenise the new body. Tokens whose verbatim XML is also a value in
  // sidecarA are preserved tokens (already-existing macros that were
  // carried through the update); tokens whose XML is not in sidecarA are
  // freshly emitted by the converter — candidates for equivalence pairing.
  let sidecarB: TokenSidecar;
  try {
    sidecarB = tokeniseStorage(finalStorage).sidecar;
  } catch {
    // If we can't tokenise the new body, treat every deletion as genuine.
    // This matches the strict-by-default safety posture.
    return { deleted: deletions.slice(), regenerated: [] };
  }

  // Build a set of preserved verbatim XMLs from sidecarA so we can filter
  // them out of the candidate list. A token in sidecarB whose XML is also
  // in sidecarA is a preserved (carried-through) token, not a fresh emission.
  const preservedXmls = new Set<string>();
  for (const id of Object.keys(sidecarA)) {
    preservedXmls.add(sidecarA[id]!);
  }

  // Candidate map: canonical key → list of newly-emitted token IDs (with
  // their kind, in document order). A list (not a single value) so we can
  // pair 1:1 in the multi-candidate case.
  const candidates: Map<
    string,
    Array<{ newId: TokenId; kind: MacroKind }>
  > = new Map();
  for (const newId of Object.keys(sidecarB)) {
    const xml = sidecarB[newId]!;
    if (preservedXmls.has(xml)) continue; // preserved, not freshly emitted
    const { key, kind } = canonicaliseToken(xml);
    const list = candidates.get(key);
    if (list) list.push({ newId, kind });
    else candidates.set(key, [{ newId, kind }]);
  }

  const stillDeleted: DeletedToken[] = [];
  const regenerated: RegeneratedTokenPair[] = [];

  for (const d of deletions) {
    const oldXml = sidecarA[d.id];
    if (!oldXml) {
      // No sidecar entry — should not happen, but stay strict.
      stillDeleted.push(d);
      continue;
    }
    const { key } = canonicaliseToken(oldXml);
    const list = candidates.get(key);
    if (list && list.length > 0) {
      // Pop the first available candidate to enforce 1:1 pairing.
      const match = list.shift()!;
      regenerated.push({ oldId: d.id, newId: match.newId, kind: match.kind });
      // Tidy up the map entry so a subsequent iteration sees an empty list.
      if (list.length === 0) {
        candidates.delete(key);
      }
    } else {
      stillDeleted.push(d);
    }
  }

  return { deleted: stillDeleted, regenerated };
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

/**
 * The confirm_deletions gate shared by every token-aware write path (body
 * mode and find_replace). `subject` names what is deleting the tokens in
 * the DELETIONS_NOT_CONFIRMED message ("caller markdown" for body mode, so
 * that message stays byte-identical to planUpdate's). `note` is appended to
 * that message (section writes name the placeholder id scope, R2.2).
 */
function enforceDeletionAck(
  deletedTokens: DeletedToken[],
  confirmDeletions: string[] | true | undefined,
  subject: string,
  note?: string,
): void {
  if (deletedTokens.length > 0) {
    if (confirmDeletions === undefined) {
      // Match the current DELETIONS_NOT_CONFIRMED error shape from
      // planUpdate so migrating handlers don't need to update assertions.
      const summary = deletedTokens
        .map((d) => `${d.id} (${d.fingerprint})`)
        .join(", ");
      const noun = deletedTokens.length === 1 ? "element" : "elements";
      throw new ConverterError(
        `${subject} would delete ${deletedTokens.length} preserved ${noun}: ${summary}. ` +
          `Re-submit with confirm_deletions: true to acknowledge the removal.` +
          (note ? ` ${note}` : ""),
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
 *
 * For `scope: "section"` the placeholder-id errors (DELETIONS_NOT_CONFIRMED,
 * INVENTED_TOKEN, FORGED_TOKEN) also say that ids are section-local (R2.2):
 * an id copied from a full-page read names a different macro there.
 */
export async function safePrepareBody(
  input: SafePrepareBodyInput,
): Promise<SafePrepareBodyOutput> {
  try {
    return await prepareBody(input);
  } catch (err) {
    if (
      input.scope === "section" &&
      err instanceof ConverterError &&
      SECTION_ID_ERROR_CODES.has(err.code)
    ) {
      throw new ConverterError(`${err.message} ${SECTION_LOCAL_IDS_NOTE}`, err.code);
    }
    throw err;
  }
}

/** Errors whose meaning depends on which placeholder ids the caller used. */
const SECTION_ID_ERROR_CODES: ReadonlySet<string> = new Set([
  "DELETIONS_NOT_CONFIRMED",
  "INVENTED_TOKEN",
  "FORGED_TOKEN",
]);

async function prepareBody(
  input: SafePrepareBodyInput,
): Promise<SafePrepareBodyOutput> {
  const {
    body,
    currentBody,
    scope = "full",
    confirmDeletions,
    confirmShrinkage,
    confirmStructureLoss,
    fullPageBody,
    replaceBody,
    allowRawHtml,
    confluenceBaseUrl,
  } = input;

  // 0. Title-only path: caller omitted body entirely. Valid only for updates
  //    (currentBody defined) — creates can't submit a page with no body.
  //    Short-circuit the whole pipeline; safeSubmitPage will submit without a
  //    `body` field, leaving page content untouched. All guards are no-ops
  //    for this branch (nothing transformed → nothing to guard against).
  if (body === undefined) {
    if (currentBody === undefined) {
      throw new ConverterError(
        "safePrepareBody: body is required when creating a page. " +
          "Title-only updates are valid only for existing pages.",
        "MISSING_BODY_FOR_CREATE",
      );
    }
    return {
      finalStorage: undefined,
      versionMessage: "",
      deletedTokens: [],
      regeneratedTokens: [],
    };
  }

  // 0a. Input body-size cap (Track A3). Reject pathologically-large inputs
  //     before conversion so we don't waste CPU / memory converting content
  //     Confluence will reject anyway. The cap is deliberately generous
  //     (2 MB) — normal pages are well under 100 KB.
  if (body.length > MAX_INPUT_BODY) {
    throw new ConverterError(
      `Input body exceeds ${MAX_INPUT_BODY.toLocaleString()} characters ` +
        `(received ${body.length.toLocaleString()}). Refusing to convert. ` +
        `Split the content across multiple pages or use prepend_to_page / ` +
        `append_to_page to build up a large page incrementally.`,
      INPUT_BODY_TOO_LARGE,
    );
  }

  // 0b. Write-path fence / canary detector (Track D3). Catches callers who
  //     pasted a read-tool response verbatim into a write — the response
  //     is fenced tenant content, so the paste includes `<<<CONFLUENCE_…`
  //     markers and the per-session canary. Round-tripping fenced content
  //     would propagate any injection payload that rode along with the
  //     original read.
  const echoMarker = detectUntrustedFenceInWrite(body);
  if (echoMarker !== undefined) {
    throw new ConverterError(
      `Write body contains "${echoMarker}" — this indicates the body was ` +
        `copied from a read-tool response (which wraps tenant content in ` +
        `fences and carries a per-session canary). Round-tripping fenced ` +
        `content would propagate any injection payload attached to the ` +
        `original read. Remove the fence markers and canary comments from ` +
        `your body, or compose new content from scratch.`,
      WRITE_CONTAINS_UNTRUSTED_FENCE,
    );
  }

  // 1. Read-only-markdown rejection — hard guard, no opt-out. Mirrors the
  //    identical check in create_page / update_page / update_page_section
  //    handlers; consolidating it here lets those handlers drop their copies.
  if (body.includes(READ_ONLY_MARKDOWN_MARKER_TEXT)) {
    throw new ConverterError(
      "The body contains content produced by get_page with format: 'markdown', which is a " +
        "read-only rendering not suitable for round-trip updates (tables, macros, and rich " +
        "elements may be lost). To update this page, either: (1) read with format: 'storage' " +
        "and edit the storage XML, (2) use update_page_section for targeted edits, or " +
        "(3) compose new markdown from scratch (do not copy from format: 'markdown' output).",
      READ_ONLY_MARKDOWN_ROUND_TRIP,
    );
  }

  // 1b. Mixed-input rejection — hard guard, no opt-out. Catches the common
  //     agent failure of inlining `<ac:structured-macro>` (typically a TOC
  //     macro) at the top of an otherwise-markdown body. The format detector
  //     would classify the body as storage and the markdown would be stored
  //     verbatim, rendering as literal `##` and `**` text in Confluence.
  const mixedSignals = detectMixedInput(body);
  if (mixedSignals.length > 0) {
    throw new ConverterError(
      `Body contains BOTH Confluence storage tags (<ac:.../>, <ri:.../>) AND markdown structural patterns: ${mixedSignals.join(", ")}.\n\n` +
        `The format detector classifies any body containing storage tags as storage format and skips markdown→storage conversion. Submitting this would store the markdown verbatim and Confluence would render it as literal text.\n\n` +
        `Pick one path:\n` +
        `  • TOC macro from markdown — drop the inline <ac:structured-macro ac:name="toc"/> and add YAML frontmatter at the top of the body:\n` +
        `        ---\n` +
        `        toc:\n` +
        `          maxLevel: 3\n` +
        `          minLevel: 1\n` +
        `        ---\n` +
        `  • Other macros from markdown — use directive syntax (e.g. ":info[content]", ":mention[Name]{accountId=...}", ":date[2026-04-23]").\n` +
        `  • Pure storage format — convert the markdown structure (## headings, lists, tables, code fences) to <h1>/<h2>/<p>/<ul>/<table>/etc. before submitting.`,
      MIXED_INPUT_DETECTED,
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
  let regeneratedTokens: RegeneratedTokenPair[] = [];

  if (scope === "additive") {
    // Token diff doesn't make sense for additive ops (the current body
    // round-trips unchanged). Content guards still run post-concat inside
    // safeSubmitPage. If markdown, convert the caller's addition only.
    //
    // Placeholders mean nothing here (there is no sidecar to restore from),
    // and an appended `[[epi:` literal would make every later token-aware
    // edit of that content ambiguous (PLACEHOLDER_LITERAL_IN_PAGE).
    if (body.includes(TOKEN_LITERAL_PREFIX)) {
      throw new ConverterError(
        "The content contains `[[epi:` placeholder text. Placeholders from a " +
          "markdown read cannot be appended or prepended: there is no macro " +
          "to restore them from. Remove them, or write the macro in storage " +
          "format.",
        "INVENTED_TOKEN",
      );
    }
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
      //
      // Track C1: when the byte-equivalent suppression flag is ON, we ALSO
      // need planUpdate to defer its gate — the partition step below may
      // turn some "deletions" into byte-equivalent regenerations, in which
      // case planUpdate's gate would have fired prematurely on a deletion
      // set that no longer reflects what the caller is actually losing.
      // Default behaviour (flag off) is unchanged: planUpdate's gate
      // fires exactly as before whenever confirmDeletions is unset.
      const c1Enabled = suppressEquivalentDeletionsEnabled();
      const plan = planUpdate({
        currentStorage: currentBody,
        callerMarkdown: body,
        confirmDeletions:
          confirmDeletions !== undefined || c1Enabled, // any ack form OR flag → plan doesn't re-raise
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

      // Track C1: byte-equivalent macro suppression. Strict-by-default,
      // gated behind the EPIMETHIAN_SUPPRESS_EQUIVALENT_DELETIONS env var
      // for one release (6.3.0). When the flag is OFF (default), behaviour
      // is identical to before — every token-id deletion appears in
      // `deletedTokens` and the gate fires. When ON, deletions whose
      // canonical key matches a freshly-emitted token in finalStorage are
      // moved into `regeneratedTokens` instead, where they bypass the gate
      // but are recorded in the audit log by safeSubmitPage.
      //
      // DATA-LOSS RISK: a buggy equivalence test would let genuinely lost
      // content slip past the gate. Mitigations: (1) strict canonicaliser
      // (unknown shapes produce unique opaque keys that never compare
      // equal); (2) feature flag OFF by default for 6.3.0; (3) every
      // suppressed pair is logged in the success-path MutationRecord.
      if (
        suppressEquivalentDeletionsEnabled() &&
        deletedTokens.length > 0
      ) {
        const partitioned = partitionByEquivalence(
          deletedTokens,
          sidecar,
          finalStorage,
        );
        deletedTokens = partitioned.deleted;
        regeneratedTokens = partitioned.regenerated;
      }
    } else {
      // No preservation needed — plain markdown conversion.
      //
      // planUpdate would have caught an INVENTED_TOKEN forgery (caller
      // markdown references `[[epi:T####]]` IDs that don't exist in the
      // sidecar), but this branch bypasses planUpdate so we run the same
      // check by regex. Matches planUpdate's error shape byte-for-byte so
      // the behaviour is identical regardless of whether the current page
      // had preserved tokens. replaceBody skips the check (wholesale rewrite
      // discards token semantics by design — same as planUpdate's replaceBody
      // path).
      if (replaceBody !== true) {
        const epiMatches = body.match(/\[\[epi:(T\d+)\]\]/g);
        if (epiMatches && epiMatches.length > 0) {
          const ids = Array.from(
            new Set(epiMatches.map((m) => m.slice(6, -2))),
          );
          throw new ConverterError(
            `caller markdown contains unknown token IDs: ${ids.join(", ")}`,
            "INVENTED_TOKEN",
          );
        }
      }
      finalStorage = markdownToStorage(body, converterOptions);
    }
  } else {
    // Already storage format — pass through unchanged.
    finalStorage = body;
  }

  // Deletion acknowledgement check. `replaceBody` bypasses the token-diff
  // path entirely (planUpdate returns deletedTokens: []), so this block
  // only fires when a genuine diff reported deletions.
  enforceDeletionAck(deletedTokens, confirmDeletions, "caller markdown");

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
    // For scope "section", measure the guards against the projected FULL
    // page when the caller supplied it (and the current section body is
    // present verbatim inside it). Removing one macro from a short section
    // is a ~6% page change, not the >50% section-fragment "loss" the guards
    // would otherwise see — measuring page-relative avoids that false
    // positive while still catching catastrophic page-level reduction. The
    // string replace uses a function replacement so `$`-sequences in the new
    // body are not interpreted as backreferences. Falls back to fragment-
    // relative when the section body is not found (defensive).
    let guardOld = currentBody;
    let guardNew = finalStorage;
    if (
      scope === "section" &&
      fullPageBody !== undefined &&
      fullPageBody.includes(currentBody)
    ) {
      guardOld = fullPageBody;
      guardNew = fullPageBody.replace(currentBody, () => finalStorage);
    }
    enforceContentSafetyGuards({
      oldStorage: guardOld,
      newStorage: guardNew,
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

  return { finalStorage, versionMessage, deletedTokens, regeneratedTokens };
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
    regeneratedTokens = [],
    clientLabel,
    operation,
    replaceBody,
    confirmShrinkage,
    confirmStructureLoss,
    confirmDeletions,
    source,
    assertGrowth,
    cloudId,
  } = input;

  const isCreate = pageId === undefined;
  const resolvedOperation: MutationRecord["operation"] =
    operation ?? (isCreate ? "create_page" : "update_page");

  // C2/C3: single computation of the effective destructive-flag list,
  // reused for both the Confluence version-message suffix (C3) and the
  // post-success stderr banner (C2). `confirm_deletions` only counts as
  // "effective" when deletions actually occurred — the flag being set on a
  // no-op call is not destructive.
  const destructiveFlags: string[] = [];
  if (replaceBody === true) destructiveFlags.push("replace_body");
  if (confirmShrinkage === true) destructiveFlags.push("confirm_shrinkage");
  if (confirmStructureLoss === true) destructiveFlags.push("confirm_structure_loss");
  if (confirmDeletions === true && deletedTokens.length > 0) {
    destructiveFlags.push("confirm_deletions");
  }

  // Title-only update: finalStorage is undefined. Valid ONLY for updates;
  // a create with no body is rejected up front so the caller gets a clear
  // error rather than an opaque Confluence 400.
  const isTitleOnly = finalStorage === undefined;
  if (isTitleOnly && isCreate) {
    throw new Error(
      "safeSubmitPage: finalStorage is required when creating a page. " +
        "Title-only submissions are valid only for updates.",
    );
  }

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

  const oldLen = previousBody?.length ?? 0;

  // 2a. Additive-scope invariant — for prepend/append, finalStorage must be
  // at least as large as previousBody. Catches the handler-bug case where a
  // "scope: additive" prepare returned a small delta and the handler failed
  // to concatenate it back onto currentStorage before calling submit.
  // Runs before the post-transform guard so callers get the more specific
  // error message (the post-transform guard would also fire for catastrophic
  // cases, but "you forgot to concat" is more actionable than "body shrank").
  if (assertGrowth && !isTitleOnly && previousBody !== undefined) {
    if (finalStorage!.length < previousBody.length) {
      throw new Error(
        `Additive-scope invariant violated: finalStorage (${finalStorage!.length} chars) ` +
          `is smaller than previousBody (${previousBody.length} chars). ` +
          `An additive op (prepend/append) must produce a body at least as large as ` +
          `the original — the handler likely forgot to concatenate currentStorage back ` +
          `onto the prepared delta before calling safeSubmitPage.`,
      );
    }
  }

  // 2b. Post-submit safety guard — re-runs the post-transform body guard on
  // finalStorage independent of prepare's decision. Catches section-splicing
  // damage in handlers that splice prepared output into a larger body
  // between calling safePrepareBody and safeSubmitPage. Skipped for
  // title-only updates (no body to guard).
  if (!isTitleOnly) {
    assertPostTransformBody(
      oldLen > 0 ? oldLen : finalStorage!.length,
      finalStorage!,
    );
  }

  // 2c. Byte-identical update short-circuit (Track A1).
  //
  // For updates where previousBody is provided, compare the normalised
  // finalStorage (post strip-attribution, post toStorageFormat) against
  // the normalised previousBody. If byte-identical, skip the HTTP call
  // entirely — nothing would change on Confluence's side and a write
  // would only bump the version number.
  //
  // The normalisation MUST use `normalizeBodyForSubmit` (the same helper
  // `_rawUpdatePage` uses immediately before the PUT). If the two
  // normalisations diverged we'd either miss legitimate no-ops or
  // spuriously short-circuit real changes.
  //
  // Skipped for creates (no previousBody), title-only updates (no body
  // to compare), and operations that explicitly want a version bump
  // (none today, but future tools could opt out).
  if (
    !isCreate &&
    !isTitleOnly &&
    previousBody !== undefined &&
    finalStorage !== undefined
  ) {
    const normalizedFinal = normalizeBodyForSubmit(finalStorage);
    const normalizedPrev = normalizeBodyForSubmit(previousBody);
    if (normalizedFinal === normalizedPrev) {
      // Synthesise a PageData response from what we already know. We
      // intentionally do NOT re-fetch via getPage — the short-circuit is
      // supposed to save a network round-trip, not trade one. Callers
      // rely only on `page.id`, `page.title`, and `newVersion` in the
      // response formatting.
      const synthesized: PageData = {
        id: pageId!,
        title,
        version: { number: version! },
      };
      return {
        page: synthesized,
        newVersion: version!,
        oldLen: previousBody.length,
        newLen: finalStorage.length,
        deletedTokens,
        regeneratedTokens,
        budgetWarnings: [],
      };
    }
  }

  // 2d. Track F4: consume one write-budget slot BEFORE the HTTP call so
  //     a budget breach does not count as a "failed write" in the log.
  //     Throws WriteBudgetExceededError when over the cap.
  writeBudget.consume();
  // Drain any one-shot deprecation warnings (e.g. HOURLY→ROLLING rename).
  // These are returned in SafeSubmitPageOutput.budgetWarnings so handlers
  // can push them into their WarningAccumulator for the tool result.
  const budgetWarnings = writeBudget.drainPendingWarnings();

  // 3. API call — wrapped in try/catch so both success and failure are
  //    mutation-logged.
  try {
    let page: PageData;
    let newVersion: number;
    if (isCreate) {
      // finalStorage is guaranteed defined here (isTitleOnly && isCreate
      // would have thrown above).
      page = await _rawCreatePage(
        spaceId!,
        title,
        finalStorage!,
        parentId,
        clientLabel,
      );
      newVersion = page.version?.number ?? 1;
    } else {
      if (version === undefined) {
        throw new Error("safeSubmitPage: version is required for update");
      }
      // Title-only updates: omit the `body` field; the HTTP wrapper (see
      // confluence-client.ts _rawUpdatePage) already supports
      // `body: undefined` by leaving the field out of the payload so the
      // Confluence API treats it as a title-only edit.
      const res = await _rawUpdatePage(pageId!, {
        title,
        body: finalStorage,
        version,
        versionMessage,
        previousBody,
        clientLabel,
        destructiveFlags,
      });
      page = res.page;
      newVersion = res.newVersion;
    }

    // 4. Mutation log (success). Shape matches the current handler
    //    emissions: { timestamp, operation, pageId, oldVersion, newVersion,
    //    oldBodyLen, newBodyLen, oldBodyHash, newBodyHash, clientLabel }.
    //
    // For title-only updates, `newBodyLen` and `newBodyHash` are omitted —
    // mirrors `oldBodyLen` being carried through on creates and the
    // corresponding `newBody*` fields being omitted. A forensic audit can
    // then distinguish "title-only edit" from "full rewrite" by the
    // presence of the body-metadata fields.
    const record: MutationRecord = {
      timestamp: new Date().toISOString(),
      operation: resolvedOperation,
      pageId: page.id,
      newVersion,
      clientLabel,
    };
    if (!isTitleOnly) {
      record.newBodyLen = finalStorage!.length;
      record.newBodyHash = bodyHash(finalStorage!);
    }
    if (!isCreate) {
      record.oldVersion = version;
      record.oldBodyLen = previousBody?.length ?? 0;
      if (previousBody !== undefined) {
        record.oldBodyHash = bodyHash(previousBody);
      }
    }
    // Forensic flag: thread replaceBody through so a log audit can tell a
    // wholesale-rewrite write apart from a normal one. Only emitted when
    // the caller actually set it — absent (not `false`) otherwise, to
    // avoid noise in the log.
    if (replaceBody === true) {
      record.replaceBody = true;
    }
    // E2: source provenance. Only emitted when the caller threaded one
    // through (handler validateSource() result). Absent otherwise so the
    // log stays tidy on non-destructive writes.
    if (source !== undefined) {
      record.source = source;
    }
    // D2: preceding injection signals. Correlates "agent read a suspect
    // page in the last 60s" with "agent then attempted this write".
    // Forensic-only — advisory, does not block the write.
    const preceding = recentSignalsTracker.recent();
    if (preceding.length > 0) {
      record.precedingSignals = preceding;
    }
    // C1: byte-equivalent deletion suppressions. Recorded only when the
    // canonicaliser actually paired one or more (deleted, created) tokens.
    // No content leaks: each entry carries the pre-existing token ID, the
    // freshly-emitted token ID, and the macro kind classification. A
    // postmortem can replay the IDs against the historical sidecar to
    // verify the suppression was correct.
    if (regeneratedTokens.length > 0) {
      record.regeneratedTokens = regeneratedTokens.map((p) => ({
        oldId: p.oldId,
        newId: p.newId,
        kind: p.kind,
      }));
    }
    logMutation(record);

    // C2: stderr banner for destructive flag usage. Runs after the success
    // log so the forensic record is persisted first; emission itself is
    // best-effort (a failing stderr write should never bubble up).
    try {
      emitDestructiveBanner({
        operation: resolvedOperation,
        pageId: page.id,
        flags: destructiveFlags,
        clientLabel,
      });
    } catch {
      // stderr write failed — never propagate.
    }

    // 2.E defense-in-depth: invalidate all soft-confirmation tokens for this
    // page after any successful write — even writes that bypassed validateToken
    // (e.g. EPIMETHIAN_ALLOW_UNGATED_WRITES or creates). This is the secondary
    // TOCTOU guard; the primary lives inside validateToken itself (which
    // atomically invalidates siblings on "ok"). This hook covers residual
    // paths. Skipped when cloudId is undefined (pre-seal or env-var profiles).
    if (cloudId !== undefined && pageId !== undefined) {
      invalidateForPage(cloudId, pageId);
    }

    return {
      page,
      newVersion,
      oldLen,
      newLen: isTitleOnly ? 0 : finalStorage!.length,
      deletedTokens,
      regeneratedTokens,
      budgetWarnings,
    };
  } catch (err) {
    // 5. Mutation log (failure). Reuse the current errorRecord shape; the
    //    operation name is the same one that would have been used on
    //    success, so downstream forensics see a consistent name per tool.
    const errPageId = isCreate ? "unknown" : pageId!;
    logMutation(
      errorRecord(resolvedOperation, errPageId, err, {
        oldVersion: version,
        ...(replaceBody === true ? { replaceBody: true } : {}),
      }),
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// find_replace (S1: update_page_section / update_page_sections)
// ---------------------------------------------------------------------------

/**
 * Thrown when `version: "current"` is combined with a placeholder in any
 * find or replace string, or in a body-mode body. Placeholder ids are
 * positional (T0001 is the first macro of the section, or of the page for
 * update_page, at read time); a write that skips the version check could
 * apply them to a page whose macros have shifted since.
 */
export const PLACEHOLDER_NEEDS_PINNED_VERSION = "PLACEHOLDER_NEEDS_PINNED_VERSION";

function placeholderNeedsPinnedVersion(what: string): ConverterError {
  return new ConverterError(
    `${PLACEHOLDER_NEEDS_PINNED_VERSION}: ` +
      `${what} with \`[[epi:\` placeholders requires a numeric version, not "current": ` +
      "placeholder ids are positional and can point at a different macro " +
      "if the page changed since your read. Pass the version from that read.",
    PLACEHOLDER_NEEDS_PINNED_VERSION,
  );
}

/** Reject `version: "current"` when any pair references a placeholder. */
export function assertFindReplaceVersionPinned(
  pairs: readonly FindReplacePair[],
  version: number | "current",
): void {
  if (version !== "current") return;
  const usesPlaceholder = pairs.some(
    (p) =>
      p.find.includes(TOKEN_LITERAL_PREFIX) ||
      p.replace.includes(TOKEN_LITERAL_PREFIX),
  );
  if (usesPlaceholder) throw placeholderNeedsPinnedVersion("find_replace");
}

/**
 * Body-mode counterpart (update_page, update_page_section, body entries of
 * update_page_sections): planUpdate resolves `[[epi:` placeholders in the
 * body against the macros of the page as fetched at write time, so
 * `version: "current"` would bind them to whatever macro now holds that
 * position. Checked before the page is fetched.
 */
export function assertBodyVersionPinned(
  body: string | undefined,
  version: number | "current",
): void {
  if (version !== "current" || body === undefined) return;
  if (body.includes(TOKEN_LITERAL_PREFIX)) throw placeholderNeedsPinnedVersion("a body");
}

export interface SafePrepareFindReplaceInput {
  /** Current section body (heading excluded — contract 1's placeholder base). */
  sectionBody: string;
  pairs: readonly FindReplacePair[];
  /** Same semantics as SafePrepareBodyInput.confirmDeletions. */
  confirmDeletions?: string[] | true;
}

export interface SafePrepareFindReplaceOutput {
  /** The section body with every pair applied (storage format). */
  newSectionBody: string;
  /** Macros whose placeholder the pairs removed; already acknowledged. */
  deletedTokens: DeletedToken[];
  /** Per-pair match kind and count, in input order. */
  perPair: FindReplacePairOutcome[];
  /** Deletion note for the version message ("" when nothing was removed). */
  versionMessage: string;
}

/**
 * Prepare a find_replace section edit. Pure; no API calls.
 *
 * Deliberately NOT routed through safePrepareBody: the replace strings are
 * storage fragments, and safePrepareBody would markdown-convert a bare text
 * fragment. Instead the same guards run here explicitly:
 *   1. size cap on every find/replace string (MAX_INPUT_BODY);
 *   2. fence/canary echo and read-only-markdown checks on each replace and
 *      on their concatenation (a canary split across two pairs is caught);
 *   3. the engine (exactly-once matching, placeholder invariants, single-
 *      pass restore — see converter/find-replace-engine.ts);
 *   4. lost placeholders → DeletedToken[] → the confirm_deletions gate,
 *      exactly as body mode.
 * Page-level checks (marker non-growth, content-safety guards) need the
 * spliced full page and run in enforceFindReplacePageGuards.
 */
export function safePrepareFindReplace(
  input: SafePrepareFindReplaceInput,
): SafePrepareFindReplaceOutput {
  const { sectionBody, pairs, confirmDeletions } = input;

  for (const p of pairs) {
    if (p.find.length > MAX_INPUT_BODY || p.replace.length > MAX_INPUT_BODY) {
      throw new ConverterError(
        `find_replace strings are limited to ${MAX_INPUT_BODY.toLocaleString()} characters each.`,
        INPUT_BODY_TOO_LARGE,
      );
    }
  }

  const replaces = [...pairs.map((p) => p.replace), pairs.map((p) => p.replace).join("")];
  for (const r of replaces) {
    const echoMarker = detectUntrustedFenceInWrite(r);
    if (echoMarker !== undefined) {
      throw new ConverterError(
        `find_replace replacement contains "${echoMarker}" — this indicates it ` +
          `was copied from a read-tool response (fenced tenant content with a ` +
          `per-session canary). Remove the fence markers and canary comments, ` +
          `or compose the replacement from scratch.`,
        WRITE_CONTAINS_UNTRUSTED_FENCE,
      );
    }
    if (r.includes(READ_ONLY_MARKDOWN_MARKER_TEXT)) {
      throw new ConverterError(
        "find_replace replacement contains content produced by get_page with " +
          "format: 'markdown', which is a read-only rendering. Compose the " +
          "replacement in storage format instead.",
        READ_ONLY_MARKDOWN_ROUND_TRIP,
      );
    }
  }

  const outcome = applyFindReplace(sectionBody, pairs, { maxLength: MAX_INPUT_BODY });
  const deletedTokens = buildDeletedTokens(outcome.lostTokens, outcome.sidecar);
  // find_replace exists only on the section tools, so ids are section-local.
  enforceDeletionAck(deletedTokens, confirmDeletions, "find_replace", SECTION_LOCAL_IDS_NOTE);

  const versionMessage =
    deletedTokens.length > 0
      ? `Removed ${deletedTokens.length} preserved element${deletedTokens.length === 1 ? "" : "s"}: ` +
        deletedTokens.map((d) => `${d.id} (${d.fingerprint})`).join(", ")
      : "";

  return {
    newSectionBody: outcome.body,
    deletedTokens,
    perPair: outcome.perPair,
    versionMessage,
  };
}

/** A find_replace would add an XML comment or CDATA delimiter (R1.1). */
export const FIND_REPLACE_OPAQUE_MARKUP = "FIND_REPLACE_OPAQUE_MARKUP";

/**
 * Comment delimiters, whose raw count a find_replace may not increase (R1.1).
 * CDATA delimiters are counted by countBareCdataDelimiters instead, which
 * skips the CDATA of code and link bodies: inserting a link
 * (`<ac:plain-text-link-body><![CDATA[…]]>`) is a core find_replace use.
 */
const COMMENT_DELIMITERS = ["<!--", "-->"] as const;

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Occurrences of a fence marker that a reader would treat as live: not
 * preceded by an extra "<". escapeFenceContent neutralises a marker by
 * prefixing one "<", so `<<<<CONFLUENCE_UNTRUSTED` is inert even though it
 * contains the marker as a substring. Markers start with "<<<", so the
 * leftmost hit inside a run of "<" is preceded by "<" exactly when the run
 * is longer than the marker's own.
 */
function countLiveFenceMarkers(haystack: string, marker: string): number {
  let n = 0;
  for (let i = haystack.indexOf(marker); i !== -1; i = haystack.indexOf(marker, i + marker.length)) {
    if (i === 0 || haystack[i - 1] !== "<") n++;
  }
  return n;
}

/**
 * Page-level guards for a find_replace write, run on the spliced full page.
 *
 *   - The number of fence markers, canaries and read-only-markdown markers
 *     must not grow. Pages that merely contain such text stay editable; a
 *     replacement that completes a marker with neighbouring text does not.
 *     Fence markers are counted twice: as substrings, and as live markers
 *     (so turning an inert escaped `<<<<…` into a live `<<<…` is caught
 *     even though the substring count stays equal).
 *   - XML comment delimiters, and CDATA delimiters outside a code or link
 *     body, must not grow either (R1.1): with them a replacement could hide a
 *     macro, a heading or text from Confluence while every placeholder
 *     survives, so the deletion gate never runs. (The engine also treats a
 *     placeholder that ends up inside such a region as lost.) Pages that
 *     already contain comments or code macros stay editable, and inserting a
 *     link or a code macro still works. Off for the update_page_sections
 *     aggregate check (`opaqueMarkers: false`): body entries legitimately add
 *     code macros, and each find_replace entry was already checked on its own.
 *   - enforceContentSafetyGuards, page-relative, with the same flags and
 *     meaning as body mode (confirmDeletions bypasses macro/table loss only).
 */
export function enforceFindReplacePageGuards(input: {
  oldStorage: string;
  newStorage: string;
  confirmShrinkage?: boolean;
  confirmStructureLoss?: boolean;
  confirmDeletions?: boolean;
  /** Check comment/CDATA delimiter non-growth (default true). */
  opaqueMarkers?: boolean;
}): void {
  const { oldStorage, newStorage } = input;
  const grows = (count: (s: string, m: string) => number, marker: string) =>
    count(newStorage, marker) > count(oldStorage, marker);
  if (input.opaqueMarkers !== false) {
    const delimiters: [string, number, number][] = [
      ...COMMENT_DELIMITERS.map((m): [string, number, number] => [
        m,
        countOccurrences(oldStorage, m),
        countOccurrences(newStorage, m),
      ]),
      [
        "<![CDATA[ / ]]> outside a code or link body",
        countBareCdataDelimiters(oldStorage),
        countBareCdataDelimiters(newStorage),
      ],
    ];
    for (const [marker, before, after] of delimiters) {
      if (after > before) {
        throw new ConverterError(
          `${FIND_REPLACE_OPAQUE_MARKUP}: find_replace would add "${marker}" to ` +
            `the page (${before} → ${after}). find_replace cannot add XML ` +
            `comment delimiters or CDATA outside a code or link body: they can ` +
            `hide macros and text. Write text such as an arrow escaped ` +
            `("--&gt;"), or make this edit with a storage-format \`body\` instead.`,
          FIND_REPLACE_OPAQUE_MARKUP,
        );
      }
    }
  }
  for (const marker of [
    OPEN_FENCE_PREFIX,
    CLOSE_FENCE,
    getSessionCanary(),
    READ_ONLY_MARKDOWN_MARKER_TEXT,
  ]) {
    const isFence = marker === OPEN_FENCE_PREFIX || marker === CLOSE_FENCE;
    if (grows(countOccurrences, marker) || (isFence && grows(countLiveFenceMarkers, marker))) {
      throw new ConverterError(
        `find_replace would add "${marker}" to the page. Read-tool fence ` +
          `markers, the session canary and the read-only-markdown marker ` +
          `must never be written back to Confluence.`,
        WRITE_CONTAINS_UNTRUSTED_FENCE,
      );
    }
  }
  enforceContentSafetyGuards({
    oldStorage,
    newStorage,
    confirmShrinkage: input.confirmShrinkage,
    confirmStructureLoss: input.confirmStructureLoss,
    confirmDeletions: input.confirmDeletions,
  });
}

// ---------------------------------------------------------------------------
// Confirmation binding for section writes (H1)
// ---------------------------------------------------------------------------

/** One section of a section write, as it enters the confirmation hash. */
export interface SectionWriteHashEntry {
  section: string;
  body?: string;
  find_replace?: readonly FindReplacePair[];
}

/**
 * Markdown conversion mints a random `ac:macro-id` for every new code and
 * expand macro, so two preparations of the same call differ only there.
 * Blank the values before hashing so a confirmation token minted on the
 * first call still matches the identical retry. Everything else in the
 * resulting storage stays bound.
 */
function storageForHash(storage: string): string {
  return storage.replace(/\bac:macro-id="[^"]*"/g, 'ac:macro-id=""');
}

/**
 * Diff hash for every section write (update_page_section in body and
 * find_replace mode, update_page_sections). Covers canonical JSON of the
 * tool, page id, page version, every entry (section name plus its body or
 * its pairs with their replace_all flags), the destructive flags, and the
 * SHA-256 of the resulting full storage. A token minted for one call is
 * therefore rejected for a call that differs in any of these.
 *
 * The JSON is canonical by construction: every object is built here with a
 * fixed key order and arrays keep input order.
 */
export function computeSectionWriteDiffHash(input: {
  tool: string;
  pageId: string;
  pageVersion: number;
  entries: readonly SectionWriteHashEntry[];
  flags: {
    confirmDeletions: boolean;
    confirmShrinkage: boolean;
    confirmStructureLoss: boolean;
  };
  resultingStorage: string;
}): string {
  const payload = JSON.stringify({
    tool: input.tool,
    page_id: input.pageId,
    page_version: input.pageVersion,
    entries: input.entries.map((e) =>
      e.find_replace !== undefined
        ? {
            section: e.section,
            find_replace: e.find_replace.map((p) => ({
              find: p.find,
              replace: p.replace,
              replace_all: p.replace_all === true,
            })),
          }
        : { section: e.section, body: e.body ?? "" },
    ),
    flags: {
      confirm_deletions: input.flags.confirmDeletions,
      confirm_shrinkage: input.flags.confirmShrinkage,
      confirm_structure_loss: input.flags.confirmStructureLoss,
    },
    result_sha256: createHash("sha256")
      .update(storageForHash(input.resultingStorage))
      .digest("hex"),
  });
  return computeDiffHash(payload, input.pageVersion);
}

// ---------------------------------------------------------------------------
// safePrepareMultiSectionBody (D1: update_page_sections)
// ---------------------------------------------------------------------------

/**
 * One section to apply in a multi-section update.
 */
export interface MultiSectionInput {
  /** Heading text identifying the section. */
  section: string;
  /** New body content (markdown or storage). Exactly one of body / find_replace. */
  body?: string;
  /** Literal substitutions in the section's storage (R3). */
  find_replace?: readonly FindReplacePair[];
}

/**
 * Qualify a per-section token id with its section name. Ids restart at
 * T0001 in every section (each is tokenised on its own), so the aggregate
 * list and itemised acks use `<section>#<id>`.
 */
export function qualifyTokenId(section: string, id: string): string {
  return `${section}#${id}`;
}

/**
 * Inverse of qualifyTokenId, parsed from the right: heading text may itself
 * contain "#" ("A#B"), token ids never do. Returns undefined when the part
 * after the last "#" is not a token id (T followed by digits).
 */
function parseQualifiedTokenId(
  ack: string,
): { section: string; id: string } | undefined {
  const at = ack.lastIndexOf("#");
  if (at < 0) return undefined;
  const id = ack.slice(at + 1);
  if (!/^T\d+$/.test(id)) return undefined;
  return { section: ack.slice(0, at), id };
}

/**
 * Per-section preparation result. The `matchedHeading` is the heading text as
 * it actually appears in the page — useful for the tool response so the
 * caller can see which heading the tolerant matcher resolved to.
 */
export interface MultiSectionResult {
  /** The section name as supplied by the caller. */
  section: string;
  /** The heading text as it appears in the page (after tolerant match). */
  matchedHeading: string;
  /** Token deletions in this section (ids local to the section, e.g. T0001). */
  deletedTokens: DeletedToken[];
  /** find_replace entries only: per-pair match kind and count. */
  perPair?: FindReplacePairOutcome[];
  /** Byte-equivalent regenerated tokens (C1) for this section. */
  regeneratedTokens: RegeneratedTokenPair[];
}

/**
 * Per-section failure record carried in MultiSectionError.
 */
export interface MultiSectionFailure {
  section: string;
  /**
   * Reason category:
   *   - "duplicate" — the section name appears more than once in the input.
   *   - "missing"   — heading not present in the page.
   *   - "ambiguous" — heading matched multiple candidates in the page.
   *   - "prepare"   — the per-section prepare (body or find_replace) threw.
   *   - "invalid"   — the entry has both or neither of body / find_replace,
   *                   or an itemised ack names a section not in the call.
   */
  reason: "duplicate" | "missing" | "ambiguous" | "prepare" | "invalid";
  /** Human-readable detail (e.g. ambiguity list, prepare error message). */
  message: string;
}

export class MultiSectionError extends Error {
  readonly code = MULTI_SECTION_FAILED;
  readonly failures: MultiSectionFailure[];
  constructor(failures: MultiSectionFailure[]) {
    const summary = failures
      .map((f) => `"${f.section}" (${f.reason}: ${f.message})`)
      .join("; ");
    super(
      `update_page_sections rejected: ${failures.length} section${
        failures.length === 1 ? "" : "s"
      } failed — ${summary}. ` +
        `No changes were submitted; resolve every failing section and retry.`,
    );
    this.name = "MultiSectionError";
    this.failures = failures;
  }
}

/**
 * Output of safePrepareMultiSectionBody. The handler feeds `finalStorage`
 * straight into safeSubmitPage and uses `perSectionResults` /
 * `aggregatedDeletedTokens` for the gate prompt and the tool response.
 */
export interface MultiSectionPrepareOutput {
  /** Merged page storage with all sections spliced in (one final document). */
  finalStorage: string;
  /** Per-section preparation result, in input order. */
  perSectionResults: MultiSectionResult[];
  /**
   * Aggregated deleted tokens across all sections — what the user must
   * acknowledge through the confirm_deletions gate. The gate runs ONCE on
   * this list, not per-section. Ids are section-qualified
   * (`<section>#T0001`, see qualifyTokenId) because ids repeat per section.
   */
  aggregatedDeletedTokens: DeletedToken[];
  /** Aggregated regenerated tokens (C1). */
  aggregatedRegeneratedTokens: RegeneratedTokenPair[];
  /**
   * Combined version-message hints from each per-section safePrepareBody.
   * Joined with "; " so the caller can pass it through unchanged.
   */
  versionMessage: string;
}

/**
 * Locate a section's body byte-range in `currentStorage` against the
 * ORIGINAL page contents. Used to compute splice plans for
 * safePrepareMultiSectionBody — the offsets remain valid as long as the
 * splices are applied in reverse-by-offset order.
 *
 * Returns:
 *   - { ok: true, ... }     — section present and unambiguous.
 *   - { ok: false, ... }    — section missing or ambiguous (carries the
 *                             reason for the per-section failure record).
 *
 * Errors thrown by extractSection / extractSectionBody (B1's tolerant
 * matcher throws on ambiguity) are translated into the structured failure
 * shape so the caller can collect every failure across all sections before
 * raising MultiSectionError.
 */
function locateSectionRange(
  currentStorage: string,
  sectionName: string,
):
  | {
      ok: true;
      bodyStart: number;
      bodyEnd: number;
      currentBody: string;
      matchedHeading: string;
    }
  | { ok: false; reason: "missing" | "ambiguous"; message: string } {
  let sectionWithHeading: string | null;
  let body: string | null;
  try {
    sectionWithHeading = extractSection(currentStorage, sectionName);
    body = extractSectionBody(currentStorage, sectionName);
  } catch (err) {
    return {
      ok: false,
      reason: "ambiguous",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (sectionWithHeading === null || body === null) {
    return {
      ok: false,
      reason: "missing",
      message:
        `Section "${sectionName}" not found. Use headings_only to see ` +
        `available sections.`,
    };
  }

  // Locate the section byte-range in the source by string-search.
  // sectionWithHeading is a verbatim slice of currentStorage; the unique
  // section means a unique slice at this offset. Verify uniqueness so a
  // freak duplication can't silently route the wrong splice.
  const offset = currentStorage.indexOf(sectionWithHeading);
  if (offset < 0) {
    // Should never happen — extractSection returns a slice of currentStorage.
    return {
      ok: false,
      reason: "missing",
      message:
        `Section "${sectionName}" matched but its byte-range could not be ` +
        `located in the source storage. This indicates a corrupt page body.`,
    };
  }
  const second = currentStorage.indexOf(sectionWithHeading, offset + 1);
  if (second !== -1) {
    return {
      ok: false,
      reason: "ambiguous",
      message:
        `Section "${sectionName}" matched a heading whose surrounding ` +
        `content appears more than once in the page; refusing to splice ` +
        `because the target offset is not unique.`,
    };
  }

  const headingLen = sectionWithHeading.length - body.length;
  const bodyStart = offset + headingLen;
  const bodyEnd = bodyStart + body.length;

  // Recover the heading text from the original — the part before the body in
  // the section slice. We surface the rendered heading element back to the
  // caller so they can confirm the tolerant matcher (B1) resolved to the
  // expected target.
  const matchedHeading = sectionWithHeading.slice(0, headingLen);

  return {
    ok: true,
    bodyStart,
    bodyEnd,
    currentBody: body,
    matchedHeading,
  };
}

/**
 * Multi-section, atomic body preparation for the `update_page_sections`
 * tool (D1). Runs every section's prepare against the ORIGINAL page
 * contents, then merges all splices into a single final document.
 *
 * Each entry is `{section, body}` (markdown or storage, through
 * safePrepareBody) or `{section, find_replace}` (through
 * safePrepareFindReplace — the same engine and guards as
 * update_page_section), exactly one of the two (R3).
 *
 * Atomicity: either every section applies cleanly or the whole call throws
 * MultiSectionError. No partial writes — the caller submits one document
 * to safeSubmitPage, which produces one version bump.
 *
 * Ordering: sections are matched against the ORIGINAL page (not the
 * cumulative-edited state), so reordering the input cannot change which
 * heading each section resolves to. Section bodies cannot reference content
 * introduced by an earlier section in the same call. This is documented on
 * the tool description — see register("update_page_sections", ...) in
 * src/server/index.ts.
 *
 * Splice ordering: ranges are sorted by `bodyEnd` descending and applied in
 * that order so an earlier (lower-offset) splice never invalidates a later
 * (higher-offset) splice's offsets. Equivalent to a single-pass merge.
 *
 * Pure: no API calls. Throws MultiSectionError on any per-section failure.
 *
 * DATA-LOSS RISK: medium-high. A naive "apply what we can" mode would
 * silently corrupt pages on partial failure. Mitigations:
 *   1. Locate every section against the ORIGINAL page first; failures are
 *      collected and reported together via MultiSectionError.
 *   2. Each per-section prepare is invoked in isolation; any throw is
 *      captured into the failure list. If ANY section fails, NO splice
 *      is performed, NO submit happens.
 *   3. The deletion-gate runs once on the AGGREGATED deletion list — a
 *      caller cannot bypass the gate by spreading deletions across sections.
 *   4. Aggregate guard (M10): per-section guards are page-relative, so five
 *      sections each removing 15% would each pass. enforceContentSafetyGuards
 *      (plus the marker non-growth check) runs once more on the merged page.
 *
 * confirmDeletions: `true` acknowledges every deletion (as before). A
 * `string[]` is an itemised ack of section-qualified ids
 * (`<section>#T0001`, see qualifyTokenId); each section is checked against
 * its own ids, and an ack naming a section not in the call is rejected.
 */
export async function safePrepareMultiSectionBody(input: {
  currentStorage: string;
  sections: readonly MultiSectionInput[];
  confirmDeletions?: boolean | string[];
  confirmShrinkage?: boolean;
  confirmStructureLoss?: boolean;
  allowRawHtml?: boolean;
  confluenceBaseUrl?: string;
}): Promise<MultiSectionPrepareOutput> {
  const {
    currentStorage,
    sections,
    confirmDeletions,
    confirmShrinkage,
    confirmStructureLoss,
    allowRawHtml,
    confluenceBaseUrl,
  } = input;

  if (sections.length === 0) {
    // Defensive — the zod schema enforces .min(1) at the handler boundary.
    throw new MultiSectionError([
      {
        section: "(none)",
        reason: "missing",
        message: "sections list is empty",
      },
    ]);
  }

  // 0. Shape check — each entry carries exactly one of body / find_replace.
  const shapeFailures: MultiSectionFailure[] = [];
  for (const s of sections) {
    const hasBody = s.body !== undefined;
    const hasPairs = s.find_replace !== undefined && s.find_replace.length > 0;
    if (hasBody === hasPairs) {
      shapeFailures.push({
        section: s.section,
        reason: "invalid",
        message: hasBody
          ? "provide exactly one of `body` or `find_replace`, not both"
          : "provide exactly one of `body` or `find_replace` (neither was provided)",
      });
    }
  }
  if (shapeFailures.length > 0) {
    throw new MultiSectionError(shapeFailures);
  }

  // 1. Dedup check — duplicate section names are an ambiguous-intent signal
  //    and must be rejected before any processing. Collect every duplicate
  //    in one pass so the error message lists them all.
  const seen = new Map<string, number>();
  const dupFailures: MultiSectionFailure[] = [];
  for (const s of sections) {
    const count = (seen.get(s.section) ?? 0) + 1;
    seen.set(s.section, count);
  }
  for (const [name, count] of seen) {
    if (count > 1) {
      dupFailures.push({
        section: name,
        reason: "duplicate",
        message: `appears ${count} times in input — each section name may ` +
          `appear at most once per call`,
      });
    }
  }
  if (dupFailures.length > 0) {
    throw new MultiSectionError(dupFailures);
  }

  // 1b. Itemised acks must each name a section of this call. Routing is by
  //     exact section name (parsed from the right), never by prefix: with
  //     sections "A" and "A#B", "A#B#T0001" belongs to "A#B" only.
  if (Array.isArray(confirmDeletions)) {
    const stray = confirmDeletions.filter((ack) => {
      const parsed = parseQualifiedTokenId(ack);
      return parsed === undefined || !sections.some((s) => s.section === parsed.section);
    });
    if (stray.length > 0) {
      throw new MultiSectionError([
        {
          section: "(confirm_deletions)",
          reason: "invalid",
          message:
            `acknowledgement(s) ${stray.join(", ")} do not name a section in ` +
            `this call; use <section>#<token id>`,
        },
      ]);
    }
  }
  const ackFor = (section: string): string[] | true | undefined => {
    if (!Array.isArray(confirmDeletions)) return confirmDeletions ? true : undefined;
    const ids = confirmDeletions.flatMap((ack) => {
      const parsed = parseQualifiedTokenId(ack);
      return parsed !== undefined && parsed.section === section ? [parsed.id] : [];
    });
    return ids.length > 0 ? ids : undefined;
  };

  // 2. Locate every section against the ORIGINAL page and collect failures.
  //    Heading-resolution failures are collected here, BEFORE any prepare
  //    runs. This guarantees the per-section prepare step (which is the
  //    expensive part — markdown conversion etc.) only fires when every
  //    section is known to exist in the source.
  type Located = {
    entry: MultiSectionInput;
    section: string;
    body: string;
    bodyStart: number;
    bodyEnd: number;
    matchedHeading: string;
  };
  const located: Located[] = [];
  const failures: MultiSectionFailure[] = [];
  for (const s of sections) {
    const r = locateSectionRange(currentStorage, s.section);
    if (!r.ok) {
      failures.push({
        section: s.section,
        reason: r.reason,
        message: r.message,
      });
      continue;
    }
    located.push({
      entry: s,
      section: s.section,
      body: r.currentBody,
      bodyStart: r.bodyStart,
      bodyEnd: r.bodyEnd,
      matchedHeading: r.matchedHeading,
    });
  }
  if (failures.length > 0) {
    throw new MultiSectionError(failures);
  }

  // 3. Verify no two section ranges overlap. Two distinct, unambiguous
  //    sections in the same page cannot legitimately occupy the same byte
  //    range — overlapping ranges would mean the splice plan is non-
  //    deterministic. This catches the pathological case where one section
  //    is fully contained in another (a parent section and its nested
  //    child), or two different names (e.g. "A" and "1. A") that resolve to
  //    the same heading; the dedup check above only covers identical names.
  //    Equal starts count as overlap too: two names that resolve to the same
  //    empty section (bodyStart === bodyEnd) would otherwise both splice at
  //    one offset.
  const sortedByStart = [...located].sort((a, b) => a.bodyStart - b.bodyStart);
  for (let i = 1; i < sortedByStart.length; i++) {
    const prev = sortedByStart[i - 1];
    const cur = sortedByStart[i];
    if (cur.bodyStart < prev.bodyEnd || cur.bodyStart === prev.bodyStart) {
      throw new MultiSectionError([
        {
          section: cur.section,
          reason: "ambiguous",
          message:
            `section "${cur.section}" (range ${cur.bodyStart}-${cur.bodyEnd}) ` +
            `overlaps with "${prev.section}" (range ${prev.bodyStart}-${prev.bodyEnd}). ` +
            `Sections cannot be nested inside each other in a single ` +
            `update_page_sections call.`,
        },
      ]);
    }
  }

  // 4. Per-section prepare. Each call is isolated against its own section
  //    body. Failures are captured into the failure list; we only throw the
  //    aggregated error AFTER all sections have been attempted, so the
  //    caller sees every problem in one round-trip.
  const perSectionResults: MultiSectionResult[] = [];
  const prepareFailures: MultiSectionFailure[] = [];
  const splices: { bodyStart: number; bodyEnd: number; replacement: string }[] = [];
  const versionMessageParts: string[] = [];
  const aggregatedDeleted: DeletedToken[] = [];
  const aggregatedRegenerated: RegeneratedTokenPair[] = [];

  for (const loc of located) {
    let replacement: string;
    let deletedTokens: DeletedToken[];
    let regeneratedTokens: RegeneratedTokenPair[] = [];
    let versionMessage: string;
    let perPair: FindReplacePairOutcome[] | undefined;
    try {
      if (loc.entry.find_replace !== undefined) {
        const fr = safePrepareFindReplace({
          sectionBody: loc.body,
          pairs: loc.entry.find_replace,
          confirmDeletions: ackFor(loc.section),
        });
        // Same page-relative guards as update_page_section's find_replace.
        enforceFindReplacePageGuards({
          oldStorage: currentStorage,
          newStorage:
            currentStorage.slice(0, loc.bodyStart) +
            fr.newSectionBody +
            currentStorage.slice(loc.bodyEnd),
          confirmShrinkage,
          confirmStructureLoss,
          confirmDeletions: confirmDeletions !== undefined && confirmDeletions !== false,
        });
        replacement = fr.newSectionBody;
        deletedTokens = fr.deletedTokens;
        versionMessage = fr.versionMessage;
        perPair = fr.perPair;
      } else {
        const prepared = await safePrepareBody({
          body: loc.entry.body,
          currentBody: loc.body,
          scope: "section",
          confirmDeletions: ackFor(loc.section),
          confirmShrinkage,
          confirmStructureLoss,
          // Measure each section's guards page-relative (see safePrepareBody).
          fullPageBody: currentStorage,
          ...(allowRawHtml !== undefined ? { allowRawHtml } : {}),
          ...(confluenceBaseUrl !== undefined ? { confluenceBaseUrl } : {}),
        });
        if (prepared.finalStorage === undefined) {
          // safePrepareBody returned title-only — meaningless for a section
          // splice. Treat as a prepare failure.
          throw new Error(
            "safePrepareBody returned undefined finalStorage; sections require a body",
          );
        }
        replacement = prepared.finalStorage;
        deletedTokens = prepared.deletedTokens;
        regeneratedTokens = prepared.regeneratedTokens;
        versionMessage = prepared.versionMessage;
      }
    } catch (err) {
      prepareFailures.push({
        section: loc.section,
        reason: "prepare",
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    perSectionResults.push({
      section: loc.section,
      matchedHeading: loc.matchedHeading,
      deletedTokens,
      regeneratedTokens,
      ...(perPair !== undefined ? { perPair } : {}),
    });
    splices.push({
      bodyStart: loc.bodyStart,
      bodyEnd: loc.bodyEnd,
      replacement,
    });
    if (versionMessage) {
      versionMessageParts.push(`${loc.section}: ${versionMessage}`);
    }
    aggregatedDeleted.push(
      ...deletedTokens.map((d) => ({ ...d, id: qualifyTokenId(loc.section, d.id) })),
    );
    aggregatedRegenerated.push(...regeneratedTokens);
  }
  if (prepareFailures.length > 0) {
    throw new MultiSectionError(prepareFailures);
  }

  // 5. Apply splices in reverse-by-offset order against the ORIGINAL body.
  //    Splice indexes were computed against `currentStorage`; replacing in
  //    descending offset order means earlier (lower-offset) replacements
  //    never invalidate later (higher-offset) splice indexes.
  splices.sort((a, b) => b.bodyEnd - a.bodyEnd);
  let merged = currentStorage;
  for (const sp of splices) {
    merged =
      merged.slice(0, sp.bodyStart) + sp.replacement + merged.slice(sp.bodyEnd);
  }

  // 6. Aggregate guard (M10) on the merged page. The fence/canary non-growth
  //    part is redundant for body entries (their input was already checked)
  //    and harmless; it matters for find_replace entries. The comment/CDATA
  //    part is off here: a body entry may add a code macro, and every
  //    find_replace entry passed it on its own in step 4 (entries are
  //    separated by headings, so two of them cannot form one delimiter).
  try {
    enforceFindReplacePageGuards({
      oldStorage: currentStorage,
      newStorage: merged,
      confirmShrinkage,
      confirmStructureLoss,
      confirmDeletions: confirmDeletions !== undefined && confirmDeletions !== false,
      opaqueMarkers: false,
    });
  } catch (err) {
    if (err instanceof ConverterError) {
      throw new ConverterError(
        `Across all ${sections.length} sections combined: ${err.message}`,
        err.code,
      );
    }
    throw err;
  }

  return {
    finalStorage: merged,
    perSectionResults,
    aggregatedDeletedTokens: aggregatedDeleted,
    aggregatedRegeneratedTokens: aggregatedRegenerated,
    versionMessage: versionMessageParts.join("; "),
  };
}
