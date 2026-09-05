import type { DatabaseSync } from "node:sqlite";

import {
  claimIdSchema,
  claimSchema,
  contentDigestSchema,
  facetPathSchema,
  factChecksumSchema,
  isoDateTimeSchema,
  materialIdSchema,
  provenanceDigestSchema,
  versionClaimsSnapshotSchema,
  versionIdSchema,
  versionMaterialManifestSchema,
  versionRecordSchema,
  versionStatusSchema,
} from "@distilly/protocol";
import type {
  Claim,
  ContentDigest,
  FactChecksum,
  SubjectId,
  VersionClaimsSnapshot,
  VersionId,
  VersionMaterialEntry,
  VersionMaterialManifest,
  VersionRecord,
  VersionStatus,
} from "@distilly/protocol";

import { canonicalJson } from "../facts/canonical-json.js";
import { sealFact, verifyFactChecksum } from "../facts/checksum.js";
import { hashMaterialSet } from "../facts/digests.js";
import { deriveSourceGroups } from "../ingest/source-groups.js";
import { schemaUnsupported, storageCorrupt } from "../internal-errors.js";
import { canonicalizeResolvedClaimDraft, compareUtf8, deriveClaimId } from "../profile/claim-id.js";
import { PROFILE_RENDERER_VERSION } from "../profile/render.js";
import { deriveVersionId } from "../profile/version-id.js";

type SqlValue = string | number | bigint | Uint8Array | null;

/** Complete immutable SQLite version facts used by verified engine reads. */
export interface SqliteStoredVersion {
  readonly version: VersionRecord;
  readonly manifest: VersionMaterialManifest;
  readonly claims: VersionClaimsSnapshot;
  readonly status: VersionStatus;
  readonly acceptedPatchDigest: ContentDigest;
}

/** Canonical new version facts inserted by one enclosing business transaction. */
export interface SqliteVersionInsert extends SqliteStoredVersion {
  readonly status: "current" | "suspended";
}

interface SqliteVersionAuthorityRecord {
  readonly schemaVersion: 1;
  readonly version: VersionRecord;
  readonly acceptedPatchDigest: ContentDigest;
  readonly checksum: FactChecksum;
}

const parseStored = <T>(parse: () => T, label: string): T => {
  try {
    return parse();
  } catch (error) {
    throw storageCorrupt(`SQLite ${label} is invalid.`, error);
  }
};

const parseJson = (value: string, label: string): unknown => {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw storageCorrupt(`SQLite ${label} is not valid JSON.`, error);
  }
};

const text = (row: Readonly<Record<string, unknown>>, key: string): string => {
  const value = row[key];
  if (typeof value !== "string") throw storageCorrupt(`SQLite ${key} is invalid.`);
  return value;
};

const nullableText = (row: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = row[key];
  if (value === null) return undefined;
  if (typeof value !== "string") throw storageCorrupt(`SQLite ${key} is invalid.`);
  return value;
};

const integer = (row: Readonly<Record<string, unknown>>, key: string): number => {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw storageCorrupt(`SQLite ${key} is invalid.`);
  }
  return value;
};

