import {
  briefContractDigestSchema,
  DistillyError,
  contentDigestSchema,
  eventIdSchema,
  isoDateTimeSchema,
  jobIdSchema,
  leaseIdSchema,
  leaseOwnerIdSchema,
  materialIdSchema,
  materialSetHashSchema,
  provenanceDigestSchema,
  requestIdSchema,
  spaceIdSchema,
  subjectIdSchema,
  versionIdSchema,
} from "@distilly/protocol";
import type {
  DistillyErrorCode,
  EventRecord,
  FactEnvelope,
  MaterialRecord,
  OperationRecord,
  Profile,
  SpaceRecord,
  SubjectId,
  SubjectRecord,
  SubjectStateRecord,
  SubjectSummary,
  VersionMaterialEntry,
  VersionMaterialManifest,
  VersionClaimsSnapshot,
  VersionRecord,
} from "@distilly/protocol";
import { mkdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { Layout } from "../layout.js";
import { PROFILE_RENDERER_VERSION, renderProfile, renderPrompt } from "../profile/render.js";
import type { VersionIdentityPayload } from "../profile/version-id.js";
import { deriveVersionId } from "../profile/version-id.js";
import { FileVersionStaging } from "../testing/legacy-file-version-staging.test.fixture.js";
import { computeFactChecksum, sealFact } from "./checksum.js";
import {
  deriveMaterialId,
  digestBriefContract,
  digestContent,
  digestMaterialProvenance,
  hashMaterialSet,
} from "./digests.js";
import { FileEventStore } from "./event-store.js";
import { FileMaterialStore } from "./material-store.js";
import { FileOperationStore } from "./operation-store.js";
import { FileSpaceStore } from "./space-store.js";
import { FileStateStore } from "./state-store.js";
import { FileSubjectStore } from "./subject-store.js";
import { FileVersionStore } from "./version-store.js";

const HEX_32 = "0".repeat(32);
const ALT_HEX_32 = "1".repeat(32);
const HEX_64 = "0".repeat(64);
const ALT_HEX_64 = "1".repeat(64);

const SPACE_ID = spaceIdSchema.parse(`space_${HEX_32}`);
const OTHER_SPACE_ID = spaceIdSchema.parse(`space_${ALT_HEX_32}`);
const SUBJECT_ID = subjectIdSchema.parse(`subject_${HEX_32}`);
const OTHER_SUBJECT_ID = subjectIdSchema.parse(`subject_${ALT_HEX_32}`);
const EVENT_ID = eventIdSchema.parse(`event_${HEX_32}`);
const OTHER_EVENT_ID = eventIdSchema.parse(`event_${ALT_HEX_32}`);
const REQUEST_ID = requestIdSchema.parse(`req_${HEX_32}`);
const OTHER_REQUEST_ID = requestIdSchema.parse(`req_${ALT_HEX_32}`);
const OTHER_VERSION_ID = versionIdSchema.parse(`version_${ALT_HEX_64}`);
const AT = isoDateTimeSchema.parse("2026-08-20T00:00:00.000Z");
const LATER = isoDateTimeSchema.parse("2026-08-20T00:01:00.000Z");
const CANONICAL_SPACE_BYTES = `{"checksum":"fact_sha256_fe51be64a2d3df70e654c6be7d3d0ae762cf295676c97c476406d9eb3d921c06","displayName":"People","id":"space_${HEX_32}","kind":"people","schemaVersion":1}\n`;

const VERSION_QUALITY = {
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
  await Promise.all(
    roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })),
  );
});

type Harness = {
  readonly root: string;
  readonly layout: Layout;
  readonly spaces: FileSpaceStore;
  readonly subjects: FileSubjectStore;
  readonly materials: FileMaterialStore;
  readonly states: FileStateStore;
  readonly events: FileEventStore;
  readonly operations: FileOperationStore;
};

const createHarness = async (): Promise<Harness> => {
  const root = await mkdtemp(join(tmpdir(), "distilly-fact-stores-"));
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
    events: new FileEventStore(layout, subjects),
    operations: new FileOperationStore(layout, subjects),
  };
};

