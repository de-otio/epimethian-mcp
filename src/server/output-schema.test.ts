/**
 * v6.6.2 T1 — schema tests for the discriminated unions in
 * output-schema.ts. Covers each arm's positive case plus the cross-
 * arm rejections that uphold the §5 data-loss invariants:
 *
 *   - A confirmation_required payload must NEVER validate against
 *     the success arm (would let a client treat a soft-confirm as a
 *     completed write and skip the user prompt).
 *   - A success payload must NEVER validate against the
 *     confirmation_required arm (would let a client surface a
 *     phantom token-prompt after a successful write).
 *   - The discriminator field `kind` must mismatch on the wrong
 *     output schema (e.g. `kind: "deleted"` against
 *     writeOutputSchema must fail).
 *   - The success arm's TYPE must not contain `confirm_token` or
 *     `audit_id` (compile-time guard via `Extract<…>` — caught by
 *     `tsc` if the schema regresses).
 *
 * One test additionally round-trips a freshly minted token through
 * `confirmation-tokens.ts` to confirm the schema does not mangle
 * the byte sequence.
 */

import { describe, expect, it } from "vitest";
import {
  confirmationRequiredArm,
  deleteOutputSchema,
  deleteSuccessArm,
  writeOutputSchema,
  writeSuccessArm,
  type WriteOutput,
} from "./output-schema.js";
import {
  computeDiffHash,
  mintToken,
  validateToken,
  _resetForTest,
} from "./confirmation-tokens.js";

describe("output-schema arms — positive cases", () => {
  it("writeSuccessArm accepts a fully-populated written payload", () => {
    const ok = writeSuccessArm.parse({
      kind: "written",
      page_id: "page-42",
      new_version: 8,
      body_bytes_before: 1234,
      body_bytes_after: 1356,
      title: "Test Page",
    });
    expect(ok.kind).toBe("written");
    expect(ok.new_version).toBe(8);
  });

  it("writeSuccessArm accepts a minimal payload (no body byte counts, no title)", () => {
    const ok = writeSuccessArm.parse({
      kind: "written",
      page_id: "page-42",
      new_version: 8,
    });
    expect(ok.kind).toBe("written");
    expect(ok.body_bytes_before).toBeUndefined();
    expect(ok.title).toBeUndefined();
  });

  it("deleteSuccessArm accepts a deleted payload", () => {
    const ok = deleteSuccessArm.parse({
      kind: "deleted",
      page_id: "page-99",
      last_version: 17,
    });
    expect(ok.kind).toBe("deleted");
    expect(ok.last_version).toBe(17);
  });

  it("confirmationRequiredArm accepts a fully-populated payload (with deletion_summary)", () => {
    const ok = confirmationRequiredArm.parse({
      kind: "confirmation_required",
      confirm_token: "abcdefghij1234567890ABCDEF",
      audit_id: "audit-uuid-001",
      expires_at: "2026-04-30T12:00:00.000Z",
      page_id: "page-42",
      human_summary: "This update will remove 1 TOC macro and 8 link macros.",
      deletion_summary: {
        tocs: 1,
        links: 8,
        structured_macros: 0,
        code_macros: 0,
        plain_elements: 0,
        other: 0,
      },
    });
    expect(ok.kind).toBe("confirmation_required");
    expect(ok.confirm_token).toBe("abcdefghij1234567890ABCDEF");
    expect(ok.deletion_summary?.links).toBe(8);
  });

  it("confirmationRequiredArm accepts a payload without deletion_summary", () => {
    const ok = confirmationRequiredArm.parse({
      kind: "confirmation_required",
      confirm_token: "tok-bytes-here",
      audit_id: "audit-002",
      expires_at: "2026-04-30T12:00:00.000Z",
      page_id: "page-7",
      human_summary: "Permanently delete page",
    });
    expect(ok.deletion_summary).toBeUndefined();
  });
});

