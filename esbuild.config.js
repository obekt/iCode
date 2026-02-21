import { build } from "esbuild";

await build({
  entryPoints: ["src/client/app.ts"],
  bundle: true,
  outfile: "dist/client/app.js",
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  minify: process.argv.includes("--minify"),
});

console.log("Client bundle built → dist/client/app.js");
