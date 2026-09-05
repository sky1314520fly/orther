import {
  contentDigestSchema,
  eventIdSchema,
  isoDateTimeSchema,
  materialIdSchema,
  provenanceDigestSchema,
  rawIdSchema,
  requestIdSchema,
  spaceIdSchema,
  subjectIdSchema,
  versionIdSchema,
} from "@distilly/protocol";
import type {
  ActorContext,
  EventRecord,
  FactEnvelope,
  MaterialRecord,
  Profile,
  RequestId,
  SpaceRecord,
  SubjectRecord,
  SubjectStateRecord,
  VersionClaimsSnapshot,
  VersionMaterialEntry,
  VersionMaterialManifest,
  VersionRecord,
} from "@distilly/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sealFact } from "../facts/checksum.js";
import {
  deriveMaterialId,
  digestContent,
  digestMaterialProvenance,
  hashMaterialSet,
} from "../facts/digests.js";
import { FileEventStore } from "../facts/event-store.js";
import { FileMaterialStore } from "../facts/material-store.js";
import { FileSpaceStore } from "../facts/space-store.js";
import { FileStateStore } from "../facts/state-store.js";
import { FileSubjectStore } from "../facts/subject-store.js";
import { FileVersionStore } from "../facts/version-store.js";
import { Layout } from "../layout.js";
import { MaterialQueryService } from "../material/query-service.js";
import { ProfileService } from "../profile/service.js";
import { PROFILE_RENDERER_VERSION, renderProfile, renderPrompt } from "../profile/render.js";
import type { VersionIdentityPayload } from "../profile/version-id.js";
import { deriveVersionId } from "../profile/version-id.js";
import { LegacyFileReviewQueryService } from "../testing/legacy-file-review-query-service.test.fixture.js";
import { CommittedVersionReader } from "./committed-version-reader.js";
import { encodeCursor } from "./cursor.js";
import { FileSubjectLock } from "../transaction/subject-lock.js";
import { FileVersionStaging } from "../testing/legacy-file-version-staging.test.fixture.js";
import { VersionService } from "../version/service.js";

const HEX_32 = "0".repeat(32);
const SPACE_ID = spaceIdSchema.parse(`space_${HEX_32}`);
const SUBJECT_ID = subjectIdSchema.parse(`subject_${HEX_32}`);
const AT = isoDateTimeSchema.parse("2026-08-21T00:00:00.000Z");
const LATER = isoDateTimeSchema.parse("2026-08-21T00:01:00.000Z");
const ACTOR: ActorContext = { kind: "sdk", id: "read-services-test" };
const QUALITY = {
  sourceGroupingVersion: "source-groups-v1",
  activeClaimCount: 0,
  contestedClaimCount: 0,
  userAssertedClaimCount: 0,
  corroboratedClaimCount: 0,
  sourceGroupCount: 0,
  diversityEligibleSourceGroupCount: 0,
  unknownSourceGroupCount: 0,
  coveredCoreFacets: [],
  uncoveredCoreFacets: [
    "identity",
    "voice",
    "psyche",
    "relations",
    "boundaries",
    "texture",
    "timeline",
  ],
  maturity: "sparse",
} as const;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const withoutChecksum = <T extends FactEnvelope>(record: T): Omit<T, "checksum"> => {
  const { checksum, ...payload } = record;
  void checksum;
  return payload;
};

const reseal = <T extends FactEnvelope>(record: T, overrides: Partial<Omit<T, "checksum">>): T =>
  sealFact<T>({ ...withoutChecksum(record), ...overrides });

const makeMaterial = (
  content: string,
  uri: string,
  kind: MaterialRecord["kind"],
  derivation: MaterialRecord["derivation"] = { kind: "native_text" },
): MaterialRecord => {
  const contentDigest = digestContent(content);
  const provisional = sealFact<MaterialRecord>({
    schemaVersion: 1,
    id: materialIdSchema.parse(`mat_${"0".repeat(64)}`),
    subjectId: SUBJECT_ID,
    kind,
    contentDigest,
    provenanceDigest: provenanceDigestSchema.parse(`provenance_sha256_${"0".repeat(64)}`),
    sourceIdentity: `uri:${uri}`,
    source: {
      uri,
      title: "Public source",
      medium: "article",
      access: "public",
      role: "reference",
      capturedAt: AT,
      authors: ["Ada"],
    },
    derivation,
    participants: [],
    sensitivity: "shareable",
    flags: [],
    storedAt: AT,
  });
  const provenanceDigest = digestMaterialProvenance(provisional);
  return reseal(provisional, {
    provenanceDigest,
    id: deriveMaterialId(provisional.sourceIdentity, provenanceDigest, contentDigest),
  });
};

const entryFor = (record: MaterialRecord): VersionMaterialEntry => ({
  materialId: record.id,
  contentDigest: record.contentDigest,
  provenanceDigest: record.provenanceDigest,
});

const request = (digit: number): RequestId =>
  requestIdSchema.parse(`req_${digit.toString(16).padStart(32, "0")}`);

