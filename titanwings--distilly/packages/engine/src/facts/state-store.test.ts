import { DistillyError, versionIdSchema } from "@distilly/protocol";
import type { DistillyErrorCode, SubjectStateRecord, VersionId } from "@distilly/protocol";
import { rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { sealFact } from "./checksum.js";
import { hashMaterialSet } from "./digests.js";
import { FileStateStore } from "./state-store.js";
import {
  createVersionFixtureHarness,
  makeVersionArtifacts,
  publishVersionArtifacts,
  TEST_SUBJECT_ID,
} from "./version-fixture.test-support.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const expectCode = async (promise: Promise<unknown>, code: DistillyErrorCode): Promise<void> => {
  try {
    await promise;
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(DistillyError);
    expect(error).toMatchObject({ code });
  }
};

const stateWithPointers = (
  items: SubjectStateRecord["materialManifest"],
  generation: number,
  currentVersionId?: VersionId,
  suspendedVersionId?: VersionId,
): SubjectStateRecord =>
  sealFact<SubjectStateRecord>({
    schemaVersion: 2,
    subjectId: TEST_SUBJECT_ID,
    generation,
    materialSetHash: hashMaterialSet(items),
    materialManifest: items,
    ...(currentVersionId === undefined ? {} : { currentVersionId }),
    ...(suspendedVersionId === undefined ? {} : { suspendedVersionId }),
  });

describe("FileStateStore version pointers", () => {
  it("accepts complete current and suspended versions with exact parent lineage", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const current = makeVersionArtifacts(harness);
    const suspended = makeVersionArtifacts(harness, {
      generation: 2,
      parentId: current.version.id,
      disposition: "suspended",
      claimTextSuffix: " Candidate",
    });
    await publishVersionArtifacts(harness, current);
    await publishVersionArtifacts(harness, suspended);
    const states = new FileStateStore(harness.layout, harness.subjects, harness.materials);
    const state = stateWithPointers(
      suspended.manifest.items,
      2,
      current.version.id,
      suspended.version.id,
    );

    await states.write(state);
    await expect(states.read(TEST_SUBJECT_ID)).resolves.toEqual(state);
  });

  it("rejects a missing or incomplete current version", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const artifacts = makeVersionArtifacts(harness);
    const states = new FileStateStore(harness.layout, harness.subjects, harness.materials);
    const missingVersionId = versionIdSchema.parse(`version_${"f".repeat(64)}`);
    await expectCode(
      states.write(stateWithPointers(artifacts.manifest.items, 1, missingVersionId)),
      "storage_corrupt",
    );

    await publishVersionArtifacts(harness, artifacts);
    await rm(harness.layout.versionPromptFile(TEST_SUBJECT_ID, artifacts.version.id));
    await expectCode(
      states.write(stateWithPointers(artifacts.manifest.items, 1, artifacts.version.id)),
      "storage_corrupt",
    );
  });

  it("rejects a suspended version whose immutable parent differs from current", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const current = makeVersionArtifacts(harness);
    const suspended = makeVersionArtifacts(harness, {
      generation: 1,
      disposition: "suspended",
      claimTextSuffix: " Unparented",
    });
    await publishVersionArtifacts(harness, current);
    await publishVersionArtifacts(harness, suspended);
    const states = new FileStateStore(harness.layout, harness.subjects, harness.materials);

    await expectCode(
      states.write(
        stateWithPointers(current.manifest.items, 1, current.version.id, suspended.version.id),
      ),
      "storage_corrupt",
    );
  });

  it("requires suspended pointers to preserve creation disposition but permits promotion", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const promoted = makeVersionArtifacts(harness, {
      disposition: "suspended",
      claimTextSuffix: " Promoted",
    });
    const currentCreatedCandidate = makeVersionArtifacts(harness, {
      parentId: promoted.version.id,
      claimTextSuffix: " Wrong disposition",
    });
    await publishVersionArtifacts(harness, promoted);
    await publishVersionArtifacts(harness, currentCreatedCandidate);
    const states = new FileStateStore(harness.layout, harness.subjects, harness.materials);

    const promotedState = stateWithPointers(promoted.manifest.items, 1, promoted.version.id);
    await states.write(promotedState);
    await expect(states.read(TEST_SUBJECT_ID)).resolves.toEqual(promotedState);

    await expectCode(
      states.write(
        stateWithPointers(
          currentCreatedCandidate.manifest.items,
          1,
          promoted.version.id,
          currentCreatedCandidate.version.id,
        ),
      ),
      "storage_corrupt",
    );
  });

  it("rejects version manifests outside state membership and versions newer than state", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const newer = makeVersionArtifacts(harness, { generation: 2, claimTextSuffix: " Newer" });
    await publishVersionArtifacts(harness, newer);
    const states = new FileStateStore(harness.layout, harness.subjects, harness.materials);

    await expectCode(
      states.write(stateWithPointers(newer.manifest.items, 1, newer.version.id)),
      "storage_corrupt",
    );
    const empty = sealFact<SubjectStateRecord>({
      schemaVersion: 2,
      subjectId: TEST_SUBJECT_ID,
      generation: 0,
      materialManifest: [],
      currentVersionId: newer.version.id,
    });
    await expectCode(states.write(empty), "storage_corrupt");
  });

  it("rejects state reads when a pointed renderer artifact drifts", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const artifacts = makeVersionArtifacts(harness);
    await publishVersionArtifacts(harness, artifacts);
    const states = new FileStateStore(harness.layout, harness.subjects, harness.materials);
    const state = stateWithPointers(artifacts.manifest.items, 1, artifacts.version.id);
    await states.write(state);
    await writeFile(
      harness.layout.versionCoreProfileFile(TEST_SUBJECT_ID, artifacts.version.id, "identity"),
      "drifted\n",
    );

    await expectCode(states.read(TEST_SUBJECT_ID), "storage_corrupt");
  });
});