describe("output-schema unions — discriminator routing", () => {
  it("writeOutputSchema accepts a written payload", () => {
    const ok = writeOutputSchema.parse({
      kind: "written",
      page_id: "page-42",
      new_version: 8,
    });
    expect(ok.kind).toBe("written");
  });

  it("writeOutputSchema accepts a confirmation_required payload", () => {
    const ok = writeOutputSchema.parse({
      kind: "confirmation_required",
      confirm_token: "tok",
      audit_id: "aud",
      expires_at: "2026-01-01T00:00:00Z",
      page_id: "page-1",
      human_summary: "Summary.",
    });
    expect(ok.kind).toBe("confirmation_required");
  });

  it("deleteOutputSchema accepts a deleted payload", () => {
    const ok = deleteOutputSchema.parse({
      kind: "deleted",
      page_id: "page-1",
      last_version: 3,
    });
    expect(ok.kind).toBe("deleted");
  });

  it("deleteOutputSchema accepts a confirmation_required payload", () => {
    const ok = deleteOutputSchema.parse({
      kind: "confirmation_required",
      confirm_token: "tok",
      audit_id: "aud",
      expires_at: "2026-01-01T00:00:00Z",
      page_id: "page-1",
      human_summary: "Summary.",
    });
    expect(ok.kind).toBe("confirmation_required");
  });
});

describe("output-schema unions — discriminator-mismatch rejection (security)", () => {
  it("writeOutputSchema rejects kind=\"deleted\"", () => {
    const r = writeOutputSchema.safeParse({
      kind: "deleted",
      page_id: "page-1",
      last_version: 3,
    });
    expect(r.success).toBe(false);
  });

  it("deleteOutputSchema rejects kind=\"written\"", () => {
    const r = deleteOutputSchema.safeParse({
      kind: "written",
      page_id: "page-1",
      new_version: 4,
    });
    expect(r.success).toBe(false);
  });

  // §5 invariant: a confirmation_required payload must NEVER validate
  // against a success arm. If this regresses, a client could treat a
  // soft-confirm as a completed write and skip the user prompt.
  it("writeSuccessArm REJECTS a confirmation_required payload (data-loss invariant)", () => {
    const r = writeSuccessArm.safeParse({
      kind: "confirmation_required",
      confirm_token: "tok",
      audit_id: "aud",
      expires_at: "2026-01-01T00:00:00Z",
      page_id: "page-1",
      human_summary: "Summary.",
    });
    expect(r.success).toBe(false);
  });

  it("deleteSuccessArm REJECTS a confirmation_required payload (data-loss invariant)", () => {
    const r = deleteSuccessArm.safeParse({
      kind: "confirmation_required",
      confirm_token: "tok",
      audit_id: "aud",
      expires_at: "2026-01-01T00:00:00Z",
      page_id: "page-1",
      human_summary: "Summary.",
    });
    expect(r.success).toBe(false);
  });

  // Reverse direction: a success-arm payload must NEVER validate
  // against the confirmation arm — otherwise a client could surface a
  // phantom token-prompt after a successful write.
  it("confirmationRequiredArm REJECTS a written payload", () => {
    const r = confirmationRequiredArm.safeParse({
      kind: "written",
      page_id: "page-1",
      new_version: 4,
    });
    expect(r.success).toBe(false);
  });

  it("confirmationRequiredArm REJECTS a deleted payload", () => {
    const r = confirmationRequiredArm.safeParse({
      kind: "deleted",
      page_id: "page-1",
      last_version: 3,
    });
    expect(r.success).toBe(false);
  });
});

