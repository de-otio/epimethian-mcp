/**
 * Auto-update trust model (Track A, `plans/security-audit-fixes.md`)
 * ------------------------------------------------------------------
 *
 * The previous behaviour — silent `npm install -g` for any patch release —
 * turns a compromise of the npm publisher account or a registry MITM into
 * remote code execution on every user's machine within 24 hours. The audit
 * flagged this as Critical. The revised model has three tiers:
 *
 * 1. DEFAULT: check-and-notify only.
 *    - Never auto-install, regardless of patch / minor / major.
 *    - A background check (throttled to once per day) records a pending
 *      update in the state file.
 *    - The stderr startup banner and the `get_version` MCP tool surface the
 *      "update available" signal to the user / agent.
 *    - The user upgrades explicitly with `epimethian-mcp upgrade`.
 *
 * 2. OPT-IN: `EPIMETHIAN_AUTO_UPGRADE=patches`.
 *    - Restores automatic installation, but ONLY for patch releases.
 *    - Requires the user to have read the supply-chain warning and to
 *      explicitly accept the trust model. Startup logs a loud warning
 *      ("auto-upgrade enabled — treat the npm publisher as trusted").
 *    - Minor / major upgrades remain manual even with the opt-in flag.
 *
 * 3. INTEGRITY CHECK: runs before every install, manual or opt-in.
 *    - Primary mechanism: `npm audit signatures` on the resolved
 *      `@de-otio/epimethian-mcp@<version>` tuple. This validates npm
 *      provenance attestations against Sigstore's transparency log, which
 *      proves the tarball was produced by the declared GitHub Actions
 *      workflow — defending against both publisher-credential compromise
 *      and registry tampering.
 *    - Secondary (belt-and-braces): compare the tarball SHA-512 we actually
 *      download against the `dist.integrity` value the registry advertised
 *      at check time. This is weaker than provenance (a compromised
 *      registry can advertise a malicious integrity), but catches
 *      in-flight tampering and guards against `npm audit signatures`
 *      false-negatives on older npm clients.
 *    - Recommendation: require provenance (fail closed if the package was
 *      published without `--provenance` or if verification fails).
 *      SHA-512 is a cheap additional check, not a substitute.
 *    - Fail closed on mismatch: do NOT install, surface the error to the
 *      user, leave the pending-update record intact so `get_version`
 *      keeps nagging.
 *
 * A1 = this design note. A2 = implementation. A3 = changelog + docs.
 * See `plans/security-audit-fixes.md` Track A for the full plan.
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { safeOpenRead } from "./safe-fs.js";

const execFileAsync = promisify(execFile);

const CONFIG_DIR = join(homedir(), ".config", "epimethian-mcp");
const UPDATE_CHECK_FILE = join(CONFIG_DIR, "update-check.json");
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const NPM_REGISTRY_URL =
  "https://registry.npmjs.org/@de-otio/epimethian-mcp/latest";
const PACKAGE_NAME = "@de-otio/epimethian-mcp";

interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

export type UpdateType = "patch" | "minor" | "major";

export interface UpdateInfo {
  current: string;
  latest: string;
  type: UpdateType;
  autoInstalled?: boolean;
}

interface UpdateCheckState {
  lastCheck: string; // ISO timestamp
  pendingUpdate?: UpdateInfo;
}

export function parseSemVer(version: string): SemVer | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

export function classifyUpdate(
  current: SemVer,
  latest: SemVer
): UpdateType | null {
  if (latest.major > current.major) return "major";
  if (latest.major === current.major && latest.minor > current.minor)
    return "minor";
  if (
    latest.major === current.major &&
    latest.minor === current.minor &&
    latest.patch > current.patch
  )
    return "patch";
  return null;
}

async function readCheckState(): Promise<UpdateCheckState | null> {
  try {
    // E2: safeOpenRead rejects symlinks and unsafe mode bits. A poisoned
    // pending-update record could suppress the upgrade banner, so we treat
    // reads of this file as security-sensitive even though it carries no
    // code-execution path.
    const raw = await safeOpenRead(UPDATE_CHECK_FILE);
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.lastCheck === "string") {
      return parsed as UpdateCheckState;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeCheckState(state: UpdateCheckState): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const data = JSON.stringify(state, null, 2) + "\n";
  const tmpFile = join(
    CONFIG_DIR,
    `.update-check.${randomBytes(4).toString("hex")}.tmp`
  );
  await writeFile(tmpFile, data, { mode: 0o600 });
  await rename(tmpFile, UPDATE_CHECK_FILE);
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const response = await fetch(NPM_REGISTRY_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { version?: string };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null; // Network error — silently skip
  }
}

/** Return any cached pending update without performing a new check. */
export async function getPendingUpdate(): Promise<UpdateInfo | null> {
  const state = await readCheckState();
  return state?.pendingUpdate ?? null;
}

