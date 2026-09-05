import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  BUILTIN_PEOPLE_SPACE_ID,
  DistillyError,
  requestIdSchema,
  type ActorContext,
  type CreateSubjectInput,
  type EngineEvent,
  type EventId,
  type IsoDateTime,
  type JobId,
  type LeaseId,
  type LeaseOwnerId,
  type RequestId,
  type SpaceId,
  type SubjectId,
} from "@distilly/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { InProcessEventBus } from "../defaults/in-process-event-bus.js";
import type { Clock } from "../defaults/system-clock.js";
import { canonicalJson } from "../facts/canonical-json.js";
import type { IdGenerator } from "../ports/id-generator.js";
import { computeMutationInputChecksum } from "../storage/mutation-ledger.js";
import { SqliteEngineStore } from "../storage/sqlite-engine-store.js";
import type { SubjectCreateServiceHooks } from "./service.js";
import { SubjectCreateService } from "./service.js";

const AT = "2026-08-30T10:00:00.000Z" as IsoDateTime;
const ACTOR: ActorContext = { kind: "sdk", id: "subject-create-test" };

class FakeClock implements Clock {
  now(): IsoDateTime {
    return AT;
  }
}

class SequenceIds implements IdGenerator {
  private subject = 1;
  private space = 16;
  private event = 1;
  spaceCalls = 0;

  subjectId(): SubjectId {
    return `subject_${(this.subject++).toString(16).padStart(32, "0")}` as SubjectId;
  }

  spaceId(): SpaceId {
    this.spaceCalls += 1;
    return `space_${(this.space++).toString(16).padStart(32, "0")}` as SpaceId;
  }

  eventId(): EventId {
    return `event_${(this.event++).toString(16).padStart(32, "0")}` as EventId;
  }

  jobId(): JobId {
    return "job_00000000000000000000000000000001" as JobId;
  }

  leaseId(): LeaseId {
    return "lease_00000000000000000000000000000001" as LeaseId;
  }

  leaseOwnerId(): LeaseOwnerId {
    return "lease_owner_00000000000000000000000000000001" as LeaseOwnerId;
  }
}

interface Harness {
  readonly root: string;
  readonly store: SqliteEngineStore;
  readonly service: SubjectCreateService;
  readonly eventBus: InProcessEventBus;
  readonly published: EngineEvent[];
  readonly ids: SequenceIds;
}

const roots: string[] = [];
const stores: SqliteEngineStore[] = [];

const request = (digit: number): RequestId =>
  requestIdSchema.parse(`req_${digit.toString(16).padStart(32, "0")}`);

const input = (
  displayName: string,
  overrides: Omit<Partial<CreateSubjectInput>, "displayName"> = {},
): CreateSubjectInput => ({ displayName, ...overrides });

const open = async (hooks?: SubjectCreateServiceHooks): Promise<Harness> => {
  const root = await mkdtemp(join(tmpdir(), "distilly-subject-create-"));
  roots.push(root);
  const store = await SqliteEngineStore.open(root);
  stores.push(store);
  const published: EngineEvent[] = [];
  const eventBus = new InProcessEventBus();
  const ids = new SequenceIds();
  eventBus.subscribe((event) => {
    published.push(event);
  });
  return {
    root,
    store,
    eventBus,
    ids,
    published,
    service: new SubjectCreateService({
      store,
      ids,
      clock: new FakeClock(),
      eventBus,
      ...(hooks === undefined ? {} : { hooks }),
    }),
  };
};

const deleteSubjectWithoutForeignKeys = (root: string, subjectId: SubjectId): void => {
  const database = new DatabaseSync(join(root, "store.sqlite3"));
  try {
    database.exec("PRAGMA foreign_keys = OFF");
    database.prepare("DELETE FROM subjects WHERE id = ?").run(subjectId);
  } finally {
    database.close();
  }
};

