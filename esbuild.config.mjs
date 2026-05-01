import { build, context } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  sourcemap: true,
  target: "node18",
  loader: { ".md": "text" },
  define: { __PKG_VERSION__: JSON.stringify(pkg.version) },
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
