import { z } from "zod";

import type {
  BriefContractDigest,
  BriefMaterialRef,
  CaptureAuditRef,
  CaptureScopeDigest,
  ClaimId,
  ContentDigest,
  ConversationSourceKey,
  EventId,
  FacetPath,
  FactChecksum,
  HostName,
  IsoDateTime,
  JobId,
  LeaseId,
  LeaseOwnerId,
  MaterialId,
  MaterialSetHash,
  ProvenanceDigest,
  RawId,
  RelationId,
  RequestId,
  SourceGroupKey,
  SpaceId,
  SubjectId,
  VersionId,
} from "../ids.js";

const HEX_64 = "[0-9a-f]{64}";
const HEX_32 = "[0-9a-f]{32}";

const brandedDigest = <T extends string>(prefix: string) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}${HEX_64}$`))
    .transform((value) => value as T);

const brandedRandomId = <T extends string>(prefix: string) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}${HEX_32}$`))
    .transform((value) => value as T);

/** Runtime schema for an engine-generated subject id. */
export const subjectIdSchema = brandedRandomId<SubjectId>("subject_");

/** Runtime schema for an engine-generated space id. */
export const spaceIdSchema = brandedRandomId<SpaceId>("space_");

/** Runtime schema for an engine-generated pending-job id. */
export const jobIdSchema = brandedRandomId<JobId>("job_");

/** Runtime schema for an engine-generated lease id. */
export const leaseIdSchema = brandedRandomId<LeaseId>("lease_");

/** Runtime schema for a client-session lease owner identity. */
export const leaseOwnerIdSchema = brandedRandomId<LeaseOwnerId>("lease_owner_");

/** Runtime schema for an engine-generated event id. */
export const eventIdSchema = brandedRandomId<EventId>("event_");

/** Runtime schema for an unguessable capture audit reference. */
export const captureAuditRefSchema = brandedRandomId<CaptureAuditRef>("capture_");

/** Runtime schema for content-addressed raw bytes. */
export const rawIdSchema = brandedDigest<RawId>("raw_");

/** Runtime schema for a deterministic immutable version id. */
export const versionIdSchema = brandedDigest<VersionId>("version_");

/** Runtime schema for a deterministic claim id. */
export const claimIdSchema = brandedDigest<ClaimId>("claim_");

/** Runtime schema for a deterministic relation id. */
export const relationIdSchema = brandedDigest<RelationId>("relation_");

/** Runtime schema for a canonical JSON fact checksum. */
export const factChecksumSchema = brandedDigest<FactChecksum>("fact_sha256_");

/** Runtime schema for a full SHA-256 content digest. */
export const contentDigestSchema = brandedDigest<ContentDigest>("sha256_");

/** Runtime schema for provenance participating in MaterialId. */
export const provenanceDigestSchema = brandedDigest<ProvenanceDigest>("provenance_sha256_");

/** Runtime schema for a material identity. */
export const materialIdSchema = brandedDigest<MaterialId>("mat_");

/** Runtime schema for a complete material-set hash. */
export const materialSetHashSchema = brandedDigest<MaterialSetHash>("set_sha256_");

/** Runtime schema for an engine-derived source group. */
export const sourceGroupKeySchema = brandedDigest<SourceGroupKey>("sg_");

/** Runtime schema for a keyed private-capture scope fingerprint. */
export const captureScopeDigestSchema = brandedDigest<CaptureScopeDigest>("capture_scope_");

/** Runtime schema for a keyed private-conversation source. */
export const conversationSourceKeySchema = brandedDigest<ConversationSourceKey>("conversation_");

/** Runtime schema for a pinned host-distillation contract. */
export const briefContractDigestSchema = brandedDigest<BriefContractDigest>("brief_contract_");

/** Runtime schema for a non-empty, bounded idempotency key. */
export const requestIdSchema = z
  .string()
  .regex(/^req_[0-9a-f]{32}$/)
  .transform((value) => value as RequestId);

/** Runtime schema for canonical UTC millisecond RFC 3339 timestamps. */
export const isoDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
  })
  .transform((value) => value as IsoDateTime);

/** Runtime schema for a provider-neutral lowercase host slug. */
export const hostNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .transform((value) => value as HostName);

/** Runtime schema for a bounded dotted facet path. */
export const facetPathSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_]{0,31}(?:\.[a-z][a-z0-9_]{0,31})*$/)
  .transform((value) => value as FacetPath);

/** Runtime schema for one short material handle within a briefing. */
export const briefMaterialRefSchema = z
  .string()
  .regex(/^m(?:00[1-9]|0[1-9][0-9]|[1-9][0-9]{2})$/)
  .transform((value) => value as BriefMaterialRef);

/** Named digest schemas used by contract fixtures and boundary maps. */
export const digestSchemas = {
  fact: factChecksumSchema,
  content: contentDigestSchema,
  provenance: provenanceDigestSchema,
  material: materialIdSchema,
  materialSet: materialSetHashSchema,
  sourceGroup: sourceGroupKeySchema,
  captureScope: captureScopeDigestSchema,
  conversation: conversationSourceKeySchema,
  briefContract: briefContractDigestSchema,
} as const;

/** Complete branded-value schema registry used by contract fixtures. */
export const brandedValueSchemas = {
  subject: subjectIdSchema,
  space: spaceIdSchema,
  material: materialIdSchema,
  raw: rawIdSchema,
  fact: factChecksumSchema,
  content: contentDigestSchema,
  provenance: provenanceDigestSchema,
  materialSet: materialSetHashSchema,
  version: versionIdSchema,
  job: jobIdSchema,
  lease: leaseIdSchema,
  leaseOwner: leaseOwnerIdSchema,
  claim: claimIdSchema,
  relation: relationIdSchema,
  request: requestIdSchema,
  event: eventIdSchema,
  isoDateTime: isoDateTimeSchema,
  host: hostNameSchema,
  facet: facetPathSchema,
  sourceGroup: sourceGroupKeySchema,
  captureAudit: captureAuditRefSchema,
  captureScope: captureScopeDigestSchema,
  conversation: conversationSourceKeySchema,
  briefContract: briefContractDigestSchema,
  briefMaterial: briefMaterialRefSchema,
} as const;
