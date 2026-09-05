import { randomBytes } from "node:crypto";

import type {
  CaptureAuditRef,
  EventId,
  JobId,
  LeaseId,
  LeaseOwnerId,
  RequestId,
  SpaceId,
  SubjectId,
} from "@distilly/protocol";
import { BUILTIN_PEOPLE_SPACE_ID } from "@distilly/protocol";

import type { IdGenerator } from "../ports/id-generator.js";

const random128 = (): string => randomBytes(16).toString("hex");

/** Production 128-bit cryptographic identifier generator. */
export class CryptoIdGenerator implements IdGenerator {
  /**
   * Generates an opaque subject id.
   *
   * @returns A fresh 128-bit subject identifier.
   */
  subjectId(): SubjectId {
    return `subject_${random128()}` as SubjectId;
  }

  /**
   * Generates an opaque space id.
   *
   * @returns A fresh 128-bit space identifier.
   */
  spaceId(): SpaceId {
    let id: SpaceId;
    do {
      id = `space_${random128()}` as SpaceId;
    } while (id === BUILTIN_PEOPLE_SPACE_ID);
    return id;
  }

  /**
   * Generates an opaque job id.
   *
   * @returns A fresh 128-bit job identifier.
   */
  jobId(): JobId {
    return `job_${random128()}` as JobId;
  }

  /**
   * Generates an opaque lease id.
   *
   * @returns A fresh 128-bit lease identifier.
   */
  leaseId(): LeaseId {
    return `lease_${random128()}` as LeaseId;
  }

  /**
   * Generates an opaque owner token for one trusted client session.
   *
   * @returns A fresh 128-bit session-bound lease owner identifier.
   */
  leaseOwnerId(): LeaseOwnerId {
    return `lease_owner_${random128()}` as LeaseOwnerId;
  }

  /**
   * Generates a caller-safe mutation id.
   *
   * @returns A fresh 128-bit request identifier.
   */
  requestId(): RequestId {
    return `req_${random128()}` as RequestId;
  }

  /**
   * Generates an opaque event id.
   *
   * @returns A fresh 128-bit event identifier.
   */
  eventId(): EventId {
    return `event_${random128()}` as EventId;
  }

  /**
   * Generates an unguessable private-capture audit reference.
   *
   * @returns A fresh 128-bit capture-audit reference.
   */
  captureAuditRef(): CaptureAuditRef {
    return `capture_${random128()}` as CaptureAuditRef;
  }
}
