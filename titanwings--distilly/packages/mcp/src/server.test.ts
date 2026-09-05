import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { DistillyError, WIRE_LIMITS, distillyMcpTools } from "@distilly/protocol";
import type {
  CommitResult,
  BriefContractDigest,
  BriefMaterialRef,
  ClaimId,
  ContentDigest,
  EngineClient,
  EngineMethodMap,
  IngestResult,
  HostName,
  IsoDateTime,
  JobId,
  LeaseId,
  LeaseOwnerId,
  MaterialId,
  MaterialSetHash,
  MutationContext,
  MutationMethodName,
  Profile,
  QueryMethodName,
  RequestId,
  ReviewLaunch,
  ReviewRef,
  SourceGroupKey,
  SpaceId,
  SubjectId,
  SubjectStatus,
  SubjectSummary,
  Unsubscribe,
  VersionId,
} from "@distilly/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requireSdkServer } from "./internal.js";
import { createMcpServer } from "./server.js";
import type { McpServer, ReviewPresenter } from "./types.js";

const HEX_32 = "a".repeat(32);
const HEX_64 = "b".repeat(64);
const OTHER_HEX_32 = "c".repeat(32);
const REQUEST_ID = `req_${HEX_32}` as RequestId;
const SUBJECT_ID = `subject_${HEX_32}` as SubjectId;
const OTHER_SUBJECT_ID = `subject_${OTHER_HEX_32}` as SubjectId;
const SPACE_ID = `space_${HEX_32}` as SpaceId;
const JOB_ID = `job_${HEX_32}` as JobId;
const LEASE_ID = `lease_${HEX_32}` as LeaseId;
const LEASE_OWNER_ID = `lease_owner_${HEX_32}` as LeaseOwnerId;
const VERSION_ID = `version_${HEX_64}` as VersionId;
const OTHER_VERSION_ID = `version_${"c".repeat(64)}` as VersionId;
const MATERIAL_ID = `mat_${HEX_64}` as MaterialId;
const CONTENT_DIGEST = `sha256_${HEX_64}` as ContentDigest;
const MATERIAL_SET_HASH = `set_sha256_${HEX_64}` as MaterialSetHash;
const BRIEF_CONTRACT_DIGEST = `brief_contract_${HEX_64}` as BriefContractDigest;
const PROMPT_VERSION = `host-distill-v1-sha256_${HEX_64}` as const;
const SOURCE_GROUP_KEY = `sg_${HEX_64}` as SourceGroupKey;
const BRIEF_MATERIAL_REF = "m001" as BriefMaterialRef;
const CODEX_HOST = "codex" as HostName;
const NOW = "2026-08-20T08:00:00.000Z" as IsoDateTime;
const REVIEW_TOKEN = "d".repeat(64);
const REVIEW_URL = `http://127.0.0.1:43123/#${REVIEW_TOKEN}/review/${SUBJECT_ID}/${VERSION_ID}`;

const wireRequest = { wireVersion: "3", requestId: REQUEST_ID } as const;
const selector = { kind: "id", subjectId: SUBJECT_ID } as const;

const subject: SubjectSummary = {
  id: SUBJECT_ID,
  displayName: "Ada Lovelace",
  aliases: [],
  identityHints: [],
  space: { id: SPACE_ID, displayName: "People", kind: "people" },
  lifecycle: "active",
};
const otherSubject: SubjectSummary = {
  ...subject,
  id: OTHER_SUBJECT_ID,
  displayName: "Augusta Ada King",
};

const quality = {
  sourceGroupingVersion: "source-groups-v1",
  activeClaimCount: 0,
  contestedClaimCount: 0,
  userAssertedClaimCount: 0,
  corroboratedClaimCount: 0,
  sourceGroupCount: 0,
  diversityEligibleSourceGroupCount: 0,
  unknownSourceGroupCount: 0,
  coveredCoreFacets: [],
  uncoveredCoreFacets: [
    "identity",
    "voice",
    "psyche",
    "relations",
    "boundaries",
    "texture",
    "timeline",
  ],
  maturity: "sparse",
} as const;

