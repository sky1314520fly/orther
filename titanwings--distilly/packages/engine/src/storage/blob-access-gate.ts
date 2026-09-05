type AccessMode = "exclusive" | "shared";

interface Waiter {
  readonly mode: AccessMode;
  readonly resolve: (lease: BlobStoreAccessLease) => void;
}

/** In-process lease that prevents blob maintenance from racing active reads or puts. */
export interface BlobStoreAccessLease {
  readonly mode: AccessMode;
  release(): Promise<void>;
}

class GateLease implements BlobStoreAccessLease {
  private active = true;

  constructor(
    readonly mode: AccessMode,
    private readonly onRelease: () => void,
  ) {}

  release(): Promise<void> {
    if (!this.active) return Promise.resolve();
    this.active = false;
    this.onRelease();
    return Promise.resolve();
  }
}

/**
 * Fair in-process shared/exclusive gate for immutable blob access.
 *
 * The gate is deliberately non-durable: process exit releases it, while SQLite
 * and blob reachability remain the only durable authorities.
 */
export class BlobAccessGate {
  private sharedCount = 0;
  private exclusiveActive = false;
  private readonly waiters: Waiter[] = [];

  /**
   * Acquires access for one blob read or put.
   *
   * @returns A shared lease that must be released after the caller is finished.
   */
  async acquireShared(): Promise<BlobStoreAccessLease> {
    if (!this.exclusiveActive && this.waiters.length === 0) return this.grantShared();
    return new Promise((resolve) => {
      this.waiters.push({ mode: "shared", resolve });
      this.drain();
    });
  }

  /**
   * Acquires exclusive maintenance access after every older shared lease exits.
   *
   * @returns An exclusive lease that must be released after maintenance.
   */
  async acquireExclusive(): Promise<BlobStoreAccessLease> {
    if (!this.exclusiveActive && this.sharedCount === 0 && this.waiters.length === 0) {
      return this.grantExclusive();
    }
    return new Promise((resolve) => {
      this.waiters.push({ mode: "exclusive", resolve });
      this.drain();
    });
  }

  private grantShared(): BlobStoreAccessLease {
    this.sharedCount += 1;
    return new GateLease("shared", () => {
      this.sharedCount -= 1;
      this.drain();
    });
  }

  private grantExclusive(): BlobStoreAccessLease {
    this.exclusiveActive = true;
    return new GateLease("exclusive", () => {
      this.exclusiveActive = false;
      this.drain();
    });
  }

  private drain(): void {
    if (this.exclusiveActive || this.sharedCount > 0 || this.waiters.length === 0) return;
    const first = this.waiters[0];
    if (first?.mode === "exclusive") {
      this.waiters.shift();
      first.resolve(this.grantExclusive());
      return;
    }
    while (this.waiters[0]?.mode === "shared") {
      this.waiters.shift()!.resolve(this.grantShared());
    }
  }
}
