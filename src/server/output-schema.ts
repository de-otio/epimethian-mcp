/**
 * v6.6.2 T1 — declared `outputSchema` for the five mutating tools so
 * MCP clients that strictly enforce the spec forward our
 * `structuredContent` payload back to the agent.
 *
 * Per the MCP spec (2025-06-18 §6.4.2 "Structured outputs"), most
 * spec-compliant clients DROP `structuredContent` when the registering
 * tool did not declare an `outputSchema`. v6.6.0/6.6.1 emitted the soft
 * confirmation token via `structuredContent.confirm_token`, but Claude
 * Code (and several other clients) silently dropped it because no
 * schema had been declared. The agent never saw the token, the user
 * was prompted but couldn't retry — the soft-confirmation round-trip
 * was effectively broken on the client side.
 *
 * This module declares two discriminated unions:
 *
 *   - `writeOutputSchema` — for tools that mutate page bodies in
 *     place: `update_page`, `update_page_section`, `append_to_page`,
 *     `prepend_to_page`. Either a write succeeded
 *     (`kind: "written"`) or a soft confirmation is required
 *     (`kind: "confirmation_required"`).
 *   - `deleteOutputSchema` — for `delete_page`. Either a delete
 *     succeeded (`kind: "deleted"`) or a soft confirmation is required.
 *
 * Discriminator field: `kind`. Snake_case throughout the on-the-wire
 * shape — agents read these fields back as JSON keys.
 *
 * Data-loss / security invariants enforced by the schema (see §5 of
 * the v6.6.2 plan):
 *
 *   - The success arms (`written`, `deleted`) MUST NOT carry a
 *     `confirm_token` or `audit_id`. Any client that forwards the
 *     full payload sees only the bytes the agent needs to log a
 *     successful mutation.
 *   - The confirmation arm carries the token and audit ID. The token
 *     bytes must round-trip cleanly through the schema (validated by
 *     `output-schema.test.ts`).
 *   - `human_summary` is built from numeric counts only, NEVER from
 *     tenant content. The schema accepts a string but the producing
 *     code (`formatSoftConfirmationResult` in safe-write.ts) is the
 *     load-bearing invariant; this module only constrains shape.
 *   - `deletion_summary` carries numeric counts ONLY (zod numbers),
 *     so a malformed/attacker-shaped payload cannot smuggle strings
 *     through the schema.
 *
 * IMPORTANT: do not annotate `writeOutputSchema` /
 * `deleteOutputSchema` with explicit `z.ZodType<…>` annotations.
 * `z.discriminatedUnion` produces an inferred type whose `_input`
 * may not align with a hand-written annotation, and TS will reject
 * the assignment. Same trap that bit T2 in v6.6.1 — let TS infer.
 */

import { z } from "zod";

/**
 * Numeric breakdown of what a confirm_deletions gate is about to
 * remove. Mirrors `DeletionSummary` in elicitation.ts but uses
 * snake_case keys for the on-the-wire output payload. All values
 * are numeric counts — never tenant content.
 */
const deletionSummarySchema = z.object({
  tocs: z.number().int().nonnegative(),
  links: z.number().int().nonnegative(),
  structured_macros: z.number().int().nonnegative(),
  code_macros: z.number().int().nonnegative(),
  plain_elements: z.number().int().nonnegative(),
  other: z.number().int().nonnegative(),
});

/**
 * Confirmation-required arm — emitted when the soft-elicitation path
 * mints a token. The agent surfaces `human_summary` to the user, asks
 * for approval, and on approval re-calls the tool with the
 * `confirm_token` parameter set.
 *
 * `confirm_token` carries the full single-use token bytes minted by
 * `confirmation-tokens.ts.mintToken`. It is bound to the exact
 * {tool, cloudId, pageId, pageVersion, diffHash} tuple and rejected
 * by `validateToken` if any of those drift. The token is single-use
 * and TTL-bounded (default 5 min, env-tunable).
 *
 * `audit_id` is the audit-log linkage for this mint; it appears in
 * the `onMint` and matching `onValidate` audit records. Distinct
 * from the token bytes (which never appear in audit records).
 *
 * `expires_at` is an ISO-8601 timestamp string; the producer
 * formats `Date(err.expiresAt).toISOString()`.
 *
 * `deletion_summary` is optional and present only when the gate
 * was a destructive-flag gate that produced a forecast.
 */
export const confirmationRequiredArm = z.object({
  kind: z.literal("confirmation_required"),
  confirm_token: z.string().min(1),
  audit_id: z.string().min(1),
  expires_at: z.string().min(1),
  page_id: z.string().min(1),
  human_summary: z.string(),
  deletion_summary: deletionSummarySchema.optional(),
});

/**
 * Successful-write arm — emitted when an in-place page body update
 * (or section update / append / prepend) succeeded. `new_version`
 * is the version number now persisted in Confluence. `body_bytes_*`
 * are post-conversion byte counts and may be omitted for
 * title-only updates that did not touch the body.
 */
export const writeSuccessArm = z.object({
  kind: z.literal("written"),
  page_id: z.string().min(1),
  new_version: z.number().int().positive(),
  body_bytes_before: z.number().int().nonnegative().optional(),
  body_bytes_after: z.number().int().nonnegative().optional(),
  title: z.string().optional(),
});

/**
 * Successful-delete arm — emitted when delete_page succeeded.
 * `last_version` is the version number that was deleted (the
 * caller-supplied version that was current at delete time).
 *
 * `last_version` is optional ONLY to support the deprecated
 * `EPIMETHIAN_LEGACY_DELETE_WITHOUT_VERSION` opt-out, which lets
 * callers run delete_page without a version and emits a stderr
 * warning. In all non-legacy paths the field is populated.
 */
export const deleteSuccessArm = z.object({
  kind: z.literal("deleted"),
  page_id: z.string().min(1),
  last_version: z.number().int().positive().optional(),
});

/**
 * Discriminated union for tools that mutate a page body in place:
 * `update_page`, `update_page_section`, `append_to_page`,
 * `prepend_to_page`.
 */
export const writeOutputSchema = z.discriminatedUnion("kind", [
  writeSuccessArm,
  confirmationRequiredArm,
]);

/**
 * Discriminated union for `delete_page`.
 */
export const deleteOutputSchema = z.discriminatedUnion("kind", [
  deleteSuccessArm,
  confirmationRequiredArm,
]);

/** Inferred output type for the four write tools. */
export type WriteOutput = z.infer<typeof writeOutputSchema>;

/** Inferred output type for delete_page. */
export type DeleteOutput = z.infer<typeof deleteOutputSchema>;
