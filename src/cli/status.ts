import { testConnection } from "../shared/test-connection.js";
import { readFromKeychain, PROFILE_NAME_RE } from "../shared/keychain.js";
import { requestBaseFor } from "../server/api-base.js";
import { tokenExpiryState, describeExpiry, todayUtc } from "../shared/token-expiry.js";
import { describeCopies, findInstalledCopies } from "../shared/installed-copies.js";
import { resolveProfileArg } from "./profile-arg.js";

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

/**
 * `epimethian-mcp status [--profile <name>]`. `argv` is the argument list
 * after `status`. The profile is resolved first (flag against
 * CONFLUENCE_PROFILE), so a bad or conflicting name fails before any keychain
 * read or request.
 */
export async function runStatus(
  argv: readonly string[] = [],
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<void> {
  const resolved = resolveProfileArg(argv, env);
  if (!resolved.ok) {
    console.error(`Error: ${resolved.error}`);
    process.exit(1);
    return;
  }

  await printInstalledCopies();

  const profile = resolved.profile ?? "";
  const urlEnv = env.CONFLUENCE_URL || "";
  const emailEnv = env.CONFLUENCE_EMAIL || "";
  const tokenEnv = env.CONFLUENCE_API_TOKEN || "";

  let url: string;
  let email: string;
  let apiToken: string;
  let mode: string;
  // Gateway-mode details (scoped token); undefined for site mode.
  let gateway: { cloudId?: string; tokenExpiry?: string } | undefined;

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
    if (creds.apiMode === "gateway") {
      gateway = { cloudId: creds.cloudId, tokenExpiry: creds.tokenExpiry };
    }
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
  console.log(`Mode:     ${gateway ? "gateway (scoped token)" : "site"}`);
  if (gateway?.tokenExpiry) {
    const state = tokenExpiryState(gateway.tokenExpiry, todayUtc());
    console.log(`Token expires: ${describeExpiry(gateway.tokenExpiry, state)}`);
  }

  // Gateway mode tests through the pinned gateway base: the site URL does not
  // serve a scoped token. A gateway record without a seal cannot be pinned.
  let base = url;
  if (gateway) {
    try {
      base = requestBaseFor({ url, apiMode: "gateway", sealedCloudId: gateway.cloudId });
    } catch (err) {
      console.log(`Status:   Failed - ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
  }

  console.log("Testing connection...");
  const result = gateway
    ? await testConnection(base, email, apiToken, { gateway: true })
    : await testConnection(base, email, apiToken);
  console.log(`Status:   ${result.ok ? "Connected" : "Failed"} - ${result.message}`);
}
