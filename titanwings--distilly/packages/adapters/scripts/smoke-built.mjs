import assert from "node:assert/strict";

import {
  AdapterRegistry,
  ParserRegistry,
  createBuiltinParserRegistry,
  userCollectionMethodSchemas,
} from "@distilly/adapters";

const adapters = await import("@distilly/adapters");
assert.deepEqual(Object.keys(adapters).sort(), [
  "AdapterRegistry",
  "ParserRegistry",
  "createBuiltinParserRegistry",
  "userCollectionMethodSchemas",
]);
assert.ok(new ParserRegistry());

const parser = createBuiltinParserRegistry().select("text/plain");
assert.ok(parser);
assert.deepEqual(
  await parser.parse(
    {
      clientRef: "built-smoke",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("built parser smoke"),
      source: {
        medium: "document",
        access: "private",
        capturedAt: "2026-08-31T00:00:00.000Z",
      },
    },
    {
      subjectId: "sub_built_smoke",
      requestId: "req_built_smoke",
      maximumOutputBytes: 1_048_576,
    },
  ),
  {
    material: {
      clientRef: "built-smoke",
      kind: "document",
      content: "built parser smoke",
      source: {
        medium: "document",
        access: "private",
        capturedAt: "2026-08-31T00:00:00.000Z",
      },
      extraction: { method: "document_text", producer: "distilly-text" },
    },
    warnings: [],
  },
);

const registry = new AdapterRegistry();
registry.register({
  id: "built-fixture",
  mode: "direct",
  resourceSchema: {
    parse(input) {
      assert.deepEqual(input, { kind: "documents", locator: "folder-1" });
      return input;
    },
  },
  capabilities() {
    return {
      resolveSubject: true,
      plan: false,
      collect: true,
      requiresSecret: true,
      resourceKinds: [{ kind: "documents", availability: "available" }],
    };
  },
  async preflight() {
    return { ok: true, warnings: [] };
  },
  async resolveSubject() {
    return [];
  },
  async *collect() {
    return;
  },
});

assert.deepEqual(registry.list(), [
  {
    id: "built-fixture",
    mode: "direct",
    capabilities: {
      resolveSubject: true,
      plan: false,
      collect: true,
      requiresSecret: true,
      resourceKinds: [{ kind: "documents", availability: "available" }],
    },
  },
]);
assert.equal(userCollectionMethodSchemas["source.list"].params.parse(null), null);
assert.deepEqual(
  userCollectionMethodSchemas["source.configure"].params.parse({
    adapterId: "built-fixture",
    config: {
      values: { region: "international" },
      secretRefs: { apiKey: "env:DISTILLY_BUILT_FIXTURE_API_KEY" },
    },
  }),
  {
    adapterId: "built-fixture",
    config: {
      values: { region: "international" },
      secretRefs: { apiKey: "env:DISTILLY_BUILT_FIXTURE_API_KEY" },
    },
  },
);
assert.throws(() =>
  userCollectionMethodSchemas["source.configure"].params.parse({
    adapterId: "built-fixture",
    config: { values: { apiKey: "plaintext" } },
  }),
);
