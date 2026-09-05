import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DistillyError } from "@distilly/protocol";
import type { FactEnvelope, RuntimeSchema } from "@distilly/protocol";

import { sealFact } from "./checksum.js";
import { createFactFile, readFactFile, readMutableFactFile, replaceFactFile } from "./fact-file.js";

interface LargeFact extends FactEnvelope<1> {
  readonly payload: string;
}

const largeFactSchema: RuntimeSchema<LargeFact> = {
  parse(value) {
    if (
      typeof value !== "object" ||
      value === null ||
      (value as { readonly schemaVersion?: unknown }).schemaVersion !== 1 ||
      typeof (value as { readonly checksum?: unknown }).checksum !== "string" ||
      typeof (value as { readonly payload?: unknown }).payload !== "string"
    ) {
      throw new Error("invalid large fact");
    }
    return value as LargeFact;
  },
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("generic fact files", () => {
  it("does not reuse the MCP input limit for an accumulating fact", async () => {
    const root = await mkdtemp(join(tmpdir(), "distilly-large-fact-"));
    roots.push(root);
    const path = join(root, "state.json");
    const fact = sealFact<LargeFact>({
      schemaVersion: 1,
      payload: "x".repeat(4_194_305),
    });

    await createFactFile(root, path, fact, largeFactSchema);

    await expect(readFactFile(root, path, largeFactSchema)).resolves.toEqual(fact);
  });

  it("retries a proven atomic replacement race for mutable facts only", async () => {
    const root = await mkdtemp(join(tmpdir(), "distilly-mutable-fact-"));
    roots.push(root);
    const path = join(root, "state.json");
    const previous = sealFact<LargeFact>({ schemaVersion: 1, payload: "previous" });
    const target = sealFact<LargeFact>({ schemaVersion: 1, payload: "target" });
    await createFactFile(root, path, previous, largeFactSchema);

    let replaced = false;
    await expect(
      readMutableFactFile(root, path, largeFactSchema, {
        async afterTargetStat() {
          if (replaced) return;
          replaced = true;
          await replaceFactFile(root, path, target, largeFactSchema);
        },
      }),
    ).resolves.toEqual(target);

    let next = previous;
    try {
      await readMutableFactFile(root, path, largeFactSchema, {
        async afterTargetStat() {
          next = next.payload === previous.payload ? target : previous;
          await replaceFactFile(root, path, next, largeFactSchema);
        },
      });
      throw new Error("Expected a retryable busy result.");
    } catch (error) {
      expect(error).toBeInstanceOf(DistillyError);
      expect(error).toMatchObject({ code: "busy", retryable: true });
    }
  });
});
