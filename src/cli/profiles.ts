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

  const verbose = args.includes("--verbose");
  const profiles = await readProfileRegistry();

  if (profiles.length === 0) {
    console.log("No profiles configured. Run `epimethian-mcp setup --profile <name>` to create one.");
    return;
  }

  if (verbose) {
    console.log(
      `  ${"Profile".padEnd(20)} ${"URL".padEnd(40)} Email`
    );
    console.log(
      `  ${"─".repeat(20)} ${"─".repeat(40)} ${"─".repeat(30)}`
    );

    for (const name of profiles) {
      try {
        const creds = await readFromKeychain(name);
        if (creds) {
          console.log(
            `  ${name.padEnd(20)} ${creds.url.padEnd(40)} ${creds.email}`
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
      console.log(`  ${name}`);
    }
    console.log("\nUse --verbose to show URLs and emails.");
  }
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
