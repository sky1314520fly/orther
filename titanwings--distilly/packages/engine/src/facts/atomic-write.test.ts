import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  atomicCreateDirectory,
  atomicCreateFile,
  atomicReplaceFile,
  ensurePrivateDirectory,
} from "./atomic-write.js";

const roots: string[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "distilly-engine-atomic-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("atomic fact publication", () => {
  it("leaves the previous file visible when failure happens before rename", async () => {
    const root = await makeRoot();
    const target = join(root, "facts", "state.json");
    await atomicReplaceFile(root, target, "previous");

    await expect(
      atomicReplaceFile(root, target, "target", {
        beforeCommit() {
          throw new Error("injected before rename");
        },
      }),
    ).rejects.toThrow(/injected/u);
    await expect(readFile(target, "utf8")).resolves.toBe("previous");
  });

  it("removes the synchronized temporary file when a pre-commit hook fails", async () => {
    const root = await makeRoot();
    const parent = join(root, "facts");
    const target = join(parent, "state.json");

    await expect(
      atomicReplaceFile(root, target, "target", {
        afterTemporarySync() {
          throw new Error("injected after temporary sync");
        },
      }),
    ).rejects.toThrow(/injected/u);
    await expect(readdir(parent)).resolves.toEqual([]);
  });

  it("leaves the complete target visible when failure happens after rename", async () => {
    const root = await makeRoot();
    const target = join(root, "facts", "state.json");
    await atomicReplaceFile(root, target, "previous");

    await expect(
      atomicReplaceFile(root, target, "target", {
        afterCommit() {
          throw new Error("injected after rename");
        },
      }),
    ).rejects.toThrow(/injected/u);
    await expect(readFile(target, "utf8")).resolves.toBe("target");
  });

  it("does not replace immutable files on collision", async () => {
    const root = await makeRoot();
    const target = join(root, "facts", "event.json");
    await atomicCreateFile(root, target, "first");
    await expect(atomicCreateFile(root, target, "second")).rejects.toMatchObject({
      code: "EEXIST",
    });
    await expect(readFile(target, "utf8")).resolves.toBe("first");
  });

  it("publishes an immutable directory only after all children are durable", async () => {
    const root = await makeRoot();
    const target = join(root, "materials", "mat");
    await expect(
      atomicCreateDirectory(
        root,
        target,
        async (temporary) => {
          await writeFile(join(temporary, "material.json"), "fact", { mode: 0o600 });
          await writeFile(join(temporary, "content.txt"), "body", { mode: 0o600 });
        },
        {
          beforeCommit() {
            throw new Error("injected directory failure");
          },
        },
      ),
    ).rejects.toThrow(/injected/u);
    await expect(readFile(join(target, "content.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });

    await atomicCreateDirectory(root, target, async (temporary) => {
      await writeFile(join(temporary, "material.json"), "fact", { mode: 0o600 });
      await writeFile(join(temporary, "content.txt"), "body", { mode: 0o600 });
    });
    await expect(readFile(join(target, "material.json"), "utf8")).resolves.toBe("fact");
    await expect(readFile(join(target, "content.txt"), "utf8")).resolves.toBe("body");
  });

  it.runIf(process.platform !== "win32")(
    "creates private fact directories and files with owner-only modes",
    async () => {
      const root = await makeRoot();
      const facts = join(root, "facts");
      const mutable = join(facts, "state.json");
      const immutable = join(facts, "event.json");
      const materials = join(root, "materials");
      const material = join(materials, "mat");

      await atomicReplaceFile(root, mutable, "state");
      await atomicCreateFile(root, immutable, "event");
      await atomicCreateDirectory(root, material, async (temporary) => {
        await atomicCreateFile(root, join(temporary, "material.json"), "fact");
        await atomicCreateFile(root, join(temporary, "content.txt"), "body");
      });

      const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;
      await expect(mode(facts)).resolves.toBe(0o700);
      await expect(mode(materials)).resolves.toBe(0o700);
      await expect(mode(material)).resolves.toBe(0o700);
      await expect(mode(mutable)).resolves.toBe(0o600);
      await expect(mode(immutable)).resolves.toBe(0o600);
      await expect(mode(join(material, "material.json"))).resolves.toBe(0o600);
      await expect(mode(join(material, "content.txt"))).resolves.toBe(0o600);
    },
  );

  it("rejects a symlinked fact ancestor before writing through it", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await ensurePrivateDirectory(join(root, "facts"));
    await symlink(outside, join(root, "facts", "escape"));

    await expect(
      atomicReplaceFile(root, join(root, "facts", "escape", "state.json"), "nope"),
    ).rejects.toMatchObject({ code: "storage_corrupt" });
    await expect(readFile(join(outside, "state.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not chmod through a symlink passed as a private directory", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const linkedDirectory = join(root, "linked-directory");
    await symlink(outside, linkedDirectory);

    await expect(ensurePrivateDirectory(linkedDirectory)).rejects.toMatchObject({
      code: "storage_corrupt",
    });
  });
});
