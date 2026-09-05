import { writeSync } from "node:fs";

import { createInternalEngineComposition } from "../lib/ingest/composition.js";

const [root, phase, requestId] = process.argv.slice(2);
if (
  root === undefined ||
  requestId === undefined ||
  (phase !== "after_blob" && phase !== "before_commit" && phase !== "after_commit")
) {
  throw new Error("sqlite-crash-child requires root, phase, and request id");
}

const stop = (reached) => {
  writeSync(1, `phase:${reached}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};

const hooks = {
  ...(phase === "after_blob" ? { afterBlobPut: () => stop("after_blob") } : {}),
  ...(phase === "before_commit" ? { beforeTransactionCommit: () => stop("before_commit") } : {}),
  ...(phase === "after_commit" ? { afterTransactionCommit: () => stop("after_commit") } : {}),
};
const composition = await createInternalEngineComposition({ root, ingestHooks: hooks });
await composition.ingest.ingest(
  {
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
  },
  { kind: "sdk", id: "sqlite-crash-child" },
  { requestId },
);
composition.close();
