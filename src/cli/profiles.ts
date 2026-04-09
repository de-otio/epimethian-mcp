import { stdin, stdout } from "node:process";
import * as readline from "node:readline/promises";
import {
  readFromKeychain,
  deleteFromKeychain,
  PROFILE_NAME_RE,
} from "../shared/keychain.js";
import {
  readProfileRegistry,
  removeFromProfileRegistry,
  appendAuditLog,
  getProfileSettings,
  setProfileSettings,
} from "../shared/profiles.js";

export async function runProfiles(): Promise<void> {
  const args = process.argv.slice(3);

  // Handle --remove <name>
  const removeIdx = args.indexOf("--remove");
  if (removeIdx > -1) {
    const name = args[removeIdx + 1];
    if (!name || !PROFILE_NAME_RE.test(name)) {
      console.error(
        "Error: --remove requires a valid profile name."
      );
      process.exit(1);
    }
    await removeProfile(name, args.includes("--force"));
    return;
  }

  // Handle --set-read-only <name>
  const setRoIdx = args.indexOf("--set-read-only");
  if (setRoIdx > -1) {
    const name = args[setRoIdx + 1];
    if (!name || !PROFILE_NAME_RE.test(name)) {
      console.error("Error: --set-read-only requires a valid profile name.");
      process.exit(1);
    }
    await setReadOnlyFlag(name, true);
    return;
  }

  // Handle --set-read-write <name>
  const setRwIdx = args.indexOf("--set-read-write");
  if (setRwIdx > -1) {
    const name = args[setRwIdx + 1];
    if (!name || !PROFILE_NAME_RE.test(name)) {
      console.error("Error: --set-read-write requires a valid profile name.");
      process.exit(1);
    }
    await setReadOnlyFlag(name, false);
    return;
  }

  const verbose = args.includes("--verbose");
  const profiles = await readProfileRegistry();

  if (profiles.length === 0) {
    console.log("No profiles configured. Run `epimethian-mcp setup --profile <name>` to create one.");
    return;
  }

  if (verbose) {
    console.log(
      `  ${"Profile".padEnd(20)} ${"URL".padEnd(40)} ${"Read-Only".padEnd(12)} Email`
    );
    console.log(
      `  ${"─".repeat(20)} ${"─".repeat(40)} ${"─".repeat(12)} ${"─".repeat(30)}`
    );

    for (const name of profiles) {
      try {
        const creds = await readFromKeychain(name);
        const settings = await getProfileSettings(name);
        const roLabel = settings?.readOnly ? "YES" : "no";
        if (creds) {
          console.log(
            `  ${name.padEnd(20)} ${creds.url.padEnd(40)} ${roLabel.padEnd(12)} ${creds.email}`
          );
        } else {
          console.log(
            `  ${name.padEnd(20)} (credentials missing)`
          );
        }
      } catch {
        console.log(
          `  ${name.padEnd(20)} (credentials corrupted)`
        );
      }
    }
  } else {
    console.log("Configured profiles:");
    for (const name of profiles) {
      const settings = await getProfileSettings(name);
      const roSuffix = settings?.readOnly ? " (read-only)" : "";
      console.log(`  ${name}${roSuffix}`);
    }
    console.log("\nUse --verbose to show URLs and emails.");
  }
}

async function setReadOnlyFlag(name: string, readOnly: boolean): Promise<void> {
  const profiles = await readProfileRegistry();
  if (!profiles.includes(name)) {
    console.error(`Error: Profile "${name}" does not exist.`);
    process.exit(1);
  }
  await setProfileSettings(name, { readOnly });
  const label = readOnly ? "read-only" : "read-write";
  console.log(`Profile "${name}" is now ${label}.`);
  console.log("Note: Restart any running MCP servers for this change to take effect.");
}

async function removeProfile(name: string, force: boolean): Promise<void> {
  // --force only works when stdin is NOT a TTY (CI environments)
  if (!force || stdin.isTTY) {
    if (!stdin.isTTY) {
      console.error(
        "Error: Removing a profile requires an interactive terminal or --force in non-TTY mode."
      );
      process.exit(1);
    }

    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      const answer = await rl.question(
        `Remove profile "${name}" and delete its credentials? [y/N] `
      );
      if (answer.trim().toLowerCase() !== "y") {
        console.log("Cancelled.");
        return;
      }
    } finally {
      rl.close();
    }
  }

  await deleteFromKeychain(name);
  await removeFromProfileRegistry(name);
  await appendAuditLog(`Removed profile "${name}"`);
  console.log(`Profile "${name}" removed.`);
}
