import { readFile, writeFile, rename, mkdir, chmod, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const CONFIG_DIR = join(homedir(), ".config", "epimethian-mcp");
const REGISTRY_FILE = join(CONFIG_DIR, "profiles.json");
const AUDIT_LOG = join(CONFIG_DIR, "audit.log");

export function getProfileRegistryPath(): string {
  return REGISTRY_FILE;
}

export function getAuditLogPath(): string {
  return AUDIT_LOG;
}

async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
}

// --- Registry types ---

export interface ProfileSettings {
  readOnly?: boolean;
}

interface ProfileRegistry {
  profiles: string[];
  settings?: Record<string, ProfileSettings>;
}

/**
 * Read the full registry object from disk.
 * Returns a default empty registry if the file is missing or corrupted.
 */
async function readFullRegistry(): Promise<ProfileRegistry> {
  try {
    // Permission check: reject group- or world-writable registry files
    try {
      const info = await stat(REGISTRY_FILE);
      if ((info.mode & 0o022) !== 0) {
        console.error(
          "Error: Profile registry has unsafe permissions (group/world-writable). " +
            `Run: chmod 600 ${REGISTRY_FILE}`
        );
        return { profiles: [] };
      }
    } catch (statErr: unknown) {
      // File doesn't exist yet — will be caught by readFile below
      if (
        !(statErr instanceof Error) ||
        !("code" in statErr) ||
        (statErr as NodeJS.ErrnoException).code !== "ENOENT"
      ) {
        throw statErr;
      }
    }

    const raw = await readFile(REGISTRY_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray(parsed.profiles) &&
      parsed.profiles.every((p: unknown) => typeof p === "string")
    ) {
      return {
        profiles: parsed.profiles as string[],
        settings: parsed.settings ?? undefined,
      };
    }
    console.error(
      "Warning: Profile registry has unexpected format. Treating as empty."
    );
    return { profiles: [] };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { profiles: [] }; // File doesn't exist yet
    }
    console.error("Warning: Could not read profile registry. Treating as empty.");
    return { profiles: [] };
  }
}

/** Atomic write of the full registry to disk. */
async function writeRegistry(registry: ProfileRegistry): Promise<void> {
  await ensureConfigDir();
  const data = JSON.stringify(registry, null, 2) + "\n";
  const tmpFile = join(
    CONFIG_DIR,
    `.profiles.${randomBytes(4).toString("hex")}.tmp`
  );
  await writeFile(tmpFile, data, { mode: 0o600 });
  await rename(tmpFile, REGISTRY_FILE);
}

/**
 * Read the list of known profile names from the registry.
 * Returns [] if the file is missing or corrupted (with a warning to stderr).
 */
export async function readProfileRegistry(): Promise<string[]> {
  const registry = await readFullRegistry();
  return registry.profiles;
}

/**
 * Get settings for a specific profile.
 * Returns undefined if the profile has no settings or is unknown.
 */
export async function getProfileSettings(
  name: string
): Promise<ProfileSettings | undefined> {
  const registry = await readFullRegistry();
  return registry.settings?.[name];
}

/**
 * Set settings for a specific profile (merge with existing).
 */
export async function setProfileSettings(
  name: string,
  settings: ProfileSettings
): Promise<void> {
  const registry = await readFullRegistry();
  if (!registry.settings) {
    registry.settings = {};
  }
  registry.settings[name] = { ...registry.settings[name], ...settings };
  await writeRegistry(registry);
}

/**
 * Add a profile name to the registry (idempotent).
 * Uses atomic write (write to temp file, then rename).
 */
export async function addToProfileRegistry(name: string): Promise<void> {
  await ensureConfigDir();
  const registry = await readFullRegistry();
  if (registry.profiles.includes(name)) return; // Already registered
  registry.profiles.push(name);
  await writeRegistry(registry);
}

/**
 * Remove a profile name from the registry.
 */
export async function removeFromProfileRegistry(name: string): Promise<void> {
  const registry = await readFullRegistry();
  const filtered = registry.profiles.filter((p) => p !== name);
  if (filtered.length === registry.profiles.length) return; // Wasn't in the list
  registry.profiles = filtered;
  // Clean up settings for removed profile
  if (registry.settings) {
    delete registry.settings[name];
    if (Object.keys(registry.settings).length === 0) {
      delete registry.settings;
    }
  }
  await writeRegistry(registry);
}

/**
 * Append an audit log entry for profile removal.
 */
export async function appendAuditLog(message: string): Promise<void> {
  await ensureConfigDir();
  const entry = `[${new Date().toISOString()}] ${message}\n`;
  // appendFile semantics via writeFile with flag
  const { appendFile } = await import("node:fs/promises");
  await appendFile(AUDIT_LOG, entry, { mode: 0o600 });
}
