import { execFile, spawn } from 'node:child_process';
import { isValidExpiryDate } from './token-expiry.js';

const SERVICE = 'epimethian-mcp';
const LEGACY_ACCOUNT = 'confluence-credentials';

// --- Profile name validation ---

/**
 * Profile names: lowercase alphanumeric + hyphens, 1-63 chars, must start with [a-z0-9].
 * Starting with a letter/digit (not "-") also prevents the name from being
 * misinterpreted as a CLI flag by `security` / `secret-tool`.
 */
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Derive the keychain account name for a named profile.
 * Validates the profile name at this chokepoint regardless of caller-side checks.
 */
export function accountForProfile(profile: string): string {
  if (!PROFILE_NAME_RE.test(profile)) {
    throw new Error(
      `Invalid profile name: "${profile}". Use lowercase alphanumeric and hyphens only (1-63 chars).`
    );
  }
  return `${LEGACY_ACCOUNT}/${profile}`;
}

export interface KeychainCredentials {
  url: string;
  email: string;
  apiToken: string;
  /** Tenant seal: the Atlassian cloudId of the site. Added in v5.5+. Optional for backward compatibility with pre-seal profiles. */
  cloudId?: string;
  /** Tenant seal: human-readable display name (cloudName or host) captured at setup. Purely for user-facing messages. */
  tenantDisplayName?: string;
  /**
   * Gateway mode (7.6.0): the token is a scoped API token and every request goes
   * through api.atlassian.com/ex/confluence/{cloudId}. Absent means site mode;
   * "site" is never written. Only ever stored together with `cloudId`
   * (see `buildKeychainRecord`).
   */
  apiMode?: 'gateway';
  /** Scoped token expiry as shown at token creation, `YYYY-MM-DD`. Optional; only asked for in gateway setup. */
  tokenExpiry?: string;
}

/**
 * The one place a keychain record is assembled for writing. Enforces the
 * gateway invariant: a record never claims gateway mode without the tenant
 * seal that the gateway base is derived from. Optional fields are omitted,
 * never written as undefined or empty.
 */
export function buildKeychainRecord(input: {
  url: string;
  email: string;
  apiToken: string;
  cloudId?: string;
  tenantDisplayName?: string;
  apiMode?: 'gateway';
  tokenExpiry?: string;
}): KeychainCredentials {
  if (input.apiMode === 'gateway' && !input.cloudId) {
    throw new Error(
      'Refusing to store gateway mode without a tenant seal (cloudId): the gateway base is derived from it.'
    );
  }
  if (input.tokenExpiry !== undefined && !isValidExpiryDate(input.tokenExpiry)) {
    throw new Error(`Invalid token expiry "${input.tokenExpiry}": use a real date as YYYY-MM-DD.`);
  }
  return {
    url: input.url,
    email: input.email,
    apiToken: input.apiToken,
    ...(input.cloudId ? { cloudId: input.cloudId } : {}),
    ...(input.tenantDisplayName ? { tenantDisplayName: input.tenantDisplayName } : {}),
    ...(input.apiMode === 'gateway' ? { apiMode: 'gateway' as const } : {}),
    ...(input.tokenExpiry !== undefined ? { tokenExpiry: input.tokenExpiry } : {}),
  };
}

/**
 * Validate a parsed keychain JSON value. Returns null when the required
 * fields (url, email, apiToken) are missing. Optional fields that fail
 * validation are dropped silently (same policy for all of them), so a
 * hand-edited record can never smuggle in a mode or date that the writer
 * would have refused.
 *
 * Every field the record can hold MUST be copied here: the opportunistic
 * tenant seal re-saves `{ ...stored, cloudId }`, and a field this function
 * does not parse is erased by that re-save.
 */
export function parseKeychainRecord(parsed: unknown): KeychainCredentials | null {
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as Record<string, unknown>).apiToken !== 'string' ||
    typeof (parsed as Record<string, unknown>).url !== 'string' ||
    typeof (parsed as Record<string, unknown>).email !== 'string'
  ) {
    return null;
  }
  const p = parsed as Record<string, unknown>;
  const result: KeychainCredentials = {
    url: p.url as string,
    email: p.email as string,
    apiToken: p.apiToken as string,
  };
  // Tenant seal fields — optional, string-only. Silently drop non-strings.
  if (typeof p.cloudId === 'string' && p.cloudId) result.cloudId = p.cloudId;
  if (typeof p.tenantDisplayName === 'string' && p.tenantDisplayName) {
    result.tenantDisplayName = p.tenantDisplayName;
  }
  // Gateway mode: kept only when exactly "gateway"; anything else is site mode.
  if (p.apiMode === 'gateway') result.apiMode = 'gateway';
  // Token expiry: kept only as a real YYYY-MM-DD date.
  if (typeof p.tokenExpiry === 'string' && isValidExpiryDate(p.tokenExpiry)) {
    result.tokenExpiry = p.tokenExpiry;
  }
  return result;
}

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

