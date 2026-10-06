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

function build(
  title: string,
  hints: { readOnly: boolean; destructive: boolean; idempotent: boolean },
  requiresUserInteraction: boolean,
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
  return requiresUserInteraction
    ? { title, annotations, _meta: { [REQUIRES_USER_INTERACTION_META_KEY]: true } }
    : { title, annotations };
}

/** A tool that reads only. Safe for clients to run in parallel. */
export function readOnlyTool(title: string): ToolMeta {
  return build(title, { readOnly: true, destructive: false, idempotent: true }, false);
}

/** A tool that changes state but never removes content. */
export function writeTool(title: string, opts: { idempotent?: boolean } = {}): ToolMeta {
  return build(
    title,
    { readOnly: false, destructive: false, idempotent: opts.idempotent ?? false },
    false,
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
    opts.requiresUserInteraction ?? false,
  );
}
