import { main as startServer } from "../server/index.js";

async function run(): Promise<void> {
  const command = process.argv[2];

  if (command === "setup") {
    const idx = process.argv.indexOf("--profile");
    const profile = idx > -1 ? process.argv[idx + 1] : undefined;
    const { runSetup } = await import("./setup.js");
    await runSetup(profile);
  } else if (command === "profiles") {
    const { runProfiles } = await import("./profiles.js");
    await runProfiles();
  } else if (command === "status") {
    const { runStatus } = await import("./status.js");
    await runStatus();
  } else if (command === "agent-guide") {
    const { runAgentGuide } = await import("./agent-guide.js");
    runAgentGuide();
  } else {
    await startServer();
  }
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
