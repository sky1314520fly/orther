import assert from "node:assert/strict";

import { expectedRuntimeExports } from "./check-public-api.mjs";

const protocol = await import("@distilly/protocol");

assert.deepEqual(
  Object.keys(protocol).sort(),
  expectedRuntimeExports,
  "Packed root runtime exports must match the reviewed allowlist",
);
assert.equal(protocol.WIRE_VERSION, "3");
assert.equal(protocol.JSON_SCHEMA_DIALECT, "https://json-schema.org/draft/2020-12/schema");
assert.equal(protocol.BUILTIN_PEOPLE_SPACE_ID, "space_00000000000000000000000000000001");

const subjectId = `subject_${"a".repeat(32)}`;
assert.equal(protocol.subjectIdSchema.parse(subjectId), subjectId);
assert.deepEqual(protocol.engineMethodSchemas["subjects.list"].params.parse({}), {});
assert.deepEqual(protocol.engineMethodSchemas["subjects.archive"].params.parse({ subjectId }), {
  subjectId,
});
assert.equal(protocol.engineMethodSchemas["subjects.archive"].result.parse(null), null);
assert.throws(() => protocol.engineMethodSchemas["subjects.archive"].result.parse(undefined));
assert.deepEqual(Object.keys(protocol.engineAdministrationSchemas), ["backup", "restore"]);
assert.equal(Object.hasOwn(protocol.engineMethodSchemas, "backup"), false);
assert.deepEqual(
  protocol.engineMethodSchemas["subjects.purge"].result.parse({
    subjectId,
    logicalDeletion: "complete",
    physicalDeletion: "complete",
  }),
  { subjectId, logicalDeletion: "complete", physicalDeletion: "complete" },
);
assert.deepEqual(
  protocol.distillyMcpTools.map((tool) => tool.name),
  ["distilly_get", "distilly_ingest", "distilly_pending", "distilly_commit", "distilly_correct"],
);
