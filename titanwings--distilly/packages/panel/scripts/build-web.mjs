import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import { build, version } from "esbuild";

assert.equal(version, "0.27.4", "Panel web assets require the pinned esbuild 0.27.4");

const entry = new URL("../src/browser-app.ts", import.meta.url);
const output = new URL("../web/app.js", import.meta.url);
const protocolEntry = new URL("../../protocol/src/index.ts", import.meta.url).pathname;
const result = await build({
  entryPoints: [entry.pathname],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["es2023"],
  write: false,
  minify: true,
  legalComments: "none",
  charset: "utf8",
  banner: { js: "// prettier-ignore" },
  alias: { "@distilly/protocol": protocolEntry },
  logLevel: "silent",
});
assert.equal(result.outputFiles.length, 1, "Panel web build must produce one local script");
const rawBytes = result.outputFiles[0]?.contents;
assert.ok(rawBytes, "Panel web build did not return script bytes");
const bytes = Buffer.from(
  Buffer.from(rawBytes)
    .toString("utf8")
    .replace(/[ \t]+$/gm, ""),
);

if (process.argv.includes("--check")) {
  const current = await readFile(output);
  assert.deepEqual(
    current,
    Buffer.from(bytes),
    "Panel web/app.js is stale; run pnpm --filter @distilly/panel build:web",
  );
} else {
  await writeFile(output, bytes);
}
