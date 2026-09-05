import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { contentDigestSchema, type ContentDigest } from "@distilly/protocol";

export const PREVIEW_RUNTIME_MANIFEST = "preview-runtime-manifest.json";
export const PREVIEW_RUNTIME_ENTRY = "packages/cli/lib/bin.js";
export const PREVIEW_PLUGIN_SOURCES = "plugins";
export const PREVIEW_PANEL_ASSETS = "packages/panel/web";

interface RuntimeFileRecord {
  readonly path: string;
  readonly contentDigest: ContentDigest;
}

interface RuntimeManifest {
  readonly schemaVersion: 1;
  readonly releaseVersion: string;
  readonly entryPath: typeof PREVIEW_RUNTIME_ENTRY;
  readonly pluginSourcesPath: typeof PREVIEW_PLUGIN_SOURCES;
  readonly panelAssetsPath: typeof PREVIEW_PANEL_ASSETS;
  readonly files: readonly RuntimeFileRecord[];
}

/** One fully verified self-contained Preview runtime tree. */
export interface VerifiedPreviewRuntimePackage {
  readonly root: string;
  readonly manifestPath: string;
  readonly manifestDigest: ContentDigest;
  readonly releaseVersion: string;
  readonly entryPath: string;
  readonly pluginSourcesPath: string;
  readonly panelAssetsPath: string;
}

const semver =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const compareUtf8 = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const digest = (bytes: Uint8Array | string): ContentDigest =>
  contentDigestSchema.parse(`sha256_${createHash("sha256").update(bytes).digest("hex")}`);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort(compareUtf8);
  const expected = [...keys].sort(compareUtf8);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const safeRelativePath = (value: string): string => {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error("The Preview runtime manifest contains an unsafe path.");
  }
  return value;
};

const inside = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
};

const resolveOwnedPath = (root: string, path: string): string => {
  const resolved = resolve(root, safeRelativePath(path));
  if (!inside(root, resolved)) throw new Error("A Preview runtime path escapes its package root.");
  return resolved;
};

