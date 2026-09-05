import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  briefMaterialRefSchema,
  DistillyError,
  engineMethodSchemas,
  facetPathSchema,
  isoDateTimeSchema,
  leaseOwnerIdSchema,
  requestIdSchema,
} from "@distilly/protocol";
import type {
  ActorContext,
  ClientSessionContext,
  CommitInput,
  IngestInput,
  IsoDateTime,
  RequestId,
  SubjectId,
  VersionId,
} from "@distilly/protocol";
import { afterEach, describe, expect, it } from "vitest";

import type { Clock } from "../defaults/system-clock.js";
import type { InternalEngineComposition } from "../ingest/composition.js";
import { createInternalEngineComposition } from "../ingest/composition.js";

const AT = isoDateTimeSchema.parse("2026-08-31T18:00:00.000Z");
const LATER = isoDateTimeSchema.parse("2026-08-31T18:10:00.000Z");
const LATEST = isoDateTimeSchema.parse("2026-08-31T18:20:00.000Z");
const SDK_ACTOR: ActorContext = { kind: "sdk", id: "sqlite-read-preview" };
const USER_ACTOR: ActorContext = { kind: "user", id: "sqlite-read-panel" };
const SESSION: ClientSessionContext = {
  actor: SDK_ACTOR,
  leaseOwner: leaseOwnerIdSchema.parse("lease_owner_00000000000000000000000000000001"),
  capacity: {
    maximumInputTokens: 4_194_304,
    maximumToolResultBytes: 4_194_304,
    source: "sdk_explicit",
  },
};
const FIRST_REF = briefMaterialRefSchema.parse("m001");
const IDENTITY = facetPathSchema.parse("identity");
const VOICE = facetPathSchema.parse("voice");

class MutableClock implements Clock {
  current: IsoDateTime = AT;

  now(): IsoDateTime {
    return this.current;
  }
}

const roots: string[] = [];
const compositions: InternalEngineComposition[] = [];
let requestCounter = 1;

const request = (): RequestId =>
  requestIdSchema.parse(`req_${(requestCounter++).toString(16).padStart(32, "0")}`);

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "distilly-sqlite-reads-"));
  roots.push(root);
  return root;
};

const open = async (root: string, clock: MutableClock): Promise<InternalEngineComposition> => {
  const composition = await createInternalEngineComposition({ root, clock });
  compositions.push(composition);
  return composition;
};

const close = (composition: InternalEngineComposition): void => {
  composition.close();
  const index = compositions.indexOf(composition);
  if (index !== -1) compositions.splice(index, 1);
};

const material = (
  label: string,
  content: string,
  capturedAt: IsoDateTime,
  sensitivity: "private" | "shareable" = "shareable",
): IngestInput["materials"][number] => ({
  clientRef: `read-${label}`,
  kind: "document",
  content,
  source: {
    uri: `https://example.test/read/${label}`,
    medium: "document",
    access: sensitivity === "private" ? "private" : "public",
    role: "first_party_expression",
    capturedAt,
  },
  derivation: { kind: "native_text" },
  sensitivity,
});

const commitInput = (
  briefing: Awaited<ReturnType<InternalEngineComposition["leases"]["brief"]>>,
  patch: CommitInput["patch"],
): CommitInput => ({
  jobId: briefing.job.id,
  generation: briefing.job.generation,
  leaseId: briefing.lease.id,
  briefContractDigest: briefing.contract.digest,
  materialSetHash: briefing.job.materialSetHash,
  ...(briefing.job.baseVersionId === undefined
    ? {}
    : { baseVersionId: briefing.job.baseVersionId }),
  patch,
});

interface SeedCurrent {
  readonly subjectId: SubjectId;
  readonly versionId: VersionId;
  readonly materialId: ReturnType<typeof materialIdFromIngest>;
}

const materialIdFromIngest = (
  result: Awaited<ReturnType<InternalEngineComposition["ingest"]["ingest"]>>,
) => result.items[0]!.materialId;

