import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { testConnection, fetchTenantInfo } from "../shared/test-connection.js";
import {
  saveToKeychain,
  readFromKeychain,
  PROFILE_NAME_RE,
} from "../shared/keychain.js";
import { addToProfileRegistry, setProfileSettings } from "../shared/profiles.js";

const TOOLS = [
  "create_page",
  "get_page",
  "get_page_by_title",
  "update_page",
  "update_page_section",
  "delete_page",
  "list_pages",
  "get_page_children",
  "search_pages",
  "get_spaces",
  "add_attachment",
  "get_attachments",
  "add_drawio_diagram",
];

function readPassword(prompt: string): Promise<string> {
  stdout.write(prompt);
  return new Promise((resolve) => {
    const chars: string[] = [];
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const onData = (key: string) => {
      if (key === "\r" || key === "\n") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        stdout.write("\n");
        resolve(chars.join(""));
      } else if (key === "\u007f" || key === "\b") {
        if (chars.length > 0) {
          chars.pop();
          stdout.write("\b \b");
        }
      } else if (key === "\u0003") {
        // Ctrl+C
        stdout.write("\n");
        process.exit(1);
      } else {
        chars.push(key);
        stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

export async function runSetup(profile?: string): Promise<void> {
  if (!stdin.isTTY) {
    console.error(
      "Error: setup requires an interactive terminal.\n" +
        "For non-interactive environments, set CONFLUENCE_URL, CONFLUENCE_EMAIL, and CONFLUENCE_API_TOKEN as environment variables."
    );
    process.exit(1);
  }

  if (profile !== undefined && !PROFILE_NAME_RE.test(profile)) {
    console.error(
      `Error: Invalid profile name "${profile}". Use lowercase alphanumeric and hyphens only (1-63 chars).`
    );
    process.exit(1);
  }

  const banner = profile
    ? `Epimethian MCP - Credential setup for profile "${profile}"`
    : "Epimethian MCP - Confluence credential setup";
  console.log(banner + "\n");

  // Load existing credentials as defaults
  const existing = await readFromKeychain(profile);

  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    const defaultUrl = existing?.url ?? "";
    const urlPrompt = defaultUrl
      ? `Confluence URL [${defaultUrl}]: `
      : "Confluence URL (e.g. https://yoursite.atlassian.net): ";
    let url = (await rl.question(urlPrompt)).trim();
    if (!url && defaultUrl) url = defaultUrl;

    if (!url) {
      console.error("Error: URL is required.");
      process.exit(1);
    }
    url = url.replace(/\/+$/, "");
    if (!url.startsWith("https://")) {
      console.error("Error: URL must start with https://");
      process.exit(1);
    }

    // Validate URL structure
    try {
      const parsed = new URL(url);
      if (parsed.username || parsed.password || /[\n\r]/.test(url)) {
        console.error("Error: URL contains invalid characters.");
        process.exit(1);
      }
      if (!parsed.hostname.endsWith(".atlassian.net")) {
        console.error(
          `Warning: URL does not match *.atlassian.net. Ensure this is the correct Confluence instance.`
        );
      }
    } catch {
      console.error("Error: Invalid URL format.");
      process.exit(1);
    }

    const defaultEmail = existing?.email ?? "";
    const emailPrompt = defaultEmail
      ? `Email [${defaultEmail}]: `
      : "Email: ";
    let email = (await rl.question(emailPrompt)).trim();
    if (!email && defaultEmail) email = defaultEmail;

    if (!email) {
      console.error("Error: email is required.");
      process.exit(1);
    }

    // Close readline before raw mode password input
    rl.close();

    const apiToken = await readPassword(
      "API token (from https://id.atlassian.com/manage-profile/security/api-tokens): "
    );

    if (!apiToken) {
      console.error("Error: API token is required.");
      process.exit(1);
    }

    console.log("\nTesting connection...");
    const result = await testConnection(url, email, apiToken);

    if (!result.ok) {
      console.error(`Connection failed: ${result.message}`);
      process.exit(1);
    }

    console.log(`${result.message}`);

    // Fetch tenant identity (cloudId + display name) so we can (a) show the
    // user exactly which tenant they've connected to and (b) seal the profile
    // against future cross-tenant credential corruption.
    const tenantResult = await fetchTenantInfo(url, email, apiToken);
    let sealedCloudId: string | undefined;
    let sealedDisplayName: string | undefined;

    if (tenantResult.ok) {
      const { cloudId, displayName } = tenantResult.info;
      console.log(
        `\nTenant identity:\n` +
          `  Display name : ${displayName}\n` +
          `  Cloud ID     : ${cloudId}\n` +
          `  URL          : ${url}\n`
      );

      const rlConfirm = readline.createInterface({ input: stdin, output: stdout });
      try {
        const args = process.argv.slice(2);
        const assumeYes = args.includes("--yes") || args.includes("-y");
        let answer = "y";
        if (!assumeYes) {
          answer = (
            await rlConfirm.question("Is this the tenant you intended? [y/N] ")
          ).trim().toLowerCase();
        }
        if (answer !== "y" && answer !== "yes") {
          console.error(
            "\nAborted: tenant identity not confirmed. No credentials were saved."
          );
          process.exit(1);
        }
      } finally {
        rlConfirm.close();
      }

      sealedCloudId = cloudId;
      sealedDisplayName = displayName;
    } else {
      console.log(
        `\nWarning: Could not fetch tenant identity (${tenantResult.message}).\n` +
          "Profile will be saved without a tenant seal. Cross-tenant verification at startup will be skipped.\n"
      );
    }

    await saveToKeychain(
      {
        url,
        email,
        apiToken,
        ...(sealedCloudId ? { cloudId: sealedCloudId } : {}),
        ...(sealedDisplayName ? { tenantDisplayName: sealedDisplayName } : {}),
      },
      profile
    );
    if (profile) {
      await addToProfileRegistry(profile);

      // Determine read-only mode: --read-write opts out, otherwise default to read-only
      const args = process.argv.slice(2);
      const explicitReadWrite = args.includes("--read-write");
      let enableWrites = explicitReadWrite;

      if (!explicitReadWrite && !args.includes("--read-only")) {
        // Interactive prompt — default is read-only (N)
        const rl2 = readline.createInterface({ input: stdin, output: stdout });
        try {
          const answer = await rl2.question("Enable writes for this profile? [y/N] ");
          enableWrites = answer.trim().toLowerCase() === "y";
        } finally {
          rl2.close();
        }
      }

      const readOnly = !enableWrites;
      await setProfileSettings(profile, { readOnly });
      const modeLabel = readOnly ? "read-only" : "read-write";
      console.log(`Credentials saved to OS keychain (profile: ${profile}, ${modeLabel}).\n`);
    } else {
      console.log("Credentials saved to OS keychain.\n");
      console.log(
        "Tip: Use --profile <name> for multi-tenant support.\n"
      );
    }

    console.log(`Available tools (${TOOLS.length}):`);
    console.log(`  ${TOOLS.join(", ")}`);
    console.log(
      "\nSetup complete. Restart your MCP client to use the new credentials."
    );
  } finally {
    rl.close();
  }
}
