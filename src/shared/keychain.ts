import { execFile, spawn } from 'node:child_process';

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

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as Record<string, unknown>).apiToken !== 'string' ||
    typeof (parsed as Record<string, unknown>).url !== 'string' ||
    typeof (parsed as Record<string, unknown>).email !== 'string'
  ) {
    const label = profile ? `profile "${profile}"` : 'legacy keychain entry';
    throw new Error(
      `Corrupted keychain entry for ${label}: missing required fields (url, email, apiToken).`
    );
  }

  return parsed as KeychainCredentials;
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