const seedCurrent = async (
  composition: InternalEngineComposition,
  clock: MutableClock,
  label: string,
  sensitivity: "private" | "shareable" = "shareable",
): Promise<SeedCurrent> => {
  const content = `${label} builds reliable local-first systems and explains evidence clearly.`;
  const ingested = await composition.ingest.ingest(
    {
      subject: {
        kind: "create",
        input: {
          displayName: label,
          aliases: [`${label} alias`],
          domainPack: "colleague",
          identityHints: [
            { kind: "url", value: `https://example.test/people/${label.toLowerCase()}` },
            { kind: "account", provider: "example", handle: label.toLowerCase() },
            { kind: "description", value: "Shared description is not a locator" },
          ],
        },
      },
      materials: [material(`${label}-first`, content, clock.current, sensitivity)],
      enqueue: "now",
    },
    SDK_ACTOR,
    { requestId: request() },
  );
  const briefing = await composition.leases.brief({ jobId: ingested.job!.id }, SESSION, {
    requestId: request(),
  });
  const committed = await composition.commits.commit(
    commitInput(briefing, {
      operations: [
        {
          op: "add",
          claim: {
            facet: IDENTITY,
            text: `${label} builds reliable local-first systems.`,
            evidence: [
              {
                kind: "brief_material",
                materialRef: FIRST_REF,
                quote: "builds reliable local-first systems",
              },
            ],
          },
        },
      ],
    }),
    SESSION,
    { requestId: request() },
  );
  if (committed.kind !== "current") throw new Error("Expected a current seed version.");
  return {
    subjectId: ingested.subject.id,
    versionId: committed.version.id,
    materialId: materialIdFromIngest(ingested),
  };
};

const addVersion = async (
  composition: InternalEngineComposition,
  clock: MutableClock,
  seed: SeedCurrent,
  label: string,
  suspended = false,
): Promise<{ readonly versionId: VersionId; readonly materialId: SeedCurrent["materialId"] }> => {
  const content = `${label} uses concise examples and names tradeoffs explicitly.`;
  const ingested = await composition.ingest.ingest(
    {
      subject: { kind: "existing", subjectId: seed.subjectId },
      materials: [material(label, content, clock.current)],
      enqueue: "now",
    },
    SDK_ACTOR,
    { requestId: request() },
  );
  const briefing = await composition.leases.brief({ jobId: ingested.job!.id }, SESSION, {
    requestId: request(),
  });
  const committed = await composition.commits.commit(
    commitInput(briefing, {
      operations: [
        {
          op: "add",
          claim: {
            facet: VOICE,
            text: `${label} names tradeoffs explicitly.`,
            evidence: [
              {
                kind: "brief_material",
                materialRef: FIRST_REF,
                quote: "names tradeoffs explicitly",
              },
            ],
          },
        },
      ],
      ...(suspended ? { reviewRequest: { note: "Preview review" } } : {}),
    }),
    SESSION,
    { requestId: request() },
  );
  if (suspended) {
    if (committed.kind !== "suspended") throw new Error("Expected a suspended version.");
    return {
      versionId: committed.candidate.id,
      materialId: materialIdFromIngest(ingested),
    };
  }
  if (committed.kind !== "current") throw new Error("Expected a current version.");
  return { versionId: committed.version.id, materialId: materialIdFromIngest(ingested) };
};

const expectCode = async (promise: Promise<unknown>, code: string): Promise<void> => {
  try {
    await promise;
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(DistillyError);
    expect(error).toMatchObject({ code });
  }
};