const deleteSpaceWithoutForeignKeys = (root: string, spaceId: SpaceId): void => {
  const database = new DatabaseSync(join(root, "store.sqlite3"));
  try {
    database.exec("PRAGMA foreign_keys = OFF");
    database.prepare("DELETE FROM spaces WHERE id = ?").run(spaceId);
  } finally {
    database.close();
  }
};

const setSubjectVersionWithoutForeignKeys = (
  root: string,
  subjectId: SubjectId,
  column: "current_version_id" | "suspended_version_id",
  versionId: string,
): void => {
  const database = new DatabaseSync(join(root, "store.sqlite3"));
  try {
    database.exec("PRAGMA foreign_keys = OFF");
    database
      .prepare(
        `UPDATE subject_states
         SET current_version_id = NULL, suspended_version_id = NULL, ${column} = ?
         WHERE subject_id = ?`,
      )
      .run(versionId, subjectId);
  } finally {
    database.close();
  }
};

const count = (store: SqliteEngineStore, table: string): number =>
  store.read((database) => {
    const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get();
    if (typeof row?.count !== "number") throw new Error("count unavailable");
    return row.count;
  });

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
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SQLite subject create service", () => {
  it("creates in the default, inline, and explicitly existing spaces", async () => {
    const harness = await open();
    const first = await harness.service.create(input("Ada Lovelace", { aliases: ["Ada"] }), ACTOR, {
      requestId: request(1),
    });
    expect(first).toMatchObject({
      displayName: "Ada Lovelace",
      aliases: ["Ada"],
      space: { id: BUILTIN_PEOPLE_SPACE_ID, displayName: "People", kind: "people" },
      lifecycle: "active",
    });
    expect(harness.ids.spaceCalls).toBe(0);

    const inline = await harness.service.create(
      input("Mira", { space: { displayName: "Novel", kind: "fictional" } }),
      ACTOR,
      { requestId: request(2) },
    );
    expect(inline.space).toMatchObject({ displayName: "Novel", kind: "fictional" });
    expect(inline.space.id).not.toBe(BUILTIN_PEOPLE_SPACE_ID);
    expect(harness.ids.spaceCalls).toBe(1);
    const reusedInline = await harness.service.create(
      input("Alice", { space: { displayName: "Novel", kind: "fictional" } }),
      ACTOR,
      { requestId: request(4) },
    );
    expect(reusedInline.space.id).toBe(inline.space.id);
    expect(harness.ids.spaceCalls).toBe(1);

    const existingSpaceId = "space_ffffffffffffffffffffffffffffffff" as SpaceId;
    harness.store.write((database) => {
      database
        .prepare(
          `INSERT INTO spaces(id, display_name, canonical_label, kind)
           VALUES (?, 'Team', 'Team', 'custom')`,
        )
        .run(existingSpaceId);
    });
    const existing = await harness.service.create(
      input("Grace", { spaceId: existingSpaceId }),
      ACTOR,
      { requestId: request(3) },
    );
    expect(existing.space).toEqual({
      id: existingSpaceId,
      displayName: "Team",
      kind: "custom",
    });
    expect(count(harness.store, "subjects")).toBe(4);
    expect(count(harness.store, "operations")).toBe(4);
    expect(count(harness.store, "events")).toBe(4);
  });

  it("replays exactly and rejects changed input, actor, and method for one RequestId", async () => {
    const harness = await open();
    const createInput = input("Ada", {
      identityHints: [{ kind: "url", value: "https://example.com/ada" }],
    });
    const first = await harness.service.create(createInput, ACTOR, { requestId: request(1) });
    await expect(
      harness.service.create(createInput, ACTOR, { requestId: request(1) }),
    ).resolves.toEqual(first);
    expect(harness.published).toHaveLength(1);
    expect(count(harness.store, "subjects")).toBe(1);

    await expectCode(
      harness.service.create(input("Changed"), ACTOR, { requestId: request(1) }),
      "idempotency_conflict",
    );
    await expectCode(
      harness.service.create(
        createInput,
        { ...ACTOR, id: "another-actor" },
        {
          requestId: request(1),
        },
      ),
      "idempotency_conflict",
    );

    const ingestChecksum = computeMutationInputChecksum("materials.ingest", {}, ACTOR);
    harness.store.write((database) => {
      database
        .prepare(
          `INSERT INTO operations(
             request_id, method, scope_subject_id, actor_json,
             input_checksum, result_json, completed_at
           ) VALUES (?, 'materials.ingest', ?, ?, ?, '{}', ?)`,
        )
        .run(request(2), first.id, canonicalJson(ACTOR), ingestChecksum, AT);
    });
    await expectCode(
      harness.service.create(input("Other"), ACTOR, { requestId: request(2) }),
      "idempotency_conflict",
    );
  });

  it("uses global locators, same-space names, ambiguity, and proven-different locators", async () => {
    const harness = await open();
    const ada = await harness.service.create(
      input("Ada", {
        aliases: ["Countess"],
        identityHints: [{ kind: "url", value: "https://example.com/ada" }],
      }),
      ACTOR,
      { requestId: request(1) },
    );

    const locatorError = await expectCode(
      harness.service.create(
        input("Different label", {
          space: { displayName: "Other", kind: "custom" },
          identityHints: [{ kind: "url", value: "https://example.com/ada#bio" }],
        }),
        ACTOR,
        { requestId: request(2) },
      ),
      "already_exists",
    );
    expect(locatorError.subjectResolution).toMatchObject({
      kind: "found",
      subject: { id: ada.id },
    });
    expect(count(harness.store, "spaces")).toBe(1);

    await expectCode(
      harness.service.create(input("Ada"), ACTOR, { requestId: request(3) }),
      "already_exists",
    );
    await expectCode(
      harness.service.create(input("Countess"), ACTOR, { requestId: request(8) }),
      "already_exists",
    );
    await expect(
      harness.service.create(
        input("Ada", { space: { displayName: "Elsewhere", kind: "custom" } }),
        ACTOR,
        { requestId: request(4) },
      ),
    ).resolves.toMatchObject({ space: { displayName: "Elsewhere" } });

    const firstSam = await harness.service.create(
      input("Sam", {
        identityHints: [{ kind: "account", provider: "x", handle: "sam-one" }],
      }),
      ACTOR,
      { requestId: request(5) },
    );
    const secondSam = await harness.service.create(
      input("Sam", {
        identityHints: [{ kind: "account", provider: "x", handle: "sam-two" }],
      }),
      ACTOR,
      { requestId: request(6) },
    );
    expect(secondSam.id).not.toBe(firstSam.id);

    const ambiguous = await expectCode(
      harness.service.create(input("Sam"), ACTOR, { requestId: request(7) }),
      "ambiguous_subject",
    );
    const candidates =
      ambiguous.subjectResolution?.kind === "ambiguous"
        ? ambiguous.subjectResolution.candidates
        : [];
    expect(candidates.map((candidate) => candidate.id)).toEqual([firstSam.id, secondSam.id].sort());
  });

  it("checks global locators before space resolution and reports conflicting targets as ambiguous", async () => {
    const harness = await open();
    const ada = await harness.service.create(
      input("Ada", {
        identityHints: [{ kind: "url", value: "https://example.com/ada" }],
      }),
      ACTOR,
      { requestId: request(1) },
    );
    const grace = await harness.service.create(
      input("Grace", {
        identityHints: [{ kind: "account", provider: "x", handle: "grace" }],
      }),
      ACTOR,
      { requestId: request(2) },
    );
    const missingSpaceId = "space_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as SpaceId;

    const existing = await expectCode(
      harness.service.create(
        input("Different label", {
          spaceId: missingSpaceId,
          identityHints: [{ kind: "url", value: "https://example.com/ada#profile" }],
        }),
        ACTOR,
        { requestId: request(3) },
      ),
      "already_exists",
    );
    expect(existing.subjectResolution).toMatchObject({
      kind: "found",
      subject: { id: ada.id },
    });

    const mixed = await expectCode(
      harness.service.create(
        input("Mixed target", {
          identityHints: [
            { kind: "url", value: "https://example.com/ada" },
            { kind: "account", provider: "x", handle: "grace" },
          ],
        }),
        ACTOR,
        { requestId: request(4) },
      ),
      "ambiguous_subject",
    );
    const candidates =
      mixed.subjectResolution?.kind === "ambiguous" ? mixed.subjectResolution.candidates : [];
    expect(candidates.map((candidate) => candidate.id)).toEqual([ada.id, grace.id].sort());
    expect({
      spaces: count(harness.store, "spaces"),
      subjects: count(harness.store, "subjects"),
      operations: count(harness.store, "operations"),
      events: count(harness.store, "events"),
    }).toEqual({ spaces: 1, subjects: 2, operations: 2, events: 2 });
  });

  it("fails closed on v1 subject pointers before version authority exists", async () => {
    const harness = await open();
    const subject = await harness.service.create(
      input("Ada", {
        identityHints: [{ kind: "url", value: "https://example.com/ada" }],
      }),
      ACTOR,
      { requestId: request(1) },
    );
    const danglingVersion = `version_${"a".repeat(64)}`;
    const tamper = (column: "current_version_id" | "suspended_version_id"): void => {
      setSubjectVersionWithoutForeignKeys(harness.root, subject.id, column, danglingVersion);
    };

    tamper("current_version_id");
    await expectCode(
      harness.service.create(
        input("Different", {
          identityHints: [{ kind: "url", value: "https://example.com/ada" }],
        }),
        ACTOR,
        { requestId: request(2) },
      ),
      "storage_corrupt",
    );
    tamper("suspended_version_id");
    await expectCode(
      harness.service.create(
        input("Different", {
          identityHints: [{ kind: "url", value: "https://example.com/ada" }],
        }),
        ACTOR,
        { requestId: request(3) },
      ),
      "storage_corrupt",
    );
    expect({
      subjects: count(harness.store, "subjects"),
      operations: count(harness.store, "operations"),
      events: count(harness.store, "events"),
    }).toEqual({ subjects: 1, operations: 1, events: 1 });
  });

  it("treats dangling locator and alias parents as corruption without recording a mutation", async () => {
    const locatorHarness = await open();
    const locatorSubject = await locatorHarness.service.create(
      input("Ada", {
        identityHints: [{ kind: "url", value: "https://example.com/ada" }],
      }),
      ACTOR,
      { requestId: request(1) },
    );
    deleteSubjectWithoutForeignKeys(locatorHarness.root, locatorSubject.id);

    await expectCode(
      locatorHarness.service.create(
        input("Different", {
          identityHints: [{ kind: "url", value: "https://example.com/ada" }],
        }),
        ACTOR,
        { requestId: request(2) },
      ),
      "storage_corrupt",
    );
    expect({
      subjects: count(locatorHarness.store, "subjects"),
      operations: count(locatorHarness.store, "operations"),
      events: count(locatorHarness.store, "events"),
    }).toEqual({ subjects: 0, operations: 1, events: 1 });

    const aliasHarness = await open();
    const aliasSubject = await aliasHarness.service.create(
      input("Ada", { aliases: ["Countess"] }),
      ACTOR,
      { requestId: request(3) },
    );
    deleteSubjectWithoutForeignKeys(aliasHarness.root, aliasSubject.id);

    await expectCode(
      aliasHarness.service.create(input("Countess"), ACTOR, { requestId: request(4) }),
      "storage_corrupt",
    );
    expect({
      subjects: count(aliasHarness.store, "subjects"),
      operations: count(aliasHarness.store, "operations"),
      events: count(aliasHarness.store, "events"),
    }).toEqual({ subjects: 0, operations: 1, events: 1 });
  });

  it("does not fully validate a same-label alias owner from an unrelated space", async () => {
    const harness = await open();
    const unrelated = await harness.service.create(
      input("Ada", {
        aliases: ["Countess"],
        space: { displayName: "Other", kind: "custom" },
      }),
      ACTOR,
      { requestId: request(1) },
    );
    setSubjectVersionWithoutForeignKeys(
      harness.root,
      unrelated.id,
      "current_version_id",
      `version_${"a".repeat(64)}`,
    );

    await expect(
      harness.service.create(input("Countess"), ACTOR, { requestId: request(2) }),
    ).resolves.toMatchObject({
      displayName: "Countess",
      space: { id: BUILTIN_PEOPLE_SPACE_ID },
    });
    expect({
      subjects: count(harness.store, "subjects"),
      operations: count(harness.store, "operations"),
      events: count(harness.store, "events"),
    }).toEqual({ subjects: 2, operations: 2, events: 2 });
  });

  it("fails closed when an alias owner or built-in subject references a missing space", async () => {
    const aliasHarness = await open();
    const unrelated = await aliasHarness.service.create(
      input("Ada", {
        aliases: ["Countess"],
        space: { displayName: "Other", kind: "custom" },
      }),
      ACTOR,
      { requestId: request(1) },
    );
    deleteSpaceWithoutForeignKeys(aliasHarness.root, unrelated.space.id);

    await expectCode(
      aliasHarness.service.create(input("Countess"), ACTOR, { requestId: request(2) }),
      "storage_corrupt",
    );
    expect({
      spaces: count(aliasHarness.store, "spaces"),
      subjects: count(aliasHarness.store, "subjects"),
      operations: count(aliasHarness.store, "operations"),
      events: count(aliasHarness.store, "events"),
    }).toEqual({ spaces: 0, subjects: 1, operations: 1, events: 1 });

    const builtinHarness = await open();
    await builtinHarness.service.create(input("Ada"), ACTOR, { requestId: request(3) });
    deleteSpaceWithoutForeignKeys(builtinHarness.root, BUILTIN_PEOPLE_SPACE_ID);

    await expectCode(
      builtinHarness.service.create(input("Grace"), ACTOR, { requestId: request(4) }),
      "storage_corrupt",
    );
    expect({
      spaces: count(builtinHarness.store, "spaces"),
      subjects: count(builtinHarness.store, "subjects"),
      operations: count(builtinHarness.store, "operations"),
      events: count(builtinHarness.store, "events"),
    }).toEqual({ spaces: 0, subjects: 1, operations: 1, events: 1 });
  });

  it("rolls back inline identity, operation, and event before COMMIT and publishes only afterward", async () => {
    let fail = true;
    let postCommitSnapshot: { readonly operations: number; readonly events: number } | undefined;
    const harness = await open({
      beforeTransactionCommit: () => {
        if (!fail) return;
        fail = false;
        throw new Error("stop before commit");
      },
    });
    harness.eventBus.subscribe(() => {
      postCommitSnapshot = {
        operations: count(harness.store, "operations"),
        events: count(harness.store, "events"),
      };
    });

    const createInput = input("Rollback", {
      space: { displayName: "Transient", kind: "custom" },
    });
    await expect(
      harness.service.create(createInput, ACTOR, { requestId: request(1) }),
    ).rejects.toThrow("stop before commit");
    expect({
      spaces: count(harness.store, "spaces"),
      subjects: count(harness.store, "subjects"),
      operations: count(harness.store, "operations"),
      events: count(harness.store, "events"),
    }).toEqual({ spaces: 0, subjects: 0, operations: 0, events: 0 });
    expect(harness.published).toEqual([]);

    const result = await harness.service.create(createInput, ACTOR, { requestId: request(1) });
    expect(result.space.displayName).toBe("Transient");
    expect(postCommitSnapshot).toEqual({ operations: 1, events: 1 });
    expect(harness.published).toEqual([{ kind: "subject.created", subjectId: result.id, at: AT }]);
    await harness.service.create(createInput, ACTOR, { requestId: request(1) });
    expect(harness.published).toHaveLength(1);
  });
});
