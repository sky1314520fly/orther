import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  DistillyError,
  eventRecordSchema,
  requestIdSchema,
  type ActorContext,
  type EventId,
  type IsoDateTime,
  type RequestId,
  type SpaceId,
  type SubjectId,
  type SubjectSummary,
} from "@distilly/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../facts/canonical-json.js";
import { verifyFactChecksum } from "../facts/checksum.js";
import {
  computeMutationInputChecksum,
  insertCompletedOperationInTransaction,
  insertEventInTransaction,
  replayCompletedMutation,
} from "./mutation-ledger.js";
import { SqliteEngineStore } from "./sqlite-engine-store.js";

const AT = "2026-08-30T12:00:00.000Z" as IsoDateTime;
const ACTOR: ActorContext = { kind: "sdk", id: "ledger-test" };
const SPACE_ID = "space_00000000000000000000000000000020" as SpaceId;
const SUBJECT_ID = "subject_00000000000000000000000000000020" as SubjectId;
const OTHER_SUBJECT_ID = "subject_00000000000000000000000000000021" as SubjectId;
const EVENT_ID = "event_00000000000000000000000000000020" as EventId;
const RESULT: SubjectSummary = {
  id: SUBJECT_ID,
  displayName: "Ada",
  aliases: [],
  identityHints: [],
  space: { id: SPACE_ID, displayName: "People", kind: "people" },
  lifecycle: "active",
};

const roots: string[] = [];
const stores: SqliteEngineStore[] = [];

const request = (digit: number): RequestId =>
  requestIdSchema.parse(`req_${digit.toString(16).padStart(32, "0")}`);

const open = async (): Promise<SqliteEngineStore> => {
  const root = await mkdtemp(join(tmpdir(), "distilly-ledger-"));
  roots.push(root);
  const store = await SqliteEngineStore.open(root);
  stores.push(store);
  store.write((database) => {
    database
      .prepare(
        `INSERT INTO spaces(id, display_name, canonical_label, kind)
         VALUES (?, 'People', 'People', 'people')`,
      )
      .run(SPACE_ID);
    database
      .prepare(
        `INSERT INTO subjects(
           id, space_id, display_name, canonical_label, domain_pack, lifecycle
         ) VALUES (?, ?, 'Ada', 'Ada', NULL, 'active')`,
      )
      .run(SUBJECT_ID, SPACE_ID);
    database
      .prepare(
        `INSERT INTO subject_states(
           subject_id, generation, material_set_hash, current_version_id, suspended_version_id
         ) VALUES (?, 0, NULL, NULL, NULL)`,
      )
      .run(SUBJECT_ID);
  });
  return store;
};

