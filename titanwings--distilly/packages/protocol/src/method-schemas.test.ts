import { describe, expect, it } from "vitest";

import { FACT_LIMITS, WIRE_LIMITS } from "./json.js";
import type { EngineMethodMap } from "./methods.js";
import { utf8ByteLength } from "./schemas/common.js";
import { ingestResultSchema, materialRecordSchema } from "./schemas/materials.js";
import { engineAdministrationSchemas, engineMethodSchemas } from "./schemas/methods.js";

const HEX_32 = "0".repeat(32);
const ALT_HEX_32 = "1".repeat(32);
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
const claimId = `claim_${HEX_64}`;
const eventId = `event_${HEX_32}`;
const captureAuditRef = `capture_${HEX_32}`;
const conversationSourceKey = `conversation_${HEX_64}`;
const sourceGroupKey = `sg_${HEX_64}`;
const briefContractDigest = `brief_contract_${HEX_64}`;
const promptVersion = `host-distill-v1-sha256_${HEX_64}` as const;
const at = "2026-08-20T00:00:00.000Z";

const space = {
  id: spaceId,
  displayName: "People",
  kind: "people",
} as const;

const subject = {
  id: subjectId,
  displayName: "Ada",
  aliases: ["A"],
  identityHints: [{ kind: "url", value: "https://example.com/ada" }],
  space,
  lifecycle: "active",
  currentVersionId: versionId,
} as const;

const quality = {
  sourceGroupingVersion: "source-groups-v1",
  activeClaimCount: 1,
  contestedClaimCount: 0,
  userAssertedClaimCount: 0,
  corroboratedClaimCount: 0,
  sourceGroupCount: 1,
  diversityEligibleSourceGroupCount: 1,
  unknownSourceGroupCount: 0,
  coveredCoreFacets: ["identity", "voice"],
  uncoveredCoreFacets: ["psyche", "relations", "boundaries", "texture", "timeline"],
  maturity: "forming",
} as const;

const evidenceLocator = { start: 0, end: 5 } as const;
const evidenceRef = {
  materialId,
  quote: "hello",
  locator: evidenceLocator,
} as const;

const claim = {
  id: claimId,
  facet: "identity",
  text: "Ada writes.",
  evidence: [evidenceRef],
  status: "active",
  strength: "single_source",
  observedIn: ["2026"],
  createdIn: versionId,
} as const;

const actor = { kind: "sdk", id: "sdk-test" } as const;

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
  claims: [claim],
  core: {
    identity: "Ada writes.",
    voice: "Direct.",
    psyche: "Unassessed.",
    relations: "Unassessed.",
    boundaries: "Unassessed.",
    texture: "Unassessed.",
    timeline: "Unassessed.",
  },
  domains: { work: "Builder." },
  rendered: "# Ada\n\nAda writes.",
  quality,
} as const;

const subjectStatus = {
  subject,
  generation: 1,
  materialSetHash,
  pendingJobId: jobId,
  suspendedVersionId: candidateVersionId,
  maturity: "forming",
} as const;

const pendingJob = {
  id: jobId,
  subjectId,
  generation: 1,
  baseVersionId: versionId,
  materialSetHash,
  addedMaterialCount: 1,
  totalMaterialCount: 1,
  state: "pending",
  queuedAt: at,
} as const;

const leasedJob = {
  ...pendingJob,
  state: "leased",
  leaseExpiresAt: "2026-08-20T00:30:00.000Z",
} as const;

const lease = {
  id: leaseId,
  jobId,
  generation: 1,
  briefContractDigest,
  owner: leaseOwnerId,
  acquiredAt: at,
  expiresAt: "2026-08-20T00:30:00.000Z",
} as const;

const materialSourceInput = {
  uri: "https://example.com/post",
  title: "Post",
  medium: "article",
  access: "public",
  role: "first_party_expression",
  artifact: {
    provider: "example",
    externalId: "post-1",
    canonicalUri: "https://example.com/post",
  },
  capturedAt: at,
  language: "en",
  authors: ["Ada"],
} as const;

const materialSource = {
  ...materialSourceInput,
  authors: ["Ada"],
} as const;

const materialInput = {
  clientRef: "source-1",
  kind: "web",
  content: "hello",
  source: materialSourceInput,
  derivation: { kind: "native_text" },
  participants: ["Ada"],
  sensitivity: "private",
  flags: [],
} as const;

const ingestParams = {
  subject: { kind: "existing", subjectId },
  materials: [materialInput],
  enqueue: "auto",
} as const;

const ingestItem = {
  clientRef: "source-1",
  kind: "accepted",
  materialId,
  contentDigest,
} as const;

const ingestResult = {
  kind: "ingested",
  subject,
  created: false,
  items: [ingestItem],
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
  participants: ["Ada"],
  sensitivity: "private",
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

const materialSummary = {
  record: materialRecord,
  contentScalarCount: 5,
  rawAvailable: false,
  inCurrentGeneration: true,
  sourceGroup,
  grouping,
} as const;

const briefing = {
  job: leasedJob,
  lease,
  subject,
  baseline: {
    versionId,
    claims: [claim],
    quality,
    evidenceFacts: [
      {
        materialId,
        source: materialSource,
        derivation: { kind: "native_text" },
        sourceGroup,
        sensitivity: "private",
        flags: [],
      },
    ],
  },
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
      sensitivity: "private",
    },
  ],
  contract: {
    digest: briefContractDigest,
    sourceGroupingVersion: "source-groups-v1",
    promptVersion,
    draftSchemaVersion: 1,
    instructions: "Distill evidence-bounded claims.",
    evidenceRules: ["Quote exact text."],
  },
  limits: {
    estimatedInputTokens: 100,
    maximumInputTokens: 4_096,
    maximumOutputBytes: 65_536,
  },
} as const;