const expectErrorCode = async (
  promise: Promise<unknown>,
  code: DistillyErrorCode,
): Promise<void> => {
  try {
    await promise;
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(DistillyError);
    expect(error).toMatchObject({ code });
  }
};

const omitChecksum = <T extends FactEnvelope>(record: T): Omit<T, "checksum"> => {
  const { checksum, ...payload } = record;
  void checksum;
  return payload;
};

const resealFact = <T extends FactEnvelope>(
  record: T,
  overrides: Partial<Omit<T, "checksum">>,
): T => sealFact<T>({ ...omitChecksum(record), ...overrides });

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
};

const makeSpace = (
  id = SPACE_ID,
  displayName = "People",
  kind: SpaceRecord["kind"] = "people",
): SpaceRecord =>
  sealFact<SpaceRecord>({
    schemaVersion: 1,
    id,
    displayName,
    kind,
  });

const makeSubject = (id = SUBJECT_ID, spaceId = SPACE_ID, displayName = "Ada"): SubjectRecord =>
  sealFact<SubjectRecord>({
    schemaVersion: 1,
    id,
    spaceId,
    displayName,
    aliases: ["A"],
    identityHints: [{ kind: "url", value: "https://example.com/ada" }],
    lifecycle: "active",
  });

const makeSubjectSummary = (
  subjectId = SUBJECT_ID,
  spaceId = SPACE_ID,
  displayName = "Ada",
): SubjectSummary => ({
  id: subjectId,
  displayName,
  aliases: ["A"],
  identityHints: [{ kind: "url", value: "https://example.com/ada" }],
  space: { id: spaceId, displayName: "People", kind: "people" },
  lifecycle: "active",
});

const makeMaterial = (
  content = "Evidence-bound material.\n",
  input: {
    readonly subjectId?: SubjectId;
    readonly sourceIdentity?: string;
    readonly uri?: string;
    readonly title?: string;
    readonly capturedAt?: string;
    readonly sensitivity?: "private" | "shareable";
  } = {},
): MaterialRecord => {
  const subjectId = input.subjectId ?? SUBJECT_ID;
  const contentDigest = digestContent(content);
  const provisional = sealFact<MaterialRecord>({
    schemaVersion: 1,
    id: materialIdSchema.parse(`mat_${HEX_64}`),
    subjectId,
    kind: "web",
    contentDigest,
    provenanceDigest: provenanceDigestSchema.parse(`provenance_sha256_${HEX_64}`),
    sourceIdentity: input.sourceIdentity ?? "uri:https://example.com/post",
    source: {
      uri: input.uri ?? "https://example.com/post",
      title: input.title ?? "Post",
      medium: "article",
      access: "public",
      role: "first_party_expression",
      capturedAt: isoDateTimeSchema.parse(input.capturedAt ?? AT),
      publishedAt: AT,
      authors: ["Ada"],
    },
    derivation: { kind: "native_text" },
    participants: [],
    sensitivity: input.sensitivity ?? "private",
    flags: [],
    storedAt: AT,
  });
  const provenanceDigest = digestMaterialProvenance(provisional);
  return resealFact(provisional, {
    provenanceDigest,
    id: deriveMaterialId(provisional.sourceIdentity, provenanceDigest, contentDigest),
  });
};

const materialEntry = (record: MaterialRecord): VersionMaterialEntry => ({
  materialId: record.id,
  contentDigest: record.contentDigest,
  provenanceDigest: record.provenanceDigest,
});

const makeState = (
  subjectId = SUBJECT_ID,
  entries: readonly VersionMaterialEntry[] = [],
): SubjectStateRecord =>
  entries.length === 0
    ? sealFact<SubjectStateRecord>({
        schemaVersion: 2,
        subjectId,
        generation: 0,
        materialManifest: [],
      })
    : sealFact<SubjectStateRecord>({
        schemaVersion: 2,
        subjectId,
        generation: 1,
        materialSetHash: hashMaterialSet(entries),
        materialManifest: entries,
      });

