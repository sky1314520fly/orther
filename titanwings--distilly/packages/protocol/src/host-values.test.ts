import { describe, expect, it } from "vitest";

import {
  actorContextSchema,
  briefCapacitySchema,
  clientSessionContextSchema,
  mutationContextSchema,
} from "./schemas/context.js";
import {
  capturedPrivateTranscriptSchema,
  hostCapabilitiesSchema,
  hostPreflightEvidenceSchema,
  hostPreflightSchema,
  privateUiCaptureActionResultSchema,
  privateUiCaptureAuthorizationSchema,
  privateUiCaptureGrantStatusSchema,
  privateUiCaptureScopeSchema,
} from "./schemas/hosts.js";

const at = "2026-08-20T00:00:00.000Z";
const requestId = `req_${"1".repeat(32)}`;
const subjectId = `subject_${"2".repeat(32)}`;
const materialId = `mat_${"3".repeat(64)}`;
const contentDigest = `sha256_${"4".repeat(64)}`;
const materialSetHash = `set_sha256_${"5".repeat(64)}`;
const spaceId = `space_${"6".repeat(32)}`;
const jobId = `job_${"7".repeat(32)}`;
const leaseOwner = `lease_owner_${"8".repeat(32)}`;

const capabilities = {
  webResearch: "available",
  localFileRead: "available",
  vision: "unknown",
  documentTextExtraction: "available",
  imageOcr: "unavailable",
  audioTranscription: "unavailable",
  videoCaptions: "available",
  privateUiCapture: "unavailable",
  windowScopedCapture: "unknown",
  captureDataPolicy: "unknown",
  structuredToolCalls: true,
  lifecycleHooks: ["session_end"],
  subruns: true,
  subrunsInheritMcp: false,
  opensLoopbackUrls: true,
  maxContextTokens: 128_000,
  maxToolResultBytes: 1_000_000,
} as const;

const hostHandshakeEvidence = {
  kind: "host_handshake",
  host: "codex",
  hostVersion: "2026.08.21",
  environment: "desktop",
  releaseVersion: "0.0.0",
  wireMajor: 3,
  canonicalSkillDigest: `sha256_${"9".repeat(64)}`,
} as const;

const bindingFixtureEvidence = {
  kind: "binding_fixture",
  fixtureId: "codex-desktop-2026.08.21",
  host: "codex",
  hostVersion: "2026.08.21",
  environment: "desktop",
  releaseVersion: "0.0.0",
  wireMajor: 3,
  canonicalSkillDigest: `sha256_${"9".repeat(64)}`,
} as const;

const hostHandshakeCapacity = {
  maximumInputTokens: 128_000,
  maximumToolResultBytes: 1_000_000,
  source: "host_handshake",
} as const;

const bindingFixtureCapacity = {
  maximumInputTokens: 96_000,
  maximumToolResultBytes: 750_000,
  source: "binding_fixture",
} as const;

const unsupportedError = {
  code: "host_unsupported",
  message: "This host does not provide structured tool calls.",
  retryable: false,
  fieldPath: "capabilities.structuredToolCalls",
  remediation: "Upgrade the host and restart the session.",
  details: { host: "codex" },
} as const;

const subject = {
  id: subjectId,
  displayName: "Ada",
  aliases: [],
  identityHints: [],
  space: { id: spaceId, displayName: "People", kind: "people" },
  lifecycle: "active",
} as const;

const material = {
  clientRef: "capture-1",
  kind: "transcript",
  content: "A private message.",
  source: {
    medium: "conversation",
    access: "private",
    role: "personal_communication",
    capturedAt: at,
  },
  derivation: {
    kind: "host_extract",
    method: "computer_use_transcript",
    producer: "codex",
  },
  sensitivity: "private",
} as const;

const pendingJob = {
  id: jobId,
  subjectId,
  generation: 1,
  materialSetHash,
  addedMaterialCount: 1,
  totalMaterialCount: 1,
  state: "pending",
  queuedAt: at,
} as const;

