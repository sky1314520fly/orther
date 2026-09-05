import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { WIRE_LIMITS, distillyMcpTools } from "@distilly/protocol";

const rootExports = await import("@distilly/mcp");
const stdioExports = await import("@distilly/mcp/stdio");
const schemaExports = await import("@distilly/mcp/internal/schema");
assert.deepEqual(Object.keys(rootExports).sort(), ["createMcpServer"]);
assert.deepEqual(Object.keys(stdioExports).sort(), ["runStdio"]);
assert.deepEqual(Object.keys(schemaExports).sort(), [
  "advertisedToolContractDigest",
  "projectAdvertisedSchema",
]);

const HEX_32 = "a".repeat(32);
const HEX_64 = "b".repeat(64);
const REQUEST_ID = `req_${HEX_32}`;
const SUBJECT_ID = `subject_${HEX_32}`;
const JOB_ID = `job_${HEX_32}`;
const LEASE_ID = `lease_${HEX_32}`;
const MATERIAL_SET_HASH = `set_sha256_${HEX_64}`;
const BRIEF_CONTRACT_DIGEST = `brief_contract_${HEX_64}`;
const fixturePath = fileURLToPath(new URL("./stdio-fixture.mjs", import.meta.url));
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

const withTimeout = async (label, operation, milliseconds = 10_000) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const waitUntil = async (predicate) => {
  while (!predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const parseToolOutput = (index, result) => {
  const contract = distillyMcpTools[index];
  assert.ok(contract);
  const output = contract.output.parse(result.structuredContent);
  assert.deepEqual(result.content, [
    { type: "text", text: JSON.stringify(result.structuredContent) },
  ]);
  return output;
};

const ingestArguments = (content) => ({
  wireVersion: "3",
  requestId: REQUEST_ID,
  subject: { kind: "existing", subjectId: SUBJECT_ID },
  materials: [
    {
      clientRef: "source-1",
      kind: "web",
      content,
      source: {
        uri: "https://example.test/ada",
        medium: "webpage",
        access: "public",
        capturedAt: "2026-08-20T08:00:00.000Z",
      },
      derivation: { kind: "native_text" },
    },
  ],
  enqueue: "now",
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fixturePath],
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.setEncoding("utf8");
transport.stderr?.on("data", (chunk) => {
  stderr += chunk;
});

const client = new Client({ name: "distilly-built-smoke", version: "0.0.0" });
try {
  await withTimeout("stdio initialize", client.connect(transport));
  assert.deepEqual(client.getServerVersion(), {
    name: "distilly",
    version: packageJson.version,
  });

  const { tools } = await withTimeout("tools/list", client.listTools());
  assert.deepEqual(
    tools.map(({ name, title, description, inputSchema, outputSchema, annotations }) => ({
      name,
      title,
      description,
      inputSchema,
      outputSchema,
      annotations,
    })),
    distillyMcpTools.map(
      ({ name, title, description, inputSchema, outputSchema, annotations }) => ({
        name,
        title,
        description,
        inputSchema,
        outputSchema,
        annotations,
      }),
    ),
  );

  const get = parseToolOutput(
    0,
    await withTimeout(
      "distilly_get",
      client.callTool({
        name: "distilly_get",
        arguments: {
          wireVersion: "3",
          requestId: REQUEST_ID,
          action: "resolve",
          subject: { kind: "id", subjectId: SUBJECT_ID },
        },
      }),
    ),
  );
  assert.equal(get.ok && get.value.kind, "resolved");

  const ingest = parseToolOutput(
    1,
    await withTimeout(
      "distilly_ingest",
      client.callTool({
        name: "distilly_ingest",
        arguments: ingestArguments("Analytical Engine notes"),
      }),
    ),
  );
  assert.equal(ingest.ok && ingest.value.kind, "ingested");

  const pending = parseToolOutput(
    2,
    await withTimeout(
      "distilly_pending",
      client.callTool({
        name: "distilly_pending",
        arguments: { wireVersion: "3", requestId: REQUEST_ID, action: "list" },
      }),
    ),
  );
  assert.equal(pending.ok && pending.value.kind, "jobs");

  const commit = parseToolOutput(
    3,
    await withTimeout(
      "distilly_commit",
      client.callTool({
        name: "distilly_commit",
        arguments: {
          wireVersion: "3",
          requestId: REQUEST_ID,
          jobId: JOB_ID,
          generation: 1,
          leaseId: LEASE_ID,
          briefContractDigest: BRIEF_CONTRACT_DIGEST,
          materialSetHash: MATERIAL_SET_HASH,
          patch: { operations: [] },
        },
      }),
    ),
  );
  assert.equal(commit.ok && commit.value.kind, "current");

  const correct = parseToolOutput(
    4,
    await withTimeout(
      "distilly_correct",
      client.callTool({
        name: "distilly_correct",
        arguments: {
          wireVersion: "3",
          requestId: REQUEST_ID,
          subjectId: SUBJECT_ID,
          text: "The publication date should be 1843.",
        },
      }),
    ),
  );
  assert.equal(correct.ok && correct.value.kind, "suspended");

  const invalid = parseToolOutput(
    4,
    await withTimeout(
      "invalid distilly_correct",
      client.callTool({
        name: "distilly_correct",
        arguments: {
          wireVersion: "3",
          requestId: REQUEST_ID,
          subjectId: SUBJECT_ID,
          text: "é".repeat(Math.floor(WIRE_LIMITS.correctionTextBytes / 2) + 1),
        },
      }),
    ),
  );
  assert.deepEqual(invalid, {
    ok: false,
    wireVersion: "3",
    error: {
      code: "invalid_input",
      message: "The Distilly tool input is invalid.",
      retryable: false,
      fieldPath: "input",
    },
  });

  const domainFailure = parseToolOutput(
    1,
    await withTimeout(
      "domain failure",
      client.callTool({
        name: "distilly_ingest",
        arguments: ingestArguments("domain failure"),
      }),
    ),
  );
  assert.deepEqual(domainFailure, {
    ok: false,
    wireVersion: "3",
    error: {
      code: "permission_denied",
      message: "fixture denied the material",
      retryable: false,
      fieldPath: "materials[0]",
    },
  });

  const unexpectedFailure = parseToolOutput(
    1,
    await withTimeout(
      "unexpected failure",
      client.callTool({
        name: "distilly_ingest",
        arguments: ingestArguments("unexpected failure"),
      }),
    ),
  );
  assert.deepEqual(unexpectedFailure, {
    ok: false,
    wireVersion: "3",
    error: {
      code: "internal_error",
      message: "The Distilly MCP adapter encountered an unexpected internal error.",
      retryable: false,
    },
  });
  assert.doesNotMatch(JSON.stringify(unexpectedFailure), /private fixture/u);
} finally {
  await withTimeout("stdio teardown", client.close(), 5_000);
}

assert.equal(transport.pid, null);
assert.equal(stderr, "");

for (const signal of ["SIGINT", "SIGTERM"]) {
  const signalTransport = new StdioClientTransport({
    command: process.execPath,
    args: [fixturePath],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stderr: "pipe",
  });
  let signalStderr = "";
  signalTransport.stderr?.setEncoding("utf8");
  signalTransport.stderr?.on("data", (chunk) => {
    signalStderr += chunk;
  });
  const signalClient = new Client({ name: "distilly-signal-smoke", version: "0.0.0" });
  try {
    await withTimeout(`${signal} stdio initialize`, signalClient.connect(signalTransport));
    const signalPid = signalTransport.pid;
    assert.notEqual(signalPid, null);
    process.kill(signalPid, signal);
    await withTimeout(
      `${signal} teardown`,
      waitUntil(() => signalTransport.pid === null),
      5_000,
    );
  } finally {
    await withTimeout(`${signal} client close`, signalClient.close(), 5_000);
  }
  assert.equal(signalStderr, "");
}

const explicitCloseChild = spawn(process.execPath, [fixturePath], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, DISTILLY_MCP_FIXTURE_EXPLICIT_CLOSE: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});
let explicitCloseStdout = "";
let explicitCloseStderr = "";
explicitCloseChild.stdout.setEncoding("utf8");
explicitCloseChild.stdout.on("data", (chunk) => {
  explicitCloseStdout += chunk;
});
explicitCloseChild.stderr.setEncoding("utf8");
explicitCloseChild.stderr.on("data", (chunk) => {
  explicitCloseStderr += chunk;
});
const explicitCloseExit = new Promise((resolve, reject) => {
  explicitCloseChild.once("error", reject);
  explicitCloseChild.once("exit", (code, signal) => resolve({ code, signal }));
});
try {
  assert.deepEqual(await withTimeout("explicit close teardown", explicitCloseExit, 5_000), {
    code: 0,
    signal: null,
  });
} finally {
  if (explicitCloseChild.exitCode === null && explicitCloseChild.signalCode === null) {
    explicitCloseChild.kill("SIGKILL");
  }
}
assert.equal(explicitCloseStdout, "");
assert.equal(explicitCloseStderr, "");

const malformedChild = spawn(process.execPath, [fixturePath], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdio: ["pipe", "pipe", "pipe"],
});
let malformedStdout = "";
let malformedStderr = "";
malformedChild.stdout.setEncoding("utf8");
malformedChild.stdout.on("data", (chunk) => {
  malformedStdout += chunk;
});
malformedChild.stderr.setEncoding("utf8");
malformedChild.stderr.on("data", (chunk) => {
  malformedStderr += chunk;
});
const malformedExit = new Promise((resolve, reject) => {
  malformedChild.once("error", reject);
  malformedChild.once("exit", (code, signal) => resolve({ code, signal }));
});
try {
  malformedChild.stdin.write("{}\n");
  const exit = await withTimeout("transport-error teardown", malformedExit, 5_000);
  assert.deepEqual(exit, { code: 1, signal: null });
} finally {
  if (malformedChild.exitCode === null && malformedChild.signalCode === null) {
    malformedChild.kill("SIGKILL");
  }
}
assert.equal(malformedStdout, "");
assert.notEqual(malformedStderr, "");
