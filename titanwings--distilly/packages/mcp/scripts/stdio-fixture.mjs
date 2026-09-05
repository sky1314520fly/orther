import { createMcpServer } from "@distilly/mcp";
import { runStdio } from "@distilly/mcp/stdio";

import { FullFakeEngineClient } from "../lib/testing/full-fake-engine-client.js";

const REVIEW_TOKEN = "d".repeat(64);

const reviewPresenter = {
  closeCalls: 0,

  async present(ref) {
    return {
      ref,
      url: `http://127.0.0.1:43123/#${REVIEW_TOKEN}/review/${ref.subjectId}/${ref.candidateVersionId}`,
    };
  },

  async close() {
    this.closeCalls += 1;
  },
};

const client = new FullFakeEngineClient();
const server = createMcpServer({
  client,
  reviewPresenter,
});

try {
  const explicitClose =
    process.env.DISTILLY_MCP_FIXTURE_EXPLICIT_CLOSE === "1"
      ? new Promise((resolve, reject) => {
          setTimeout(() => {
            server.close().then(resolve, reject);
          }, 25);
        })
      : Promise.resolve();
  await runStdio(server);
  await explicitClose;
  if (client.closeCalls !== 0 || reviewPresenter.closeCalls !== 0) {
    throw new Error("MCP teardown closed a borrowed dependency.");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