const writeEvent = async (
  stores: FixtureStores,
  digit: number,
  event: EventRecord["event"],
  metadata: {
    readonly reason?: string;
    readonly relatedVersionId?: VersionRecord["id"];
  } = {},
): Promise<void> => {
  await stores.events.write(
    SUBJECT_ID,
    sealFact<EventRecord>({
      schemaVersion: 1,
      eventId: eventIdSchema.parse(`event_${digit.toString(16).padStart(32, "0")}`),
      event,
      actor: ACTOR,
      requestId: request(digit + 20),
      ...(metadata.reason === undefined ? {} : { reason: metadata.reason }),
      ...(metadata.relatedVersionId === undefined
        ? {}
        : { relatedVersionId: metadata.relatedVersionId }),
    }),
  );
};

interface FixtureStores {
  readonly root: string;
  readonly layout: Layout;
  readonly spaces: FileSpaceStore;
  readonly subjects: FileSubjectStore;
  readonly materials: FileMaterialStore;
  readonly states: FileStateStore;
  readonly versions: FileVersionStore;
  readonly events: FileEventStore;
}

const createStores = async (): Promise<FixtureStores> => {
  const root = await mkdtemp(join(tmpdir(), "distilly-read-services-"));
  roots.push(root);
  const layout = new Layout(root);
  const spaces = new FileSpaceStore(layout);
  const subjects = new FileSubjectStore(layout, spaces);
  const materials = new FileMaterialStore(layout, subjects);
  return {
    root,
    layout,
    spaces,
    subjects,
    materials,
    states: new FileStateStore(layout, subjects, materials),
    versions: new FileVersionStore(layout, materials),
    events: new FileEventStore(layout, subjects),
  };
};

const committedReader = (
  stores: FixtureStores,
  reconcile: () => Promise<void> = () => Promise.resolve(),
): CommittedVersionReader =>
  new CommittedVersionReader({
    spaces: stores.spaces,
    subjects: stores.subjects,
    states: stores.states,
    materials: stores.materials,
    versions: stores.versions,
    events: stores.events,
    subjectLocks: new FileSubjectLock(stores.layout),
    reconcile,
  });

const publishVersion = async (
  stores: FixtureStores,
  input: {
    readonly entries: readonly VersionMaterialEntry[];
    readonly generation: number;
    readonly createdAt: VersionRecord["createdAt"];
    readonly disposition: VersionRecord["createdDisposition"];
    readonly requestId: RequestId;
    readonly parentId?: VersionRecord["id"];
    readonly derivedFromCandidateVersionId?: VersionRecord["id"];
    readonly creation?: VersionRecord["creation"];
  },
): Promise<VersionRecord> => {
  const entries = [...input.entries].sort((left, right) =>
    left.materialId < right.materialId ? -1 : left.materialId > right.materialId ? 1 : 0,
  );
  const identity: VersionIdentityPayload = {
    subjectId: SUBJECT_ID,
    subjectDisplayName: "Ada",
    ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
    ...(input.derivedFromCandidateVersionId === undefined
      ? {}
      : { derivedFromCandidateVersionId: input.derivedFromCandidateVersionId }),
    generation: input.generation,
    materialSetHash: hashMaterialSet(entries),
    creation:
      input.creation ??
      ({
        kind: "bundle_import",
        bundleDigest: contentDigestSchema.parse(`sha256_${"1".repeat(64)}`),
      } as const),
    createdDisposition: input.disposition,
    ...(input.disposition === "suspended"
      ? { reviewReasons: [{ code: "manual_review_requested" }] as const }
      : {}),
    actor: ACTOR,
    quality: QUALITY,
    rendererVersion: PROFILE_RENDERER_VERSION,
  };
  const versionId = deriveVersionId(identity, []);
  const version = sealFact<VersionRecord>({
    schemaVersion: 1,
    id: versionId,
    ...identity,
    materialCount: entries.length,
    createdAt: input.createdAt,
  });
  const manifest = sealFact<VersionMaterialManifest>({ schemaVersion: 1, items: entries });
  const claims = sealFact<VersionClaimsSnapshot>({
    schemaVersion: 1,
    subjectId: SUBJECT_ID,
    versionId,
    claims: [],
  });
  const rendered = renderProfile({
    subjectId: SUBJECT_ID,
    displayName: "Ada",
    versionId,
    claims: [],
    quality: QUALITY,
  });
  const profile: Profile = {
    subjectId: SUBJECT_ID,
    displayName: "Ada",
    versionId,
    claims: [],
    core: rendered.core,
    domains: rendered.domains,
    rendered: rendered.markdown,
    quality: QUALITY,
  };
  const artifacts = { version, manifest, claims, profile, prompt: renderPrompt(profile) };
  const staging = new FileVersionStaging(stores.layout, stores.versions);
  await staging.prepare(input.requestId, artifacts);
  await staging.publish(input.requestId, artifacts);
  return version;
};

