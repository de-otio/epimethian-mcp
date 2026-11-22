/**
 * Tool metadata helpers (7.0.0 — field-session findings S4, R5, A3).
 *
 * One place that decides what each tool declares to the client: the
 * top-level `title` (emitted by the SDK as `Tool.title`), the ToolAnnotations
 * hints, and `_meta` keys such as `anthropic/requiresUserInteraction`.
 *
 * Every annotation here is a HINT. MCP clients must treat annotations as
 * untrusted, and server-side enforcement (write guard, space allowlist,
 * deletion gate, elicitation) never depends on them. Claude Code uses
 * `readOnlyHint` to decide whether calls may run in parallel, and honours
 * `requiresUserInteraction` by forcing an approval prompt on every call.
 *
 * `openWorldHint` defaults to true in the spec; it is stated explicitly
 * because every tool here talks to an external Confluence tenant.
 */

export const REQUIRES_USER_INTERACTION_META_KEY = "anthropic/requiresUserInteraction";

/**
 * Claude Code loads MCP tools on demand (tool search): at session start the
 * model sees only tool names and the server instructions. `alwaysLoad` puts
 * a tool's full definition in context up front; keep it to the one or two
 * tools nearly every Confluence task starts with.
 */
export const ALWAYS_LOAD_META_KEY = "anthropic/alwaysLoad";

/**
 * Claude Code moves a tool result larger than 50,000 chars to a file and
 * shows the model a preview. A page read at the default `max_length`
 * (50,000) plus its framing crosses that line, so large reads raise it.
 * Claude Code accepts up to 500,000.
 */
export const MAX_RESULT_SIZE_META_KEY = "anthropic/maxResultSizeChars";

/** Result-size ceiling for the large page-body reads (see above). */
export const LARGE_READ_RESULT_CHARS = 200_000;

export interface ToolMeta {
  readonly title: string;
  readonly annotations: {
    readonly title: string;
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: true;
  };
  readonly _meta?: Readonly<Record<string, unknown>>;
}

interface ExtraMeta {
  readonly requiresUserInteraction?: boolean;
  readonly alwaysLoad?: boolean;
  readonly maxResultSizeChars?: number;
}

function build(
  title: string,
  hints: { readOnly: boolean; destructive: boolean; idempotent: boolean },
  extra: ExtraMeta = {},
): ToolMeta {
  if (title.trim().length === 0) {
    throw new Error("tool-meta: title must be non-empty");
  }
  const annotations = {
    title,
    readOnlyHint: hints.readOnly,
    destructiveHint: hints.destructive,
    idempotentHint: hints.idempotent,
    openWorldHint: true,
  } as const;
  const meta: Record<string, unknown> = {};
  if (extra.requiresUserInteraction) meta[REQUIRES_USER_INTERACTION_META_KEY] = true;
  if (extra.alwaysLoad) meta[ALWAYS_LOAD_META_KEY] = true;
  if (extra.maxResultSizeChars !== undefined) {
    const n = extra.maxResultSizeChars;
    if (!Number.isInteger(n) || n <= 50_000 || n > 500_000) {
      throw new Error("tool-meta: maxResultSizeChars must be an integer in (50000, 500000]");
    }
    meta[MAX_RESULT_SIZE_META_KEY] = n;
  }
  return Object.keys(meta).length > 0 ? { title, annotations, _meta: meta } : { title, annotations };
}

/** A tool that reads only. Safe for clients to run in parallel. */
export function readOnlyTool(
  title: string,
  opts: { alwaysLoad?: boolean; maxResultSizeChars?: number } = {},
): ToolMeta {
  return build(title, { readOnly: true, destructive: false, idempotent: true }, opts);
}

/** A tool that changes state but never removes content. */
export function writeTool(title: string, opts: { idempotent?: boolean } = {}): ToolMeta {
  return build(
    title,
    { readOnly: false, destructive: false, idempotent: opts.idempotent ?? false },
  );
}

/**
 * A tool that can remove or overwrite content. `requiresUserInteraction`
 * asks the client for a human approval prompt on every call; use it for
 * tools that are destructive on every invocation, not for flag-gated writes
 * (those keep the soft-confirmation path, where a static prompt would be
 * too broad).
 */
export function destructiveTool(
  title: string,
  opts: { idempotent?: boolean; requiresUserInteraction?: boolean } = {},
): ToolMeta {
  return build(
    title,
    { readOnly: false, destructive: true, idempotent: opts.idempotent ?? false },
    { requiresUserInteraction: opts.requiresUserInteraction ?? false },
  );
}
