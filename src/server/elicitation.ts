/**
 * Track E4: human-in-the-loop elicitation for gated write operations.
 *
 * Calls `server.server.elicitInput()` to surface a "confirm?" prompt to
 * the user before executing a gated tool call. The MCP elicitation
 * feature (2025-06-18 spec) returns one of three actions:
 *
 *   - "accept"  — user approved; proceed with the call.
 *   - "decline" — user rejected; abort with `USER_DENIED_GATED_OPERATION`.
 *   - "cancel"  — same outcome as decline (treated as user said no).
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

/** Error code thrown when the elicited user denies a gated operation. */
export const USER_DENIED_GATED_OPERATION = "USER_DENIED_GATED_OPERATION";
/** Error code thrown when elicitation is needed but unsupported and no opt-out. */
export const ELICITATION_UNSUPPORTED = "ELICITATION_UNSUPPORTED";

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
   */
  details?: Record<string, string | number | boolean | undefined>;
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
      ELICITATION_UNSUPPORTED,
      `This operation (${context.tool}) requires human confirmation via MCP elicitation, ` +
        `but the connected client did not advertise elicitation support in the initialize ` +
        `handshake. Set EPIMETHIAN_ALLOW_UNGATED_WRITES=true to restore permissive ` +
        `behaviour (not recommended), or connect from a client that supports elicitation.`,
    );
  }

  // Build a concise human-readable message.
  const lines: string[] = [context.summary];
  if (context.details) {
    for (const [k, v] of Object.entries(context.details)) {
      if (v === undefined) continue;
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
    // The client reported an error mid-elicitation. Treat as denial:
    // when in doubt, do not execute the destructive action.
    throw new GatedOperationError(
      USER_DENIED_GATED_OPERATION,
      `Elicitation for ${context.tool} failed (${
        err instanceof Error ? err.message : String(err)
      }) — refusing the operation.`,
    );
  }

  // "accept" with confirm=true is the only path that proceeds.
  if (result.action === "accept" && result.content?.confirm === true) {
    return;
  }

  const why =
    result.action === "decline"
      ? "user declined"
      : result.action === "cancel"
        ? "user cancelled"
        : `user did not confirm (action=${result.action})`;

  throw new GatedOperationError(
    USER_DENIED_GATED_OPERATION,
    `${context.tool} was not executed — ${why}.`,
  );
}
