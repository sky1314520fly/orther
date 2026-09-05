/** Real CLI fixtures for TypeScript workspace package-boundary enforcement. */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = resolve(ROOT, "scripts/check_package_boundaries.mjs");

async function workspace(
  testContext,
  {
    protocolSource,
    engineSource,
    protocolDependencies = {},
    engineDependencies = {},
    additionalPackages = [],
  },
) {
  const root = await mkdtemp(join(tmpdir(), "distilly-package-boundaries-"));
  testContext.after(() => rm(root, { force: true, recursive: true }));
  const fixtures = [
    [
      "protocol",
      "@distilly/protocol",
      protocolSource,
      protocolDependencies,
    ],
    ["engine", "@distilly/engine", engineSource, engineDependencies],
    ...additionalPackages,
  ];
  for (const [directory, name, source, dependencies] of fixtures) {
    const packageDirectory = resolve(root, "packages", directory);
    await mkdir(resolve(packageDirectory, "src"), { recursive: true });
    await writeFile(
      resolve(packageDirectory, "package.json"),
      `${JSON.stringify({ name, type: "module", dependencies })}\n`,
      "utf8",
    );
    await writeFile(resolve(packageDirectory, "src/index.ts"), source, "utf8");
  }
  return root;
}

function run(root) {
  const result = spawnSync(process.execPath, [CHECKER, root], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.ifError(result.error);
  return result;
}

test("accepts engine to protocol", async (testContext) => {
  const root = await workspace(testContext, {
    protocolSource:
      'import type { ZodType } from "zod";\nexport type Schema = ZodType;\n',
    engineSource:
      'import type { EngineClient } from "@distilly/protocol";\nexport type Client = EngineClient;\n',
    engineDependencies: { "@distilly/protocol": "workspace:*" },
  });

  const result = run(root);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "package boundaries: ok\n");
  assert.equal(result.stderr, "");
});

test("rejects production Engine source importing a legacy test fixture", async (testContext) => {
  const root = await workspace(testContext, {
    protocolSource: "export interface EngineClient {}\n",
    engineSource:
      'import { ReviewService } from "./testing/legacy-file-review-service.test.fixture.js";\n' +
      "export { ReviewService };\n",
  });

  const result = run(root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[legacy-test-only-import\]/u);
});

test("accepts adapters, runtime, facade, MCP, bindings, Panel, and CLI along reviewed edges", async (testContext) => {
  const root = await workspace(testContext, {
    protocolSource: "export interface EngineClient {}\n",
    engineSource: "export interface EngineRuntime {}\n",
    additionalPackages: [
      [
        "adapters",
        "@distilly/adapters",
        'export type { MaterialInput } from "@distilly/protocol";\n',
        { "@distilly/protocol": "workspace:*" },
      ],
      [
        "distilly",
        "distilly",
        'export type { EngineClient } from "@distilly/protocol";\n',
        { "@distilly/protocol": "workspace:*" },
      ],
      [
        "runtime",
        "@distilly/runtime",
        'export type { Adapter } from "@distilly/adapters";\nexport type { HostBinding } from "@distilly/bindings";\nexport type { EngineRuntime } from "@distilly/engine/preview";\nexport type { EngineClient } from "@distilly/protocol";\n',
        {
          "@distilly/adapters": "workspace:*",
          "@distilly/bindings": "workspace:*",
          "@distilly/engine": "workspace:*",
          "@distilly/protocol": "workspace:*",
        },
      ],
      [
        "mcp",
        "@distilly/mcp",
        'export type { EngineClient } from "@distilly/protocol";\n',
        { "@distilly/protocol": "workspace:*" },
      ],
      [
        "bindings",
        "@distilly/bindings",
        'export type { HostPreflight } from "@distilly/protocol";\n',
        { "@distilly/protocol": "workspace:*" },
      ],
      [
        "panel",
        "@distilly/panel",
        'export type { EngineClient } from "@distilly/protocol";\nexport type { ReviewPresenter } from "@distilly/mcp";\n',
        { "@distilly/protocol": "workspace:*", "@distilly/mcp": "workspace:*" },
      ],
      [
        "cli",
        "@distilly/cli",
        'export type { EngineClient } from "@distilly/protocol";\n' +
          'export type { HostBinding } from "@distilly/bindings";\n' +
          'export type { PreviewLocalRuntime } from "@distilly/runtime/preview";\n' +
          'export { Distilly } from "distilly";\n' +
          'export { createMcpServer } from "@distilly/mcp";\n' +
          'export { PanelLauncher } from "@distilly/panel/server";\n',
        {
          "@distilly/protocol": "workspace:*",
          "@distilly/bindings": "workspace:*",
          "@distilly/runtime": "workspace:*",
          distilly: "workspace:*",
          "@distilly/mcp": "workspace:*",
          "@distilly/panel": "workspace:*",
        },
      ],
    ],
  });

  const result = run(root);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "package boundaries: ok\n");
  assert.equal(result.stderr, "");
});

