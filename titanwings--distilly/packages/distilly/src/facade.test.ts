import { describe, expect, it, vi } from "vitest";

import type {
  CommitResult,
  EngineClient,
  EngineEvent,
  EngineMethodMap,
  HostName,
  MutationContext,
  MutationMethodName,
  QueryMethodName,
  RequestId,
  SubjectId,
  SubjectSummary,
  Unsubscribe,
  VersionId,
} from "@distilly/protocol";
import { DistillyError, installRefSchema, requestIdSchema } from "@distilly/protocol";

import { Distilly } from "./distilly.js";
import { Person } from "./person.js";

interface RecordedCall {
  readonly method: keyof EngineMethodMap;
  readonly params: unknown;
  readonly context?: MutationContext;
}

class RecordingClient implements EngineClient {
  readonly calls: RecordedCall[] = [];
  closeCalls = 0;
  readonly #results = new Map<keyof EngineMethodMap, unknown>();

  setResult<M extends keyof EngineMethodMap>(
    method: M,
    result: EngineMethodMap[M]["result"],
  ): void {
    this.#results.set(method, result);
  }

  call<M extends QueryMethodName>(
    method: M,
    params: EngineMethodMap[M]["params"],
  ): Promise<EngineMethodMap[M]["result"]>;
  call<M extends MutationMethodName>(
    method: M,
    params: EngineMethodMap[M]["params"],
    context: MutationContext,
  ): Promise<EngineMethodMap[M]["result"]>;
  call<M extends keyof EngineMethodMap>(
    method: M,
    params: EngineMethodMap[M]["params"],
    context?: MutationContext,
  ): Promise<EngineMethodMap[M]["result"]> {
    this.calls.push({ method, params, ...(context === undefined ? {} : { context }) });
    if (!this.#results.has(method)) throw new Error(`Missing test result for ${method}.`);
    return Promise.resolve(this.#results.get(method) as EngineMethodMap[M]["result"]);
  }

  watch(handler: (event: EngineEvent) => void): Promise<Unsubscribe> {
    void handler;
    return Promise.resolve(() => undefined);
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    return Promise.resolve();
  }
}

const subjectId = `subject_${"1".repeat(32)}` as SubjectId;
const versionId = `version_${"2".repeat(64)}` as VersionId;
const secondVersionId = `version_${"3".repeat(64)}` as VersionId;
const host = "codex" as HostName;
const requestId = (digit: string): RequestId => `req_${digit.repeat(32)}` as RequestId;
const subject = { id: subjectId } as SubjectSummary;
const commitResult = { kind: "current" } as CommitResult;
const purgeResult = {
  subjectId,
  logicalDeletion: "complete",
  physicalDeletion: "complete",
} as const;

describe("Distilly", () => {
  it("maps every query and creates Person handles without I/O", async () => {
    const client = new RecordingClient();
    client.setResult("subjects.list", { items: [] });
    client.setResult("subjects.resolve", { kind: "found", subject });
    client.setResult("distill.pending", []);
    client.setResult("reviews.list", { items: [] });
    const distilly = new Distilly({ client });

    const person = distilly.person(subjectId);
    expect(person).toBeInstanceOf(Person);
    expect(person.id).toBe(subjectId);
    await expect(distilly.list()).resolves.toEqual({ items: [] });
    await expect(distilly.resolve({ selector: { kind: "id", subjectId } })).resolves.toEqual({
      kind: "found",
      subject,
    });
    await expect(distilly.pending()).resolves.toEqual([]);
    await expect(distilly.reviews()).resolves.toEqual({ items: [] });

    expect(client.calls).toEqual([
      { method: "subjects.list", params: {} },
      {
        method: "subjects.resolve",
        params: { selector: { kind: "id", subjectId } },
      },
      { method: "distill.pending", params: {} },
      { method: "reviews.list", params: {} },
    ]);
  });

  it("forwards every mutation with an explicit or fresh top-level request id", async () => {
    const client = new RecordingClient();
    client.setResult("subjects.create", subject);
    client.setResult("distill.brief", { kind: "briefing" } as never);
    client.setResult("distill.renew", { id: "lease" } as never);
    client.setResult("distill.release", null);
    client.setResult("distill.commit", commitResult);
    client.setResult("versions.promote", { id: versionId } as never);
    client.setResult("versions.reject", { id: versionId } as never);
    const distilly = new Distilly({ client });

    const created = await distilly.create(
      { displayName: "Ada Lovelace" },
      { requestId: requestId("4") },
    );
    expect(created.id).toBe(subjectId);
    await distilly.brief({ jobId: `job_${"5".repeat(32)}` as never });
    await distilly.renew({
      jobId: `job_${"5".repeat(32)}`,
      leaseId: `lease_${"6".repeat(32)}`,
    } as never);
    await expect(
      distilly.release({
        jobId: `job_${"5".repeat(32)}`,
        leaseId: `lease_${"6".repeat(32)}`,
      } as never),
    ).resolves.toBeUndefined();
    await distilly.commit({ patch: { operations: [] } } as never);
    await distilly.promote({ subjectId, candidateVersionId: versionId });
    await distilly.reject({ subjectId, candidateVersionId: versionId });

    expect(client.calls[0]).toEqual({
      method: "subjects.create",
      params: { displayName: "Ada Lovelace" },
      context: { requestId: requestId("4") },
    });
    const automaticIds = client.calls
      .slice(1)
      .map((call) => requestIdSchema.parse(call.context?.requestId));
    expect(new Set(automaticIds).size).toBe(automaticIds.length);
    expect(client.calls.map((call) => call.method)).toEqual([
      "subjects.create",
      "distill.brief",
      "distill.renew",
      "distill.release",
      "distill.commit",
      "versions.promote",
      "versions.reject",
    ]);
  });

  it("closes only the injected client", async () => {
    const client = new RecordingClient();
    const distilly = new Distilly({ client });

    await distilly.close();

    expect(client.closeCalls).toBe(1);
    expect(client.calls).toEqual([]);
  });

  it("purges only through the explicit management method and preserves deletion status", async () => {
    const client = new RecordingClient();
    client.setResult("subjects.purge", purgeResult);
    const distilly = new Distilly({ client });

    await expect(
      distilly.purge({ subjectId, confirmation: "Ada Lovelace" }, { requestId: requestId("9") }),
    ).resolves.toEqual(purgeResult);

    expect(client.calls).toEqual([
      {
        method: "subjects.purge",
        params: { subjectId, confirmation: "Ada Lovelace" },
        context: { requestId: requestId("9") },
      },
    ]);
  });

  it.each([undefined, {}])(
    "fails before client I/O when Web Crypto is unavailable or incomplete",
    async (crypto) => {
      const client = new RecordingClient();
      const distilly = new Distilly({ client });
      vi.stubGlobal("crypto", crypto);

      try {
        await expect(
          distilly.brief({ jobId: `job_${"5".repeat(32)}` as never }),
        ).rejects.toMatchObject({ code: "host_unsupported", retryable: false });
        expect(client.calls).toEqual([]);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});

describe("Person", () => {
  it("can be constructed directly over the same injected client contract", () => {
    const client = new RecordingClient();

    const person = new Person(client, subjectId);

    expect(person.id).toBe(subjectId);
    expect(client.calls).toEqual([]);
  });

  it("maps every subject-scoped query to the exact EngineMethodMap params", async () => {
    const client = new RecordingClient();
    client.setResult("profiles.get", { subjectId, versionId } as never);
    client.setResult("profiles.prompt", "prompt\n");
    client.setResult("profiles.status", { subject } as never);
    client.setResult("versions.list", { items: [] });
    client.setResult("versions.diff", { added: [], removed: [] } as never);
    client.setResult("versions.lineage", { items: [] });
    const person = new Distilly({ client }).person(subjectId);

    await person.get({ versionId });
    await person.prompt();
    await person.status();
    await person.versions({ cursor: "versions-next", limit: 5 });
    await person.diff(versionId, secondVersionId);
    await person.lineage({ cursor: "next", limit: 7 });

    expect(client.calls).toEqual([
      { method: "profiles.get", params: { subjectId, versionId } },
      { method: "profiles.prompt", params: { subjectId } },
      { method: "profiles.status", params: { subjectId } },
      {
        method: "versions.list",
        params: { subjectId, cursor: "versions-next", limit: 5 },
      },
      {
        method: "versions.diff",
        params: { subjectId, before: versionId, after: secondVersionId },
      },
      {
        method: "versions.lineage",
        params: { subjectId, cursor: "next", limit: 7 },
      },
    ]);
  });

  it("maps every subject-scoped mutation and discards null results", async () => {
    const client = new RecordingClient();
    client.setResult("materials.ingest", { kind: "unchanged" } as never);
    client.setResult("materials.ingestFiles", { items: [] } as never);
    client.setResult("profiles.correct", commitResult);
    client.setResult("distill.redistill", { id: "job" } as never);
    client.setResult("versions.rollback", { id: versionId } as never);
    const installRef = installRefSchema.parse({
      id: "install",
      host,
      subjectId,
      versionId,
      path: "/projection/install",
      contentDigest: `sha256_${"4".repeat(64)}`,
      installedAt: "2026-08-21T00:00:00.000Z",
    });
    client.setResult("hosts.install", installRef);
    client.setResult("hosts.uninstall", null);
    client.setResult("hosts.export", { path: "/export" } as never);
    client.setResult("subjects.archive", null);
    const person = new Distilly({ client }).person(subjectId);
    const material = { clientRef: "m1" } as never;

    await person.ingest([material], { enqueue: "now" }, { requestId: requestId("0") });
    await person.ingestFiles(
      ["/tmp/source.md"],
      { enqueue: "auto", sensitivity: "shareable" },
      { requestId: requestId("1") },
    );
    await person.correct({ text: "Correction." }, { requestId: requestId("2") });
    await person.redistill({ mode: "full", reason: "Re-evaluate." }, { requestId: requestId("3") });
    await person.rollback({ versionId, reason: "Restore." }, { requestId: requestId("4") });
    await person.install(host, { versionId }, { requestId: requestId("5") });
    await expect(
      person.uninstall(installRef, { requestId: requestId("6") }),
    ).resolves.toBeUndefined();
    await person.export(
      host,
      { destination: "/export", overwrite: true },
      { requestId: requestId("7") },
    );
    await expect(person.archive({ requestId: requestId("8") })).resolves.toBeUndefined();

    expect(client.calls).toEqual([
      {
        method: "materials.ingest",
        params: {
          subject: { kind: "existing", subjectId },
          materials: [material],
          enqueue: "now",
        },
        context: { requestId: requestId("0") },
      },
      {
        method: "materials.ingestFiles",
        params: {
          subject: { kind: "existing", subjectId },
          paths: ["/tmp/source.md"],
          enqueue: "auto",
          sensitivity: "shareable",
        },
        context: { requestId: requestId("1") },
      },
      {
        method: "profiles.correct",
        params: { subjectId, correction: { text: "Correction." } },
        context: { requestId: requestId("2") },
      },
      {
        method: "distill.redistill",
        params: { subjectId, mode: "full", reason: "Re-evaluate." },
        context: { requestId: requestId("3") },
      },
      {
        method: "versions.rollback",
        params: { subjectId, targetVersionId: versionId, reason: "Restore." },
        context: { requestId: requestId("4") },
      },
      {
        method: "hosts.install",
        params: { subjectId, host, options: { versionId } },
        context: { requestId: requestId("5") },
      },
      {
        method: "hosts.uninstall",
        params: { install: installRef },
        context: { requestId: requestId("6") },
      },
      {
        method: "hosts.export",
        params: { subjectId, host, options: { destination: "/export", overwrite: true } },
        context: { requestId: requestId("7") },
      },
      {
        method: "subjects.archive",
        params: { subjectId },
        context: { requestId: requestId("8") },
      },
    ]);
  });

  it("never lets cast-only fields override the bound subject", async () => {
    const client = new RecordingClient();
    client.setResult("distill.redistill", { id: "job" } as never);
    client.setResult("versions.lineage", { items: [] });
    const person = new Person(client, subjectId);
    const attackerSubjectId = `subject_${"9".repeat(32)}` as SubjectId;

    await person.redistill({
      subjectId: attackerSubjectId,
      mode: "full",
      reason: "Re-evaluate.",
      ignored: true,
    } as never);
    await person.lineage({ subjectId: attackerSubjectId, cursor: "next", ignored: true } as never);

    expect(client.calls.map(({ method, params }) => ({ method, params }))).toEqual([
      {
        method: "distill.redistill",
        params: { subjectId, mode: "full", reason: "Re-evaluate." },
      },
      { method: "versions.lineage", params: { subjectId, cursor: "next" } },
    ]);
    expect(requestIdSchema.parse(client.calls[0]?.context?.requestId)).toMatch(
      /^req_[0-9a-f]{32}$/u,
    );
    expect(client.calls[1]?.context).toBeUndefined();
  });

  it("rejects an installation owned by another subject before client I/O", async () => {
    const client = new RecordingClient();
    const person = new Person(client, subjectId);
    const otherSubjectId = `subject_${"9".repeat(32)}` as SubjectId;
    const foreignInstall = installRefSchema.parse({
      id: "install-other",
      host,
      subjectId: otherSubjectId,
      versionId,
      path: "/projection/other",
      contentDigest: `sha256_${"5".repeat(64)}`,
      installedAt: "2026-08-21T00:00:00.000Z",
    });

    await expect(person.uninstall(foreignInstall)).rejects.toEqual(
      new DistillyError({
        code: "invalid_input",
        message: "Install reference does not belong to this Person.",
        retryable: false,
        fieldPath: "ref.subjectId",
      }),
    );
    expect(client.calls).toEqual([]);
  });
});