const expectCode = (run: () => unknown, code: string): DistillyError => {
  try {
    run();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(DistillyError);
    expect(error).toMatchObject({ code });
    return error as DistillyError;
  }
};

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SQLite mutation ledger", () => {
  it("replays a strict result and rejects input, actor, and cross-method RequestId reuse", async () => {
    const store = await open();
    const params = { displayName: "Ada" };
    const checksum = computeMutationInputChecksum("subjects.create", params, ACTOR);
    store.write((database) => {
      insertCompletedOperationInTransaction(database, {
        requestId: request(1),
        method: "subjects.create",
        subjectId: SUBJECT_ID,
        actor: ACTOR,
        inputChecksum: checksum,
        result: RESULT,
        completedAt: AT,
      });
    });

    expect(
      store.read((database) =>
        replayCompletedMutation(database, {
          requestId: request(1),
          method: "subjects.create",
          inputChecksum: checksum,
          actor: ACTOR,
        }),
      ),
    ).toEqual(RESULT);

    const changed = computeMutationInputChecksum(
      "subjects.create",
      { displayName: "Changed" },
      ACTOR,
    );
    expectCode(
      () =>
        store.read((database) =>
          replayCompletedMutation(database, {
            requestId: request(1),
            method: "subjects.create",
            inputChecksum: changed,
            actor: ACTOR,
          }),
        ),
      "idempotency_conflict",
    );
    const changedActor = computeMutationInputChecksum("subjects.create", params, {
      ...ACTOR,
      id: "other",
    });
    expectCode(
      () =>
        store.read((database) =>
          replayCompletedMutation(database, {
            requestId: request(1),
            method: "subjects.create",
            inputChecksum: changedActor,
            actor: { ...ACTOR, id: "other" },
          }),
        ),
      "idempotency_conflict",
    );
    expectCode(
      () =>
        store.read((database) =>
          replayCompletedMutation(database, {
            requestId: request(1),
            method: "materials.ingest",
            inputChecksum: computeMutationInputChecksum("materials.ingest", {}, ACTOR),
            actor: ACTOR,
          }),
        ),
      "idempotency_conflict",
    );

    store.write((database) => {
      database.prepare("UPDATE operations SET method = 'unknown.method'").run();
    });
    expectCode(
      () =>
        store.read((database) =>
          replayCompletedMutation(database, {
            requestId: request(1),
            method: "subjects.create",
            inputChecksum: checksum,
            actor: ACTOR,
          }),
        ),
      "storage_corrupt",
    );
  });

  it("persists a request-correlated sealed event and fails closed on an invalid stored result", async () => {
    const store = await open();
    const checksum = computeMutationInputChecksum("subjects.create", { displayName: "Ada" }, ACTOR);
    store.write((database) => {
      insertCompletedOperationInTransaction(database, {
        requestId: request(1),
        method: "subjects.create",
        subjectId: SUBJECT_ID,
        actor: ACTOR,
        inputChecksum: checksum,
        result: RESULT,
        completedAt: AT,
      });
      insertEventInTransaction(database, {
        eventId: EVENT_ID,
        event: { kind: "subject.created", subjectId: SUBJECT_ID, at: AT },
        actor: ACTOR,
        requestId: request(1),
      });
    });

    const row = store.read((database) =>
      database
        .prepare(
          `SELECT request_id, subject_id, actor_json, event_json, occurred_at
           FROM events`,
        )
        .get(),
    );
    expect(row).toMatchObject({
      request_id: request(1),
      subject_id: SUBJECT_ID,
      actor_json: canonicalJson(ACTOR),
      occurred_at: AT,
    });
    const record = eventRecordSchema.parse(JSON.parse(String(row?.event_json)));
    expect(() => verifyFactChecksum(record)).not.toThrow();
    expect(record).toMatchObject({
      eventId: EVENT_ID,
      requestId: request(1),
      event: { kind: "subject.created", subjectId: SUBJECT_ID, at: AT },
    });

    store.write((database) => {
      database.prepare("UPDATE operations SET result_json = '{}'").run();
    });
    expectCode(
      () =>
        store.read((database) =>
          replayCompletedMutation(database, {
            requestId: request(1),
            method: "subjects.create",
            inputChecksum: checksum,
            actor: ACTOR,
          }),
        ),
      "storage_corrupt",
    );
  });

  it("rejects an event whose subject or actor disagrees with its completed operation", async () => {
    const store = await open();
    const checksum = computeMutationInputChecksum("subjects.create", { displayName: "Ada" }, ACTOR);
    store.write((database) => {
      database
        .prepare(
          `INSERT INTO subjects(
             id, space_id, display_name, canonical_label, domain_pack, lifecycle
           ) VALUES (?, ?, 'Grace', 'Grace', NULL, 'active')`,
        )
        .run(OTHER_SUBJECT_ID, SPACE_ID);
      database
        .prepare(
          `INSERT INTO subject_states(
             subject_id, generation, material_set_hash, current_version_id, suspended_version_id
           ) VALUES (?, 0, NULL, NULL, NULL)`,
        )
        .run(OTHER_SUBJECT_ID);
      insertCompletedOperationInTransaction(database, {
        requestId: request(1),
        method: "subjects.create",
        subjectId: SUBJECT_ID,
        actor: ACTOR,
        inputChecksum: checksum,
        result: RESULT,
        completedAt: AT,
      });
    });

    expectCode(
      () =>
        store.write((database) => {
          insertEventInTransaction(database, {
            eventId: EVENT_ID,
            event: { kind: "subject.created", subjectId: OTHER_SUBJECT_ID, at: AT },
            actor: ACTOR,
            requestId: request(1),
          });
        }),
      "storage_corrupt",
    );
    expectCode(
      () =>
        store.write((database) => {
          insertEventInTransaction(database, {
            eventId: EVENT_ID,
            event: { kind: "subject.created", subjectId: SUBJECT_ID, at: AT },
            actor: { ...ACTOR, id: "wrong-event-actor" },
            requestId: request(1),
          });
        }),
      "storage_corrupt",
    );
    expect(
      store.read((database) => database.prepare("SELECT count(*) AS count FROM events").get()),
    ).toEqual({ count: 0 });
  });

  it("fails closed when a stored operation actor no longer matches its sealed input", async () => {
    const store = await open();
    const checksum = computeMutationInputChecksum("subjects.create", { displayName: "Ada" }, ACTOR);
    store.write((database) => {
      insertCompletedOperationInTransaction(database, {
        requestId: request(1),
        method: "subjects.create",
        subjectId: SUBJECT_ID,
        actor: ACTOR,
        inputChecksum: checksum,
        result: RESULT,
        completedAt: AT,
      });
      database
        .prepare("UPDATE operations SET actor_json = ? WHERE request_id = ?")
        .run(canonicalJson({ ...ACTOR, id: "tampered" }), request(1));
    });

    expectCode(
      () =>
        store.read((database) =>
          replayCompletedMutation(database, {
            requestId: request(1),
            method: "subjects.create",
            inputChecksum: checksum,
            actor: ACTOR,
          }),
        ),
      "storage_corrupt",
    );
  });

  it("fails closed when a completed operation loses its authoritative subject scope", async () => {
    const store = await open();
    const checksum = computeMutationInputChecksum("subjects.create", { displayName: "Ada" }, ACTOR);
    store.write((database) => {
      insertCompletedOperationInTransaction(database, {
        requestId: request(1),
        method: "subjects.create",
        subjectId: SUBJECT_ID,
        actor: ACTOR,
        inputChecksum: checksum,
        result: RESULT,
        completedAt: AT,
      });
      database
        .prepare("UPDATE operations SET scope_subject_id = NULL WHERE request_id = ?")
        .run(request(1));
    });
    expectCode(
      () =>
        store.read((database) =>
          replayCompletedMutation(database, {
            requestId: request(1),
            method: "subjects.create",
            inputChecksum: checksum,
            actor: ACTOR,
          }),
        ),
      "storage_corrupt",
    );

    store.write((database) => {
      database
        .prepare("UPDATE operations SET scope_subject_id = ? WHERE request_id = ?")
        .run(SUBJECT_ID, request(1));
    });
    const tamper = new DatabaseSync(store.databaseFile);
    tamper.exec("PRAGMA foreign_keys = OFF");
    tamper.prepare("DELETE FROM subjects WHERE id = ?").run(SUBJECT_ID);
    tamper.close();
    expectCode(
      () =>
        store.read((database) =>
          replayCompletedMutation(database, {
            requestId: request(1),
            method: "subjects.create",
            inputChecksum: checksum,
            actor: ACTOR,
          }),
        ),
      "storage_corrupt",
    );
  });
});
