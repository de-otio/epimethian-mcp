/**
 * `epimethian-mcp upgrade` subcommand.
 *
 * Manually trigger a version check + integrity-verified install. This is the
 * user-facing path for the new check-and-notify trust model (Track A of
 * `plans/security-audit-fixes.md`). The server never installs silently; users
 * run this command when they see the "update available" banner or
 * `get_version` advisory.
 */

import {
  checkLatestNow,
  clearPendingUpdate,
  getPendingUpdate,
  performUpgrade,
  verifyNpmProvenance,
} from "../shared/update-check.js";

declare const __PKG_VERSION__: string;

export interface UpgradeResult {
  status:
    | "up-to-date"
    | "installed"
    | "integrity-failed"
    | "install-failed"
    | "check-failed"
    | "no-target";
  installed?: string;
  message: string;
}

/**
 * Run the upgrade flow. Returns a structured result so tests can assert on
 * status without scraping console output. Also logs human-readable progress.
 */
export async function runUpgrade(): Promise<UpgradeResult> {
  const currentVersion = __PKG_VERSION__;
  console.log(`epimethian-mcp upgrade: current version v${currentVersion}`);

  // A manual upgrade always asks the registry: the throttle that keeps the
  // server's startup check quiet must not hide a release published today.
  console.log("Checking npm registry for a newer version…");
  const check = await checkLatestNow(currentVersion);
  let pending;
  if (check.status === "available") {
    pending = check.info;
  } else if (check.status === "up-to-date") {
    console.log(`Already on the latest version (v${check.latest} on npm).`);
    return {
      status: "up-to-date",
      message: `Already on v${currentVersion}.`,
    };
  } else {
    // Unreachable: never report that as "up to date". A pending record from
    // an earlier check for this version is still a usable target.
    pending = await getPendingUpdate(currentVersion);
    if (!pending) {
      console.error(
        `Could not check for updates: ${check.reason}. Whether a newer version exists is unknown; try again later.`
      );
      return {
        status: "check-failed",
        message: check.reason,
      };
    }
    console.log(`Could not reach the registry (${check.reason}); using the update recorded by an earlier check.`);
  }

  console.log(
    `Update available: v${pending.current} → v${pending.latest} (${pending.type} release)`
  );

  console.log("Verifying npm provenance attestation…");
  const integrity = await verifyNpmProvenance(pending.latest);
  if (!integrity.ok) {
    console.error(`Integrity check failed: ${integrity.message}`);
    console.error(
      "Refusing to install. The pending-update record is preserved so the banner keeps nagging."
    );
    return {
      status: "integrity-failed",
      message: integrity.message,
    };
  }
  console.log("Provenance verified.");

  console.log(`Installing v${pending.latest}…`);
  try {
    const output = await performUpgrade(pending.latest);
    if (output) console.log(output);
    await clearPendingUpdate();
    console.log(
      `Installed v${pending.latest}. Restart the MCP server (or reload your IDE) for the new version to take effect.`
    );
    return {
      status: "installed",
      installed: pending.latest,
      message: `Installed v${pending.latest}.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Install failed: ${message}`);
    return {
      status: "install-failed",
      message,
    };
  }
}
