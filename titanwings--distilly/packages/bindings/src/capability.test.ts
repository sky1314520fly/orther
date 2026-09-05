import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BUILTIN_HOSTS,
  type HostCapabilities,
  type HostName,
  type HostPreflight,
} from "@distilly/protocol";
import { describe, expect, it, vi } from "vitest";

import { createClaudeCodeCapabilityBinding } from "./claude-code/capability.js";
import { createCodexCapabilityBinding } from "./codex/capability.js";
import type {
  HostCapabilityBinding,
  HostCapabilityBindingOptions,
  HostContext,
} from "./protocol.js";

const DIGEST: `sha256_${string}` = `sha256_${"9".repeat(64)}`;
const RELEASE = {
  releaseVersion: "0.0.0",
  wireMajor: 3,
  canonicalSkillDigest: DIGEST,
} as const;
const CONTEXT = {
  sessionId: "session-1",
  workingDirectory: "/workspace/not-the-process-cwd",
  environment: "desktop",
} as const satisfies HostContext;

const UNKNOWN_CAPABILITIES = {
  webResearch: "unknown",
  localFileRead: "unknown",
  vision: "unknown",
  documentTextExtraction: "unknown",
  imageOcr: "unknown",
  audioTranscription: "unknown",
  videoCaptions: "unknown",
  privateUiCapture: "unavailable",
  windowScopedCapture: "unknown",
  captureDataPolicy: "unknown",
  structuredToolCalls: true,
  lifecycleHooks: [],
  subruns: false,
  subrunsInheritMcp: false,
  opensLoopbackUrls: false,
  maxContextTokens: 128_000,
  maxToolResultBytes: 1_000_000,
} as const satisfies HostCapabilities;

const FAIL_CLOSED_CAPABILITIES = {
  webResearch: "unknown",
  localFileRead: "unknown",
  vision: "unknown",
  documentTextExtraction: "unknown",
  imageOcr: "unknown",
  audioTranscription: "unknown",
  videoCaptions: "unknown",
  privateUiCapture: "unavailable",
  windowScopedCapture: "unknown",
  captureDataPolicy: "unknown",
  structuredToolCalls: false,
  lifecycleHooks: [],
  subruns: false,
  subrunsInheritMcp: false,
  opensLoopbackUrls: false,
} as const satisfies HostCapabilities;

const UNSUPPORTED_ERROR = {
  code: "host_unsupported",
  message: "This host session does not provide a verified Distilly briefing capacity.",
  retryable: false,
  remediation:
    "Upgrade or restart the host, or install a release with a matching verified capacity fixture.",
} as const;

type EvidenceKind = "host_handshake" | "binding_fixture";
type Factory = (options: HostCapabilityBindingOptions) => HostCapabilityBinding;

const evidence = (host: HostName, kind: EvidenceKind) => ({
  kind,
  ...(kind === "binding_fixture" ? { fixtureId: `${host}-desktop-2026.08.21` } : {}),
  host,
  hostVersion: "2026.08.21",
  environment: "desktop" as const,
  releaseVersion: RELEASE.releaseVersion,
  wireMajor: RELEASE.wireMajor,
  canonicalSkillDigest: RELEASE.canonicalSkillDigest,
});

const successPayload = (
  host: HostName,
  kind: EvidenceKind,
  capabilities: HostCapabilities = UNKNOWN_CAPABILITIES,
) => ({
  ok: true,
  capabilities,
  capacity: {
    maximumInputTokens: 96_000,
    maximumToolResultBytes: 750_000,
    source: kind,
  },
  evidence: evidence(host, kind),
  warnings: ["Verified net briefing capacity."],
});

const create = (factory: Factory, payload: unknown): HostCapabilityBinding =>
  factory({
    provider: { load: () => Promise.resolve(payload) },
    release: RELEASE,
  });

const expectUnsupported = (
  result: HostPreflight,
  capabilities: HostCapabilities,
  warnings: readonly string[] = [],
): void => {
  expect(result).toEqual({
    ok: false,
    capabilities,
    error: UNSUPPORTED_ERROR,
    warnings,
  });
  expect("capacity" in result).toBe(false);
  expect("evidence" in result).toBe(false);
};

const FACTORIES = [
  {
    label: "Codex",
    host: BUILTIN_HOSTS.codex,
    factory: createCodexCapabilityBinding,
  },
  {
    label: "Claude Code",
    host: BUILTIN_HOSTS.claudeCode,
    factory: createClaudeCodeCapabilityBinding,
  },
] as const;

