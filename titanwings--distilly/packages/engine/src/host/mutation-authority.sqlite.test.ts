import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  BUILTIN_HOSTS,
  contentDigestSchema,
  requestIdSchema,
  versionIdSchema,
} from "@distilly/protocol";
import type {
  ActorContext,
  CoreEngineClient,
  ExportRef,
  HostExportInput,
  InstallInput,
  InstallRef,
  IsoDateTime,
  RequestId,
  SubjectId,
} from "@distilly/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../facts/canonical-json.js";
import { openPreviewEngine, type PreviewEngineRuntime } from "../preview.js";

const CODEX_HOST = BUILTIN_HOSTS.codex;
const HOST_ACTOR: ActorContext = { kind: "host", id: "codex-preview", host: CODEX_HOST };
const VERSION_ID = versionIdSchema.parse(`version_${"a".repeat(64)}`);
const CONTENT_DIGEST = contentDigestSchema.parse(`sha256_${"b".repeat(64)}`);
const INSTALLED_AT = "2026-08-31T08:00:00.000Z" as IsoDateTime;

const roots: string[] = [];
const runtimes: PreviewEngineRuntime[] = [];
let requestCounter = 1;

const request = (): RequestId =>
  requestIdSchema.parse(`req_${(requestCounter++).toString(16).padStart(32, "0")}`);

const mutation = (requestId = request()) => ({ requestId });

interface Harness {
  readonly root: string;
  readonly runtime: PreviewEngineRuntime;
  readonly client: CoreEngineClient;
  readonly subjectId: SubjectId;
}

const openHarness = async (): Promise<Harness> => {
  const root = await mkdtemp(join(tmpdir(), "distilly-host-authority-"));
  roots.push(root);
  const runtime = await openPreviewEngine({ root });
  runtimes.push(runtime);
  const client = await runtime.connect({ actor: { kind: "sdk", id: "host-authority-test" } });
  const subject = await client.call("subjects.create", { displayName: "Ada" }, mutation());
  return { root, runtime, client, subjectId: subject.id };
};

const installInput = (subjectId: SubjectId, destination = "/tmp/distilly/ada"): InstallInput => ({
  subjectId,
  host: CODEX_HOST,
  options: { versionId: VERSION_ID, destination },
});

const installResult = (subjectId: SubjectId, overrides: Partial<InstallRef> = {}): InstallRef => ({
  id: "install-ada-codex",
  host: CODEX_HOST,
  subjectId,
  versionId: VERSION_ID,
  path: "/tmp/distilly/ada",
  contentDigest: CONTENT_DIGEST,
  installedAt: INSTALLED_AT,
  ...overrides,
});

const exportResult = (subjectId: SubjectId): ExportRef => ({
  host: CODEX_HOST,
  subjectId,
  versionId: VERSION_ID,
  path: "/tmp/distilly/ada.md",
  contentDigest: CONTENT_DIGEST,
});

