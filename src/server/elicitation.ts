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
 * Unsupported-client behaviour:
 *
 *   - Default: refuse the operation with a structured error explaining
 *     the opt-out. Fail-closed so a client that doesn't support
 *     elicitation cannot silently execute the gated action.
 *   - Opt-out: `EPIMETHIAN_ALLOW_UNGATED_WRITES=true` restores
 *     permissive-by-default behaviour (the name is deliberately
 *     unflattering).
 *
 * Spec: see
 * `doc/design/investigations/investigate-prompt-injection-hardening/07-human-in-the-loop.md`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

export class GatedOperationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GatedOperationError";
    this.code = code;
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
}

/**
 * Dispatch an elicitation for a gated operation. Resolves normally on
 * approval; throws `GatedOperationError` on denial or unsupported
 * client (in fail-closed mode). Silently returns when
 * `EPIMETHIAN_ALLOW_UNGATED_WRITES=true` and the client lacks support
 * — the operation proceeds without a gate.
 */
export async function gateOperation(
  server: McpServer,
  context: GatedOperationContext,
): Promise<void> {
  const supported = clientSupportsElicitation(server);

  if (!supported) {
    if (process.env.EPIMETHIAN_ALLOW_UNGATED_WRITES === "true") {
      // Opt-out path: log the bypass for forensics and proceed.
      console.error(
        `epimethian-mcp: [UNGATED] tool=${context.tool} — client does not support elicitation; ` +
          `proceeding because EPIMETHIAN_ALLOW_UNGATED_WRITES=true.`,
      );
      return;
    }
    throw new GatedOperationError(
      ELICITATION_REQUIRED_BUT_UNAVAILABLE,
      `This tool requires interactive confirmation but your MCP client does not expose ` +
        `elicitation. Use \`update_page_section\` instead, or switch to a client that ` +
        `supports MCP elicitation (Claude Code ≥ 2.x, Claude Desktop ≥ 0.10).`,
    );
  }

  // Build a concise human-readable message.
  const lines: string[] = [context.summary];
  if (context.details) {
    for (const [k, v] of Object.entries(context.details)) {
      if (v === undefined) continue;
      if (k === "deletionSummary" && typeof v === "object" && v !== null) {
        // Render the structured deletion summary as human-readable text.
        const s = v as DeletionSummary;
        const parts: string[] = [];
        if (s.tocs > 0) parts.push(`${s.tocs} TOC macro${s.tocs === 1 ? "" : "s"}`);
        if (s.links > 0) parts.push(`${s.links} link macro${s.links === 1 ? "" : "s"}`);
        if (s.codeMacros > 0) parts.push(`${s.codeMacros} code macro${s.codeMacros === 1 ? "" : "s"}`);
        if (s.structuredMacros > 0) parts.push(`${s.structuredMacros} structured macro${s.structuredMacros === 1 ? "" : "s"}`);
        if (s.plainElements > 0) parts.push(`${s.plainElements} plain element${s.plainElements === 1 ? "" : "s"}`);
        if (s.other > 0) parts.push(`${s.other} other element${s.other === 1 ? "" : "s"}`);
        if (parts.length > 0) {
          const list =
            parts.length === 1
              ? parts[0]
              : parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
          lines.push(`  This update will remove ${list} that the new markdown does not regenerate. Proceed?`);
        }
        continue;
      }
      lines.push(`  • ${k}: ${String(v)}`);
    }
  }
  const message = lines.join("\n");

  let result;
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
