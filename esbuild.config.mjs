import { build, context } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  sourcemap: true,
  target: "node18",
  loader: { ".md": "text" },
};

const isWatch = process.argv.includes("--watch");

const configs = [
  {
    ...shared,
    entryPoints: ["src/cli/index.ts"],
    outfile: "dist/cli/index.js",
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
];

if (isWatch) {
  const contexts = await Promise.all(configs.map((c) => context(c)));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log("Watching for changes...");
} else {
  await Promise.all(configs.map((c) => build(c)));
}
