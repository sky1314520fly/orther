import { createMcpServer } from "@distilly/mcp";
import { runStdio } from "@distilly/mcp/stdio";

import {
  canonicalJson,
  createHostCapacityFixture,
  SUBJECT_ID,
} from "./host-capacity-fixture-data.mjs";

const parseBytes = (name) => {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
};

const fixture = createHostCapacityFixture({
  briefingBytes: parseBytes("DISTILLY_FIXTURE_BRIEFING_BYTES"),
  toolResultBytes: parseBytes("DISTILLY_FIXTURE_TOOL_RESULT_BYTES"),
});
const { briefing, prompt } = fixture;
const schemaProfile = process.env.DISTILLY_MCP_SCHEMA_PROFILE;
if (schemaProfile !== undefined && schemaProfile !== "openclaw" && schemaProfile !== "hermes") {
  throw new Error("DISTILLY_MCP_SCHEMA_PROFILE must be openclaw or hermes.");
}

const subject = briefing.subject;
const expectedResolveParams = { selector: fixture.promptToolInput.subject };
const expectedPromptParams = { subjectId: SUBJECT_ID };
const expectedBriefingParams = { jobId: fixture.briefingToolInput.jobId };

const assertExactCall = (method, params, context, expectedParams, expectedContext) => {
  if (canonicalJson(params) !== canonicalJson(expectedParams)) {
    throw new Error(`Unexpected ${method} parameters in capacity fixture probe.`);
  }
  if (canonicalJson(context) !== canonicalJson(expectedContext)) {
    throw new Error(`Unexpected ${method} request context in capacity fixture probe.`);
  }
};

const client = {
  async call(method, params, context) {
    if (method === "subjects.resolve") {
      assertExactCall(method, params, context, expectedResolveParams, undefined);
      return { kind: "found", subject };
    }
    if (method === "profiles.prompt") {
      assertExactCall(method, params, context, expectedPromptParams, undefined);
      return prompt;
    }
    if (method === "distill.brief") {
      assertExactCall(method, params, context, expectedBriefingParams, {
        requestId: fixture.briefingToolInput.requestId,
      });
      return briefing;
    }
    throw new Error(`Unexpected capacity fixture method: ${method}`);
  },
  async watch() {
    return () => undefined;
  },
  async close() {},
};

const reviewPresenter = {
  async present(ref) {
    return { ref, url: `http://127.0.0.1/review/${SUBJECT_ID}` };
  },
  async close() {},
};

const server = createMcpServer({
  client,
  reviewPresenter,
  ...(schemaProfile === undefined ? {} : { schemaProfile }),
});

try {
  await runStdio(server);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
