import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const rootModule = await import("@distilly/engine");
assert.deepEqual(Object.keys(rootModule), [], "the Engine root export must remain empty");
const previewModule = await import("@distilly/engine/preview");
assert.deepEqual(Object.keys(previewModule), ["openPreviewEngine"]);

const { PromptCatalog } = await import("../lib/distill/prompt-catalog.js");
const promptContract = await new PromptCatalog().load();
assert.equal(
  promptContract.promptVersion,
  "host-distill-v1-sha256_667e3c0cc6cc55a1ba32f0476c17af5540659267d4b66a31c4c258adc259db1e",
  "the built package must load the exact packed host-distill prompt",
);

const { createInternalEngineComposition } = await import("../lib/ingest/composition.js");

const actor = { kind: "sdk", id: "sqlite-crash-child" };
const correctionUser = { kind: "user", id: "sqlite-built-correction-user" };
const correctionHost = {
  kind: "host",
  id: "sqlite-built-correction-host",
  host: "codex",
};
const session = {
  actor,
  leaseOwner: `lease_owner_${"1".padStart(32, "0")}`,
  capacity: {
    maximumInputTokens: 4_194_304,
    maximumToolResultBytes: 4_194_304,
    source: "sdk_explicit",
  },
};
const input = {
  subject: {
    kind: "create",
    input: {
      displayName: "Ada Lovelace",
      aliases: ["Ada"],
      identityHints: [{ kind: "url", value: "https://example.com/ada" }],
    },
  },
  materials: [
    {
      clientRef: "sqlite-crash-source",
      kind: "web",
      content: "Verified SQLite crash evidence.",
      source: {
        uri: "https://example.com/sqlite-crash",
        medium: "article",
        access: "public",
        role: "reference",
        capturedAt: "2026-08-30T00:00:00.000Z",
      },
      derivation: { kind: "native_text" },
    },
  ],
  enqueue: "now",
};

const incrementalInput = (subjectId) => ({
  subject: { kind: "existing", subjectId },
  materials: [
    {
      clientRef: "sqlite-review-source",
      kind: "document",
      content: "Ada records explicit review tradeoffs with concise examples.",
      source: {
        uri: "https://example.com/sqlite-review",
        medium: "document",
        access: "public",
        role: "first_party_expression",
        capturedAt: "2026-08-30T00:01:00.000Z",
      },
      derivation: { kind: "native_text" },
    },
  ],
  enqueue: "now",
});

const requestIdFor = (digit) => `req_${digit.toString(16).padStart(32, "0")}`;

const blobPath = (root, content) => {
  const digest = `sha256_${createHash("sha256").update(content).digest("hex")}`;
  return join(
    root,
    "blobs",
    "sha256",
    digest.slice("sha256_".length, "sha256_".length + 2),
    digest,
  );
};

const inspect = (root) => {
  const database = new DatabaseSync(join(root, "store.sqlite3"), { readOnly: true });
  try {
    const count = (table) => database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;
    return {
      spaces: count("spaces"),
      subjects: count("subjects"),
      aliases: count("subject_aliases"),
      identityHints: count("subject_identity_hints"),
      subjectStates: count("subject_states"),
      blobRows: count("blobs"),
      materials: count("materials"),
      pending: count("pending_jobs"),
      leases: count("job_leases"),
      versions: count("versions"),
      versionStatuses: count("version_statuses"),
      versionMaterials: count("version_materials"),
      versionClaims: count("version_claims"),
      versionEvidence: count("version_claim_evidence"),
      currentPointers: database
        .prepare(
          "SELECT count(*) AS count FROM subject_states WHERE current_version_id IS NOT NULL",
        )
        .get().count,
      suspendedPointers: database
        .prepare(
          "SELECT count(*) AS count FROM subject_states WHERE suspended_version_id IS NOT NULL",
        )
        .get().count,
      operations: count("operations"),
      events: count("events"),
      journalMode: database.prepare("PRAGMA journal_mode").get().journal_mode,
      quickCheck: database.prepare("PRAGMA quick_check(1)").get().quick_check,
      foreignKeyFailures: database.prepare("PRAGMA foreign_key_check").all(),
    };
  } finally {
    database.close();
  }
};

