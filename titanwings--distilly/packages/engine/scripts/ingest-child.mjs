import { setTimeout as delay } from "node:timers/promises";

import { createInternalEngineComposition } from "../lib/ingest/composition.js";

const [root, requestId] = process.argv.slice(2);
if (root === undefined || requestId === undefined) {
  throw new Error("ingest-child requires root and request id");
}

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
      clientRef: "built-smoke-source",
      kind: "web",
      content: "Verified built smoke evidence.",
      source: {
        uri: "https://example.com/evidence",
        medium: "article",
        access: "public",
        role: "reference",
        capturedAt: "2026-08-20T00:00:00.000Z",
      },
      derivation: { kind: "native_text" },
    },
  ],
  enqueue: "now",
};
const actor = { kind: "sdk", id: "built-ingest-smoke" };
const deadline = Date.now() + 10_000;

for (;;) {
  let composition;
  try {
    composition = await createInternalEngineComposition({ root });
    const result = await composition.ingest.ingest(input, actor, { requestId });
    process.stdout.write(
      `result:${JSON.stringify({ kind: "success", subjectId: result.subject.id })}\n`,
    );
    break;
  } catch (error) {
    if (error?.code === "already_exists") {
      process.stdout.write('result:{"kind":"already_exists"}\n');
      break;
    }
    if (error?.code !== "busy" || Date.now() >= deadline) throw error;
    await delay(20);
  } finally {
    composition?.close();
  }
}
