/**
 * Track E4: human-in-the-loop elicitation for gated write operations.
 *
 * Calls `server.server.elicitInput()` to surface a "confirm?" prompt to
 * the user before executing a gated tool call. The MCP elicitation
 * feature (2025-06-18 spec) returns one of three actions:
 *
 *   - "accept"  — user approved; proceed with the call.
 *   - "decline" — user explicitly rejected; abort with `USER_DECLINED`.
 *   - "cancel"  — user cancelled the prompt; abort with `USER_CANCELLED`.
 *
 * Other outcomes (timeout, transport error, unknown action) are treated
 * as `NO_USER_RESPONSE` — fail-closed, do not execute the gated action.
 *
 * Unsupported-client behaviour (Phase 2 / v6.6.0): see the §3.4
 * precedence table in
 * [plans/opencode-compatibility-implementation.md](../../plans/opencode-compatibility-implementation.md).
 * The branches are evaluated top-down; the first match wins:
 *
 *   1. `EPIMETHIAN_BYPASS_ELICITATION=true` — silent bypass for clients
 *      that falsely advertise elicitation support.
 *   2. `EPIMETHIAN_ALLOW_UNGATED_WRITES=true` AND client lacks
 *      elicitation — operator opt-out for elicitation-less clients.
 *   3. `EPIMETHIAN_DISABLE_SOFT_CONFIRM=true` AND client lacks
 *      elicitation — legacy fail-closed throw, restoring v6.5.0 behaviour.
 *   4. Client lacks elicitation AND all four soft-mode fields
 *      (`cloudId`, `pageId`, `pageVersion`, `diffHash`) are present —
 *      mint a confirmation token and throw `SoftConfirmationRequiredError`.
 *      The agent surfaces the prompt to the user and retries with the
 *      `confirm_token` parameter.
 *   5. Client lacks elicitation AND any soft-mode field is missing —
 *      fail-closed `ELICITATION_REQUIRED_BUT_UNAVAILABLE`. We refuse
 *      rather than silently bypass.
 *   6. Client supports elicitation — real `elicitInput()` request.
 *
 * Spec: see
 * `doc/design/investigations/investigate-prompt-injection-hardening/07-human-in-the-loop.md`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SOFT_CONFIRM_RATE_LIMITED,
  mintToken,
} from "./confirmation-tokens.js";
import { clientSupportsElicitation } from "./index.js";

/**
 * Structured breakdown of what a confirm_deletions gate is about to remove.
 * Counts are drawn from the post-suppression deletion set (after C1's
 * byte-equivalent filter), so the numbers match what the user will actually
 * lose. Categories with a zero count are omitted from the human-readable
 * prompt.
 */
export interface DeletionSummary {
  /** Number of Table-of-Contents macros being removed. */
  tocs: number;
  /** Number of ac:link macros being removed. */
  links: number;
  /** Number of non-toc, non-code structured macros being removed. */
  structuredMacros: number;
  /** Number of code-block macros being removed. */
  codeMacros: number;
  /** Number of plain elements (emoticons, etc.) being removed. */
  plainElements: number;
  /** Number of tokens that couldn't be classified into the above categories. */
  other: number;
}

/** Error code thrown when the user explicitly declines a gated operation. */
export const USER_DECLINED = "USER_DECLINED";
/** Error code thrown when the user cancels the elicitation prompt. */
export const USER_CANCELLED = "USER_CANCELLED";
/**
 * Error code thrown when no user response was received — e.g. timeout,
 * transport error, or an unrecognised action value.
 */
export const NO_USER_RESPONSE = "NO_USER_RESPONSE";
/**
 * Error code thrown when elicitation is needed but the connected client
 * does not support it (and the opt-out flag is not set).
 */
export const ELICITATION_REQUIRED_BUT_UNAVAILABLE =
  "ELICITATION_REQUIRED_BUT_UNAVAILABLE";

/**
 * Error code thrown when soft-elicitation fires and a confirmation
 * token has been minted for the agent to surface to the user. The
 * caller is expected to re-invoke the tool with `confirm_token` once
 * the user approves. See §3.3 of the opencode-compatibility plan.
 */
export const SOFT_CONFIRMATION_REQUIRED = "SOFT_CONFIRMATION_REQUIRED";

export class GatedOperationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GatedOperationError";
    this.code = code;
  }
}

