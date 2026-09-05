import type { DistillyWireError } from "./errors.js";
import type { IsoDateTime, SubjectId, VersionId } from "./ids.js";

/** Post-commit invalidation signal that tells clients what to re-read. */
export interface EngineEvent {
  readonly kind:
    | "subject.created"
    | "subject.archived"
    | "subject.purged"
    | "material.ingested"
    | "job.changed"
    | "version.current"
    | "version.suspended"
    | "version.promoted"
    | "version.rejected"
    | "version.rolled_back"
    | "relation.changed";
  readonly subjectId?: SubjectId;
  readonly versionId?: VersionId;
  readonly at: IsoDateTime;
}

/** Trusted callbacks used while decoding an event at the wire boundary. */
export interface EngineEventDecodeHandlers {
  readonly onEvent: (event: EngineEvent) => void;
  readonly onFullReread: (error: DistillyWireError) => void;
}

export type EngineEventDecodeResult =
  | { readonly kind: "event"; readonly event: EngineEvent }
  | { readonly kind: "schema_unsupported"; readonly error: DistillyWireError };
