import { build, context } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  sourcemap: true,
  target: "node18",
};

const isWatch = process.argv.includes("--watch");

const configs = [
  {
    ...shared,
    entryPoints: ["src/extension/extension.ts"],
    outfile: "dist/extension.js",
    external: ["vscode"],
  },
  {
    ...shared,
    entryPoints: ["src/server/index.ts"],
    outfile: "dist/server.js",
  },
];

if (isWatch) {
  const contexts = await Promise.all(configs.map((c) => context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("Watching for changes...");
} else {
  await Promise.all(configs.map((c) => build(c)));
}
