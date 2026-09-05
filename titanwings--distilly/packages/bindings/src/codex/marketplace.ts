import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { DistillyError } from "@distilly/protocol";

const PLUGIN_NAME = "distilly";
const SOURCE_PATH = "./plugins/distilly";

interface MarketplaceSnapshot {
  readonly path: string;
  readonly previous?: Uint8Array;
  readonly name: string;
}

const invalid = (message: string): DistillyError =>
  new DistillyError({ code: "invalid_input", message, retryable: false });

const parseMarketplace = (bytes: Uint8Array): Record<string, unknown> => {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw invalid("The personal Codex marketplace is not valid UTF-8 JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("The personal Codex marketplace must contain a JSON object.");
  }
  return value as Record<string, unknown>;
};

const readExisting = async (path: string): Promise<Uint8Array | undefined> => {
  try {
    return Uint8Array.from(await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const atomicWrite = async (path: string, bytes: Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.distilly-${randomUUID()}`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
};

const validateRoot = (
  payload: Record<string, unknown>,
): {
  readonly name: string;
  readonly plugins: unknown[];
} => {
  if (
    typeof payload.name !== "string" ||
    !/^[A-Za-z0-9_-]+$/u.test(payload.name) ||
    !Array.isArray(payload.plugins)
  ) {
    throw invalid("The personal Codex marketplace has an unsupported shape.");
  }
  return { name: payload.name, plugins: payload.plugins };
};

const isDistillyEntry = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (value as Record<string, unknown>).name === PLUGIN_NAME;

const assertOwnedEntry = (entry: Record<string, unknown>): void => {
  const source = entry.source;
  if (
    source === null ||
    typeof source !== "object" ||
    Array.isArray(source) ||
    (source as Record<string, unknown>).source !== "local" ||
    (source as Record<string, unknown>).path !== SOURCE_PATH
  ) {
    throw invalid("The existing Codex marketplace entry named distilly is owned elsewhere.");
  }
};

const distillyEntry = (): Record<string, unknown> => ({
  name: PLUGIN_NAME,
  source: { source: "local", path: SOURCE_PATH },
  policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
  category: "Productivity",
});

/**
 * Adds or refreshes only Distilly's entry in the default personal marketplace.
 *
 * @param homeDirectory - Explicit user home that owns the personal marketplace.
 * @returns Exact previous bytes and validated marketplace name for rollback/add.
 */
export const installMarketplaceEntry = async (
  homeDirectory: string,
): Promise<MarketplaceSnapshot> => {
  const path = join(homeDirectory, ".agents", "plugins", "marketplace.json");
  const previous = await readExisting(path);
  const payload =
    previous === undefined
      ? {
          name: "personal",
          interface: { displayName: "Personal" },
          plugins: [] as unknown[],
        }
      : parseMarketplace(previous);
  const { name, plugins } = validateRoot(payload);
  const existingIndex = plugins.findIndex(isDistillyEntry);
  if (existingIndex >= 0) {
    assertOwnedEntry(plugins[existingIndex] as Record<string, unknown>);
    plugins[existingIndex] = distillyEntry();
  } else {
    plugins.push(distillyEntry());
  }
  await atomicWrite(path, Buffer.from(`${JSON.stringify(payload, undefined, 2)}\n`, "utf8"));
  return { path, ...(previous === undefined ? {} : { previous }), name };
};

/**
 * Restores the marketplace exactly after a failed Codex installation.
 *
 * @param snapshot - Bytes captured before the failed update.
 * @returns Completion after exact restoration or removal.
 */
export const restoreMarketplace = async (snapshot: MarketplaceSnapshot): Promise<void> => {
  if (snapshot.previous === undefined) {
    await rm(snapshot.path, { force: true });
    return;
  }
  await atomicWrite(snapshot.path, snapshot.previous);
};

/**
 * Reads the validated personal marketplace name without changing it.
 *
 * @param homeDirectory - Explicit user home that owns the marketplace.
 * @returns Marketplace name only when the owned Distilly entry exists.
 */
export const readMarketplaceName = async (homeDirectory: string): Promise<string | undefined> => {
  const path = join(homeDirectory, ".agents", "plugins", "marketplace.json");
  const bytes = await readExisting(path);
  if (bytes === undefined) return undefined;
  const { name, plugins } = validateRoot(parseMarketplace(bytes));
  const entry = plugins.find(isDistillyEntry);
  if (entry === undefined) return undefined;
  assertOwnedEntry(entry);
  return name;
};

/**
 * Removes only the exact local Distilly entry and preserves every unrelated field.
 *
 * @param homeDirectory - Explicit user home that owns the marketplace.
 * @returns Marketplace name, or undefined when the file is absent.
 */
export const uninstallMarketplaceEntry = async (
  homeDirectory: string,
): Promise<string | undefined> => {
  const path = join(homeDirectory, ".agents", "plugins", "marketplace.json");
  const previous = await readExisting(path);
  if (previous === undefined) return undefined;
  const payload = parseMarketplace(previous);
  const { name, plugins } = validateRoot(payload);
  const index = plugins.findIndex(isDistillyEntry);
  if (index < 0) return name;
  assertOwnedEntry(plugins[index] as Record<string, unknown>);
  plugins.splice(index, 1);
  await atomicWrite(path, Buffer.from(`${JSON.stringify(payload, undefined, 2)}\n`, "utf8"));
  return name;
};
