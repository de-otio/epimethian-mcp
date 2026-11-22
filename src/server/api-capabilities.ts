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
