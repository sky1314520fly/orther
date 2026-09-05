import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  captureAuditRefSchema,
  eventIdSchema,
  jobIdSchema,
  leaseIdSchema,
  materialIdSchema,
  requestIdSchema,
  spaceIdSchema,
  subjectIdSchema,
  versionIdSchema,
} from "@distilly/protocol";
import type { SubjectId } from "@distilly/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { CryptoIdGenerator } from "./defaults/crypto-id-generator.js";
import { SystemClock } from "./defaults/system-clock.js";
import { Layout } from "./layout.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("fact foundation defaults", () => {
  it("generates canonical cryptographic ids and UTC times", () => {
    const ids = new CryptoIdGenerator();
    expect(subjectIdSchema.parse(ids.subjectId())).toMatch(/^subject_/u);
    expect(spaceIdSchema.parse(ids.spaceId())).toMatch(/^space_/u);
    expect(jobIdSchema.parse(ids.jobId())).toMatch(/^job_/u);
    expect(leaseIdSchema.parse(ids.leaseId())).toMatch(/^lease_/u);
    expect(requestIdSchema.parse(ids.requestId())).toMatch(/^req_/u);
    expect(eventIdSchema.parse(ids.eventId())).toMatch(/^event_/u);
    expect(captureAuditRefSchema.parse(ids.captureAuditRef())).toMatch(/^capture_/u);
    expect(ids.subjectId()).not.toBe(ids.subjectId());
    expect(new SystemClock().now()).toMatch(/^\d{4}-\d{2}-\d{2}T.*\.\d{3}Z$/u);
  });

  it("constructs only validated paths inside DISTILLY_ROOT", async () => {
    const root = await mkdtemp(join(tmpdir(), "distilly-layout-"));
    roots.push(root);
    const layout = new Layout(root);
    const spaceId = spaceIdSchema.parse(`space_${"2".repeat(32)}`);
    const subjectId = subjectIdSchema.parse(`subject_${"1".repeat(32)}`);
    const materialId = materialIdSchema.parse(`mat_${"3".repeat(64)}`);
    const eventId = eventIdSchema.parse(`event_${"4".repeat(32)}`);
    const requestId = requestIdSchema.parse(`req_${"5".repeat(32)}`);
    const versionId = versionIdSchema.parse(`version_${"6".repeat(64)}`);

    const expectedPaths: readonly (readonly [string, string])[] = [
      [layout.spacesDirectory(), "spaces"],
      [layout.subjectsDirectory(), "subjects"],
      [layout.operationsDirectory(), "operations"],
      [layout.transactionsDirectory(), "transactions"],
      [layout.indexDirectory(), ".index"],
      [layout.spaceFile(spaceId), join("spaces", `${spaceId}.json`)],
      [layout.subjectDirectory(subjectId), join("subjects", subjectId)],
      [layout.subjectLock(subjectId), join("subjects", ".locks", `${subjectId}.lock`)],
      [layout.subjectFile(subjectId), join("subjects", subjectId, "subject.json")],
      [layout.stateFile(subjectId), join("subjects", subjectId, "state.json")],
      [
        layout.materialDirectory(subjectId, materialId),
        join("subjects", subjectId, "knowledge", "materials", materialId),
      ],
      [
        layout.materialFile(subjectId, materialId),
        join("subjects", subjectId, "knowledge", "materials", materialId, "material.json"),
      ],
      [
        layout.materialContentFile(subjectId, materialId),
        join("subjects", subjectId, "knowledge", "materials", materialId, "content.txt"),
      ],
      [
        layout.eventFile(subjectId, eventId),
        join("subjects", subjectId, "events", `${eventId}.json`),
      ],
      [layout.operationFile(requestId), join("operations", `${requestId}.json`)],
      [layout.requestLock(requestId), join("operations", ".locks", `${requestId}.lock`)],
      [layout.transactionFile(requestId), join("transactions", `${requestId}.json`)],
      [layout.versionsDirectory(subjectId), join("subjects", subjectId, "versions")],
      [
        layout.versionFile(subjectId, versionId),
        join("subjects", subjectId, "versions", versionId, "version.json"),
      ],
      [
        layout.versionMaterialManifestFile(subjectId, versionId),
        join("subjects", subjectId, "versions", versionId, "materials.json"),
      ],
      [
        layout.versionClaimsFile(subjectId, versionId),
        join("subjects", subjectId, "versions", versionId, "claims.json"),
      ],
      [
        layout.versionProfileFile(subjectId, versionId),
        join("subjects", subjectId, "versions", versionId, "profile", "profile.md"),
      ],
      [
        layout.versionCoreProfileFile(subjectId, versionId, "identity"),
        join("subjects", subjectId, "versions", versionId, "profile", "identity.md"),
      ],
      [
        layout.versionDomainProfileFile(subjectId, versionId, "career"),
        join("subjects", subjectId, "versions", versionId, "profile", "domains", "career.md"),
      ],
      [
        layout.versionPromptFile(subjectId, versionId),
        join("subjects", subjectId, "versions", versionId, "prompt.md"),
      ],
      [layout.currentProfileFile(subjectId), join("subjects", subjectId, "profile", "profile.md")],
      [
        layout.currentCoreProfileFile(subjectId, "timeline"),
        join("subjects", subjectId, "profile", "timeline.md"),
      ],
      [
        layout.currentDomainProfileFile(subjectId, "career"),
        join("subjects", subjectId, "profile", "domains", "career.md"),
      ],
      [layout.currentPromptFile(subjectId), join("subjects", subjectId, "profile", "prompt.md")],
      [
        layout.currentProfileStagingDirectory(requestId, subjectId, versionId),
        join("subjects", subjectId, `.profile.staging.${requestId}.${versionId}`),
      ],
      [
        layout.currentProfileBackupDirectory(requestId, subjectId, versionId),
        join("subjects", subjectId, `.profile.previous.${requestId}.${versionId}`),
      ],
      [layout.libraryFile(), join(".index", "library.json")],
      [layout.libraryDirtyFile(), join(".index", "library.dirty")],
      [layout.libraryIntentFile(), join(".index", "library.intent")],
      [layout.libraryLock(), join(".index", "library.lock")],
    ];
    for (const [path, expected] of expectedPaths) {
      expect(relative(root, path)).toBe(expected);
    }

    expect(() => layout.subjectFile("subject_../../escape" as SubjectId)).toThrow();
    expect(() => layout.versionDomainProfileFile(subjectId, versionId, "a.b")).toThrow();
    expect(() => layout.currentDomainProfileFile(subjectId, "../escape")).toThrow();
    expect(() => layout.assertInside(join(root, "..", "escape"))).toThrow(/escapes/u);
  });
});
