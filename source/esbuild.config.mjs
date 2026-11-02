import esbuild from "esbuild";

const mode = process.argv[2] || "dev";

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: mode === "test" ? ["src/test-core.ts"] : ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    "cpu-features",
    // ssh2's optional native binding — must stay a runtime require so ssh2's
    // try/catch falls back to its pure-JS implementation.
    "./crypto/build/Release/sshcrypto.node",
  ],
  format: "cjs",
  platform: "node",
  target: "es2020",
  logLevel: "info",
  sourcemap: mode === "production" ? false : "inline",
  treeShaking: true,
  outfile: mode === "test" ? "test/test-core.cjs" : "main.js",
};

if (mode === "production" || mode === "test") {
  await esbuild.build(options);
} else {
  const ctx = await esbuild.context(options);
  await ctx.watch();
}