/**
 * Thrown when the soft-elicitation path mints a confirmation token.
 * Carries the token and the metadata an agent needs to render a
 * user-facing confirmation prompt and retry the call.
 *
 * The full token is intended to be returned via the MCP
 * `structuredContent.confirm_token` channel — NOT free-text — so it
 * stays out of the agent's scratchpad. See §3.3 / §3.5 of the
 * opencode-compatibility plan.
 */
export class SoftConfirmationRequiredError extends GatedOperationError {
  readonly token: string;
  readonly auditId: string;
  readonly expiresAt: number;
  readonly humanSummary: string;
  readonly retryHint: string;
  readonly pageId: string;

  constructor(args: {
    token: string;
    auditId: string;
    expiresAt: number;
    humanSummary: string;
    retryHint: string;
    pageId: string;
    message: string;
  }) {
    super(SOFT_CONFIRMATION_REQUIRED, args.message);
    this.name = "SoftConfirmationRequiredError";
    this.token = args.token;
    this.auditId = args.auditId;
    this.expiresAt = args.expiresAt;
    this.humanSummary = args.humanSummary;
    this.retryHint = args.retryHint;
    this.pageId = args.pageId;
  }
}

export interface GatedOperationContext {
  /** Tool being gated — used for both message framing and the log line. */
  tool: string;
  /** Human-readable one-line summary of what the action will do. */
  summary: string;
  /**
   * Specific flags / metadata to show the user. Rendered as key=value
   * pairs below the summary. Keep values short — this is for quick
   * human inspection, not a full diff.
   *
   * When `deletionSummary` is present (as a `DeletionSummary` object),
   * it is rendered as a human-readable sentence instead of key=value,
   * e.g. "This update will remove 1 TOC macro and 8 link macros…".
   */
  details?: Record<string, string | number | boolean | DeletionSummary | undefined>;

  // ──── Soft-elicitation fields (all optional; required as a SET when
  // soft-mode triggers — see §3.7 of the opencode-compatibility plan) ────

  /**
   * Confluence cloudId of the tenant the operation runs under. Sourced
   * from `cfg.sealedCloudId` after `await getConfig()`.
   */
  cloudId?: string;
  /** Page ID the operation will affect. */
  pageId?: string;
  /** `version.number` of the page at the time the diff was computed. */
  pageVersion?: number;
  /**
   * SHA-256 hex of the canonical post-prepare storage XML, computed
   * via `computeDiffHash(canonicalXml, pageVersion)` from
   * confirmation-tokens.ts.
   */
  diffHash?: string;
}

/**
 * Render a `DeletionSummary` as a single human-readable English clause.
 * Pluralises correctly and omits zero-count categories.
 *
 * Pure function of the numeric counts — no tenant content is ever
 * interpolated. See §3.5 "humanSummary content invariant".
 *
 * Examples:
 *  - `{tocs: 1, links: 8, ...zeros}` →
 *    *"This update will remove 1 TOC macro and 8 link macros."*
 *  - all-zero counts → *"This update has no destructive changes."*
 */
export function renderDeletionSummary(s: DeletionSummary): string {
  const parts: string[] = [];
  if (s.tocs > 0) parts.push(`${s.tocs} TOC macro${s.tocs === 1 ? "" : "s"}`);
  if (s.links > 0) parts.push(`${s.links} link macro${s.links === 1 ? "" : "s"}`);
  if (s.codeMacros > 0)
    parts.push(`${s.codeMacros} code macro${s.codeMacros === 1 ? "" : "s"}`);
  if (s.structuredMacros > 0)
    parts.push(
      `${s.structuredMacros} structured macro${s.structuredMacros === 1 ? "" : "s"}`,
    );
  if (s.plainElements > 0)
    parts.push(
      `${s.plainElements} plain element${s.plainElements === 1 ? "" : "s"}`,
    );
  if (s.other > 0)
    parts.push(`${s.other} other element${s.other === 1 ? "" : "s"}`);
  if (parts.length === 0) {
    return "This update has no destructive changes.";
  }
  const list =
    parts.length === 1
      ? parts[0]
      : parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
  return `This update will remove ${list}.`;
}

/**
 * Module-level "have we logged the BYPASS-vs-non-faking-client
 * misconfiguration warning yet?" flag. Per §3.4 the warning fires once
 * per process to surface the most common operator misconfiguration
 * without spamming the log.
 */
let bypassMisconfigWarningFired = false;