const nullableInteger = (
  row: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined => {
  const value = row[key];
  if (value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw storageCorrupt(`SQLite ${key} is invalid.`);
  }
  return value;
};

const queryOne = (
  database: DatabaseSync,
  sql: string,
  values: readonly SqlValue[],
  label: string,
): Readonly<Record<string, unknown>> | undefined => {
  try {
    return database.prepare(sql).get(...values);
  } catch (error) {
    throw storageCorrupt(`SQLite could not read ${label}.`, error);
  }
};

const queryAll = (
  database: DatabaseSync,
  sql: string,
  values: readonly SqlValue[],
  label: string,
): readonly Readonly<Record<string, unknown>>[] => {
  try {
    return database.prepare(sql).all(...values);
  } catch (error) {
    throw storageCorrupt(`SQLite could not read ${label}.`, error);
  }
};

const canonicalText = (value: unknown, stored: string, label: string): void => {
  if (canonicalJson(value) !== stored) {
    throw storageCorrupt(`SQLite ${label} is not canonically encoded.`);
  }
};

const parseVersionAuthorityRecord = (stored: string): SqliteVersionAuthorityRecord => {
  const raw = parseJson(stored, "version authority record");
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw storageCorrupt("SQLite version authority record is invalid.");
  }
  const value = raw as Readonly<Record<string, unknown>>;
  const record: SqliteVersionAuthorityRecord = {
    schemaVersion: parseStored(() => {
      if (value.schemaVersion !== 1) throw new TypeError("unsupported authority schema");
      return 1 as const;
    }, "version authority schema"),
    version: parseStored(
      () => versionRecordSchema.parse(value.version) as VersionRecord,
      "version record",
    ),
    acceptedPatchDigest: parseStored(
      () => contentDigestSchema.parse(value.acceptedPatchDigest),
      "accepted patch digest",
    ),
    checksum: parseStored(
      () => factChecksumSchema.parse(value.checksum),
      "version authority checksum",
    ),
  };
  canonicalText(record, stored, "version authority record");
  verifyFactChecksum(record);
  return record;
};

const assertCanonicalClaims = (
  version: VersionRecord,
  manifest: readonly VersionMaterialEntry[],
  claims: readonly Claim[],
): void => {
  const materialIds = new Set(manifest.map((entry) => entry.materialId));
  const claimIds = new Set(claims.map((claim) => claim.id));
  const claimsById = new Map(claims.map((claim) => [claim.id, claim] as const));
  for (const [index, claim] of claims.entries()) {
    if (index > 0 && compareUtf8(claims[index - 1]!.id, claim.id) >= 0) {
      throw storageCorrupt("SQLite version claims are not strictly ordered by ClaimId.");
    }
    const canonical = canonicalizeResolvedClaimDraft({
      facet: claim.facet,
      text: claim.text,
      evidence: claim.evidence,
      observedIn: claim.observedIn,
      ...(claim.validFrom === undefined ? {} : { validFrom: claim.validFrom }),
      ...(claim.validTo === undefined ? {} : { validTo: claim.validTo }),
    });
    if (
      canonicalJson(canonical.evidence) !== canonicalJson(claim.evidence) ||
      canonicalJson(canonical.observedIn) !== canonicalJson(claim.observedIn)
    ) {
      throw storageCorrupt("SQLite version claims are not canonically encoded.");
    }
    for (const evidence of claim.evidence) {
      if (!materialIds.has(evidence.materialId)) {
        throw storageCorrupt("SQLite claim evidence is outside its version membership.");
      }
    }
    if (claim.supersededBy !== undefined && !claimIds.has(claim.supersededBy)) {
      throw storageCorrupt("SQLite claim supersession points outside its version snapshot.");
    }
    if (
      (claim.status === "active" || claim.status === "contested") &&
      claim.supersededBy !== undefined
    ) {
      throw storageCorrupt("SQLite live version claim names a superseding claim.");
    }
    if (
      claim.createdIn === version.id &&
      (claim.status !== "active" ||
        claim.supersededBy !== undefined ||
        deriveClaimId(version.subjectId, canonical) !== claim.id)
    ) {
      throw storageCorrupt("SQLite version-created claim has invalid live claim-v1 semantics.");
    }
    if (version.parentId === undefined && claim.createdIn !== version.id) {
      throw storageCorrupt("SQLite first-version claim has foreign creation lineage.");
    }
  }

  const completed = new Set<Claim["id"]>();
  const active = new Set<Claim["id"]>();
  const visit = (claimId: Claim["id"]): void => {
    if (completed.has(claimId)) return;
    if (active.has(claimId)) {
      throw storageCorrupt("SQLite claim supersession contains a cycle.");
    }
    active.add(claimId);
    const targetId = claimsById.get(claimId)?.supersededBy;
    if (targetId !== undefined) visit(targetId);
    active.delete(claimId);
    completed.add(claimId);
  };
  for (const claim of claims) visit(claim.id);
};

