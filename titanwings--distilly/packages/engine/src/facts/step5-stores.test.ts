import {
  BUILTIN_PEOPLE_SPACE_ID,
  DistillyError,
  isoDateTimeSchema,
  materialIdSchema,
  materialSetHashSchema,
  operationFactSchema,
  provenanceDigestSchema,
  requestIdSchema,
  spaceIdSchema,
  spaceRecordSchema,
  subjectIdSchema,
  versionIdSchema,
  versionMaterialManifestSchema,
  versionRecordSchema,
} from "@distilly/protocol";
import type {
  DistillyErrorCode,
  MaterialRecord,
  OperationFact,
  OperationRecord,
  OperationTombstoneRecord,
  RuntimeSchema,
  SpaceRecord,
  SubjectRecord,
  SubjectSummary,
  VersionMaterialEntry,
  VersionMaterialManifest,
  VersionRecord,
} from "@distilly/protocol";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Layout } from "../layout.js";
import { computeFactChecksum, sealFact } from "./checksum.js";
import {
  deriveMaterialId,
  digestContent,
  digestMaterialProvenance,
  hashMaterialSet,
} from "./digests.js";
import { createFactFile, replaceFactFile } from "./fact-file.js";
import { FileMaterialStore } from "./material-store.js";
import { FileOperationStore } from "./operation-store.js";
import { FileSpaceStore } from "./space-store.js";
import { FileSubjectStore } from "./subject-store.js";
import { FileVersionManifestStore } from "./version-manifest-store.js";

const ZERO_32 = "0".repeat(32);
const ONE_32 = "1".repeat(32);
const TWO_32 = "2".repeat(32);
const ZERO_64 = "0".repeat(64);
const ONE_64 = "1".repeat(64);
const SPACE_ID = spaceIdSchema.parse(`space_${ZERO_32}`);
const OTHER_SPACE_ID = spaceIdSchema.parse(`space_${ONE_32}`);
const SUBJECT_ID = subjectIdSchema.parse(`subject_${ZERO_32}`);
const OTHER_SUBJECT_ID = subjectIdSchema.parse(`subject_${ONE_32}`);
const REQUEST_ID = requestIdSchema.parse(`req_${ZERO_32}`);
const OTHER_REQUEST_ID = requestIdSchema.parse(`req_${ONE_32}`);
const THIRD_REQUEST_ID = requestIdSchema.parse(`req_${TWO_32}`);
const VERSION_ID = versionIdSchema.parse(`version_${ZERO_64}`);
const OTHER_VERSION_ID = versionIdSchema.parse(`version_${ONE_64}`);
const AT = isoDateTimeSchema.parse("2026-08-20T00:00:00.000Z");
const LATER = isoDateTimeSchema.parse("2026-08-20T00:01:00.000Z");
const SET_HASH = materialSetHashSchema.parse(`set_sha256_${ZERO_64}`);
const VERSION_CONTENT = "Version baseline evidence.\n";

const OPERATION_FACT_SCHEMA: RuntimeSchema<OperationFact> = {
  parse(value) {
    return operationFactSchema.parse(value) as OperationFact;
  },
};
const VERSION_SCHEMA: RuntimeSchema<VersionRecord> = {
  parse(value) {
    return versionRecordSchema.parse(value) as VersionRecord;
  },
};
const VERSION_MANIFEST_SCHEMA: RuntimeSchema<VersionMaterialManifest> = {
  parse(value) {
    return versionMaterialManifestSchema.parse(value);
  },
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "distilly-step5-stores-"));
  roots.push(root);
  return root;
};

const expectCode = async (promise: Promise<unknown>, code: DistillyErrorCode): Promise<void> => {
  try {
    await promise;
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(DistillyError);
    expect(error).toMatchObject({ code });
  }
};

const makeSpace = (id = SPACE_ID, displayName = "People"): SpaceRecord =>
  sealFact<SpaceRecord>({ schemaVersion: 1, id, displayName, kind: "people" });

const makeSubject = (id = SUBJECT_ID, spaceId = SPACE_ID, displayName = "Ada"): SubjectRecord =>
  sealFact<SubjectRecord>({
    schemaVersion: 1,
    id,
    spaceId,
    displayName,
    aliases: [],
    identityHints: [],
    lifecycle: "active",
  });

