import { DistillyError } from "@distilly/protocol";
import type {
  BriefContractDigest,
  BriefMaterialRef,
  ContentDigest,
  EngineClient,
  EngineMethodMap,
  ExportRef,
  FactChecksum,
  HostDistillBriefing,
  HostName,
  IngestResult,
  InstallRef,
  IsoDateTime,
  JobId,
  JobLease,
  LeaseId,
  LeaseOwnerId,
  MaterialId,
  MaterialRecord,
  MaterialSetHash,
  MutationContext,
  MutationMethodName,
  PendingJob,
  Profile,
  ProvenanceDigest,
  QualitySummary,
  QueryMethodName,
  SourceGroup,
  SourceGroupKey,
  SpaceId,
  SubjectId,
  SubjectSummary,
  Unsubscribe,
  VersionId,
  VersionSummary,
} from "@distilly/protocol";

const HEX_32 = "a".repeat(32);
const HEX_64 = "b".repeat(64);
const SUBJECT_ID = `subject_${HEX_32}` as SubjectId;
const SPACE_ID = `space_${HEX_32}` as SpaceId;
const JOB_ID = `job_${HEX_32}` as JobId;
const LEASE_ID = `lease_${HEX_32}` as LeaseId;
const LEASE_OWNER_ID = `lease_owner_${HEX_32}` as LeaseOwnerId;
const VERSION_ID = `version_${HEX_64}` as VersionId;
const MATERIAL_ID = `mat_${HEX_64}` as MaterialId;
const CONTENT_DIGEST = `sha256_${HEX_64}` as ContentDigest;
const PROVENANCE_DIGEST = `provenance_sha256_${HEX_64}` as ProvenanceDigest;
const FACT_CHECKSUM = `fact_sha256_${HEX_64}` as FactChecksum;
const MATERIAL_SET_HASH = `set_sha256_${HEX_64}` as MaterialSetHash;
const BRIEF_CONTRACT_DIGEST = `brief_contract_${HEX_64}` as BriefContractDigest;
const SOURCE_GROUP_KEY = `sg_${HEX_64}` as SourceGroupKey;
const BRIEF_MATERIAL_REF = "m001" as BriefMaterialRef;
const CODEX_HOST = "codex" as HostName;
const NOW = "2026-08-20T08:00:00.000Z" as IsoDateTime;
const LEASE_EXPIRES_AT = "2026-08-20T08:30:00.000Z" as IsoDateTime;

const subject: SubjectSummary = {
  id: SUBJECT_ID,
  displayName: "Ada Lovelace",
  aliases: [],
  identityHints: [],
  space: { id: SPACE_ID, displayName: "People", kind: "people" },
  lifecycle: "active",
};

const quality: QualitySummary = {
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
};

const currentVersion: VersionSummary = {
  id: VERSION_ID,
  subjectId: SUBJECT_ID,
  generation: 1,
  materialSetHash: MATERIAL_SET_HASH,
  creation: {
    kind: "host_distill",
    briefContractDigest: BRIEF_CONTRACT_DIGEST,
    promptVersion: `host-distill-v1-sha256_${HEX_64}`,
    draftSchemaVersion: 1,
  },
  status: "current",
  actor: { kind: "host", id: "stdio-fixture", host: CODEX_HOST },
  quality,
  createdAt: NOW,
};

const correctionVersion: VersionSummary = {
  ...currentVersion,
  creation: { kind: "correction", correctionMaterialId: MATERIAL_ID },
  status: "suspended",
};

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

const pendingJob: PendingJob = {
  id: JOB_ID,
  subjectId: SUBJECT_ID,
  generation: 1,
  materialSetHash: MATERIAL_SET_HASH,
  addedMaterialCount: 1,
  totalMaterialCount: 1,
  state: "pending",
  queuedAt: NOW,
};

const lease: JobLease = {
  id: LEASE_ID,
  jobId: JOB_ID,
  generation: 1,
  briefContractDigest: BRIEF_CONTRACT_DIGEST,
  owner: LEASE_OWNER_ID,
  acquiredAt: NOW,
  expiresAt: LEASE_EXPIRES_AT,
};

const sourceGroup: SourceGroup = {
  key: SOURCE_GROUP_KEY,
  bases: ["canonical_uri"],
  diversityStatus: "eligible",
  cautions: [],
};

const materialRecord: MaterialRecord = {
  schemaVersion: 1,
  checksum: FACT_CHECKSUM,
  id: MATERIAL_ID,
  subjectId: SUBJECT_ID,
  kind: "web",
  contentDigest: CONTENT_DIGEST,
  provenanceDigest: PROVENANCE_DIGEST,
  sourceIdentity: "source-uri-v1\0https://example.test/ada",
  source: {
    uri: "https://example.test/ada",
    medium: "webpage",
    access: "public",
    capturedAt: NOW,
    authors: [],
  },
  derivation: { kind: "native_text" },
  participants: [],
  sensitivity: "shareable",
  flags: [],
  storedAt: NOW,
};

