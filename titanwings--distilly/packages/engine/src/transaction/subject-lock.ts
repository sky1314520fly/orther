import type { SubjectId } from "@distilly/protocol";

import type { Clock } from "../defaults/system-clock.js";
import { SystemClock } from "../defaults/system-clock.js";
import type { Layout } from "../layout.js";
import { FileLock } from "./file-lock.js";
import type { FileLockLease } from "./file-lock.js";

/** Cross-process writer lock scoped to one subject candidate. */
export class FileSubjectLock {
  private readonly layout: Layout;
  private readonly clock: Clock;

  /**
   * Creates the lock service for one fact layout.
   *
   * @param layout - Confined fact-layout paths.
   * @param clock - Clock used by owner heartbeats and stale recovery.
   */
  constructor(layout: Layout, clock: Clock = new SystemClock()) {
    this.layout = layout;
    this.clock = clock;
  }

  /**
   * Acquires the candidate-safe lock for one subject.
   *
   * @param subjectId - Existing or not-yet-published subject id.
   * @returns The owner-bound lock lease.
   */
  acquire(subjectId: SubjectId): Promise<FileLockLease> {
    return new FileLock(this.layout.root, this.layout.subjectLock(subjectId), this.clock).acquire();
  }
}
