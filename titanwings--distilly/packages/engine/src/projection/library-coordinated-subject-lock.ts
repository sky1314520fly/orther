import type { SubjectId } from "@distilly/protocol";

import type { Clock } from "../defaults/system-clock.js";
import { SystemClock } from "../defaults/system-clock.js";
import { storageCorrupt } from "../internal-errors.js";
import type { Layout } from "../layout.js";
import type { FileLockLease } from "../transaction/file-lock.js";
import { FileSubjectLock } from "../transaction/subject-lock.js";
import type { CoordinatedLibraryProjection, LibraryWriterKind } from "./library-projection.js";

/**
 * Extends the canonical subject writer lock through the Library projection commit.
 *
 * Writers acquire request/identity locks before this subject lock, then reserve the
 * Library lock before reading or mutating facts. Releasing in reverse keeps Library
 * list/rebuild linearizable without making query scan facts or rebuild lock subjects.
 */
export class LibraryCoordinatedSubjectLock extends FileSubjectLock {
  readonly #library: Pick<CoordinatedLibraryProjection, "reserveWriter">;
  readonly #kind: LibraryWriterKind;

  /**
   * Creates a subject lock that extends through Library projection coordination.
   *
   * @param layout - Confined fact-root paths.
   * @param library - Coordinated Library lock seam.
   * @param clock - Shared lock clock.
   * @param kind - New-mutation or recovery reservation behavior.
   */
  constructor(
    layout: Layout,
    library: Pick<CoordinatedLibraryProjection, "reserveWriter">,
    clock: Clock = new SystemClock(),
    kind: LibraryWriterKind = "mutation",
  ) {
    super(layout, clock);
    this.#library = library;
    this.#kind = kind;
  }

  /**
   * Acquires the subject lock and then its Library reservation.
   *
   * @param subjectId - Subject whose facts may change.
   * @returns One combined lease released in Library-to-subject order.
   */
  override async acquire(subjectId: SubjectId): Promise<FileLockLease> {
    const subjectLease = await super.acquire(subjectId);
    let libraryLease: FileLockLease;
    try {
      libraryLease = await this.#library.reserveWriter(subjectId, this.#kind);
    } catch (error) {
      try {
        await subjectLease.release();
      } catch (releaseError) {
        throw storageCorrupt(
          "The subject lock could not be released after Library reservation failed.",
          new AggregateError([error, releaseError]),
        );
      }
      throw error;
    }

    return {
      ownerToken: subjectLease.ownerToken,
      async heartbeat(): Promise<void> {
        await Promise.all([subjectLease.heartbeat(), libraryLease.heartbeat()]);
      },
      async release(): Promise<void> {
        const errors: unknown[] = [];
        try {
          await libraryLease.release();
        } catch (error) {
          errors.push(error);
        }
        try {
          await subjectLease.release();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length !== 0) {
          throw storageCorrupt(
            "The coordinated Library writer locks could not be released safely.",
            new AggregateError(errors),
          );
        }
      },
    };
  }
}
