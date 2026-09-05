import { DistillyError, requestIdSchema } from "@distilly/protocol";
import type { DistillyErrorCode } from "@distilly/protocol";
import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createVersionFixtureHarness,
  makeVersionArtifacts,
  TEST_REQUEST_ID,
  TEST_SUBJECT_ID,
} from "../facts/version-fixture.test-support.js";
import { storageCorrupt } from "../internal-errors.js";
import {
  FileVersionStaging,
  legacyVersionDeletingDirectory,
  legacyVersionStagingDirectory,
  legacyVersionStagingRootDirectory,
} from "../testing/legacy-file-version-staging.test.fixture.js";
import type { VersionStagingArtifactLabel } from "../testing/legacy-file-version-staging.test.fixture.js";

const roots: string[] = [];
const OTHER_REQUEST_ID = requestIdSchema.parse(`req_${"1".repeat(32)}`);
const STAGED_ARTIFACT_LABELS = [
  "version.json",
  "materials.json",
  "claims.json",
  "profile/profile.md",
  "profile/identity.md",
  "profile/voice.md",
  "profile/psyche.md",
  "profile/relations.md",
  "profile/boundaries.md",
  "profile/texture.md",
  "profile/timeline.md",
  "profile/domains/career.md",
  "prompt.md",
] as const satisfies readonly VersionStagingArtifactLabel[];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const exists = async (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    },
  );

const expectCode = async (promise: Promise<unknown>, code: DistillyErrorCode): Promise<void> => {
  try {
    await promise;
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(DistillyError);
    expect(error).toMatchObject({ code });
  }
};