/**
 * Testing-only: reset the once-per-process startup-warning flag. Not
 * exported via the package barrel — internal to elicitation tests.
 */
export function _resetStartupWarningForTest(): void {
  bypassMisconfigWarningFired = false;
}

// ────────────────────────────────────────────────────────────────────────
// Fast-decline auto-detection (v6.6.1, §3.2 of fix-claude-code-elicitation
// plan). Some MCP clients (notably the Claude Code VS Code extension
// ≤ 2.1.123) advertise `capabilities.elicitation = {}` during the MCP
// `initialize` handshake but auto-decline every elicitation/create call
// without surfacing UI to the user. The naive
// `clientSupportsElicitation()` check returns `true` and we'd take the
// row-6 branch, get an instant `decline`, and throw `USER_DECLINED` —
// the user never sees a prompt.
//
// We detect this by timing the round trip: if `elicitInput()` resolves
// with `action: "decline"` faster than any human could plausibly hit a
// button, treat it as a fake decline. Mark the client as "faking" for
// the rest of the session and re-evaluate the gate as if elicitation
// were unsupported (which routes through the soft-confirm path).
// ────────────────────────────────────────────────────────────────────────

/** Default threshold below which a `decline` is considered fake. */
export const FAST_DECLINE_THRESHOLD_MS = 50;

/**
 * Env var name for overriding the threshold. Value is parsed as an
 * integer and clamped to `[10, 5000]`.
 */
export const FAST_DECLINE_THRESHOLD_OVERRIDE_ENV =
  "EPIMETHIAN_FAST_DECLINE_THRESHOLD_MS";

/**
 * Env var name for the total off-switch. When set to `"true"` the
 * timing measurement still happens (to keep the code path simple) but
 * the result is never used to flip the faking flag. See §7 of the plan.
 */
export const DISABLE_FAST_DECLINE_DETECTION_ENV =
  "EPIMETHIAN_DISABLE_FAST_DECLINE_DETECTION";

/**
 * Env var name for the deterministic "treat this client as
 * elicitation-unsupported" override. Bypasses the timing heuristic
 * entirely and always routes through `effectiveSupportsElicitation`'s
 * `false` branch.
 */
export const TREAT_ELICITATION_AS_UNSUPPORTED_ENV =
  "EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED";

/**
 * Per-`McpServer`-instance flag set on the first observed fast-decline.
 * Sticky for the lifetime of the McpServer (one MCP session). Stored
 * as a `WeakMap` so server instances can be GC'd without leaking.
 *
 * NOT a global flag — multi-tenant MCP host processes that connect to
 * several clients must track this per `McpServer` instance.
 *
 * Module-level `let` (not `const`) so `_resetFakeElicitationStateForTest`
 * can swap the map reference cheaply rather than iterating to clear it.
 */
let fakingElicitationFlags: WeakMap<McpServer, boolean> = new WeakMap();

/**
 * Read the per-server fake-elicitation flag.
 *
 * Returns `true` when this server's client has been observed to
 * fast-decline an `elicitInput` request earlier in the session.
 */
export function isClientFakingElicitation(server: McpServer): boolean {
  return fakingElicitationFlags.get(server) === true;
}

/**
 * Internal: mark a server's client as faking elicitation. Sticky for
 * the lifetime of the server. Exported with an underscore-prefix so
 * it's discoverable in tests but signposted as not part of the public
 * surface.
 */
export function _markClientAsFakingElicitation(server: McpServer): void {
  fakingElicitationFlags.set(server, true);
}

/**
 * Testing-only: clear the fake-elicitation WeakMap. Implemented as a
 * fresh-map swap so we don't have to enumerate keys (WeakMap is
 * non-iterable). Not part of the public package surface.
 */
export function _resetFakeElicitationStateForTest(): void {
  fakingElicitationFlags = new WeakMap();
}

/**
 * Read and clamp the fast-decline threshold.
 *
 * - Default: `FAST_DECLINE_THRESHOLD_MS` (50).
 * - Override via `EPIMETHIAN_FAST_DECLINE_THRESHOLD_MS=<integer>`.
 * - Clamped to `[10, 5000]` to prevent both pathological tunings (0 →
 *   never trigger; 60000 → real declines auto-converted to soft) and
 *   adversarial overrides. See §5.1 of the plan.
 * - Non-integer / non-finite values fall back to the default.
 */
