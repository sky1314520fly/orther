import { chmod } from "node:fs/promises";
import { join } from "node:path";

import { DistillyError, contentDigestSchema } from "@distilly/protocol";
import type { ContentDigest } from "@distilly/protocol";

import { atomicCreateFile } from "../facts/atomic-write.js";
import { sha256Hex } from "../facts/checksum.js";
import { readRegularFile } from "../facts/safe-fs.js";
import { storageCorrupt } from "../internal-errors.js";
import { BlobAccessGate } from "./blob-access-gate.js";
import type { BlobStoreAccessLease } from "./blob-access-gate.js";
import { StorageLayout } from "./storage-layout.js";
import { throwMappedStorageError } from "./storage-errors.js";

const DIGEST_PREFIX = "sha256_";

const hasCode = (error: unknown, code: string): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === code;

const bytesFor = (value: string | Uint8Array): Uint8Array =>
  typeof value === "string" ? new TextEncoder().encode(value) : Uint8Array.from(value);

const parseDigest = (digest: ContentDigest): ContentDigest => {
  try {
    return contentDigestSchema.parse(digest);
  } catch (error) {
    throw storageCorrupt("Blob access received an invalid content digest.", error);
  }
};

const parseExpectedByteLength = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw storageCorrupt("Blob read received an invalid expected byte length.");
  }
  return value;
};

/** Put result whose shared access lease remains held until explicit release. */
export interface BlobAccessLease {
  readonly digest: ContentDigest;
  readonly byteLength: number;
  readonly created: boolean;
  release(): Promise<void>;
}

/** Result of one immutable put performed under a caller-owned mutation lease. */
export interface BlobPutResult {
  readonly digest: ContentDigest;
  readonly byteLength: number;
  readonly created: boolean;
}

/** Shared blob access held while verified immutable bytes are read. */
export interface BlobReadAccessLease {
  read(digest: ContentDigest, expectedByteLength: number): Promise<Uint8Array>;
  release(): Promise<void>;
}

/** Shared blob access held across every put and the referencing SQLite transaction. */
export interface BlobMutationAccessLease extends BlobReadAccessLease {
  verify(digest: ContentDigest, value: string | Uint8Array): Promise<BlobPutResult | undefined>;
  put(digest: ContentDigest, value: string | Uint8Array): Promise<BlobPutResult>;
}

interface TrackedBlobAccess {
  run<T>(operation: () => Promise<T>, fallbackMessage: string): Promise<T>;
  release(): Promise<void>;
}

const trackBlobAccess = (access: BlobStoreAccessLease): TrackedBlobAccess => {
  const inFlight = new Set<Promise<unknown>>();
  let releasePromise: Promise<void> | undefined;
  return {
    run: <T>(operation: () => Promise<T>, fallbackMessage: string): Promise<T> => {
      try {
        if (releasePromise !== undefined) {
          throw storageCorrupt("A released blob access lease cannot access bytes.");
        }
        const pending = operation();
        inFlight.add(pending);
        void pending.then(
          () => inFlight.delete(pending),
          () => inFlight.delete(pending),
        );
        return pending;
      } catch (error) {
        return Promise.reject(
          error instanceof Error ? error : storageCorrupt(fallbackMessage, error),
        );
      }
    },
    release: () => {
      if (releasePromise !== undefined) return releasePromise;
      releasePromise = (async () => {
        await Promise.allSettled([...inFlight]);
        await access.release();
      })();
      return releasePromise;
    },
  };
};

const wrapPutLease = (
  digest: ContentDigest,
  byteLength: number,
  created: boolean,
  access: Pick<BlobMutationAccessLease, "release">,
): BlobAccessLease => ({
  digest,
  byteLength,
  created,
  release: () => access.release(),
});

/** Immutable local content-addressed blob store backed by SHA-256 files. */
export class ContentAddressedBlobStore {
  private constructor(
    private readonly layout: StorageLayout,
    private readonly accessGate: BlobAccessGate,
  ) {}

  /**
   * Opens the fixed private blob hierarchy for one DISTILLY_ROOT.
   *
   * @param root - Configured DISTILLY_ROOT.
   * @returns A content-addressed blob store with one in-process access gate.
   */
  static async open(root: string): Promise<ContentAddressedBlobStore> {
    const layout = new StorageLayout(root);
    try {
      await layout.prepareBlobRoot();
      return new ContentAddressedBlobStore(layout, new BlobAccessGate());
    } catch (error) {
      return throwMappedStorageError(error, "open its local blob store");
    }
  }

  /**
   * Publishes immutable bytes under an already-derived full content digest.
   *
   * The returned shared lease intentionally remains active so the caller can
   * hold it through the SQLite transaction that creates the blob reference.
   *
   * @param digest - Expected full SHA-256 content digest.
   * @param value - Exact immutable text or bytes to publish.
   * @returns Digest, byte length, and the still-active put lease.
   */
  async put(digest: ContentDigest, value: string | Uint8Array): Promise<BlobAccessLease> {
    const access = await this.acquireMutationAccess();
    try {
      const result = await access.put(digest, value);
      return wrapPutLease(result.digest, result.byteLength, result.created, access);
    } catch (error) {
      await access.release();
      throw error;
    }
  }

