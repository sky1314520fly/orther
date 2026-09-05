import { lstat, readFile, realpath } from "node:fs/promises";
import { parse, resolve } from "node:path";

/** Immutable static asset loaded before the listener opens. */
interface PanelAsset {
  readonly body: Buffer;
  readonly contentType: string;
}

type PanelAssets = ReadonlyMap<string, PanelAsset>;

const ASSET_FILES = [
  { name: "index.html", contentType: "text/html; charset=utf-8" },
  { name: "app.js", contentType: "text/javascript; charset=utf-8" },
  { name: "app.css", contentType: "text/css; charset=utf-8" },
] as const;

const assertNoSymlinkChain = async (
  path: string,
  finalKind: "directory" | "file",
): Promise<void> => {
  const parsed = parse(path);
  let current = parsed.root;
  const segments = path.slice(parsed.root.length).split("/").filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error("Panel asset paths must not traverse symlinks.");
    const isFinal = index === segments.length - 1;
    if (!isFinal && !stat.isDirectory()) {
      throw new Error("Panel asset ancestors must be real directories.");
    }
    if (isFinal && finalKind === "directory" && !stat.isDirectory()) {
      throw new Error("Panel assetsDir must be a real directory.");
    }
    if (isFinal && finalKind === "file" && !stat.isFile()) {
      throw new Error("Panel assets must be regular files.");
    }
  }
};

/**
 * Loads the three fixed Panel assets after rejecting symlinks and non-files.
 *
 * @param assetsDir - Directory containing exactly the expected local asset names.
 * @returns Preloaded immutable bytes keyed by fixed request paths.
 */
export const loadPanelAssets = async (assetsDir: string): Promise<PanelAssets> => {
  const configuredDirectory = resolve(assetsDir);
  await assertNoSymlinkChain(configuredDirectory, "directory");
  const directoryStat = await lstat(configuredDirectory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error("Panel assetsDir must be a real directory, not a symlink.");
  }

  const canonicalDirectory = await realpath(configuredDirectory);
  if (canonicalDirectory !== configuredDirectory) {
    throw new Error("Panel assetsDir must not traverse a symlink.");
  }

  const loaded = new Map<string, PanelAsset>();
  for (const asset of ASSET_FILES) {
    const configuredPath = resolve(configuredDirectory, asset.name);
    await assertNoSymlinkChain(configuredPath, "file");
    const before = await lstat(configuredPath);
    if (before.isSymbolicLink() || !before.isFile()) {
      throw new Error(`Panel asset ${asset.name} must be a regular file, not a symlink.`);
    }
    const canonicalPath = await realpath(configuredPath);
    if (canonicalPath !== resolve(canonicalDirectory, asset.name)) {
      throw new Error(`Panel asset ${asset.name} must not traverse a symlink.`);
    }
    const body = await readFile(configuredPath);
    const after = await lstat(configuredPath);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      body.byteLength !== after.size
    ) {
      throw new Error(`Panel asset ${asset.name} changed while it was loaded.`);
    }
    loaded.set(`/${asset.name}`, { body, contentType: asset.contentType });
  }

  const index = loaded.get("/index.html");
  if (index === undefined) throw new Error("Panel index asset was not loaded.");
  loaded.set("/", index);
  return loaded;
};