/** Clear the pending update record (e.g. after a successful upgrade). */
export async function clearPendingUpdate(): Promise<void> {
  const state = await readCheckState();
  if (state) {
    delete state.pendingUpdate;
    await writeCheckState(state);
  }
}

/**
 * Verify npm provenance attestation for the given version.
 *
 * Shells out to `npm audit signatures @de-otio/epimethian-mcp@<version>` via
 * `execFile` (never `exec`, never a shell) and scans stdout for a success
 * signal. Any failure — non-zero exit, missing provenance, parse error,
 * timeout — returns `{ ok: false }`. Fail closed.
 *
 * `npm audit signatures` exits non-zero when verification fails; we also
 * require an explicit success line so a silent/empty pass does not let an
 * unverified package through.
 */
export async function verifyNpmProvenance(
  version: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const spec = `${PACKAGE_NAME}@${version}`;
  try {
    const { stdout, stderr } = await execFileAsync(
      "npm",
      ["audit", "signatures", spec],
      { timeout: 30_000 }
    );
    const output = `${stdout}\n${stderr}`;
    // `npm audit signatures` prints lines like:
    //   "audited 1 package ... verified registry signatures"
    //   "audited 1 package ... verified attestations"
    // We require the attestation line — a plain signature does not prove
    // provenance, it only proves the registry served the tarball.
    const attested = /verified\s+(?:registry\s+)?attestations?/i.test(output);
    if (!attested) {
      return {
        ok: false,
        message:
          "npm audit signatures did not report a verified provenance attestation. " +
          "The package may have been published without `--provenance`, or the " +
          "attestation failed to verify. Refusing to install.",
      };
    }
    return { ok: true };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `npm audit signatures failed: ${message}`,
    };
  }
}

/**
 * Run `npm install -g` to upgrade to the given version.
 *
 * Verifies npm provenance first (fail closed). On integrity-check failure we
 * throw; callers are responsible for preserving any pending-update record so
 * `get_version` keeps surfacing the pending upgrade to the user.
 */
export async function performUpgrade(version: string): Promise<string> {
  const integrity = await verifyNpmProvenance(version);
  if (!integrity.ok) {
    throw new Error(
      `Integrity check failed for ${PACKAGE_NAME}@${version}: ${integrity.message}`
    );
  }
  const { stdout, stderr } = await execFileAsync(
    "npm",
    ["install", "-g", `${PACKAGE_NAME}@${version}`],
    { timeout: 120_000 }
  );
  return (stdout + stderr).trim();
}

/** True if the user has explicitly opted in to patch auto-upgrade. */
function autoUpgradePatchesEnabled(): boolean {
  return process.env.EPIMETHIAN_AUTO_UPGRADE === "patches";
}

/**
 * Log the loud startup warning for `EPIMETHIAN_AUTO_UPGRADE=patches`.
 *
 * Called once per server start (from `checkForUpdates`) so users see the
 * supply-chain acknowledgement every time the opt-in is active. Kept here
 * (not at the call site) so tests can silence it.
 */