test("accepts runtime composing bindings", async (testContext) => {
  const root = await workspace(testContext, {
    protocolSource: "export interface EngineClient {}\n",
    engineSource: "export interface EngineRuntime {}\n",
    additionalPackages: [
      ["bindings", "@distilly/bindings", "export interface HostBinding {}\n", {}],
      [
        "runtime",
        "@distilly/runtime",
        'export type { HostBinding } from "@distilly/bindings";\n',
        {
          "@distilly/bindings": "workspace:*",
          "@distilly/engine": "workspace:*",
          "@distilly/protocol": "workspace:*",
        },
      ],
    ],
  });

  const result = run(root);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "package boundaries: ok\n");
  assert.equal(result.stderr, "");
});

for (const forbiddenTarget of [
  "@distilly/engine",
  "@distilly/bindings",
  "distilly",
  "@distilly/mcp",
  "@distilly/panel",
]) {
  test(`rejects @distilly/adapters depending on ${forbiddenTarget}`, async (testContext) => {
    const root = await workspace(testContext, {
      protocolSource: "export interface MaterialInput {}\n",
      engineSource: "export interface EngineRuntime {}\n",
      additionalPackages: [
        [
          "adapters",
          "@distilly/adapters",
          `export type { Forbidden } from "${forbiddenTarget}";\n`,
          { [forbiddenTarget]: "workspace:*" },
        ],
        ["bindings", "@distilly/bindings", "export interface Binding {}\n", {}],
        ["distilly", "distilly", "export interface Facade {}\n", {}],
        ["mcp", "@distilly/mcp", "export interface Mcp {}\n", {}],
        ["panel", "@distilly/panel", "export interface Panel {}\n", {}],
      ],
    });

    const result = run(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[forbidden-internal-dependency]/);
    assert.match(result.stderr, /\[forbidden-internal-import]/);
    assert.match(
      result.stderr,
      new RegExp(`@distilly/adapters may not depend on ${forbiddenTarget}`),
    );
  });
}

for (const [directory, name] of [
  ["protocol", "@distilly/protocol"],
  ["engine", "@distilly/engine"],
  ["bindings", "@distilly/bindings"],
  ["distilly", "distilly"],
  ["mcp", "@distilly/mcp"],
  ["panel", "@distilly/panel"],
]) {
  test(`rejects ${name} depending on @distilly/adapters`, async (testContext) => {
    const sources = {
      protocol: "export interface Protocol {}\n",
      engine: "export interface Engine {}\n",
      bindings: "export interface Binding {}\n",
      distilly: "export interface Facade {}\n",
      mcp: "export interface Mcp {}\n",
      panel: "export interface Panel {}\n",
    };
    const manifests = {
      protocol: {},
      engine: {},
      bindings: {},
      distilly: {},
      mcp: {},
      panel: {},
    };
    sources[directory] = 'export type { Forbidden } from "@distilly/adapters";\n';
    manifests[directory] = { "@distilly/adapters": "workspace:*" };
    const root = await workspace(testContext, {
      protocolSource: sources.protocol,
      engineSource: sources.engine,
      protocolDependencies: manifests.protocol,
      engineDependencies: manifests.engine,
      additionalPackages: [
        ["adapters", "@distilly/adapters", "export interface Adapter {}\n", {}],
        ["bindings", "@distilly/bindings", sources.bindings, manifests.bindings],
        ["distilly", "distilly", sources.distilly, manifests.distilly],
        ["mcp", "@distilly/mcp", sources.mcp, manifests.mcp],
        ["panel", "@distilly/panel", sources.panel, manifests.panel],
      ],
    });

    const result = run(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[forbidden-internal-dependency]/);
    assert.match(result.stderr, /\[forbidden-internal-import]/);
    assert.match(result.stderr, new RegExp(`${name} may not depend on @distilly/adapters`));
  });
}

