import type { EngineMethodMap } from "@distilly/protocol";

interface RpcContractFixture {
  readonly params: unknown;
  readonly result: unknown;
}

const HEX_32 = "0".repeat(32);
const HEX_64 = "0".repeat(64);
const ALT_HEX_64 = "1".repeat(64);
const THIRD_HEX_64 = "2".repeat(64);

const subjectId = `subject_${HEX_32}`;
const spaceId = `space_${HEX_32}`;
const materialId = `mat_${HEX_64}`;
const rawId = `raw_${HEX_64}`;
const factChecksum = `fact_sha256_${HEX_64}`;
const contentDigest = `sha256_${HEX_64}`;
const provenanceDigest = `provenance_sha256_${HEX_64}`;
const materialSetHash = `set_sha256_${HEX_64}`;
const versionId = `version_${HEX_64}`;
const candidateVersionId = `version_${ALT_HEX_64}`;
const rollbackVersionId = `version_${THIRD_HEX_64}`;
const jobId = `job_${HEX_32}`;
const leaseId = `lease_${HEX_32}`;
const leaseOwnerId = `lease_owner_${HEX_32}`;
const eventId = `event_${HEX_32}`;
const sourceGroupKey = `sg_${HEX_64}`;
const briefContractDigest = `brief_contract_${HEX_64}`;
const promptVersion = `host-distill-v1-sha256_${HEX_64}`;
const at = "2026-08-20T00:00:00.000Z";

const subject = {
  id: subjectId,
  displayName: "Ada",
  aliases: [],
  identityHints: [],
  space: { id: spaceId, displayName: "People", kind: "people" },
  lifecycle: "active",
  currentVersionId: versionId,
} as const;