const makeMaterial = (): MaterialRecord => {
  const contentDigest = digestContent(VERSION_CONTENT);
  const provisional = sealFact<MaterialRecord>({
    schemaVersion: 1,
    id: materialIdSchema.parse(`mat_${ZERO_64}`),
    subjectId: SUBJECT_ID,
    kind: "web",
    contentDigest,
    provenanceDigest: provenanceDigestSchema.parse(`provenance_sha256_${ZERO_64}`),
    sourceIdentity: "source-uri-v1\0https://example.com/version-evidence",
    source: {
      uri: "https://example.com/version-evidence",
      medium: "article",
      access: "public",
      capturedAt: AT,
      authors: [],
    },
    derivation: { kind: "native_text" },
    participants: [],
    sensitivity: "private",
    flags: [],
    storedAt: AT,
  });
  const provenanceDigest = digestMaterialProvenance(provisional);
  return sealFact<MaterialRecord>({
    ...provisional,
    provenanceDigest,
    id: deriveMaterialId(provisional.sourceIdentity, provenanceDigest, contentDigest),
  });
};

const entryFor = (record: MaterialRecord): VersionMaterialEntry => ({
  materialId: record.id,
  contentDigest: record.contentDigest,
  provenanceDigest: record.provenanceDigest,
});

const summary = (id = SUBJECT_ID, spaceId = SPACE_ID): SubjectSummary => ({
  id,
  displayName: id === SUBJECT_ID ? "Ada" : "Grace",
  aliases: [],
  identityHints: [],
  space: { id: spaceId, displayName: "People", kind: "people" },
  lifecycle: "active",
});

const makeCreateOperation = (
  requestId = REQUEST_ID,
  subjectId = SUBJECT_ID,
): OperationRecord<"subjects.create"> =>
  sealFact<OperationRecord<"subjects.create">>({
    schemaVersion: 1,
    recordKind: "completed",
    requestId,
    method: "subjects.create",
    scope: { kind: "subject", subjectId },
    actor: { kind: "sdk", id: "step5-store-test" },
    inputChecksum: computeFactChecksum({ method: "subjects.create", subjectId }),
    result: summary(subjectId),
    completedAt: AT,
  });

const VERSION_ENTRY: VersionMaterialEntry = {
  materialId: `mat_${ZERO_64}` as VersionMaterialEntry["materialId"],
  contentDigest: `sha256_${ZERO_64}` as VersionMaterialEntry["contentDigest"],
  provenanceDigest: `provenance_sha256_${ZERO_64}` as VersionMaterialEntry["provenanceDigest"],
};

const QUALITY = {
  sourceGroupingVersion: "source-groups-v1",
  activeClaimCount: 0,
  contestedClaimCount: 0,
  userAssertedClaimCount: 0,
  corroboratedClaimCount: 0,
  sourceGroupCount: 1,
  diversityEligibleSourceGroupCount: 1,
  unknownSourceGroupCount: 0,
  coveredCoreFacets: ["identity"],
  uncoveredCoreFacets: ["voice", "psyche", "relations", "boundaries", "texture", "timeline"],
  maturity: "forming",
} as const;

const makeVersion = (
  id = VERSION_ID,
  subjectId = SUBJECT_ID,
  items: readonly VersionMaterialEntry[] = [VERSION_ENTRY],
): { readonly version: VersionRecord; readonly manifest: VersionMaterialManifest } => {
  const materialSetHash = hashMaterialSet(items);
  return {
    version: sealFact<VersionRecord>({
      schemaVersion: 1,
      id,
      subjectId,
      subjectDisplayName: "Ada",
      generation: 1,
      materialSetHash,
      materialCount: items.length,
      creation: { kind: "renderer_only", sourceVersionId: id },
      createdDisposition: "current",
      actor: { kind: "system", id: "step5-store-test" },
      quality: QUALITY,
      rendererVersion: "renderer-v1",
      createdAt: AT,
    }),
    manifest: sealFact<VersionMaterialManifest>({ schemaVersion: 1, items }),
  };
};