const claimDraft = {
  facet: "identity",
  text: "Ada writes.",
  evidence: [
    {
      kind: "brief_material",
      materialRef: "m001",
      quote: "hello",
      locator: evidenceLocator,
    },
  ],
  observedIn: ["2026"],
} as const;

const commitParams = {
  jobId,
  generation: 1,
  leaseId,
  briefContractDigest,
  materialSetHash,
  baseVersionId: versionId,
  patch: {
    operations: [{ op: "add", claim: claimDraft }],
    reviewRequest: { note: "Review identity." },
    notes: "One bounded update.",
  },
} as const;

const profileDiff = {
  added: [claim],
  removed: [],
  changed: [],
  changedFacets: ["identity"],
  beforeQuality: quality,
  afterQuality: quality,
} as const;

const reviewReason = {
  code: "manual_review_requested",
  note: "Review identity.",
} as const;

const reviewRef = {
  subjectId,
  candidateVersionId,
} as const;

const installRef = {
  id: "install-1",
  host: "codex",
  subjectId,
  versionId,
  path: "/tmp/distilly/ada.md",
  contentDigest,
  installedAt: at,
} as const;

const exportRef = {
  host: "codex",
  subjectId,
  versionId,
  path: "/tmp/distilly/ada-export.md",
  contentDigest,
} as const;

const libraryEntry = {
  subject,
  status: subjectStatus,
  privacy: "private",
  searchTerms: ["active", "forming", "pending", "private", "suspended"],
  currentQuality: quality,
  suspendedQuality: quality,
  pendingJobs: 1,
  suspendedVersions: 1,
  newMaterialCount: 1,
  lastChangedAt: at,
} as const;

const reviewItem = {
  candidate: suspendedVersion,
  current: currentVersion,
  reasons: [reviewReason],
  diff: profileDiff,
} as const;

const methodNames = [
  "subjects.create",
  "subjects.list",
  "subjects.resolve",
  "subjects.archive",
  "subjects.purge",
  "materials.ingest",
  "materials.ingestFiles",
  "materials.list",
  "materials.get",
  "distill.pending",
  "distill.brief",
  "distill.renew",
  "distill.release",
  "distill.commit",
  "distill.redistill",
  "profiles.get",
  "profiles.prompt",
  "profiles.status",
  "profiles.correct",
  "versions.list",
  "versions.diff",
  "versions.promote",
  "versions.reject",
  "versions.rollback",
  "versions.lineage",
  "hosts.install",
  "hosts.uninstall",
  "hosts.export",
  "library.list",
  "library.rebuild",
  "reviews.list",
  "bundles.inspect",
  "bundles.import",
  "bundles.export",
  "system.doctor",
] as const satisfies readonly (keyof EngineMethodMap)[];

const fixtures = {
  "subjects.create": {
    params: {
      displayName: "Ada",
      aliases: ["A"],
      domainPack: "creator",
      identityHints: [{ kind: "url", value: "https://example.com/ada" }],
    },
    result: subject,
  },
  "subjects.list": {
    params: { text: "Ada", lifecycle: "active", cursor: "cursor-1", limit: 10 },
    result: { items: [subject], nextCursor: "cursor-2" },
  },
  "subjects.resolve": {
    params: { selector: { kind: "query", query: "Ada", spaceId } },
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
  "materials.ingest": { params: ingestParams, result: ingestResult },
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
          warnings: ["No parser available."],
        },
      ],
      generation: 1,
      materialSetHash,
      job: pendingJob,
    },
  },
  "materials.list": {
    params: { subjectId, kind: "web", atVersionId: versionId, cursor: "cursor-1", limit: 10 },
    result: { items: [materialSummary], nextCursor: "cursor-2" },
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
  "distill.pending": {
    params: { subjectId, state: "pending", limit: 10 },
    result: [pendingJob],
  },
  "distill.brief": { params: { jobId }, result: briefing },
  "distill.renew": { params: { jobId, leaseId }, result: lease },
  "distill.release": {
    params: { jobId, leaseId, reason: "Retry later." },
    result: null,
  },
  "distill.commit": {
    params: commitParams,
    result: {
      kind: "suspended",
      candidate: suspendedVersion,
      currentVersionId: versionId,
      reasons: [reviewReason],
      review: reviewRef,
    },
  },
  "distill.redistill": {
    params: { subjectId, mode: "full", reason: "Re-evaluate all evidence." },
    result: pendingJob,
  },
  "profiles.get": { params: { subjectId, versionId }, result: profile },
  "profiles.prompt": { params: { subjectId, versionId }, result: "Use Ada's saved profile." },
  "profiles.status": { params: { subjectId }, result: subjectStatus },
  "profiles.correct": {
    params: {
      subjectId,
      correction: {
        text: "Ada now writes in Rust.",
        facet: "identity",
        supersedes: [claimId],
      },
    },
    result: { kind: "current", version: currentVersion, profile },
  },
  "versions.list": { params: { subjectId }, result: { items: [currentVersion] } },
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
    params: { subjectId, cursor: "cursor-1", limit: 10 },
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
    params: {
      subjectId,
      host: "codex",
      options: { versionId, destination: "/tmp/distilly/ada" },
    },
    result: installRef,
  },
  "hosts.uninstall": { params: { install: installRef }, result: null },
  "hosts.export": {
    params: {
      subjectId,
      host: "codex",
      options: {
        destination: "/tmp/distilly/ada-export.md",
        versionId,
        overwrite: false,
      },
    },
    result: exportRef,
  },
  "library.list": {
    params: {
      text: "Ada",
      spaceId,
      lifecycle: "active",
      hasPending: true,
      hasSuspended: true,
      cursor: "cursor-1",
      limit: 10,
    },
    result: { items: [libraryEntry], nextCursor: "cursor-2" },
  },
  "library.rebuild": {
    params: {},
    result: { subjects: 1, jobs: 1, relations: 0, rebuiltAt: at },
  },
  "reviews.list": {
    params: { subjectId, cursor: "cursor-1", limit: 10 },
    result: { items: [reviewItem] },
  },
  "bundles.inspect": {
    params: { path: "/tmp/ada.distilly-profile" },
    result: {
      displayName: "Ada",
      claimCount: 1,
      evidenceExcerptCount: 1,
      license: "CC-BY-4.0",
      signature: "valid",
      warnings: [],
    },
  },
  "bundles.import": {
    params: {
      path: "/tmp/ada.distilly-profile",
      spaceId,
      confirmation: "Import Ada",
    },
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
      runtime: {
        productVersion: "0.0.0",
        wireVersion: "3",
        promptVersion,
      },
      storage: {
        rootLabel: "distilly-home",
        writable: true,
        schemaSupported: true,
        projectionsDirty: false,
        pendingBlobGcCount: 0,
      },
      panel: { loopbackOnly: true, authentication: "enabled" },
      extensions: [
        {
          id: "codex",
          kind: "host",
          ok: true,
          version: "1",
          warnings: [],
        },
      ],
    },
  },
} satisfies {
  readonly [M in keyof EngineMethodMap]: {
    readonly params: unknown;
    readonly result: unknown;
  };
};