const briefing: HostDistillBriefing = {
  job: { ...pendingJob, state: "leased", leaseExpiresAt: LEASE_EXPIRES_AT },
  lease,
  subject,
  materials: [
    {
      ref: BRIEF_MATERIAL_REF,
      materialId: MATERIAL_ID,
      contentDigest: CONTENT_DIGEST,
      kind: "web",
      content: "Analytical Engine notes",
      source: materialRecord.source,
      derivation: materialRecord.derivation,
      sourceGroup,
      sensitivity: "shareable",
    },
  ],
  contract: {
    digest: BRIEF_CONTRACT_DIGEST,
    sourceGroupingVersion: "source-groups-v1",
    promptVersion: `host-distill-v1-sha256_${HEX_64}`,
    draftSchemaVersion: 1,
    instructions: "Produce an evidence-bound patch.",
    evidenceRules: ["Quote the supplied material."],
  },
  limits: {
    estimatedInputTokens: 100,
    maximumInputTokens: 1_000,
    maximumOutputBytes: 65_536,
  },
};

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

const correctionResult: EngineMethodMap["profiles.correct"]["result"] = {
  kind: "suspended",
  candidate: correctionVersion,
  reasons: [{ code: "relayed_correction", actorKind: "host" }],
  review: { subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID },
};

const installRef: InstallRef = {
  id: "stdio-fixture-install",
  host: CODEX_HOST,
  subjectId: SUBJECT_ID,
  versionId: VERSION_ID,
  path: "/tmp/distilly/ada",
  contentDigest: CONTENT_DIGEST,
  installedAt: NOW,
};

const exportRef: ExportRef = {
  host: CODEX_HOST,
  subjectId: SUBJECT_ID,
  versionId: VERSION_ID,
  path: "/tmp/distilly/ada.md",
  contentDigest: CONTENT_DIGEST,
};

type FullFakeEngineResults = {
  readonly [M in keyof EngineMethodMap]: EngineMethodMap[M]["result"];
};

/** Exhaustive, schema-valid deterministic results for all 35 EngineMethodMap methods. */
export const FULL_FAKE_ENGINE_RESULTS: FullFakeEngineResults = {
  "subjects.create": subject,
  "subjects.list": { items: [subject] },
  "subjects.resolve": { kind: "found", subject },
  "subjects.archive": null,
  "subjects.purge": {
    subjectId: SUBJECT_ID,
    logicalDeletion: "complete",
    physicalDeletion: "complete",
  },
  "materials.ingest": ingestResult,
  "materials.ingestFiles": {
    subject,
    created: false,
    items: [],
    generation: 1,
    materialSetHash: MATERIAL_SET_HASH,
  },
  "materials.list": { items: [] },
  "materials.get": {
    record: materialRecord,
    content: "Analytical Engine notes",
    rawAvailable: false,
    inCurrentGeneration: true,
    sourceGroup,
    grouping: { algorithmVersion: "source-groups-v1", generation: 1 },
  },
  "distill.pending": [pendingJob],
  "distill.brief": briefing,
  "distill.renew": lease,
  "distill.release": null,
  "distill.commit": { kind: "current", version: currentVersion, profile },
  "distill.redistill": pendingJob,
  "profiles.get": profile,
  "profiles.prompt": "# Ada Lovelace",
  "profiles.status": {
    subject,
    generation: 1,
    materialSetHash: MATERIAL_SET_HASH,
    pendingJobId: JOB_ID,
    maturity: "sparse",
  },
  "profiles.correct": correctionResult,
  "versions.list": { items: [currentVersion] },
  "versions.diff": {
    added: [],
    removed: [],
    changed: [],
    changedFacets: [],
    beforeQuality: quality,
    afterQuality: quality,
  },
  "versions.promote": currentVersion,
  "versions.reject": { ...currentVersion, status: "rejected" },
  "versions.rollback": currentVersion,
  "versions.lineage": { items: [] },
  "hosts.install": installRef,
  "hosts.uninstall": null,
  "hosts.export": exportRef,
  "library.list": { items: [] },
  "library.rebuild": { subjects: 1, jobs: 1, relations: 0, rebuiltAt: NOW },
  "reviews.list": { items: [] },
  "bundles.inspect": {
    displayName: "Ada Lovelace",
    claimCount: 0,
    evidenceExcerptCount: 0,
    license: "CC-BY-4.0",
    signature: "valid",
    warnings: [],
  },
  "bundles.import": {
    subject,
    candidate: correctionVersion,
    review: { subjectId: SUBJECT_ID, candidateVersionId: VERSION_ID },
  },
  "bundles.export": { path: "/tmp/distilly/ada.distilly-profile", contentDigest: CONTENT_DIGEST },
  "system.doctor": {
    runtime: {
      productVersion: "0.0.0",
      wireVersion: "3",
      promptVersion: `host-distill-v1-sha256_${HEX_64}`,
    },
    storage: {
      rootLabel: "distilly-home",
      writable: true,
      schemaSupported: true,
      projectionsDirty: false,
      pendingBlobGcCount: 0,
    },
    panel: { loopbackOnly: true, authentication: "enabled" },
    extensions: [],
  },
};