const privateCaptureIngestedResult = {
  kind: "ingested",
  subject,
  created: false,
  items: [
    {
      clientRef: "capture-1",
      kind: "accepted",
      materialId,
      contentDigest,
    },
  ],
  materialSetHash,
  generation: 1,
} as const;

const privateCaptureUnchangedResult = {
  kind: "unchanged",
  subject,
  items: [
    {
      clientRef: "capture-1",
      kind: "duplicate",
      materialId,
      contentDigest,
    },
  ],
  materialSetHash,
  generation: 1,
} as const;

describe("trusted session schemas", () => {
  it("parses actor, mutation, capacity, and session contexts", () => {
    const actor = { kind: "host", id: "host-session", host: "codex" } as const;
    const capacity = {
      maximumInputTokens: 128_000,
      maximumToolResultBytes: 1_000_000,
      source: "host_handshake",
    } as const;

    expect(actorContextSchema.parse(actor)).toEqual(actor);
    expect(mutationContextSchema.parse({ requestId })).toEqual({ requestId });
    expect(briefCapacitySchema.parse(capacity)).toEqual(capacity);
    expect(clientSessionContextSchema.parse({ actor, leaseOwner, capacity })).toEqual({
      actor,
      leaseOwner,
      capacity,
    });
    expect(() => clientSessionContextSchema.parse({ actor, capacity })).toThrow();
    expect(() =>
      clientSessionContextSchema.parse({ actor, leaseOwner: "host-session", capacity }),
    ).toThrow();
    expect(() => briefCapacitySchema.parse({ ...capacity, maximumInputTokens: 0 })).toThrow();
    expect(() => actorContextSchema.parse({ ...actor, extra: true })).toThrow();
  });
});