const seed = async () => {
  const stores = await createStores();
  const space = sealFact<SpaceRecord>({
    schemaVersion: 1,
    id: SPACE_ID,
    displayName: "People",
    kind: "people",
  });
  const subject = sealFact<SubjectRecord>({
    schemaVersion: 1,
    id: SUBJECT_ID,
    spaceId: SPACE_ID,
    displayName: "Ada",
    aliases: [],
    identityHints: [],
    lifecycle: "active",
  });
  await stores.spaces.write(space);
  await stores.subjects.write(subject);
  const firstContent = "One emoji 🙂.";
  const secondContent = "Second independent source.";
  const first = makeMaterial(firstContent, "https://example.com/one", "web");
  const second = makeMaterial(secondContent, "https://example.com/two", "document");
  await stores.materials.write(first, firstContent);
  await stores.materials.write(second, secondContent);
  const firstEntry = entryFor(first);
  const secondEntry = entryFor(second);
  const current = await publishVersion(stores, {
    entries: [firstEntry],
    generation: 1,
    createdAt: AT,
    disposition: "current",
    requestId: request(1),
  });
  const candidate = await publishVersion(stores, {
    entries: [firstEntry, secondEntry],
    generation: 2,
    createdAt: LATER,
    disposition: "suspended",
    requestId: request(2),
    parentId: current.id,
  });
  const manifest = [firstEntry, secondEntry].sort((left, right) =>
    left.materialId < right.materialId ? -1 : left.materialId > right.materialId ? 1 : 0,
  );
  const state = sealFact<SubjectStateRecord>({
    schemaVersion: 2,
    subjectId: SUBJECT_ID,
    generation: 2,
    materialSetHash: hashMaterialSet(manifest),
    materialManifest: manifest,
    currentVersionId: current.id,
    suspendedVersionId: candidate.id,
  });
  await stores.states.write(state);
  const events: EventRecord[] = [
    sealFact<EventRecord>({
      schemaVersion: 1,
      eventId: eventIdSchema.parse(`event_${"1".padStart(32, "0")}`),
      event: { kind: "subject.created", subjectId: SUBJECT_ID, at: AT },
      actor: ACTOR,
      requestId: request(3),
    }),
    sealFact<EventRecord>({
      schemaVersion: 1,
      eventId: eventIdSchema.parse(`event_${"2".padStart(32, "0")}`),
      event: { kind: "version.current", subjectId: SUBJECT_ID, versionId: current.id, at: AT },
      actor: ACTOR,
      requestId: request(4),
    }),
    sealFact<EventRecord>({
      schemaVersion: 1,
      eventId: eventIdSchema.parse(`event_${"3".padStart(32, "0")}`),
      event: {
        kind: "version.suspended",
        subjectId: SUBJECT_ID,
        versionId: candidate.id,
        at: LATER,
      },
      actor: ACTOR,
      requestId: request(5),
    }),
  ];
  for (const event of events) await stores.events.write(SUBJECT_ID, event);
  return { stores, first, second, firstContent, current, candidate };
};

type SeedFixture = Awaited<ReturnType<typeof seed>>;

const publishRollbackCopyingCandidate = async (
  fixture: SeedFixture,
  targetVersionId: VersionRecord["id"],
): Promise<VersionRecord> => {
  const { stores, first, second, candidate } = fixture;
  const rollback = await publishVersion(stores, {
    entries: [entryFor(first), entryFor(second)],
    generation: candidate.generation,
    createdAt: isoDateTimeSchema.parse("2026-08-21T00:03:00.000Z"),
    disposition: "current",
    requestId: request(21),
    parentId: candidate.id,
    creation: { kind: "rollback", targetVersionId },
  });
  const previous = await stores.states.read(SUBJECT_ID);
  const { checksum, currentVersionId, suspendedVersionId, ...statePayload } = previous;
  void checksum;
  void currentVersionId;
  void suspendedVersionId;
  await stores.states.write(
    sealFact<SubjectStateRecord>({ ...statePayload, currentVersionId: rollback.id }),
  );
  await writeEvent(stores, 21, {
    kind: "version.promoted",
    subjectId: SUBJECT_ID,
    versionId: candidate.id,
    at: isoDateTimeSchema.parse("2026-08-21T00:02:00.000Z"),
  });
  await writeEvent(
    stores,
    22,
    {
      kind: "version.rolled_back",
      subjectId: SUBJECT_ID,
      versionId: rollback.id,
      at: rollback.createdAt,
    },
    { reason: "Restore prior version.", relatedVersionId: targetVersionId },
  );
  return rollback;
};

const committedCorruptionCases: ReadonlyArray<
  readonly [string, (fixture: SeedFixture) => Promise<void>]