function readFastDeclineThresholdMs(): number {
  const raw = process.env[FAST_DECLINE_THRESHOLD_OVERRIDE_ENV];
  if (raw === undefined || raw === "") return FAST_DECLINE_THRESHOLD_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return FAST_DECLINE_THRESHOLD_MS;
  if (parsed < 10) return 10;
  if (parsed > 5000) return 5000;
  return parsed;
}

/**
 * Composite check used by `gateOperation`. Returns `false` when:
 *   1. `EPIMETHIAN_TREAT_ELICITATION_AS_UNSUPPORTED=true`, or
 *   2. The connected client has been observed to fast-decline an
 *      earlier elicitation request in this session.
 *
 * Otherwise delegates to `clientSupportsElicitation` (the unchanged
 * read of advertised capabilities).
 */
export function effectiveSupportsElicitation(server: McpServer): boolean {
  if (process.env[TREAT_ELICITATION_AS_UNSUPPORTED_ENV] === "true") {
    return false;
  }
  if (isClientFakingElicitation(server)) {
    return false;
  }
  return clientSupportsElicitation(server);
}

/**
 * Result of `evaluateUnsupportedBranch`:
 *   - `"handled"` — rows 1–5 short-circuited the gate. Either the gate
 *     resolved silently (rows 1–2) or threw (rows 3–5). The caller
 *     must not invoke row 6.
 *   - `"fall_through"` — the client effectively supports elicitation;
 *     row 6 (the real `elicitInput()` request) should run.
 */
type UnsupportedBranchOutcome = "handled" | "fall_through";

/**
 * Evaluate rows 1–5 of the §3.3 precedence table. Returns
 * `"fall_through"` only when none of those rows applies — i.e. the
 * client effectively supports elicitation and the caller should run the
 * row-6 real-elicitation path.
 *
 * Extracted from `gateOperation` so the post-fast-decline retry can
 * re-use the same selector without duplicating logic. The retry path
 * MUST NOT issue a second `elicitInput` (data-loss invariant — see
 * §3.2 of the v6.6.1 plan); routing the retry through this helper
 * guarantees that, since the helper never calls `elicitInput`.
 */
