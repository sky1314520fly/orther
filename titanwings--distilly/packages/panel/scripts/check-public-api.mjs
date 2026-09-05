import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
assert.deepEqual(Object.keys(packageJson.exports), ["./server", "./web"]);
assert.equal(packageJson.exports["."], undefined, "Panel must not expose a root barrel");
assert.deepEqual(packageJson.imports, { "#package-manifest": "./package.json" });
assert.deepEqual(packageJson.dependencies, {
  "@distilly/mcp": "workspace:*",
  "@distilly/protocol": "workspace:*",
});
assert.deepEqual(packageJson.devDependencies, { esbuild: "0.27.4", playwright: "1.62.1" });

const solutionConfig = JSON.parse(
  await readFile(new URL("../tsconfig.json", import.meta.url), "utf8"),
);
const serverConfig = JSON.parse(
  await readFile(new URL("../tsconfig.server.json", import.meta.url), "utf8"),
);
const webConfig = JSON.parse(
  await readFile(new URL("../tsconfig.web.json", import.meta.url), "utf8"),
);
assert.deepEqual(solutionConfig.files, []);
assert.deepEqual(solutionConfig.references, [
  { path: "./tsconfig.server.json" },
  { path: "./tsconfig.web.json" },
]);
assert.deepEqual(serverConfig.compilerOptions.lib, ["es2023"]);
assert.deepEqual(serverConfig.compilerOptions.types, ["node"]);
assert.equal(serverConfig.compilerOptions.outDir, "lib/server");
assert.equal(serverConfig.compilerOptions.tsBuildInfoFile, "tsconfig.server.tsbuildinfo");
assert.deepEqual(webConfig.compilerOptions.lib, ["es2023", "dom", "dom.iterable"]);
assert.deepEqual(webConfig.compilerOptions.types, []);
assert.equal(webConfig.compilerOptions.outDir, "lib/web");
assert.equal(webConfig.compilerOptions.tsBuildInfoFile, "tsconfig.web.tsbuildinfo");
assert.ok(
  serverConfig.files.every((path) => !path.includes("web-") && path !== "src/browser-app.ts"),
  "Panel server build must not traverse browser entries",
);
assert.ok(
  webConfig.files.every((path) => !path.includes("server-")),
  "Panel web build must not traverse Node server entries",
);

const serverSource = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
assert.equal(
  serverSource,
  'export { startPanelServer } from "./server-http.js";\n' +
    'export type { PanelHandle, PanelServerOptions } from "./server-http.js";\n' +
    'export { PanelLauncher } from "./server-launcher.js";\n' +
    'export type { PanelLauncherOptions } from "./server-launcher.js";\n',
  "Panel server subpath must keep its reviewed export allowlist",
);

const webSource = await readFile(new URL("../src/web.ts", import.meta.url), "utf8");
assert.equal(
  webSource,
  'export { HttpEngineClient } from "./web-client.js";\n' +
    'export type { HttpEngineClientOptions } from "./web-client.js";\n' +
    'export { bootstrapPanel } from "./web-ui.js";\n' +
    'export type { PanelWebBootstrapOptions, PanelWebHandle } from "./web-ui.js";\n',
  "Panel web subpath must keep its reviewed export allowlist",
);

const webGraph = [
  "src/browser-app.ts",
  "src/web.ts",
  "src/web-client.ts",
  "src/web-fragment.ts",
  "src/web-recovery.ts",
  "src/web-sse.ts",
  "src/web-ui.ts",
  "src/transport.ts",
];
for (const path of webGraph) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  assert.doesNotMatch(source, /["']node:/u, `${path} must remain browser-safe`);
  assert.doesNotMatch(source, /@distilly\/(?:engine|mcp)/u, `${path} must depend only on Protocol`);
}
