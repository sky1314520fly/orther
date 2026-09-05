import type { IsoDateTime } from "@distilly/protocol";

/** Clock seam used by fact timestamps and file-lock leases. */
export interface Clock {
  now(): IsoDateTime;
}

/** Production UTC clock with the canonical millisecond wire representation. */
export class SystemClock implements Clock {
  /**
   * Returns the current time as canonical UTC milliseconds.
   *
   * @returns The current instant in canonical wire format.
   */
  now(): IsoDateTime {
    return new Date().toISOString() as IsoDateTime;
  }
}
