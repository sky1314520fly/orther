import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const defaultOutput = join(repositoryRoot, "artifacts", "distilly-codex-preview");
const sentinel = "__DISTILLY_LAUNCHER_ABSOLUTE_PATH__";

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const sha256 = (bytes) => `sha256_${createHash("sha256").update(bytes).digest("hex")}`;

const parseArgs = () => {
  let output = defaultOutput;
  let force = false;
  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index];
    if (value === "--force") {
      force = true;
      continue;
    }
    if (value === "--output" && process.argv[index + 1] !== undefined) {
      output = resolve(process.argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error("Usage: assemble-preview-package.mjs [--output <absolute-path>] [--force]");
  }
  if (!isAbsolute(output) || output === resolve(output, "..")) {
    throw new Error("The Preview package output must be a specific absolute directory.");
  }
  return { output, force };
};

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const copyRegularFile = async (source, destination, mode = 0o600) => {
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Expected a regular package source file: ${source}`);
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, await readFile(source), { flag: "wx", mode });
};

const copyTree = async (sourceRoot, destinationRoot, current = sourceRoot) => {
  const metadata = await lstat(current);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Expected a regular package source directory: ${current}`);
  }
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => compareUtf8(left.name, right.name));
  for (const entry of entries) {
    const source = join(current, entry.name);
    const destination = join(destinationRoot, relative(sourceRoot, source));
    if (entry.isSymbolicLink()) throw new Error(`Package source contains a symlink: ${source}`);
    if (entry.isDirectory()) {
      await copyTree(sourceRoot, destinationRoot, source);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Package source is not a regular file: ${source}`);
    await copyRegularFile(source, destination);
  }
};

const walkFiles = async (root, current = root) => {
  const result = [];
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => compareUtf8(left.name, right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Preview package output contains a symlink.");
    if (entry.isDirectory()) {
      result.push(...(await walkFiles(root, path)));
      continue;
    }
    if (!entry.isFile()) throw new Error("Preview package output contains a special file.");
    result.push(relative(root, path).split(sep).join("/"));
  }
  return result;
};

const rejectForbiddenOutput = async (root, files) => {
  const repositoryBytes = Buffer.from(repositoryRoot, "utf8");
  for (const path of files) {
    if (
      path === "preview-runtime-manifest.json" ||
      path.endsWith(".mcp.json.template") ||
      /(?:^|\/)testing(?:\/|$)|\.test\.|\.spec\.|(?:^|\/)e2e(?:\/|$)|playwright/iu.test(path)
    ) {
      throw new Error(`Preview package contains a forbidden path: ${path}`);
    }
    const bytes = await readFile(join(root, path));
    if (bytes.includes(Buffer.from(sentinel, "utf8"))) {
      throw new Error(`Preview package contains the launcher sentinel: ${path}`);
    }
    if (bytes.includes(repositoryBytes)) {
      throw new Error(`Preview package contains the checkout path: ${path}`);
    }
    if (bytes.includes(Buffer.from("workspace:*", "utf8"))) {
      throw new Error(`Preview package contains a workspace dependency: ${path}`);
    }
  }
};

const assemble = async (staging) => {
  const mcpManifest = await readJson(join(repositoryRoot, "packages/mcp/package.json"));
  const releaseManifest = await readJson(join(repositoryRoot, "plugins/release-manifest.json"));
  const releaseVersion = mcpManifest.version;
  if (releaseManifest.releaseVersion !== releaseVersion) {
    throw new Error("Build the plugin release manifest before assembling the Preview package.");
  }

  const bundle = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: ["packages/cli/lib/bin.js"],
    outdir: join(staging, "packages/cli/lib"),
    bundle: true,
    splitting: true,
    platform: "node",
    format: "esm",
    target: "node22",
    tsconfigRaw: { compilerOptions: {} },
    metafile: true,
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
    plugins: [
      {
        name: "distilly-release-versions",
        setup(buildApi) {
          buildApi.onLoad({ filter: /packages\/(mcp|panel)\/package\.json$/ }, async (args) => {
            const manifest = await readJson(args.path);
            return { contents: JSON.stringify({ version: manifest.version }), loader: "json" };
          });
        },
      },
    ],
  });
  const sourceInput = Object.keys(bundle.metafile.inputs).find((path) =>
    /(?:^|\/)packages\/[^/]+\/src\//u.test(path),
  );
  if (sourceInput !== undefined) {
    throw new Error(
      `Preview package bundled workspace source instead of build output: ${sourceInput}`,
    );
  }

  await copyTree(join(repositoryRoot, "packages/panel/web"), join(staging, "packages/panel/web"));
  await copyRegularFile(
    join(repositoryRoot, "packages/engine/prompts/host-distill-v1.md"),
    join(staging, "packages/prompts/host-distill-v1.md"),
  );
  await copyRegularFile(
    join(repositoryRoot, "plugins/release-manifest.json"),
    join(staging, "plugins/release-manifest.json"),
  );
  await copyRegularFile(
    join(repositoryRoot, "plugins/codex/.codex-plugin/plugin.json"),
    join(staging, "plugins/codex/.codex-plugin/plugin.json"),
  );
  await copyTree(
    join(repositoryRoot, "plugins/codex/skills"),
    join(staging, "plugins/codex/skills"),
  );
  // OpenClaw consumes the Claude-compatible bundle, while Hermes consumes the
  // shared canonical Skill directly. Keep both source trees in the verified
  // runtime package so lifecycle setup never reaches back into the checkout.
  await copyRegularFile(
    join(repositoryRoot, "plugins/claude-code/.claude-plugin/plugin.json"),
    join(staging, "plugins/claude-code/.claude-plugin/plugin.json"),
  );
  await copyTree(
    join(repositoryRoot, "plugins/claude-code/skills"),
    join(staging, "plugins/claude-code/skills"),
  );
  await copyTree(
    join(repositoryRoot, "plugins/shared/skills"),
    join(staging, "plugins/shared/skills"),
  );

  const bootstrap = `#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\nexec node "$root/packages/cli/lib/bin.js" "$@"\n`;
  await writeFile(join(staging, "distilly"), bootstrap, { flag: "wx", mode: 0o700 });
  await chmod(join(staging, "distilly"), 0o700);
  await writeFile(
    join(staging, "package.json"),
    `${JSON.stringify(
      {
        name: "@distilly/codex-preview",
        version: releaseVersion,
        private: true,
        type: "module",
        engines: { node: "^22.19 || ^24" },
        bin: { distilly: "./distilly" },
      },
      undefined,
      2,
    )}\n`,
    { flag: "wx", mode: 0o600 },
  );

  const files = (await walkFiles(staging)).sort(compareUtf8);
  await rejectForbiddenOutput(staging, files);
  const records = [];
  for (const path of files) {
    records.push({ path, contentDigest: sha256(await readFile(join(staging, path))) });
  }
  await writeFile(
    join(staging, "preview-runtime-manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        releaseVersion,
        entryPath: "packages/cli/lib/bin.js",
        pluginSourcesPath: "plugins",
        panelAssetsPath: "packages/panel/web",
        files: records,
      },
      undefined,
      2,
    )}\n`,
    { flag: "wx", mode: 0o600 },
  );

  const { inspectPreviewRuntimePackage } = await import("../lib/runtime-package.js");
  await inspectPreviewRuntimePackage(staging);
  return releaseVersion;
};

const { output, force } = parseArgs();
const outputMetadata = await lstat(output).catch((error) => {
  if (error.code === "ENOENT") return undefined;
  throw error;
});
const { inspectPreviewRuntimePackage, removePreviewRuntimePackage } =
  await import("../lib/runtime-package.js");
let existingPackage;
if (outputMetadata !== undefined) {
  if (!force) throw new Error(`Preview package output already exists: ${output}`);
  if (!outputMetadata.isDirectory() || outputMetadata.isSymbolicLink()) {
    throw new Error("Refusing to replace a non-directory Preview package output.");
  }
  try {
    existingPackage = await inspectPreviewRuntimePackage(output);
  } catch (error) {
    throw new Error("Refusing to replace an unverified Preview package output.", {
      cause: error,
    });
  }
}
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const staging = await mkdtemp(join(dirname(output), ".distilly-preview-"));
try {
  const releaseVersion = await assemble(staging);
  if (existingPackage !== undefined) {
    await removePreviewRuntimePackage(existingPackage.root, existingPackage.manifestDigest);
  }
  await rename(staging, output);
  process.stdout.write(`${output}\n${releaseVersion}\n`);
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  throw error;
}
