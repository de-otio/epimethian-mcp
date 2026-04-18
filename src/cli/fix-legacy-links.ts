/**
 * D1 — Legacy `<ac:link>` migration CLI.
 *
 * Scans Confluence pages for the broken legacy shape:
 *   <ac:link>
 *     <ri:page ri:content-id="…" [ri:space-key="…"]/>
 *     <ac:plain-text-link-body><![CDATA[link text]]></ac:plain-text-link-body>
 *   </ac:link>
 *
 * and rewrites each occurrence to a plain `<a href="…">text</a>` anchor, which
 * renders correctly on all modern Confluence Cloud instances.
 *
 * Safety hard-rules (written into the code, not relying on operator discipline):
 *   - Dry-run is the default; `--apply` is required to mutate.
 *   - Either `--page-ids` or `--space-key` is required (never "everything").
 *   - `--client-label` is required (mutation log must be attributable).
 *   - If more than one distinct Confluence host is configured, the CLI refuses
 *     to run unless `--i-understand-multi-tenant` is passed.
 *   - Per-page failures are accumulated; the CLI exits 2 if any page failed.
 *
 * Write path uses safePrepareBody + safeSubmitPage exclusively — never the raw
 * HTTP wrappers directly.
 */

import {
  getConfig,
  getPage,
  listPages,
  resolveSpaceId,
  type PageData,
} from "../server/confluence-client.js";
import {
  safePrepareBody,
  safeSubmitPage,
} from "../server/safe-write.js";
import { readProfileRegistry } from "../shared/profiles.js";
import { readFromKeychain } from "../shared/keychain.js";

// ---------------------------------------------------------------------------
// Regex — detects the broken legacy <ac:link> shape.
//
// We match ONLY the shape that has BOTH:
//   <ri:page ri:content-id="…"> (not ri:user — leave user-mentions alone)
//   <ac:plain-text-link-body>   (not ac:link-body — leave modern shape alone)
//
// The flags:
//   s (dotAll) — body may span multiple lines.
//   g — replace all occurrences per page.
// ---------------------------------------------------------------------------

const LEGACY_LINK_RE =
  /<ac:link>\s*<ri:page\s+([^>]*?)\/>\s*<ac:plain-text-link-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-link-body>\s*<\/ac:link>/gs;

/**
 * Extract the value of a named XML attribute from a tag string.
 * Returns undefined when the attribute is absent.
 */
function extractAttr(tagAttrs: string, name: string): string | undefined {
  const m = tagAttrs.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : undefined;
}

/**
 * Build the replacement `<a href>` anchor URL.
 *
 *   - With ri:space-key present:
 *       ${base}/wiki/spaces/${spaceKey}/pages/${contentId}
 *   - Without ri:space-key (same-space link):
 *       ${base}/wiki/pages/viewpage.action?pageId=${contentId}
 */
function buildUrl(
  baseUrl: string,
  contentId: string,
  spaceKey: string | undefined,
): string {
  if (spaceKey) {
    return `${baseUrl}/wiki/spaces/${spaceKey}/pages/${contentId}`;
  }
  return `${baseUrl}/wiki/pages/viewpage.action?pageId=${contentId}`;
}

/**
 * Count legacy link occurrences in a storage body without mutating.
 */
export function countLegacyLinks(storage: string): number {
  const matches = storage.match(LEGACY_LINK_RE);
  return matches ? matches.length : 0;
}

/**
 * Rewrite all legacy `<ac:link>` occurrences to plain `<a href>` anchors.
 * Returns the rewritten body and the count of replacements made.
 *
 * @param storage Confluence storage-format body.
 * @param baseUrl Confluence base URL (e.g. https://site.atlassian.net).
 */
export function rewriteLegacyLinks(
  storage: string,
  baseUrl: string,
): { rewritten: string; count: number } {
  let count = 0;
  const rewritten = storage.replace(LEGACY_LINK_RE, (_match, attrs, text) => {
    const contentId = extractAttr(attrs, "ri:content-id");
    if (!contentId) return _match; // missing content-id — leave untouched
    const spaceKey = extractAttr(attrs, "ri:space-key");
    const url = buildUrl(baseUrl, contentId, spaceKey);
    count++;
    return `<a href="${url}">${text}</a>`;
  });
  return { rewritten, count };
}

// ---------------------------------------------------------------------------
// Multi-tenant detection
// ---------------------------------------------------------------------------

/**
 * Collect the set of distinct Confluence host names across all configured
 * profiles (including env-var mode). Returns:
 *   - A set of hostname strings.
 *   - `hasUnreadableProfile: true` if at least one profile's keychain entry
 *     could not be read — treated as an unknown distinct host (safe default).
 */