const makePendingState = (
  entries: readonly VersionMaterialEntry[],
  addedMaterialCount: number,
  baseVersionId?: VersionRecord["id"],
): SubjectStateRecord => {
  const materialManifest = [...entries].sort((left, right) =>
    left.materialId < right.materialId ? -1 : left.materialId > right.materialId ? 1 : 0,
  );
  const generation = baseVersionId === undefined ? 1 : 2;
  const materialSetHash = hashMaterialSet(materialManifest);
  return sealFact<SubjectStateRecord>({
    schemaVersion: 2,
    subjectId: SUBJECT_ID,
    generation,
    materialSetHash,
    materialManifest,
    ...(baseVersionId === undefined ? {} : { currentVersionId: baseVersionId }),
    pending: {
      jobId: jobIdSchema.parse(`job_${HEX_32}`),
      generation,
      ...(baseVersionId === undefined ? {} : { baseVersionId }),
      materialSetHash,
      addedMaterialCount,
      totalMaterialCount: materialManifest.length,
      queuedAt: AT,
    },
  });
};

const writeVersion = async (
  harness: Harness,
  items: readonly VersionMaterialEntry[],
  fixtureName: string,
): Promise<VersionRecord["id"]> => {
  const manifestItems = [...items].sort((left, right) =>
    left.materialId < right.materialId ? -1 : left.materialId > right.materialId ? 1 : 0,
  );
  const identity: VersionIdentityPayload = {
    subjectId: SUBJECT_ID,
    subjectDisplayName: "Ada",
    generation: 1,
    materialSetHash: hashMaterialSet(manifestItems),
    creation: {
      kind: "bundle_import",
      bundleDigest: contentDigestSchema.parse(`sha256_${HEX_64}`),
    },
    createdDisposition: "current",
    actor: { kind: "system", id: `state-baseline-${fixtureName}` },
    quality: VERSION_QUALITY,
    rendererVersion: PROFILE_RENDERER_VERSION,
  };
  const versionId = deriveVersionId(identity, []);
  const version = sealFact<VersionRecord>({
    schemaVersion: 1,
    id: versionId,
    ...identity,
    materialCount: manifestItems.length,
    createdAt: AT,
  });
  const manifest = sealFact<VersionMaterialManifest>({
    schemaVersion: 1,
    items: manifestItems,
  });
  const claims = sealFact<VersionClaimsSnapshot>({
    schemaVersion: 1,
    subjectId: SUBJECT_ID,
    versionId,
    claims: [],
  });
  const rendering = renderProfile({
    subjectId: SUBJECT_ID,
    displayName: "Ada",
    versionId,
    claims: [],
    quality: VERSION_QUALITY,
  });
  const profile: Profile = {
    subjectId: SUBJECT_ID,
    displayName: "Ada",
    versionId,
    claims: [],
    core: rendering.core,
    domains: rendering.domains,
    rendered: rendering.markdown,
    quality: VERSION_QUALITY,
  };
  const artifacts = { version, manifest, claims, profile, prompt: renderPrompt(profile) };
  const versions = new FileVersionStore(harness.layout, harness.materials);
  const staging = new FileVersionStaging(harness.layout, versions);
  await staging.prepare(REQUEST_ID, artifacts);
  await staging.publish(REQUEST_ID, artifacts);
  return versionId;
};

const makeEvent = (eventId = EVENT_ID, subjectId = SUBJECT_ID, at = AT): EventRecord =>
  sealFact<EventRecord>({
    schemaVersion: 1,
    eventId,
    event: { kind: "material.ingested", subjectId, at },
    actor: { kind: "sdk", id: "fact-store-test" },
    requestId: REQUEST_ID,
  });

const makeOperation = (
  requestId = REQUEST_ID,
  resultSubjectId = SUBJECT_ID,
  completedAt = AT,
): OperationRecord<"subjects.create"> =>
  sealFact<OperationRecord<"subjects.create">>({
    schemaVersion: 1,
    recordKind: "completed",
    requestId,
    method: "subjects.create",
    scope: { kind: "subject", subjectId: resultSubjectId },
    actor: { kind: "sdk", id: "fact-store-test" },
    inputChecksum: computeFactChecksum({ method: "subjects.create", displayName: "Ada" }),
    result: makeSubjectSummary(resultSubjectId),
    completedAt,
  });

