import type { EventId, JobId, LeaseId, LeaseOwnerId, SpaceId, SubjectId } from "@distilly/protocol";

/** Random id seam used by the Step 5 atomic-ingest composition. */
export interface IdGenerator {
  subjectId(): SubjectId;
  spaceId(): SpaceId;
  jobId(): JobId;
  leaseId(): LeaseId;
  leaseOwnerId(): LeaseOwnerId;
  eventId(): EventId;
}
