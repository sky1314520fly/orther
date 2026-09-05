import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { BUILTIN_HOSTS } from "@distilly/protocol";
import {
  HostRegistry,
  createClaudeCodeCapabilityBinding,
  createClaudeCodeHostBinding,
  createCodexCapabilityBinding,
  createCodexHostBinding,
  createHermesCapabilityBinding,
  createHermesHostBinding,
  createOpenClawCapabilityBinding,
  createOpenClawHostBinding,
} from "@distilly/bindings";

const bindings = await import("@distilly/bindings");
assert.deepEqual(Object.keys(bindings).sort(), [
  "HostRegistry",
  "createClaudeCodeCapabilityBinding",
  "createClaudeCodeHostBinding",
  "createCodexCapabilityBinding",
  "createCodexHostBinding",
  "createHermesCapabilityBinding",
  "createHermesHostBinding",
  "createOpenClawCapabilityBinding",
  "createOpenClawHostBinding",
]);

const digest = `sha256_${"9".repeat(64)}`;
const release = {
  releaseVersion: "0.0.0",
  wireMajor: 3,
  canonicalSkillDigest: digest,
};
const context = { sessionId: "built-smoke", environment: "ci" };
const capabilities = {
  webResearch: "unknown",
  localFileRead: "unknown",
  vision: "unknown",
  documentTextExtraction: "unknown",
  imageOcr: "unknown",
  audioTranscription: "unknown",
  videoCaptions: "unknown",
  privateUiCapture: "available",
  windowScopedCapture: "available",
  captureDataPolicy: "known",
  structuredToolCalls: true,
  lifecycleHooks: [],
  subruns: false,
  subrunsInheritMcp: false,
  opensLoopbackUrls: false,
};

const createProvider = (host) => ({
  async load(receivedContext) {
    assert.deepEqual(receivedContext, context);
    return {
      ok: true,
      capabilities,
      capacity: {
        maximumInputTokens: 64_000,
        maximumToolResultBytes: 500_000,
        source: "host_handshake",
      },
      evidence: {
        kind: "host_handshake",
        host,
        hostVersion: "built-smoke-1",
        environment: "ci",
        ...release,
      },
      warnings: [],
    };
  },
});

const codex = createCodexCapabilityBinding({
  provider: createProvider(BUILTIN_HOSTS.codex),
  release,
});
const claudeCode = createClaudeCodeCapabilityBinding({
  provider: createProvider(BUILTIN_HOSTS.claudeCode),
  release,
});
const hermes = createHermesCapabilityBinding({
  provider: createProvider(BUILTIN_HOSTS.hermes),
  release,
});
const openClaw = createOpenClawCapabilityBinding({
  provider: createProvider(BUILTIN_HOSTS.openclaw),
  release,
});
const registry = new HostRegistry();
registry.register(codex);
registry.register(claudeCode);
registry.register(hermes);
registry.register(openClaw);

assert.deepEqual(
  registry.list().map(({ host }) => host),
  [BUILTIN_HOSTS.claudeCode, BUILTIN_HOSTS.codex, BUILTIN_HOSTS.hermes, BUILTIN_HOSTS.openclaw],
);
for (const binding of registry.list()) {
  const result = await binding.preflight(context);
  assert.equal(result.ok, true);
  assert.equal(result.capabilities.privateUiCapture, "unavailable");
  assert.equal(result.capacity.source, "host_handshake");
}

for (const file of [
  "capability-fixture.js",
  "codex/capability.js",
  "claude-code/capability.js",
  "hermes/capability.js",
  "openclaw/capability.js",
  "registry.js",
]) {
  const builtSource = await readFile(new URL(`../lib/${file}`, import.meta.url), "utf8");
  assert.doesNotMatch(
    builtSource,
    /node:(?:fs|child_process|http|https|net)|process\.(?:cwd|env)|\bfetch\s*\(/u,
  );
}
