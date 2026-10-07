/**
 * Where the running copy of the package is installed, so an upgrade replaces
 * that copy rather than whichever `npm` happens to be first on PATH.
 *
 * Two npm installations side by side (Homebrew's and nvm's, say) each have
 * their own global prefix. A bare `npm install -g` writes to the prefix of
 * the npm it finds, reports success, and leaves the copy the MCP client
 * actually starts untouched.
 */

import { posix, win32 } from "node:path";

export const PACKAGE_DIR_SEGMENTS = ["node_modules", "@de-otio", "epimethian-mcp"] as const;

/**
 * The npm global prefix that holds the running script, or null when the
 * script is not inside an npm global install (a source checkout, an npx
 * cache, a local `node_modules`).
 *
 * npm's global layout is `<prefix>/lib/node_modules/<pkg>` on POSIX and
 * `<prefix>\node_modules\<pkg>` on Windows.
 */
export function globalInstallPrefix(
  scriptPath: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  const path = platform === "win32" ? win32 : posix;
  const parts = path.normalize(scriptPath).split(path.sep);
  // The last occurrence: a package nested inside another's node_modules is
  // not a global install of this one.
  let at = -1;
  for (let i = parts.length - PACKAGE_DIR_SEGMENTS.length; i >= 0; i--) {
    if (PACKAGE_DIR_SEGMENTS.every((seg, j) => parts[i + j] === seg)) {
      at = i;
      break;
    }
  }
  if (at === -1) return null;
  const before = parts.slice(0, at);
  if (platform !== "win32") {
    if (before[before.length - 1] !== "lib") return null;
    before.pop();
  }
  // `<prefix>` must itself not sit inside another node_modules (npx caches
  // and local installs look like `.../node_modules/.bin/...` or deeper).
  if (before.includes("node_modules")) return null;
  const prefix = before.join(path.sep);
  return prefix === "" ? path.sep : prefix;
}

/** The package directory under a global prefix. */
export function packageDirUnder(prefix: string, platform: NodeJS.Platform = process.platform): string {
  const path = platform === "win32" ? win32 : posix;
  return platform === "win32"
    ? path.join(prefix, ...PACKAGE_DIR_SEGMENTS)
    : path.join(prefix, "lib", ...PACKAGE_DIR_SEGMENTS);
}