const unexpectedCall = (method: keyof EngineMethodMap): TypeError =>
  new TypeError(`Unexpected fixture EngineClient call: ${method}`);

const validateMcpSmokeCall = (
  method: keyof EngineMethodMap,
  params: unknown,
  context?: MutationContext,
): void => {
  if (method === "subjects.resolve") {
    const input = params as EngineMethodMap["subjects.resolve"]["params"];
    if (context !== undefined || input.selector.kind !== "id") throw unexpectedCall(method);
  }
  if (method === "materials.ingest") {
    const input = params as EngineMethodMap["materials.ingest"]["params"];
    if (context?.requestId === undefined || input.materials.length !== 1) {
      throw unexpectedCall(method);
    }
    const content = input.materials[0]?.content;
    if (content === "domain failure") {
      throw new DistillyError({
        code: "permission_denied",
        message: "fixture denied the material",
        retryable: false,
        fieldPath: "materials[0]",
      });
    }
    if (content === "unexpected failure") {
      throw new Error("private fixture implementation detail");
    }
  }
  if (method === "distill.pending") {
    const input = params as EngineMethodMap["distill.pending"]["params"];
    if (context !== undefined || Object.keys(input).length !== 0) throw unexpectedCall(method);
  }
  if (method === "distill.commit") {
    const input = params as EngineMethodMap["distill.commit"]["params"];
    if (context?.requestId === undefined || input.jobId !== JOB_ID) throw unexpectedCall(method);
  }
  if (method === "profiles.correct") {
    const input = params as EngineMethodMap["profiles.correct"]["params"];
    if (context?.requestId === undefined || input.subjectId !== SUBJECT_ID) {
      throw unexpectedCall(method);
    }
  }
};

/** Test-only full EngineClient used by the built stdio child-process fixture. */
export class FullFakeEngineClient implements EngineClient {
  closeCalls = 0;

  /**
   * Calls a deterministic query result.
   *
   * @param method - Query method name.
   * @param params - Parameters paired with the method.
   * @returns The deterministic fixture result.
   */
  call<M extends QueryMethodName>(
    method: M,
    params: EngineMethodMap[M]["params"],
  ): Promise<EngineMethodMap[M]["result"]>;

  /**
   * Calls a deterministic mutation result.
   *
   * @param method - Mutation method name.
   * @param params - Parameters paired with the method.
   * @param context - Mutation request identity.
   * @returns The deterministic fixture result.
   */
  call<M extends MutationMethodName>(
    method: M,
    params: EngineMethodMap[M]["params"],
    context: MutationContext,
  ): Promise<EngineMethodMap[M]["result"]>;

  /**
   * Dispatches either overload through the exhaustive deterministic result table.
   *
   * @param method - Engine method name.
   * @param params - Parameters paired with the method.
   * @param context - Optional mutation request identity.
   * @returns The deterministic fixture result.
   */
  call(
    method: keyof EngineMethodMap,
    params: unknown,
    context?: MutationContext,
  ): Promise<unknown> {
    validateMcpSmokeCall(method, params, context);
    if (method === "materials.ingest") {
      const input = params as EngineMethodMap["materials.ingest"]["params"];
      const result: IngestResult = {
        ...ingestResult,
        items: ingestResult.items.map((item, index) => ({
          ...item,
          clientRef: input.materials[index]?.clientRef ?? item.clientRef,
        })),
      };
      return Promise.resolve(result);
    }
    return Promise.resolve(FULL_FAKE_ENGINE_RESULTS[method]);
  }

  /**
   * Subscribes to no events in the deterministic fixture.
   *
   * @param handler - Event handler retained by no test state.
   * @returns A no-op unsubscribe function.
   */
  watch(handler: Parameters<EngineClient["watch"]>[0]): Promise<Unsubscribe> {
    void handler;
    return Promise.resolve(() => undefined);
  }

  /**
   * Records attempted ownership violations without closing another resource.
   *
   * @returns Completion after recording the call.
   */
  close(): Promise<void> {
    this.closeCalls += 1;
    return Promise.resolve();
  }
}
