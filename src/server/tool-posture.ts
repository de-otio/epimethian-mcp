/**
 * Which tools a posture registers. The server's registration shim
 * (`registerTools` in index.ts) drops every tool in WRITE_TOOLS when the
 * effective posture is read-only, and `setup` prints the same set from
 * `registeredToolsFor`, so the two cannot drift. Pure and static.
 */
import { toolAvailableIn, type ApiMode } from "./api-capabilities.js";
import { KNOWN_TOOLS } from "./tool-allowlist.js";

/**
 * O2: The set of write tools that are only registered when effectivePosture === "read-write".
 * This complements READ_ONLY_TOOLS — the registration-time gate (O2) is the primary
 * enforcement; writeGuard remains a belt-and-suspenders runtime check.
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "authorise_destructive_writes",
  "create_page",
  "update_page",
  "create_blog_post",
  "update_blog_post",
  "append_to_page",
  "prepend_to_page",
  "update_page_section",
  "update_page_sections",
  "delete_page",
  "add_drawio_diagram",
  "update_drawio_diagram",
  "revert_page",
  "add_attachment",
  "add_label",
  "remove_label",
  "create_comment",
  "delete_comment",
  "resolve_comment",
  "set_page_status",
  "remove_page_status",
]);

/**
 * The tools the server registers for an API mode and an effective posture,
 * in KNOWN_TOOLS order, before any per-profile allow/deny list. Posture
 * "detect" has no answer here: the startup probe resolves it to one of these.
 */
export function registeredToolsFor(
  mode: ApiMode | undefined,
  effectivePosture: "read-only" | "read-write"
): readonly string[] {
  return KNOWN_TOOLS.filter(
    (name) => toolAvailableIn(mode, name) && !(effectivePosture === "read-only" && WRITE_TOOLS.has(name))
  );
}
