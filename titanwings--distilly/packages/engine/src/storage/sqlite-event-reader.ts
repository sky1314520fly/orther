import type { DatabaseSync } from "node:sqlite";

import {
  actorContextSchema,
  eventRecordSchema,
  requestIdSchema,
  subjectIdSchema,
} from "@distilly/protocol";
import type { ActorContext, EventRecord, SubjectId } from "@distilly/protocol";

import { canonicalJson } from "../facts/canonical-json.js";
import { verifyFactChecksum } from "../facts/checksum.js";
import { storageCorrupt } from "../internal-errors.js";

const parseStored = <T>(parse: () => T, label: string): T => {
  try {
    return parse();
  } catch (error) {
    throw storageCorrupt(`SQLite ${label} is invalid.`, error);
  }
};

const text = (row: Readonly<Record<string, unknown>>, key: string): string => {
  const value = row[key];
  if (typeof value !== "string") throw storageCorrupt(`SQLite ${key} is invalid.`);
  return value;
};

const parseJson = (value: string, label: string): unknown => {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw storageCorrupt(`SQLite ${label} is not valid JSON.`, error);
  }
};

/**
 * Reads and verifies the event rows directly used by one subject read.
 *
 * @param database - Connection inside the caller's active SQLite snapshot.
 * @param subjectId - Subject whose durable events are required.
 * @returns Events in insertion order after checking their operation correlation.
 */
export const readSqliteSubjectEventsInTransaction = (
  database: DatabaseSync,
  subjectId: SubjectId,
): readonly EventRecord[] => {
  const expectedSubjectId = parseStored(() => subjectIdSchema.parse(subjectId), "event subject id");
  let rows: readonly Readonly<Record<string, unknown>>[];
  try {
    rows = database
      .prepare(
        `SELECT events.event_id, events.request_id, events.subject_id,
                events.actor_json, events.event_json, events.occurred_at,
                operations.request_id AS operation_request_id,
                operations.scope_subject_id AS operation_subject_id,
                operations.actor_json AS operation_actor_json
         FROM events
         LEFT JOIN operations ON operations.request_id = events.request_id
         WHERE events.subject_id = ?
         ORDER BY events.sequence`,
      )
      .all(expectedSubjectId);
  } catch (error) {
    throw storageCorrupt("SQLite could not read subject events.", error);
  }

  return rows.map((row): EventRecord => {
    const eventJson = text(row, "event_json");
    const record = parseStored(
      () => eventRecordSchema.parse(parseJson(eventJson, "event record")) as EventRecord,
      "event record",
    );
    if (canonicalJson(record) !== eventJson) {
      throw storageCorrupt("SQLite event record is not canonically encoded.");
    }
    verifyFactChecksum(record);
    const requestId = parseStored(
      () => requestIdSchema.parse(text(row, "request_id")),
      "event request id",
    );
    const actorJson = text(row, "actor_json");
    const actor = parseStored(
      () => actorContextSchema.parse(parseJson(actorJson, "event actor")) as ActorContext,
      "event actor",
    );
    const operationActorJson = text(row, "operation_actor_json");
    const operationActor = parseStored(
      () =>
        actorContextSchema.parse(
          parseJson(operationActorJson, "event operation actor"),
        ) as ActorContext,
      "event operation actor",
    );
    if (
      canonicalJson(actor) !== actorJson ||
      canonicalJson(operationActor) !== operationActorJson ||
      record.eventId !== text(row, "event_id") ||
      record.requestId !== requestId ||
      record.event.subjectId !== expectedSubjectId ||
      text(row, "subject_id") !== expectedSubjectId ||
      record.event.at !== text(row, "occurred_at") ||
      canonicalJson(record.actor) !== canonicalJson(actor) ||
      text(row, "operation_request_id") !== requestId ||
      text(row, "operation_subject_id") !== expectedSubjectId ||
      canonicalJson(operationActor) !== canonicalJson(actor)
    ) {
      throw storageCorrupt("SQLite event columns disagree with their canonical record.");
    }
    return record;
  });
};