const suspendedVersion = {
  id: VERSION_ID,
  subjectId: SUBJECT_ID,
  generation: 1,
  materialSetHash: MATERIAL_SET_HASH,
  creation: {
    kind: "host_distill",
    briefContractDigest: BRIEF_CONTRACT_DIGEST,
    promptVersion: PROMPT_VERSION,
    draftSchemaVersion: 1,
  },
  status: "suspended",
  actor: { kind: "host", id: "host-session", host: CODEX_HOST },
  quality,
  createdAt: NOW,
} as const;
const currentVersion = { ...suspendedVersion, status: "current" } as const;
const correctionVersion = {
  ...suspendedVersion,
  creation: { kind: "correction", correctionMaterialId: MATERIAL_ID },
} as const;

const profile: Profile = {
  subjectId: SUBJECT_ID,
  displayName: "Ada Lovelace",
  versionId: VERSION_ID,
  claims: [],
  core: {
    identity: "Mathematician",
    voice: "Analytical",
    psyche: "Curious",
    relations: "Collaborator",
    boundaries: "Private",
    texture: "Precise",
    timeline: "Nineteenth century",
  },
  domains: {},
  rendered: "# Ada Lovelace",
  quality,
};

const status: SubjectStatus = {
  subject,
  generation: 1,
  materialSetHash: MATERIAL_SET_HASH,
  pendingJobId: JOB_ID,
  maturity: "sparse",
};
const pendingJob = {
  id: JOB_ID,
  subjectId: SUBJECT_ID,
  generation: 1,
  materialSetHash: MATERIAL_SET_HASH,
  addedMaterialCount: 1,
  totalMaterialCount: 1,
  state: "pending",
  queuedAt: NOW,
} as const;
const leaseExpiresAt = "2026-08-20T08:30:00.000Z" as IsoDateTime;
const lease = {
  id: LEASE_ID,
  jobId: JOB_ID,
  generation: 1,
  briefContractDigest: BRIEF_CONTRACT_DIGEST,
  owner: LEASE_OWNER_ID,
  acquiredAt: NOW,
  expiresAt: leaseExpiresAt,
} as const;
const briefing = {
  job: { ...pendingJob, state: "leased", leaseExpiresAt },
  lease,
  subject,
  materials: [
    {
      ref: BRIEF_MATERIAL_REF,
      materialId: MATERIAL_ID,
      contentDigest: CONTENT_DIGEST,
      kind: "web",
      content: "Analytical Engine notes",
      source: {
        uri: "https://example.test/ada",
        medium: "webpage",
        access: "public",
        capturedAt: NOW,
        authors: ["Ada Lovelace"],
      },
      derivation: { kind: "native_text" },
      sourceGroup: {
        key: SOURCE_GROUP_KEY,
        bases: ["canonical_uri"],
        diversityStatus: "eligible",
        cautions: [],
      },
      sensitivity: "shareable",
    },
  ],
  contract: {
    digest: BRIEF_CONTRACT_DIGEST,
    sourceGroupingVersion: "source-groups-v1",
    promptVersion: PROMPT_VERSION,
    draftSchemaVersion: 1,
    instructions: "Produce an evidence-bound patch.",
    evidenceRules: ["Quote the supplied material."],
  },
  limits: {
    estimatedInputTokens: 100,
    maximumInputTokens: 1_000,
    maximumOutputBytes: 65_536,
  },
} as const;
const materialInput = {
  clientRef: "source-1",
  kind: "web",
  content: "Analytical Engine notes",
  source: {
    uri: "https://example.test/ada",
    medium: "webpage",
    access: "public",
    capturedAt: NOW,
  },
  derivation: { kind: "native_text" },
} as const;