const waitForOutput = async (state, expected) => {
  const deadline = Date.now() + 5_000;
  while (!state.stdout.includes(expected)) {
    if (state.child.exitCode !== null || Date.now() >= deadline) {
      throw new Error(
        `child did not print ${JSON.stringify(expected)}; stdout=${JSON.stringify(state.stdout)} stderr=${JSON.stringify(state.stderr)}`,
      );
    }
    await delay(10);
  }
};

const withDeadline = (promise, milliseconds, label) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${label} exceeded its deadline`)),
      milliseconds,
    );
    timeout.unref();
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });

const reapChild = async (state, label) => {
  if (state.child.exitCode === null && state.child.signalCode === null) {
    state.child.kill("SIGKILL");
  }
  return withDeadline(state.exited, 5_000, `${label} close`);
};

const startCrashChild = (root, phase, requestId) => {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./sqlite-crash-child.mjs", import.meta.url)), root, phase, requestId],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const state = { child, stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    state.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    state.stderr += chunk;
  });
  state.exited = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return state;
};

const runIngestChild = async (root, requestId) => {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./ingest-child.mjs", import.meta.url)), root, requestId],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    },
  );
  const state = { child, stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    state.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    state.stderr += chunk;
  });
  state.exited = new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  try {
    const exit = await withDeadline(state.exited, 15_000, "ingest child");
    assert.deepEqual(exit, { code: 0, signal: null }, `ingest child failed: ${state.stderr}`);
    assert.equal(state.stderr, "", "ingest child must not emit stderr");
    const line = state.stdout
      .trim()
      .split("\n")
      .find((candidate) => candidate.startsWith("result:"));
    assert.ok(line, `ingest child did not emit a result: ${state.stdout}`);
    return JSON.parse(line.slice("result:".length));
  } finally {
    await reapChild(state, "ingest child");
  }
};

const killAt = async (root, phase, requestId) => {
  const state = startCrashChild(root, phase, requestId);
  try {
    await waitForOutput(state, `phase:${phase}`);
    assert.equal(state.child.kill("SIGKILL"), true, `the ${phase} child must accept SIGKILL`);
    const exit = await withDeadline(state.exited, 5_000, `${phase} child`);
    if (process.platform !== "win32") {
      assert.equal(exit.signal, "SIGKILL", `the ${phase} child must die from real SIGKILL`);
    }
    assert.equal(exit.code, null, `the ${phase} child must not exit normally`);
  } finally {
    await reapChild(state, `${phase} child`);
  }
};

const roots = [];
try {
  const previewRoot = await mkdtemp(join(tmpdir(), "distilly-engine-built-preview-"));
  roots.push(previewRoot);
  const previewRuntime = await previewModule.openPreviewEngine({ root: previewRoot });
  const previewClient = await previewRuntime.connect({
    actor: { kind: "sdk", id: "engine-built-preview" },
  });
  assert.deepEqual(await previewClient.call("subjects.list", {}), { items: [] });
  await previewClient.close();
  await previewRuntime.close();

  const normalRoot = await mkdtemp(join(tmpdir(), "distilly-engine-built-sqlite-"));
  roots.push(normalRoot);
  const first = await createInternalEngineComposition({ root: normalRoot });
  const normalRequest = requestIdFor(1);
  const normalResult = await first.ingest.ingest(input, actor, { requestId: normalRequest });
  assert.equal(normalResult.kind, "ingested");
  assert.equal(normalResult.created, true);
  const briefing = await first.leases.brief({ jobId: normalResult.job.id }, session, {
    requestId: requestIdFor(2),
  });
  const commitInput = {
    jobId: briefing.job.id,
    generation: briefing.job.generation,
    leaseId: briefing.lease.id,
    briefContractDigest: briefing.contract.digest,
    materialSetHash: briefing.job.materialSetHash,
    patch: {
      operations: [
        {
          op: "add",
          claim: {
            facet: "identity",
            text: "Ada uses verified SQLite evidence.",
            evidence: [
              {
                kind: "brief_material",
                materialRef: "m001",
                quote: "Verified SQLite crash evidence",
              },
            ],
          },
        },
      ],
    },
  };
  const commitRequest = requestIdFor(3);
  const commitResult = await first.commits.commit(commitInput, session, {
    requestId: commitRequest,
  });
  assert.equal(commitResult.kind, "current");
  first.close();
  const reopened = await createInternalEngineComposition({ root: normalRoot });
  assert.deepEqual(
    await reopened.ingest.ingest(input, actor, { requestId: normalRequest }),
    normalResult,
    "reopen must replay the exact stored result",
  );
  assert.deepEqual(
    await reopened.commits.commit(commitInput, session, { requestId: commitRequest }),
    commitResult,
    "reopen must replay the exact built commit result without pending state",
  );
  reopened.close();
  assert.deepEqual(inspect(normalRoot), {
    spaces: 1,
    subjects: 1,
    aliases: 1,
    identityHints: 1,
    subjectStates: 1,
    blobRows: 2,
    materials: 1,
    pending: 0,
    leases: 0,
    versions: 1,
    versionStatuses: 1,
    versionMaterials: 1,
    versionClaims: 1,
    versionEvidence: 1,
    currentPointers: 1,
    suspendedPointers: 0,
    operations: 3,
    events: 6,
    journalMode: "wal",
    quickCheck: "ok",
    foreignKeyFailures: [],
  });

  const reviewRoot = await mkdtemp(join(tmpdir(), "distilly-engine-built-review-"));
  roots.push(reviewRoot);
  const reviewComposition = await createInternalEngineComposition({ root: reviewRoot });
  const firstIngest = await reviewComposition.ingest.ingest(input, actor, {
    requestId: requestIdFor(10),
  });
  const firstBrief = await reviewComposition.leases.brief({ jobId: firstIngest.job.id }, session, {
    requestId: requestIdFor(11),
  });
  const firstCurrent = await reviewComposition.commits.commit(
    {
      jobId: firstBrief.job.id,
      generation: firstBrief.job.generation,
      leaseId: firstBrief.lease.id,
      briefContractDigest: firstBrief.contract.digest,
      materialSetHash: firstBrief.job.materialSetHash,
      patch: commitInput.patch,
    },
    session,
    { requestId: requestIdFor(12) },
  );
  assert.equal(firstCurrent.kind, "current");
  const incremental = await reviewComposition.ingest.ingest(
    incrementalInput(firstIngest.subject.id),
    actor,
    { requestId: requestIdFor(13) },
  );
  const incrementalBrief = await reviewComposition.leases.brief(
    { jobId: incremental.job.id },
    session,
    { requestId: requestIdFor(14) },
  );
  const suspended = await reviewComposition.commits.commit(
    {
      jobId: incrementalBrief.job.id,
      generation: incrementalBrief.job.generation,
      leaseId: incrementalBrief.lease.id,
      briefContractDigest: incrementalBrief.contract.digest,
      materialSetHash: incrementalBrief.job.materialSetHash,
      baseVersionId: incrementalBrief.job.baseVersionId,
      patch: {
        operations: [
          {
            op: "add",
            claim: {
              facet: "psyche",
              text: "Ada makes review tradeoffs explicit and uses concise examples.",
              evidence: [
                {
                  kind: "brief_material",
                  materialRef: "m001",
                  quote: "explicit review tradeoffs with concise examples",
                },
              ],
            },
          },
        ],
        reviewRequest: { note: "Exercise the packaged review service." },
      },
    },
    session,
    { requestId: requestIdFor(15) },
  );
  assert.equal(suspended.kind, "suspended");
  const candidateId = suspended.candidate.id;
  assert.equal(
    (await reviewComposition.reviews.list({ subjectId: firstIngest.subject.id })).items[0]
      ?.candidate.id,
    candidateId,
    "the packaged review query must expose the active candidate",
  );
  const promoteInput = {
    subjectId: firstIngest.subject.id,
    candidateVersionId: candidateId,
    reason: "Approve the packaged review candidate.",
  };
  const promoted = await reviewComposition.review.promote(promoteInput, actor, {
    requestId: requestIdFor(16),
  });
  assert.equal(promoted.status, "current");
  const rollbackInput = {
    subjectId: firstIngest.subject.id,
    targetVersionId: firstCurrent.version.id,
    reason: "Exercise packaged immutable rollback.",
  };
  const rolledBack = await reviewComposition.review.rollback(rollbackInput, actor, {
    requestId: requestIdFor(17),
  });
  assert.equal(rolledBack.status, "current");
  assert.deepEqual(rolledBack.creation, {
    kind: "rollback",
    targetVersionId: firstCurrent.version.id,
  });
  assert.deepEqual(await reviewComposition.reviews.list({ subjectId: firstIngest.subject.id }), {
    items: [],
  });
  const directCorrectionInput = {
    subjectId: firstIngest.subject.id,
    correction: {
      text: "Ada makes packaged decisions with explicit evidence.",
      facet: "psyche.decision_style",
    },
  };
  const directCorrectionRequest = requestIdFor(18);
  const directCorrection = await reviewComposition.corrections.correct(
    directCorrectionInput,
    correctionUser,
    { requestId: directCorrectionRequest },
  );
  assert.equal(directCorrection.kind, "current");
  assert.equal(directCorrection.version.parentId, rolledBack.id);
  const relayedCorrectionInput = {
    subjectId: firstIngest.subject.id,
    correction: {
      text: "Ada states uncertainty explicitly.",
      facet: "texture.uncertainty",
    },
  };
  const relayedCorrectionRequest = requestIdFor(19);
  const relayedCorrection = await reviewComposition.corrections.correct(
    relayedCorrectionInput,
    correctionHost,
    { requestId: relayedCorrectionRequest },
  );
  assert.equal(relayedCorrection.kind, "suspended");
  assert.equal(relayedCorrection.currentVersionId, directCorrection.version.id);
  assert.deepEqual(relayedCorrection.reasons, [{ code: "relayed_correction", actorKind: "host" }]);
  reviewComposition.close();

  const reopenedReview = await createInternalEngineComposition({ root: reviewRoot });
  assert.deepEqual(
    await reopenedReview.review.promote(promoteInput, actor, { requestId: requestIdFor(16) }),
    promoted,
    "the packaged promote operation must replay exactly after rollback and reopen",
  );
  assert.deepEqual(
    await reopenedReview.review.rollback(rollbackInput, actor, { requestId: requestIdFor(17) }),
    rolledBack,
    "the packaged rollback operation must replay exactly after reopen",
  );
  assert.deepEqual(
    await reopenedReview.corrections.correct(directCorrectionInput, correctionUser, {
      requestId: directCorrectionRequest,
    }),
    directCorrection,
    "the packaged direct correction must replay exactly after reopen",
  );
  assert.deepEqual(
    await reopenedReview.corrections.correct(relayedCorrectionInput, correctionHost, {
      requestId: relayedCorrectionRequest,
    }),
    relayedCorrection,
    "the packaged relayed correction must replay exactly after reopen",
  );
  reopenedReview.close();

  const concurrentRoot = await mkdtemp(join(tmpdir(), "distilly-engine-built-concurrent-"));
  roots.push(concurrentRoot);
  const concurrent = await Promise.all([
    runIngestChild(concurrentRoot, requestIdFor(5)),
    runIngestChild(concurrentRoot, requestIdFor(6)),
  ]);
  assert.deepEqual(
    concurrent.map((result) => result.kind).sort(),
    ["already_exists", "success"],
    "two process create/ingest must publish one identity and reject the competing request",
  );
  assert.deepEqual(inspect(concurrentRoot), {
    spaces: 1,
    subjects: 1,
    aliases: 1,
    identityHints: 1,
    subjectStates: 1,
    blobRows: 1,
    materials: 1,
    pending: 1,
    leases: 0,
    versions: 0,
    versionStatuses: 0,
    versionMaterials: 0,
    versionClaims: 0,
    versionEvidence: 0,
    currentPointers: 0,
    suspendedPointers: 0,
    operations: 1,
    events: 3,
    journalMode: "wal",
    quickCheck: "ok",
    foreignKeyFailures: [],
  });

  for (const [offset, phase] of ["after_blob", "before_commit"].entries()) {
    const root = await mkdtemp(join(tmpdir(), `distilly-engine-built-${phase}-`));
    roots.push(root);
    const requestId = requestIdFor(offset + 2);
    await killAt(root, phase, requestId);
    assert.deepEqual(inspect(root), {
      spaces: 0,
      subjects: 0,
      aliases: 0,
      identityHints: 0,
      subjectStates: 0,
      blobRows: 0,
      materials: 0,
      pending: 0,
      leases: 0,
      versions: 0,
      versionStatuses: 0,
      versionMaterials: 0,
      versionClaims: 0,
      versionEvidence: 0,
      currentPointers: 0,
      suspendedPointers: 0,
      operations: 0,
      events: 0,
      journalMode: "wal",
      quickCheck: "ok",
      foreignKeyFailures: [],
    });
    const expectedContent = input.materials[0].content;
    const unreferencedBlob = blobPath(root, expectedContent);
    assert.equal(
      (await lstat(unreferencedBlob)).isFile(),
      true,
      `${phase} must leave the published blob as a regular file`,
    );
    assert.equal(
      await readFile(unreferencedBlob, "utf8"),
      expectedContent,
      `${phase} must leave exact immutable blob bytes`,
    );
    const retry = await createInternalEngineComposition({ root });
    const result = await retry.ingest.ingest(input, actor, { requestId });
    assert.equal(result.kind, "ingested", `${phase} exact retry must succeed without recovery`);
    retry.close();
  }

  const committedRoot = await mkdtemp(join(tmpdir(), "distilly-engine-built-after-commit-"));
  roots.push(committedRoot);
  const committedRequest = requestIdFor(4);
  await killAt(committedRoot, "after_commit", committedRequest);
  assert.deepEqual(inspect(committedRoot), {
    spaces: 1,
    subjects: 1,
    aliases: 1,
    identityHints: 1,
    subjectStates: 1,
    blobRows: 1,
    materials: 1,
    pending: 1,
    leases: 0,
    versions: 0,
    versionStatuses: 0,
    versionMaterials: 0,
    versionClaims: 0,
    versionEvidence: 0,
    currentPointers: 0,
    suspendedPointers: 0,
    operations: 1,
    events: 3,
    journalMode: "wal",
    quickCheck: "ok",
    foreignKeyFailures: [],
  });
  const operationDatabase = new DatabaseSync(join(committedRoot, "store.sqlite3"), {
    readOnly: true,
  });
  const storedResult = JSON.parse(
    operationDatabase
      .prepare("SELECT result_json FROM operations WHERE request_id = ?")
      .get(committedRequest).result_json,
  );
  operationDatabase.close();
  const committedReplay = await createInternalEngineComposition({ root: committedRoot });
  assert.deepEqual(
    await committedReplay.ingest.ingest(input, actor, { requestId: committedRequest }),
    storedResult,
    "post-COMMIT SIGKILL must replay exact SubjectId, MaterialId, and JobId",
  );
  committedReplay.close();
} finally {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}
