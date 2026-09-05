import type {
  FactChecksum,
  IsoDateTime,
  JobId,
  LeaseOwnerId,
  PendingFilter,
  PendingJob,
  PendingJobMarker,
  SubjectId,
} from "@distilly/protocol";

/** One fact-verified subject state used by the test-only legacy queue seam. */
export interface VerifiedQueueStateSeed {
  readonly subjectId: SubjectId;
  readonly stateChecksum: FactChecksum;
  readonly pending?: PendingJobMarker;
}

/** Public queue view plus projection-only scheduling metadata. */
export interface PendingJobRecord {
  readonly job: PendingJob;
  readonly attempt: number;
  readonly leaseOwner?: LeaseOwnerId;
  readonly lastSequence: number;
}

/** Test-only queue seam retained for legacy behavior regression coverage. */
export interface QueueRepository {
  apply(seed: VerifiedQueueStateSeed): Promise<void>;
  read(jobId: JobId, now: IsoDateTime): Promise<PendingJobRecord | undefined>;
  list(filter: PendingFilter, now: IsoDateTime): Promise<readonly PendingJobRecord[]>;
  rebuild(seeds: () => AsyncIterable<VerifiedQueueStateSeed>, now: IsoDateTime): Promise<void>;
}
