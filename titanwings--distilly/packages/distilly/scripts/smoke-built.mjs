import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const facade = await import("distilly");

assert.deepEqual(Object.keys(facade).sort(), ["Distilly", "DistillyError", "Person"]);

const calls = [];
let closeCalls = 0;
const subjectId = `subject_${"1".repeat(32)}`;
const client = {
  async call(method, params, context) {
    calls.push({ method, params, ...(context === undefined ? {} : { context }) });
    switch (method) {
      case "subjects.create":
        return { id: subjectId };
      case "subjects.list":
        return { items: [] };
      case "subjects.archive":
        return null;
      case "subjects.purge":
        return {
          subjectId,
          logicalDeletion: "complete",
          physicalDeletion: "complete",
        };
      default:
        throw new Error(`Unexpected built-smoke method ${method}.`);
    }
  },
  async watch() {
    return () => undefined;
  },
  async close() {
    closeCalls += 1;
  },
};

const distilly = new facade.Distilly({ client });
assert.deepEqual(await distilly.list(), { items: [] });
const person = await distilly.create(
  { displayName: "Ada Lovelace" },
  { requestId: `req_${"2".repeat(32)}` },
);
assert.ok(person instanceof facade.Person);
assert.equal(person.id, subjectId);
assert.equal(await person.archive(), undefined);
assert.deepEqual(
  await distilly.purge(
    { subjectId, confirmation: "Ada Lovelace" },
    { requestId: `req_${"3".repeat(32)}` },
  ),
  {
    subjectId,
    logicalDeletion: "complete",
    physicalDeletion: "complete",
  },
);
await distilly.close();

assert.deepEqual(calls[0], { method: "subjects.list", params: {} });
assert.deepEqual(calls[1], {
  method: "subjects.create",
  params: { displayName: "Ada Lovelace" },
  context: { requestId: `req_${"2".repeat(32)}` },
});
assert.match(calls[2].context.requestId, /^req_[0-9a-f]{32}$/u);
assert.deepEqual(calls[3], {
  method: "subjects.purge",
  params: { subjectId, confirmation: "Ada Lovelace" },
  context: { requestId: `req_${"3".repeat(32)}` },
});
assert.equal(closeCalls, 1);

const declaration = await readFile(new URL("../lib/person.d.ts", import.meta.url), "utf8");
assert.match(declaration, /constructor\(client: EngineClient, subjectId: SubjectId\)/u);

for (const file of ["index.js", "distilly.js", "person.js", "request-id.js"]) {
  const source = await readFile(new URL(`../lib/${file}`, import.meta.url), "utf8");
  assert.doesNotMatch(source, /(?:from\s+|import\s*\()["']node:/u);
}
