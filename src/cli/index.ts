import { main as startServer } from "../server/index.js";

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
    await runStatus();
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
      result.status === "install-failed"
    ) {
      process.exit(1);
    }
  } else {
    await startServer();
  }
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