export async function detectTenantHosts(): Promise<{
  hosts: Set<string>;
  hasUnreadableProfile: boolean;
}> {
  const hosts = new Set<string>();
  let hasUnreadableProfile = false;

  // Env-var mode: check CONFLUENCE_URL.
  const urlEnv = process.env.CONFLUENCE_URL;
  if (urlEnv) {
    try {
      hosts.add(new URL(urlEnv).hostname);
    } catch {
      // Malformed env-var URL — ignore (getConfig will reject it anyway).
    }
  }

  // Profile registry: read each profile's keychain entry.
  let profiles: string[];
  try {
    profiles = await readProfileRegistry();
  } catch {
    profiles = [];
    hasUnreadableProfile = true;
  }

  for (const profile of profiles) {
    try {
      const creds = await readFromKeychain(profile);
      if (creds?.url) {
        hosts.add(new URL(creds.url).hostname);
      } else {
        // Profile exists in registry but no keychain entry.
        hasUnreadableProfile = true;
      }
    } catch {
      hasUnreadableProfile = true;
    }
  }

  return { hosts, hasUnreadableProfile };
}

/**
 * Returns true when the environment looks multi-tenant.
 * Defined as: more than one distinct host across all configured profiles + env vars,
 * OR at least one unreadable profile (unknown → conservative).
 */
export async function isMultiTenant(): Promise<boolean> {
  const { hosts, hasUnreadableProfile } = await detectTenantHosts();
  return hasUnreadableProfile || hosts.size > 1;
}

// ---------------------------------------------------------------------------
// Per-page processing
// ---------------------------------------------------------------------------

interface PageResult {
  pageId: string;
  title: string;
  legacyCount: number;
  /** Populated when apply=true and the write succeeded. */
  newVersion?: number;
  /** Populated when the page had no legacy links to fix. */
  skipped?: boolean;
  /** Populated on error. */
  error?: string;
}

/**
 * Process a single page: detect, optionally rewrite, and report.
 */
async function processPage(
  page: PageData,
  baseUrl: string,
  clientLabel: string,
  apply: boolean,
): Promise<PageResult> {
  const pageId = page.id;
  const title = page.title;

  const originalStorage: string =
    page.body?.storage?.value ?? page.body?.value ?? "";

  const legacyCount = countLegacyLinks(originalStorage);

  if (legacyCount === 0) {
    return { pageId, title, legacyCount: 0, skipped: true };
  }

  if (!apply) {
    // Dry-run: just report the count.
    return { pageId, title, legacyCount };
  }

  // Apply mode: rewrite and submit via the pipeline.
  try {
    const { rewritten } = rewriteLegacyLinks(originalStorage, baseUrl);
    const version = page.version?.number;
    if (version === undefined) {
      throw new Error(`Page ${pageId} has no version number — cannot update.`);
    }

    const prepared = await safePrepareBody({
      body: rewritten,
      currentBody: originalStorage,
      scope: "full",
      replaceBody: false,
      confluenceBaseUrl: baseUrl,
      // The rewrite only converts existing ac:link shapes to <a> tags. We
      // expect the rewritten body to be comparable in length to the original;
      // shrinkage shouldn't fire in practice, but if markup overhead was heavy
      // and the anchors are shorter, we want the guard to catch real shrinkage.
    });

    const result = await safeSubmitPage({
      pageId,
      title,
      finalStorage: prepared.finalStorage!,
      previousBody: originalStorage,
      version,
      versionMessage: `Fix legacy <ac:link> shape (D1 migration, ${clientLabel})`,
      deletedTokens: prepared.deletedTokens,
      clientLabel,
      operation: "update_page",
    });

    return { pageId, title, legacyCount, newVersion: result.newVersion };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { pageId, title, legacyCount, error: message };
  }
}

// ---------------------------------------------------------------------------
// Page collection
// ---------------------------------------------------------------------------

async function collectPagesByIds(
  pageIds: string[],
): Promise<PageData[]> {
  const pages: PageData[] = [];
  for (const id of pageIds) {
    const page = await getPage(id, true);
    pages.push(page);
  }
  return pages;
}

async function collectPagesBySpaceKey(
  spaceKey: string,
  limit: number,
): Promise<PageData[]> {
  const spaceId = await resolveSpaceId(spaceKey);
  // listPages returns pages without bodies; we need bodies to scan.
  const pageList = await listPages(spaceId, limit, "current");
  const pages: PageData[] = [];
  for (const p of pageList) {
    const full = await getPage(p.id, true);
    pages.push(full);
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Argument parsing helpers
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  pageIds: string[] | undefined;
  spaceKey: string | undefined;
  clientLabel: string | undefined;
  apply: boolean;
  limit: number;
  multiTenantAck: boolean;
  help: boolean;
} {
  const args = argv;
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx > -1 ? args[idx + 1] : undefined;
  };
  const has = (flag: string): boolean => args.includes(flag);

  const pageIdsRaw = get("--page-ids");
  const pageIds = pageIdsRaw
    ? pageIdsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  return {
    pageIds,
    spaceKey: get("--space-key"),
    clientLabel: get("--client-label"),
    apply: has("--apply"),
    limit: parseInt(get("--limit") ?? "250", 10),
    multiTenantAck: has("--i-understand-multi-tenant"),
    help: has("--help") || has("-h"),
  };
}

