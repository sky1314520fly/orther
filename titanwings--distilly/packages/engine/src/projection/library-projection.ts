import { DistillyError } from "@distilly/protocol";
import type {
  FactEnvelope,
  LibraryEntry,
  LibraryPage,
  LibraryQuery,
  RebuildResult,
  SubjectId,
} from "@distilly/protocol";
import type { FileLockLease } from "../transaction/file-lock.js";

/** Complete checksum-protected payload stored in `.index/library.json`. */
export interface LibraryProjectionRecord extends FactEnvelope<1> {
  readonly recordKind: "library";
  readonly entries: readonly LibraryEntry[];
}

/** Durable visibility state after one coordinated post-commit projection apply. */
export type LibraryApplyStatus = "clean" | "dirty";

/** Whether a subject lock belongs to a new mutation or prepared-journal recovery. */
export type LibraryWriterKind = "mutation" | "recovery";

/** Internal retry signal carrying the exact writer intent observed under the Library lock. */
export class LibraryIntentPendingError extends DistillyError {
  readonly intentToken: string;

  /**
   * Creates the retryable signal for one exact outstanding intent.
   *
   * @param intentToken - Durable intent owner token observed under the Library lock.
   */
  constructor(intentToken: string) {
    super({
      code: "busy",
      message: "Library projection reconciliation raced with a fact writer.",
      retryable: true,
    });
    this.intentToken = intentToken;
  }
}

/** Replaceable package-internal projection used by Library reads and recovery. */
export interface LibraryProjection {
  upsert(entry: LibraryEntry): Promise<void>;
  remove(subjectId: SubjectId): Promise<void>;
  query(input: LibraryQuery): Promise<LibraryPage>;
  rebuild(entries: () => AsyncIterable<LibraryEntry>): Promise<RebuildResult>;
}

/** Projection seam that computes a post-commit aggregate while holding its write lock. */
export interface CoordinatedLibraryProjection extends LibraryProjection {
  reserveWriter(subjectId: SubjectId, kind: LibraryWriterKind): Promise<FileLockLease>;
  hasWriterIntent(): Promise<boolean>;
  completeWriter(subjectId: SubjectId): Promise<void>;
  settleReconciledIntent(
    hasPreparedJournal: () => Promise<boolean>,
  ): Promise<"pending" | "settled">;
  apply(
    subjectId: SubjectId,
    entry: () => Promise<LibraryEntry | undefined>,
  ): Promise<LibraryApplyStatus>;
}