const readRegularFile = async (path: string): Promise<Uint8Array> => {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Expected a regular Preview runtime file at ${path}.`);
  }
  return Uint8Array.from(await readFile(path));
};

const parseManifest = (bytes: Uint8Array): RuntimeManifest => {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("The Preview runtime manifest is not valid UTF-8 JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The Preview runtime manifest is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    !hasExactKeys(record, [
      "schemaVersion",
      "releaseVersion",
      "entryPath",
      "pluginSourcesPath",
      "panelAssetsPath",
      "files",
    ]) ||
    record.schemaVersion !== 1 ||
    typeof record.releaseVersion !== "string" ||
    !semver.test(record.releaseVersion) ||
    record.entryPath !== PREVIEW_RUNTIME_ENTRY ||
    record.pluginSourcesPath !== PREVIEW_PLUGIN_SOURCES ||
    record.panelAssetsPath !== PREVIEW_PANEL_ASSETS ||
    !Array.isArray(record.files)
  ) {
    throw new Error("The Preview runtime manifest is invalid.");
  }
  const files = record.files.map((value): RuntimeFileRecord => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("The Preview runtime manifest contains an invalid file record.");
    }
    const file = value as Record<string, unknown>;
    const contentDigest = contentDigestSchema.safeParse(file.contentDigest);
    if (
      !hasExactKeys(file, ["path", "contentDigest"]) ||
      typeof file.path !== "string" ||
      !contentDigest.success
    ) {
      throw new Error("The Preview runtime manifest contains an invalid file record.");
    }
    return { path: safeRelativePath(file.path), contentDigest: contentDigest.data };
  });
  const paths = files.map((file) => file.path);
  if (
    paths.length === 0 ||
    new Set(paths).size !== paths.length ||
    paths.some((path, index) => index > 0 && compareUtf8(paths[index - 1]!, path) >= 0) ||
    paths.includes(PREVIEW_RUNTIME_MANIFEST)
  ) {
    throw new Error("The Preview runtime manifest file order or ownership is invalid.");
  }
  for (const required of [
    "distilly",
    "package.json",
    PREVIEW_RUNTIME_ENTRY,
    "packages/panel/web/index.html",
    "packages/prompts/host-distill-v1.md",
    "plugins/release-manifest.json",
    "plugins/codex/.codex-plugin/plugin.json",
    "plugins/codex/skills/distilly/SKILL.md",
    "plugins/claude-code/.claude-plugin/plugin.json",
    "plugins/claude-code/skills/distilly/SKILL.md",
    "plugins/shared/skills/distilly/SKILL.md",
  ]) {
    if (!paths.includes(required)) {
      throw new Error(`The Preview runtime package is missing ${required}.`);
    }
  }
  return {
    schemaVersion: 1,
    releaseVersion: record.releaseVersion,
    entryPath: PREVIEW_RUNTIME_ENTRY,
    pluginSourcesPath: PREVIEW_PLUGIN_SOURCES,
    panelAssetsPath: PREVIEW_PANEL_ASSETS,
    files,
  };
};

const walkTree = async (root: string, current = root): Promise<string[]> => {
  const result: string[] = [];
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => compareUtf8(left.name, right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink())
      throw new Error("Preview runtime packages may not contain symlinks.");
    if (entry.isDirectory()) {
      result.push(...(await walkTree(root, path)));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error("Preview runtime packages may contain only regular files.");
    }
    result.push(relative(root, path).split(sep).join("/"));
  }
  return result;
};

/**
 * Verifies every byte and path in one assembled Preview runtime package.
 *
 * @param rootValue - Absolute runtime package root.
 * @returns Trusted absolute paths and the manifest digest.
 */
export const inspectPreviewRuntimePackage = async (
  rootValue: string,
): Promise<VerifiedPreviewRuntimePackage> => {
  if (!isAbsolute(rootValue)) throw new Error("The Preview runtime package path must be absolute.");
  const root = resolve(rootValue);
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("The Preview runtime package must be a regular directory.");
  }
  const manifestPath = join(root, PREVIEW_RUNTIME_MANIFEST);
  const manifestBytes = await readRegularFile(manifestPath);
  const manifest = parseManifest(manifestBytes);
  const observed = (await walkTree(root)).sort(compareUtf8);
  const expected = [...manifest.files.map((file) => file.path), PREVIEW_RUNTIME_MANIFEST].sort(
    compareUtf8,
  );
  if (
    observed.length !== expected.length ||
    observed.some((path, index) => path !== expected[index])
  ) {
    throw new Error("The Preview runtime package contains unowned or missing files.");
  }
  for (const file of manifest.files) {
    const bytes = await readRegularFile(resolveOwnedPath(root, file.path));
    if (digest(bytes) !== file.contentDigest) {
      throw new Error(`The Preview runtime package file was modified: ${file.path}.`);
    }
  }
  return {
    root,
    manifestPath,
    manifestDigest: digest(manifestBytes),
    releaseVersion: manifest.releaseVersion,
    entryPath: resolveOwnedPath(root, manifest.entryPath),
    pluginSourcesPath: resolveOwnedPath(root, manifest.pluginSourcesPath),
    panelAssetsPath: resolveOwnedPath(root, manifest.panelAssetsPath),
  };
};

/**
 * Copies one verified package to a new exact version directory without symlinks.
 *
 * @param source - Already verified source package.
 * @param destinationValue - Absent absolute destination directory.
 * @returns The verified installed copy.
 */
export const installPreviewRuntimePackage = async (
  source: VerifiedPreviewRuntimePackage,
  destinationValue: string,
): Promise<VerifiedPreviewRuntimePackage> => {
  if (!isAbsolute(destinationValue)) throw new Error("The runtime destination must be absolute.");
  const destination = resolve(destinationValue);
  const parent = dirname(destination);
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error("The runtime destination parent must be a regular directory.");
  }
  await lstat(destination)
    .then(() => {
      throw new Error("The runtime destination already exists.");
    })
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });

  const staging = join(parent, `.distilly-runtime-${randomUUID()}`);
  try {
    await mkdir(staging, { mode: 0o700 });
    const manifestBytes = await readRegularFile(source.manifestPath);
    const manifest = parseManifest(manifestBytes);
    for (const file of manifest.files) {
      const target = resolveOwnedPath(staging, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, await readRegularFile(resolveOwnedPath(source.root, file.path)), {
        flag: "wx",
        mode: file.path === "distilly" ? 0o700 : 0o600,
      });
    }
    await writeFile(join(staging, PREVIEW_RUNTIME_MANIFEST), manifestBytes, {
      flag: "wx",
      mode: 0o600,
    });
    await chmod(join(staging, "distilly"), 0o700);
    const verified = await inspectPreviewRuntimePackage(staging);
    if (
      verified.manifestDigest !== source.manifestDigest ||
      verified.releaseVersion !== source.releaseVersion
    ) {
      throw new Error("The installed runtime copy does not match its source package.");
    }
    await rename(staging, destination);
    return inspectPreviewRuntimePackage(destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
};

/**
 * Removes only an exact verified runtime package owned by one install manifest.
 *
 * @param root - Exact version directory.
 * @param expectedManifestDigest - Digest stored by lifecycle setup.
 */
export const removePreviewRuntimePackage = async (
  root: string,
  expectedManifestDigest: ContentDigest,
): Promise<void> => {
  const verified = await inspectPreviewRuntimePackage(root);
  if (verified.manifestDigest !== expectedManifestDigest) {
    throw new Error("The installed Preview runtime manifest was modified.");
  }
  await rm(verified.root, { recursive: true });
};