// --- Platform helpers (parameterized by account) ---

async function writeMacOS(account: string, password: string): Promise<void> {
  // Delete existing entry first (ignore errors if it doesn't exist)
  try {
    await exec('security', ['delete-generic-password', '-s', SERVICE, '-a', account]);
  } catch {
    // Entry didn't exist — that's fine
  }
  await exec('security', [
    'add-generic-password',
    '-s', SERVICE,
    '-a', account,
    '-w', password,
    '-U',
  ]);
}

async function readMacOS(account: string): Promise<string> {
  return (await exec('security', [
    'find-generic-password',
    '-s', SERVICE,
    '-a', account,
    '-w',
  ])).trim();
}

async function deleteMacOS(account: string): Promise<void> {
  await exec('security', ['delete-generic-password', '-s', SERVICE, '-a', account]);
}

async function writeLinux(account: string, password: string): Promise<void> {
  // secret-tool reads the secret from stdin
  return new Promise((resolve, reject) => {
    const proc = spawn('secret-tool', [
      'store', '--label', SERVICE, 'service', SERVICE, 'account', account,
    ]);
    proc.stdin.write(password);
    proc.stdin.end();
    proc.on('close', (code: number) => {
      if (code === 0) resolve();
      else reject(new Error(`secret-tool store exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

async function readLinux(account: string): Promise<string> {
  return (await exec('secret-tool', [
    'lookup',
    'service', SERVICE,
    'account', account,
  ])).trim();
}

async function deleteLinux(account: string): Promise<void> {
  await exec('secret-tool', [
    'clear',
    'service', SERVICE,
    'account', account,
  ]);
}

// --- Resolve account name ---

function resolveAccount(profile?: string): string {
  if (profile !== undefined) {
    return accountForProfile(profile);
  }
  return LEGACY_ACCOUNT;
}

// --- Public API ---

/**
 * Save credentials to the OS keychain.
 * When profile is provided, stores under the profiled account name.
 * When omitted, uses the legacy account for backward compatibility.
 */
export async function saveToKeychain(creds: KeychainCredentials, profile?: string): Promise<void> {
  const account = resolveAccount(profile);
  // Last line of defence behind buildKeychainRecord: never persist gateway mode without the seal.
  if (creds.apiMode === 'gateway' && !creds.cloudId) {
    throw new Error('Refusing to store gateway mode without a tenant seal (cloudId).');
  }
  const json = JSON.stringify(creds);
  if (process.platform === 'darwin') {
    await writeMacOS(account, json);
  } else if (process.platform === 'linux') {
    await writeLinux(account, json);
  } else {
    throw new Error(`Keychain not supported on ${process.platform}`);
  }
}

/**
 * Read credentials from the OS keychain.
 * Returns null if no entry exists for the resolved account.
 * Throws if the entry exists but contains corrupted or invalid data.
 */
export async function readFromKeychain(profile?: string): Promise<KeychainCredentials | null> {
  const account = resolveAccount(profile);
  let raw: string;
  try {
    if (process.platform === 'darwin') {
      raw = await readMacOS(account);
    } else if (process.platform === 'linux') {
      raw = await readLinux(account);
    } else {
      return null;
    }
  } catch {
    // Entry not found or keychain unavailable
    return null;
  }

  // Entry exists — parse and validate. Corruption is a hard error.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const label = profile ? `profile "${profile}"` : 'legacy keychain entry';
    throw new Error(`Corrupted keychain entry for ${label}: invalid JSON.`);
  }

  const result = parseKeychainRecord(parsed);
  if (!result) {
    const label = profile ? `profile "${profile}"` : 'legacy keychain entry';
    throw new Error(
      `Corrupted keychain entry for ${label}: missing required fields (url, email, apiToken).`
    );
  }
  return result;
}

/**
 * Remove credentials from the OS keychain.
 */
export async function deleteFromKeychain(profile?: string): Promise<void> {
  const account = resolveAccount(profile);
  try {
    if (process.platform === 'darwin') {
      await deleteMacOS(account);
    } else if (process.platform === 'linux') {
      await deleteLinux(account);
    }
  } catch {
    // Entry didn't exist — that's fine
  }
}
