import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PREVIEW_RUNTIME_MANIFEST,
  inspectPreviewRuntimePackage,
  installPreviewRuntimePackage,
  removePreviewRuntimePackage,
} from "./runtime-package.js";

const roots: string[] = [];
const compareUtf8 = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
const digest = (bytes: Uint8Array | string): `sha256_${string}` =>
  `sha256_${createHash("sha256").update(bytes).digest("hex")}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async (): Promise<{ readonly parent: string; readonly source: string }> => {
  const parent = await mkdtemp(join(tmpdir(), "distilly-runtime-package-"));
  roots.push(parent);
  const source = join(parent, "Preview 包");
  await mkdir(source);
  const contents = new Map<string, string>([
    ["distilly", "#!/bin/sh\nexit 0\n"],
    ["package.json", '{"name":"@distilly/codex-preview","version":"0.1.0-preview.1"}\n'],
    ["packages/cli/lib/bin.js", "// production entry\n"],
    ["packages/panel/web/index.html", "<!doctype html>\n"],
    ["packages/prompts/host-distill-v1.md", "# Host prompt\n"],
    ["plugins/release-manifest.json", '{"releaseVersion":"0.1.0-preview.1"}\n'],
    ["plugins/codex/.codex-plugin/plugin.json", '{"name":"distilly"}\n'],
    ["plugins/codex/skills/distilly/SKILL.md", "# Distilly\n"],
    ["plugins/claude-code/.claude-plugin/plugin.json", '{"name":"distilly"}\n'],
    ["plugins/claude-code/skills/distilly/SKILL.md", "# Distilly\n"],
    ["plugins/shared/skills/distilly/SKILL.md", "# Distilly\n"],
  ]);
  for (const [path, content] of contents) {
    const target = join(source, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const files = [...contents]
    .map(([path, content]) => ({ path, contentDigest: digest(content) }))
    .sort((left, right) => compareUtf8(left.path, right.path));
  await writeFile(
    join(source, PREVIEW_RUNTIME_MANIFEST),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        releaseVersion: "0.1.0-preview.1",
        entryPath: "packages/cli/lib/bin.js",
        pluginSourcesPath: "plugins",
        panelAssetsPath: "packages/panel/web",
        files,
      },
      undefined,
      2,
    )}\n`,
  );
  return { parent, source };
};

describe("Preview runtime package ownership", () => {
  it("copies a verified tree and removes only the exact owned version", async () => {
    const { parent, source } = await fixture();
    const verified = await inspectPreviewRuntimePackage(source);
    const destination = join(parent, "runtime", "0.1.0-preview.1");
    await mkdir(dirname(destination));

    const installed = await installPreviewRuntimePackage(verified, destination);
    expect(installed.manifestDigest).toBe(verified.manifestDigest);
    await expect(readFile(installed.entryPath, "utf8")).resolves.toBe("// production entry\n");

    await removePreviewRuntimePackage(destination, installed.manifestDigest);
    await expect(readFile(installed.entryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a modified owned byte and leaves the runtime tree in place", async () => {
    const { parent, source } = await fixture();
    const verified = await inspectPreviewRuntimePackage(source);
    const destination = join(parent, "runtime", "0.1.0-preview.1");
    await mkdir(dirname(destination));
    const installed = await installPreviewRuntimePackage(verified, destination);
    await writeFile(installed.entryPath, "// tampered entry\n");

    await expect(inspectPreviewRuntimePackage(destination)).rejects.toThrow(/modified/u);
    await expect(
      removePreviewRuntimePackage(destination, installed.manifestDigest),
    ).rejects.toThrow(/modified/u);
    await expect(readFile(installed.entryPath, "utf8")).resolves.toBe("// tampered entry\n");
  });

  it("rejects files not owned by the package manifest", async () => {
    const { source } = await fixture();
    await writeFile(join(source, ".mcp.json.template"), "forbidden\n");
    await expect(inspectPreviewRuntimePackage(source)).rejects.toThrow(/unowned/u);
  });
});
