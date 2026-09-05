import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const expectedTypeExports = `
BriefInput
CommitInput
CommitResult
CorrectionDraft
CreateSubjectInput
DistillyErrorCode
DistillyOptions
DistillyWireError
EngineClient
ExportOptions
ExportRef
HostDistillBriefing
HostName
IngestFilesInput
IngestFilesResult
IngestResult
InstallOptions
InstallRef
JobLease
LineageEvent
LineageInput
LineagePage
MaterialInput
MutationOptions
PendingFilter
PendingJob
Profile
ProfileDiff
PurgeResult
PurgeSubjectInput
RedistillInput
ReleaseLeaseInput
RenewLeaseInput
RequestId
ResolveSubjectInput
ResolveSubjectResult
ReviewActionInput
ReviewItem
ReviewPage
ReviewQuery
SubjectId
SubjectPage
SubjectQuery
SubjectStatus
VersionId
VersionPage
VersionQuery
VersionSummary
`
  .trim()
  .split("\n");

const expectedRuntimeExports = ["Distilly", "DistillyError", "Person"];
const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const declarationPattern = /export( type)? \{([\s\S]*?)\} from "[^"]+";/g;
const actualTypeExports = [];
const actualRuntimeExports = [];
let cursor = 0;

for (const declaration of source.matchAll(declarationPattern)) {
  assert.equal(
    source.slice(cursor, declaration.index).trim(),
    "",
    "Facade root may contain only explicit named re-export declarations",
  );
  cursor = (declaration.index ?? 0) + declaration[0].length;

  const names = (declaration[2] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of names) {
    assert.match(
      name,
      /^[A-Za-z_$][A-Za-z0-9_$]*$/,
      "Aliases and type-in-value escapes are forbidden",
    );
  }
  (declaration[1] === " type" ? actualTypeExports : actualRuntimeExports).push(...names);
}

assert.equal(
  source.slice(cursor).trim(),
  "",
  "Facade root may contain only explicit named re-export declarations",
);
assert.equal(
  new Set([...actualTypeExports, ...actualRuntimeExports]).size,
  actualTypeExports.length + actualRuntimeExports.length,
  "Facade root exports must not be duplicated",
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
