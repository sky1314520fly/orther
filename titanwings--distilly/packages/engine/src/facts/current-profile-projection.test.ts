import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { FileCurrentProfileProjection } from "./current-profile-projection.js";
import {
  createVersionFixtureHarness,
  makeVersionArtifacts,
  publishVersionArtifacts,
  TEST_REQUEST_ID,
  TEST_SUBJECT_ID,
} from "./version-fixture.test-support.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileCurrentProfileProjection", () => {
  it("rebuilds the exact current profile and prompt from a verified immutable version", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const artifacts = makeVersionArtifacts(harness);
    await publishVersionArtifacts(harness, artifacts);
    const projection = new FileCurrentProfileProjection(harness.layout, harness.versions);

    await projection.apply(TEST_REQUEST_ID, artifacts);
    await expect(projection.readExact(artifacts)).resolves.toBeUndefined();
    await expect(
      readFile(harness.layout.currentProfileFile(TEST_SUBJECT_ID), "utf8"),
    ).resolves.toBe(artifacts.profile.rendered);
    await expect(readFile(harness.layout.currentPromptFile(TEST_SUBJECT_ID), "utf8")).resolves.toBe(
      artifacts.prompt,
    );
  });

  it("replaces the complete projection without retaining stale domain artifacts", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const first = makeVersionArtifacts(harness);
    const second = makeVersionArtifacts(harness, {
      generation: 2,
      parentId: first.version.id,
      claimTextSuffix: " Updated",
      domainRoot: "research",
    });
    await publishVersionArtifacts(harness, first);
    await publishVersionArtifacts(harness, second);
    const projection = new FileCurrentProfileProjection(harness.layout, harness.versions);
    await projection.apply(TEST_REQUEST_ID, first);

    await projection.apply(TEST_REQUEST_ID, second);
    await expect(projection.readExact(second)).resolves.toBeUndefined();
    await expect(
      readFile(harness.layout.currentDomainProfileFile(TEST_SUBJECT_ID, "research"), "utf8"),
    ).resolves.toBe(second.profile.domains.research);
    await expect(
      readFile(harness.layout.currentDomainProfileFile(TEST_SUBJECT_ID, "career"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers when a crash left only the fixed previous projection and a partial stage", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const first = makeVersionArtifacts(harness);
    const second = makeVersionArtifacts(harness, {
      generation: 2,
      parentId: first.version.id,
      claimTextSuffix: " Recovered",
    });
    await publishVersionArtifacts(harness, first);
    await publishVersionArtifacts(harness, second);
    const projection = new FileCurrentProfileProjection(harness.layout, harness.versions);
    await projection.apply(TEST_REQUEST_ID, first);

    const current = harness.layout.currentProfileDirectory(TEST_SUBJECT_ID);
    const backup = harness.layout.currentProfileBackupDirectory(
      TEST_REQUEST_ID,
      TEST_SUBJECT_ID,
      second.version.id,
    );
    const staging = harness.layout.currentProfileStagingDirectory(
      TEST_REQUEST_ID,
      TEST_SUBJECT_ID,
      second.version.id,
    );
    await rename(current, backup);
    await mkdir(staging);
    await writeFile(`${staging}/partial`, "partial");

    await projection.recover(TEST_REQUEST_ID, second);
    await expect(projection.readExact(second)).resolves.toBeUndefined();
    await expect(readFile(`${staging}/partial`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${backup}/profile.md`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("repairs a corrupt visible projection and cleans journal-owned sibling leftovers", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const artifacts = makeVersionArtifacts(harness);
    await publishVersionArtifacts(harness, artifacts);
    const projection = new FileCurrentProfileProjection(harness.layout, harness.versions);
    await projection.apply(TEST_REQUEST_ID, artifacts);
    await writeFile(harness.layout.currentProfileFile(TEST_SUBJECT_ID), "corrupt\n");

    await projection.apply(TEST_REQUEST_ID, artifacts);
    await expect(projection.readExact(artifacts)).resolves.toBeUndefined();

    const staging = harness.layout.currentProfileStagingDirectory(
      TEST_REQUEST_ID,
      TEST_SUBJECT_ID,
      artifacts.version.id,
    );
    const backup = harness.layout.currentProfileBackupDirectory(
      TEST_REQUEST_ID,
      TEST_SUBJECT_ID,
      artifacts.version.id,
    );
    await mkdir(staging);
    await mkdir(backup);
    await projection.apply(TEST_REQUEST_ID, artifacts);
    await expect(readFile(staging)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(backup)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