function logAutoUpgradeWarning(): void {
  console.error(
    "[epimethian-mcp] EPIMETHIAN_AUTO_UPGRADE=patches is active. " +
      "Patch releases will be installed automatically if `npm audit signatures` " +
      "verifies their provenance attestation. You are trusting the npm publisher " +
      "and the registry. Unset this variable to restore the default " +
      "check-and-notify behaviour."
  );
}

/**
 * Check for updates (max once per day).
 *
 * Default: check-and-notify only. A pending-update record is written so the
 * startup banner and `get_version` tool can surface the signal; the user
 * installs with `epimethian-mcp upgrade`.
 *
 * Opt-in (`EPIMETHIAN_AUTO_UPGRADE=patches`): restores automatic installation
 * for patch releases ONLY, and only after `verifyNpmProvenance` passes.
 * Minor / major releases are always pending regardless of the opt-in.
 *
 * On integrity-check failure we leave the pending-update record intact so
 * `get_version` keeps nagging the user.
 *
 * Returns UpdateInfo when an update exists, or null when up-to-date. Never
 * throws — network and install errors are logged to stderr and swallowed.
 */
export async function checkForUpdates(
  currentVersion: string
): Promise<UpdateInfo | null> {
  // Honour opt-out for CI / non-interactive environments
  if (process.env.EPIMETHIAN_NO_UPDATE_CHECK === "true") return null;

  const autoPatches = autoUpgradePatchesEnabled();
  if (autoPatches) {
    logAutoUpgradeWarning();
  }

  try {
    // Throttle: skip if last check was less than 24 h ago
    const state = await readCheckState();
    if (state?.lastCheck) {
      const elapsed = Date.now() - new Date(state.lastCheck).getTime();
      if (elapsed < ONE_DAY_MS) {
        return state.pendingUpdate ?? null;
      }
    }

    const latestStr = await fetchLatestVersion();
    if (!latestStr) {
      // Network error — return whatever we had cached
      return state?.pendingUpdate ?? null;
    }

    const current = parseSemVer(currentVersion);
    const latest = parseSemVer(latestStr);
    if (!current || !latest) return null;

    const type = classifyUpdate(current, latest);
    const newState: UpdateCheckState = {
      lastCheck: new Date().toISOString(),
    };

    if (!type) {
      // Already on latest (or ahead) — clear any stale pending update
      await writeCheckState(newState);
      return null;
    }

    const info: UpdateInfo = {
      current: currentVersion,
      latest: latestStr,
      type,
    };

    // Record the pending update first, so an integrity failure or install
    // failure below leaves the nagging signal in place.
    newState.pendingUpdate = info;
    await writeCheckState(newState);

    if (type === "patch" && autoPatches) {
      try {
        // performUpgrade itself runs verifyNpmProvenance and throws on failure.
        await performUpgrade(latestStr);
        info.autoInstalled = true;
        newState.pendingUpdate = info;
        await writeCheckState(newState);
        console.error(
          `[epimethian-mcp] Bugfix v${latestStr} installed automatically (provenance verified). ` +
            `Restart the MCP server to apply.`
        );
      } catch (err) {
        // Integrity-check or install failure. Leave the pending-update
        // record intact (already written above) so get_version keeps nagging.
        console.error(
          `[epimethian-mcp] Auto-update to v${latestStr} refused: ` +
            `${err instanceof Error ? err.message : err}`
        );
      }
      return info;
    }

    // Default path, or minor/major under opt-in: notify only.
    const label =
      type === "major" ? "Major" : type === "minor" ? "Minor" : "Patch";
    console.error(
      `[epimethian-mcp] ${label} update available: ` +
        `v${currentVersion} → v${latestStr}. ` +
        `Run \`epimethian-mcp upgrade\` to install.`
    );
    return info;
  } catch (err) {
    // Defensive: never let the update check crash the server
    console.error(
      `[epimethian-mcp] Update check failed: ${err instanceof Error ? err.message : err}`
    );
    return null;
  }
}