const ingestResult: IngestResult = {
  kind: "ingested",
  subject,
  created: false,
  items: [
    {
      clientRef: "source-1",
      kind: "accepted",
      materialId: MATERIAL_ID,
      contentDigest: CONTENT_DIGEST,
    },
  ],
  materialSetHash: MATERIAL_SET_HASH,
  generation: 1,
  job: pendingJob,
};
const currentCommit: CommitResult = {
  kind: "current",
  version: currentVersion,
  profile,
};
const suspendedCommit: Extract<CommitResult, { readonly kind: "suspended" }> = {
  kind: "suspended",
  candidate: suspendedVersion,
  reasons: [{ code: "manual_review_requested", note: "check" }],
  review: { subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID },
};
const correctionCommit: Extract<CommitResult, { readonly kind: "suspended" }> = {
  kind: "suspended",
  candidate: correctionVersion,
  reasons: [{ code: "relayed_correction", actorKind: "host" }],
  review: { subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID },
};

type RecordedCall = {
  readonly method: keyof EngineMethodMap;
  readonly params: unknown;
  readonly context?: MutationContext;
};

class RecordingEngineClient implements EngineClient {
  readonly calls: RecordedCall[] = [];
  closeCount = 0;
  readonly #responses = new Map<keyof EngineMethodMap, unknown>();
  readonly #failures = new Map<keyof EngineMethodMap, unknown>();

  setResponse<M extends keyof EngineMethodMap>(
    method: M,
    result: EngineMethodMap[M]["result"],
  ): void {
    this.#failures.delete(method);
    this.#responses.set(method, result);
  }

  setRawResponse(method: keyof EngineMethodMap, result: unknown): void {
    this.#failures.delete(method);
    this.#responses.set(method, result);
  }

  setFailure(method: keyof EngineMethodMap, failure: unknown): void {
    this.#failures.set(method, failure);
  }

  call<M extends QueryMethodName>(
    method: M,
    params: EngineMethodMap[M]["params"],
  ): Promise<EngineMethodMap[M]["result"]>;
  call<M extends MutationMethodName>(
    method: M,
    params: EngineMethodMap[M]["params"],
    context: MutationContext,
  ): Promise<EngineMethodMap[M]["result"]>;
  call(
    method: keyof EngineMethodMap,
    params: unknown,
    context?: MutationContext,
  ): Promise<unknown> {
    this.calls.push({ method, params, ...(context === undefined ? {} : { context }) });
    if (this.#failures.has(method)) {
      const failure = this.#failures.get(method);
      return Promise.reject(failure instanceof Error ? failure : new Error(String(failure)));
    }
    if (!this.#responses.has(method)) {
      return Promise.reject(new TypeError(`Unexpected EngineClient call: ${method}`));
    }
    return Promise.resolve(this.#responses.get(method));
  }

  watch(): Promise<Unsubscribe> {
    return Promise.resolve(() => undefined);
  }

  close(): Promise<void> {
    this.closeCount += 1;
    return Promise.resolve();
  }
}

class RecordingPresenter implements ReviewPresenter {
  readonly reviews: ReviewRef[] = [];
  closeCount = 0;
  launchOverride?: ReviewLaunch;

  present(reviewRef: ReviewRef): Promise<ReviewLaunch> {
    this.reviews.push(reviewRef);
    return Promise.resolve(
      this.launchOverride ?? {
        ref: reviewRef,
        url: REVIEW_URL,
      },
    );
  }

  close(): Promise<void> {
    this.closeCount += 1;
    return Promise.resolve();
  }
}

const deferred = <T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} => {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};

const outputOf = <T>(index: number, result: Awaited<ReturnType<Client["callTool"]>>): T => {
  const contract = distillyMcpTools[index];
  if (contract === undefined) throw new TypeError(`Missing tool contract ${index}`);
  expect(result.content).toEqual([
    { type: "text", text: JSON.stringify(result.structuredContent) },
  ]);
  return contract.output.parse(result.structuredContent) as T;
};

