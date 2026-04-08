import { main as startServer } from "../server/index.js";

async function run(): Promise<void> {
  const command = process.argv[2];

  if (command === "setup") {
    const { runSetup } = await import("./setup.js");
    await runSetup();
  } else {
    await startServer();
  }
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
