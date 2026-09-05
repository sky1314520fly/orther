import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rootExports = await import("@distilly/runtime");
const previewExports = await import("@distilly/runtime/preview");

assert.deepEqual(Object.keys(rootExports), []);
assert.deepEqual(Object.keys(previewExports).sort(), ["openPreviewLocalRuntime"]);

const root = await mkdtemp(join(tmpdir(), "distilly-runtime-smoke-"));
try {
  const runtime = await previewExports.openPreviewLocalRuntime({ root });
  const client = await runtime.connectTrusted({ actor: { kind: "sdk", id: "built-smoke" } });
  assert.deepEqual(await client.call("subjects.list", {}), { items: [] });
  await client.close();
  await runtime.close();
} finally {
  await rm(root, { force: true, recursive: true });
}
