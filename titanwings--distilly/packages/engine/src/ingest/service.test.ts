import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  DistillyError,
  requestIdSchema,
  type ActorContext,
  type EngineEvent,
  type EventId,
  type IngestInput,
  type IsoDateTime,
  type JobId,
  type LeaseId,
  type LeaseOwnerId,
  type RequestId,
  type SpaceId,
  type SubjectId,
} from "@distilly/protocol";

import { InProcessEventBus } from "../defaults/in-process-event-bus.js";
import type { Clock } from "../defaults/system-clock.js";
import { digestContent } from "../facts/digests.js";
import type { IdGenerator } from "../ports/id-generator.js";
import { createInternalEngineComposition } from "./composition.js";
import type { InternalEngineComposition } from "./composition.js";
import type { IngestServiceHooks } from "./service.js";

const AT = "2026-08-20T10:30:00.000Z" as IsoDateTime;
const LATER = "2026-08-20T11:30:00.000Z" as IsoDateTime;
const ACTOR: ActorContext = { kind: "sdk", id: "sqlite-ingest-test" };

class FakeClock implements Clock {
  current = AT;

  now(): IsoDateTime {
    return this.current;
  }
}

class SequenceIds implements IdGenerator {
  private subject = 1;
  private space = 1;
  private job = 1;
  private lease = 1;
  private owner = 1;
  private event = 1;

  subjectId(): SubjectId {
    return `subject_${(this.subject++).toString(16).padStart(32, "0")}` as SubjectId;
  }

  spaceId(): SpaceId {
    return `space_${(this.space++ + 1).toString(16).padStart(32, "0")}` as SpaceId;
  }

  jobId(): JobId {
    return `job_${(this.job++).toString(16).padStart(32, "0")}` as JobId;
  }

  leaseId(): LeaseId {
    return `lease_${(this.lease++).toString(16).padStart(32, "0")}` as LeaseId;
  }

  leaseOwnerId(): LeaseOwnerId {
    return `lease_owner_${(this.owner++).toString(16).padStart(32, "0")}` as LeaseOwnerId;
  }

  eventId(): EventId {
    return `event_${(this.event++).toString(16).padStart(32, "0")}` as EventId;
  }
}

const roots: string[] = [];
const compositions: InternalEngineComposition[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "distilly-sqlite-ingest-"));
  roots.push(root);
  return root;
};

const request = (digit: number): RequestId =>
  requestIdSchema.parse(`req_${digit.toString(16).padStart(32, "0")}`);

const material = (
  digit: number,
  overrides: Partial<IngestInput["materials"][number]> = {},
): IngestInput["materials"][number] => ({
  clientRef: `source-${digit}`,
  kind: "web",
  content: `Verified source ${digit}.`,
  source: {
    uri: `https://example.com/source-${digit}`,
    title: `Source ${digit}`,
    medium: "article",
    access: "public",
    role: "reference",
    capturedAt: AT,
  },
  derivation: { kind: "native_text" },
  ...overrides,
});

const createInput = (
  materials: IngestInput["materials"] = [material(1)],
  enqueue: IngestInput["enqueue"] = "now",
): IngestInput => ({
  subject: {
    kind: "create",
    input: {
      displayName: "Ada Lovelace",
      aliases: ["Ada"],
      identityHints: [{ kind: "url", value: "https://example.com/ada" }],
    },
  },
  materials,
  enqueue,
});

const existingInput = (
  subjectId: SubjectId,
  materials: IngestInput["materials"],
  enqueue: IngestInput["enqueue"] = "now",
): IngestInput => ({ subject: { kind: "existing", subjectId }, materials, enqueue });

const open = async (
  root: string,
  ids = new SequenceIds(),
  clock = new FakeClock(),
  hooks?: IngestServiceHooks,
  published?: EngineEvent[],
): Promise<InternalEngineComposition> => {
  const eventBus = new InProcessEventBus();
  if (published !== undefined) {
    eventBus.subscribe((event) => {
      published.push(event);
    });
  }
  const composition = await createInternalEngineComposition({
    root,
    ids,
    clock,
    eventBus,
    ...(hooks === undefined ? {} : { ingestHooks: hooks }),
  });
  compositions.push(composition);
  return composition;
};