describe("FileVersionStaging", () => {
  it.each(STAGED_ARTIFACT_LABELS)(
    "leaves only its fixed partial staging directory after %s is durable",
    async (crashLabel) => {
      const harness = await createVersionFixtureHarness();
      roots.push(harness.root);
      const artifacts = makeVersionArtifacts(harness);
      const staging = legacyVersionStagingDirectory(
        harness.layout,
        TEST_REQUEST_ID,
        TEST_SUBJECT_ID,
        artifacts.version.id,
      );
      const interrupted = new FileVersionStaging(harness.layout, harness.versions, {
        afterArtifact: (label) => {
          if (label === crashLabel) throw new Error(`crash after ${label}`);
        },
      });

      await expect(interrupted.prepare(TEST_REQUEST_ID, artifacts)).rejects.toThrow(
        `crash after ${crashLabel}`,
      );

      expect(await exists(join(staging, crashLabel))).toBe(true);
      expect(
        await exists(harness.layout.versionDirectory(TEST_SUBJECT_ID, artifacts.version.id)),
      ).toBe(false);
      expect((await readdir(harness.layout.versionsDirectory(TEST_SUBJECT_ID))).sort()).toEqual([
        ".staging",
      ]);
      expect(
        (await readdir(legacyVersionStagingRootDirectory(harness.layout, TEST_SUBJECT_ID))).sort(),
      ).toEqual([basename(staging)]);

      await harness.staging.cleanup(TEST_REQUEST_ID, artifacts);
      expect(await exists(staging)).toBe(false);
    },
  );

  it("writes and verifies the complete fixed journal-owned artifact set", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const artifacts = makeVersionArtifacts(harness);

    await harness.staging.prepare(TEST_REQUEST_ID, artifacts);
    await harness.staging.prepare(TEST_REQUEST_ID, artifacts);

    await expect(harness.staging.readExact(TEST_REQUEST_ID, artifacts)).resolves.toEqual(artifacts);
    expect(
      await exists(
        legacyVersionStagingDirectory(
          harness.layout,
          TEST_REQUEST_ID,
          TEST_SUBJECT_ID,
          artifacts.version.id,
        ),
      ),
    ).toBe(true);
  });

  it("accepts an exact published target when fixed staging is already missing", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const artifacts = makeVersionArtifacts(harness);
    await harness.staging.prepare(TEST_REQUEST_ID, artifacts);
    await harness.staging.publish(TEST_REQUEST_ID, artifacts);

    const staging = legacyVersionStagingDirectory(
      harness.layout,
      TEST_REQUEST_ID,
      TEST_SUBJECT_ID,
      artifacts.version.id,
    );
    expect(await exists(staging)).toBe(false);
    await expect(harness.staging.publish(TEST_REQUEST_ID, artifacts)).resolves.toBeUndefined();
    await expect(harness.versions.read(TEST_SUBJECT_ID, artifacts.version.id)).resolves.toEqual(
      artifacts,
    );
  });

  it("rejects an existing published target whose bytes differ from the journal payload", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const artifacts = makeVersionArtifacts(harness);
    await harness.staging.prepare(TEST_REQUEST_ID, artifacts);
    await harness.staging.publish(TEST_REQUEST_ID, artifacts);
    await writeFile(
      harness.layout.versionPromptFile(TEST_SUBJECT_ID, artifacts.version.id),
      "different\n",
    );

    await expectCode(harness.staging.publish(TEST_REQUEST_ID, artifacts), "storage_corrupt");
    expect(
      await exists(harness.layout.versionDirectory(TEST_SUBJECT_ID, artifacts.version.id)),
    ).toBe(true);
  });

  it("removes a partial fixed staging directory and makes missing cleanup idempotent", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const artifacts = makeVersionArtifacts(harness);
    const staging = legacyVersionStagingDirectory(
      harness.layout,
      TEST_REQUEST_ID,
      TEST_SUBJECT_ID,
      artifacts.version.id,
    );
    await mkdir(staging, { recursive: true });
    await writeFile(`${staging}/version.json`, "partial\n");

    await harness.staging.cleanup(TEST_REQUEST_ID, artifacts);
    await harness.staging.cleanup(TEST_REQUEST_ID, artifacts);
    expect(await exists(staging)).toBe(false);
  });

  it("removes a published target only after exact verification and an unreferenced proof", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const artifacts = makeVersionArtifacts(harness);
    await harness.staging.prepare(TEST_REQUEST_ID, artifacts);
    await harness.staging.publish(TEST_REQUEST_ID, artifacts);
    const target = harness.layout.versionDirectory(TEST_SUBJECT_ID, artifacts.version.id);

    await expectCode(
      harness.staging.removePublishedExact(TEST_REQUEST_ID, artifacts, () =>
        Promise.reject(storageCorrupt("Version remains referenced.")),
      ),
      "storage_corrupt",
    );
    expect(await exists(target)).toBe(true);

    let proved = false;
    await harness.staging.removePublishedExact(
      TEST_REQUEST_ID,
      artifacts,
      (subjectId, versionId) => {
        expect(subjectId).toBe(TEST_SUBJECT_ID);
        expect(versionId).toBe(artifacts.version.id);
        proved = true;
        return Promise.resolve();
      },
    );
    expect(proved).toBe(true);
    expect(await exists(target)).toBe(false);
    await harness.staging.removePublishedExact(TEST_REQUEST_ID, artifacts, () => Promise.resolve());
  });

  it("keeps the exact target visible when cleanup crashes before its deletion rename", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const artifacts = makeVersionArtifacts(harness);
    await harness.staging.prepare(TEST_REQUEST_ID, artifacts);
    await harness.staging.publish(TEST_REQUEST_ID, artifacts);
    const target = harness.layout.versionDirectory(TEST_SUBJECT_ID, artifacts.version.id);
    const deleting = legacyVersionDeletingDirectory(
      harness.layout,
      TEST_REQUEST_ID,
      TEST_SUBJECT_ID,
      artifacts.version.id,
    );
    const interrupted = new FileVersionStaging(harness.layout, harness.versions, {
      beforePublishedCleanupRename: () => {
        throw new Error("crash before deletion rename");
      },
    });

    await expect(
      interrupted.removePublishedExact(TEST_REQUEST_ID, artifacts, () => Promise.resolve()),
    ).rejects.toThrow("crash before deletion rename");
    expect(await exists(target)).toBe(true);
    expect(await exists(deleting)).toBe(false);

    await harness.staging.removePublishedExact(TEST_REQUEST_ID, artifacts, () => Promise.resolve());
    expect(await exists(target)).toBe(false);
    expect(await exists(deleting)).toBe(false);
  });

  it("resumes fixed-path cleanup after the deletion rename and partial recursive removal", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const artifacts = makeVersionArtifacts(harness);
    await harness.staging.prepare(TEST_REQUEST_ID, artifacts);
    await harness.staging.publish(TEST_REQUEST_ID, artifacts);
    const target = harness.layout.versionDirectory(TEST_SUBJECT_ID, artifacts.version.id);
    const deleting = legacyVersionDeletingDirectory(
      harness.layout,
      TEST_REQUEST_ID,
      TEST_SUBJECT_ID,
      artifacts.version.id,
    );
    const interrupted = new FileVersionStaging(harness.layout, harness.versions, {
      afterPublishedCleanupRename: () => {
        throw new Error("crash after deletion rename");
      },
    });

    await expect(
      interrupted.removePublishedExact(TEST_REQUEST_ID, artifacts, () => Promise.resolve()),
    ).rejects.toThrow("crash after deletion rename");
    expect(await exists(target)).toBe(false);
    expect(await exists(deleting)).toBe(true);

    await rm(`${deleting}/profile/domains`, { recursive: true, force: false });
    let reproved = false;
    await harness.staging.removePublishedExact(TEST_REQUEST_ID, artifacts, () => {
      reproved = true;
      return Promise.resolve();
    });

    expect(reproved).toBe(false);
    expect(await exists(target)).toBe(false);
    expect(await exists(deleting)).toBe(false);
  });

  it("cleans only its fixed deleting path when the version target is republished", async () => {
    const harness = await createVersionFixtureHarness();
    roots.push(harness.root);
    const artifacts = makeVersionArtifacts(harness);
    await harness.staging.prepare(TEST_REQUEST_ID, artifacts);
    await harness.staging.publish(TEST_REQUEST_ID, artifacts);
    const target = harness.layout.versionDirectory(TEST_SUBJECT_ID, artifacts.version.id);
    const deleting = legacyVersionDeletingDirectory(
      harness.layout,
      TEST_REQUEST_ID,
      TEST_SUBJECT_ID,
      artifacts.version.id,
    );
    const otherDeleting = legacyVersionDeletingDirectory(
      harness.layout,
      OTHER_REQUEST_ID,
      TEST_SUBJECT_ID,
      artifacts.version.id,
    );
    const interrupted = new FileVersionStaging(harness.layout, harness.versions, {
      afterPublishedCleanupRename: () => {
        throw new Error("crash after deletion rename");
      },
    });
    await expect(
      interrupted.removePublishedExact(TEST_REQUEST_ID, artifacts, () => Promise.resolve()),
    ).rejects.toThrow("crash after deletion rename");

    await harness.staging.prepare(OTHER_REQUEST_ID, artifacts);
    await harness.staging.publish(OTHER_REQUEST_ID, artifacts);
    await mkdir(otherDeleting);
    await writeFile(`${otherDeleting}/partial`, "other request\n");

    await harness.staging.removePublishedExact(TEST_REQUEST_ID, artifacts, () =>
      Promise.reject(storageCorrupt("must not re-prove after the rename commit point")),
    );

    expect(await exists(deleting)).toBe(false);
    expect(await exists(target)).toBe(true);
    expect(await exists(otherDeleting)).toBe(true);
    await expect(harness.versions.read(TEST_SUBJECT_ID, artifacts.version.id)).resolves.toEqual(
      artifacts,
    );
  });
});