const validateCompleteVersion = (input: SqliteStoredVersion): void => {
  const version = parseStored(
    () => versionRecordSchema.parse(input.version) as VersionRecord,
    "version record",
  );
  const manifest = parseStored(
    () => versionMaterialManifestSchema.parse(input.manifest) as VersionMaterialManifest,
    "version material membership",
  );
  const claims = parseStored(
    () => versionClaimsSnapshotSchema.parse(input.claims) as VersionClaimsSnapshot,
    "version claim membership",
  );
  parseStored(() => versionStatusSchema.parse(input.status), "version status");
  parseStored(() => contentDigestSchema.parse(input.acceptedPatchDigest), "accepted patch digest");
  verifyFactChecksum(version);
  verifyFactChecksum(manifest);
  verifyFactChecksum(claims);
  if (version.rendererVersion !== PROFILE_RENDERER_VERSION) {
    throw schemaUnsupported(`Unsupported profile renderer version: ${version.rendererVersion}`);
  }
  deriveSourceGroups([], version.quality.sourceGroupingVersion);
  if (
    claims.subjectId !== version.subjectId ||
    claims.versionId !== version.id ||
    version.materialCount !== manifest.items.length ||
    version.materialSetHash !== hashMaterialSet(manifest.items)
  ) {
    throw storageCorrupt("SQLite version facts disagree about immutable membership.");
  }
  assertCanonicalClaims(version, manifest.items, claims.claims);
  if (deriveVersionId(version, claims.claims) !== version.id) {
    throw storageCorrupt("SQLite version has the wrong deterministic VersionId.");
  }
};

const readManifest = (
  database: DatabaseSync,
  subjectId: SubjectId,
  versionId: VersionId,
): VersionMaterialManifest => {
  const rows = queryAll(
    database,
    `SELECT version_materials.ordinal, version_materials.material_id,
            version_materials.content_digest, version_materials.provenance_digest,
            materials.material_id AS existing_material_id
     FROM version_materials
     LEFT JOIN materials
       ON materials.subject_id = version_materials.subject_id
      AND materials.material_id = version_materials.material_id
      AND materials.content_digest = version_materials.content_digest
      AND materials.provenance_digest = version_materials.provenance_digest
     WHERE version_materials.version_id = ? AND version_materials.subject_id = ?
     ORDER BY version_materials.ordinal`,
    [versionId, subjectId],
    "version material membership",
  );
  const items = rows.map((row, index): VersionMaterialEntry => {
    if (integer(row, "ordinal") !== index) {
      throw storageCorrupt("SQLite version material ordinals are not contiguous.");
    }
    const materialId = parseStored(
      () => materialIdSchema.parse(text(row, "material_id")),
      "version material id",
    );
    if (nullableText(row, "existing_material_id") !== materialId) {
      throw storageCorrupt("SQLite version membership is missing its material authority row.");
    }
    return {
      materialId,
      contentDigest: parseStored(
        () => contentDigestSchema.parse(text(row, "content_digest")),
        "version material content digest",
      ),
      provenanceDigest: parseStored(
        () => provenanceDigestSchema.parse(text(row, "provenance_digest")),
        "version material provenance digest",
      ),
    };
  });
  for (let index = 1; index < items.length; index += 1) {
    if (compareUtf8(items[index - 1]!.materialId, items[index]!.materialId) >= 0) {
      throw storageCorrupt("SQLite version material membership is not canonical.");
    }
  }
  return parseStored(
    () =>
      versionMaterialManifestSchema.parse(
        sealFact<VersionMaterialManifest>({ schemaVersion: 1, items }),
      ) as VersionMaterialManifest,
    "version material manifest",
  );
};