afterEach(async () => {
  for (const composition of compositions.splice(0)) composition.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SQLite Preview verified reads", () => {
  it("reads subjects, profiles, materials, versions, diffs, and lineage after commit", async () => {
    const root = await temporaryRoot();
    const clock = new MutableClock();
    const composition = await open(root, clock);
    const first = await seedCurrent(composition, clock, "Mira");
    clock.current = LATER;
    const second = await addVersion(composition, clock, first, "Mira-second");
    await composition.subjects.create(
      {
        displayName: "Zoe",
        identityHints: [{ kind: "description", value: "Shared description is not a locator" }],
      },
      SDK_ACTOR,
      { requestId: request() },
    );

    const subjectPage = await composition.subjects.list({ limit: 1 });
    expect(subjectPage.items).toHaveLength(1);
    expect(subjectPage.nextCursor).toBeDefined();
    if (subjectPage.nextCursor === undefined) throw new Error("Expected a subject cursor.");
    await expectCode(
      composition.subjects.list({ text: "Mira", cursor: subjectPage.nextCursor }),
      "invalid_input",
    );
    await expect(
      composition.subjects.resolve({ selector: { kind: "query", query: "Mira alias" } }),
    ).resolves.toMatchObject({ kind: "found", subject: { id: first.subjectId } });
    await expect(
      composition.subjects.resolve({
        selector: { kind: "query", query: "example:mira" },
      }),
    ).resolves.toMatchObject({ kind: "found", subject: { id: first.subjectId } });
    await expect(
      composition.subjects.resolve({
        selector: { kind: "query", query: "Shared description is not a locator" },
      }),
    ).resolves.toEqual({ kind: "not_found" });

    await expect(composition.profiles.get({ subjectId: first.subjectId })).resolves.toMatchObject({
      versionId: second.versionId,
      claims: [{}, {}],
    });
    await expect(
      composition.profiles.get({ subjectId: first.subjectId, versionId: first.versionId }),
    ).resolves.toMatchObject({ versionId: first.versionId, claims: [{}] });
    await expect(composition.profiles.prompt({ subjectId: first.subjectId })).resolves.toContain(
      "# Distilly simulation context",
    );
    await expect(
      composition.profiles.status({ subjectId: first.subjectId }),
    ).resolves.toMatchObject({
      subject: { currentVersionId: second.versionId },
      generation: 2,
      maturity: "sparse",
    });

    const currentMaterials = await composition.materials.list({
      subjectId: first.subjectId,
      limit: 1,
    });
    expect(currentMaterials.items).toHaveLength(1);
    expect(currentMaterials.nextCursor).toBeDefined();
    if (currentMaterials.nextCursor === undefined) throw new Error("Expected a material cursor.");
    await expectCode(
      composition.materials.list({
        subjectId: first.subjectId,
        kind: "document",
        cursor: currentMaterials.nextCursor,
      }),
      "invalid_input",
    );
    await expect(
      composition.materials.list({
        subjectId: first.subjectId,
        atVersionId: first.versionId,
      }),
    ).resolves.toMatchObject({
      items: [{ record: { id: first.materialId }, inCurrentGeneration: true }],
    });
    const selectedMaterial = await composition.materials.get({
      subjectId: first.subjectId,
      materialId: second.materialId,
    });
    expect(selectedMaterial.content).toContain("concise examples");

    const versions = await composition.versions.list({ subjectId: first.subjectId });
    expect(() => engineMethodSchemas["versions.list"].result.parse(versions)).not.toThrow();
    expect(versions.items.map((version) => version.id)).toEqual([
      second.versionId,
      first.versionId,
    ]);
    await expect(
      composition.versions.diff({
        subjectId: first.subjectId,
        before: first.versionId,
        after: second.versionId,
      }),
    ).resolves.toMatchObject({ added: [{}], beforeQuality: {}, afterQuality: {} });
    await expect(
      composition.versions.lineage({ subjectId: first.subjectId }),
    ).resolves.toMatchObject({
      items: [{ kind: "committed" }, { kind: "created" }],
    });
  });

  it("reopens pending and suspended Library state with privacy and search semantics", async () => {
    const root = await temporaryRoot();
    const clock = new MutableClock();
    const initial = await open(root, clock);
    const first = await seedCurrent(initial, clock, "Ada", "private");
    clock.current = LATER;
    const candidate = await addVersion(initial, clock, first, "Ada-candidate", true);
    clock.current = LATEST;
    const pending = await initial.ingest.ingest(
      {
        subject: { kind: "existing", subjectId: first.subjectId },
        materials: [
          material(
            "Ada-pending",
            "Ada records one later observation while review remains active.",
            clock.current,
          ),
        ],
        enqueue: "now",
      },
      SDK_ACTOR,
      { requestId: request() },
    );
    expect(pending.job).toBeDefined();
    close(initial);

    const reopened = await open(root, clock);
    await expect(reopened.reviews.list({ subjectId: first.subjectId })).resolves.toMatchObject({
      items: [{ candidate: { id: candidate.versionId } }],
    });
    const library = await reopened.library.list({
      text: "colleague",
      hasPending: true,
      hasSuspended: true,
    });
    expect(() => engineMethodSchemas["library.list"].result.parse(library)).not.toThrow();
    expect(library).toMatchObject({
      items: [
        {
          subject: { id: first.subjectId },
          status: {
            pendingJobId: pending.job!.id,
            suspendedVersionId: candidate.versionId,
          },
          privacy: "mixed",
          pendingJobs: 1,
          suspendedVersions: 1,
          newMaterialCount: 2,
          lastChangedAt: LATEST,
        },
      ],
    });
    expect(library.items[0]!.searchTerms).toEqual([
      "active",
      "colleague",
      "mixed",
      "pending",
      "sparse",
      "suspended",
    ]);
    await expect(reopened.library.list({ text: "ADA ALIAS" })).resolves.toMatchObject({
      items: [{ subject: { id: first.subjectId } }],
    });
    await expect(reopened.library.list({ hasPending: false })).resolves.toEqual({ items: [] });
  });

  it("reopens rejected, corrected, and rolled-back authority without file recovery", async () => {
    const root = await temporaryRoot();
    const clock = new MutableClock();
    const initial = await open(root, clock);
    const first = await seedCurrent(initial, clock, "Lin");
    clock.current = LATER;
    const candidate = await addVersion(initial, clock, first, "Lin-candidate", true);
    await initial.review.reject(
      { subjectId: first.subjectId, candidateVersionId: candidate.versionId, reason: "Not now" },
      USER_ACTOR,
      { requestId: request() },
    );
    const corrected = await initial.corrections.correct(
      {
        subjectId: first.subjectId,
        correction: {
          text: "Lin prefers explicit tradeoffs.",
          facet: facetPathSchema.parse("psyche.decision_style"),
        },
      },
      USER_ACTOR,
      { requestId: request() },
    );
    if (corrected.kind !== "current") throw new Error("Expected a current correction.");
    clock.current = LATEST;
    const rollback = await initial.review.rollback(
      {
        subjectId: first.subjectId,
        targetVersionId: first.versionId,
        reason: "Restore the original profile",
      },
      USER_ACTOR,
      { requestId: request() },
    );
    close(initial);

    const reopened = await open(root, clock);
    await expect(reopened.profiles.get({ subjectId: first.subjectId })).resolves.toMatchObject({
      versionId: rollback.id,
    });
    const versions = await reopened.versions.list({ subjectId: first.subjectId });
    expect(new Map(versions.items.map((version) => [version.id, version.status]))).toEqual(
      new Map([
        [rollback.id, "current"],
        [corrected.version.id, "historical"],
        [candidate.versionId, "rejected"],
        [first.versionId, "historical"],
      ]),
    );
    const lineage = await reopened.versions.lineage({ subjectId: first.subjectId });
    expect(() => engineMethodSchemas["versions.lineage"].result.parse(lineage)).not.toThrow();
    expect(lineage.items.map((event) => event.kind)).toEqual(
      expect.arrayContaining(["created", "suspended", "rejected", "corrected", "rolled_back"]),
    );
    await expect(reopened.reviews.list({ subjectId: first.subjectId })).resolves.toEqual({
      items: [],
    });
  });

  it("rejects current material rows that no longer match their state authority", async () => {
    const root = await temporaryRoot();
    const clock = new MutableClock();
    const initial = await open(root, clock);
    const first = await seedCurrent(initial, clock, "Nia", "private");
    clock.current = LATER;
    const pending = await initial.ingest.ingest(
      {
        subject: { kind: "existing", subjectId: first.subjectId },
        materials: [
          material("Nia-pending", "Nia adds one pending shareable observation.", clock.current),
        ],
        enqueue: "now",
      },
      SDK_ACTOR,
      { requestId: request() },
    );
    const pendingMaterialId = materialIdFromIngest(pending);
    close(initial);

    const database = new DatabaseSync(join(root, "store.sqlite3"));
    database.exec("PRAGMA foreign_keys = ON");
    database
      .prepare("DELETE FROM materials WHERE subject_id = ? AND material_id = ?")
      .run(first.subjectId, pendingMaterialId);
    database.close();

    const reopened = await open(root, clock);
    await expectCode(reopened.materials.list({ subjectId: first.subjectId }), "storage_corrupt");
    await expectCode(reopened.library.list({ text: "Nia" }), "storage_corrupt");
  });
});
