import { readFile, writeFile, rename, mkdir, chmod } from "node:fs/promises";
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

/**
 * Read the list of known profile names from the registry.
 * Returns [] if the file is missing or corrupted (with a warning to stderr).
 */
export async function readProfileRegistry(): Promise<string[]> {
  try {
    const raw = await readFile(REGISTRY_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray(parsed.profiles) &&
      parsed.profiles.every((p: unknown) => typeof p === "string")
    ) {
      return parsed.profiles as string[];
    }
    console.error(
      "Warning: Profile registry has unexpected format. Treating as empty."
    );
    return [];
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return []; // File doesn't exist yet
    }
    console.error("Warning: Could not read profile registry. Treating as empty.");
    return [];
  }
}

/**
 * Add a profile name to the registry (idempotent).
 * Uses atomic write (write to temp file, then rename).
 */
export async function addToProfileRegistry(name: string): Promise<void> {
  await ensureConfigDir();
  const profiles = await readProfileRegistry();
  if (profiles.includes(name)) return; // Already registered
  profiles.push(name);

  const data = JSON.stringify({ profiles }, null, 2) + "\n";
  const tmpFile = join(
    CONFIG_DIR,
    `.profiles.${randomBytes(4).toString("hex")}.tmp`
  );
  await writeFile(tmpFile, data, { mode: 0o600 });
  await rename(tmpFile, REGISTRY_FILE);
}

/**
 * Remove a profile name from the registry.
 */
export async function removeFromProfileRegistry(name: string): Promise<void> {
  const profiles = await readProfileRegistry();
  const filtered = profiles.filter((p) => p !== name);
  if (filtered.length === profiles.length) return; // Wasn't in the list

  await ensureConfigDir();
  const data = JSON.stringify({ profiles: filtered }, null, 2) + "\n";
  const tmpFile = join(
    CONFIG_DIR,
    `.profiles.${randomBytes(4).toString("hex")}.tmp`
  );
  await writeFile(tmpFile, data, { mode: 0o600 });
  await rename(tmpFile, REGISTRY_FILE);
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