const readClaims = (
  database: DatabaseSync,
  subjectId: SubjectId,
  versionId: VersionId,
): VersionClaimsSnapshot => {
  const claimRows = queryAll(
    database,
    `SELECT version_claims.ordinal, version_claims.subject_id, version_claims.claim_id,
            version_claims.facet, version_claims.text, version_claims.status,
            version_claims.strength, version_claims.observed_in_json,
            version_claims.valid_from, version_claims.valid_to,
            version_claims.created_in_version_id, version_claims.superseded_by_claim_id,
            created_versions.id AS existing_created_in_version_id,
            created_versions.subject_id AS created_in_subject_id
     FROM version_claims
     LEFT JOIN versions AS created_versions
       ON created_versions.id = version_claims.created_in_version_id
     WHERE version_claims.version_id = ?
     ORDER BY version_claims.ordinal`,
    [versionId],
    "version claims",
  );
  const evidenceRows = queryAll(
    database,
    `SELECT claim_id, ordinal, material_id, quote, locator_start, locator_end
     FROM version_claim_evidence
     WHERE version_id = ?
     ORDER BY claim_id COLLATE BINARY, ordinal`,
    [versionId],
    "version claim evidence",
  );
  const evidenceByClaim = new Map<string, typeof evidenceRows>();
  for (const row of evidenceRows) {
    const claimId = text(row, "claim_id");
    evidenceByClaim.set(claimId, [...(evidenceByClaim.get(claimId) ?? []), row]);
  }
  const claims = claimRows.map((row, index): Claim => {
    if (integer(row, "ordinal") !== index) {
      throw storageCorrupt("SQLite version claim ordinals are not contiguous.");
    }
    if (text(row, "subject_id") !== subjectId) {
      throw storageCorrupt("SQLite version claim belongs to a different subject.");
    }
    const createdInVersionId = text(row, "created_in_version_id");
    if (
      nullableText(row, "existing_created_in_version_id") !== createdInVersionId ||
      nullableText(row, "created_in_subject_id") !== subjectId
    ) {
      throw storageCorrupt("SQLite version claim has cross-subject creation lineage.");
    }
    const claimId = parseStored(
      () => claimIdSchema.parse(text(row, "claim_id")),
      "version claim id",
    );
    const evidence = (evidenceByClaim.get(claimId) ?? []).map((item, evidenceIndex) => {
      if (integer(item, "ordinal") !== evidenceIndex) {
        throw storageCorrupt("SQLite claim evidence ordinals are not contiguous.");
      }
      const start = nullableInteger(item, "locator_start");
      const end = nullableInteger(item, "locator_end");
      if ((start === undefined) !== (end === undefined)) {
        throw storageCorrupt("SQLite claim evidence has an incomplete locator.");
      }
      return {
        materialId: parseStored(
          () => materialIdSchema.parse(text(item, "material_id")),
          "claim evidence material id",
        ),
        quote: text(item, "quote"),
        ...(start === undefined ? {} : { locator: { start, end: end! } }),
      };
    });
    evidenceByClaim.delete(claimId);
    const observedJson = text(row, "observed_in_json");
    const observedIn = parseJson(observedJson, "claim observed contexts");
    canonicalText(observedIn, observedJson, "claim observed contexts");
    const validFrom = nullableText(row, "valid_from");
    const validTo = nullableText(row, "valid_to");
    const supersededBy = nullableText(row, "superseded_by_claim_id");
    return parseStored(
      () =>
        claimSchema.parse({
          id: claimId,
          facet: facetPathSchema.parse(text(row, "facet")),
          text: text(row, "text"),
          evidence,
          status: text(row, "status"),
          strength: text(row, "strength"),
          observedIn,
          ...(validFrom === undefined ? {} : { validFrom: isoDateTimeSchema.parse(validFrom) }),
          ...(validTo === undefined ? {} : { validTo: isoDateTimeSchema.parse(validTo) }),
          createdIn: versionIdSchema.parse(createdInVersionId),
          ...(supersededBy === undefined
            ? {}
            : { supersededBy: claimIdSchema.parse(supersededBy) }),
        }) as Claim,
      "version claim",
    );
  });
  if (evidenceByClaim.size !== 0) {
    throw storageCorrupt("SQLite evidence points to an absent version claim.");
  }
  return parseStored(
    () =>
      versionClaimsSnapshotSchema.parse(
        sealFact<VersionClaimsSnapshot>({
          schemaVersion: 1,
          subjectId,
          versionId,
          claims,
        }),
      ) as VersionClaimsSnapshot,
    "version claims snapshot",
  );
};

