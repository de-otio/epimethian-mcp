import { execFile, spawn } from 'node:child_process';

const SERVICE = 'epimethian-mcp';
const ACCOUNT = 'confluence-credentials';

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

async function writeMacOS(password: string): Promise<void> {
  // Delete existing entry first (ignore errors if it doesn't exist)
  try {
    await exec('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]);
  } catch {
    // Entry didn't exist — that's fine
  }
  await exec('security', [
    'add-generic-password',
    '-s', SERVICE,
    '-a', ACCOUNT,
    '-w', password,
    '-U',
  ]);
}

async function readMacOS(): Promise<string> {
  return (await exec('security', [
    'find-generic-password',
    '-s', SERVICE,
    '-a', ACCOUNT,
    '-w',
  ])).trim();
}

async function deleteMacOS(): Promise<void> {
  await exec('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]);
}

async function writeLinux(password: string): Promise<void> {
  // secret-tool reads the secret from stdin
  return new Promise((resolve, reject) => {
    const proc = spawn('secret-tool', [
      'store', '--label', SERVICE, 'service', SERVICE, 'account', ACCOUNT,
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

async function readLinux(): Promise<string> {
  return (await exec('secret-tool', [
    'lookup',
    'service', SERVICE,
    'account', ACCOUNT,
  ])).trim();
}

async function deleteLinux(): Promise<void> {
  await exec('secret-tool', [
    'clear',
    'service', SERVICE,
    'account', ACCOUNT,
  ]);
}

/**
 * Save credentials to the OS keychain.
 * Stores as a JSON blob so we can retrieve all fields.
 */
export async function saveToKeychain(creds: KeychainCredentials): Promise<void> {
  const json = JSON.stringify(creds);
  if (process.platform === 'darwin') {
    await writeMacOS(json);
  } else if (process.platform === 'linux') {
    await writeLinux(json);
  } else {
    throw new Error(`Keychain not supported on ${process.platform}`);
  }
}

/**
 * Read credentials from the OS keychain.
 * Returns null if no credentials are stored.
 */
export async function readFromKeychain(): Promise<KeychainCredentials | null> {
  try {
    let raw: string;
    if (process.platform === 'darwin') {
      raw = await readMacOS();
    } else if (process.platform === 'linux') {
      raw = await readLinux();
    } else {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.apiToken === 'string') {
      return parsed as KeychainCredentials;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Remove credentials from the OS keychain.
 */
export async function deleteFromKeychain(): Promise<void> {
  try {
    if (process.platform === 'darwin') {
      await deleteMacOS();
    } else if (process.platform === 'linux') {
      await deleteLinux();
    }
  } catch {
    // Entry didn't exist — that's fine
  }
}