const operationRows = (root: string): readonly Readonly<Record<string, unknown>>[] => {
  const database = new DatabaseSync(join(root, "store.sqlite3"), { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT request_id, method, scope_subject_id, result_json
         FROM operations
         WHERE method LIKE 'hosts.%'
         ORDER BY request_id`,
      )
      .all();
  } finally {
    database.close();
  }
};

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("SQLite Preview host mutation authority", () => {
  it("records, exactly replays, and conflicts all three host mutation methods", async () => {
    const { root, runtime, subjectId } = await openHarness();
    const authority = runtime.hostMutations;
    const installParams = installInput(subjectId);
    const installed = installResult(subjectId);
    const installMutation = mutation();
    const exportParams: HostExportInput = {
      subjectId,
      host: CODEX_HOST,
      options: {
        destination: "/tmp/distilly/ada.md",
        versionId: VERSION_ID,
        overwrite: false,
      },
    };
    const exported = exportResult(subjectId);
    const exportMutation = mutation();
    const uninstallParams = { install: installed };
    const uninstallMutation = mutation();

    await expect(
      authority.complete("hosts.install", installParams, HOST_ACTOR, installMutation, installed),
    ).resolves.toEqual(installed);
    await expect(
      authority.complete("hosts.export", exportParams, HOST_ACTOR, exportMutation, exported),
    ).resolves.toEqual(exported);
    await expect(
      authority.complete("hosts.uninstall", uninstallParams, HOST_ACTOR, uninstallMutation, null),
    ).resolves.toBeNull();

    await expect(
      authority.replay("hosts.install", installParams, HOST_ACTOR, installMutation),
    ).resolves.toEqual(installed);
    await expect(
      authority.replay("hosts.export", exportParams, HOST_ACTOR, exportMutation),
    ).resolves.toEqual(exported);
    await expect(
      authority.replay("hosts.uninstall", uninstallParams, HOST_ACTOR, uninstallMutation),
    ).resolves.toBeNull();

    await expect(
      authority.replay(
        "hosts.install",
        installInput(subjectId, "/tmp/distilly/changed"),
        HOST_ACTOR,
        installMutation,
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      authority.replay(
        "hosts.export",
        {
          ...exportParams,
          options: { ...exportParams.options, destination: "/tmp/distilly/changed.md" },
        },
        HOST_ACTOR,
        exportMutation,
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      authority.replay(
        "hosts.uninstall",
        { install: { ...installed, path: "/tmp/distilly/changed" } },
        HOST_ACTOR,
        uninstallMutation,
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    expect(operationRows(root)).toEqual([
      {
        request_id: installMutation.requestId,
        method: "hosts.install",
        scope_subject_id: subjectId,
        result_json: canonicalJson(installed),
      },
      {
        request_id: exportMutation.requestId,
        method: "hosts.export",
        scope_subject_id: subjectId,
        result_json: canonicalJson(exported),
      },
      {
        request_id: uninstallMutation.requestId,
        method: "hosts.uninstall",
        scope_subject_id: subjectId,
        result_json: "null",
      },
    ]);
  });

  it("strictly rejects malformed or request-inconsistent host results before recording", async () => {
    const { root, runtime, subjectId } = await openHarness();
    const authority = runtime.hostMutations;

    await expect(
      authority.complete("hosts.install", installInput(subjectId), HOST_ACTOR, mutation(), {
        ...installResult(subjectId),
        host: BUILTIN_HOSTS.claudeCode,
      }),
    ).rejects.toMatchObject({ code: "invalid_input", fieldPath: "result" });
    await expect(
      authority.complete(
        "hosts.export",
        {
          subjectId,
          host: CODEX_HOST,
          options: { destination: "/tmp/distilly/ada.md", versionId: VERSION_ID },
        },
        HOST_ACTOR,
        mutation(),
        { ...exportResult(subjectId), subjectId: `subject_${"f".repeat(32)}` as SubjectId },
      ),
    ).rejects.toMatchObject({ code: "invalid_input", fieldPath: "result" });
    await expect(
      authority.complete("hosts.install", installInput(subjectId), HOST_ACTOR, mutation(), {
        host: CODEX_HOST,
      } as never),
    ).rejects.toMatchObject({ code: "invalid_input", fieldPath: "result" });

    const installed = installResult(subjectId);
    const installMutation = mutation();
    await authority.complete(
      "hosts.install",
      installInput(subjectId),
      HOST_ACTOR,
      installMutation,
      installed,
    );
    await expect(
      authority.complete(
        "hosts.uninstall",
        { install: installed },
        HOST_ACTOR,
        mutation(),
        {} as never,
      ),
    ).rejects.toMatchObject({ code: "invalid_input", fieldPath: "result" });

    expect(operationRows(root)).toEqual([
      {
        request_id: installMutation.requestId,
        method: "hosts.install",
        scope_subject_id: subjectId,
        result_json: canonicalJson(installed),
      },
    ]);
  });

  it("rejects a forged uninstall reference before authorizing any external path effect", async () => {
    const { root, runtime, subjectId } = await openHarness();
    const authority = runtime.hostMutations;
    const forged = installResult(subjectId, {
      id: "forged-install",
      path: "/tmp/unowned-path",
    });
    const uninstallMutation = mutation();

    await expect(
      authority.replay("hosts.uninstall", { install: forged }, HOST_ACTOR, uninstallMutation),
    ).rejects.toMatchObject({
      code: "invalid_input",
      fieldPath: "params.install",
    });
    await expect(
      authority.complete(
        "hosts.uninstall",
        { install: forged },
        HOST_ACTOR,
        uninstallMutation,
        null,
      ),
    ).rejects.toMatchObject({
      code: "invalid_input",
      fieldPath: "params.install",
    });
    expect(operationRows(root)).toEqual([]);
  });
});
