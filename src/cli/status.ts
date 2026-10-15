import { testConnection } from "../shared/test-connection.js";
import { readFromKeychain, PROFILE_NAME_RE } from "../shared/keychain.js";
import { describeCopies, findInstalledCopies } from "../shared/installed-copies.js";

declare const __PKG_VERSION__: string;

/**
 * Which installed copy this is, or every copy when there are two or more.
 * Printed first, so it shows even when no credentials are configured.
 */
async function printInstalledCopies(): Promise<void> {
  const copies = await findInstalledCopies();
  const block = describeCopies(copies, __PKG_VERSION__, { runningLabel: "this command" });
  if (block) {
    console.log(block);
  } else if (copies.length === 1) {
    console.log(`Installed: ${copies[0].version ? `v${copies[0].version}` : "unknown version"} at ${copies[0].packageDir}`);
  } else {
    console.log(`Installed: no npm global install found (running v${__PKG_VERSION__} from ${process.argv[1] ?? "an unknown location"})`);
  }
}

export async function runStatus(): Promise<void> {
  await printInstalledCopies();

  const profile = process.env.CONFLUENCE_PROFILE || "";
  const urlEnv = process.env.CONFLUENCE_URL || "";
  const emailEnv = process.env.CONFLUENCE_EMAIL || "";
  const tokenEnv = process.env.CONFLUENCE_API_TOKEN || "";

  let url: string;
  let email: string;
  let apiToken: string;
  let mode: string;

  if (profile) {
    if (!PROFILE_NAME_RE.test(profile)) {
      console.error(`Invalid CONFLUENCE_PROFILE: "${profile}".`);
      process.exit(1);
    }
    const creds = await readFromKeychain(profile);
    if (!creds) {
      console.error(
        `No credentials found for profile "${profile}". Run \`epimethian-mcp setup --profile ${profile}\` to configure.`
      );
      process.exit(1);
    }
    url = creds.url;
    email = creds.email;
    apiToken = creds.apiToken;
    mode = `profile: ${profile}`;
  } else if (urlEnv && emailEnv && tokenEnv) {
    url = urlEnv;
    email = emailEnv;
    apiToken = tokenEnv;
    mode = "env-var mode";
  } else {
    const legacy = await readFromKeychain();
    if (!legacy) {
      console.error(
        "No credentials configured. Run `epimethian-mcp setup --profile <name>` to get started."
      );
      process.exit(1);
    }
    url = legacy.url;
    email = legacy.email;
    apiToken = legacy.apiToken;
    mode = "legacy keychain (no profile)";
  }

  console.log(`Profile:  ${mode}`);
  console.log(`URL:      ${url}`);
  console.log(`Email:    ${email}`);

  console.log("Testing connection...");
  const result = await testConnection(url, email, apiToken);
  console.log(`Status:   ${result.ok ? "Connected" : "Failed"} - ${result.message}`);
}