for (const [directory, name, forbiddenTarget] of [
  ["distilly", "distilly", "@distilly/engine"],
  ["distilly", "distilly", "@distilly/mcp"],
  ["mcp", "@distilly/mcp", "@distilly/engine"],
  ["mcp", "@distilly/mcp", "distilly"],
  ["panel", "@distilly/panel", "@distilly/engine"],
  ["panel", "@distilly/panel", "@distilly/bindings"],
  ["panel", "@distilly/panel", "distilly"],
]) {
  test(`rejects ${name} depending on ${forbiddenTarget}`, async (testContext) => {
    const root = await workspace(testContext, {
      protocolSource: "export interface EngineClient {}\n",
      engineSource: "export interface EngineRuntime {}\n",
      additionalPackages: [
        [
          "distilly",
          "distilly",
          directory === "distilly"
            ? `export type { Forbidden } from "${forbiddenTarget}";\n`
            : "export interface Facade {}\n",
          directory === "distilly" ? { [forbiddenTarget]: "workspace:*" } : {},
        ],
        [
          "mcp",
          "@distilly/mcp",
          directory === "mcp"
            ? `export type { Forbidden } from "${forbiddenTarget}";\n`
            : "export interface Presenter {}\n",
          directory === "mcp" ? { [forbiddenTarget]: "workspace:*" } : {},
        ],
        [
          "panel",
          "@distilly/panel",
          directory === "panel"
            ? `export type { Forbidden } from "${forbiddenTarget}";\n`
            : "export interface Panel {}\n",
          directory === "panel" ? { [forbiddenTarget]: "workspace:*" } : {},
        ],
        [
          "bindings",
          "@distilly/bindings",
          "export interface Bindings {}\n",
          {},
        ],
      ],
    });

    const result = run(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[forbidden-internal-dependency]/);
    assert.match(result.stderr, /\[forbidden-internal-import]/);
    assert.match(result.stderr, new RegExp(`${name} may not depend on ${forbiddenTarget}`));
  });
}

for (const [directory, name, forbiddenTarget] of [
  ["protocol", "@distilly/protocol", "@distilly/bindings"],
  ["engine", "@distilly/engine", "@distilly/bindings"],
  ["distilly", "distilly", "@distilly/bindings"],
  ["mcp", "@distilly/mcp", "@distilly/bindings"],
  ["protocol", "@distilly/protocol", "@distilly/panel"],
  ["engine", "@distilly/engine", "@distilly/panel"],
  ["distilly", "distilly", "@distilly/panel"],
  ["mcp", "@distilly/mcp", "@distilly/panel"],
  ["bindings", "@distilly/bindings", "@distilly/panel"],
  ["bindings", "@distilly/bindings", "@distilly/engine"],
  ["bindings", "@distilly/bindings", "distilly"],
  ["bindings", "@distilly/bindings", "@distilly/mcp"],
]) {
  test(`rejects ${name} depending on ${forbiddenTarget}`, async (testContext) => {
    const sources = {
      protocol: "export interface Protocol {}\n",
      engine: "export interface Engine {}\n",
      distilly: "export interface Facade {}\n",
      mcp: "export interface Mcp {}\n",
      bindings: "export interface Bindings {}\n",
      panel: "export interface Panel {}\n",
    };
    const manifests = {
      protocol: {},
      engine: {},
      distilly: {},
      mcp: {},
      bindings: {},
      panel: {},
    };
    sources[directory] = `export type { Forbidden } from "${forbiddenTarget}";\n`;
    manifests[directory] = { [forbiddenTarget]: "workspace:*" };
    const root = await workspace(testContext, {
      protocolSource: sources.protocol,
      engineSource: sources.engine,
      protocolDependencies: manifests.protocol,
      engineDependencies: manifests.engine,
      additionalPackages: [
        ["distilly", "distilly", sources.distilly, manifests.distilly],
        ["mcp", "@distilly/mcp", sources.mcp, manifests.mcp],
        ["bindings", "@distilly/bindings", sources.bindings, manifests.bindings],
        ["panel", "@distilly/panel", sources.panel, manifests.panel],
      ],
    });

    const result = run(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[forbidden-internal-dependency]/);
    assert.match(result.stderr, /\[forbidden-internal-import]/);
    assert.match(result.stderr, new RegExp(`${name} may not depend on ${forbiddenTarget}`));
  });
}

test("rejects bindings to engine through a relative workspace alias and subpath", async (
  testContext,
) => {
  const root = await workspace(testContext, {
    protocolSource: "export interface Protocol {}\n",
    engineSource: "export interface Engine {}\n",
    additionalPackages: [
      [
        "bindings",
        "@distilly/bindings",
        'export type { Engine } from "hidden-engine/internal";\n',
        { "hidden-engine": "workspace:../engine" },
      ],
    ],
  });

  const result = run(root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[forbidden-internal-dependency]/);
  assert.match(result.stderr, /\[forbidden-internal-import]/);
  assert.match(result.stderr, /@distilly\/bindings may not depend on @distilly\/engine/);
});

test("rejects bindings bypassing engine through a cross-package relative import", async (
  testContext,
) => {
  const root = await workspace(testContext, {
    protocolSource: "export interface Protocol {}\n",
    engineSource: "export interface Engine {}\n",
    additionalPackages: [
      [
        "bindings",
        "@distilly/bindings",
        'export type { Engine } from "../../engine/src/index.js";\n',
        {},
      ],
    ],
  });

  const result = run(root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[cross-package-relative-import]/);
  assert.match(result.stderr, /\[forbidden-internal-import]/);
  assert.match(result.stderr, /@distilly\/bindings may not depend on @distilly\/engine/);
});

