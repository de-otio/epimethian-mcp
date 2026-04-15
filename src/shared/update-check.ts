import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
    const raw = await readFile(UPDATE_CHECK_FILE, "utf-8");
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

/** Run `npm install -g` to upgrade to the given version. */
export async function performUpgrade(version: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    "npm",
    ["install", "-g", `${PACKAGE_NAME}@${version}`],
    { timeout: 120_000 }
  );
  return (stdout + stderr).trim();
}

/**
 * Check for updates (max once per day).
 *
 * - Patch releases are installed automatically.
 * - Minor / major releases are stored as pending for user confirmation.
 *
 * Returns UpdateInfo when an update exists, or null when up-to-date.
 * Never throws — network and install errors are logged to stderr and swallowed.
 */
export async function checkForUpdates(
  currentVersion: string
): Promise<UpdateInfo | null> {
  // Honour opt-out for CI / non-interactive environments
  if (process.env.EPIMETHIAN_NO_UPDATE_CHECK === "true") return null;

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

    if (type === "patch") {
      try {
        await performUpgrade(latestStr);
        info.autoInstalled = true;
        newState.pendingUpdate = info;
        await writeCheckState(newState);
        console.error(
          `[epimethian-mcp] Bugfix v${latestStr} installed automatically. ` +
            `Restart the MCP server to apply.`
        );
      } catch (err) {
        // Install failed — still record the update so get_version can report it
        newState.pendingUpdate = info;
        await writeCheckState(newState);
        console.error(
          `[epimethian-mcp] Auto-update to v${latestStr} failed: ${err instanceof Error ? err.message : err}`
        );
      }
      return info;
    }

    // Minor or major — store as pending, let the user decide
    newState.pendingUpdate = info;
    await writeCheckState(newState);
    console.error(
      `[epimethian-mcp] ${type === "major" ? "Major" : "Minor"} update available: ` +
        `v${currentVersion} → v${latestStr}. ` +
        `Use the upgrade tool to install.`
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
