import { readFile, rm } from "node:fs/promises";

import {
  eventIdSchema,
  isoDateTimeSchema,
  jobIdSchema,
  materialIdSchema,
  provenanceDigestSchema,
  requestIdSchema,
  type ActorContext,
  type EventRecord,
  type IsoDateTime,
  type LibraryQuery,
  type MaterialRecord,
  type SubjectStateRecord,
} from "@distilly/protocol";
import { afterEach, describe, expect, it } from "vitest";

import type { Clock } from "../defaults/system-clock.js";
import { sealFact } from "../facts/checksum.js";
import { deriveMaterialId, digestContent, digestMaterialProvenance } from "../facts/digests.js";
import { FileEventStore } from "../facts/event-store.js";
import { FileStateStore } from "../facts/state-store.js";
import {
  createVersionFixtureHarness,
  makeVersionArtifacts,
  publishVersionArtifacts,
  TEST_AT,
  TEST_QUALITY,
  TEST_SUBJECT_ID,
} from "../facts/version-fixture.test-support.js";
import { JsonLibraryProjection, LIBRARY_DIRTY_BYTES } from "./json-library-projection.js";
import { LibraryService } from "./library-service.js";
import type { LibraryProjection } from "./library-projection.js";
import { ProjectionService } from "./projection-service.js";

const LATER = isoDateTimeSchema.parse("2026-08-21T00:05:00.000Z");
const ACTOR: ActorContext = { kind: "system", id: "version-fixture" };
const roots: string[] = [];

class FixedClock implements Clock {
  now(): IsoDateTime {
    return LATER;
  }
}

const event = (digit: number, value: EventRecord["event"]): EventRecord =>
  sealFact<EventRecord>({
    schemaVersion: 1,
    eventId: eventIdSchema.parse(`event_${digit.toString(16).padStart(32, "0")}`),
    event: value,
    actor: ACTOR,
    requestId: requestIdSchema.parse(`req_${(digit + 10).toString(16).padStart(32, "0")}`),
  });

