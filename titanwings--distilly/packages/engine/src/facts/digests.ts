import type {
  BriefContract,
  BriefContractDigest,
  CaptureAuditRef,
  ConversationSourceKey,
  ContentDigest,
  CorrectionProvenance,
  DistillPatch,
  MaterialId,
  MaterialInput,
  MaterialRecord,
  MaterialSetHash,
  MaterialSource,
  ProvenanceDigest,
  TextDerivation,
  VersionMaterialEntry,
} from "@distilly/protocol";

import { storageCorrupt } from "../internal-errors.js";
import { canonicalJsonBytes } from "./canonical-json.js";
import { sha256Hex } from "./checksum.js";

const PROVENANCE_NAMESPACE = "distilly:provenance:v1\0";
const MATERIAL_SET_NAMESPACE = "distilly:material-set:v1\0";
const BRIEF_CONTRACT_NAMESPACE = "brief-contract-v1\0";
const DISTILL_PATCH_NAMESPACE = "distill-patch-v1\0";

/**
 * Recomputes the digest that pins source grouping, prompt bytes, and draft schema.
 *
 * @param contract - Exact version fields; the digest itself is excluded from the preimage.
 * @returns The namespaced full SHA-256 brief-contract digest.
 */
export const digestBriefContract = (
  contract: Omit<BriefContract, "digest">,
): BriefContractDigest => {
  const fields = {
    sourceGroupingVersion: contract.sourceGroupingVersion,
    promptVersion: contract.promptVersion,
    draftSchemaVersion: contract.draftSchemaVersion,
  };
  return `brief_contract_${sha256Hex(
    new Uint8Array([
      ...new TextEncoder().encode(BRIEF_CONTRACT_NAMESPACE),
      ...canonicalJsonBytes(fields),
    ]),
  )}` as BriefContractDigest;
};

/**
 * Hashes normalized UTF-8 material text with full SHA-256.
 *
 * @param content - Normalized material text to hash.
 * @returns The content digest used by material identities.
 */
export const digestContent = (content: string): ContentDigest =>
  `sha256_${sha256Hex(content)}` as ContentDigest;

/**
 * Hashes one accepted claim patch for durable commit-journal correlation.
 *
 * @param patch - Schema-normalized, claim-only patch accepted by CommitService.
 * @returns The namespaced full SHA-256 patch digest.
 */
export const digestDistillPatch = (patch: DistillPatch): ContentDigest =>
  `sha256_${sha256Hex(
    new Uint8Array([
      ...new TextEncoder().encode(DISTILL_PATCH_NAMESPACE),
      ...canonicalJsonBytes(patch),
    ]),
  )}` as ContentDigest;

/** Normalized fields covered by ProvenanceDigest. */
export interface MaterialProvenanceInput {
  readonly kind: MaterialInput["kind"] | "correction";
  readonly source: MaterialSource;
  readonly derivation: TextDerivation;
  readonly participants: readonly string[];
  readonly sensitivity: "private" | "shareable";
  readonly flags: readonly "suspicious_source"[];
  readonly correctionProvenance?: CorrectionProvenance;
  readonly captureAuditRef?: CaptureAuditRef;
  readonly conversationSourceKey?: ConversationSourceKey;
}

const provenanceSource = (source: MaterialSource) => ({
  medium: source.medium,
  access: source.access,
  ...(source.role === undefined ? {} : { role: source.role }),
  ...(source.artifact === undefined ? {} : { artifact: source.artifact }),
  ...(source.representationOf === undefined ? {} : { representationOf: source.representationOf }),
  ...(source.occurredAt === undefined ? {} : { occurredAt: source.occurredAt }),
  ...(source.publishedAt === undefined ? {} : { publishedAt: source.publishedAt }),
  ...(source.language === undefined ? {} : { language: source.language }),
  authors: source.authors,
});

/**
 * Hashes the normalized provenance fields that change grouping, safety, or export behavior.
 *
 * @param input - Normalized provenance, excluding retrieval URI and display-only fields.
 * @returns The namespaced provenance digest.
 */
export const digestProvenance = (input: MaterialProvenanceInput): ProvenanceDigest => {
  const preimage = {
    kind: input.kind,
    source: provenanceSource(input.source),
    derivation: input.derivation,
    participants: input.participants,
    sensitivity: input.sensitivity,
    flags: input.flags,
    ...(input.correctionProvenance === undefined
      ? {}
      : { correctionProvenance: input.correctionProvenance }),
    ...(input.captureAuditRef === undefined ? {} : { captureAuditRef: input.captureAuditRef }),
    ...(input.conversationSourceKey === undefined
      ? {}
      : { conversationSourceKey: input.conversationSourceKey }),
  };
  return `provenance_sha256_${sha256Hex(
    new Uint8Array([
      ...new TextEncoder().encode(PROVENANCE_NAMESPACE),
      ...canonicalJsonBytes(preimage),
    ]),
  )}` as ProvenanceDigest;
};

/**
 * Recomputes the provenance fields that affect grouping, safety, and export.
 *
 * @param record - Material record containing the normalized provenance fields.
 * @returns The namespaced provenance digest.
 */
export const digestMaterialProvenance = (record: MaterialRecord): ProvenanceDigest => {
  return digestProvenance(record);
};

/**
 * Derives a material id from source, provenance, and content identities.
 *
 * @param sourceIdentity - Stable source identity participating in material identity.
 * @param provenanceDigest - Digest of provenance fields that affect identity.
 * @param contentDigest - Digest of the normalized material text.
 * @returns The deterministic content-addressed material identifier.
 */
export const deriveMaterialId = (
  sourceIdentity: string,
  provenanceDigest: ProvenanceDigest,
  contentDigest: ContentDigest,
): MaterialId =>
  `mat_${sha256Hex(`${sourceIdentity}\0${provenanceDigest}\0${contentDigest}`)}` as MaterialId;

/**
 * Hashes a current or historical material manifest independent of input order.
 *
 * @param entries - Material identifiers and content digests in the manifest.
 * @returns The deterministic material-set hash.
 */
export const hashMaterialSet = (entries: readonly VersionMaterialEntry[]): MaterialSetHash => {
  const ordered = [...entries].sort((left, right) =>
    left.materialId < right.materialId ? -1 : left.materialId > right.materialId ? 1 : 0,
  );
  const body = ordered.map((entry) => `${entry.materialId}\0${entry.contentDigest}`).join("\0");
  return `set_sha256_${sha256Hex(`${MATERIAL_SET_NAMESPACE}${body}`)}` as MaterialSetHash;
};

/**
 * Verifies every content-addressed identity stored beside a material body.
 *
 * @param record - Stored material record to verify.
 * @param content - Exact material body read from content.txt.
 */
export const verifyMaterialIdentity = (record: MaterialRecord, content: string): void => {
  if (digestContent(content) !== record.contentDigest) {
    throw storageCorrupt("Material content digest does not match content.txt.");
  }
  if (digestMaterialProvenance(record) !== record.provenanceDigest) {
    throw storageCorrupt("Material provenance digest does not match its record.");
  }
  if (
    deriveMaterialId(record.sourceIdentity, record.provenanceDigest, record.contentDigest) !==
    record.id
  ) {
    throw storageCorrupt("Material id does not match source, provenance, and content digests.");
  }
};
