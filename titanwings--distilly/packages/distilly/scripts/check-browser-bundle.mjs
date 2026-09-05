import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const facadeEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const protocolEntry = fileURLToPath(new URL("../../protocol/src/index.ts", import.meta.url));

const result = await build({
  entryPoints: [facadeEntry],
  bundle: true,
  platform: "browser",
  format: "esm",
  write: false,
  metafile: true,
  alias: { "@distilly/protocol": protocolEntry },
  logLevel: "silent",
});

assert.equal(result.outputFiles.length, 1, "Facade must produce one browser ESM entry");
assert.ok(
  Object.keys(result.metafile.inputs).some((input) => resolve(input) === protocolEntry),
  "Browser bundle must traverse the Protocol source graph",
);
assert.doesNotMatch(
  result.outputFiles[0]?.text ?? "",
  /(?:from\s+|import\s*\()["']node:/u,
  "Browser bundle must not retain Node built-in imports",
);