/**
 * Reads and verifies one immutable version inside the caller's SQLite snapshot.
 *
 * @param database - Connection inside an active read or write transaction.
 * @param subjectId - Expected subject authority.
 * @param versionId - Exact immutable version id.
 * @returns Complete verified version facts, or undefined when absent.
 */
export const readSqliteVersionInTransaction = (
  database: DatabaseSync,
  subjectId: SubjectId,
  versionId: VersionId,
): SqliteStoredVersion | undefined => {
  const row = queryOne(
    database,
    `SELECT versions.id, versions.subject_id, versions.subject_display_name,
            versions.parent_id, versions.derived_from_candidate_version_id,
            versions.generation, versions.material_set_hash, versions.material_count,
            versions.creation_json, versions.created_disposition, versions.actor_json,
            versions.quality_json, versions.renderer_version, versions.review_reasons_json,
            versions.accepted_patch_digest, versions.created_at, versions.record_json,
            version_statuses.status,
            version_statuses.subject_id AS status_subject_id,
            parent_versions.id AS existing_parent_id,
            parent_versions.subject_id AS parent_subject_id,
            candidate_versions.id AS existing_candidate_id,
            candidate_versions.subject_id AS candidate_subject_id
     FROM versions
     LEFT JOIN version_statuses ON version_statuses.version_id = versions.id
     LEFT JOIN versions AS parent_versions ON parent_versions.id = versions.parent_id
     LEFT JOIN versions AS candidate_versions
       ON candidate_versions.id = versions.derived_from_candidate_version_id
     WHERE versions.id = ? AND versions.subject_id = ?`,
    [versionId, subjectId],
    "an immutable version",
  );
  if (row === undefined) return undefined;
  const authorityRecord = parseVersionAuthorityRecord(text(row, "record_json"));
  const version = authorityRecord.version;
  const reviewReasonsJson = nullableText(row, "review_reasons_json");
  const parentId = nullableText(row, "parent_id");
  const candidateId = nullableText(row, "derived_from_candidate_version_id");
  const acceptedPatchDigest = parseStored(
    () => contentDigestSchema.parse(text(row, "accepted_patch_digest")),
    "accepted patch digest",
  );
  if (nullableText(row, "status_subject_id") !== subjectId) {
    throw storageCorrupt("SQLite version status belongs to a different subject.");
  }
  if (
    version.id !== versionId ||
    version.subjectId !== subjectId ||
    text(row, "id") !== version.id ||
    text(row, "subject_id") !== version.subjectId ||
    text(row, "subject_display_name") !== version.subjectDisplayName ||
    parentId !== version.parentId ||
    candidateId !== version.derivedFromCandidateVersionId ||
    integer(row, "generation") !== version.generation ||
    text(row, "material_set_hash") !== version.materialSetHash ||
    integer(row, "material_count") !== version.materialCount ||
    text(row, "created_disposition") !== version.createdDisposition ||
    text(row, "renderer_version") !== version.rendererVersion ||
    text(row, "created_at") !== version.createdAt ||
    canonicalJson(version.creation) !== text(row, "creation_json") ||
    canonicalJson(version.actor) !== text(row, "actor_json") ||
    canonicalJson(version.quality) !== text(row, "quality_json") ||
    acceptedPatchDigest !== authorityRecord.acceptedPatchDigest ||
    (version.reviewReasons === undefined
      ? reviewReasonsJson !== undefined
      : reviewReasonsJson !== canonicalJson(version.reviewReasons))
  ) {
    throw storageCorrupt("SQLite version columns disagree with their canonical record.");
  }
  if (
    (parentId === undefined
      ? nullableText(row, "existing_parent_id") !== undefined ||
        nullableText(row, "parent_subject_id") !== undefined
      : nullableText(row, "existing_parent_id") !== parentId ||
        nullableText(row, "parent_subject_id") !== subjectId) ||
    (candidateId === undefined
      ? nullableText(row, "existing_candidate_id") !== undefined ||
        nullableText(row, "candidate_subject_id") !== undefined
      : nullableText(row, "existing_candidate_id") !== candidateId ||
        nullableText(row, "candidate_subject_id") !== subjectId)
  ) {
    throw storageCorrupt("SQLite version lineage belongs to a different subject.");
  }
  const stored: SqliteStoredVersion = {
    version,
    manifest: readManifest(database, subjectId, versionId),
    claims: readClaims(database, subjectId, versionId),
    status: parseStored(() => versionStatusSchema.parse(text(row, "status")), "version status"),
    acceptedPatchDigest,
  };
  validateCompleteVersion(stored);
  return stored;
};