async function evaluateUnsupportedBranch(
  server: McpServer,
  context: GatedOperationContext,
): Promise<UnsupportedBranchOutcome> {
  const supported = effectiveSupportsElicitation(server);

  // Row 1: BYPASS — escape hatch for clients that falsely advertise
  // elicitation support but auto-decline every request without UI.
  // Observed in the Claude Code VS Code extension (≤ 2.1.123).
  if (process.env.EPIMETHIAN_BYPASS_ELICITATION === "true") {
    // Startup-time misconfiguration warning (§3.4): if the connected
    // client effectively does NOT support elicitation, BYPASS is the
    // wrong knob — ALLOW_UNGATED_WRITES (or v6.6.0's soft-confirmation
    // default) is the intended path. Warn ONCE per process to avoid log
    // spam. `supported` was computed from `effectiveSupportsElicitation`
    // above (per the §3.3 v6.6.1 contract); we reuse it here to keep
    // gateOperation's code path free of direct `clientSupportsElicitation`
    // calls.
    if (!supported && !bypassMisconfigWarningFired) {
      bypassMisconfigWarningFired = true;
      console.error(
        `epimethian-mcp: BYPASS_ELICITATION is set, but the connected client ` +
          `does not advertise elicitation support. The intended use of ` +
          `BYPASS_ELICITATION is for clients that falsely advertise the ` +
          `capability and never honour requests. For clients that don't ` +
          `advertise it (e.g. OpenCode), set EPIMETHIAN_ALLOW_UNGATED_WRITES ` +
          `instead, or upgrade to v6.6.0 to benefit from soft elicitation.`,
      );
    }
    console.error(
      `epimethian-mcp: [UNGATED] tool=${context.tool} — bypassing elicitation gate; ` +
        `proceeding because EPIMETHIAN_BYPASS_ELICITATION=true.`,
    );
    return "handled";
  }

  // Row 2: ALLOW_UNGATED_WRITES + unsupported client — operator opt-out.
  if (
    !supported &&
    process.env.EPIMETHIAN_ALLOW_UNGATED_WRITES === "true"
  ) {
    console.error(
      `epimethian-mcp: [UNGATED] tool=${context.tool} — client does not support elicitation; ` +
        `proceeding because EPIMETHIAN_ALLOW_UNGATED_WRITES=true.`,
    );
    return "handled";
  }

  // Row 3: DISABLE_SOFT_CONFIRM + unsupported client — restore v6.5.0
  // fail-closed behaviour for users who don't want the soft-confirmation
  // flow.
  if (
    !supported &&
    process.env.EPIMETHIAN_DISABLE_SOFT_CONFIRM === "true"
  ) {
    throw new GatedOperationError(
      ELICITATION_REQUIRED_BUT_UNAVAILABLE,
      `This tool requires interactive confirmation but your MCP client does not expose ` +
        `elicitation, and EPIMETHIAN_DISABLE_SOFT_CONFIRM is set. Use ` +
        `\`update_page_section\` instead, or switch to a client that supports MCP ` +
        `elicitation (Claude Code ≥ 2.x, Claude Desktop ≥ 0.10).`,
    );
  }

  // Row 4: soft elicitation — client lacks elicitation AND every
  // soft-mode binding field is present. Mint a token, throw a
  // `SoftConfirmationRequiredError` so the index.ts handler can format
  // a structured tool-result for the agent to surface to the user.
  if (
    !supported &&
    context.cloudId !== undefined &&
    context.pageId !== undefined &&
    context.pageVersion !== undefined &&
    context.diffHash !== undefined
  ) {
    // Build the human summary SOLELY from numeric counts. The §3.5
    // invariant prohibits interpolating any other field of
    // `context.details` — those values are tenant-controlled and would
    // otherwise be a prompt-injection exfil channel.
    const deletionSummary = context.details?.deletionSummary;
    let humanSummary: string;
    if (
      deletionSummary !== undefined &&
      typeof deletionSummary === "object" &&
      deletionSummary !== null &&
      !Array.isArray(deletionSummary)
    ) {
      humanSummary = renderDeletionSummary(deletionSummary as DeletionSummary);
    } else {
      // Fall back to the gate's own one-line summary literal. Do NOT
      // pull arbitrary other fields out of `context.details`.
      humanSummary = context.summary;
    }

    // Mint may throw SOFT_CONFIRM_RATE_LIMITED when the 15-min mint
    // budget is exhausted. Let it propagate as a GatedOperationError;
    // the index.ts handler turns it into a tool-result.
    const minted = mintToken({
      tool: context.tool,
      cloudId: context.cloudId,
      pageId: context.pageId,
      pageVersion: context.pageVersion,
      diffHash: context.diffHash,
    });

    const retryHint =
      `Re-call \`${context.tool}\` with the same parameters plus ` +
      `\`confirm_token\` set to the value in structuredContent.confirm_token.`;

    throw new SoftConfirmationRequiredError({
      token: minted.token,
      auditId: minted.auditId,
      expiresAt: minted.expiresAt,
      humanSummary,
      retryHint,
      pageId: context.pageId,
      // The message is consumed by the index.ts catch in §5.5; the
      // structured fields above are the load-bearing payload. Keep the
      // text agent-directed (not user-facing) and free of tenant content.
      message:
        `Soft confirmation required for ${context.tool}: surface the prompt ` +
        `to the user and retry with the confirm_token.`,
    });
  }

  // Row 5: unsupported client AND any required mint input missing —
  // fail-closed legacy throw. We refuse rather than silently bypass.
  if (!supported) {
    throw new GatedOperationError(
      ELICITATION_REQUIRED_BUT_UNAVAILABLE,
      `This tool requires interactive confirmation but your MCP client does not expose ` +
        `elicitation. Use \`update_page_section\` instead, or switch to a client that ` +
        `supports MCP elicitation (Claude Code ≥ 2.x, Claude Desktop ≥ 0.10).`,
    );
  }

  // No row 1–5 fired; caller proceeds to row 6.
  return "fall_through";
}

/**
 * Dispatch an elicitation for a gated operation. Resolves normally on
 * approval; throws `GatedOperationError` on denial, unsupported client
 * (in fail-closed mode), or — in the soft-elicitation path —
 * `SoftConfirmationRequiredError` carrying a freshly-minted
 * confirmation token.
 *
 * Branch precedence is the §3.3 table of the v6.6.1 plan; the first
 * matching row wins.
 */
