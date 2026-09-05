import { z } from "zod";

import type { DistillyWireError } from "../errors.js";
import type { EngineEvent, EngineEventDecodeHandlers, EngineEventDecodeResult } from "../events.js";
import type { RuntimeSchema } from "../wire.js";
import { exactOptionalRuntimeSchema } from "./common.js";
import { isoDateTimeSchema, subjectIdSchema, versionIdSchema } from "./ids.js";

const ENGINE_EVENT_KINDS = [
  "subject.created",
  "subject.archived",
  "subject.purged",
  "material.ingested",
  "job.changed",
  "version.current",
  "version.suspended",
  "version.promoted",
  "version.rejected",
  "version.rolled_back",
  "relation.changed",
] as const;

const engineEventKindSchema = z.enum(ENGINE_EVENT_KINDS);
const engineEventKinds = new Set<string>(ENGINE_EVENT_KINDS);
const versionEventKinds = new Set<EngineEvent["kind"]>([
  "version.current",
  "version.suspended",
  "version.promoted",
  "version.rejected",
  "version.rolled_back",
]);

/** Runtime schema for one post-commit invalidation event. */
export const engineEventSchema = z
  .strictObject({
    kind: engineEventKindSchema,
    subjectId: subjectIdSchema.optional(),
    versionId: versionIdSchema.optional(),
    at: isoDateTimeSchema,
  })
  .superRefine((event, context) => {
    if (event.subjectId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["subjectId"],
        message: "subject-scoped events require subjectId",
      });
    }
    if (versionEventKinds.has(event.kind) && event.versionId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["versionId"],
        message: "version events require versionId",
      });
    }
  });

const engineEventRuntimeSchema = exactOptionalRuntimeSchema(
  engineEventSchema,
) satisfies RuntimeSchema<EngineEvent>;

const unsupportedEventError = (): DistillyWireError => ({
  code: "schema_unsupported",
  message: "Unsupported EngineEvent kind.",
  retryable: false,
  remediation: "Re-read all visible subjects and upgrade the event consumer.",
});

/**
 * Dispatches a known event or requests a full reread for an unknown event kind.
 *
 * @param value - Untrusted event payload from a transport.
 * @param handlers - Consumer callbacks for known events and compatibility recovery.
 * @returns The decoded event or a stable schema-unsupported failure.
 */
export const decodeEngineEvent = (
  value: unknown,
  handlers: EngineEventDecodeHandlers,
): EngineEventDecodeResult => {
  const kind =
    typeof value === "object" && value !== null && "kind" in value
      ? (value as { readonly kind?: unknown }).kind
      : undefined;

  if (typeof kind !== "string" || !engineEventKinds.has(kind)) {
    const error = unsupportedEventError();
    handlers.onFullReread(error);
    return { kind: "schema_unsupported", error };
  }

  const event = engineEventRuntimeSchema.parse(value);
  handlers.onEvent(event);
  return { kind: "event", event };
};
