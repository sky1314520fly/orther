import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, version } from "esbuild";

assert.equal(version, "0.27.4", "Panel browser gate requires the pinned esbuild version");
const webEntry = fileURLToPath(new URL("../src/web.ts", import.meta.url));
const protocolEntry = fileURLToPath(new URL("../../protocol/src/index.ts", import.meta.url));
const result = await build({
  entryPoints: [webEntry],
  bundle: true,
  platform: "browser",
  format: "esm",
  write: false,
  metafile: true,
  alias: { "@distilly/protocol": protocolEntry },
  logLevel: "silent",
});

assert.equal(result.outputFiles.length, 1, "Panel web subpath must produce one browser ESM entry");
assert.ok(
  Object.keys(result.metafile.inputs).some((input) => resolve(input) === protocolEntry),
  "Panel browser bundle must traverse the Protocol source graph",
);
assert.doesNotMatch(
  result.outputFiles[0]?.text ?? "",
  /(?:from\s+|import\s*\()["']node:/u,
  "Panel browser bundle must not retain Node built-in imports",
);
assert.ok(
  Object.keys(result.metafile.inputs).every(
    (input) => !/server-(?:http|assets|launcher)\.ts$/u.test(input),
  ),
  "Panel browser bundle must not traverse server implementation files",
);

for (const asset of ["index.html", "app.css"]) {
  const text = await readFile(new URL(`../web/${asset}`, import.meta.url), "utf8");
  assert.doesNotMatch(
    text,
    /(?:src|href)\s*=\s*["']https?:|@import\s+["']https?:|url\(\s*["']?https?:/iu,
    `${asset} must not reference remote assets`,
  );
}
