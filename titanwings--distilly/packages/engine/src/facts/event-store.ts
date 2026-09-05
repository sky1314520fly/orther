import { DistillyError, eventIdSchema, eventRecordSchema } from "@distilly/protocol";
import type { EventId, EventRecord, RuntimeSchema, SubjectId } from "@distilly/protocol";

import { storageCorrupt } from "../internal-errors.js";
import { Layout } from "../layout.js";
import { createFactFile, readFactFile } from "./fact-file.js";
import { listFactDirectory } from "./directory-scan.js";
import type { FileSubjectStore } from "./subject-store.js";

const eventFactSchema: RuntimeSchema<EventRecord> = {
  parse(value) {
    return eventRecordSchema.parse(value) as EventRecord;
  },
};

const isFileCollision = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "EEXIST";

const EVENT_FILE_PATTERN = /^(event_[0-9a-f]{32})\.json$/u;
const EVENT_TEMP_PATTERN = /^\.event_[0-9a-f]{32}\.json\.[1-9][0-9]*\.[0-9a-f]{16}\.tmp$/u;

const requireSubject = async (subjects: FileSubjectStore, subjectId: SubjectId): Promise<void> => {
  try {
    await subjects.read(subjectId);
  } catch (error) {
    if (error instanceof DistillyError && error.code === "not_found") {
      throw storageCorrupt("Event fact references a missing subject.", error);
    }
    throw error;
  }
};

const assertSubject = (subjectId: SubjectId, record: EventRecord): void => {
  if (record.event.subjectId !== subjectId) {
    throw storageCorrupt("Event subject id does not match its fact path.");
  }
};

/** Concrete local store for immutable event facts. */
export class FileEventStore {
  readonly #layout: Layout;
  readonly #subjects: FileSubjectStore;

  /**
   * Creates an event store with its required subject-fact dependency.
   *
   * @param layout - Confined local fact layout.
   * @param subjects - Store used to validate event ownership.
   */
  constructor(layout: Layout, subjects: FileSubjectStore) {
    this.#layout = layout;
    this.#subjects = subjects;
  }

  /**
   * Publishes one immutable event or accepts an exact retry.
   *
   * @param subjectId - Subject path that owns the event.
   * @param record - Complete event fact.
   * @returns Completion after publication or exact retry validation.
   */
  async write(subjectId: SubjectId, record: EventRecord): Promise<void> {
    let parsed: EventRecord;
    try {
      parsed = eventFactSchema.parse(record);
    } catch (error) {
      throw storageCorrupt("Event fact cannot be written because its schema is invalid.", error);
    }
    await requireSubject(this.#subjects, subjectId);
    assertSubject(subjectId, parsed);
    const path = this.#layout.eventFile(subjectId, parsed.eventId);
    try {
      await createFactFile(this.#layout.root, path, parsed, eventFactSchema);
    } catch (error) {
      if (!isFileCollision(error)) throw error;
      const existing = await this.read(subjectId, parsed.eventId);
      if (existing.checksum === parsed.checksum) return;
      throw storageCorrupt("Immutable event id already contains a different fact.", error);
    }
  }

  /**
   * Reads an event and validates its path id and subject association.
   *
   * @param subjectId - Subject path that owns the event.
   * @param eventId - Event path segment.
   * @returns The verified immutable event.
   */
  async read(subjectId: SubjectId, eventId: EventId): Promise<EventRecord> {
    await requireSubject(this.#subjects, subjectId);
    const record = await readFactFile(
      this.#layout.root,
      this.#layout.eventFile(subjectId, eventId),
      eventFactSchema,
    );
    if (record.eventId !== eventId) {
      throw storageCorrupt("Event id does not match its fact path.");
    }
    assertSubject(subjectId, record);
    return record;
  }

  /**
   * Lists every verified immutable event for one subject in EventId order.
   *
   * @param subjectId - Subject whose event history is requested.
   * @returns Canonically ordered verified event records.
   */
  async list(subjectId: SubjectId): Promise<readonly EventRecord[]> {
    await requireSubject(this.#subjects, subjectId);
    const records: EventRecord[] = [];
    for (const entry of await listFactDirectory(
      this.#layout.root,
      this.#layout.eventsDirectory(subjectId),
    )) {
      if (EVENT_TEMP_PATTERN.test(entry.name) && entry.kind === "file") continue;
      const match = EVENT_FILE_PATTERN.exec(entry.name);
      if (match === null || entry.kind !== "file") {
        throw storageCorrupt("Events directory contains an unknown entry.");
      }
      records.push(await this.read(subjectId, eventIdSchema.parse(match[1])));
    }
    return records;
  }
}