describe("output-schema — required-field rejection", () => {
  it("writeSuccessArm rejects when new_version is missing", () => {
    const r = writeSuccessArm.safeParse({
      kind: "written",
      page_id: "page-1",
    });
    expect(r.success).toBe(false);
  });

  it("confirmationRequiredArm rejects when confirm_token is missing", () => {
    const r = confirmationRequiredArm.safeParse({
      kind: "confirmation_required",
      audit_id: "aud",
      expires_at: "2026-01-01T00:00:00Z",
      page_id: "page-1",
      human_summary: "Summary.",
    });
    expect(r.success).toBe(false);
  });

  it("confirmationRequiredArm rejects when human_summary is missing", () => {
    const r = confirmationRequiredArm.safeParse({
      kind: "confirmation_required",
      confirm_token: "tok",
      audit_id: "aud",
      expires_at: "2026-01-01T00:00:00Z",
      page_id: "page-1",
    });
    expect(r.success).toBe(false);
  });

  it("confirmationRequiredArm rejects deletion_summary with non-numeric counts", () => {
    const r = confirmationRequiredArm.safeParse({
      kind: "confirmation_required",
      confirm_token: "tok",
      audit_id: "aud",
      expires_at: "2026-01-01T00:00:00Z",
      page_id: "page-1",
      human_summary: "Summary.",
      deletion_summary: {
        tocs: "not-a-number",
        links: 0,
        structured_macros: 0,
        code_macros: 0,
        plain_elements: 0,
        other: 0,
      },
    });
    expect(r.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// §5 data-loss invariant: real-token byte round-trip
// ────────────────────────────────────────────────────────────────────

describe("output-schema — token byte-sequence integrity", () => {
  it("a real minted token survives parse/stringify through confirmationRequiredArm and re-validates ok", async () => {
    _resetForTest();
    const cloudId = "cloud-roundtrip";
    const pageId = "page-rt-1";
    const pageVersion = 7;
    const diffHash = computeDiffHash("<p>round-trip body</p>", pageVersion);

    const minted = mintToken({
      tool: "update_page",
      cloudId,
      pageId,
      pageVersion,
      diffHash,
    });

    // Build the confirmation-arm payload exactly as
    // formatSoftConfirmationResult does.
    const payload = {
      kind: "confirmation_required" as const,
      confirm_token: minted.token,
      audit_id: minted.auditId,
      expires_at: new Date(minted.expiresAt).toISOString(),
      page_id: pageId,
      human_summary: "Round-trip test.",
    };

    // Parse through the schema and verify the bytes survive.
    const parsed = confirmationRequiredArm.parse(payload);
    expect(parsed.confirm_token).toBe(minted.token);

    // The parsed token must validate cleanly against the token store.
    const outcome = await validateToken(parsed.confirm_token, {
      tool: "update_page",
      cloudId,
      pageId,
      pageVersion,
      diffHash,
    });
    expect(outcome).toBe("ok");
  });
});

// ────────────────────────────────────────────────────────────────────
// §5 data-loss invariant: success arm has no token-leak keys
// (compile-time guard — TS rejects if the schema regresses)
// ────────────────────────────────────────────────────────────────────

describe("output-schema — success arm cannot carry token fields (type-level)", () => {
  it("Extract<WriteOutput, {kind: 'written'}> has NO confirm_token / audit_id keys", () => {
    type WrittenArm = Extract<WriteOutput, { kind: "written" }>;
    // These two assignments must compile to `never` — which TS will
    // accept as `void` in an unused expression context. The point of
    // the test is the type-level assertion below; the runtime body is
    // a simple shape assertion that complements the compile-time guard.
    type HasConfirmToken = "confirm_token" extends keyof WrittenArm
      ? true
      : false;
    type HasAuditId = "audit_id" extends keyof WrittenArm ? true : false;

    // If the schema regresses to include these keys, these asserts go
    // from `false` to `true` and the line below stops compiling.
    const noConfirmToken: HasConfirmToken = false;
    const noAuditId: HasAuditId = false;
    expect(noConfirmToken).toBe(false);
    expect(noAuditId).toBe(false);

    // Runtime sanity check: a written payload constructed with stray
    // confirm_token / audit_id keys still parses (zod's default mode
    // strips unknowns) — the data-loss guard is the TYPE constraint
    // above, not the parser. The parser strips so a misbehaving
    // producer can't smuggle these keys into a `written` arm.
    // (`unknown` cast: zod's input type is `unknown`, so a literal
    // with extra keys is accepted at parse time; the strip-on-parse
    // behaviour is what we're confirming.)
    const stripped = writeSuccessArm.parse({
      kind: "written",
      page_id: "page-1",
      new_version: 4,
      confirm_token: "should-be-stripped",
      audit_id: "should-be-stripped",
    } as unknown);
    expect((stripped as Record<string, unknown>).confirm_token).toBeUndefined();
    expect((stripped as Record<string, unknown>).audit_id).toBeUndefined();
  });
});

// v6.6.3 regression-net — would have caught the v6.6.2 ship.
//
// The MCP SDK's `normalizeObjectSchema` (called by `validateToolOutput`
// after every tool handler returns) only handles Zod-3 schemas that
// expose a `.shape` property. `z.discriminatedUnion` does NOT — it
// exposes `.options` and `.discriminator` instead. v6.6.2 declared the
// outputSchemas as discriminated unions; the SDK normalised them to
// `undefined` and then threw `Cannot read properties of undefined
// (reading '_zod')` AFTER the Confluence write had already committed,
// leaving the agent with a "failed" call result while the page was
// already mutated.
//
// These tests replicate the SDK's own check inline and assert the
// registered schemas survive it. Any future regression that swaps
// the schemas back to a non-`.shape` form (discriminated union, raw
// union, intersection) trips this test in milliseconds.
//
// See `doc/design/investigations/investigate-v6.6.2-regression-and-coverage-gaps.md`
// for the full root-cause analysis.
function normalizeObjectSchemaProbe(schema: unknown): unknown | undefined {
  if (
    schema &&
    typeof schema === "object" &&
    (schema as { shape?: unknown }).shape !== undefined
  ) {
    return schema;
  }
  return undefined;
}

describe("outputSchema is SDK-normalisable (v6.6.3 regression net)", () => {
  it("writeOutputSchema exposes a .shape property", () => {
    const shape = (writeOutputSchema as unknown as { shape?: Record<string, unknown> }).shape;
    expect(shape).toBeDefined();
    expect(Object.keys(shape!)).toContain("kind");
    expect(Object.keys(shape!)).toContain("page_id");
  });

  it("deleteOutputSchema exposes a .shape property", () => {
    const shape = (deleteOutputSchema as unknown as { shape?: Record<string, unknown> }).shape;
    expect(shape).toBeDefined();
    expect(Object.keys(shape!)).toContain("kind");
    expect(Object.keys(shape!)).toContain("page_id");
  });

  it("writeOutputSchema survives the SDK's normalize-object check", () => {
    expect(normalizeObjectSchemaProbe(writeOutputSchema)).toBeDefined();
  });

  it("deleteOutputSchema survives the SDK's normalize-object check", () => {
    expect(normalizeObjectSchemaProbe(deleteOutputSchema)).toBeDefined();
  });

  it("writeOutputSchema accepts the success arm's payload shape", () => {
    const r = writeOutputSchema.safeParse({
      kind: "written",
      page_id: "page-1",
      new_version: 5,
      body_bytes_before: 100,
      body_bytes_after: 200,
      title: "T",
    });
    expect(r.success).toBe(true);
  });

  it("writeOutputSchema accepts the confirmation_required arm's payload shape", () => {
    const r = writeOutputSchema.safeParse({
      kind: "confirmation_required",
      page_id: "page-1",
      confirm_token: "x".repeat(32),
      audit_id: "audit-1",
      expires_at: "2026-04-30T07:00:00.000Z",
      human_summary: "summary",
    });
    expect(r.success).toBe(true);
  });

  it("writeOutputSchema rejects a payload with an invalid kind value", () => {
    const r = writeOutputSchema.safeParse({
      kind: "deleted", // wrong discriminator for write tools
      page_id: "page-1",
    });
    expect(r.success).toBe(false);
  });

  it("deleteOutputSchema accepts the success arm's payload shape", () => {
    const r = deleteOutputSchema.safeParse({
      kind: "deleted",
      page_id: "page-1",
      last_version: 5,
    });
    expect(r.success).toBe(true);
  });

  it("deleteOutputSchema accepts the confirmation_required arm's payload shape", () => {
    const r = deleteOutputSchema.safeParse({
      kind: "confirmation_required",
      page_id: "page-1",
      confirm_token: "x".repeat(32),
      audit_id: "audit-1",
      expires_at: "2026-04-30T07:00:00.000Z",
      human_summary: "summary",
    });
    expect(r.success).toBe(true);
  });

  it("deleteOutputSchema rejects a payload with an invalid kind value", () => {
    const r = deleteOutputSchema.safeParse({
      kind: "written", // wrong discriminator for delete
      page_id: "page-1",
    });
    expect(r.success).toBe(false);
  });
});