> = [
  [
    "a missing parent",
    async ({ stores, first }) => {
      const missingVersionId = versionIdSchema.parse(`version_${"f".repeat(64)}`);
      const version = await publishVersion(stores, {
        entries: [entryFor(first)],
        generation: 3,
        createdAt: isoDateTimeSchema.parse("2026-08-21T00:02:00.000Z"),
        disposition: "current",
        requestId: request(20),
        parentId: missingVersionId,
      });
      await writeEvent(stores, 20, {
        kind: "version.current",
        subjectId: SUBJECT_ID,
        versionId: version.id,
        at: version.createdAt,
      });
    },
  ],
  [
    "a missing correction source",
    async ({ stores, first, current }) => {
      const version = await publishVersion(stores, {
        entries: [entryFor(first)],
        generation: 3,
        createdAt: isoDateTimeSchema.parse("2026-08-21T00:02:00.000Z"),
        disposition: "current",
        requestId: request(20),
        parentId: current.id,
        derivedFromCandidateVersionId: versionIdSchema.parse(`version_${"f".repeat(64)}`),
        creation: { kind: "correction", correctionMaterialId: first.id },
      });
      await writeEvent(stores, 20, {
        kind: "version.current",
        subjectId: SUBJECT_ID,
        versionId: version.id,
        at: version.createdAt,
      });
    },
  ],
  [
    "a missing renderer-only source",
    async ({ stores, first, current }) => {
      const version = await publishVersion(stores, {
        entries: [entryFor(first)],
        generation: 3,
        createdAt: isoDateTimeSchema.parse("2026-08-21T00:02:00.000Z"),
        disposition: "current",
        requestId: request(20),
        parentId: current.id,
        creation: {
          kind: "renderer_only",
          sourceVersionId: versionIdSchema.parse(`version_${"f".repeat(64)}`),
        },
      });
      await writeEvent(stores, 20, {
        kind: "version.current",
        subjectId: SUBJECT_ID,
        versionId: version.id,
        at: version.createdAt,
      });
    },
  ],
  [
    "a missing rollback source",
    async ({ stores, first, current }) => {
      const missingVersionId = versionIdSchema.parse(`version_${"f".repeat(64)}`);
      const version = await publishVersion(stores, {
        entries: [entryFor(first)],
        generation: 3,
        createdAt: isoDateTimeSchema.parse("2026-08-21T00:02:00.000Z"),
        disposition: "current",
        requestId: request(20),
        parentId: current.id,
        creation: { kind: "rollback", targetVersionId: missingVersionId },
      });
      await writeEvent(
        stores,
        20,
        {
          kind: "version.rolled_back",
          subjectId: SUBJECT_ID,
          versionId: version.id,
          at: version.createdAt,
        },
        { reason: "Restore prior version.", relatedVersionId: missingVersionId },
      );
    },
  ],
  [
    "a duplicate creation event",
    async ({ stores, current }) => {
      await writeEvent(stores, 20, {
        kind: "version.current",
        subjectId: SUBJECT_ID,
        versionId: current.id,
        at: current.createdAt,
      });
    },
  ],
  [
    "a creation event with the wrong actor",
    async ({ stores, current }) => {
      await stores.events.write(
        SUBJECT_ID,
        sealFact<EventRecord>({
          schemaVersion: 1,
          eventId: eventIdSchema.parse(`event_${"14".padStart(32, "0")}`),
          event: {
            kind: "version.current",
            subjectId: SUBJECT_ID,
            versionId: current.id,
            at: current.createdAt,
          },
          actor: { kind: "system", id: "wrong-creator" },
          requestId: request(20),
        }),
      );
    },
  ],
  [
    "a terminal decision for the active suspended version",
    async ({ stores, candidate }) => {
      await writeEvent(stores, 20, {
        kind: "version.promoted",
        subjectId: SUBJECT_ID,
        versionId: candidate.id,
        at: isoDateTimeSchema.parse("2026-08-21T00:02:00.000Z"),
      });
    },
  ],
  [
    "an inactive suspended version without a decision",
    async ({ stores, current }) => {
      const state = await stores.states.read(SUBJECT_ID);
      const { checksum, suspendedVersionId, ...payload } = state;
      void checksum;
      void suspendedVersionId;
      await stores.states.write(
        sealFact<SubjectStateRecord>({
          ...payload,
          generation: current.generation,
          materialSetHash: current.materialSetHash,
          materialManifest: (await stores.versions.read(SUBJECT_ID, current.id)).manifest.items,
        }),
      );
    },
  ],
  [
    "a rejected version selected as current",
    async ({ stores, candidate }) => {
      const state = await stores.states.read(SUBJECT_ID);
      const { checksum, currentVersionId, suspendedVersionId, ...payload } = state;
      void checksum;
      void currentVersionId;
      void suspendedVersionId;
      await stores.states.write(
        sealFact<SubjectStateRecord>({
          ...payload,
          currentVersionId: candidate.id,
        }),
      );
      await writeEvent(stores, 20, {
        kind: "version.rejected",
        subjectId: SUBJECT_ID,
        versionId: candidate.id,
        at: isoDateTimeSchema.parse("2026-08-21T00:02:00.000Z"),
      });
    },
  ],
  [
    "a stale state pointer behind the unique current leaf",
    async ({ stores, first, current, candidate }) => {
      const next = await publishVersion(stores, {
        entries: [entryFor(first)],
        generation: 3,
        createdAt: isoDateTimeSchema.parse("2026-08-21T00:03:00.000Z"),
        disposition: "current",
        requestId: request(20),
        parentId: current.id,
      });
      const state = await stores.states.read(SUBJECT_ID);
      const { checksum, suspendedVersionId, ...payload } = state;
      void checksum;
      void suspendedVersionId;
      await stores.states.write(sealFact<SubjectStateRecord>(payload));
      await writeEvent(stores, 20, {
        kind: "version.rejected",
        subjectId: SUBJECT_ID,
        versionId: candidate.id,
        at: isoDateTimeSchema.parse("2026-08-21T00:02:00.000Z"),
      });
      await writeEvent(stores, 21, {
        kind: "version.current",
        subjectId: SUBJECT_ID,
        versionId: next.id,
        at: next.createdAt,
      });
    },
  ],
  [
    "two current children of one current parent",
    async ({ stores, first, current, candidate }) => {
      const firstChild = await publishVersion(stores, {
        entries: [entryFor(first)],
        generation: 3,
        createdAt: isoDateTimeSchema.parse("2026-08-21T00:03:00.000Z"),
        disposition: "current",
        requestId: request(20),
        parentId: current.id,
      });
      const secondChild = await publishVersion(stores, {
        entries: [entryFor(first)],
        generation: 4,
        createdAt: isoDateTimeSchema.parse("2026-08-21T00:04:00.000Z"),
        disposition: "current",
        requestId: request(21),
        parentId: current.id,
      });
      const state = await stores.states.read(SUBJECT_ID);
      const { checksum, suspendedVersionId, ...payload } = state;
      void checksum;
      void suspendedVersionId;
      await stores.states.write(
        sealFact<SubjectStateRecord>({
          ...payload,
          generation: secondChild.generation,
          currentVersionId: secondChild.id,
        }),
      );
      await writeEvent(stores, 20, {
        kind: "version.rejected",
        subjectId: SUBJECT_ID,
        versionId: candidate.id,
        at: isoDateTimeSchema.parse("2026-08-21T00:02:00.000Z"),
      });
      await writeEvent(stores, 21, {
        kind: "version.current",
        subjectId: SUBJECT_ID,
        versionId: firstChild.id,
        at: firstChild.createdAt,
      });
      await writeEvent(stores, 22, {
        kind: "version.current",
        subjectId: SUBJECT_ID,
        versionId: secondChild.id,
        at: secondChild.createdAt,
      });
    },
  ],
  [
    "a rollback event linked to the wrong source",
    async ({ stores, first, current, candidate }) => {
      const version = await publishVersion(stores, {
        entries: [entryFor(first)],
        generation: 3,
        createdAt: isoDateTimeSchema.parse("2026-08-21T00:02:00.000Z"),
        disposition: "current",
        requestId: request(20),
        parentId: current.id,
        creation: { kind: "rollback", targetVersionId: current.id },
      });
      await writeEvent(
        stores,
        20,
        {
          kind: "version.rolled_back",
          subjectId: SUBJECT_ID,
          versionId: version.id,
          at: version.createdAt,
        },
        { reason: "Restore prior version.", relatedVersionId: candidate.id },
      );
    },
  ],
  [
    "a candidate-derived version without its replacement event",
    async ({ stores, first, current, candidate }) => {
      const version = await publishVersion(stores, {
        entries: [entryFor(first)],
        generation: 3,
        createdAt: isoDateTimeSchema.parse("2026-08-21T00:02:00.000Z"),
        disposition: "current",
        requestId: request(20),
        parentId: current.id,
        derivedFromCandidateVersionId: candidate.id,
        creation: { kind: "correction", correctionMaterialId: first.id },
      });
      await writeEvent(stores, 20, {
        kind: "version.current",
        subjectId: SUBJECT_ID,
        versionId: version.id,
        at: version.createdAt,
      });
    },
  ],
  [
    "a rollback-created suspended version",
    async ({ stores, first, current }) => {
      const version = await publishVersion(stores, {
        entries: [entryFor(first)],
        generation: 3,
        createdAt: isoDateTimeSchema.parse("2026-08-21T00:02:00.000Z"),
        disposition: "suspended",
        requestId: request(20),
        parentId: current.id,
        creation: { kind: "rollback", targetVersionId: current.id },
      });
      await writeEvent(
        stores,
        20,
        {
          kind: "version.rolled_back",
          subjectId: SUBJECT_ID,
          versionId: version.id,
          at: version.createdAt,
        },
        { reason: "Restore prior version.", relatedVersionId: current.id },
      );
    },
  ],
  [
    "a rollback source equal to its creation-time current parent",
    async (fixture) => {
      await publishRollbackCopyingCandidate(fixture, fixture.candidate.id);
    },
  ],
  [
    "rollback artifacts copied from a version other than their historical source",
    async (fixture) => {
      await publishRollbackCopyingCandidate(fixture, fixture.current.id);
    },
  ],
  [
    "a rollback parent already superseded before rollback creation",
    async ({ stores, first, second, current, candidate }) => {
      const promotedAt = isoDateTimeSchema.parse("2026-08-21T00:02:00.000Z");
      const supersededAt = isoDateTimeSchema.parse("2026-08-21T00:02:30.000Z");
      const intervening = await publishVersion(stores, {
        entries: [entryFor(first), entryFor(second)],
        generation: candidate.generation,
        createdAt: supersededAt,
        disposition: "current",
        requestId: request(22),
        parentId: candidate.id,
      });
      const rollback = await publishVersion(stores, {
        entries: [entryFor(first)],
        generation: current.generation,
        createdAt: isoDateTimeSchema.parse("2026-08-21T00:03:00.000Z"),
        disposition: "current",
        requestId: request(23),
        parentId: candidate.id,
        creation: { kind: "rollback", targetVersionId: current.id },
      });
      const previous = await stores.states.read(SUBJECT_ID);
      const { checksum, currentVersionId, suspendedVersionId, ...statePayload } = previous;
      void checksum;
      void currentVersionId;
      void suspendedVersionId;
      await stores.states.write(
        sealFact<SubjectStateRecord>({ ...statePayload, currentVersionId: rollback.id }),
      );
      await writeEvent(stores, 23, {
        kind: "version.promoted",
        subjectId: SUBJECT_ID,
        versionId: candidate.id,
        at: promotedAt,
      });
      await writeEvent(stores, 24, {
        kind: "version.current",
        subjectId: SUBJECT_ID,
        versionId: intervening.id,
        at: supersededAt,
      });
      await writeEvent(
        stores,
        25,
        {
          kind: "version.rolled_back",
          subjectId: SUBJECT_ID,
          versionId: rollback.id,
          at: rollback.createdAt,
        },
        { reason: "Restore prior version.", relatedVersionId: current.id },
      );
    },
  ],
];

