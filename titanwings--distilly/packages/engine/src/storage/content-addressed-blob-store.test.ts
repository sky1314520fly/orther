import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContentDigest } from "@distilly/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { BlobAccessGate } from "./blob-access-gate.js";
import { ContentAddressedBlobStore } from "./content-addressed-blob-store.js";

const roots: string[] = [];

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "distilly-blobs-"));
  roots.push(root);
  return root;
};

const digestFor = (value: string | Uint8Array): ContentDigest => {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return `sha256_${createHash("sha256").update(bytes).digest("hex")}` as ContentDigest;
};

const pathFor = (root: string, digest: ContentDigest): string => {
  const hex = digest.slice("sha256_".length);
  return join(root, "blobs", "sha256", hex.slice(0, 2), digest);
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ContentAddressedBlobStore", () => {
  it("publishes exact immutable bytes with a private mode and reuses identical content", async () => {
    const root = await temporaryRoot();
    const store = await ContentAddressedBlobStore.open(root);
    const content = "Distill how they think.\n";
    const digest = digestFor(content);

    const first = await store.put(digest, content);
    const second = await store.put(digest, new TextEncoder().encode(content));
    expect(first).toMatchObject({
      digest,
      byteLength: Buffer.byteLength(content),
      created: true,
    });
    expect(second).toMatchObject({
      digest,
      byteLength: Buffer.byteLength(content),
      created: false,
    });
    expect(await readFile(pathFor(root, digest), "utf8")).toBe(content);
    if (process.platform !== "win32") {
      expect((await stat(pathFor(root, digest))).mode & 0o777).toBe(0o600);
    }
    await Promise.all([first.release(), second.release()]);
  });

  it("rejects a declared digest mismatch and an existing conflicting target", async () => {
    const root = await temporaryRoot();
    const store = await ContentAddressedBlobStore.open(root);
    const digest = digestFor("expected");
    await expect(store.put(digest, "different")).rejects.toMatchObject({
      code: "storage_corrupt",
    });

    const target = pathFor(root, digest);
    await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
    await writeFile(target, "tampered", { mode: 0o600 });
    await expect(store.put(digest, "expected")).rejects.toMatchObject({
      code: "storage_corrupt",
    });
  });

  it("uses no-replace CAS for concurrent identical puts", async () => {
    const root = await temporaryRoot();
    const store = await ContentAddressedBlobStore.open(root);
    const content = "same bytes";
    const digest = digestFor(content);
    const leases = await Promise.all(Array.from({ length: 8 }, () => store.put(digest, content)));
    expect(await readFile(pathFor(root, digest), "utf8")).toBe(content);
    expect(new Set(leases.map((lease) => lease.digest))).toEqual(new Set([digest]));
    await Promise.all(leases.map((lease) => lease.release()));
  });

  it("rejects a symlink inside the fixed blob hierarchy", async () => {
    const root = await temporaryRoot();
    const store = await ContentAddressedBlobStore.open(root);
    const outside = await temporaryRoot();
    const digest = digestFor("linked target");
    const prefix = digest.slice("sha256_".length, "sha256_".length + 2);
    await symlink(outside, join(root, "blobs", "sha256", prefix), "dir");
    await expect(store.put(digest, "linked target")).rejects.toMatchObject({
      code: "storage_corrupt",
    });
  });

  it("maps a malformed blob ancestor without exposing the configured root", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "blobs"), "not a directory");

    try {
      await ContentAddressedBlobStore.open(root);
      throw new Error("Expected storage_corrupt.");
    } catch (error) {
      expect(error).toMatchObject({ code: "storage_corrupt" });
      expect(String((error as Error).message)).not.toContain(root);
    }
  });

  it("keeps one shared mutation lease across a queued writer and later puts", async () => {
    const root = await temporaryRoot();
    const store = await ContentAddressedBlobStore.open(root);
    const mutation = await store.acquireMutationAccess();
    const firstDigest = digestFor("first");
    await expect(mutation.verify(firstDigest, "first")).resolves.toBeUndefined();
    await mutation.put(firstDigest, "first");
    await expect(mutation.verify(firstDigest, "first")).resolves.toMatchObject({
      created: false,
    });
    let maintenanceEntered = false;
    const maintenancePromise = store.acquireMaintenanceAccess().then((lease) => {
      maintenanceEntered = true;
      return lease;
    });

    await expect(mutation.read(firstDigest, Buffer.byteLength("first"))).resolves.toEqual(
      new TextEncoder().encode("first"),
    );
    await expect(mutation.put(digestFor("second"), "second")).resolves.toMatchObject({
      created: true,
    });
    expect(maintenanceEntered).toBe(false);
    await mutation.release();
    const maintenance = await maintenancePromise;
    expect(maintenanceEntered).toBe(true);
    await maintenance.release();
    await expect(mutation.put(digestFor("too late"), "too late")).rejects.toMatchObject({
      code: "storage_corrupt",
    });
  });

  it("reads verified bytes without reacquiring shared access behind a queued writer", async () => {
    const root = await temporaryRoot();
    const store = await ContentAddressedBlobStore.open(root);
    const content = "snapshot-bound bytes";
    const digest = digestFor(content);
    const put = await store.put(digest, content);
    await put.release();

    const read = await store.acquireReadAccess();
    let maintenanceEntered = false;
    const maintenancePromise = store.acquireMaintenanceAccess().then((lease) => {
      maintenanceEntered = true;
      return lease;
    });

    await expect(read.read(digest, Buffer.byteLength(content))).resolves.toEqual(
      new TextEncoder().encode(content),
    );
    expect(maintenanceEntered).toBe(false);
    await read.release();
    const maintenance = await maintenancePromise;
    expect(maintenanceEntered).toBe(true);
    await maintenance.release();
    await expect(read.read(digest, Buffer.byteLength(content))).rejects.toMatchObject({
      code: "storage_corrupt",
    });
  });

  it("rejects missing, length-mismatched, and digest-mismatched blob reads", async () => {
    const root = await temporaryRoot();
    const store = await ContentAddressedBlobStore.open(root);
    const content = "verified bytes";
    const digest = digestFor(content);
    const put = await store.put(digest, content);
    await put.release();
    const read = await store.acquireReadAccess();

    await expect(read.read(digest, Buffer.byteLength(content) + 1)).rejects.toMatchObject({
      code: "storage_corrupt",
    });
    await expect(
      read.read(digestFor("missing"), Buffer.byteLength("missing")),
    ).rejects.toMatchObject({ code: "storage_corrupt" });
    await writeFile(pathFor(root, digest), "tampered bytes", { mode: 0o600 });
    await expect(read.read(digest, Buffer.byteLength("tampered bytes"))).rejects.toMatchObject({
      code: "storage_corrupt",
    });
    await expect(read.read(digest, -1)).rejects.toMatchObject({ code: "storage_corrupt" });
    await read.release();
  });

  it("holds the put lease until release and gives queued maintenance writer priority", async () => {
    const root = await temporaryRoot();
    const store = await ContentAddressedBlobStore.open(root);
    const putLease = await store.put(digestFor("leased"), "leased");
    let maintenanceEntered = false;
    const maintenancePromise = store.acquireMaintenanceAccess().then((lease) => {
      maintenanceEntered = true;
      return lease;
    });
    const nextReadPromise = store.acquireReadAccess();
    await Promise.resolve();
    expect(maintenanceEntered).toBe(false);

    await putLease.release();
    const maintenance = await maintenancePromise;
    expect(maintenanceEntered).toBe(true);
    let readEntered = false;
    void nextReadPromise.then(() => {
      readEntered = true;
    });
    await Promise.resolve();
    expect(readEntered).toBe(false);
    await maintenance.release();
    const nextRead = await nextReadPromise;
    expect(readEntered).toBe(true);
    await nextRead.release();
  });
});

describe("BlobAccessGate", () => {
  it("allows concurrent shared access and idempotent release", async () => {
    const gate = new BlobAccessGate();
    const first = await gate.acquireShared();
    const second = await gate.acquireShared();
    expect(first.mode).toBe("shared");
    expect(second.mode).toBe("shared");
    await first.release();
    await first.release();
    await second.release();
    const exclusive = await gate.acquireExclusive();
    expect(exclusive.mode).toBe("exclusive");
    await exclusive.release();
  });
});
