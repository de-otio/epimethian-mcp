/**
 * Track F2: per-tool registration filter.
 *
 * Resolves the effective tool set for a profile based on
 * `ProfileSettings.allowed_tools` / `denied_tools`. The registration loop
 * in `registerTools()` consults `isToolEnabled()` before each
 * `server.registerTool(...)` call; disallowed tools are never registered
 * and so are never visible to the agent.
 *
 * Validation:
 *   - `allowed_tools` and `denied_tools` are mutually exclusive — one is
 *     an error during startup.
 *   - Unknown tool names (not in KNOWN_TOOLS) are rejected so a typo
 *     like `delete_pages` can't silently accept the call.
 *
 * Spec:
 *   doc/design/investigations/investigate-prompt-injection-hardening/08-capability-scoping.md
 */

import type { ProfileSettings } from "../shared/profiles.js";

/**
 * The complete set of tool names this server can register. Keep in sync
 * with `registerTools()` — a test enforces the invariant so a new tool
 * without an entry here surfaces at CI time.
 */
export const KNOWN_TOOLS = [
  "create_page",
  "get_page",
  "update_page",
  "delete_page",
  "update_page_section",
  "prepend_to_page",
  "append_to_page",
  "search_pages",
  "list_pages",
  "get_page_children",
  "get_spaces",
  "get_page_by_title",
  "add_attachment",
  "add_drawio_diagram",
  "get_attachments",
  "get_labels",
  "add_label",
  "remove_label",
  "get_page_status",
  "set_page_status",
  "remove_page_status",
  "get_comments",
  "create_comment",
  "resolve_comment",
  "delete_comment",
  "get_page_versions",
  "get_page_version",
  "diff_page_versions",
  "revert_page",
  "lookup_user",
  "resolve_page_link",
  "get_version",
  "upgrade",
] as const;

export type KnownTool = (typeof KNOWN_TOOLS)[number];

const KNOWN_TOOL_SET = new Set<string>(KNOWN_TOOLS);

/**
 * Thrown during startup when a profile's tool allowlist / denylist is
 * misconfigured. Bubbles up through `registerTools()` and aborts the
 * MCP server; the user must fix their registry before the server will
 * start.
 */
export class InvalidToolAllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidToolAllowlistError";
  }
}

/**
 * Validate the profile's allow/deny lists and return a resolver that
 * answers "is this tool enabled?". Called once at server startup.
 *
 * Throws `InvalidToolAllowlistError` when:
 *   - both allowed_tools and denied_tools are set,
 *   - any listed tool name is not in KNOWN_TOOLS.
 */
export function resolveToolFilter(
  settings: ProfileSettings | undefined,
): (tool: string) => boolean {
  if (!settings) return () => true;
  const { allowed_tools, denied_tools } = settings;
  if (allowed_tools !== undefined && denied_tools !== undefined) {
    throw new InvalidToolAllowlistError(
      "Profile settings cannot set both `allowed_tools` and `denied_tools`. " +
        "Pick one — `allowed_tools` for a whitelist, `denied_tools` for a blacklist.",
    );
  }

  if (allowed_tools !== undefined) {
    const unknown = allowed_tools.filter((t) => !KNOWN_TOOL_SET.has(t));
    if (unknown.length > 0) {
      throw new InvalidToolAllowlistError(
        `allowed_tools contains unknown tool name(s): ${unknown.join(", ")}. ` +
          `Valid names: ${KNOWN_TOOLS.join(", ")}.`,
      );
    }
    const allowed = new Set(allowed_tools);
    return (tool) => allowed.has(tool);
  }

  if (denied_tools !== undefined) {
    const unknown = denied_tools.filter((t) => !KNOWN_TOOL_SET.has(t));
    if (unknown.length > 0) {
      throw new InvalidToolAllowlistError(
        `denied_tools contains unknown tool name(s): ${unknown.join(", ")}. ` +
          `Valid names: ${KNOWN_TOOLS.join(", ")}.`,
      );
    }
    const denied = new Set(denied_tools);
    return (tool) => !denied.has(tool);
  }

  return () => true;
}
