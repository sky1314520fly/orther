import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

import { createCodexHostBinding } from "@distilly/bindings";
import {
  BUILTIN_HOSTS,
  contentDigestSchema,
  facetPathSchema,
  isoDateTimeSchema,
  requestIdSchema,
  type CommitInput,
  type RequestId,
} from "@distilly/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { openPreviewMcpApplication, type PreviewMcpApplication } from "./preview.js";

const CAPACITY = {
  maximumInputTokens: 4_194_304,
  maximumToolResultBytes: 4_194_304,
  source: "binding_fixture" as const,
};
const IDENTITY = facetPathSchema.parse("identity");
let requestCounter = 1;
const roots: string[] = [];
const applications: PreviewMcpApplication[] = [];
const execFileAsync = promisify(execFile);

const request = (): RequestId =>
  requestIdSchema.parse(`req_${(requestCounter++).toString(16).padStart(32, "0")}`);

const open = async (root: string): Promise<PreviewMcpApplication> => {
  const binding = createCodexHostBinding({
    homeDirectory: root,
    executablePath: "/usr/bin/false",
    forms: { ask: () => Promise.reject(new Error("Forms are not used by this fixture.")) },
    provider: { load: () => Promise.reject(new Error("Preflight is owned by the caller.")) },
    release: {
      releaseVersion: "0.1.0-preview.1",
      wireMajor: 3,
      canonicalSkillDigest: contentDigestSchema.parse(`sha256_${"a".repeat(64)}`),
    },
    now: () => new Date("2026-08-31T20:00:00.000Z"),
  });
  const application = await openPreviewMcpApplication({
    root,
    binding,
    hostContext: { sessionId: "preview-test-session", environment: "ci" },
    capacity: CAPACITY,
    panel: {
      assetsDir: resolve("packages/panel/web"),
      port: 43_191,
    },
  });
  applications.push(application);
  return application;
};

const close = async (application: PreviewMcpApplication): Promise<void> => {
  await application.close();
  const index = applications.indexOf(application);
  if (index !== -1) applications.splice(index, 1);
};

afterEach(async () => {
  await Promise.allSettled(applications.splice(0).map((application) => application.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Developer Preview MCP application", () => {
  it("shares one real local authority across Distilly, Person, review, and reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "distilly-preview-mcp-"));
    roots.push(root);
    const first = await open(root);
    const person = await first.distilly.create(
      { displayName: "Mira Chen", aliases: ["Mira"], identityHints: [] },
      { requestId: request() },
    );
    const ingested = await person.ingest(
      [
        {
          clientRef: "mira-note",
          kind: "document",
          content: "Mira builds reliable local-first systems and explains evidence precisely.",
          source: {
            medium: "document",
            access: "private",
            capturedAt: isoDateTimeSchema.parse("2026-08-31T20:00:00.000Z"),
          },
          derivation: { kind: "native_text" },
        },
      ],
      { enqueue: "now" },
      { requestId: request() },
    );
    if (ingested.job === undefined) throw new Error("Expected immediate distillation work.");
    const briefing = await first.distilly.brief(
      { jobId: ingested.job.id },
      { requestId: request() },
    );
    const materialRef = briefing.materials[0]?.ref;
    if (materialRef === undefined) throw new Error("Expected one briefing material.");
    const patch: CommitInput["patch"] = {
      operations: [
        {
          op: "add",
          claim: {
            facet: IDENTITY,
            text: "Mira builds reliable local-first systems.",
            evidence: [
              {
                kind: "brief_material",
                materialRef,
                quote: "Mira builds reliable local-first systems",
              },
            ],
          },
        },
      ],
    };
    const committed = await first.distilly.commit(
      {
        jobId: briefing.job.id,
        generation: briefing.job.generation,
        leaseId: briefing.lease.id,
        briefContractDigest: briefing.contract.digest,
        materialSetHash: briefing.job.materialSetHash,
        patch,
      },
      { requestId: request() },
    );
    expect(committed.kind).toBe("current");
    await expect(person.get()).resolves.toMatchObject({ subjectId: person.id });
    await expect(person.prompt()).resolves.toContain("Mira builds reliable local-first systems");

    const correction = await person.correct(
      { text: "Mira prioritizes auditable local-first systems." },
      { requestId: request() },
    );
    expect(correction.kind).toBe("current");
    await expect(person.prompt()).resolves.toContain(
      "Mira prioritizes auditable local-first systems.",
    );

    const installRequestId = request();
    const installed = await person.install(BUILTIN_HOSTS.codex, undefined, {
      requestId: installRequestId,
    });
    await expect(
      person.install(BUILTIN_HOSTS.codex, undefined, { requestId: installRequestId }),
    ).resolves.toEqual(installed);
    await expect(
      person.install(
        BUILTIN_HOSTS.codex,
        { destination: join(root, "another-person-skill") },
        { requestId: installRequestId },
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(readdir(installed.path).then((entries) => entries.sort())).resolves.toEqual([
      ".distilly-install.json",
      "SKILL.md",
    ]);
    const installedSkill = await readFile(join(installed.path, "SKILL.md"), "utf8");
    expect(installedSkill).toContain("Mira prioritizes auditable local-first systems.");
    expect(installedSkill).not.toContain("mira-note");

    await close(first);
    const codexExecutable = process.env.DISTILLY_VERIFY_CODEX_DISCOVERY;
    if (codexExecutable !== undefined) {
      const discovered = await execFileAsync(
        codexExecutable,
        ["debug", "prompt-input", "Use the installed Distilly person Profile."],
        {
          cwd: root,
          env: {
            ...process.env,
            HOME: root,
            USERPROFILE: root,
            CODEX_HOME: join(root, ".codex"),
          },
          maxBuffer: 4 * 1_024 * 1_024,
        },
      );
      const promptInput = JSON.parse(discovered.stdout) as unknown;
      expect(JSON.stringify(promptInput)).toContain(basename(installed.path));
      expect(JSON.stringify(promptInput)).toContain(installed.path);
    }
    const reopened = await open(root);
    const resolution = await reopened.distilly.resolve({
      selector: { kind: "id", subjectId: person.id },
    });
    expect(resolution.kind).toBe("found");
    await expect(reopened.distilly.person(person.id).prompt()).resolves.toContain(
      "Mira prioritizes auditable local-first systems.",
    );
    await expect(readdir(installed.path).then((entries) => entries.sort())).resolves.toEqual([
      ".distilly-install.json",
      "SKILL.md",
    ]);

    const reopenedPerson = reopened.distilly.person(person.id);
    const exportPath = join(root, "exports", "mira.md");
    const exportRequestId = request();
    const exported = await reopenedPerson.export(
      BUILTIN_HOSTS.codex,
      { destination: exportPath },
      { requestId: exportRequestId },
    );
    await expect(
      reopenedPerson.export(
        BUILTIN_HOSTS.codex,
        { destination: exportPath },
        { requestId: exportRequestId },
      ),
    ).resolves.toEqual(exported);
    await expect(readFile(exportPath, "utf8")).resolves.toContain(
      "Mira prioritizes auditable local-first systems.",
    );

    await reopenedPerson.uninstall(installed, { requestId: request() });
    await expect(readdir(installed.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for its active stdio transport before releasing the local root", async () => {
    const root = await mkdtemp(join(tmpdir(), "distilly-preview-mcp-close-"));
    roots.push(root);
    const first = await open(root);
    const serving = first.runStdio();

    await close(first);
    await expect(serving).resolves.toBeUndefined();

    const reopened = await open(root);
    await expect(reopened.distilly.list()).resolves.toMatchObject({ items: [] });
  });
});