test("accepts allowed internal npm and workspace aliases", async (testContext) => {
  const root = await workspace(testContext, {
    protocolSource: "export interface EngineClient {}\n",
    engineSource:
      'import type { EngineClient as NpmClient } from "protocol-npm";\n' +
      'import type { EngineClient as WorkspaceClient } from "protocol-workspace/subpath";\n' +
      'import type { EngineClient as RelativeClient } from "protocol-relative";\n' +
      'import type { EngineClient as LinkClient } from "protocol-link";\n' +
      'import type { EngineClient as FileClient } from "protocol-file";\n' +
      'import type { EngineClient as DirectoryClient } from "protocol-directory";\n' +
      "export type Clients = NpmClient | WorkspaceClient | RelativeClient | LinkClient | FileClient | DirectoryClient;\n",
    engineDependencies: {
      "protocol-npm": "npm:@distilly/protocol@1.0.0",
      "protocol-workspace": "workspace:@distilly/protocol@*",
      "protocol-relative": "workspace:../protocol",
      "protocol-link": "link:../protocol",
      "protocol-file": "file:../protocol",
      "protocol-directory": "../protocol",
    },
  });

  const result = run(root);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "package boundaries: ok\n");
  assert.equal(result.stderr, "");
});

test("rejects protocol to engine dependency and import", async (testContext) => {
  const root = await workspace(testContext, {
    protocolSource:
      'export type { EngineRuntime } from "@distilly/engine";\n',
    engineSource: "export interface EngineRuntime {}\n",
    protocolDependencies: { "@distilly/engine": "workspace:*" },
  });

  const result = run(root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[forbidden-internal-dependency]/);
  assert.match(result.stderr, /\[forbidden-internal-import]/);
  assert.match(
    result.stderr,
    /@distilly\/protocol may not depend on @distilly\/engine/,
  );
});

for (const [aliasKind, aliasSpecifier, dependencyName] of [
  ["npm", "npm:@distilly/engine@1.0.0", "engine-npm"],
  ["workspace", "workspace:@distilly/engine@*", "engine-workspace"],
  ["relative workspace", "workspace:../engine", "engine-relative"],
  ["link", "link:../engine", "engine-link"],
  ["file", "file:../engine", "engine-file"],
  ["directory", "../engine", "engine-directory"],
]) {
  test(`rejects protocol to engine through ${aliasKind} alias`, async (testContext) => {
    const root = await workspace(testContext, {
      protocolSource: `export type { EngineRuntime } from "${dependencyName}";\n`,
      engineSource: "export interface EngineRuntime {}\n",
      protocolDependencies: { [dependencyName]: aliasSpecifier },
    });

    const result = run(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[forbidden-internal-dependency]/);
    assert.match(result.stderr, /\[forbidden-internal-import]/);
    assert.match(
      result.stderr,
      /@distilly\/protocol may not depend on @distilly\/engine/,
    );
  });
}

for (const [aliasKind, protocolSpecifier, engineSpecifier] of [
  ["link", "link:../engine", "link:../protocol"],
  ["file", "file:../engine", "file:../protocol"],
  ["directory", "../engine", "../protocol"],
]) {
  test(`rejects a cycle through ${aliasKind} dependency aliases`, async (testContext) => {
    const root = await workspace(testContext, {
      protocolSource: 'export type { EngineRuntime } from "hidden-engine";\n',
      engineSource: 'export type { EngineClient } from "hidden-protocol";\n',
      protocolDependencies: { "hidden-engine": protocolSpecifier },
      engineDependencies: { "hidden-protocol": engineSpecifier },
    });

    const result = run(root);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\[forbidden-internal-dependency]/);
    assert.match(result.stderr, /\[forbidden-internal-import]/);
    assert.match(result.stderr, /\[dependency-cycle]/);
  });
}

test("rejects a cycle in the real source import graph", async (testContext) => {
  const root = await workspace(testContext, {
    protocolSource:
      'export type { EngineRuntime } from "@distilly/engine";\n',
    engineSource:
      'export type { EngineClient } from "@distilly/protocol";\n',
  });

  const result = run(root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[dependency-cycle]/);
  assert.match(result.stderr, /@distilly\/engine, @distilly\/protocol/);
});

test("rejects a computed import that the boundary gate cannot resolve", async (
  testContext,
) => {
  const root = await workspace(testContext, {
    protocolSource: "export interface EngineClient {}\n",
    engineSource:
      'const packageName = "@distilly/protocol";\nvoid import(packageName);\n',
  });

  const result = run(root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[non-static-module-specifier]/);
  assert.match(result.stderr, /dynamic import target must be a string literal/);
});