const makeOrphanMaterial = (): { readonly record: MaterialRecord; readonly content: string } => {
  const content = "A complete material that no committed manifest references.\n";
  const contentDigest = digestContent(content);
  const provisional = sealFact<MaterialRecord>({
    schemaVersion: 1,
    id: materialIdSchema.parse(`mat_${"f".repeat(64)}`),
    subjectId: TEST_SUBJECT_ID,
    kind: "web",
    contentDigest,
    provenanceDigest: provenanceDigestSchema.parse(`provenance_sha256_${"f".repeat(64)}`),
    sourceIdentity: "source-uri-v1\0https://example.com/orphan",
    source: {
      uri: "https://example.com/orphan",
      medium: "article",
      access: "public",
      role: "reference",
      capturedAt: TEST_AT,
      authors: [],
    },
    derivation: { kind: "native_text" },
    participants: [],
    sensitivity: "shareable",
    flags: [],
    storedAt: TEST_AT,
  });
  const provenanceDigest = digestMaterialProvenance(provisional);
  return {
    content,
    record: sealFact<MaterialRecord>({
      ...provisional,
      provenanceDigest,
      id: deriveMaterialId(provisional.sourceIdentity, provenanceDigest, contentDigest),
    }),
  };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Library aggregate services", () => {
  it("derives the exact aggregate from verified state, materials, versions, and events", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const current = makeVersionArtifacts(harness);
    await publishVersionArtifacts(harness, current);
    const suspended = makeVersionArtifacts(harness, {
      parentId: current.version.id,
      disposition: "suspended",
      claimTextSuffix: " Candidate",
    });
    await publishVersionArtifacts(
      harness,
      suspended,
      requestIdSchema.parse(`req_${"2".repeat(32)}`),
    );

    const states = new FileStateStore(harness.layout, harness.subjects, harness.materials);
    const state = sealFact<SubjectStateRecord>({
      schemaVersion: 2,
      subjectId: TEST_SUBJECT_ID,
      generation: 1,
      materialSetHash: current.version.materialSetHash,
      materialManifest: current.manifest.items,
      currentVersionId: current.version.id,
      suspendedVersionId: suspended.version.id,
      pending: {
        jobId: jobIdSchema.parse(`job_${"3".repeat(32)}`),
        generation: 1,
        baseVersionId: current.version.id,
        materialSetHash: current.version.materialSetHash,
        addedMaterialCount: 0,
        totalMaterialCount: current.manifest.items.length,
        queuedAt: TEST_AT,
      },
    });
    await states.write(state);
    const events = new FileEventStore(harness.layout, harness.subjects);
    await events.write(
      TEST_SUBJECT_ID,
      event(1, { kind: "subject.created", subjectId: TEST_SUBJECT_ID, at: TEST_AT }),
    );
    await events.write(
      TEST_SUBJECT_ID,
      event(2, {
        kind: "version.current",
        subjectId: TEST_SUBJECT_ID,
        versionId: current.version.id,
        at: TEST_AT,
      }),
    );
    await events.write(
      TEST_SUBJECT_ID,
      event(3, {
        kind: "version.suspended",
        subjectId: TEST_SUBJECT_ID,
        versionId: suspended.version.id,
        at: TEST_AT,
      }),
    );
    await events.write(
      TEST_SUBJECT_ID,
      event(4, { kind: "job.changed", subjectId: TEST_SUBJECT_ID, at: LATER }),
    );

    const projection = new JsonLibraryProjection(harness.layout, new FixedClock());
    const service = new ProjectionService({
      spaces: harness.spaces,
      subjects: harness.subjects,
      states,
      materials: harness.materials,
      versions: harness.versions,
      events,
      projection,
      reconcile: () => Promise.resolve(),
    });
    const entry = await service.entry(TEST_SUBJECT_ID);
    const subjectFact = await harness.subjects.read(TEST_SUBJECT_ID);
    const spaceFact = await harness.spaces.read(subjectFact.spaceId);
    expect(entry.subject).toEqual({
      id: TEST_SUBJECT_ID,
      displayName: "Ada",
      aliases: [],
      identityHints: [],
      space: {
        id: spaceFact.id,
        displayName: "People",
        kind: "people",
      },
      lifecycle: "active",
      currentVersionId: current.version.id,
    });
    expect(entry.subject.space.id).toMatch(/^space_/u);
    expect(entry.status.subject).toEqual(entry.subject);
    expect({
      ...entry,
      subject: undefined,
      status: { ...entry.status, subject: undefined },
    }).toEqual({
      subject: undefined,
      status: {
        subject: undefined,
        generation: 1,
        materialSetHash: current.version.materialSetHash,
        pendingJobId: state.pending!.jobId,
        suspendedVersionId: suspended.version.id,
        maturity: TEST_QUALITY.maturity,
      },
      privacy: "private",
      searchTerms: ["active", "career", "pending", "private", "sparse", "suspended"],
      currentQuality: TEST_QUALITY,
      suspendedQuality: TEST_QUALITY,
      pendingJobs: 1,
      suspendedVersions: 1,
      newMaterialCount: 0,
      lastChangedAt: LATER,
    });
    await expect(service.rebuild()).resolves.toEqual({
      subjects: 1,
      jobs: 1,
      relations: 0,
      rebuiltAt: LATER,
    });
    await expect(projection.query({})).resolves.toEqual({ items: [entry] });
    await expect(projection.query({ text: "career" })).resolves.toEqual({ items: [entry] });

    const orphan = makeOrphanMaterial();
    await harness.materials.write(orphan.record, orphan.content);
    await expect(service.entry(TEST_SUBJECT_ID)).rejects.toMatchObject({
      code: "storage_corrupt",
    });
  });

  it("computes recovery apply facts only after the exact dirty marker is durable", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    await rm(harness.layout.materialDirectory(TEST_SUBJECT_ID, harness.material.id), {
      recursive: true,
    });
    const states = new FileStateStore(harness.layout, harness.subjects, harness.materials);
    await states.write(
      sealFact<SubjectStateRecord>({
        schemaVersion: 2,
        subjectId: TEST_SUBJECT_ID,
        generation: 0,
        materialManifest: [],
      }),
    );
    const events = new FileEventStore(harness.layout, harness.subjects);
    await events.write(
      TEST_SUBJECT_ID,
      event(1, { kind: "subject.created", subjectId: TEST_SUBJECT_ID, at: TEST_AT }),
    );
    const initial = new JsonLibraryProjection(harness.layout, new FixedClock());
    const base = new ProjectionService({
      spaces: harness.spaces,
      subjects: harness.subjects,
      states,
      materials: harness.materials,
      versions: harness.versions,
      events,
      projection: initial,
      reconcile: () => Promise.resolve(),
    });
    await expect(base.entry(TEST_SUBJECT_ID)).resolves.toMatchObject({
      privacy: "none",
      pendingJobs: 0,
      suspendedVersions: 0,
      newMaterialCount: 0,
    });
    await base.rebuild();

    let markerObserved = false;
    const projection = new JsonLibraryProjection(harness.layout, new FixedClock(), {
      async afterDirtyMarker() {
        markerObserved =
          (await readFile(harness.layout.libraryDirtyFile(), "utf8")) === LIBRARY_DIRTY_BYTES;
      },
    });
    const service = new ProjectionService({
      spaces: harness.spaces,
      subjects: harness.subjects,
      states,
      materials: harness.materials,
      versions: harness.versions,
      events,
      projection,
      reconcile: () => Promise.resolve(),
    });
    await events.write(
      TEST_SUBJECT_ID,
      event(2, { kind: "job.changed", subjectId: TEST_SUBJECT_ID, at: LATER }),
    );
    await service.apply(TEST_SUBJECT_ID);

    expect(markerObserved).toBe(true);
    await expect(projection.query({})).resolves.toMatchObject({
      items: [expect.objectContaining({ lastChangedAt: LATER })],
    });
  });

  it("reconciles before each read and queries only the projection", async () => {
    const calls: string[] = [];
    const projection: LibraryProjection = {
      async upsert() {},
      async remove() {},
      query(input: LibraryQuery) {
        calls.push(`query:${input.text ?? "all"}`);
        return Promise.resolve({ items: [] });
      },
      rebuild() {
        return Promise.reject(
          new Error("LibraryService must use ProjectionService for verified rebuild seeds."),
        );
      },
    };
    const service = new LibraryService({
      projection,
      reconcile() {
        calls.push("reconcile");
        return Promise.resolve();
      },
    });

    await expect(service.list({ text: "Ada" })).resolves.toEqual({ items: [] });
    expect(calls).toEqual(["reconcile", "query:Ada"]);
  });
});
