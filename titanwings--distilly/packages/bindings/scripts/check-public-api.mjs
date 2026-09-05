import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const expectedTypeExports = `
ClaudeCodeHostBindingOptions
CodexHostBindingOptions
FullHostBindingOptions
HermesHostBindingOptions
HostActionRegistration
HostAnswer
HostBinding
HostCapabilityBinding
HostCapabilityBindingOptions
HostCommandResult
HostCommandRunner
HostContext
HostDoctorResult
HostFormPresenter
HostFormRenderer
HostInjector
HostPreflightProvider
HostQuestion
HostRegistryBinding
HostSpawnRequest
Injection
InstallContext
OpenClawHostBindingOptions
PluginInstallResult
PrivateUiCaptureActionPort
PrivateUiCaptureAuthorizationResult
PrivateUiCaptureController
PrivateUiCaptureGrantHandle
`
  .trim()
  .split("\n");
const expectedRuntimeExports = [
  "HostRegistry",
  "createClaudeCodeCapabilityBinding",
  "createClaudeCodeHostBinding",
  "createCodexCapabilityBinding",
  "createCodexHostBinding",
  "createHermesCapabilityBinding",
  "createHermesHostBinding",
  "createOpenClawCapabilityBinding",
  "createOpenClawHostBinding",
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
    "Bindings root may contain only explicit named re-export declarations",
  );
  cursor = (declaration.index ?? 0) + declaration[0].length;
  const names = (declaration[2] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of names) {
    assert.match(name, /^[A-Za-z_$][A-Za-z0-9_$]*$/u, "Bindings exports must be unaliased");
  }
  (declaration[1] === " type" ? actualTypeExports : actualRuntimeExports).push(...names);
}

assert.equal(
  source.slice(cursor).trim(),
  "",
  "Bindings root may contain only explicit named re-export declarations",
);
assert.equal(
  new Set([...actualTypeExports, ...actualRuntimeExports]).size,
  actualTypeExports.length + actualRuntimeExports.length,
  "Bindings root exports must not be duplicated",
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
assert.deepEqual(packageJson.dependencies, { "@distilly/protocol": "workspace:*" });
assert.deepEqual(Object.keys(packageJson.exports), ["."]);

for (const path of [
  "src/capability-fixture.ts",
  "src/codex/capability.ts",
  "src/claude-code/capability.ts",
  "src/hermes/capability.ts",
  "src/openclaw/capability.ts",
  "src/registry.ts",
]) {
  const productionSource = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  assert.doesNotMatch(
    productionSource,
    /node:(?:fs|child_process|http|https|net|os|path)|process\.(?:cwd|env)|\bfetch\s*\(|\bspawn(?:Sync)?\s*\(/u,
    `${path} must not probe the filesystem, process environment, executables, or network`,
  );
  assert.doesNotMatch(
    productionSource,
    /\babstract\s+class\b/u,
    `${path} must not add a base class`,
  );
}

const codexSource = await readFile(new URL("../src/codex/capability.ts", import.meta.url), "utf8");
const claudeCodeSource = await readFile(
  new URL("../src/claude-code/capability.ts", import.meta.url),
  "utf8",
);
const hermesSource = await readFile(
  new URL("../src/hermes/capability.ts", import.meta.url),
  "utf8",
);
const openClawSource = await readFile(
  new URL("../src/openclaw/capability.ts", import.meta.url),
  "utf8",
);
assert.match(codexSource, /BUILTIN_HOSTS\.codex/u);
assert.doesNotMatch(codexSource, /BUILTIN_HOSTS\.claudeCode/u);
assert.match(claudeCodeSource, /BUILTIN_HOSTS\.claudeCode/u);
assert.doesNotMatch(claudeCodeSource, /BUILTIN_HOSTS\.codex\b/u);
assert.match(hermesSource, /BUILTIN_HOSTS\.hermes/u);
assert.doesNotMatch(hermesSource, /BUILTIN_HOSTS\.(?:codex|claudeCode|openclaw)\b/u);
assert.match(openClawSource, /BUILTIN_HOSTS\.openclaw/u);
assert.doesNotMatch(openClawSource, /BUILTIN_HOSTS\.(?:codex|claudeCode|hermes)\b/u);