const inspect = <T>(root: string, read: (database: DatabaseSync) => T): T => {
  const database = new DatabaseSync(join(root, "store.sqlite3"), { readOnly: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
};

const scalar = (database: DatabaseSync, sql: string): unknown => {
  const row = database.prepare(sql).get();
  return row === undefined ? undefined : Object.values(row)[0];
};

const blobPath = (root: string, content: string): string => {
  const digest = digestContent(content);
  const hexadecimal = digest.slice("sha256_".length);
  return join(root, "blobs", "sha256", hexadecimal.slice(0, 2), digest);
};

const deferred = (): { readonly promise: Promise<void>; readonly resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const within = async <T>(promise: Promise<T>, milliseconds = 1_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for the operation.")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const expectCode = async (promise: Promise<unknown>, code: string): Promise<DistillyError> => {
  try {
    await promise;
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(DistillyError);
    expect(error).toMatchObject({ code });
    return error as DistillyError;
  }
};

afterEach(async () => {
  for (const composition of compositions.splice(0)) composition.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SQLite ingest service", () => {
  it("atomically creates subject, material, pending job, operation, events, and exact replay", async () => {
    const root = await makeRoot();
    const published: EngineEvent[] = [];
    const composition = await open(root, new SequenceIds(), new FakeClock(), undefined, published);

    const first = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    expect(first).toMatchObject({
      kind: "ingested",
      created: true,
      generation: 1,
      items: [{ clientRef: "source-1", kind: "accepted" }],
      job: { generation: 1, state: "pending" },
    });
    expect(published.map((event) => event.kind)).toEqual([
      "subject.created",
      "material.ingested",
      "job.changed",
    ]);
    expect(
      inspect(root, (database) => ({
        spaces: scalar(database, "SELECT count(*) FROM spaces"),
        subjects: scalar(database, "SELECT count(*) FROM subjects"),
        aliases: scalar(database, "SELECT count(*) FROM subject_aliases"),
        identityHints: scalar(database, "SELECT count(*) FROM subject_identity_hints"),
        subjectStates: scalar(database, "SELECT count(*) FROM subject_states"),
        blobs: scalar(database, "SELECT count(*) FROM blobs"),
        materials: scalar(database, "SELECT count(*) FROM materials"),
        pending: scalar(database, "SELECT count(*) FROM pending_jobs"),
        operations: scalar(database, "SELECT count(*) FROM operations"),
        events: scalar(database, "SELECT count(*) FROM events"),
        integrity: scalar(database, "PRAGMA quick_check(1)"),
      })),
    ).toEqual({
      spaces: 1,
      subjects: 1,
      aliases: 1,
      identityHints: 1,
      subjectStates: 1,
      blobs: 1,
      materials: 1,
      pending: 1,
      operations: 1,
      events: 3,
      integrity: "ok",
    });

    expect(
      await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) }),
    ).toEqual(first);
    expect(published).toHaveLength(3);
    composition.close();
    compositions.splice(compositions.indexOf(composition), 1);

    const reopened = await open(root, new SequenceIds());
    expect(await reopened.ingest.ingest(createInput(), ACTOR, { requestId: request(1) })).toEqual(
      first,
    );
  });

  it("fails closed when ingest(create) resolves a locator with a missing subject parent", async () => {
    const root = await makeRoot();
    const composition = await open(root);
    const first = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    const database = new DatabaseSync(join(root, "store.sqlite3"));
    try {
      database.exec("PRAGMA foreign_keys = OFF");
      database.prepare("DELETE FROM subjects WHERE id = ?").run(first.subject.id);
    } finally {
      database.close();
    }

    await expectCode(
      composition.ingest.ingest(createInput(), ACTOR, { requestId: request(2) }),
      "storage_corrupt",
    );
    expect(
      inspect(root, (sqlite) => ({
        subjects: scalar(sqlite, "SELECT count(*) FROM subjects"),
        operations: scalar(sqlite, "SELECT count(*) FROM operations"),
        events: scalar(sqlite, "SELECT count(*) FROM events"),
      })),
    ).toEqual({ subjects: 0, operations: 1, events: 3 });
  });

  it("appends to an existing subject and shares one blob for equal content", async () => {
    const root = await makeRoot();
    const composition = await open(root);
    const first = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    const subjectId = first.subject.id;
    const sameBody = material(2, { content: material(1).content });

    const second = await composition.ingest.ingest(existingInput(subjectId, [sameBody]), ACTOR, {
      requestId: request(2),
    });
    expect(second).toMatchObject({ kind: "ingested", created: false, generation: 2 });
    expect(
      inspect(root, (database) => ({
        materials: scalar(database, "SELECT count(*) FROM materials"),
        blobs: scalar(database, "SELECT count(*) FROM blobs"),
      })),
    ).toEqual({ materials: 2, blobs: 1 });
  });

  it("does not mistake a concurrent new reference for a previously missing blob", async () => {
    const root = await makeRoot();
    const ids = new SequenceIds();
    const firstPut = deferred();
    const releaseFirst = deferred();
    let coordinate = false;
    let coordinatedPuts = 0;
    const composition = await open(root, ids, new FakeClock(), {
      afterBlobPut: async () => {
        if (!coordinate || ++coordinatedPuts !== 1) return;
        firstPut.resolve();
        await releaseFirst.promise;
      },
    });
    const first = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    const sharedContent = "One newly published shared body.";
    coordinate = true;
    const earlier = composition.ingest.ingest(
      existingInput(first.subject.id, [material(2, { content: sharedContent })]),
      ACTOR,
      { requestId: request(2) },
    );
    await firstPut.promise;
    const later = await composition.ingest.ingest(
      existingInput(first.subject.id, [material(3, { content: sharedContent })]),
      ACTOR,
      { requestId: request(3) },
    );
    releaseFirst.resolve();

    await expect(earlier).resolves.toMatchObject({ kind: "ingested" });
    expect(later).toMatchObject({ kind: "ingested" });
    expect(
      inspect(root, (database) => ({
        materials: scalar(database, "SELECT count(*) FROM materials"),
        blobs: scalar(database, "SELECT count(*) FROM blobs"),
      })),
    ).toEqual({ materials: 3, blobs: 2 });
  });

  it("finishes a multi-blob transaction before queued maintenance enters", async () => {
    const root = await makeRoot();
    let putCount = 0;
    let maintenanceEntered = false;
    let maintenancePromise:
      ReturnType<InternalEngineComposition["blobs"]["acquireMaintenanceAccess"]> | undefined;
    const composition = await open(root, new SequenceIds(), new FakeClock(), {
      afterBlobPut: () => {
        if (++putCount !== 1) return;
        maintenancePromise = composition.blobs.acquireMaintenanceAccess().then((lease) => {
          maintenanceEntered = true;
          return lease;
        });
      },
      beforeTransactionCommit: () => {
        expect(maintenanceEntered).toBe(false);
      },
    });

    await expect(
      within(
        composition.ingest.ingest(createInput([material(1), material(2)]), ACTOR, {
          requestId: request(1),
        }),
      ),
    ).resolves.toMatchObject({ kind: "ingested" });
    expect(maintenancePromise).toBeDefined();
    const maintenance = await within(maintenancePromise!);
    expect(maintenanceEntered).toBe(true);
    await maintenance.release();
  });

  it("releases blob access after COMMIT before a post-commit observer completes", async () => {
    const root = await makeRoot();
    const composition = await open(root);
    const listenerStarted = deferred();
    const releaseListener = deferred();
    const unsubscribe = composition.events.subscribe(async () => {
      listenerStarted.resolve();
      await releaseListener.promise;
    });
    const ingest = composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    await listenerStarted.promise;

    expect(
      inspect(root, (database) => ({
        materials: scalar(database, "SELECT count(*) FROM materials"),
        operations: scalar(database, "SELECT count(*) FROM operations"),
      })),
    ).toEqual({ materials: 1, operations: 1 });
    const maintenance = await within(composition.blobs.acquireMaintenanceAccess());
    await maintenance.release();
    releaseListener.resolve();
    await expect(ingest).resolves.toMatchObject({ kind: "ingested" });
    unsubscribe();
  });

  it("keeps title, capturedAt, and storedAt first-seen for a duplicate material", async () => {
    const root = await makeRoot();
    const clock = new FakeClock();
    const composition = await open(root, new SequenceIds(), clock);
    const firstInput = createInput();
    const first = await composition.ingest.ingest(firstInput, ACTOR, { requestId: request(1) });
    const subjectId = first.subject.id;
    clock.current = LATER;
    const changedDisplay = material(1, {
      source: { ...material(1).source, title: "Later title", capturedAt: LATER },
    });

    const duplicate = await composition.ingest.ingest(
      existingInput(subjectId, [changedDisplay]),
      ACTOR,
      { requestId: request(2) },
    );
    expect(duplicate).toMatchObject({
      kind: "unchanged",
      generation: 1,
      items: [{ kind: "duplicate" }],
    });
    const record = inspect(root, (database) => {
      const row = database.prepare("SELECT record_json FROM materials").get();
      return JSON.parse(String(row?.record_json)) as {
        readonly source: { readonly title: string; readonly capturedAt: string };
        readonly storedAt: string;
      };
    });
    expect(record.source).toMatchObject({ title: "Source 1", capturedAt: AT });
    expect(record.storedAt).toBe(AT);
  });

  it("validates the full batch before publishing any blob or database row", async () => {
    const root = await makeRoot();
    const composition = await open(root);
    const invalid = createInput([material(1), material(2, { content: "   \n" })]);

    await expectCode(
      composition.ingest.ingest(invalid, ACTOR, { requestId: request(1) }),
      "invalid_input",
    );
    expect(
      inspect(root, (database) => ({
        subjects: scalar(database, "SELECT count(*) FROM subjects"),
        blobs: scalar(database, "SELECT count(*) FROM blobs"),
        operations: scalar(database, "SELECT count(*) FROM operations"),
      })),
    ).toEqual({ subjects: 0, blobs: 0, operations: 0 });
    const prefixes = await readdir(join(root, "blobs", "sha256"));
    expect(prefixes).toEqual([]);
  });

  it("rejects computer-use transcripts outside a trusted private capture session", async () => {
    const root = await makeRoot();
    const composition = await open(root);
    const privateTranscript = material(1, {
      kind: "transcript",
      source: {
        medium: "conversation",
        access: "private",
        role: "personal_communication",
        capturedAt: AT,
      },
      derivation: {
        kind: "host_extract",
        method: "computer_use_transcript",
        producer: "codex-private-capture",
      },
      sensitivity: "private",
    });

    await expectCode(
      composition.ingest.ingest(createInput([privateTranscript]), ACTOR, {
        requestId: request(1),
      }),
      "invalid_input",
    );
    expect(
      inspect(root, (database) => ({
        spaces: scalar(database, "SELECT count(*) FROM spaces"),
        subjects: scalar(database, "SELECT count(*) FROM subjects"),
        aliases: scalar(database, "SELECT count(*) FROM subject_aliases"),
        identityHints: scalar(database, "SELECT count(*) FROM subject_identity_hints"),
        subjectStates: scalar(database, "SELECT count(*) FROM subject_states"),
        blobs: scalar(database, "SELECT count(*) FROM blobs"),
        materials: scalar(database, "SELECT count(*) FROM materials"),
        pending: scalar(database, "SELECT count(*) FROM pending_jobs"),
        operations: scalar(database, "SELECT count(*) FROM operations"),
        events: scalar(database, "SELECT count(*) FROM events"),
      })),
    ).toEqual({
      spaces: 0,
      subjects: 0,
      aliases: 0,
      identityHints: 0,
      subjectStates: 0,
      blobs: 0,
      materials: 0,
      pending: 0,
      operations: 0,
      events: 0,
    });
    expect(await readdir(join(root, "blobs", "sha256"))).toEqual([]);
  });

  it("shares ambiguous exact-locator resolution with standalone subject creation", async () => {
    const root = await makeRoot();
    const composition = await open(root);
    const ada = await composition.subjects.create(
      {
        displayName: "Ada",
        identityHints: [{ kind: "url", value: "https://example.com/ada" }],
      },
      ACTOR,
      { requestId: request(1) },
    );
    const grace = await composition.subjects.create(
      {
        displayName: "Grace",
        identityHints: [{ kind: "account", provider: "x", handle: "grace" }],
      },
      ACTOR,
      { requestId: request(2) },
    );

    const error = await expectCode(
      composition.ingest.ingest(
        {
          subject: {
            kind: "create",
            input: {
              displayName: "Mixed target",
              identityHints: [
                { kind: "url", value: "https://example.com/ada" },
                { kind: "account", provider: "x", handle: "grace" },
              ],
            },
          },
          materials: [material(1)],
          enqueue: "now",
        },
        ACTOR,
        { requestId: request(3) },
      ),
      "ambiguous_subject",
    );
    const candidates =
      error.subjectResolution?.kind === "ambiguous" ? error.subjectResolution.candidates : [];
    expect(candidates.map((candidate) => candidate.id)).toEqual([ada.id, grace.id].sort());
    expect(
      inspect(root, (database) => ({
        subjects: scalar(database, "SELECT count(*) FROM subjects"),
        materials: scalar(database, "SELECT count(*) FROM materials"),
        blobs: scalar(database, "SELECT count(*) FROM blobs"),
        pending: scalar(database, "SELECT count(*) FROM pending_jobs"),
        operations: scalar(database, "SELECT count(*) FROM operations"),
        events: scalar(database, "SELECT count(*) FROM events"),
      })),
    ).toEqual({ subjects: 2, materials: 0, blobs: 0, pending: 0, operations: 2, events: 2 });
  });

  it("queues at the auto threshold, replaces stale pending on append, and reuses on duplicate", async () => {
    const root = await makeRoot();
    const composition = await open(root);
    const first = await composition.ingest.ingest(
      createInput([material(1), material(2)], "auto"),
      ACTOR,
      { requestId: request(1) },
    );
    expect(first.job).toBeUndefined();

    const third = await composition.ingest.ingest(
      existingInput(first.subject.id, [material(3)], "auto"),
      ACTOR,
      { requestId: request(2) },
    );
    expect(third.job).toMatchObject({ generation: 2, addedMaterialCount: 3 });
    const thirdJob = third.job?.id;

    const fourth = await composition.ingest.ingest(
      existingInput(first.subject.id, [material(4)], "auto"),
      ACTOR,
      { requestId: request(3) },
    );
    expect(fourth.job?.id).not.toBe(thirdJob);
    expect(fourth).toMatchObject({ generation: 3, job: { addedMaterialCount: 4 } });

    const duplicate = await composition.ingest.ingest(
      existingInput(first.subject.id, [material(4)], "now"),
      ACTOR,
      { requestId: request(4) },
    );
    expect(duplicate).toMatchObject({ kind: "unchanged", generation: 3 });
    expect(duplicate.job?.id).toBe(fourth.job?.id);
  });

  it("rolls back every authority row on a pre-commit failure and retries without a journal", async () => {
    const root = await makeRoot();
    let fail = true;
    const composition = await open(root, new SequenceIds(), new FakeClock(), {
      beforeTransactionCommit: () => {
        if (!fail) return;
        fail = false;
        throw new Error("stop before commit");
      },
    });

    await expect(
      composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) }),
    ).rejects.toThrow("stop before commit");
    expect(
      inspect(root, (database) => ({
        spaces: scalar(database, "SELECT count(*) FROM spaces"),
        subjects: scalar(database, "SELECT count(*) FROM subjects"),
        aliases: scalar(database, "SELECT count(*) FROM subject_aliases"),
        identityHints: scalar(database, "SELECT count(*) FROM subject_identity_hints"),
        subjectStates: scalar(database, "SELECT count(*) FROM subject_states"),
        blobs: scalar(database, "SELECT count(*) FROM blobs"),
        materials: scalar(database, "SELECT count(*) FROM materials"),
        pending: scalar(database, "SELECT count(*) FROM pending_jobs"),
        operations: scalar(database, "SELECT count(*) FROM operations"),
        events: scalar(database, "SELECT count(*) FROM events"),
      })),
    ).toEqual({
      spaces: 0,
      subjects: 0,
      aliases: 0,
      identityHints: 0,
      subjectStates: 0,
      blobs: 0,
      materials: 0,
      pending: 0,
      operations: 0,
      events: 0,
    });
    const expectedContent = material(1).content;
    const unreferencedBlob = blobPath(root, expectedContent);
    expect((await lstat(unreferencedBlob)).isFile()).toBe(true);
    expect(await readFile(unreferencedBlob, "utf8")).toBe(expectedContent);

    await expect(
      composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) }),
    ).resolves.toMatchObject({ kind: "ingested", created: true });
  });

  it("fails closed when pending metadata disagrees with its empty-version baseline", async () => {
    const root = await makeRoot();
    const composition = await open(root);
    const first = await composition.ingest.ingest(
      createInput([material(1), material(2), material(3)]),
      ACTOR,
      { requestId: request(1) },
    );
    composition.close();
    compositions.splice(compositions.indexOf(composition), 1);

    const database = new DatabaseSync(join(root, "store.sqlite3"));
    database.prepare("UPDATE pending_jobs SET added_material_count = 1").run();
    database.close();

    const reopened = await open(root);
    await expectCode(
      reopened.ingest.ingest(existingInput(first.subject.id, [material(1)]), ACTOR, {
        requestId: request(2),
      }),
      "storage_corrupt",
    );
    expect(
      inspect(root, (authority) => ({
        operations: scalar(authority, "SELECT count(*) FROM operations"),
        events: scalar(authority, "SELECT count(*) FROM events"),
      })),
    ).toEqual({ operations: 1, events: 3 });
  });

  it("maps an out-of-range SQLite integer to storage corruption", async () => {
    const root = await makeRoot();
    const composition = await open(root);
    const first = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });

    const database = new DatabaseSync(join(root, "store.sqlite3"));
    database.exec("PRAGMA ignore_check_constraints = ON");
    database
      .prepare("UPDATE pending_jobs SET total_material_count = ?")
      .run(9_223_372_036_854_775_807n);
    database.close();

    await expectCode(
      composition.ingest.ingest(existingInput(first.subject.id, [material(1)]), ACTOR, {
        requestId: request(2),
      }),
      "storage_corrupt",
    );
  });

  it("fails closed when the reserved People space drifts", async () => {
    const root = await makeRoot();
    const composition = await open(root);
    const first = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });

    const database = new DatabaseSync(join(root, "store.sqlite3"));
    database
      .prepare(
        `UPDATE spaces
         SET display_name = 'Persons', canonical_label = 'Persons', kind = 'custom'
         WHERE id = ?`,
      )
      .run(first.subject.space.id);
    database.close();

    await expectCode(
      composition.ingest.ingest(existingInput(first.subject.id, [material(2)]), ACTOR, {
        requestId: request(2),
      }),
      "storage_corrupt",
    );
    expect(
      inspect(root, (authority) => ({
        materials: scalar(authority, "SELECT count(*) FROM materials"),
        operations: scalar(authority, "SELECT count(*) FROM operations"),
        events: scalar(authority, "SELECT count(*) FROM events"),
      })),
    ).toEqual({ materials: 1, operations: 1, events: 3 });
  });

  it("fails closed on dangling version pointers without committing an ingest", async () => {
    const root = await makeRoot();
    const composition = await open(root);
    const first = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    const danglingVersion = `version_${"a".repeat(64)}`;
    const tamper = (column: "current_version_id" | "suspended_version_id"): void => {
      const database = new DatabaseSync(join(root, "store.sqlite3"));
      database.exec("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON");
      database
        .prepare(
          `UPDATE subject_states
           SET current_version_id = NULL, suspended_version_id = NULL, ${column} = ?`,
        )
        .run(danglingVersion);
      database.exec("PRAGMA ignore_check_constraints = OFF");
      database.close();
    };

    tamper("current_version_id");
    await expectCode(
      composition.ingest.ingest(existingInput(first.subject.id, [material(2)]), ACTOR, {
        requestId: request(2),
      }),
      "storage_corrupt",
    );
    tamper("suspended_version_id");
    await expectCode(
      composition.ingest.ingest(existingInput(first.subject.id, [material(3)]), ACTOR, {
        requestId: request(3),
      }),
      "storage_corrupt",
    );
    expect(
      inspect(root, (database) => ({
        materials: scalar(database, "SELECT count(*) FROM materials"),
        blobs: scalar(database, "SELECT count(*) FROM blobs"),
        pending: scalar(database, "SELECT count(*) FROM pending_jobs"),
        operations: scalar(database, "SELECT count(*) FROM operations"),
        events: scalar(database, "SELECT count(*) FROM events"),
      })),
    ).toEqual({ materials: 1, blobs: 1, pending: 1, operations: 1, events: 3 });
  });

  it("verifies redundant material kind and blob length before accepting a duplicate", async () => {
    const root = await makeRoot();
    let composition = await open(root);
    const first = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    composition.close();
    compositions.splice(compositions.indexOf(composition), 1);

    let database = new DatabaseSync(join(root, "store.sqlite3"));
    database.prepare("UPDATE materials SET kind = 'document'").run();
    database.close();
    composition = await open(root);
    await expectCode(
      composition.ingest.ingest(existingInput(first.subject.id, [material(1)]), ACTOR, {
        requestId: request(2),
      }),
      "storage_corrupt",
    );
    composition.close();
    compositions.splice(compositions.indexOf(composition), 1);

    database = new DatabaseSync(join(root, "store.sqlite3"));
    database.prepare("UPDATE materials SET kind = 'web'").run();
    database.prepare("UPDATE blobs SET byte_length = byte_length + 1").run();
    database.close();
    composition = await open(root);
    await expectCode(
      composition.ingest.ingest(existingInput(first.subject.id, [material(1)]), ACTOR, {
        requestId: request(3),
      }),
      "storage_corrupt",
    );
    expect(
      inspect(root, (authority) => ({
        operations: scalar(authority, "SELECT count(*) FROM operations"),
        events: scalar(authority, "SELECT count(*) FROM events"),
      })),
    ).toEqual({ operations: 1, events: 3 });
  });

  it("fails closed when stored fact, identity semantics, or immutable blob bytes are corrupt", async () => {
    const root = await makeRoot();
    const composition = await open(root);
    const first = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    const digest = first.items[0]!.contentDigest;
    composition.close();
    compositions.splice(compositions.indexOf(composition), 1);

    const database = new DatabaseSync(join(root, "store.sqlite3"));
    const originalRecord = String(
      database.prepare("SELECT record_json FROM materials").get()?.record_json,
    );
    const originalIdentity = String(
      database.prepare("SELECT identity_json FROM materials").get()?.identity_json,
    );
    const tamperedRecord = JSON.parse(originalRecord) as { source: { title?: string } };
    tamperedRecord.source.title = "Tampered without resealing";
    database.prepare("UPDATE materials SET record_json = ?").run(JSON.stringify(tamperedRecord));
    database.close();
    const badChecksum = await open(root);
    await expectCode(
      badChecksum.ingest.ingest(existingInput(first.subject.id, [material(1)]), ACTOR, {
        requestId: request(2),
      }),
      "storage_corrupt",
    );
    badChecksum.close();
    compositions.splice(compositions.indexOf(badChecksum), 1);

    const identityDatabase = new DatabaseSync(join(root, "store.sqlite3"));
    identityDatabase
      .prepare("UPDATE materials SET record_json = ?, identity_json = '{}'")
      .run(originalRecord);
    identityDatabase.close();
    const reopened = await open(root);
    await expectCode(
      reopened.ingest.ingest(existingInput(first.subject.id, [material(1)]), ACTOR, {
        requestId: request(3),
      }),
      "storage_corrupt",
    );
    reopened.close();
    compositions.splice(compositions.indexOf(reopened), 1);

    const hexadecimal = digest.slice("sha256_".length);
    const repair = new DatabaseSync(join(root, "store.sqlite3"));
    repair.prepare("UPDATE materials SET identity_json = ?").run(originalIdentity);
    repair.close();
    await writeFile(join(root, "blobs", "sha256", hexadecimal.slice(0, 2), digest), "bad");
    const blobCorrupt = await open(root);
    await expectCode(
      blobCorrupt.ingest.ingest(existingInput(first.subject.id, [material(1)]), ACTOR, {
        requestId: request(4),
      }),
      "storage_corrupt",
    );
    expect(await readFile(join(root, "store.sqlite3"))).not.toHaveLength(0);
  });

  it("fails closed without repairing a referenced blob missing from disk", async () => {
    const root = await makeRoot();
    const composition = await open(root);
    const first = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    const digest = first.items[0]!.contentDigest;
    const hexadecimal = digest.slice("sha256_".length);
    const target = join(root, "blobs", "sha256", hexadecimal.slice(0, 2), digest);
    await rm(target);

    await expectCode(
      composition.ingest.ingest(existingInput(first.subject.id, [material(1)]), ACTOR, {
        requestId: request(2),
      }),
      "storage_corrupt",
    );
    expect(
      inspect(root, (database) => ({
        materials: scalar(database, "SELECT count(*) FROM materials"),
        operations: scalar(database, "SELECT count(*) FROM operations"),
        events: scalar(database, "SELECT count(*) FROM events"),
      })),
    ).toEqual({ materials: 1, operations: 1, events: 3 });
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const concurrent = await Promise.all([
      expectCode(
        composition.ingest.ingest(existingInput(first.subject.id, [material(1)]), ACTOR, {
          requestId: request(3),
        }),
        "storage_corrupt",
      ),
      expectCode(
        composition.ingest.ingest(existingInput(first.subject.id, [material(1)]), ACTOR, {
          requestId: request(4),
        }),
        "storage_corrupt",
      ),
    ]);
    expect(concurrent).toHaveLength(2);
    expect(
      inspect(root, (database) => ({
        materials: scalar(database, "SELECT count(*) FROM materials"),
        operations: scalar(database, "SELECT count(*) FROM operations"),
        events: scalar(database, "SELECT count(*) FROM events"),
      })),
    ).toEqual({ materials: 1, operations: 1, events: 3 });
    await expect(readFile(target, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed without recreating a blob authority row required by existing material", async () => {
    const root = await makeRoot();
    const composition = await open(root);
    const first = await composition.ingest.ingest(createInput(), ACTOR, { requestId: request(1) });
    const grace = await composition.subjects.create(
      {
        displayName: "Grace",
        identityHints: [{ kind: "account", provider: "x", handle: "grace" }],
      },
      ACTOR,
      { requestId: request(2) },
    );
    const database = new DatabaseSync(join(root, "store.sqlite3"));
    try {
      database.exec("PRAGMA foreign_keys = OFF");
      database.prepare("DELETE FROM blobs WHERE digest = ?").run(first.items[0]!.contentDigest);
    } finally {
      database.close();
    }

    await expectCode(
      composition.ingest.ingest(
        existingInput(grace.id, [material(2, { content: material(1).content })]),
        ACTOR,
        { requestId: request(3) },
      ),
      "storage_corrupt",
    );
    expect(
      inspect(root, (sqlite) => ({
        subjects: scalar(sqlite, "SELECT count(*) FROM subjects"),
        blobs: scalar(sqlite, "SELECT count(*) FROM blobs"),
        materials: scalar(sqlite, "SELECT count(*) FROM materials"),
        operations: scalar(sqlite, "SELECT count(*) FROM operations"),
        events: scalar(sqlite, "SELECT count(*) FROM events"),
      })),
    ).toEqual({ subjects: 2, blobs: 0, materials: 1, operations: 2, events: 4 });
  });
});
