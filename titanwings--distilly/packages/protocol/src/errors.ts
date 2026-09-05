import type { JsonObject } from "./json.js";
import type { AmbiguousSubjectCandidates, SubjectSummary } from "./values/subjects.js";

/** Stable error codes used for branching across every transport. */
export const DISTILLY_ERROR_CODES = [
  "invalid_input",
  "not_found",
  "already_exists",
  "ambiguous_subject",
  "idempotency_conflict",
  "nothing_pending",
  "lease_conflict",
  "lease_expired",
  "stale_job",
  "briefing_too_large",
  "evidence_invalid",
  "context_too_large",
  "review_conflict",
  "busy",
  "storage_corrupt",
  "schema_unsupported",
  "index_unavailable",
  "host_unsupported",
  "adapter_failed",
  "permission_denied",
  "internal_error",
] as const;

export type DistillyErrorCode = (typeof DISTILLY_ERROR_CODES)[number];

interface DistillyWireErrorBase {
  readonly message: string;
  readonly retryable: boolean;
  readonly fieldPath?: string;
  readonly remediation?: string;
  readonly details?: JsonObject;
}

/** Serializable, code-correlated error used at every transport boundary. */
export type DistillyWireError =
  | (DistillyWireErrorBase & {
      readonly code: "already_exists";
      readonly subjectResolution: {
        readonly kind: "found";
        readonly subject: SubjectSummary;
      };
    })
  | (DistillyWireErrorBase & {
      readonly code: "ambiguous_subject";
      readonly subjectResolution: {
        readonly kind: "ambiguous";
        readonly candidates: AmbiguousSubjectCandidates;
      };
    })
  | {
      readonly code: "internal_error";
      readonly message: string;
      readonly retryable: false;
      readonly fieldPath?: never;
      readonly remediation?: never;
      readonly details?: never;
      readonly subjectResolution?: never;
    }
  | (DistillyWireErrorBase & {
      readonly code: Exclude<
        DistillyErrorCode,
        "already_exists" | "ambiguous_subject" | "internal_error"
      >;
      readonly subjectResolution?: never;
    });

/** Concrete SDK error that preserves the stable wire error fields. */
export class DistillyError extends Error {
  readonly code: DistillyErrorCode;
  readonly retryable: boolean;
  readonly fieldPath?: string;
  readonly remediation?: string;
  readonly details?: JsonObject;
  readonly subjectResolution?: DistillyWireError["subjectResolution"];

  /**
   * Creates an SDK error from its transport-safe representation.
   *
   * @param error - Stable error fields received from a boundary.
   * @param options - Standard Error construction options.
   */
  constructor(error: DistillyWireError, options?: ErrorOptions) {
    super(error.message, options);
    this.name = "DistillyError";
    this.code = error.code;
    this.retryable = error.retryable;
    if (error.fieldPath !== undefined) this.fieldPath = error.fieldPath;
    if (error.remediation !== undefined) this.remediation = error.remediation;
    if (error.details !== undefined) this.details = error.details;
    if (error.subjectResolution !== undefined) {
      this.subjectResolution = error.subjectResolution;
    }
  }
}
