import type { RequestId } from "@distilly/protocol";

import type { Clock } from "../defaults/system-clock.js";
import { SystemClock } from "../defaults/system-clock.js";
import type { Layout } from "../layout.js";
import { FileLock } from "./file-lock.js";
import type { FileLockLease } from "./file-lock.js";

/** Cross-process lock for one globally unique RequestId. */
export class FileRequestLock {
  private readonly layout: Layout;
  private readonly clock: Clock;

  /**
   * Creates a request-lock factory for one fact layout.
   *
   * @param layout - Confined local fact layout.
   * @param clock - Clock used by the underlying file-lock lease.
   */
  constructor(layout: Layout, clock: Clock = new SystemClock()) {
    this.layout = layout;
    this.clock = clock;
  }

  /**
   * Acquires the root operation lock before any narrower mutation lock.
   *
   * @param requestId - Globally unique request identifier to serialize.
   * @returns A held request-lock lease.
   */
  acquire(requestId: RequestId): Promise<FileLockLease> {
    return new FileLock(this.layout.root, this.layout.requestLock(requestId), this.clock).acquire();
  }
}
