/**
 * Contract C2 (plans/next-release-sdk2-and-v2-api.md §4): which Confluence
 * features each API mode can serve.
 *
 * Pure and static. The table is never probed at runtime, so `tools/list` is
 * deterministic for a given profile. Gateway-mode rows the plan marks "to be
 * confirmed by W-INV" are `false` until W-INV's live results say otherwise
 * (plan §11, "W-INV live runs": conservative defaults apply).
 */

export type ApiMode = "site" | "gateway";

/**
 * Every feature with a mode-dependent answer. Each name maps to one row of the
 * gateway capability table in plan §5.3 (row number in the comment).
 */
export const FEATURES = [
  "content.read", // row 1: page/blog read, children
  "content.write", // row 1: page/blog create, update, delete
  "content.comments", // row 1: comments read and write
  "versions.read", // row 2: versions list, historical body
  "labels.read", // row 2
  "attachments.read", // row 2: attachments list and metadata
  "attachments.upload", // row 3: add_attachment, draw.io tools
  "attachments.download", // row 4: gateway download path per W-INV
  "labels.write", // row 5: add_label, remove_label
  "attribution.label", // row 5: epimethian-edited label (skipped in gateway mode)
  "contentState", // row 6: get/set/remove_page_status
  "unverifiedBadge", // row 6: AI-edited badge (skipped in gateway mode)
  "search.cql", // row 7: search_pages, resolve_page_link (v1 /search) per W-INV
  "recentChanges", // row 7: get_recent_changes per W-INV
  "pageByTitle", // row 8: get_page_by_title (v2)
  "users.byName", // row 9: lookup_user by name (v1 /search/user)
  "users.byId", // row 9: users-bulk
  "writeProbe.spacePermissions", // row 10: v2 permitted operations per W-INV
  "writeProbe.dryRun", // row 10: dry-run PUT (v2)
  "badgeLocale.site", // row 11: site default locale (v1 systemInfo)
] as const;

export type Feature = (typeof FEATURES)[number];

/** Gateway-mode availability. Site mode has every feature. */
const GATEWAY: Readonly<Record<Feature, boolean>> = Object.freeze({
  "content.read": true,
  "content.write": true,
  "content.comments": true,
  "versions.read": true,
  "labels.read": true,
  "attachments.read": true,
  "attachments.upload": false,
  "attachments.download": false,
  "labels.write": false,
  "attribution.label": false,
  contentState: false,
  unverifiedBadge: false,
  "search.cql": false,
  recentChanges: false,
  pageByTitle: true,
  "users.byName": false,
  "users.byId": true,
  "writeProbe.spacePermissions": false,
  "writeProbe.dryRun": true,
  "badgeLocale.site": false,
});

const SITE: Readonly<Record<Feature, boolean>> = Object.freeze(
  Object.fromEntries(FEATURES.map((f) => [f, true])) as Record<Feature, boolean>
);

export function capabilitiesFor(mode: ApiMode): Readonly<Record<Feature, boolean>> {
  return mode === "gateway" ? GATEWAY : SITE;
}

/**
 * The features each tool's core call needs (plan §5.3 item 5). A tool is
 * available in a mode iff every feature listed is available there. An empty
 * list means the tool needs no Confluence API feature (it works in every mode).
 *
 * Insertion order is the order the unavailable list is printed in the server
 * instructions, so it is part of the deterministic `tools/list` surface.
 * `gateway-mode.test.ts` pins that the keys equal `KNOWN_TOOLS`, so a new tool
 * cannot reach gateway mode without a deliberate entry here.
 *
 * A tool that writes in two steps over two APIs (add_drawio_diagram uploads
 * over v1, then edits the page over v2) lists the feature of EVERY step: if
 * any step is unavailable the tool is not registered, so no half-completed
 * state can arise.
 */
export const TOOL_FEATURES: Readonly<Record<string, readonly Feature[]>> = Object.freeze({
  create_page: ["content.write"],
  get_page: ["content.read"],
  authorise_destructive_writes: [],
  update_page: ["content.write"],
  create_blog_post: ["content.write"],
  update_blog_post: ["content.write"],
  delete_page: ["content.write"],
  update_page_section: ["content.write"],
  update_page_sections: ["content.write"],
  prepend_to_page: ["content.write"],
  append_to_page: ["content.write"],
  search_pages: ["search.cql"],
  list_pages: ["content.read"],
  get_page_children: ["content.read"],
  get_spaces: ["content.read"],
  check_permissions: [],
  get_page_by_title: ["pageByTitle"],
  add_attachment: ["attachments.upload"],
  add_drawio_diagram: ["attachments.upload", "content.write"],
  update_drawio_diagram: ["attachments.upload", "attachments.read", "content.write"],
  get_attachments: ["attachments.read"],
  download_attachment: ["attachments.read", "attachments.download"],
  get_labels: ["labels.read"],
  add_label: ["labels.write"],
  remove_label: ["labels.write"],
  get_page_status: ["contentState"],
  set_page_status: ["contentState"],
  remove_page_status: ["contentState"],
  get_comments: ["content.comments"],
  create_comment: ["content.comments"],
  resolve_comment: ["content.comments"],
  delete_comment: ["content.comments"],
  get_page_versions: ["versions.read"],
  get_page_version: ["versions.read"],
  diff_page_versions: ["versions.read"],
  get_recent_changes: ["recentChanges", "search.cql"],
  revert_page: ["versions.read", "content.write"],
  lookup_user: ["users.byName"],
  resolve_page_link: ["search.cql"],
  get_version: [],
  upgrade: [],
});

/**
 * True when the tool can work in `mode`. Unknown names are treated as
 * available in site mode and unavailable in gateway mode (fail closed: an
 * unmapped tool is never advertised to a gateway profile).
 */
export function toolAvailableIn(mode: ApiMode | undefined, toolName: string): boolean {
  if (mode !== "gateway") return true;
  const needs = TOOL_FEATURES[toolName];
  if (needs === undefined) return false;
  const caps = capabilitiesFor("gateway");
  return needs.every((f) => caps[f]);
}

/** Tools `mode` cannot serve, in table order. Empty in site mode. */
export function unavailableToolsFor(mode: ApiMode | undefined): readonly string[] {
  if (mode !== "gateway") return [];
  return Object.keys(TOOL_FEATURES).filter((name) => !toolAvailableIn(mode, name));
}
