/**
 * Every globally installed copy of the package on this machine, so a second
 * copy is visible instead of silently shadowing the one being upgraded.
 *
 * A machine can hold two global copies (Homebrew's npm and nvm's npm each have
 * their own prefix). The MCP client starts one and the terminal finds the
 * other: an IDE started from the macOS Dock does not get the login shell's
 * PATH. `upgrade` replaces the copy it runs from, so the user can upgrade one
 * copy and keep running the other. This module lists them.
 *
 * It only reads the filesystem: no `npm`, no child process, no writes. Every
 * fs error leaves that candidate out; `findInstalledCopies` never throws.
 */

import { readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { globalInstallPrefix, packageDirUnder } from "./install-location.js";

export const PACKAGE_NAME = "@de-otio/epimethian-mcp";
const BIN_NAME = "epimethian-mcp";
const POSIX_SYSTEM_PREFIXES = ["/opt/homebrew", "/usr/local", "/usr"] as const;
/** At most this many entries of each nvm `versions/node` folder are probed. */
const NVM_LISTING_CAP = 64;

export interface InstalledCopy {
  /** npm global prefix. */
  prefix: string;
  /** packageDirUnder(prefix). */
  packageDir: string;
  /** From packageDir/package.json; null if unreadable. */
  version: string | null;
  /** Holds realpath(process.argv[1]). */
  running: boolean;
  /** Position among the PATH hits in this process (0 = first); null if not on PATH. */
  pathRank: number | null;
}

type Env = Record<string, string | undefined>;

export interface CandidateOptions {
  env: Env;
  platform: NodeJS.Platform;
  home: string;
  /** Replaces the fixed POSIX system prefixes (tests). */
  systemPrefixes?: readonly string[];
}

/** What to probe. PATH hits and nvm listings need the fs, so they are resolved by the finder. */
export interface Candidates {
  /** Bin entries to look for on PATH, in PATH order. */
  pathBins: string[];
  /** Prefixes probed whether or not they are on PATH. */
  prefixes: string[];
  /** `versions/node` folders: each child is an nvm-managed Node prefix. */
  nvmVersionRoots: string[];
}

export interface CopyFs {
  realpath(p: string): Promise<string>;
  readFile(p: string, encoding: "utf-8"): Promise<string>;
  readdir(p: string): Promise<string[]>;
}

export interface FindOptions extends Partial<CandidateOptions> {
  /** The running entry script; defaults to process.argv[1]. */
  runningScript?: string;
  fs?: CopyFs;
}

const defaultFs: CopyFs = {
  realpath: (p) => realpath(p),
  readFile: (p, e) => readFile(p, e),
  readdir: (p) => readdir(p),
};

function pathFor(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

function envValue(env: Env, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** The bin entry under a prefix: `<prefix>/bin/epimethian-mcp`, or `<prefix>\epimethian-mcp.cmd` on win32. */
export function runningBinPath(prefix: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? win32.join(prefix, `${BIN_NAME}.cmd`)
    : posix.join(prefix, "bin", BIN_NAME);
}

/** The prefixes and PATH entries to probe. Pure. */
export function candidatePrefixes({ env, platform, home, systemPrefixes }: CandidateOptions): Candidates {
  const path = pathFor(platform);
  const binName = platform === "win32" ? `${BIN_NAME}.cmd` : BIN_NAME;
  const pathBins = (envValue(env, "PATH", platform) ?? "")
    .split(platform === "win32" ? ";" : ":")
    .filter((d) => d !== "")
    .map((d) => path.join(d, binName));

  if (platform === "win32") {
    const appData = envValue(env, "APPDATA", platform);
    return { pathBins, prefixes: appData ? [path.join(appData, "npm")] : [], nvmVersionRoots: [] };
  }
  const nvmVersionRoots = [path.join(home, ".nvm", "versions", "node")];
  const nvmDir = envValue(env, "NVM_DIR", platform);
  if (nvmDir) {
    const fromEnv = path.join(nvmDir, "versions", "node");
    if (!nvmVersionRoots.includes(fromEnv)) nvmVersionRoots.push(fromEnv);
  }
  return {
    pathBins,
    prefixes: [...(systemPrefixes ?? POSIX_SYSTEM_PREFIXES), path.join(home, ".npm-global")],
    nvmVersionRoots,
  };
}

async function quietly<T>(f: () => Promise<T>): Promise<T | null> {
  try {
    return await f();
  } catch {
    return null;
  }
}

function parseVersion(raw: string): string | null {
  try {
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" && /^[0-9A-Za-z.+-]{1,64}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Every global copy of the package that can be found: on this process's PATH,
 * under the well-known prefixes (probed even when not on PATH, since the
 * server's PATH is the one most likely to miss the terminal's copy), and the
 * running copy itself. Deduped by the package directory's realpath. The
 * running copy comes first, then by PATH rank. Never throws.
 */
export async function findInstalledCopies(opts: FindOptions = {}): Promise<InstalledCopy[]> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const fs = opts.fs ?? defaultFs;
  const path = pathFor(platform);
  try {
    const home = opts.home ?? homedir();
    const cands = candidatePrefixes({ env, platform, home, systemPrefixes: opts.systemPrefixes });
    const runningScript = opts.runningScript ?? process.argv[1];
    const realScript = runningScript ? await quietly(() => fs.realpath(runningScript)) : null;

    const probes: { prefix: string; pathRank: number | null }[] = [];
    let hits = 0;
    for (const bin of cands.pathBins) {
      const real = await quietly(() => fs.realpath(bin));
      if (real === null) continue;
      const rank = hits++;
      // npm puts the win32 `.cmd` shim straight into the prefix; on POSIX the
      // bin is a symlink into `<prefix>/lib/node_modules/<pkg>`. A hit that is
      // not a global install (a source checkout, an npx cache, a version
      // manager's shim) resolves to no prefix and is skipped.
      const prefix = platform === "win32" ? path.dirname(bin) : globalInstallPrefix(real, platform);
      if (prefix !== null) probes.push({ prefix, pathRank: rank });
    }
    for (const prefix of cands.prefixes) probes.push({ prefix, pathRank: null });
    for (const versions of cands.nvmVersionRoots) {
      const entries = (await quietly(() => fs.readdir(versions))) ?? [];
      for (const name of [...entries].sort().slice(0, NVM_LISTING_CAP)) {
        probes.push({ prefix: path.join(versions, name), pathRank: null });
      }
    }
    const runningPrefix = realScript ? globalInstallPrefix(realScript, platform) : null;
    if (runningPrefix !== null) probes.push({ prefix: runningPrefix, pathRank: null });

    const byRealDir = new Map<string, InstalledCopy>();
    for (const { prefix, pathRank } of probes) {
      const packageDir = packageDirUnder(prefix, platform);
      const realDir = await quietly(() => fs.realpath(packageDir));
      if (realDir === null) continue;
      const seen = byRealDir.get(realDir);
      if (seen) {
        if (pathRank !== null && (seen.pathRank === null || pathRank < seen.pathRank)) seen.pathRank = pathRank;
        continue;
      }
      const raw = await quietly(() => fs.readFile(path.join(packageDir, "package.json"), "utf-8"));
      byRealDir.set(realDir, {
        prefix,
        packageDir,
        version: raw === null ? null : parseVersion(raw),
        running: realScript !== null && realScript.startsWith(realDir + path.sep),
        pathRank,
      });
    }
    const rank = (c: InstalledCopy) => (c.running ? -1 : c.pathRank ?? Number.MAX_SAFE_INTEGER);
    return [...byRealDir.values()].sort((a, b) => rank(a) - rank(b));
  } catch {
    return [];
  }
}

function quoteArg(arg: string, platform: NodeJS.Platform): string {
  if (/^[A-Za-z0-9_/\\.:@+=,~-]+$/.test(arg)) return arg;
  return platform === "win32" ? `"${arg}"` : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The command that removes the copy under `prefix`, whichever `npm` runs it. */
export function uninstallCommand(prefix: string, platform: NodeJS.Platform = process.platform): string {
  return `npm uninstall -g --prefix ${quoteArg(prefix, platform)} ${PACKAGE_NAME}`;
}

function versionLabel(copy: InstalledCopy, runningVersion?: string): string {
  const v = copy.version ?? (copy.running ? runningVersion : undefined);
  return v ? `v${v}` : "unknown";
}

/**
 * The "N copies are installed" block, or null when fewer than two copies
 * exist. Pure.
 */
export function describeCopies(
  copies: readonly InstalledCopy[],
  runningVersion: string,
  { platform = process.platform, runningLabel = "this server" }: { platform?: NodeJS.Platform; runningLabel?: string } = {}
): string | null {
  if (copies.length < 2) return null;
  const labels = copies.map((c) => versionLabel(c, runningVersion));
  const width = Math.max(...labels.map((l) => l.length));
  const lines = [`${copies.length} copies of epimethian-mcp are installed:`];
  copies.forEach((c, i) => {
    lines.push(`  ${labels[i].padEnd(width)}  ${c.packageDir}${c.running ? `   ← ${runningLabel}` : ""}`);
  });
  const removable = copies.filter((c) => !c.running);
  lines.push("An upgrade replaces only the copy it runs from. Keep the copy your MCP");
  lines.push(
    removable.length === copies.length
      ? `config's "command" starts, and remove the rest. The command for each:`
      : `config's "command" starts, and remove the ${removable.length === 1 ? "other" : "others"}:`
  );
  for (const c of removable) lines.push(`  ${uninstallCommand(c.prefix, platform)}`);
  return lines.join("\n");
}

/** After an upgrade: the copies it did not touch, or null when there are none. Pure. */
export function describeNotUpgraded(
  copies: readonly InstalledCopy[],
  platform: NodeJS.Platform = process.platform
): string | null {
  const others = copies.filter((c) => !c.running);
  if (others.length === 0) return null;
  const lines = others.map((c) => `Not upgraded: ${versionLabel(c)} at ${c.packageDir}`);
  lines.push(
    others.length === 1
      ? `If your MCP config starts that copy, it still runs ${versionLabel(others[0])}. Remove the copy you don't use:`
      : "If your MCP config starts one of those copies, it still runs the old version. Remove the copies you don't use:"
  );
  for (const c of others) lines.push(`  ${uninstallCommand(c.prefix, platform)}`);
  return lines.join("\n");
}

/**
 * The upgrade instruction for an update notice when two or more copies exist:
 * the running copy's bin by absolute path, since a bare `epimethian-mcp` runs
 * whichever copy is first on the terminal's PATH. Null otherwise, so callers
 * keep their usual wording. Pure.
 */
export function upgradeInstruction(
  copies: readonly InstalledCopy[],
  platform: NodeJS.Platform = process.platform
): string | null {
  const running = copies.find((c) => c.running);
  if (copies.length < 2 || !running) return null;
  return (
    `Ask your agent to run the \`upgrade\` tool, or run \`"${runningBinPath(running.prefix, platform)}" upgrade\` ` +
    "in your terminal. A bare `epimethian-mcp upgrade` may upgrade a different copy (see above)."
  );
}