describe("Distilly MCP server", () => {
  let engine: RecordingEngineClient;
  let presenter: RecordingPresenter;
  let server: McpServer;
  let client: Client;
  let expectedCloseFailure: boolean;

  beforeEach(async () => {
    engine = new RecordingEngineClient();
    presenter = new RecordingPresenter();
    expectedCloseFailure = false;
    engine.setResponse("subjects.resolve", { kind: "found", subject });
    engine.setResponse("profiles.get", profile);
    engine.setResponse("profiles.prompt", "# Ada Lovelace");
    engine.setResponse("profiles.status", status);
    engine.setResponse("materials.ingest", ingestResult);
    engine.setResponse("distill.pending", [pendingJob]);
    engine.setResponse("distill.brief", briefing);
    engine.setResponse("distill.renew", lease);
    engine.setResponse("distill.release", null);
    engine.setResponse("distill.commit", currentCommit);
    engine.setResponse("profiles.correct", correctionCommit);

    server = createMcpServer({ client: engine, reviewPresenter: presenter });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await requireSdkServer(server).connect(serverTransport);
    client = new Client({ name: "distilly-mcp-test", version: "0.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    try {
      await server.close();
    } catch (error) {
      if (!expectedCloseFailure) throw error;
    }
  });

  it("publishes exactly the canonical five descriptors and server identity", async () => {
    expect(client.getServerVersion()).toEqual({
      name: "distilly",
      version: "0.1.0-preview.1",
    });
    const { tools } = await client.listTools();
    expect(
      tools.map(({ name, title, description, inputSchema, outputSchema, annotations }) => ({
        name,
        title,
        description,
        inputSchema,
        outputSchema,
        annotations,
      })),
    ).toEqual(
      distillyMcpTools.map(
        ({ name, title, description, inputSchema, outputSchema, annotations }) => ({
          name,
          title,
          description,
          inputSchema,
          outputSchema,
          annotations,
        }),
      ),
    );
  });

  it("projects schemas for hosts that cannot consume the canonical dialect", async () => {
    const projected = createMcpServer({
      client: engine,
      reviewPresenter: presenter,
      schemaProfile: "openclaw",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await requireSdkServer(projected).connect(serverTransport);
    const projectedClient = new Client({ name: "distilly-mcp-projection-test", version: "0.0.0" });
    await projectedClient.connect(clientTransport);
    try {
      const { tools } = await projectedClient.listTools();
      expect(tools.map(({ name }) => name)).toEqual(distillyMcpTools.map(({ name }) => name));
      for (const tool of tools) {
        expect(tool.inputSchema).not.toHaveProperty("$schema");
        expect(tool.outputSchema).not.toHaveProperty("$schema");
        expect(tool.inputSchema).toHaveProperty("type", "object");
        expect(tool.inputSchema).toHaveProperty("properties");
      }
      const getTool = tools.find(({ name }) => name === "distilly_get");
      expect(getTool?.inputSchema).toHaveProperty("properties.action");
      expect(getTool?.inputSchema).toHaveProperty("properties.subject");
    } finally {
      await projectedClient.close();
      await projected.close();
    }
  });

  it("maps every get action through resolution without mutation context", async () => {
    const cases = [
      {
        input: { ...wireRequest, action: "resolve", subject: selector } as const,
        value: { kind: "resolved", subject },
        calls: [{ method: "subjects.resolve", params: { selector } }],
      },
      {
        input: {
          ...wireRequest,
          action: "profile",
          subject: selector,
          versionId: VERSION_ID,
        } as const,
        value: { kind: "profile", subject, profile },
        calls: [
          { method: "subjects.resolve", params: { selector } },
          {
            method: "profiles.get",
            params: { subjectId: SUBJECT_ID, versionId: VERSION_ID },
          },
        ],
      },
      {
        input: {
          ...wireRequest,
          action: "prompt",
          subject: selector,
          versionId: VERSION_ID,
        } as const,
        value: { kind: "prompt", subject, prompt: "# Ada Lovelace" },
        calls: [
          { method: "subjects.resolve", params: { selector } },
          {
            method: "profiles.prompt",
            params: { subjectId: SUBJECT_ID, versionId: VERSION_ID },
          },
        ],
      },
      {
        input: { ...wireRequest, action: "status", subject: selector } as const,
        value: { kind: "status", subject, status },
        calls: [
          { method: "subjects.resolve", params: { selector } },
          { method: "profiles.status", params: { subjectId: SUBJECT_ID } },
        ],
      },
    ] as const;

    for (const testCase of cases) {
      engine.calls.length = 0;
      const result = await client.callTool({
        name: "distilly_get",
        arguments: { ...testCase.input },
      });
      expect(outputOf(0, result)).toEqual({ ok: true, wireVersion: "3", value: testCase.value });
      expect(engine.calls).toEqual(testCase.calls);
    }
  });

  it("returns unresolved get branches without reading a profile", async () => {
    engine.setResponse("subjects.resolve", { kind: "not_found" });
    const notFound = await client.callTool({
      name: "distilly_get",
      arguments: {
        ...wireRequest,
        action: "profile",
        subject: { kind: "query", query: "Nobody" },
      },
    });
    expect(outputOf(0, notFound)).toEqual({
      ok: true,
      wireVersion: "3",
      value: { kind: "not_found", query: "Nobody" },
    });

    engine.calls.length = 0;
    engine.setResponse("subjects.resolve", {
      kind: "ambiguous",
      candidates: [subject, otherSubject],
    });
    const ambiguous = await client.callTool({
      name: "distilly_get",
      arguments: { ...wireRequest, action: "status", subject: selector },
    });
    expect(outputOf(0, ambiguous)).toEqual({
      ok: true,
      wireVersion: "3",
      value: { kind: "ambiguous", candidates: [subject, otherSubject] },
    });
    expect(engine.calls).toEqual([{ method: "subjects.resolve", params: { selector } }]);
  });

  it("maps ingest atomically and forwards only the request identity context", async () => {
    const input = {
      ...wireRequest,
      subject: { kind: "existing", subjectId: SUBJECT_ID },
      materials: [materialInput],
      enqueue: "now",
    } as const;
    const result = await client.callTool({ name: "distilly_ingest", arguments: { ...input } });
    expect(outputOf(1, result)).toEqual({ ok: true, wireVersion: "3", value: ingestResult });
    expect(engine.calls).toEqual([
      {
        method: "materials.ingest",
        params: { subject: input.subject, materials: input.materials, enqueue: "now" },
        context: { requestId: REQUEST_ID },
      },
    ]);
  });

  it("maps all pending actions and keeps list read-only", async () => {
    const cases = [
      {
        input: { ...wireRequest, action: "list", subjectId: SUBJECT_ID } as const,
        value: { kind: "jobs", jobs: [pendingJob] },
        call: { method: "distill.pending", params: { subjectId: SUBJECT_ID } },
      },
      {
        input: { ...wireRequest, action: "brief", jobId: JOB_ID } as const,
        value: { kind: "briefing", briefing },
        call: {
          method: "distill.brief",
          params: { jobId: JOB_ID },
          context: { requestId: REQUEST_ID },
        },
      },
      {
        input: { ...wireRequest, action: "renew", jobId: JOB_ID, leaseId: LEASE_ID } as const,
        value: { kind: "lease_renewed", lease },
        call: {
          method: "distill.renew",
          params: { jobId: JOB_ID, leaseId: LEASE_ID },
          context: { requestId: REQUEST_ID },
        },
      },
      {
        input: {
          ...wireRequest,
          action: "release",
          jobId: JOB_ID,
          leaseId: LEASE_ID,
          reason: "return to queue",
        } as const,
        value: { kind: "released", jobId: JOB_ID },
        call: {
          method: "distill.release",
          params: { jobId: JOB_ID, leaseId: LEASE_ID, reason: "return to queue" },
          context: { requestId: REQUEST_ID },
        },
      },
    ] as const;

    for (const testCase of cases) {
      engine.calls.length = 0;
      const result = await client.callTool({
        name: "distilly_pending",
        arguments: { ...testCase.input },
      });
      expect(outputOf(2, result)).toEqual({ ok: true, wireVersion: "3", value: testCase.value });
      expect(engine.calls).toEqual([testCase.call]);
    }
  });

  it("uses successful nothing-pending branches for empty lists and brief races", async () => {
    engine.setResponse("distill.pending", []);
    const empty = await client.callTool({
      name: "distilly_pending",
      arguments: { ...wireRequest, action: "list" },
    });
    expect(outputOf(2, empty)).toEqual({
      ok: true,
      wireVersion: "3",
      value: { kind: "nothing_pending" },
    });

    engine.setFailure(
      "distill.brief",
      new DistillyError({ code: "nothing_pending", message: "raced", retryable: false }),
    );
    const raced = await client.callTool({
      name: "distilly_pending",
      arguments: { ...wireRequest, action: "brief", jobId: JOB_ID },
    });
    expect(outputOf(2, raced)).toEqual({
      ok: true,
      wireVersion: "3",
      value: { kind: "nothing_pending" },
    });
  });

  it("maps current and suspended commits and presents only suspended candidates", async () => {
    const input = {
      ...wireRequest,
      jobId: JOB_ID,
      generation: 1,
      leaseId: LEASE_ID,
      briefContractDigest: BRIEF_CONTRACT_DIGEST,
      materialSetHash: MATERIAL_SET_HASH,
      baseVersionId: OTHER_VERSION_ID,
      patch: { operations: [] },
    } as const;
    const current = await client.callTool({ name: "distilly_commit", arguments: { ...input } });
    expect(outputOf(3, current)).toEqual({ ok: true, wireVersion: "3", value: currentCommit });
    expect(presenter.reviews).toEqual([]);
    expect(engine.calls).toEqual([
      {
        method: "distill.commit",
        params: {
          jobId: JOB_ID,
          generation: 1,
          leaseId: LEASE_ID,
          briefContractDigest: BRIEF_CONTRACT_DIGEST,
          materialSetHash: MATERIAL_SET_HASH,
          baseVersionId: OTHER_VERSION_ID,
          patch: { operations: [] },
        },
        context: { requestId: REQUEST_ID },
      },
    ]);

    engine.calls.length = 0;
    engine.setResponse("distill.commit", suspendedCommit);
    const suspended = await client.callTool({
      name: "distilly_commit",
      arguments: { ...input },
    });
    expect(presenter.reviews).toEqual([suspendedCommit.review]);
    expect(outputOf(3, suspended)).toEqual({
      ok: true,
      wireVersion: "3",
      value: {
        kind: "suspended",
        candidate: suspendedVersion,
        reasons: suspendedCommit.reasons,
        review: {
          ref: suspendedCommit.review,
          url: REVIEW_URL,
        },
      },
    });
    expect(presenter.reviews).toEqual([suspendedCommit.review]);
  });

  it("maps correction fields and presents its exact suspended candidate once", async () => {
    const claimId = `claim_${HEX_64}` as ClaimId;
    const input = {
      ...wireRequest,
      subjectId: SUBJECT_ID,
      text: "The publication date should be 1843.",
      facet: "timeline.publication",
      supersedes: [claimId],
      baseCandidateVersionId: OTHER_VERSION_ID,
    } as const;
    const result = await client.callTool({ name: "distilly_correct", arguments: { ...input } });
    expect(outputOf(4, result)).toEqual({
      ok: true,
      wireVersion: "3",
      value: {
        kind: "suspended",
        candidate: correctionVersion,
        reasons: correctionCommit.kind === "suspended" ? correctionCommit.reasons : [],
        review: {
          ref: { subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID },
          url: REVIEW_URL,
        },
      },
    });
    expect(engine.calls).toEqual([
      {
        method: "profiles.correct",
        params: {
          subjectId: SUBJECT_ID,
          correction: {
            text: input.text,
            facet: input.facet,
            supersedes: input.supersedes,
            baseCandidateVersionId: input.baseCandidateVersionId,
          },
        },
        context: { requestId: REQUEST_ID },
      },
    ]);
    expect(presenter.reviews).toEqual([{ subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID }]);
  });

  it("returns structured invalid-input failures from the Protocol parser", async () => {
    const utf8Limit = await client.callTool({
      name: "distilly_correct",
      arguments: {
        ...wireRequest,
        subjectId: SUBJECT_ID,
        text: "é".repeat(Math.floor(WIRE_LIMITS.correctionTextBytes / 2) + 1),
      },
    });
    expect(utf8Limit.isError).toBeUndefined();
    expect(outputOf(4, utf8Limit)).toEqual({
      ok: false,
      wireVersion: "3",
      error: {
        code: "invalid_input",
        message: "The Distilly tool input is invalid.",
        retryable: false,
        fieldPath: "input",
      },
    });

    const unknownProperty = await client.callTool({
      name: "distilly_get",
      arguments: {
        ...wireRequest,
        action: "resolve",
        subject: selector,
        unexpected: true,
      },
    });
    expect(unknownProperty.isError).toBeUndefined();
    expect(outputOf(0, unknownProperty)).toEqual({
      ok: false,
      wireVersion: "3",
      error: {
        code: "invalid_input",
        message: "The Distilly tool input is invalid.",
        retryable: false,
        fieldPath: "input",
      },
    });
    expect(engine.calls).toEqual([]);
  });

  it("preserves transport-safe DistillyError fields without leaking cause or stack", async () => {
    engine.setFailure(
      "materials.ingest",
      new DistillyError(
        {
          code: "permission_denied",
          message: "local store is read-only",
          retryable: false,
          fieldPath: "materials[0]",
          remediation: "Restore write access.",
          details: { volume: "profiles" },
        },
        { cause: new Error("secret filesystem detail") },
      ),
    );
    const result = await client.callTool({
      name: "distilly_ingest",
      arguments: {
        ...wireRequest,
        subject: { kind: "existing", subjectId: SUBJECT_ID },
        materials: [materialInput],
        enqueue: "auto",
      },
    });
    expect(result.isError).toBeUndefined();
    expect(outputOf(1, result)).toEqual({
      ok: false,
      wireVersion: "3",
      error: {
        code: "permission_denied",
        message: "local store is read-only",
        retryable: false,
        fieldPath: "materials[0]",
        remediation: "Restore write access.",
        details: { volume: "profiles" },
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret filesystem detail");
    expect(serialized).not.toContain("stack");
    expect(serialized).not.toContain("cause");
  });

  it("normalizes unexpected, invalid output, and presenter-ref failures", async () => {
    const expected = {
      ok: false,
      wireVersion: "3",
      error: {
        code: "internal_error",
        message: "The Distilly MCP adapter encountered an unexpected internal error.",
        retryable: false,
      },
    } as const;

    engine.setFailure("distill.pending", new Error("secret implementation failure"));
    const unexpected = await client.callTool({
      name: "distilly_pending",
      arguments: { ...wireRequest, action: "list" },
    });
    expect(outputOf(2, unexpected)).toEqual(expected);

    engine.setRawResponse("distill.commit", {
      kind: "current",
      version: currentVersion,
      profile: { ...profile, unexpected: true },
    });
    const invalidOutput = await client.callTool({
      name: "distilly_commit",
      arguments: {
        ...wireRequest,
        jobId: JOB_ID,
        generation: 1,
        leaseId: LEASE_ID,
        briefContractDigest: BRIEF_CONTRACT_DIGEST,
        materialSetHash: MATERIAL_SET_HASH,
        patch: { operations: [] },
      },
    });
    expect(outputOf(3, invalidOutput)).toEqual(expected);

    engine.setResponse("profiles.correct", correctionCommit);
    presenter.launchOverride = {
      ref: { subjectId: SUBJECT_ID, candidateVersionId: OTHER_VERSION_ID },
      url: `http://127.0.0.1:43123/#${REVIEW_TOKEN}/review/${SUBJECT_ID}/${OTHER_VERSION_ID}`,
    };
    const mismatchedReview = await client.callTool({
      name: "distilly_correct",
      arguments: { ...wireRequest, subjectId: SUBJECT_ID, text: "Correction" },
    });
    expect(outputOf(4, mismatchedReview)).toEqual(expected);
    expect(presenter.reviews).toEqual([{ subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID }]);
  });

  it("drains admitted handlers, rejects new work, and keeps borrowed dependencies open", async () => {
    const resolution = deferred<EngineMethodMap["subjects.resolve"]["result"]>();
    engine.setRawResponse("subjects.resolve", resolution.promise);
    const admittedCall = client.callTool({
      name: "distilly_get",
      arguments: { ...wireRequest, action: "resolve", subject: selector },
    });
    const admittedOutcome = admittedCall.catch(() => undefined);
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));

    let closeSettled = false;
    const firstClose = server.close();
    const secondClose = server.close();
    expect(secondClose).toBe(firstClose);
    void firstClose.then(() => {
      closeSettled = true;
    });
    expect(closeSettled).toBe(false);

    const rejectedDuringDrain = await client.callTool({
      name: "distilly_get",
      arguments: { ...wireRequest, action: "resolve", subject: selector },
    });
    expect(outputOf(0, rejectedDuringDrain)).toEqual({
      ok: false,
      wireVersion: "3",
      error: {
        code: "internal_error",
        message: "The Distilly MCP adapter encountered an unexpected internal error.",
        retryable: false,
      },
    });
    expect(engine.calls).toHaveLength(1);
    expect(closeSettled).toBe(false);

    resolution.resolve({ kind: "found", subject });
    await admittedOutcome;
    await Promise.all([firstClose, secondClose]);
    expect(engine.closeCount).toBe(0);
    expect(presenter.closeCount).toBe(0);
  });

  it("stops waiting for an in-flight handler at the exact five-second deadline", async () => {
    const resolution = deferred<EngineMethodMap["subjects.resolve"]["result"]>();
    engine.setRawResponse("subjects.resolve", resolution.promise);
    const admittedCall = client.callTool({
      name: "distilly_get",
      arguments: { ...wireRequest, action: "resolve", subject: selector },
    });
    const admittedOutcome = admittedCall.catch(() => undefined);
    await vi.waitFor(() => expect(engine.calls).toHaveLength(1));

    vi.useFakeTimers();
    try {
      let closeSettled = false;
      expectedCloseFailure = true;
      const closeOutcome = server.close().then(
        () => {
          closeSettled = true;
          return undefined;
        },
        (error: unknown) => {
          closeSettled = true;
          return error;
        },
      );
      await vi.advanceTimersByTimeAsync(4_999);
      expect(closeSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const closeError = await closeOutcome;
      expect(closeSettled).toBe(true);
      expect(closeError).toEqual(new Error("Distilly MCP server shutdown exceeded 5000ms."));
      expect(engine.closeCount).toBe(0);
      expect(presenter.closeCount).toBe(0);
    } finally {
      vi.useRealTimers();
      resolution.resolve({ kind: "found", subject });
      await admittedOutcome;
    }
  });
});
