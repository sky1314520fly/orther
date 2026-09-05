import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const rootSource = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const stdioSource = await readFile(new URL("../src/stdio.ts", import.meta.url), "utf8");
const schemaSource = await readFile(new URL("../src/internal-schema.ts", import.meta.url), "utf8");
const serverSource = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
const fixtureSource = await readFile(new URL("./stdio-fixture.mjs", import.meta.url), "utf8");

assert.equal(
  rootSource,
  'export { createMcpServer } from "./server.js";\n' +
    'export type { McpServer, McpServerOptions, ReviewPresenter } from "./types.js";\n',
  "MCP root must keep its reviewed runtime and type allowlists",
);
assert.doesNotMatch(rootSource, /stdio|runStdio|internal/u);

const stdioExports = [
  ...stdioSource.matchAll(
    /^export (?:declare )?(?:class|const|function|interface|type) ([A-Za-z_$][\w$]*)/gmu,
  ),
].map((match) => match[1]);
assert.deepEqual(stdioExports, ["runStdio"]);

assert.match(
  schemaSource,
  /export const advertisedToolContractDigest/u,
  "The internal schema seam must expose the projection-bound digest",
);
assert.match(
  schemaSource,
  /export const projectAdvertisedSchema/u,
  "The internal schema seam must own the advertised projection",
);

assert.match(
  serverSource,
  /import packageJson from "\.\.\/package\.json" with \{ type: "json" \};/u,
  "MCP server version must use the package release metadata",
);
assert.match(
  serverSource,
  /const SERVER_INFO = \{ name: "distilly", version: packageJson\.version \} as const;/u,
  "MCP server identity must use the fixed name and package version",
);
assert.doesNotMatch(
  fixtureSource,
  /DISTILLY_ROOT|createEngine|createLocalRuntime|from "@distilly\/(?:engine|runtime)"/u,
  "The transport fixture must remain injected-client-only",
);