describe("host capability and private-capture schemas", () => {
  it("keeps capability reports strict, canonical, and internally consistent", () => {
    expect(hostCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
    expect(
      hostCapabilitiesSchema.parse({
        ...capabilities,
        lifecycleHooks: ["session_start", "session_end", "command"],
      }),
    ).toBeDefined();
    expect(
      hostCapabilitiesSchema.parse({
        ...capabilities,
        lifecycleHooks: ["session_start", "command"],
      }),
    ).toBeDefined();
    expect(() =>
      hostCapabilitiesSchema.parse({ ...capabilities, maxContextTokens: Number.MAX_VALUE }),
    ).toThrow();
    expect(() => hostCapabilitiesSchema.parse({ ...capabilities, webResearch: true })).toThrow();
    expect(() =>
      hostCapabilitiesSchema.parse({
        ...capabilities,
        lifecycleHooks: ["session_end", "session_start"],
      }),
    ).toThrow();
    expect(() =>
      hostCapabilitiesSchema.parse({
        ...capabilities,
        lifecycleHooks: ["session_end", "session_end"],
      }),
    ).toThrow();
    expect(() =>
      hostCapabilitiesSchema.parse({
        ...capabilities,
        subruns: false,
        subrunsInheritMcp: true,
      }),
    ).toThrow();
  });

  it("parses exact handshake, fixture, and unsupported preflight branches", () => {
    expect(hostPreflightEvidenceSchema.parse(hostHandshakeEvidence)).toEqual(hostHandshakeEvidence);
    expect(hostPreflightEvidenceSchema.parse(bindingFixtureEvidence)).toEqual(
      bindingFixtureEvidence,
    );

    const handshakeSuccess = {
      ok: true,
      capabilities,
      capacity: hostHandshakeCapacity,
      evidence: hostHandshakeEvidence,
      warnings: [],
    } as const;
    const fixtureSuccess = {
      ok: true,
      capabilities,
      capacity: bindingFixtureCapacity,
      evidence: bindingFixtureEvidence,
      warnings: ["Private UI capture is unavailable."],
    } as const;
    const failure = {
      ok: false,
      capabilities: { ...capabilities, structuredToolCalls: false },
      error: unsupportedError,
      warnings: ["Structured tool calls are unavailable."],
    } as const;

    expect(hostPreflightSchema.parse(handshakeSuccess)).toEqual(handshakeSuccess);
    expect(hostPreflightSchema.parse(fixtureSuccess)).toEqual(fixtureSuccess);
    expect(hostPreflightSchema.parse(failure)).toEqual(failure);
  });

  it("rejects unproven capacities and malformed preflight branches", () => {
    const success = {
      ok: true,
      capabilities,
      capacity: hostHandshakeCapacity,
      evidence: hostHandshakeEvidence,
      warnings: [],
    } as const;
    const failure = {
      ok: false,
      capabilities: { ...capabilities, structuredToolCalls: false },
      error: unsupportedError,
      warnings: ["Structured tool calls are unavailable."],
    } as const;

    const invalidPreflights = [
      {
        ...success,
        capabilities: { ...capabilities, structuredToolCalls: false },
      },
      { ...success, capacity: { ...hostHandshakeCapacity, source: "sdk_explicit" } },
      { ...success, capacity: bindingFixtureCapacity },
      { ...success, error: unsupportedError },
      { ok: true, capabilities, capacity: hostHandshakeCapacity, warnings: [] },
      { ...failure, capacity: hostHandshakeCapacity },
      { ...failure, evidence: hostHandshakeEvidence },
      { ...failure, error: { ...unsupportedError, code: "permission_denied" } },
      { ...failure, error: { ...unsupportedError, retryable: true } },
      { ...failure, error: { ...unsupportedError, subjectResolution: { kind: "found" } } },
      { ...failure, remediation: "Legacy top-level remediation is forbidden." },
      { ok: false, capabilities: failure.capabilities, warnings: failure.warnings },
    ] as const;

    for (const invalidPreflight of invalidPreflights) {
      expect(() => hostPreflightSchema.parse(invalidPreflight)).toThrow();
    }
  });

  it("keeps evidence keys exact, branded, and bounded", () => {
    const invalidEvidence = [
      { ...hostHandshakeEvidence, host: "Codex" },
      { ...hostHandshakeEvidence, hostVersion: "" },
      { ...hostHandshakeEvidence, environment: "server" },
      { ...hostHandshakeEvidence, releaseVersion: "" },
      { ...hostHandshakeEvidence, wireMajor: 4 },
      { ...hostHandshakeEvidence, canonicalSkillDigest: "sha256_short" },
      { ...hostHandshakeEvidence, extra: true },
      { ...bindingFixtureEvidence, fixtureId: "x".repeat(1_025) },
      { ...bindingFixtureEvidence, releaseVersion: "" },
      { ...bindingFixtureEvidence, wireMajor: 4 },
      { ...bindingFixtureEvidence, canonicalSkillDigest: "sha256_short" },
    ] as const;

    for (const evidence of invalidEvidence) {
      expect(() => hostPreflightEvidenceSchema.parse(evidence)).toThrow();
    }
  });

  it("requires the complete private-capture capability conjunction", () => {
    const privateCaptureCapabilities = {
      ...capabilities,
      privateUiCapture: "available",
      windowScopedCapture: "available",
      captureDataPolicy: "known",
    } as const;

    expect(hostCapabilitiesSchema.parse(privateCaptureCapabilities)).toEqual(
      privateCaptureCapabilities,
    );
    expect(() =>
      hostCapabilitiesSchema.parse({
        ...privateCaptureCapabilities,
        windowScopedCapture: "unknown",
      }),
    ).toThrow();
    expect(() =>
      hostCapabilitiesSchema.parse({
        ...privateCaptureCapabilities,
        captureDataPolicy: "unknown",
      }),
    ).toThrow();
  });

  it("validates bounded scope and authorization metadata", () => {
    const scope = {
      subject: { kind: "existing", subjectId },
      application: "WeChat",
      accountLabel: "Personal",
      threadLabel: "Ada",
      range: {
        kind: "time",
        from: at,
        to: "2026-08-20T01:00:00.000Z",
      },
      textOnly: true,
      purpose: "profile_distillation",
    } as const;
    const authorization = {
      expiresAt: "2026-08-20T01:05:00.000Z",
      authorityAttested: true,
      hostProcessingDisclosed: true,
      isolation: "window",
      dataPolicyUri: "https://example.com/privacy",
      dataPolicyVersion: "2026-08",
      retentionNoticeVersion: "v1",
      conversationLocator: {
        kind: "stable",
        applicationId: "wechat",
        accountLocator: "account-1",
        threadLocator: "thread-1",
      },
    } as const;

    expect(privateUiCaptureScopeSchema.parse(scope)).toEqual(scope);
    expect(privateUiCaptureAuthorizationSchema.parse(authorization)).toEqual(authorization);
    expect(() =>
      privateUiCaptureScopeSchema.parse({
        ...scope,
        range: { ...scope.range, to: "2026-08-19T23:00:00.000Z" },
      }),
    ).toThrow();
    expect(() =>
      privateUiCaptureAuthorizationSchema.parse({ ...authorization, authorityAttested: false }),
    ).toThrow();
  });

  it("keeps transcript and action outcomes closed", () => {
    expect(capturedPrivateTranscriptSchema.parse({ materials: [material] })).toBeDefined();
    expect(() => capturedPrivateTranscriptSchema.parse({ materials: [] })).toThrow();

    const invalidCaptureMaterials = [
      { ...material, kind: "web" },
      { ...material, source: { ...material.source, medium: "article" } },
      { ...material, source: { ...material.source, access: "public" } },
      { ...material, source: { ...material.source, role: "reference" } },
      {
        ...material,
        source: {
          medium: "conversation",
          access: "private",
          capturedAt: at,
        },
      },
      { ...material, derivation: { kind: "native_text" } },
      {
        ...material,
        derivation: { kind: "host_extract", method: "transcription", producer: "codex" },
      },
      { ...material, sensitivity: "shareable" },
      { ...material, source: { ...material.source, uri: "https://example.com/thread" } },
      {
        ...material,
        source: {
          ...material.source,
          artifact: { provider: "wechat", externalId: "thread-1" },
        },
      },
      {
        ...material,
        source: {
          ...material.source,
          representationOf: { provider: "wechat", externalId: "thread-1" },
        },
      },
      { ...material, source: { ...material.source, title: "Private thread" } },
    ] as const;
    for (const invalidMaterial of invalidCaptureMaterials) {
      expect(() =>
        capturedPrivateTranscriptSchema.parse({ materials: [invalidMaterial] }),
      ).toThrow();
    }

    expect(
      privateUiCaptureGrantStatusSchema.parse({
        kind: "revoked",
        reason: "screen_locked",
        boundaryRefusalCount: 1,
      }),
    ).toBeDefined();
    expect(() =>
      privateUiCaptureGrantStatusSchema.parse({
        kind: "revoked",
        reason: "ingest_rejected",
        boundaryRefusalCount: 1,
      }),
    ).toThrow();

    expect(
      privateUiCaptureActionResultSchema.parse({
        kind: "ingested",
        result: { ...privateCaptureIngestedResult, job: pendingJob },
      }),
    ).toBeDefined();
    expect(() =>
      privateUiCaptureActionResultSchema.parse({
        kind: "ingested",
        result: privateCaptureIngestedResult,
      }),
    ).toThrow();
    expect(
      privateUiCaptureActionResultSchema.parse({
        kind: "ingested",
        result: privateCaptureUnchangedResult,
      }),
    ).toBeDefined();
    expect(
      privateUiCaptureActionResultSchema.parse({
        kind: "ingested",
        result: { ...privateCaptureUnchangedResult, job: pendingJob },
      }),
    ).toBeDefined();
    expect(() =>
      privateUiCaptureActionResultSchema.parse({
        kind: "aborted",
        reason: "process_terminated",
      }),
    ).toThrow();
  });
});