const parseRoundTrip = (schema: { parse(value: unknown): unknown }, fixture: unknown): unknown => {
  const parsed = schema.parse(fixture);
  const serialized = JSON.stringify(parsed);
  expect(serialized).toBeDefined();
  const wireValue: unknown = JSON.parse(serialized ?? "null");
  expect(schema.parse(wireValue)).toEqual(parsed);
  return parsed;
};

const makeMaterial = (index: number, content = "hello") => ({
  ...materialInput,
  clientRef: `source-${String(index)}`,
  content,
});

const makeOpenRecord = (entries: number): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: entries }, (_, index) => [`domain_${String(index)}`, "value"]),
  );

describe("engine method runtime schemas", () => {
  it("publishes exactly the 35 EngineMethodMap keys", () => {
    expect(Object.keys(engineMethodSchemas).sort()).toEqual([...methodNames].sort());
    expect(Object.hasOwn(engineMethodSchemas, "future.method")).toBe(false);
    expect(Object.keys(engineAdministrationSchemas)).toEqual(["backup", "restore"]);
    expect(Object.hasOwn(engineMethodSchemas, "backup")).toBe(false);
    expect(Object.hasOwn(engineMethodSchemas, "restore")).toBe(false);
  });

  it("keeps purge completion and live GC diagnostics strict", () => {
    const purgeResult = engineMethodSchemas["subjects.purge"].result;
    expect(
      purgeResult.parse({
        subjectId,
        logicalDeletion: "complete",
        physicalDeletion: "complete",
      }),
    ).toEqual({ subjectId, logicalDeletion: "complete", physicalDeletion: "complete" });
    expect(
      purgeResult.parse({
        subjectId,
        logicalDeletion: "complete",
        physicalDeletion: "pending",
        pendingBlobCount: Number.MAX_SAFE_INTEGER,
      }),
    ).toMatchObject({ physicalDeletion: "pending", pendingBlobCount: Number.MAX_SAFE_INTEGER });

    const invalidPurgeResults = [
      {
        subjectId,
        logicalDeletion: "complete",
        physicalDeletion: "complete",
        pendingBlobCount: 1,
      },
      { subjectId, logicalDeletion: "complete", physicalDeletion: "pending" },
      {
        subjectId,
        logicalDeletion: "complete",
        physicalDeletion: "pending",
        pendingBlobCount: 0,
      },
      {
        subjectId,
        logicalDeletion: "complete",
        physicalDeletion: "pending",
        pendingBlobCount: 1.5,
      },
      {
        subjectId,
        logicalDeletion: "complete",
        physicalDeletion: "pending",
        pendingBlobCount: Number.MAX_SAFE_INTEGER + 1,
      },
    ];
    for (const result of invalidPurgeResults) expect(() => purgeResult.parse(result)).toThrow();

    const doctorResult = engineMethodSchemas["system.doctor"].result;
    expect(() =>
      doctorResult.parse({
        ...fixtures["system.doctor"].result,
        storage: {
          ...fixtures["system.doctor"].result.storage,
          pendingBlobGcCount: Number.MAX_SAFE_INTEGER,
        },
      }),
    ).not.toThrow();
    for (const pendingBlobGcCount of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        doctorResult.parse({
          ...fixtures["system.doctor"].result,
          storage: { ...fixtures["system.doctor"].result.storage, pendingBlobGcCount },
        }),
      ).toThrow();
    }
    const storageWithoutGcCount = {
      rootLabel: "distilly-home",
      writable: true,
      schemaSupported: true,
      projectionsDirty: false,
    };
    expect(() =>
      doctorResult.parse({
        ...fixtures["system.doctor"].result,
        storage: storageWithoutGcCount,
      }),
    ).toThrow();
  });

  it("round-trips strict root-owner backup and restore contracts", () => {
    const backupInput = { destination: "/tmp/distilly-backup", overwrite: false };
    const backupResult = {
      path: "/tmp/distilly-backup",
      manifestDigest: contentDigest,
      createdAt: at,
    };
    const restoreInput = { source: "/tmp/distilly-backup", confirmation: contentDigest };
    const restoreResult = {
      manifestDigest: contentDigest,
      restoredAt: at,
      previousRootPath: "/tmp/distilly-previous",
    };

    parseRoundTrip(engineAdministrationSchemas.backup.params, backupInput);
    parseRoundTrip(engineAdministrationSchemas.backup.result, backupResult);
    parseRoundTrip(engineAdministrationSchemas.restore.params, restoreInput);
    parseRoundTrip(engineAdministrationSchemas.restore.result, restoreResult);
    expect(() =>
      engineAdministrationSchemas.backup.params.parse({ ...backupInput, unexpected: true }),
    ).toThrow();
    expect(() =>
      engineAdministrationSchemas.restore.result.parse({ ...restoreResult, unexpected: true }),
    ).toThrow();
  });

  it.each(methodNames)("round-trips valid %s params and result", (method) => {
    const schemas = engineMethodSchemas[method];
    const fixture = fixtures[method];
    parseRoundTrip(schemas.params, fixture.params);
    parseRoundTrip(schemas.result, fixture.result);
  });

  it("keeps version disposition structural and rendered output independent of material limits", () => {
    expect(() =>
      engineMethodSchemas["distill.commit"].result.parse({
        kind: "current",
        version: { ...currentVersion, status: "suspended" },
        profile,
      }),
    ).toThrow();
    expect(() =>
      engineMethodSchemas["distill.commit"].result.parse({
        kind: "suspended",
        candidate: { ...suspendedVersion, status: "current" },
        reasons: [reviewReason],
        review: { subjectId, candidateVersionId },
      }),
    ).toThrow();
    expect(() =>
      engineMethodSchemas["distill.commit"].result.parse({
        kind: "suspended",
        candidate: suspendedVersion,
        reasons: [],
        review: { subjectId, candidateVersionId },
      }),
    ).toThrow();
    expect(() =>
      engineMethodSchemas["reviews.list"].result.parse({
        items: [{ ...reviewItem, reasons: [] }],
      }),
    ).toThrow();

    const longRendered = "x".repeat(WIRE_LIMITS.materialContentBytes + 1);
    const longAggregate = "x".repeat(WIRE_LIMITS.claimTextBytes + 1);
    expect(() =>
      engineMethodSchemas["profiles.get"].result.parse({
        ...profile,
        rendered: longRendered,
      }),
    ).not.toThrow();
    expect(() =>
      engineMethodSchemas["profiles.get"].result.parse({
        ...profile,
        core: { ...profile.core, identity: longAggregate },
        domains: { work: longAggregate },
      }),
    ).not.toThrow();
    expect(() => engineMethodSchemas["profiles.prompt"].result.parse(longRendered)).not.toThrow();
    expect(() =>
      engineMethodSchemas["profiles.get"].result.parse({
        ...profile,
        rendered: "",
      }),
    ).toThrow();
    expect(() =>
      engineMethodSchemas["profiles.get"].result.parse({
        ...profile,
        core: { ...profile.core, identity: "" },
      }),
    ).toThrow();
    expect(() =>
      engineMethodSchemas["profiles.get"].result.parse({
        ...profile,
        domains: { work: "" },
      }),
    ).toThrow();
    expect(() => engineMethodSchemas["profiles.prompt"].result.parse("")).toThrow();
  });

  it("enforces canonical profile diffs and the optional first-version baseline", () => {
    const changedClaim = { ...claim, text: "Ada writes carefully." };
    const changedDiff = {
      added: [],
      removed: [],
      changed: [{ before: claim, after: changedClaim }],
      changedFacets: ["identity"],
      beforeQuality: quality,
      afterQuality: quality,
    };
    expect(() => engineMethodSchemas["versions.diff"].result.parse(changedDiff)).not.toThrow();

    const secondClaim = { ...claim, id: `claim_${ALT_HEX_64}`, text: "Ada publishes." };
    const invalidDiffs = [
      { ...profileDiff, added: [secondClaim, claim] },
      { ...profileDiff, added: [claim, claim] },
      { ...profileDiff, removed: [claim] },
      {
        ...changedDiff,
        changed: [{ before: claim, after: { ...changedClaim, id: `claim_${ALT_HEX_64}` } }],
      },
      { ...changedDiff, changed: [{ before: claim, after: claim }] },
      { ...changedDiff, changedFacets: [] },
      { ...changedDiff, changedFacets: ["identity", "identity"] },
    ];
    for (const invalidDiff of invalidDiffs) {
      expect(() => engineMethodSchemas["versions.diff"].result.parse(invalidDiff)).toThrow();
    }
    expect(() =>
      engineMethodSchemas["versions.diff"].result.parse({
        ...profileDiff,
        beforeQuality: undefined,
      }),
    ).toThrow();

    const firstCandidate = { ...suspendedVersion, parentId: undefined };
    const firstReview = {
      candidate: firstCandidate,
      reasons: [reviewReason],
      diff: { ...profileDiff, beforeQuality: undefined },
    };
    expect(() =>
      engineMethodSchemas["reviews.list"].result.parse({ items: [firstReview] }),
    ).not.toThrow();
    expect(() =>
      engineMethodSchemas["reviews.list"].result.parse({
        items: [{ ...reviewItem, diff: { ...profileDiff, beforeQuality: undefined } }],
      }),
    ).toThrow();
  });

  it("keeps panel aggregate fields correlated and pages canonically ordered", () => {
    const invalidLibraryEntries = [
      { ...libraryEntry, pendingJobs: 0 },
      { ...libraryEntry, suspendedVersions: 0 },
      { ...libraryEntry, currentQuality: undefined },
      { ...libraryEntry, suspendedQuality: undefined },
      { ...libraryEntry, newMaterialCount: -1 },
      { ...libraryEntry, status: { ...subjectStatus, maturity: "stable" } },
      { ...libraryEntry, searchTerms: ["private", "active"] },
      { ...libraryEntry, searchTerms: ["active", "active", "private"] },
      { ...libraryEntry, searchTerms: ["forming", "pending", "private", "suspended"] },
      {
        ...libraryEntry,
        searchTerms: [
          "active",
          ...Array.from(
            { length: 66 },
            (_, index) => `domain-${index.toString().padStart(2, "0")}`,
          ),
          "forming",
          "pending",
          "private",
          "suspended",
        ],
      },
    ];
    for (const entry of invalidLibraryEntries) {
      expect(() => engineMethodSchemas["library.list"].result.parse({ items: [entry] })).toThrow();
    }
    expect(() =>
      engineMethodSchemas["library.list"].result.parse({
        items: [
          {
            ...libraryEntry,
            searchTerms: [
              "active",
              ...Array.from(
                { length: 65 },
                (_, index) => `domain-${index.toString().padStart(2, "0")}`,
              ),
              "forming",
              "pending",
              "private",
              "suspended",
            ],
          },
        ],
      }),
    ).not.toThrow();

    expect(() =>
      engineMethodSchemas["versions.list"].result.parse({
        items: [currentVersion, { ...suspendedVersion, status: "historical" }],
      }),
    ).not.toThrow();
    expect(() =>
      engineMethodSchemas["versions.list"].result.parse({
        items: [{ ...suspendedVersion, status: "historical" }, currentVersion],
      }),
    ).toThrow();

    const secondEventId = `event_${ALT_HEX_32}`;
    const later = "2026-08-20T00:01:00.000Z";
    const firstLineageEvent = { eventId, kind: "committed", versionId, actor, at: later };
    const secondLineageEvent = {
      eventId: secondEventId,
      kind: "promoted",
      versionId: candidateVersionId,
      actor,
      at,
    };
    expect(() =>
      engineMethodSchemas["versions.lineage"].result.parse({
        items: [firstLineageEvent, secondLineageEvent],
      }),
    ).not.toThrow();
    expect(() =>
      engineMethodSchemas["versions.lineage"].result.parse({
        items: [secondLineageEvent, firstLineageEvent],
      }),
    ).toThrow();

    const secondMaterialSummary = {
      ...materialSummary,
      record: { ...materialRecord, id: `mat_${ALT_HEX_64}` },
    };
    expect(() =>
      engineMethodSchemas["materials.list"].result.parse({
        items: [materialSummary, secondMaterialSummary],
      }),
    ).not.toThrow();
    expect(() =>
      engineMethodSchemas["materials.list"].result.parse({
        items: [secondMaterialSummary, materialSummary],
      }),
    ).toThrow();
  });

  it("keeps subject pages in canonical display-name and SubjectId order", () => {
    const secondSubjectId = `subject_${ALT_HEX_32}`;
    const lowerNameSubject = { ...subject, displayName: "\uE000" };
    const higherNameSubject = {
      ...subject,
      id: secondSubjectId,
      displayName: "\u{1f600}",
    };
    const higherIdSubject = { ...subject, id: secondSubjectId };
    const resultSchema = engineMethodSchemas["subjects.list"].result;

    expect(() =>
      resultSchema.parse({ items: [lowerNameSubject, higherNameSubject] }),
    ).not.toThrow();
    expect(() => resultSchema.parse({ items: [subject, higherIdSubject] })).not.toThrow();
    expect(() => resultSchema.parse({ items: [higherNameSubject, lowerNameSubject] })).toThrow();
    expect(() => resultSchema.parse({ items: [higherIdSubject, subject] })).toThrow();
    expect(() => resultSchema.parse({ items: [subject, subject] })).toThrow();
  });

  it("rejects unknown keys recursively", () => {
    expect(() =>
      engineMethodSchemas["subjects.create"].params.parse({
        displayName: "Ada",
        unexpected: true,
      }),
    ).toThrow();
    expect(() =>
      engineMethodSchemas["subjects.create"].params.parse({
        displayName: "Ada",
        space: { displayName: "People", kind: "people", unexpected: true },
      }),
    ).toThrow();
    expect(() =>
      engineMethodSchemas["subjects.create"].result.parse({
        ...subject,
        unexpected: true,
      }),
    ).toThrow();
  });

  it("rejects unknown discriminants", () => {
    expect(() =>
      engineMethodSchemas["subjects.resolve"].params.parse({
        selector: { kind: "future", subjectId },
      }),
    ).toThrow();
    expect(() =>
      engineMethodSchemas["subjects.resolve"].result.parse({ kind: "future" }),
    ).toThrow();
    expect(() =>
      engineMethodSchemas["materials.ingest"].params.parse({
        ...ingestParams,
        subject: { kind: "future", subjectId },
      }),
    ).toThrow();

    expect(() =>
      engineMethodSchemas["materials.ingest"].result.parse({
        ...ingestResult,
        kind: "future",
      }),
    ).toThrow();
    expect(() =>
      engineMethodSchemas["distill.commit"].params.parse({
        ...commitParams,
        patch: { operations: [{ op: "future", claim: claimDraft }] },
      }),
    ).toThrow();
    expect(() => engineMethodSchemas["distill.commit"].result.parse({ kind: "future" })).toThrow();
    expect(() =>
      engineMethodSchemas["versions.list"].result.parse({
        items: [{ ...currentVersion, creation: { kind: "future" } }],
      }),
    ).toThrow();
    expect(() =>
      engineMethodSchemas["reviews.list"].result.parse({
        items: [{ ...reviewItem, reasons: [{ code: "future" }] }],
      }),
    ).toThrow();
  });

  it("accepts safe integer boundaries and rejects unsafe, fractional, or negative values", () => {
    expect(() =>
      engineMethodSchemas["profiles.status"].result.parse({
        ...subjectStatus,
        generation: Number.MAX_SAFE_INTEGER,
      }),
    ).not.toThrow();
    for (const generation of [Number.MAX_SAFE_INTEGER + 1, 1.5, -1]) {
      expect(() =>
        engineMethodSchemas["profiles.status"].result.parse({
          ...subjectStatus,
          generation,
        }),
      ).toThrow();
    }
    expect(() =>
      engineMethodSchemas["distill.commit"].params.parse({
        ...commitParams,
        patch: {
          operations: [
            {
              op: "add",
              claim: {
                ...claimDraft,
                evidence: [
                  {
                    kind: "brief_material",
                    materialRef: "m001",
                    quote: "hello",
                    locator: { start: -1, end: 5 },
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toThrow();
  });

  it("enforces every shared scalar and list wire limit at method boundaries", () => {
    expect(() =>
      engineMethodSchemas["subjects.create"].params.parse({
        displayName: "x".repeat(WIRE_LIMITS.labelBytes),
      }),
    ).not.toThrow();
    expect(() =>
      engineMethodSchemas["subjects.create"].params.parse({
        displayName: "x".repeat(WIRE_LIMITS.labelBytes + 1),
      }),
    ).toThrow();

    expect(() =>
      engineMethodSchemas["library.list"].params.parse({
        cursor: "x".repeat(WIRE_LIMITS.cursorBytes),
      }),
    ).not.toThrow();
    expect(() =>
      engineMethodSchemas["library.list"].params.parse({
        cursor: "x".repeat(WIRE_LIMITS.cursorBytes + 1),
      }),
    ).toThrow();

    expect(() =>
      engineMethodSchemas["subjects.list"].params.parse({
        text: "x".repeat(WIRE_LIMITS.queryBytes),
      }),
    ).not.toThrow();
    expect(() =>
      engineMethodSchemas["subjects.list"].params.parse({
        text: "x".repeat(WIRE_LIMITS.queryBytes + 1),
      }),
    ).toThrow();

    const uriPrefix = "https://example.com/";
    const uriAtLimit = uriPrefix + "x".repeat(WIRE_LIMITS.uriBytes - uriPrefix.length);
    const uriOverLimit = `${uriAtLimit}x`;
    const unicodeUriAtWireLimit =
      uriPrefix + "é".repeat((WIRE_LIMITS.uriBytes - uriPrefix.length) / 2);
    expect(() =>
      engineMethodSchemas["materials.ingest"].params.parse({
        ...ingestParams,
        materials: [
          {
            ...materialInput,
            source: { ...materialSourceInput, uri: uriAtLimit },
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      engineMethodSchemas["materials.ingest"].params.parse({
        ...ingestParams,
        materials: [
          {
            ...materialInput,
            source: { ...materialSourceInput, uri: uriOverLimit },
          },
        ],
      }),
    ).toThrow();

    expect(utf8ByteLength(unicodeUriAtWireLimit)).toBe(WIRE_LIMITS.uriBytes);
    expect(() =>
      engineMethodSchemas["materials.ingest"].params.parse({
        ...ingestParams,
        materials: [
          {
            ...materialInput,
            source: { ...materialSourceInput, uri: unicodeUriAtWireLimit },
          },
        ],
      }),
    ).not.toThrow();

    const sourceUriIdentityAtLimit = `source-uri-v1\0${uriAtLimit}`;
    const sourceIdentityAtLimit = `artifact-uri-v1\0${uriAtLimit}`;
    const sourceIdentityOverLimit = `${sourceIdentityAtLimit}x`;
    expect(utf8ByteLength(sourceUriIdentityAtLimit)).toBe(
      WIRE_LIMITS.uriBytes + utf8ByteLength("source-uri-v1\0"),
    );
    expect(utf8ByteLength(sourceIdentityAtLimit)).toBe(FACT_LIMITS.sourceIdentityBytes);
    expect(() =>
      engineMethodSchemas["materials.get"].result.parse({
        record: { ...materialRecord, sourceIdentity: sourceUriIdentityAtLimit },
        content: "hello",
        rawAvailable: false,
        inCurrentGeneration: true,
        sourceGroup,
        grouping,
      }),
    ).not.toThrow();
    expect(() =>
      engineMethodSchemas["materials.get"].result.parse({
        record: { ...materialRecord, sourceIdentity: sourceIdentityAtLimit },
        content: "hello",
        rawAvailable: false,
        inCurrentGeneration: true,
        sourceGroup,
        grouping,
      }),
    ).not.toThrow();
    expect(() =>
      engineMethodSchemas["materials.get"].result.parse({
        record: { ...materialRecord, sourceIdentity: sourceIdentityOverLimit },
        content: "hello",
        rawAvailable: false,
        inCurrentGeneration: true,
        sourceGroup,
        grouping,
      }),
    ).toThrow();

    expect(() =>
      engineMethodSchemas["distill.redistill"].params.parse({
        subjectId,
        mode: "full",
        reason: "x".repeat(WIRE_LIMITS.reasonBytes),
      }),
    ).not.toThrow();
    expect(() =>
      engineMethodSchemas["distill.redistill"].params.parse({
        subjectId,
        mode: "full",
        reason: "x".repeat(WIRE_LIMITS.reasonBytes + 1),
      }),
    ).toThrow();

    const claimAtLimit = { ...claimDraft, text: "x".repeat(WIRE_LIMITS.claimTextBytes) };
    expect(() =>
      engineMethodSchemas["distill.commit"].params.parse({
        ...commitParams,
        patch: { operations: [{ op: "add", claim: claimAtLimit }] },
      }),
    ).not.toThrow();
    expect(() =>
      engineMethodSchemas["distill.commit"].params.parse({
        ...commitParams,
        patch: {
          operations: [
            {
              op: "add",
              claim: { ...claimAtLimit, text: `${claimAtLimit.text}x` },
            },
          ],
        },
      }),
    ).toThrow();

    const patchSizeBase = {
      operations: [
        {
          op: "add",
          claim: {
            ...claimDraft,
            evidence: [
              {
                kind: "brief_material",
                materialRef: "m001",
                quote: "",
              },
            ],
          },
        },
      ],
    } as const;
    const remainingPatchBytes = 65_536 - JSON.stringify(patchSizeBase).length;
    const patchAtLimit = {
      operations: [
        {
          ...patchSizeBase.operations[0],
          claim: {
            ...patchSizeBase.operations[0].claim,
            evidence: [
              {
                ...patchSizeBase.operations[0].claim.evidence[0],
                quote: "x".repeat(remainingPatchBytes),
              },
            ],
          },
        },
      ],
    } as const;
    expect(JSON.stringify(patchAtLimit).length).toBe(65_536);
    expect(() =>
      engineMethodSchemas["distill.commit"].params.parse({
        ...commitParams,
        patch: patchAtLimit,
      }),
    ).not.toThrow();
    expect(() =>
      engineMethodSchemas["distill.commit"].params.parse({
        ...commitParams,
        patch: {
          ...patchAtLimit,
          operations: patchAtLimit.operations.map((operation) => ({
            ...operation,
            claim: {
              ...operation.claim,
              evidence: operation.claim.evidence.map((item) => ({
                ...item,
                quote: `${item.quote}x`,
              })),
            },
          })),
        },
      }),
    ).toThrow();

    expect(() =>
      engineMethodSchemas["profiles.correct"].params.parse({
        subjectId,
        correction: { text: "x".repeat(WIRE_LIMITS.correctionTextBytes) },
      }),
    ).not.toThrow();
    expect(() =>
      engineMethodSchemas["profiles.correct"].params.parse({
        subjectId,
        correction: { text: "x".repeat(WIRE_LIMITS.correctionTextBytes + 1) },
      }),
    ).toThrow();

    expect(() =>
      engineMethodSchemas["materials.ingest"].params.parse({
        ...ingestParams,
        materials: [makeMaterial(1, "x".repeat(WIRE_LIMITS.materialContentBytes))],
      }),
    ).not.toThrow();
    expect(() =>
      engineMethodSchemas["materials.ingest"].params.parse({
        ...ingestParams,
        materials: [makeMaterial(1, "x".repeat(WIRE_LIMITS.materialContentBytes + 1))],
      }),
    ).toThrow();

    expect(() =>
      engineMethodSchemas["materials.ingest"].params.parse({
        ...ingestParams,
        materials: Array.from({ length: WIRE_LIMITS.ingestMaterials }, (_, index) =>
          makeMaterial(index),
        ),
      }),
    ).not.toThrow();
    expect(() =>
      engineMethodSchemas["materials.ingest"].params.parse({
        ...ingestParams,
        materials: Array.from({ length: WIRE_LIMITS.ingestMaterials + 1 }, (_, index) =>
          makeMaterial(index),
        ),
      }),
    ).toThrow();

    expect(() =>
      engineMethodSchemas["subjects.create"].params.parse({
        displayName: "Ada",
        aliases: Array.from({ length: WIRE_LIMITS.smallArrayItems }, () => "alias"),
      }),
    ).not.toThrow();
    expect(() =>
      engineMethodSchemas["subjects.create"].params.parse({
        displayName: "Ada",
        aliases: Array.from({ length: WIRE_LIMITS.smallArrayItems + 1 }, () => "alias"),
      }),
    ).toThrow();

    const operation = { op: "add", claim: claimDraft } as const;
    expect(() =>
      engineMethodSchemas["distill.commit"].params.parse({
        ...commitParams,
        patch: { operations: Array.from({ length: WIRE_LIMITS.patchOperations }, () => operation) },
      }),
    ).not.toThrow();
    expect(() =>
      engineMethodSchemas["distill.commit"].params.parse({
        ...commitParams,
        patch: {
          operations: Array.from({ length: WIRE_LIMITS.patchOperations + 1 }, () => operation),
        },
      }),
    ).toThrow();

    const evidence = claimDraft.evidence[0];
    expect(() =>
      engineMethodSchemas["distill.commit"].params.parse({
        ...commitParams,
        patch: {
          operations: [
            {
              op: "add",
              claim: {
                ...claimDraft,
                evidence: Array.from({ length: WIRE_LIMITS.evidencePerOperation }, () => evidence),
              },
            },
          ],
        },
      }),
    ).not.toThrow();
    expect(() =>
      engineMethodSchemas["distill.commit"].params.parse({
        ...commitParams,
        patch: {
          operations: [
            {
              op: "add",
              claim: {
                ...claimDraft,
                evidence: Array.from(
                  { length: WIRE_LIMITS.evidencePerOperation + 1 },
                  () => evidence,
                ),
              },
            },
          ],
        },
      }),
    ).toThrow();

    expect(() =>
      engineMethodSchemas["profiles.get"].result.parse({
        ...profile,
        domains: makeOpenRecord(WIRE_LIMITS.openRecordEntries),
      }),
    ).not.toThrow();
    expect(() =>
      engineMethodSchemas["profiles.get"].result.parse({
        ...profile,
        domains: makeOpenRecord(WIRE_LIMITS.openRecordEntries + 1),
      }),
    ).toThrow();

    expect(() =>
      engineMethodSchemas["subjects.list"].params.parse({ limit: WIRE_LIMITS.listLimit }),
    ).not.toThrow();
    for (const limit of [0, WIRE_LIMITS.listLimit + 1]) {
      expect(() => engineMethodSchemas["subjects.list"].params.parse({ limit })).toThrow();
    }
  });

  it("rejects aggregate inputs larger than toolInputBytes", () => {
    const fullMaterial = "x".repeat(WIRE_LIMITS.materialContentBytes);
    expect(() =>
      engineMethodSchemas["materials.ingest"].params.parse({
        ...ingestParams,
        materials: Array.from({ length: 4 }, (_, index) => makeMaterial(index, fullMaterial)),
      }),
    ).toThrow();
  });

  it("encodes all three no-payload method results as null", () => {
    const methods = ["subjects.archive", "distill.release", "hosts.uninstall"] as const;
    for (const method of methods) {
      expect(engineMethodSchemas[method].result.parse(null)).toBeNull();
      expect(() => engineMethodSchemas[method].result.parse(undefined)).toThrow();
      expect(() => engineMethodSchemas[method].result.parse({})).toThrow();
    }
  });

  it("accepts only http(s) source and artifact URIs", () => {
    expect(() =>
      engineMethodSchemas["materials.ingest"].params.parse({
        ...ingestParams,
        materials: [
          {
            ...materialInput,
            kind: "document",
            source: { ...materialSourceInput, uri: "ftp://example.com/source" },
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      engineMethodSchemas["materials.ingest"].params.parse({
        ...ingestParams,
        materials: [
          {
            ...materialInput,
            source: {
              ...materialSourceInput,
              artifact: {
                provider: "publisher",
                externalId: "story-1",
                canonicalUri: "ftp://example.com/story-1",
              },
            },
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      engineMethodSchemas["materials.ingest"].params.parse({
        ...ingestParams,
        materials: [
          {
            ...materialInput,
            kind: "document",
            source: {
              ...materialSourceInput,
              uri: "https://example.com/source",
              artifact: {
                provider: "publisher",
                externalId: "story-1",
                canonicalUri: "http://example.com/story-1",
              },
            },
          },
        ],
      }),
    ).not.toThrow();
  });

  it("keeps ingest dispositions and persisted material provenance correlated", () => {
    expect(() =>
      ingestResultSchema.parse({
        ...ingestResult,
        items: [{ ...ingestItem, kind: "duplicate" }],
      }),
    ).toThrow();
    expect(() =>
      ingestResultSchema.parse({
        kind: "unchanged",
        subject,
        items: [ingestItem],
        materialSetHash,
        generation: 1,
      }),
    ).toThrow();
    for (const job of [
      { ...pendingJob, subjectId: `subject_${"1".repeat(32)}` },
      { ...pendingJob, generation: 2 },
      { ...pendingJob, materialSetHash: `set_sha256_${ALT_HEX_64}` },
    ]) {
      expect(() => ingestResultSchema.parse({ ...ingestResult, job })).toThrow();
    }

    const correctionRecord = {
      ...materialRecord,
      kind: "correction",
      sourceIdentity: "correction:direct-user",
      correctionProvenance: { kind: "direct_user" },
    } as const;
    const privateTranscriptRecord = {
      ...materialRecord,
      kind: "transcript",
      sourceIdentity: "private-conversation",
      source: {
        medium: "conversation",
        access: "private",
        role: "personal_communication",
        capturedAt: at,
        authors: [],
      },
      derivation: {
        kind: "host_extract",
        method: "computer_use_transcript",
        producer: "codex",
      },
      sensitivity: "private",
      captureAuditRef,
      conversationSourceKey,
    } as const;

    expect(() => materialRecordSchema.parse(materialRecord)).not.toThrow();
    expect(() => materialRecordSchema.parse(correctionRecord)).not.toThrow();
    expect(() => materialRecordSchema.parse(privateTranscriptRecord)).not.toThrow();
    expect(() => materialRecordSchema.parse({ ...materialRecord, kind: "correction" })).toThrow();
    expect(() =>
      materialRecordSchema.parse({
        ...materialRecord,
        correctionProvenance: { kind: "direct_user" },
      }),
    ).toThrow();
    expect(() =>
      materialRecordSchema.parse({
        ...privateTranscriptRecord,
        conversationSourceKey: undefined,
      }),
    ).toThrow();
    expect(() =>
      materialRecordSchema.parse({
        ...privateTranscriptRecord,
        captureAuditRef: undefined,
      }),
    ).toThrow();

    const forgedCaptureRecords = [
      { ...privateTranscriptRecord, kind: "web" },
      {
        ...privateTranscriptRecord,
        source: { ...privateTranscriptRecord.source, medium: "article" },
      },
      {
        ...privateTranscriptRecord,
        source: { ...privateTranscriptRecord.source, access: "public" },
      },
      {
        ...privateTranscriptRecord,
        source: { ...privateTranscriptRecord.source, role: "reference" },
      },
      { ...privateTranscriptRecord, derivation: { kind: "native_text" } },
      { ...privateTranscriptRecord, sensitivity: "shareable" },
      {
        ...privateTranscriptRecord,
        source: { ...privateTranscriptRecord.source, uri: "https://example.com/thread" },
      },
      {
        ...privateTranscriptRecord,
        source: {
          ...privateTranscriptRecord.source,
          artifact: { provider: "wechat", externalId: "thread-1" },
        },
      },
      {
        ...privateTranscriptRecord,
        source: {
          ...privateTranscriptRecord.source,
          representationOf: { provider: "wechat", externalId: "thread-1" },
        },
      },
    ] as const;
    for (const forgedRecord of forgedCaptureRecords) {
      expect(() => materialRecordSchema.parse(forgedRecord)).toThrow();
    }
  });

  it("deeply removes explicit undefined keys at the central schema adapter", () => {
    const parsedSubject = engineMethodSchemas["subjects.create"].params.parse({
      displayName: "Ada",
      aliases: undefined,
      space: {
        displayName: "People",
        kind: "people",
      },
    });
    expect(Object.hasOwn(parsedSubject, "aliases")).toBe(false);

    const parsedIngest = engineMethodSchemas["materials.ingest"].params.parse({
      ...ingestParams,
      materials: [
        {
          ...materialInput,
          sensitivity: undefined,
          source: {
            ...materialSourceInput,
            title: undefined,
          },
        },
      ],
    });
    expect(Object.hasOwn(parsedIngest.materials[0] ?? {}, "sensitivity")).toBe(false);
    expect(Object.hasOwn(parsedIngest.materials[0]?.source ?? {}, "title")).toBe(false);

    const parsedResult = engineMethodSchemas["subjects.create"].result.parse({
      ...subject,
      currentVersionId: undefined,
    });
    expect(Object.hasOwn(parsedResult, "currentVersionId")).toBe(false);
  });
});