describe.each(FACTORIES)("$label capability binding", ({ host, factory }) => {
  it.each(["host_handshake", "binding_fixture"] as const)(
    "accepts an exact %s net-capacity proof",
    async (kind) => {
      const payload = successPayload(host, kind);
      const load = vi.fn((context: HostContext) => {
        expect(context).toBe(CONTEXT);
        return Promise.resolve(payload);
      });
      const binding = factory({ provider: { load }, release: RELEASE });

      expect(binding.kind).toBe("capability");
      expect(binding.host).toBe(host);
      await expect(binding.preflight(CONTEXT)).resolves.toEqual(payload);
      expect(load).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves every independent verified capability except private capture", async () => {
    const richCapabilities = {
      webResearch: "available",
      localFileRead: "unavailable",
      vision: "unknown",
      documentTextExtraction: "available",
      imageOcr: "unavailable",
      audioTranscription: "available",
      videoCaptions: "unknown",
      privateUiCapture: "available",
      windowScopedCapture: "available",
      captureDataPolicy: "known",
      structuredToolCalls: true,
      lifecycleHooks: ["session_start", "command"],
      subruns: true,
      subrunsInheritMcp: true,
      opensLoopbackUrls: true,
      maxContextTokens: 200_000,
      maxToolResultBytes: 2_000_000,
    } as const satisfies HostCapabilities;

    const result = await create(
      factory,
      successPayload(host, "host_handshake", richCapabilities),
    ).preflight(CONTEXT);

    expect(result.ok).toBe(true);
    expect(result.capabilities).toEqual({
      ...richCapabilities,
      privateUiCapture: "unavailable",
    });
  });

  it("does not promote unknown extraction capabilities from vision or gross limits", async () => {
    const result = await create(
      factory,
      successPayload(host, "host_handshake", {
        ...UNKNOWN_CAPABILITIES,
        vision: "available",
      }),
    ).preflight(CONTEXT);

    expect(result.capabilities.documentTextExtraction).toBe("unknown");
    expect(result.capabilities.imageOcr).toBe("unknown");
    expect(result.capabilities.audioTranscription).toBe("unknown");
    expect(result.capabilities.videoCaptions).toBe("unknown");
    expect(result.capabilities.privateUiCapture).toBe("unavailable");
  });

  it("sanitizes a valid provider failure while preserving verified capabilities", async () => {
    const capabilities = {
      ...UNKNOWN_CAPABILITIES,
      webResearch: "available" as const,
      structuredToolCalls: false,
    };
    const result = await create(factory, {
      ok: false,
      capabilities,
      error: {
        code: "host_unsupported",
        message: "provider secret /Users/alice/private",
        retryable: false,
        details: { secret: "do not forward" },
      },
      warnings: ["Structured tool calls are unavailable."],
    }).preflight(CONTEXT);

    expectUnsupported(result, capabilities, ["Structured tool calls are unavailable."]);
  });

  it("forces private capture unavailable on a valid provider failure", async () => {
    const capabilities = {
      ...UNKNOWN_CAPABILITIES,
      privateUiCapture: "available" as const,
      windowScopedCapture: "available" as const,
      captureDataPolicy: "known" as const,
      structuredToolCalls: false,
    };
    const result = await create(factory, {
      ok: false,
      capabilities,
      error: {
        code: "host_unsupported",
        message: "Unsupported.",
        retryable: false,
      },
      warnings: [],
    }).preflight(CONTEXT);

    expectUnsupported(result, { ...capabilities, privateUiCapture: "unavailable" });
  });

  it.each([
    {
      label: "factory host",
      mutate: (payload: ReturnType<typeof successPayload>) => ({
        ...payload,
        evidence: { ...payload.evidence, host: "other-host" },
      }),
    },
    {
      label: "host environment",
      mutate: (payload: ReturnType<typeof successPayload>) => ({
        ...payload,
        evidence: { ...payload.evidence, environment: "cli" },
      }),
    },
    {
      label: "capacity source",
      mutate: (payload: ReturnType<typeof successPayload>) => ({
        ...payload,
        capacity: { ...payload.capacity, source: "binding_fixture" },
      }),
    },
    {
      label: "release version",
      mutate: (payload: ReturnType<typeof successPayload>) => ({
        ...payload,
        evidence: { ...payload.evidence, releaseVersion: "0.0.1" },
      }),
    },
    {
      label: "wire major",
      mutate: (payload: ReturnType<typeof successPayload>) => ({
        ...payload,
        evidence: { ...payload.evidence, wireMajor: 4 },
      }),
    },
    {
      label: "canonical skill digest",
      mutate: (payload: ReturnType<typeof successPayload>) => ({
        ...payload,
        evidence: {
          ...payload.evidence,
          canonicalSkillDigest: `sha256_${"8".repeat(64)}`,
        },
      }),
    },
  ])("fails closed on a $label mismatch", async ({ mutate }) => {
    const result = await create(factory, mutate(successPayload(host, "host_handshake"))).preflight(
      CONTEXT,
    );

    expectUnsupported(result, UNKNOWN_CAPABILITIES, ["Verified net briefing capacity."]);
  });

  it("checks the complete release tuple for binding fixtures", async () => {
    const payload = successPayload(host, "binding_fixture");
    for (const evidencePatch of [
      { releaseVersion: "0.0.1" },
      { wireMajor: 4 },
      { canonicalSkillDigest: `sha256_${"8".repeat(64)}` },
    ]) {
      const result = await create(factory, {
        ...payload,
        evidence: { ...payload.evidence, ...evidencePatch },
      }).preflight(CONTEXT);
      expectUnsupported(result, UNKNOWN_CAPABILITIES, ["Verified net briefing capacity."]);
    }
  });

  it("does not derive net capacity from gross host limits", async () => {
    const result = await create(factory, {
      ok: true,
      capabilities: UNKNOWN_CAPABILITIES,
      warnings: ["Only gross limits are known."],
    }).preflight(CONTEXT);

    expectUnsupported(result, UNKNOWN_CAPABILITIES, ["Only gross limits are known."]);
  });

  it("rejects a success-shaped payload with evidence but no net capacity", async () => {
    const payload = successPayload(host, "host_handshake");
    const result = await create(factory, {
      ok: payload.ok,
      capabilities: payload.capabilities,
      evidence: payload.evidence,
      warnings: payload.warnings,
    }).preflight(CONTEXT);

    expectUnsupported(result, UNKNOWN_CAPABILITIES, payload.warnings);
  });

  it("fails closed when the success payload has an unknown key", async () => {
    const result = await create(factory, {
      ...successPayload(host, "host_handshake", {
        ...UNKNOWN_CAPABILITIES,
        webResearch: "available",
      }),
      unexpected: true,
    }).preflight(CONTEXT);

    expectUnsupported(result, FAIL_CLOSED_CAPABILITIES);
  });

  it("fails closed when the provider throws", async () => {
    const binding = factory({
      provider: {
        load: () => Promise.reject(new Error("provider path and stack must not escape")),
      },
      release: RELEASE,
    });

    expectUnsupported(await binding.preflight(CONTEXT), FAIL_CLOSED_CAPABILITIES);
  });

  it.each([
    null,
    {},
    { provider: {}, release: RELEASE },
    {
      provider: { load: () => Promise.resolve(successPayload(host, "host_handshake")) },
      release: { ...RELEASE, releaseVersion: "v0.0.0" },
    },
    {
      provider: { load: () => Promise.resolve(successPayload(host, "host_handshake")) },
      release: { ...RELEASE, wireMajor: 4 },
    },
    {
      provider: { load: () => Promise.resolve(successPayload(host, "host_handshake")) },
      release: { ...RELEASE, canonicalSkillDigest: "sha256_short" },
    },
    {
      provider: { load: () => Promise.resolve(successPayload(host, "host_handshake")) },
      release: { ...RELEASE, extra: true },
    },
  ])("turns invalid factory options into a terminal preflight", async (options) => {
    const binding = factory(options as unknown as HostCapabilityBindingOptions);
    expectUnsupported(await binding.preflight(CONTEXT), FAIL_CLOSED_CAPABILITIES);
  });
});

describe.sequential("capability binding process isolation", () => {
  it("uses only the injected provider even from an empty sentinel cwd", async () => {
    const priorDirectory = process.cwd();
    const sentinelDirectory = await mkdtemp(join(tmpdir(), "distilly-bindings-cwd-"));
    const payload = successPayload(BUILTIN_HOSTS.codex, "host_handshake");
    try {
      process.chdir(sentinelDirectory);
      const result = await create(createCodexCapabilityBinding, payload).preflight(CONTEXT);
      expect(result.ok).toBe(true);
      await expect(readFile(join(sentinelDirectory, "package.json"), "utf8")).rejects.toMatchObject(
        {
          code: "ENOENT",
        },
      );
    } finally {
      process.chdir(priorDirectory);
      await rm(sentinelDirectory, { force: true, recursive: true });
    }
  });
});