const quality = {
  sourceGroupingVersion: "source-groups-v1",
  activeClaimCount: 0,
  contestedClaimCount: 0,
  userAssertedClaimCount: 0,
  corroboratedClaimCount: 0,
  sourceGroupCount: 1,
  diversityEligibleSourceGroupCount: 1,
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

const actor = { kind: "sdk", id: "panel-rpc-fixture" } as const;
const currentVersion = {
  id: versionId,
  subjectId,
  generation: 1,
  materialSetHash,
  creation: {
    kind: "host_distill",
    briefContractDigest,
    promptVersion,
    draftSchemaVersion: 1,
  },
  status: "current",
  actor,
  quality,
  createdAt: at,
} as const;
const suspendedVersion = {
  ...currentVersion,
  id: candidateVersionId,
  parentId: versionId,
  status: "suspended",
} as const;
const rollbackVersion = {
  ...currentVersion,
  id: rollbackVersionId,
  parentId: versionId,
  creation: { kind: "rollback", targetVersionId: versionId },
} as const;
const bundleCandidate = {
  ...suspendedVersion,
  creation: { kind: "bundle_import", bundleDigest: contentDigest },
} as const;

const profile = {
  subjectId,
  displayName: "Ada",
  versionId,
  claims: [],
  core: {
    identity: "Unassessed.",
    voice: "Unassessed.",
    psyche: "Unassessed.",
    relations: "Unassessed.",
    boundaries: "Unassessed.",
    texture: "Unassessed.",
    timeline: "Unassessed.",
  },
  domains: {},
  rendered: "# Ada",
  quality,
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
const leaseExpiresAt = "2026-08-20T00:30:00.000Z";
const leasedJob = { ...pendingJob, state: "leased", leaseExpiresAt } as const;
const lease = {
  id: leaseId,
  jobId,
  generation: 1,
  briefContractDigest,
  owner: leaseOwnerId,
  acquiredAt: at,
  expiresAt: leaseExpiresAt,
} as const;

const materialSourceInput = {
  uri: "https://example.com/post",
  medium: "article",
  access: "public",
  capturedAt: at,
} as const;
const materialSource = { ...materialSourceInput, authors: [] } as const;
const materialInput = {
  clientRef: "source-1",
  kind: "web",
  content: "hello",
  source: materialSourceInput,
  derivation: { kind: "native_text" },
} as const;
const ingestResult = {
  kind: "ingested",
  subject,
  created: false,
  items: [
    {
      clientRef: "source-1",
      kind: "accepted",
      materialId,
      contentDigest,
    },
  ],
  materialSetHash,
  generation: 1,
  job: pendingJob,
} as const;
const materialRecord = {
  schemaVersion: 1,
  checksum: factChecksum,
  id: materialId,
  subjectId,
  kind: "web",
  contentDigest,
  provenanceDigest,
  sourceIdentity: "https://example.com/post",
  source: materialSource,
  derivation: { kind: "native_text" },
  participants: [],
  sensitivity: "shareable",
  flags: [],
  storedAt: at,
} as const;
const sourceGroup = {
  key: sourceGroupKey,
  bases: ["canonical_uri"],
  diversityStatus: "eligible",
  cautions: [],
} as const;
const grouping = {
  algorithmVersion: "source-groups-v1",
  generation: 1,
  versionId,
} as const;
const briefing = {
  job: leasedJob,
  lease,
  subject,
  materials: [
    {
      ref: "m001",
      materialId,
      contentDigest,
      kind: "web",
      content: "hello",
      source: materialSource,
      derivation: { kind: "native_text" },
      sourceGroup,
      sensitivity: "shareable",
    },
  ],
  contract: {
    digest: briefContractDigest,
    sourceGroupingVersion: "source-groups-v1",
    promptVersion,
    draftSchemaVersion: 1,
    instructions: "Distill only supplied evidence.",
    evidenceRules: [],
  },
  limits: {
    estimatedInputTokens: 1,
    maximumInputTokens: 1_000,
    maximumOutputBytes: 65_536,
  },
} as const;
const subjectStatus = {
  subject,
  generation: 1,
  materialSetHash,
  pendingJobId: jobId,
  suspendedVersionId: candidateVersionId,
  maturity: "sparse",
} as const;
const commitResult = { kind: "current", version: currentVersion, profile } as const;
const reviewReason = { code: "manual_review_requested", note: "Review this version." } as const;
const reviewRef = { subjectId, candidateVersionId } as const;
const installRef = {
  id: "install-1",
  host: "codex",
  subjectId,
  versionId,
  path: "/tmp/distilly/ada",
  contentDigest,
  installedAt: at,
} as const;
const exportRef = {
  host: "codex",
  subjectId,
  versionId,
  path: "/tmp/distilly/ada.md",
  contentDigest,
} as const;
const libraryEntry = {
  subject,
  status: subjectStatus,
  privacy: "shareable",
  searchTerms: ["active", "pending", "shareable", "sparse", "suspended"],
  currentQuality: quality,
  suspendedQuality: quality,
  pendingJobs: 1,
  suspendedVersions: 1,
  newMaterialCount: 1,
  lastChangedAt: at,
} as const;
const profileDiff = {
  added: [],
  removed: [],
  changed: [],
  changedFacets: [],
  beforeQuality: quality,
  afterQuality: quality,
} as const;
const reviewItem = {
  candidate: suspendedVersion,
  current: currentVersion,
  reasons: [reviewReason],
  diff: profileDiff,
} as const;

/** Schema-valid method-correlated values used only by the real Panel HTTP fixture. */
export const PANEL_RPC_FIXTURES = {
  "subjects.create": { params: { displayName: "Ada" }, result: subject },
  "subjects.list": { params: { text: "Ada", limit: 10 }, result: { items: [subject] } },
  "subjects.resolve": {
    params: { selector: { kind: "id", subjectId } },
    result: { kind: "found", subject },
  },
  "subjects.archive": { params: { subjectId }, result: null },
  "subjects.purge": {
    params: { subjectId, confirmation: "Purge Ada" },
    result: {
      subjectId,
      logicalDeletion: "complete",
      physicalDeletion: "complete",
    },
  },
  "materials.ingest": {
    params: {
      subject: { kind: "existing", subjectId },
      materials: [materialInput],
      enqueue: "auto",
    },
    result: ingestResult,
  },
  "materials.ingestFiles": {
    params: {
      subject: { kind: "existing", subjectId },
      paths: ["/tmp/source.pdf"],
      enqueue: "now",
      sensitivity: "private",
    },
    result: {
      subject,
      created: false,
      items: [
        {
          kind: "unparsed",
          pathLabel: "source.pdf",
          rawId,
          mediaType: "application/pdf",
          warnings: [],
        },
      ],
      generation: 1,
      materialSetHash,
      job: pendingJob,
    },
  },
  "materials.list": {
    params: { subjectId, atVersionId: versionId, limit: 10 },
    result: {
      items: [
        {
          record: materialRecord,
          contentScalarCount: 5,
          rawAvailable: false,
          inCurrentGeneration: true,
          sourceGroup,
          grouping,
        },
      ],
    },
  },
  "materials.get": {
    params: { subjectId, materialId, atVersionId: versionId },
    result: {
      record: materialRecord,
      content: "hello",
      rawAvailable: false,
      inCurrentGeneration: true,
      sourceGroup,
      grouping,
    },
  },
  "distill.pending": { params: { subjectId, state: "pending", limit: 10 }, result: [pendingJob] },
  "distill.brief": { params: { jobId }, result: briefing },
  "distill.renew": { params: { jobId, leaseId }, result: lease },
  "distill.release": { params: { jobId, leaseId, reason: "Retry later." }, result: null },
  "distill.commit": {
    params: {
      jobId,
      generation: 1,
      leaseId,
      briefContractDigest,
      materialSetHash,
      patch: { operations: [] },
    },
    result: commitResult,
  },
  "distill.redistill": {
    params: { subjectId, mode: "full", reason: "Refresh all evidence." },
    result: pendingJob,
  },
  "profiles.get": { params: { subjectId, versionId }, result: profile },
  "profiles.prompt": { params: { subjectId, versionId }, result: "Use Ada's saved profile." },
  "profiles.status": { params: { subjectId }, result: subjectStatus },
  "profiles.correct": {
    params: { subjectId, correction: { text: "Ada now writes in Rust." } },
    result: commitResult,
  },
  "versions.list": { params: { subjectId, limit: 10 }, result: { items: [currentVersion] } },
  "versions.diff": {
    params: { subjectId, before: versionId, after: candidateVersionId },
    result: profileDiff,
  },
  "versions.promote": {
    params: { subjectId, candidateVersionId, reason: "Accept reviewed risk." },
    result: currentVersion,
  },
  "versions.reject": {
    params: { subjectId, candidateVersionId, reason: "Evidence is insufficient." },
    result: { ...suspendedVersion, status: "rejected" },
  },
  "versions.rollback": {
    params: { subjectId, targetVersionId: versionId, reason: "Restore known state." },
    result: rollbackVersion,
  },
  "versions.lineage": {
    params: { subjectId, limit: 10 },
    result: {
      items: [
        {
          eventId,
          kind: "committed",
          versionId,
          actor,
          at,
          reason: "Initial profile.",
        },
      ],
    },
  },
  "hosts.install": {
    params: { subjectId, host: "codex", options: { versionId, destination: "/tmp/distilly/ada" } },
    result: installRef,
  },
  "hosts.uninstall": { params: { install: installRef }, result: null },
  "hosts.export": {
    params: {
      subjectId,
      host: "codex",
      options: { destination: "/tmp/distilly/ada.md", versionId, overwrite: false },
    },
    result: exportRef,
  },
  "library.list": {
    params: { text: "Ada", spaceId, lifecycle: "active", limit: 10 },
    result: { items: [libraryEntry] },
  },
  "library.rebuild": {
    params: {},
    result: { subjects: 1, jobs: 1, relations: 0, rebuiltAt: at },
  },
  "reviews.list": { params: { subjectId, limit: 10 }, result: { items: [reviewItem] } },
  "bundles.inspect": {
    params: { path: "/tmp/ada.distilly-profile" },
    result: {
      displayName: "Ada",
      claimCount: 0,
      evidenceExcerptCount: 0,
      license: "CC-BY-4.0",
      signature: "valid",
      warnings: [],
    },
  },
  "bundles.import": {
    params: { path: "/tmp/ada.distilly-profile", spaceId, confirmation: "Import Ada" },
    result: { subject, candidate: bundleCandidate, review: reviewRef },
  },
  "bundles.export": {
    params: {
      subjectId,
      versionId,
      destination: "/tmp/ada.distilly-profile",
      provenancePolicy: "citations_and_quotes",
    },
    result: { path: "/tmp/ada.distilly-profile", contentDigest },
  },
  "system.doctor": {
    params: { host: "codex" },
    result: {
      runtime: { productVersion: "0.0.0", wireVersion: "3", promptVersion },
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
  },
} as const satisfies Readonly<Record<keyof EngineMethodMap, RpcContractFixture>>;