describe("Step 5 root fact stores", () => {
  it("creates spaces immutably and safely lists spaces and subjects", async () => {
    const root = await createRoot();
    const layout = new Layout(root);
    const spaces = new FileSpaceStore(layout);
    const subjects = new FileSubjectStore(layout, spaces);

    await spaces.write(makeSpace(OTHER_SPACE_ID, "Other"));
    await spaces.write(makeSpace());
    await spaces.write(makeSpace());
    await expectCode(spaces.write(makeSpace(SPACE_ID, "Changed")), "storage_corrupt");
    await writeFile(
      join(layout.spacesDirectory(), `.${SPACE_ID}.json.${process.pid}.${"a".repeat(16)}.tmp`),
      "partial",
    );
    expect((await spaces.list()).map((record) => record.id)).toEqual([SPACE_ID, OTHER_SPACE_ID]);

    await subjects.write(makeSubject(OTHER_SUBJECT_ID, OTHER_SPACE_ID, "Grace"));
    await subjects.write(makeSubject());
    expect((await subjects.listBySpace(SPACE_ID)).map((record) => record.id)).toEqual([SUBJECT_ID]);
    expect((await subjects.listAll()).map((record) => record.id)).toEqual([
      SUBJECT_ID,
      OTHER_SUBJECT_ID,
    ]);

    await writeFile(join(layout.spacesDirectory(), "unknown.txt"), "unknown");
    await expectCode(spaces.list(), "storage_corrupt");
    await rm(join(layout.spacesDirectory(), "unknown.txt"));
    if (process.platform === "linux") {
      const invalidName = Buffer.concat([
        Buffer.from(`${layout.spacesDirectory()}/`, "utf8"),
        Buffer.from([0xff]),
      ]);
      await writeFile(invalidName, "invalid");
      await expectCode(spaces.list(), "storage_corrupt");
      await rm(invalidName);
    }
    const partialSubject = join(
      layout.subjectsDirectory(),
      "subject_22222222222222222222222222222222",
    );
    await mkdir(partialSubject, { mode: 0o700 });
    await expectCode(subjects.listAll(), "storage_corrupt");
    await rm(partialSubject, { recursive: true });
    await symlink(root, partialSubject);
    await expectCode(subjects.listBySpace(SPACE_ID), "storage_corrupt");
  });

  it("enforces the reserved people record", async () => {
    const root = await createRoot();
    const layout = new Layout(root);
    const spaces = new FileSpaceStore(layout);
    const builtin = makeSpace(BUILTIN_PEOPLE_SPACE_ID);
    await spaces.write(builtin);
    await spaces.write(builtin);
    await expect(spaces.read(BUILTIN_PEOPLE_SPACE_ID)).resolves.toEqual(builtin);
    await expectCode(spaces.write(makeSpace(BUILTIN_PEOPLE_SPACE_ID, "people")), "storage_corrupt");

    const wrongKind = sealFact<SpaceRecord>({ ...builtin, kind: "custom" });
    await rm(layout.spaceFile(BUILTIN_PEOPLE_SPACE_ID));
    await createFactFile(
      root,
      layout.spaceFile(BUILTIN_PEOPLE_SPACE_ID),
      wrongKind,
      spaceRecordSchema,
    );
    await expectCode(spaces.read(BUILTIN_PEOPLE_SPACE_ID), "storage_corrupt");
    await rm(layout.spaceFile(BUILTIN_PEOPLE_SPACE_ID));

    await expect(spaces.list()).resolves.toEqual([]);
  });

  it("stores completed operations at the root, validates scope, and reads tombstones", async () => {
    const root = await createRoot();
    const layout = new Layout(root);
    const spaces = new FileSpaceStore(layout);
    const subjects = new FileSubjectStore(layout, spaces);
    const operations = new FileOperationStore(layout, subjects);
    await spaces.write(makeSpace());
    await subjects.write(makeSubject());

    const operation = makeCreateOperation();
    await operations.write(operation);
    await operations.write(operation);
    await expect(operations.read(REQUEST_ID)).resolves.toEqual(operation);
    await expect(operations.readOptional(THIRD_REQUEST_ID)).resolves.toBeUndefined();
    const badScope = sealFact<OperationRecord<"subjects.create">>({
      ...operation,
      scope: { kind: "global" },
    });
    await expectCode(operations.write(badScope), "storage_corrupt");

    const globalOperation = sealFact<OperationRecord<"library.rebuild">>({
      schemaVersion: 1,
      recordKind: "completed",
      requestId: THIRD_REQUEST_ID,
      method: "library.rebuild",
      scope: { kind: "global" },
      actor: { kind: "system", id: "step5-store-test" },
      inputChecksum: computeFactChecksum({ method: "library.rebuild" }),
      result: { subjects: 1, jobs: 0, relations: 0, rebuiltAt: AT },
      completedAt: AT,
    });
    await operations.write(globalOperation);
    await expect(operations.read(THIRD_REQUEST_ID)).resolves.toEqual(globalOperation);

    const tombstone = sealFact<OperationTombstoneRecord>({
      schemaVersion: 1,
      recordKind: "tombstone",
      requestId: OTHER_REQUEST_ID,
      method: "subjects.purge",
      scope: { kind: "subject", subjectId: SUBJECT_ID },
      inputChecksum: operation.inputChecksum,
      removedAt: LATER,
      reason: "subject_purged",
    });
    await createFactFile<OperationFact>(
      root,
      layout.operationFile(OTHER_REQUEST_ID),
      tombstone,
      OPERATION_FACT_SCHEMA,
    );
    await expect(operations.read(OTHER_REQUEST_ID)).resolves.toEqual(tombstone);
    await rm(layout.subjectDirectory(SUBJECT_ID), { recursive: true });
    await expect(operations.read(OTHER_REQUEST_ID)).resolves.toEqual(tombstone);
  });

  it("validates the immutable current-version baseline record and manifest", async () => {
    const root = await createRoot();
    const layout = new Layout(root);
    const spaces = new FileSpaceStore(layout);
    const subjects = new FileSubjectStore(layout, spaces);
    const materials = new FileMaterialStore(layout, subjects);
    const versions = new FileVersionManifestStore(layout, materials);
    await spaces.write(makeSpace());
    await subjects.write(makeSubject());
    const material = makeMaterial();
    await materials.write(material, VERSION_CONTENT);
    const valid = makeVersion(VERSION_ID, SUBJECT_ID, [entryFor(material)]);
    await createFactFile(
      root,
      layout.versionFile(SUBJECT_ID, VERSION_ID),
      valid.version,
      VERSION_SCHEMA,
    );
    await createFactFile(
      root,
      layout.versionMaterialManifestFile(SUBJECT_ID, VERSION_ID),
      valid.manifest,
      VERSION_MANIFEST_SCHEMA,
    );
    await expect(versions.read(SUBJECT_ID, VERSION_ID)).resolves.toEqual(valid);

    const wrongCount = sealFact<VersionRecord>({ ...valid.version, materialCount: 0 });
    await replaceFactFile(
      root,
      layout.versionFile(SUBJECT_ID, VERSION_ID),
      wrongCount,
      VERSION_SCHEMA,
    );
    await expectCode(versions.read(SUBJECT_ID, VERSION_ID), "storage_corrupt");

    const wrongHash = sealFact<VersionRecord>({ ...valid.version, materialSetHash: SET_HASH });
    await replaceFactFile(
      root,
      layout.versionFile(SUBJECT_ID, VERSION_ID),
      wrongHash,
      VERSION_SCHEMA,
    );
    await expectCode(versions.read(SUBJECT_ID, VERSION_ID), "storage_corrupt");

    const wrongSubject = sealFact<VersionRecord>({
      ...valid.version,
      subjectId: OTHER_SUBJECT_ID,
    });
    await replaceFactFile(
      root,
      layout.versionFile(SUBJECT_ID, VERSION_ID),
      wrongSubject,
      VERSION_SCHEMA,
    );
    await expectCode(versions.read(SUBJECT_ID, VERSION_ID), "storage_corrupt");
    await replaceFactFile(
      root,
      layout.versionFile(SUBJECT_ID, VERSION_ID),
      valid.version,
      VERSION_SCHEMA,
    );
    await rm(layout.versionMaterialManifestFile(SUBJECT_ID, VERSION_ID));
    await expectCode(versions.read(SUBJECT_ID, VERSION_ID), "storage_corrupt");

    for (const mismatch of [
      { ...entryFor(material), contentDigest: VERSION_ENTRY.contentDigest },
      { ...entryFor(material), provenanceDigest: VERSION_ENTRY.provenanceDigest },
    ]) {
      const mismatched = makeVersion(VERSION_ID, SUBJECT_ID, [mismatch]);
      await replaceFactFile(
        root,
        layout.versionFile(SUBJECT_ID, VERSION_ID),
        mismatched.version,
        VERSION_SCHEMA,
      );
      await replaceFactFile(
        root,
        layout.versionMaterialManifestFile(SUBJECT_ID, VERSION_ID),
        mismatched.manifest,
        VERSION_MANIFEST_SCHEMA,
      );
      await expectCode(versions.read(SUBJECT_ID, VERSION_ID), "storage_corrupt");
    }

    await replaceFactFile(
      root,
      layout.versionFile(SUBJECT_ID, VERSION_ID),
      valid.version,
      VERSION_SCHEMA,
    );
    await replaceFactFile(
      root,
      layout.versionMaterialManifestFile(SUBJECT_ID, VERSION_ID),
      valid.manifest,
      VERSION_MANIFEST_SCHEMA,
    );
    await rm(layout.materialDirectory(SUBJECT_ID, material.id), { recursive: true });
    await expectCode(versions.read(SUBJECT_ID, VERSION_ID), "storage_corrupt");

    const other = makeVersion(OTHER_VERSION_ID);
    const wrongPathId = sealFact<VersionRecord>({ ...other.version, id: VERSION_ID });
    await createFactFile(
      root,
      layout.versionFile(SUBJECT_ID, OTHER_VERSION_ID),
      wrongPathId,
      VERSION_SCHEMA,
    );
    await expectCode(versions.read(SUBJECT_ID, OTHER_VERSION_ID), "storage_corrupt");
  });
});