const seedSubject = async (harness: Harness): Promise<void> => {
  await harness.spaces.write(makeSpace());
  await harness.subjects.write(makeSubject());
};

const seedAllStores = async (harness: Harness) => {
  await seedSubject(harness);
  const content = "Evidence-bound material.\n";
  const material = makeMaterial(content);
  const state = makeState(SUBJECT_ID, [materialEntry(material)]);
  const event = makeEvent();
  const operation = makeOperation();
  await harness.materials.write(material, content);
  await harness.states.write(state);
  await harness.events.write(SUBJECT_ID, event);
  await harness.operations.write(operation);
  return { content, material, state, event, operation };
};

describe("concrete fact stores", () => {
  it("round-trips every fact family and accepts exact immutable retries", async () => {
    const harness = await createHarness();
    const { content, material, state, event, operation } = await seedAllStores(harness);

    await harness.materials.write(material, content);
    await harness.events.write(SUBJECT_ID, event);
    await harness.operations.write(operation);

    expect(await harness.spaces.read(SPACE_ID)).toEqual(makeSpace());
    expect(await harness.subjects.read(SUBJECT_ID)).toEqual(makeSubject());
    expect(await harness.materials.read(SUBJECT_ID, material.id)).toEqual({
      record: material,
      content,
    });
    expect(await harness.states.read(SUBJECT_ID)).toEqual(state);
    expect(await harness.events.read(SUBJECT_ID, EVENT_ID)).toEqual(event);
    expect(await harness.operations.read(REQUEST_ID)).toEqual(operation);

    const renamedSpace = makeSpace(SPACE_ID, "People and Creators");
    const renamedSubject = makeSubject(SUBJECT_ID, SPACE_ID, "Ada Lovelace");
    await expectErrorCode(harness.spaces.write(renamedSpace), "storage_corrupt");
    await harness.subjects.write(renamedSubject);
    expect(await harness.spaces.read(SPACE_ID)).toEqual(makeSpace());
    expect(await harness.subjects.read(SUBJECT_ID)).toEqual(renamedSubject);
  });

  it("passes v2 to the fact-family schema and rejects v3, corruption, and path mismatches", async () => {
    const harness = await createHarness();
    const record = makeSpace();
    await harness.spaces.write(record);

    await writeJson(harness.layout.spaceFile(SPACE_ID), { ...record, schemaVersion: 2 });
    await expectErrorCode(harness.spaces.read(SPACE_ID), "storage_corrupt");

    await writeJson(harness.layout.spaceFile(SPACE_ID), { ...record, schemaVersion: 3 });
    await expectErrorCode(harness.spaces.read(SPACE_ID), "schema_unsupported");

    for (const schemaVersion of [undefined, "1", null, {}, [], 0, -1, 1.5]) {
      await writeJson(harness.layout.spaceFile(SPACE_ID), { ...record, schemaVersion });
      await expectErrorCode(harness.spaces.read(SPACE_ID), "storage_corrupt");
    }

    await writeJson(harness.layout.spaceFile(SPACE_ID), { ...record, displayName: "Tampered" });
    await expectErrorCode(harness.spaces.read(SPACE_ID), "storage_corrupt");

    await writeJson(harness.layout.spaceFile(SPACE_ID), makeSpace(OTHER_SPACE_ID));
    await expectErrorCode(harness.spaces.read(SPACE_ID), "storage_corrupt");
  });

  it("requires every subject to reference an existing space and match its path", async () => {
    const harness = await createHarness();
    await expectErrorCode(harness.subjects.write(makeSubject()), "storage_corrupt");

    await harness.spaces.write(makeSpace());
    await harness.subjects.write(makeSubject());
    await writeJson(harness.layout.subjectFile(SUBJECT_ID), makeSubject(OTHER_SUBJECT_ID));
    await expectErrorCode(harness.subjects.read(SUBJECT_ID), "storage_corrupt");

    await writeJson(
      harness.layout.subjectFile(SUBJECT_ID),
      makeSubject(SUBJECT_ID, OTHER_SPACE_ID),
    );
    await expectErrorCode(harness.subjects.read(SUBJECT_ID), "storage_corrupt");
  });

  it("validates immutable material content, provenance, identity, path, and conflicts", async () => {
    const harness = await createHarness();
    await seedSubject(harness);
    const content = "Evidence-bound material.\n";
    const material = makeMaterial(content);
    await harness.materials.write(material, content);

    await writeFile(harness.layout.materialContentFile(SUBJECT_ID, material.id), "tampered\n");
    await expectErrorCode(harness.materials.read(SUBJECT_ID, material.id), "storage_corrupt");

    await writeFile(
      harness.layout.materialContentFile(SUBJECT_ID, material.id),
      Buffer.from([0xc3, 0x28]),
    );
    await expectErrorCode(harness.materials.read(SUBJECT_ID, material.id), "storage_corrupt");

    await rm(harness.layout.materialDirectory(SUBJECT_ID, material.id), {
      recursive: true,
      force: true,
    });
    await harness.materials.write(material, content);
    const provenanceMismatch = resealFact(material, { sensitivity: "shareable" });
    await writeJson(harness.layout.materialFile(SUBJECT_ID, material.id), provenanceMismatch);
    await expectErrorCode(harness.materials.read(SUBJECT_ID, material.id), "storage_corrupt");

    await rm(harness.layout.materialDirectory(SUBJECT_ID, material.id), {
      recursive: true,
      force: true,
    });
    const wrongId = resealFact(material, {
      id: materialIdSchema.parse(`mat_${ALT_HEX_64}`),
    });
    await expectErrorCode(harness.materials.write(wrongId, content), "storage_corrupt");

    await harness.materials.write(material, content);
    const movedId = materialIdSchema.parse(`mat_${ALT_HEX_64}`);
    await rename(
      harness.layout.materialDirectory(SUBJECT_ID, material.id),
      harness.layout.materialDirectory(SUBJECT_ID, movedId),
    );
    await expectErrorCode(harness.materials.read(SUBJECT_ID, movedId), "storage_corrupt");

    await rename(
      harness.layout.materialDirectory(SUBJECT_ID, movedId),
      harness.layout.materialDirectory(SUBJECT_ID, material.id),
    );
    const conflictingObservation = makeMaterial(content, {
      title: "A later display title",
      capturedAt: LATER,
    });
    expect(conflictingObservation.id).toBe(material.id);
    expect(conflictingObservation.provenanceDigest).toBe(material.provenanceDigest);
    await expectErrorCode(
      harness.materials.write(conflictingObservation, content),
      "storage_corrupt",
    );
    expect(await harness.materials.read(SUBJECT_ID, material.id)).toEqual({
      record: material,
      content,
    });

    const mirror = makeMaterial(content, {
      sourceIdentity: "uri:https://mirror.example/post",
      uri: "https://mirror.example/post",
    });
    expect(mirror.provenanceDigest).toBe(material.provenanceDigest);
    expect(mirror.id).not.toBe(material.id);

    const shareable = makeMaterial(content, { sensitivity: "shareable" });
    expect(shareable.provenanceDigest).not.toBe(material.provenanceDigest);
    expect(shareable.id).not.toBe(material.id);
  });

  it("enumerates only complete canonical material directories", async () => {
    const harness = await createHarness();
    await seedSubject(harness);
    const content = "Evidence-bound material.\n";
    const material = makeMaterial(content);
    await harness.materials.write(material, content);

    await expect(harness.materials.list(SUBJECT_ID)).resolves.toEqual([
      { record: material, content },
    ]);

    const unknown = join(harness.layout.materialsDirectory(SUBJECT_ID), "unknown");
    await writeFile(unknown, "unknown");
    await expectErrorCode(harness.materials.list(SUBJECT_ID), "storage_corrupt");
    await rm(unknown);

    const linked = join(harness.layout.materialsDirectory(SUBJECT_ID), `mat_${ALT_HEX_64}`);
    await symlink(harness.layout.materialDirectory(SUBJECT_ID, material.id), linked);
    await expectErrorCode(harness.materials.list(SUBJECT_ID), "storage_corrupt");
  });

  it("validates state subject ownership, manifest facts, digests, and set hash", async () => {
    const harness = await createHarness();
    await seedSubject(harness);
    const content = "Evidence-bound material.\n";
    const material = makeMaterial(content);
    const entry = materialEntry(material);
    await harness.materials.write(material, content);

    const valid = makeState(SUBJECT_ID, [entry]);
    await harness.states.write(valid);
    expect(await harness.states.read(SUBJECT_ID)).toEqual(valid);

    const missingEntry: VersionMaterialEntry = {
      ...entry,
      materialId: materialIdSchema.parse(`mat_${ALT_HEX_64}`),
    };
    await expectErrorCode(
      harness.states.write(makeState(SUBJECT_ID, [missingEntry])),
      "storage_corrupt",
    );

    const wrongContentEntry: VersionMaterialEntry = {
      ...entry,
      contentDigest: contentDigestSchema.parse(`sha256_${ALT_HEX_64}`),
    };
    await expectErrorCode(
      harness.states.write(makeState(SUBJECT_ID, [wrongContentEntry])),
      "storage_corrupt",
    );

    const wrongProvenanceEntry: VersionMaterialEntry = {
      ...entry,
      provenanceDigest: provenanceDigestSchema.parse(`provenance_sha256_${ALT_HEX_64}`),
    };
    await expectErrorCode(
      harness.states.write(makeState(SUBJECT_ID, [wrongProvenanceEntry])),
      "storage_corrupt",
    );

    const wrongHash = resealFact(valid, {
      materialSetHash: materialSetHashSchema.parse(`set_sha256_${ALT_HEX_64}`),
    });
    await expectErrorCode(harness.states.write(wrongHash), "storage_corrupt");

    const contractFields = {
      sourceGroupingVersion: "source-groups-v1",
      promptVersion: `host-distill-v1-sha256_${HEX_64}` as const,
      draftSchemaVersion: 1,
    } as const;
    const leased = resealFact(valid, {
      pending: {
        jobId: jobIdSchema.parse(`job_${HEX_32}`),
        generation: valid.generation,
        materialSetHash: valid.materialSetHash!,
        addedMaterialCount: 1,
        totalMaterialCount: 1,
        queuedAt: AT,
        lease: {
          id: leaseIdSchema.parse(`lease_${HEX_32}`),
          owner: leaseOwnerIdSchema.parse(`lease_owner_${HEX_32}`),
          acquiredAt: AT,
          expiresAt: isoDateTimeSchema.parse("2026-08-20T00:30:00.000Z"),
          contract: {
            digest: digestBriefContract(contractFields),
            ...contractFields,
          },
        },
      },
    });
    await harness.states.write(leased);
    await expect(harness.states.read(SUBJECT_ID)).resolves.toEqual(leased);

    const forgedLease = resealFact(leased, {
      pending: {
        ...leased.pending!,
        lease: {
          ...leased.pending!.lease!,
          contract: {
            ...leased.pending!.lease!.contract,
            digest: briefContractDigestSchema.parse(`brief_contract_${ALT_HEX_64}`),
          },
        },
      },
    });
    await expectErrorCode(harness.states.write(forgedLease), "storage_corrupt");
    await writeJson(harness.layout.stateFile(SUBJECT_ID), forgedLease);
    await expectErrorCode(harness.states.read(SUBJECT_ID), "storage_corrupt");

    await writeJson(harness.layout.stateFile(SUBJECT_ID), makeState(OTHER_SUBJECT_ID));
    await expectErrorCode(harness.states.read(SUBJECT_ID), "storage_corrupt");
    await expectErrorCode(harness.states.write(makeState(OTHER_SUBJECT_ID)), "storage_corrupt");
  });

  it("validates pending added-material counts against the verified current-version baseline", async () => {
    const harness = await createHarness();
    await seedSubject(harness);
    const baselineContent = "Baseline material.\n";
    const addedContent = "Added material.\n";
    const baselineMaterial = makeMaterial(baselineContent, {
      sourceIdentity: "uri:https://example.com/baseline",
      uri: "https://example.com/baseline",
    });
    const addedMaterial = makeMaterial(addedContent, {
      sourceIdentity: "uri:https://example.com/added",
      uri: "https://example.com/added",
    });
    const baselineEntry = materialEntry(baselineMaterial);
    const addedEntry = materialEntry(addedMaterial);
    await harness.materials.write(baselineMaterial, baselineContent);
    await harness.materials.write(addedMaterial, addedContent);

    const rejectAtWriteAndRead = async (record: SubjectStateRecord): Promise<void> => {
      await expectErrorCode(harness.states.write(record), "storage_corrupt");
      await writeJson(harness.layout.stateFile(SUBJECT_ID), record);
      await expectErrorCode(harness.states.read(SUBJECT_ID), "storage_corrupt");
    };

    const firstVersion = makePendingState([baselineEntry], 1);
    await harness.states.write(firstVersion);
    await expect(harness.states.read(SUBJECT_ID)).resolves.toEqual(firstVersion);
    await rejectAtWriteAndRead(makePendingState([baselineEntry], 0));

    const baselineVersionId = await writeVersion(harness, [baselineEntry], "baseline");
    const incremental = makePendingState([baselineEntry, addedEntry], 1, baselineVersionId);
    await harness.states.write(incremental);
    await expect(harness.states.read(SUBJECT_ID)).resolves.toEqual(incremental);
    await rejectAtWriteAndRead(makePendingState([baselineEntry, addedEntry], 0, baselineVersionId));

    await rejectAtWriteAndRead(makePendingState([baselineEntry, addedEntry], 1, OTHER_VERSION_ID));
    const otherVersionId = await writeVersion(harness, [addedEntry], "other");
    await rejectAtWriteAndRead(makePendingState([baselineEntry], 0, otherVersionId));

    await unlink(harness.layout.versionMaterialManifestFile(SUBJECT_ID, otherVersionId));
    await rejectAtWriteAndRead(makePendingState([baselineEntry, addedEntry], 1, otherVersionId));
  });

  it("rejects unsorted and duplicate material manifests at the state-store boundary", async () => {
    const harness = await createHarness();
    await seedSubject(harness);
    const firstContent = "First manifest material.\n";
    const secondContent = "Second manifest material.\n";
    const first = makeMaterial(firstContent, {
      sourceIdentity: "uri:https://example.com/first",
      uri: "https://example.com/first",
    });
    const second = makeMaterial(secondContent, {
      sourceIdentity: "uri:https://example.com/second",
      uri: "https://example.com/second",
    });
    await harness.materials.write(first, firstContent);
    await harness.materials.write(second, secondContent);

    const entries = [materialEntry(first), materialEntry(second)].sort((left, right) =>
      left.materialId < right.materialId ? -1 : left.materialId > right.materialId ? 1 : 0,
    );
    const valid = makeState(SUBJECT_ID, entries);
    await harness.states.write(valid);
    await expect(harness.states.read(SUBJECT_ID)).resolves.toEqual(valid);

    const firstEntry = entries[0];
    if (firstEntry === undefined) throw new Error("Expected a non-empty material manifest.");
    const invalidStates = [
      makeState(SUBJECT_ID, [...entries].reverse()),
      makeState(SUBJECT_ID, [firstEntry, firstEntry]),
    ];
    for (const invalid of invalidStates) {
      await expectErrorCode(harness.states.write(invalid), "storage_corrupt");
      await writeJson(harness.layout.stateFile(SUBJECT_ID), invalid);
      await expectErrorCode(harness.states.read(SUBJECT_ID), "storage_corrupt");
    }
  });

  it("keeps event and operation facts immutable and subject-associated", async () => {
    const harness = await createHarness();
    await harness.spaces.write(makeSpace());
    await harness.subjects.write(makeSubject());
    await harness.subjects.write(makeSubject(OTHER_SUBJECT_ID, SPACE_ID, "Grace"));

    const event = makeEvent();
    await harness.events.write(SUBJECT_ID, event);
    await harness.events.write(SUBJECT_ID, event);
    await expectErrorCode(
      harness.events.write(SUBJECT_ID, makeEvent(EVENT_ID, SUBJECT_ID, LATER)),
      "storage_corrupt",
    );
    await expectErrorCode(
      harness.events.write(SUBJECT_ID, makeEvent(OTHER_EVENT_ID, OTHER_SUBJECT_ID)),
      "storage_corrupt",
    );

    const operation = makeOperation();
    await harness.operations.write(operation);
    await harness.operations.write(operation);
    await expectErrorCode(
      harness.operations.write(makeOperation(REQUEST_ID, SUBJECT_ID, LATER)),
      "storage_corrupt",
    );
    await expectErrorCode(
      harness.operations.write(
        resealFact(makeOperation(OTHER_REQUEST_ID, OTHER_SUBJECT_ID), {
          scope: { kind: "subject", subjectId: SUBJECT_ID },
        }),
      ),
      "storage_corrupt",
    );

    await writeJson(harness.layout.eventFile(SUBJECT_ID, EVENT_ID), makeEvent(OTHER_EVENT_ID));
    await expectErrorCode(harness.events.read(SUBJECT_ID, EVENT_ID), "storage_corrupt");
    await writeJson(harness.layout.operationFile(REQUEST_ID), makeOperation(OTHER_REQUEST_ID));
    await expectErrorCode(harness.operations.read(REQUEST_ID), "storage_corrupt");
  });

  it("rejects symbolic links at every concrete fact-store path", async () => {
    const harness = await createHarness();
    const { material } = await seedAllStores(harness);

    const cases: readonly {
      readonly path: string;
      readonly read: () => Promise<unknown>;
    }[] = [
      { path: harness.layout.spaceFile(SPACE_ID), read: () => harness.spaces.read(SPACE_ID) },
      {
        path: harness.layout.subjectFile(SUBJECT_ID),
        read: () => harness.subjects.read(SUBJECT_ID),
      },
      {
        path: harness.layout.materialDirectory(SUBJECT_ID, material.id),
        read: () => harness.materials.read(SUBJECT_ID, material.id),
      },
      { path: harness.layout.stateFile(SUBJECT_ID), read: () => harness.states.read(SUBJECT_ID) },
      {
        path: harness.layout.eventFile(SUBJECT_ID, EVENT_ID),
        read: () => harness.events.read(SUBJECT_ID, EVENT_ID),
      },
      {
        path: harness.layout.operationFile(REQUEST_ID),
        read: () => harness.operations.read(REQUEST_ID),
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const backup = `${testCase.path}.fact-store-test-${index}`;
      await rename(testCase.path, backup);
      await symlink(backup, testCase.path);
      await expectErrorCode(testCase.read(), "storage_corrupt");
      await unlink(testCase.path);
      await rename(backup, testCase.path);
    }
  });

  it("does not leak fact bodies through corruption errors", async () => {
    const harness = await createHarness();
    await seedSubject(harness);
    const content = "private evidence that must not appear in diagnostics";
    const material = makeMaterial(content);
    await harness.materials.write(material, content);
    await writeFile(harness.layout.materialContentFile(SUBJECT_ID, material.id), `${content}!`);

    try {
      await harness.materials.read(SUBJECT_ID, material.id);
      throw new Error("Expected storage corruption.");
    } catch (error) {
      expect(error).toBeInstanceOf(DistillyError);
      expect(String(error)).not.toContain(content);
    }
  });

  it("persists canonical JSON rather than caller object formatting", async () => {
    const harness = await createHarness();
    const record = makeSpace();
    await harness.spaces.write(record);
    const bytes = await readFile(harness.layout.spaceFile(SPACE_ID), "utf8");
    expect(bytes).toBe(CANONICAL_SPACE_BYTES);
  });
});