/**
 * Inserts one complete immutable version under the caller's active write transaction.
 *
 * @param database - Connection inside the owning business transaction.
 * @param input - Canonical version, membership, claims, status, and patch digest.
 */
export const insertSqliteVersionInTransaction = (
  database: DatabaseSync,
  input: SqliteVersionInsert,
): void => {
  validateCompleteVersion(input);
  if (input.status !== input.version.createdDisposition) {
    throw storageCorrupt("A new SQLite version status disagrees with its created disposition.");
  }
  const version = input.version;
  const authorityRecord = sealFact<SqliteVersionAuthorityRecord>({
    schemaVersion: 1,
    version,
    acceptedPatchDigest: input.acceptedPatchDigest,
  });
  database
    .prepare(
      `INSERT INTO versions(
         id, subject_id, subject_display_name, parent_id,
         derived_from_candidate_version_id, generation, material_set_hash,
         material_count, creation_json, created_disposition, actor_json,
         quality_json, renderer_version, review_reasons_json,
         accepted_patch_digest, created_at, record_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      version.id,
      version.subjectId,
      version.subjectDisplayName,
      version.parentId ?? null,
      version.derivedFromCandidateVersionId ?? null,
      version.generation,
      version.materialSetHash,
      version.materialCount,
      canonicalJson(version.creation),
      version.createdDisposition,
      canonicalJson(version.actor),
      canonicalJson(version.quality),
      version.rendererVersion,
      version.reviewReasons === undefined ? null : canonicalJson(version.reviewReasons),
      input.acceptedPatchDigest,
      version.createdAt,
      canonicalJson(authorityRecord),
    );
  database
    .prepare("INSERT INTO version_statuses(version_id, subject_id, status) VALUES (?, ?, ?)")
    .run(version.id, version.subjectId, input.status);
  for (const [ordinal, entry] of input.manifest.items.entries()) {
    database
      .prepare(
        `INSERT INTO version_materials(
           version_id, subject_id, ordinal, material_id, content_digest, provenance_digest
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        version.id,
        version.subjectId,
        ordinal,
        entry.materialId,
        entry.contentDigest,
        entry.provenanceDigest,
      );
  }
  for (const [ordinal, claim] of input.claims.claims.entries()) {
    database
      .prepare(
        `INSERT INTO version_claims(
           version_id, subject_id, ordinal, claim_id, facet, text, status, strength,
           observed_in_json, valid_from, valid_to, created_in_version_id,
           superseded_by_claim_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        version.id,
        version.subjectId,
        ordinal,
        claim.id,
        claim.facet,
        claim.text,
        claim.status,
        claim.strength,
        canonicalJson(claim.observedIn),
        claim.validFrom ?? null,
        claim.validTo ?? null,
        claim.createdIn,
        claim.supersededBy ?? null,
      );
    for (const [evidenceOrdinal, evidence] of claim.evidence.entries()) {
      database
        .prepare(
          `INSERT INTO version_claim_evidence(
             version_id, claim_id, ordinal, material_id, quote, locator_start, locator_end
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          version.id,
          claim.id,
          evidenceOrdinal,
          evidence.materialId,
          evidence.quote,
          evidence.locator?.start ?? null,
          evidence.locator?.end ?? null,
        );
    }
  }
};
