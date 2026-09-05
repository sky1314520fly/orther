import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startVitest } from "vitest/node";

const [root, phase, requestId, jobId] = process.argv.slice(2);
if (
  root === undefined ||
  requestId === undefined ||
  jobId === undefined ||
  (phase !== "before_commit" && phase !== "after_commit")
) {
  throw new Error("brief-crash-child requires root, phase, request id, and job id");
}

const workspaceRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
process.env.DISTILLY_BRIEF_CRASH_CHILD = JSON.stringify({ root, phase, requestId, jobId });

await startVitest("test", ["packages/engine/src/distill/lease-service.sqlite.crash.test.ts"], {
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