export async function gateOperation(
  server: McpServer,
  context: GatedOperationContext,
): Promise<void> {
  // Rows 1–5: env-var overrides + unsupported-client paths. If this
  // returns "handled" (or throws), we're done.
  const initial = await evaluateUnsupportedBranch(server, context);
  if (initial === "handled") return;

  // Row 6: client effectively supports elicitation — real
  // `elicitInput()` request, with fast-decline detection wrapping it.

  // Build a concise human-readable message.
  const lines: string[] = [context.summary];
  if (context.details) {
    for (const [k, v] of Object.entries(context.details)) {
      if (v === undefined) continue;
      if (k === "deletionSummary" && typeof v === "object" && v !== null) {
        // Render the structured deletion summary as human-readable text.
        const rendered = renderDeletionSummary(v as DeletionSummary);
        // Preserve the existing "Proceed?" trailer for the live-elicitation
        // path; the soft path uses `humanSummary` as a static description.
        if (rendered !== "This update has no destructive changes.") {
          lines.push(
            `  ${rendered.replace(/\.$/, "")} that the new markdown does not regenerate. Proceed?`,
          );
        }
        continue;
      }
      lines.push(`  • ${k}: ${String(v)}`);
    }
  }
  const message = lines.join("\n");

  let result;
  const startedAt = performance.now();
  try {
    result = await server.server.elicitInput({
      message,
      requestedSchema: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            title: "Confirm this destructive action?",
            description:
              "Set to true to proceed. Any other response aborts the call.",
          },
        },
        required: ["confirm"],
      },
    });
  } catch (err) {
    // The client reported an error mid-elicitation (transport failure,
    // timeout, etc.). Treat as no response — fail-closed.
    throw new GatedOperationError(
      NO_USER_RESPONSE,
      `Elicitation for ${context.tool} failed (${
        err instanceof Error ? err.message : String(err)
      }) — refusing the operation.`,
    );
  }
  const elapsedMs = performance.now() - startedAt;

  // Fast-decline detection (§3.2 of the v6.6.1 plan): if the response
  // came back as a `decline` faster than any human could plausibly
  // hit a button, the client is auto-declining without surfacing UI.
  // Mark the client as "faking" for the rest of the session and re-run
  // the gate selector — `effectiveSupportsElicitation` will now read
  // `false` and the call will route through the soft-confirm path
  // (or row 5's fail-closed throw if the soft fields are missing).
  //
  // Data-loss invariants:
  //   - Only triggers on `decline`, not `cancel`/`accept`/unknown.
  //   - The retry goes through `evaluateUnsupportedBranch` which never
  //     calls `elicitInput` — preventing a second prompt that the user
  //     might actually answer.
  //   - The off-switch env var skips the heuristic entirely; the call
  //     proceeds to the normal action handling below.
  const fastDeclineDisabled =
    process.env[DISABLE_FAST_DECLINE_DETECTION_ENV] === "true";
  if (
    !fastDeclineDisabled &&
    result.action === "decline" &&
    elapsedMs < readFastDeclineThresholdMs()
  ) {
    _markClientAsFakingElicitation(server);
    const retry = await evaluateUnsupportedBranch(server, context);
    // After marking faking, `effectiveSupportsElicitation` returns
    // `false`, so the retry MUST hit row 1 (BYPASS — already false at
    // this point since row 1 didn't fire on the first pass) or rows
    // 2–5. If it ever returned `"fall_through"` we'd have a serious
    // bug — fail closed defensively rather than risk a second prompt.
    if (retry === "fall_through") {
      throw new GatedOperationError(
        NO_USER_RESPONSE,
        `${context.tool} could not be confirmed: fast-decline retry unexpectedly fell through to row 6.`,
      );
    }
    return;
  }

  // "accept" with confirm=true is the only path that proceeds.
  if (result.action === "accept" && result.content?.confirm === true) {
    return;
  }

  if (result.action === "decline") {
    throw new GatedOperationError(
      USER_DECLINED,
      `${context.tool} was not executed — user declined.`,
    );
  }

  if (result.action === "cancel") {
    throw new GatedOperationError(
      USER_CANCELLED,
      `${context.tool} was not executed — user cancelled.`,
    );
  }

  // Unknown action value (or accept with confirm !== true already handled
  // above) — treat as no response.
  throw new GatedOperationError(
    NO_USER_RESPONSE,
    `${context.tool} was not executed — user did not confirm (action=${result.action}).`,
  );
}

// Re-export the rate-limit code so callers (index.ts handler) can match
// it via `err.code === SOFT_CONFIRM_RATE_LIMITED` without depending
// directly on confirmation-tokens.js.
export { SOFT_CONFIRM_RATE_LIMITED };
