import { main as startServer } from "../server/index.js";
import { resolveProfileArg } from "./profile-arg.js";

async function run(): Promise<void> {
  const command = process.argv[2];

  if (command === "setup") {
    const idx = process.argv.indexOf("--profile");
    const profile = idx > -1 ? process.argv[idx + 1] : undefined;
    const clientIdx = process.argv.indexOf("--client");
    const clientId = clientIdx > -1 ? process.argv[clientIdx + 1] : undefined;
    const { runSetup } = await import("./setup.js");
    await runSetup(profile, clientId);
  } else if (command === "profiles") {
    const { runProfiles } = await import("./profiles.js");
    await runProfiles();
  } else if (command === "status") {
    const { runStatus } = await import("./status.js");
    await runStatus(process.argv.slice(3));
  } else if (command === "permissions") {
    const profile = process.argv[3];
    const { runPermissions } = await import("./permissions.js");
    await runPermissions(profile);
  } else if (command === "fix-legacy-links") {
    const { runFixLegacyLinks } = await import("./fix-legacy-links.js");
    await runFixLegacyLinks(process.argv.slice(3));
  } else if (command === "agent-guide") {
    const { runAgentGuide } = await import("./agent-guide.js");
    runAgentGuide();
  } else if (command === "upgrade") {
    const { runUpgrade } = await import("./upgrade.js");
    const result = await runUpgrade();
    // Non-zero exit on failure so scripts and CI can detect.
    if (
      result.status === "integrity-failed" ||
      result.status === "install-failed" ||
      result.status === "check-failed"
    ) {
      process.exit(1);
    }
  } else {
    // The server reads its profile from CONFLUENCE_PROFILE (getConfig, the
    // recovery-mode server). `--profile <name>` (what setup's client snippets
    // pass) is resolved against it first: a disagreement stops here, before
    // any keychain read or request; an agreed name is put in the environment.
    const resolved = resolveProfileArg(process.argv.slice(2), process.env);
    if (!resolved.ok) {
      console.error(`Error: ${resolved.error}`);
      process.exit(1);
      return;
    }
    if (resolved.profile !== undefined) process.env.CONFLUENCE_PROFILE = resolved.profile;
    await startServer();
  }
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
