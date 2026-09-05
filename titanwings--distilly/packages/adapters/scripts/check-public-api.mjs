import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const expectedTypeExports = `
AdapterCapabilities
AdapterConfig
AdapterPreflightResult
AdapterResource
AdapterResourceSchema
AgentPlan
CollectRequest
DelegatedSourceAdapter
DirectSourceAdapter
ExternalSubjectRef
MaterialParser
ParseContext
ParsedMaterial
ParsedMaterialDraft
ParserTextExtraction
RawMaterial
SourceActionInput
SourceAdapter
SourceAdapterBase
SourceAdapterRegistration
SourceCollectResult
SourceConfigureInput
SourceMutationActionName
SourcePreflightResult
SourceQueryActionName
SourceStatus
UserCollectionClient
UserCollectionMethodMap
UserCollectionSelection
`
  .trim()
  .split("\n");
const expectedRuntimeExports = [
  "AdapterRegistry",
  "ParserRegistry",
  "createBuiltinParserRegistry",
  "userCollectionMethodSchemas",
];

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const declarationPattern = /export( type)? \{([\s\S]*?)\} from "[^"]+";/g;
const actualTypeExports = [];
const actualRuntimeExports = [];
let cursor = 0;

for (const declaration of source.matchAll(declarationPattern)) {
  assert.equal(
    source.slice(cursor, declaration.index).trim(),
    "",
    "Adapters root may contain only explicit named re-export declarations",
  );
  cursor = (declaration.index ?? 0) + declaration[0].length;
  const names = (declaration[2] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of names) {
    assert.match(name, /^[A-Za-z_$][A-Za-z0-9_$]*$/u, "Adapters exports must be unaliased");
  }
  (declaration[1] === " type" ? actualTypeExports : actualRuntimeExports).push(...names);
}

assert.equal(
  source.slice(cursor).trim(),
  "",
  "Adapters root may contain only explicit named re-export declarations",
);
assert.equal(
  new Set([...actualTypeExports, ...actualRuntimeExports]).size,
  actualTypeExports.length + actualRuntimeExports.length,
  "Adapters root exports must not be duplicated",
);
assert.deepEqual(
  actualTypeExports.sort(),
  expectedTypeExports,
  "Update the reviewed type allowlist",
);
assert.deepEqual(
  actualRuntimeExports.sort(),
  expectedRuntimeExports,
  "Update the reviewed runtime allowlist",
);

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
assert.deepEqual(packageJson.dependencies, {
  "@distilly/protocol": "workspace:*",
  zod: "4.4.3",
});
assert.deepEqual(Object.keys(packageJson.exports), ["."]);

for (const path of [
  "src/builtin-parsers.ts",
  "src/parser-registry.ts",
  "src/registry.ts",
  "src/schemas.ts",
]) {
  const productionSource = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  assert.doesNotMatch(
    productionSource,
    /@distilly\/(?:engine|bindings|mcp|panel|runtime)|\bDISTILLY_ROOT\b/u,
    `${path} must remain independent of engine, host, transport, and runtime composition`,
  );
  assert.doesNotMatch(
    productionSource,
    /node:(?:fs|child_process|http|https|net|os|path)|process\.(?:cwd|env)|\bfetch\s*\(/u,
    `${path} must not read files, process secrets, or perform network collection`,
  );
  assert.doesNotMatch(
    productionSource,
    /\babstract\s+class\b/u,
    `${path} must not add a base class`,
  );
}