describe("Step 10 verified read services", () => {
  it("reads current and historical material snapshots with stable cursors and scalar counts", async () => {
    const { stores, first, second, firstContent, current } = await seed();
    const service = new MaterialQueryService({
      materials: stores.materials,
      committedVersions: committedReader(stores),
    });

    const firstPage = await service.list({ subjectId: SUBJECT_ID, limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBeDefined();
    const materialCursor = firstPage.nextCursor!;
    const secondPage = await service.list({
      subjectId: SUBJECT_ID,
      limit: 1,
      cursor: materialCursor,
    });
    expect([...firstPage.items, ...secondPage.items].map((item) => item.record.id)).toEqual(
      [first.id, second.id].sort(),
    );

    const view = await service.get({ subjectId: SUBJECT_ID, materialId: first.id });
    expect(view).toMatchObject({ content: firstContent, inCurrentGeneration: true });
    expect(view.content.length).toBe(Array.from(firstContent).length + 1);
    const historical = await service.list({ subjectId: SUBJECT_ID, atVersionId: current.id });
    expect(historical.items).toHaveLength(1);
    expect(historical.items[0]?.record.id).toBe(first.id);
    expect(historical.items[0]?.contentScalarCount).toBe(Array.from(firstContent).length);
    expect(historical.items[0]?.inCurrentGeneration).toBe(true);
    expect(historical.items[0]?.grouping).toMatchObject({ versionId: current.id, generation: 1 });
    await expect(
      service.get({ subjectId: SUBJECT_ID, materialId: second.id, atVersionId: current.id }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      service.list({ subjectId: SUBJECT_ID, cursor: materialCursor, kind: "web" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      service.list({
        subjectId: SUBJECT_ID,
        cursor: encodeCursor("materials.list", { subjectId: SUBJECT_ID }, ["not-a-material-id"]),
      }),
    ).rejects.toMatchObject({ code: "invalid_input", fieldPath: "cursor" });
  });

  it(
    "projects profiles, versions, lineage, and the active review from verified facts",
    { timeout: 30_000 },
    async () => {
      const { stores, current, candidate } = await seed();
      const reader = committedReader(stores);
      const profiles = new ProfileService({
        committedVersions: reader,
      });
      const versions = new VersionService({
        committedVersions: reader,
      });
      const reviews = new LegacyFileReviewQueryService({
        subjects: stores.subjects,
        committedVersions: reader,
      });

      await expect(profiles.get({ subjectId: SUBJECT_ID })).resolves.toMatchObject({
        versionId: current.id,
      });
      await expect(profiles.prompt({ subjectId: SUBJECT_ID })).resolves.toContain(current.id);
      const stateRead = vi.spyOn(stores.states, "read");
      await expect(profiles.status({ subjectId: SUBJECT_ID })).resolves.toMatchObject({
        generation: 2,
        suspendedVersionId: candidate.id,
        maturity: "sparse",
      });
      expect(stateRead).toHaveBeenCalledTimes(1);

      const page = await versions.list({ subjectId: SUBJECT_ID, limit: 1 });
      expect(page.items).toEqual([
        expect.objectContaining({ id: candidate.id, status: "suspended" }),
      ]);
      expect(page.nextCursor).toBeDefined();
      const versionCursor = page.nextCursor!;
      await expect(
        versions.list({ subjectId: SUBJECT_ID, cursor: versionCursor, limit: 1 }),
      ).resolves.toMatchObject({
        items: [expect.objectContaining({ id: current.id, status: "current" })],
      });
      await expect(
        versions.list({
          subjectId: SUBJECT_ID,
          cursor: encodeCursor("versions.list", { subjectId: SUBJECT_ID }, [
            "not-a-time",
            "not-a-version",
          ]),
        }),
      ).rejects.toMatchObject({ code: "invalid_input", fieldPath: "cursor" });
      await expect(versions.lineage({ subjectId: SUBJECT_ID })).resolves.toMatchObject({
        items: [
          expect.objectContaining({ kind: "suspended", versionId: candidate.id }),
          expect.objectContaining({ kind: "imported", versionId: current.id }),
        ],
      });
      await expect(
        versions.lineage({
          subjectId: SUBJECT_ID,
          cursor: encodeCursor("versions.lineage", { subjectId: SUBJECT_ID }, [AT, "not-an-event"]),
        }),
      ).rejects.toMatchObject({ code: "invalid_input", fieldPath: "cursor" });
      const reviewPage = await reviews.list({ subjectId: SUBJECT_ID });
      expect(reviewPage.items).toHaveLength(1);
      expect(reviewPage.items[0]?.candidate).toMatchObject({
        id: candidate.id,
        status: "suspended",
      });
      expect(reviewPage.items[0]?.current).toMatchObject({ id: current.id, status: "current" });
      expect(reviewPage.items[0]?.reasons).toEqual([{ code: "manual_review_requested" }]);
      expect(reviewPage.items[0]?.diff).toMatchObject({
        beforeQuality: QUALITY,
        afterQuality: QUALITY,
      });
      await expect(
        reviews.list({
          subjectId: SUBJECT_ID,
          cursor: encodeCursor("reviews.list", { subjectId: SUBJECT_ID }, [
            candidate.createdAt,
            "not-a-subject",
            candidate.id,
          ]),
        }),
      ).rejects.toMatchObject({ code: "invalid_input", fieldPath: "cursor" });
      const missingVersionId = versionIdSchema.parse(`version_${"f".repeat(64)}`);
      await expect(
        profiles.get({ subjectId: SUBJECT_ID, versionId: missingVersionId }),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        versions.diff({ subjectId: SUBJECT_ID, before: missingVersionId, after: current.id }),
      ).rejects.toMatchObject({ code: "not_found" });
    },
  );

  it("fails closed when the selected snapshot requires the future verified RawStore", async () => {
    const { stores } = await seed();
    const content = "Parser output backed by a retained raw file.";
    const raw = makeMaterial(content, "https://example.com/raw", "document", {
      kind: "raw_extract",
      rawId: rawIdSchema.parse(`raw_${"9".repeat(64)}`),
      method: "document_text",
      producer: "fixture-parser",
    });
    await stores.materials.write(raw, content);
    const previous = await stores.states.read(SUBJECT_ID);
    const materialManifest = [...previous.materialManifest, entryFor(raw)].sort((left, right) =>
      left.materialId < right.materialId ? -1 : left.materialId > right.materialId ? 1 : 0,
    );
    await stores.states.write(
      reseal(previous, {
        generation: previous.generation + 1,
        materialSetHash: hashMaterialSet(materialManifest),
        materialManifest,
      }),
    );
    const service = new MaterialQueryService({
      materials: stores.materials,
      committedVersions: committedReader(stores),
    });
    await expect(service.list({ subjectId: SUBJECT_ID })).rejects.toMatchObject({
      code: "schema_unsupported",
    });
  });

  it("rejects a complete physical version that has no durable creation event", async () => {
    const { stores, current, first } = await seed();
    const orphan = await publishVersion(stores, {
      entries: [entryFor(first)],
      generation: 3,
      createdAt: isoDateTimeSchema.parse("2026-08-21T00:02:00.000Z"),
      disposition: "current",
      requestId: request(6),
      parentId: current.id,
    });
    const reader = committedReader(stores);
    const materials = new MaterialQueryService({
      materials: stores.materials,
      committedVersions: reader,
    });
    const profiles = new ProfileService({ committedVersions: reader });
    const versions = new VersionService({ committedVersions: reader });

    for (const read of [
      () => versions.list({ subjectId: SUBJECT_ID }),
      () => versions.lineage({ subjectId: SUBJECT_ID }),
      () => versions.diff({ subjectId: SUBJECT_ID, before: current.id, after: orphan.id }),
      () => profiles.get({ subjectId: SUBJECT_ID, versionId: orphan.id }),
      () => materials.list({ subjectId: SUBJECT_ID, atVersionId: orphan.id }),
    ]) {
      await expect(read()).rejects.toMatchObject({ code: "storage_corrupt" });
    }
  });

  it("rejects a complete physical material that no committed manifest references", async () => {
    const { stores } = await seed();
    const content = "Uncommitted but internally complete material.";
    const orphan = makeMaterial(content, "https://example.com/orphan", "web");
    await stores.materials.write(orphan, content);
    const reader = committedReader(stores);
    const reads = [
      () => new VersionService({ committedVersions: reader }).list({ subjectId: SUBJECT_ID }),
      () => new ProfileService({ committedVersions: reader }).status({ subjectId: SUBJECT_ID }),
      () =>
        new LegacyFileReviewQueryService({
          subjects: stores.subjects,
          committedVersions: reader,
        }).list({
          subjectId: SUBJECT_ID,
        }),
      () =>
        new MaterialQueryService({ materials: stores.materials, committedVersions: reader }).list({
          subjectId: SUBJECT_ID,
        }),
    ];
    for (const read of reads) {
      await expect(read()).rejects.toMatchObject({ code: "storage_corrupt" });
    }
  });

  it("accepts a physical material referenced only by immutable history", async () => {
    const { stores, first, second, current, candidate } = await seed();
    const replacement = await publishVersion(stores, {
      entries: [entryFor(second)],
      generation: 3,
      createdAt: isoDateTimeSchema.parse("2026-08-21T00:03:00.000Z"),
      disposition: "current",
      requestId: request(20),
      parentId: current.id,
    });
    await writeEvent(stores, 19, {
      kind: "version.rejected",
      subjectId: SUBJECT_ID,
      versionId: candidate.id,
      at: isoDateTimeSchema.parse("2026-08-21T00:02:00.000Z"),
    });
    await writeEvent(stores, 20, {
      kind: "version.current",
      subjectId: SUBJECT_ID,
      versionId: replacement.id,
      at: replacement.createdAt,
    });
    const previous = await stores.states.read(SUBJECT_ID);
    const { checksum, currentVersionId, suspendedVersionId, ...payload } = previous;
    void checksum;
    void currentVersionId;
    void suspendedVersionId;
    const materialManifest = [entryFor(second)];
    await stores.states.write(
      sealFact<SubjectStateRecord>({
        ...payload,
        generation: 3,
        materialSetHash: hashMaterialSet(materialManifest),
        materialManifest,
        currentVersionId: replacement.id,
      }),
    );

    expect((await stores.materials.list(SUBJECT_ID)).map(({ record }) => record.id)).toContain(
      first.id,
    );
    const page = await new VersionService({ committedVersions: committedReader(stores) }).list({
      subjectId: SUBJECT_ID,
    });
    expect(page.items.map(({ id }) => id)).toContain(replacement.id);
  });

  it("rejects missing and contradictory version-event lifecycle references", async () => {
    const { stores, candidate } = await seed();
    const missingVersionId = versionIdSchema.parse(`version_${"f".repeat(64)}`);
    await stores.events.write(
      SUBJECT_ID,
      sealFact<EventRecord>({
        schemaVersion: 1,
        eventId: eventIdSchema.parse(`event_${"4".padStart(32, "0")}`),
        event: {
          kind: "version.promoted",
          subjectId: SUBJECT_ID,
          versionId: missingVersionId,
          at: LATER,
        },
        actor: ACTOR,
        requestId: request(7),
      }),
    );
    const versions = new VersionService({ committedVersions: committedReader(stores) });
    await expect(versions.lineage({ subjectId: SUBJECT_ID })).rejects.toMatchObject({
      code: "storage_corrupt",
    });

    const secondSeed = await seed();
    for (const [digit, kind] of [
      [4, "version.promoted"],
      [5, "version.rejected"],
    ] as const) {
      await secondSeed.stores.events.write(
        SUBJECT_ID,
        sealFact<EventRecord>({
          schemaVersion: 1,
          eventId: eventIdSchema.parse(`event_${digit.toString().padStart(32, "0")}`),
          event: { kind, subjectId: SUBJECT_ID, versionId: candidate.id, at: LATER },
          actor: ACTOR,
          requestId: request(digit + 4),
          ...(kind === "version.rejected" ? { reason: "Reject candidate." } : {}),
        }),
      );
    }
    const contradictory = new VersionService({
      committedVersions: committedReader(secondSeed.stores),
    });
    await expect(contradictory.list({ subjectId: SUBJECT_ID })).rejects.toMatchObject({
      code: "storage_corrupt",
    });
  });

  it.each(committedCorruptionCases)(
    "rejects committed version sets with %s",
    async (_name, corrupt) => {
      const fixture = await seed();
      await corrupt(fixture);
      const service = new VersionService({
        committedVersions: committedReader(fixture.stores),
      });
      await expect(service.list({ subjectId: SUBJECT_ID })).rejects.toMatchObject({
        code: "storage_corrupt",
      });
    },
  );

  it("rechecks writer intent after the subject lock and releases before recovery", async () => {
    const { stores, current } = await seed();
    const order: string[] = [];
    let reconcileCount = 0;
    let acquireCount = 0;
    let probeCount = 0;
    const reader = new CommittedVersionReader({
      spaces: stores.spaces,
      subjects: stores.subjects,
      states: stores.states,
      materials: stores.materials,
      versions: stores.versions,
      events: stores.events,
      subjectLocks: {
        acquire: vi.fn(() => {
          const attempt = (acquireCount += 1);
          order.push(`acquire:${attempt}`);
          return Promise.resolve({
            ownerToken: HEX_32,
            heartbeat: () => Promise.resolve(),
            release: () => {
              order.push(`release:${attempt}`);
              return Promise.resolve();
            },
          });
        }),
      },
      reconcile: () => {
        order.push(`reconcile:${(reconcileCount += 1)}`);
        return Promise.resolve();
      },
      writerPending: () => {
        const attempt = (probeCount += 1);
        order.push(`probe:${attempt}`);
        return Promise.resolve(attempt === 1);
      },
    });

    await expect(
      reader.withSnapshot(SUBJECT_ID, (snapshot) => {
        order.push("read");
        return snapshot.state.currentVersionId;
      }),
    ).resolves.toBe(current.id);
    expect(order).toEqual([
      "reconcile:1",
      "acquire:1",
      "probe:1",
      "release:1",
      "reconcile:2",
      "acquire:2",
      "probe:2",
      "read",
      "release:2",
    ]);
  });

  it("reconciles a global review page once before taking per-subject read locks", async () => {
    const { stores } = await seed();
    for (const digit of [1, 2]) {
      const subjectId = subjectIdSchema.parse(`subject_${digit.toString().padStart(32, "0")}`);
      await stores.subjects.write(
        sealFact<SubjectRecord>({
          schemaVersion: 1,
          id: subjectId,
          spaceId: SPACE_ID,
          displayName: `Subject ${digit}`,
          aliases: [],
          identityHints: [],
          lifecycle: "active",
        }),
      );
      await stores.states.write(
        sealFact<SubjectStateRecord>({
          schemaVersion: 2,
          subjectId,
          generation: 0,
          materialManifest: [],
        }),
      );
      await stores.events.write(
        subjectId,
        sealFact<EventRecord>({
          schemaVersion: 1,
          eventId: eventIdSchema.parse(`event_${digit.toString().padStart(32, "0")}`),
          event: { kind: "subject.created", subjectId, at: AT },
          actor: ACTOR,
          requestId: request(digit + 10),
        }),
      );
    }
    const reconcile = vi.fn(() => Promise.resolve());
    const reviews = new LegacyFileReviewQueryService({
      subjects: stores.subjects,
      committedVersions: committedReader(stores, reconcile),
    });
    await expect(reviews.list()).resolves.toMatchObject({ items: [expect.any(Object)] });
    expect(reconcile).toHaveBeenCalledTimes(1);
    await expect(reviews.list({ subjectId: SUBJECT_ID })).resolves.toMatchObject({
      items: [expect.any(Object)],
    });
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});
