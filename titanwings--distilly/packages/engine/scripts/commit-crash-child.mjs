import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startVitest } from "vitest/node";

const [root, phase, requestId, encodedInput] = process.argv.slice(2);
if (
  root === undefined ||
  requestId === undefined ||
  encodedInput === undefined ||
  (phase !== "before_commit" && phase !== "after_commit")
) {
  throw new Error("commit-crash-child requires root, phase, request id, and encoded input");
}

const workspaceRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
process.env.DISTILLY_COMMIT_CRASH_CHILD = JSON.stringify({
  root,
  phase,
  requestId,
  input: JSON.parse(Buffer.from(encodedInput, "base64url").toString("utf8")),
});

await startVitest("test", ["packages/engine/src/distill/commit-service.sqlite.crash.test.ts"], {
  root: workspaceRoot,
  run: true,
  watch: false,
  pool: "threads",
  maxWorkers: 1,
  minWorkers: 1,
  fileParallelism: false,
  testTimeout: 60 * 60 * 1_000,
  color: false,
});