const USAGE = `
Usage: epimethian-mcp fix-legacy-links [options]

  Scans Confluence pages for the legacy <ac:link> shape that renders with empty
  anchor text on modern Confluence Cloud, and rewrites them to plain <a href>.

Required (mutually exclusive):
  --page-ids <csv>     Comma-separated list of page IDs to process.
  --space-key <key>    Process all pages in a space (by space key).

Required:
  --client-label <s>   Attribution label for the mutation log (e.g. "my-script").

Safety (default is dry-run — no pages are modified):
  --apply              Actually write the changes. Without this flag, the tool
                       only reports what it would change.

Multi-tenant:
  --i-understand-multi-tenant
                       Required when more than one Confluence host is configured.
                       Confirms you've verified you are targeting the correct tenant.

Informational:
  --limit <n>          Max pages to fetch when using --space-key (default: 250).
  --help               Show this help.
`.trimStart();

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runFixLegacyLinks(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);

  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }

  // --- Required flags ---
  if (!opts.clientLabel) {
    console.error(
      "Error: --client-label is required. Provide an attribution label for the mutation log.\n" +
        "  Example: --client-label \"my-script\"\n\n" +
        USAGE,
    );
    process.exit(1);
  }

  if (!opts.pageIds && !opts.spaceKey) {
    console.error(
      "Error: Either --page-ids or --space-key is required.\n\n" + USAGE,
    );
    process.exit(1);
  }

  if (opts.pageIds && opts.spaceKey) {
    console.error(
      "Error: --page-ids and --space-key are mutually exclusive. Use one or the other.\n\n" +
        USAGE,
    );
    process.exit(1);
  }

  // --- Multi-tenant safety check ---
  const multiTenant = await isMultiTenant();
  if (multiTenant && !opts.multiTenantAck) {
    console.error(
      "MULTI-TENANT CONFIG DETECTED\n\n" +
        "More than one Confluence host is configured (or a profile could not be read).\n" +
        "Running this migration against the wrong tenant can cause serious data loss.\n\n" +
        "Verify that your active credentials (CONFLUENCE_PROFILE or env vars) target\n" +
        "the correct Confluence instance, then re-run with:\n\n" +
        "  --i-understand-multi-tenant\n",
    );
    process.exit(1);
  }

  // --- Resolve runtime config (base URL) ---
  const config = await getConfig();
  const baseUrl = config.url;

  const clientLabel = opts.clientLabel;
  const apply = opts.apply;
  const limit = isNaN(opts.limit) || opts.limit < 1 ? 250 : opts.limit;

  if (!apply) {
    console.log(
      `[fix-legacy-links] DRY RUN — no pages will be modified. Pass --apply to write changes.\n`,
    );
  }

  // --- Collect pages ---
  let pages: PageData[];
  try {
    if (opts.pageIds) {
      console.log(
        `[fix-legacy-links] Scanning ${opts.pageIds.length} page(s) by ID…`,
      );
      pages = await collectPagesByIds(opts.pageIds);
    } else {
      console.log(
        `[fix-legacy-links] Scanning space "${opts.spaceKey}" (limit ${limit})…`,
      );
      pages = await collectPagesBySpaceKey(opts.spaceKey!, limit);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error collecting pages: ${message}`);
    process.exit(1);
  }

  console.log(`[fix-legacy-links] ${pages.length} page(s) to inspect.\n`);

  // --- Process pages ---
  const results: PageResult[] = [];
  for (const page of pages) {
    const result = await processPage(page, baseUrl, clientLabel, apply);
    results.push(result);
  }

  // --- Summary report ---
  const skipped = results.filter((r) => r.skipped);
  const affected = results.filter((r) => !r.skipped);
  const errored = results.filter((r) => r.error);
  const updated = results.filter((r) => r.newVersion !== undefined);

  console.log("── fix-legacy-links summary ──────────────────────────────────");
  console.log(
    `  Pages scanned  : ${results.length}`,
  );
  console.log(
    `  No legacy links: ${skipped.length}`,
  );
  console.log(
    `  Have legacy links: ${affected.length}`,
  );

  if (apply) {
    console.log(`  Updated        : ${updated.length}`);
    console.log(`  Errors         : ${errored.length}`);
  } else {
    console.log(
      `  Would update   : ${affected.length} (run with --apply to write)`,
    );
  }
  console.log("──────────────────────────────────────────────────────────────");

  // Dry-run diff preview: first 3 affected pages.
  if (!apply && affected.length > 0) {
    console.log("\nDry-run preview (first 3 affected pages):");
    const preview = affected.slice(0, 3);
    for (const r of preview) {
      console.log(
        `  [${r.pageId}] "${r.title}" — ${r.legacyCount} legacy link(s) to fix`,
      );
    }
    if (affected.length > 3) {
      console.log(`  … and ${affected.length - 3} more.`);
    }
  }

  // Apply mode: print results.
  if (apply) {
    for (const r of updated) {
      console.log(
        `  [OK ] [${r.pageId}] "${r.title}" — ${r.legacyCount} link(s) fixed → v${r.newVersion}`,
      );
    }
    for (const r of errored) {
      console.error(
        `  [ERR] [${r.pageId}] "${r.title}" — ${r.error}`,
      );
    }
  }

  // Exit 2 if any page failed.
  if (errored.length > 0) {
    process.exit(2);
  }
}