  /**
   * Acquires one shared lease for a complete business mutation.
   *
   * Reusing this lease for every put prevents a queued maintenance writer from
   * splitting a multi-blob publish and deadlocking the mutation that owns the
   * older shared access. The caller releases it immediately after COMMIT or
   * ROLLBACK, before running post-commit observers.
   *
   * @returns A mutation-scoped immutable put surface and its release operation.
   */
  async acquireMutationAccess(): Promise<BlobMutationAccessLease> {
    const access = await this.accessGate.acquireShared();
    const tracked = trackBlobAccess(access);
    return {
      read: (digest, expectedByteLength) =>
        tracked.run(
          () => this.readWithAccess(digest, expectedByteLength),
          "Blob read failed unexpectedly.",
        ),
      verify: (digest, value) =>
        tracked.run(
          () => this.verifyWithAccess(digest, value),
          "Blob verification failed unexpectedly.",
        ),
      put: (digest, value) =>
        tracked.run(
          () => this.putWithAccess(digest, value),
          "Blob publication failed unexpectedly.",
        ),
      release: () => tracked.release(),
    };
  }

  /**
   * Acquires shared access for a snapshot-bound verified blob read.
   *
   * The returned read surface uses this already-held lease instead of taking a
   * nested shared lease, so a queued fair maintenance writer cannot deadlock it.
   *
   * @returns A verified read surface that excludes maintenance until released.
   */
  async acquireReadAccess(): Promise<BlobReadAccessLease> {
    const access = await this.accessGate.acquireShared();
    const tracked = trackBlobAccess(access);
    return {
      read: (digest, expectedByteLength) =>
        tracked.run(
          () => this.readWithAccess(digest, expectedByteLength),
          "Blob read failed unexpectedly.",
        ),
      release: () => tracked.release(),
    };
  }

  /**
   * Acquires exclusive access for generic future maintenance.
   *
   * This is only the in-process latch; it does not implement a GC task.
   *
   * @returns A lease that begins after every older read or put lease exits.
   */
  acquireMaintenanceAccess(): Promise<BlobStoreAccessLease> {
    return this.accessGate.acquireExclusive();
  }

  private pathFor(digest: ContentDigest): string {
    const hex = digest.slice(DIGEST_PREFIX.length);
    return join(this.layout.sha256Directory, hex.slice(0, 2), digest);
  }

  private async putWithAccess(
    digest: ContentDigest,
    value: string | Uint8Array,
  ): Promise<BlobPutResult> {
    const parsedDigest = parseDigest(digest);
    const bytes = bytesFor(value);
    const actualDigest = `${DIGEST_PREFIX}${sha256Hex(bytes)}` as ContentDigest;
    if (actualDigest !== parsedDigest) {
      throw storageCorrupt("Blob bytes do not match their declared content digest.");
    }

    try {
      const target = this.pathFor(parsedDigest);
      let created = true;
      try {
        await atomicCreateFile(this.layout.root, target, bytes);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        created = false;
        await this.verifyExisting(target, parsedDigest, bytes);
      }
      await chmod(target, 0o600);
      return { digest: parsedDigest, byteLength: bytes.byteLength, created };
    } catch (error) {
      return throwMappedStorageError(error, "write its local blob store");
    }
  }

  private async readWithAccess(
    digest: ContentDigest,
    expectedByteLength: number,
  ): Promise<Uint8Array> {
    const parsedDigest = parseDigest(digest);
    const parsedByteLength = parseExpectedByteLength(expectedByteLength);
    try {
      const bytes = await readRegularFile(
        this.layout.root,
        this.pathFor(parsedDigest),
        parsedByteLength,
      );
      const actualDigest = `${DIGEST_PREFIX}${sha256Hex(bytes)}`;
      if (bytes.byteLength !== parsedByteLength || actualDigest !== parsedDigest) {
        throw storageCorrupt("A content-addressed blob conflicts with its digest or length.");
      }
      return Uint8Array.from(bytes);
    } catch (error) {
      if (error instanceof DistillyError && error.code === "not_found") {
        throw storageCorrupt("A referenced content-addressed blob is missing.", error);
      }
      return throwMappedStorageError(error, "read its local blob store");
    }
  }

  private async verifyWithAccess(
    digest: ContentDigest,
    value: string | Uint8Array,
  ): Promise<BlobPutResult | undefined> {
    const parsedDigest = parseDigest(digest);
    const bytes = bytesFor(value);
    const actualDigest = `${DIGEST_PREFIX}${sha256Hex(bytes)}` as ContentDigest;
    if (actualDigest !== parsedDigest) {
      throw storageCorrupt("Blob bytes do not match their declared content digest.");
    }

    try {
      const exists = await this.readAndVerifyExisting(
        this.pathFor(parsedDigest),
        parsedDigest,
        bytes,
      );
      return exists
        ? { digest: parsedDigest, byteLength: bytes.byteLength, created: false }
        : undefined;
    } catch (error) {
      return throwMappedStorageError(error, "verify its local blob store");
    }
  }

  private async verifyExisting(
    target: string,
    digest: ContentDigest,
    expected: Uint8Array,
  ): Promise<void> {
    if (!(await this.readAndVerifyExisting(target, digest, expected))) {
      throw storageCorrupt("An existing content-addressed blob disappeared during verification.");
    }
  }

  private async readAndVerifyExisting(
    target: string,
    digest: ContentDigest,
    expected: Uint8Array,
  ): Promise<boolean> {
    let actual: Buffer;
    try {
      actual = await readRegularFile(this.layout.root, target, expected.byteLength);
    } catch (error) {
      if (error instanceof DistillyError && error.code === "not_found") return false;
      throw storageCorrupt("An existing content-addressed blob cannot be verified.", error);
    }
    const actualDigest = `${DIGEST_PREFIX}${sha256Hex(actual)}`;
    if (
      actual.byteLength !== expected.byteLength ||
      actualDigest !== digest ||
      !actual.equals(Buffer.from(expected))
    ) {
      throw storageCorrupt("An existing content-addressed blob conflicts with its digest.");
    }
    return true;
  }
}
