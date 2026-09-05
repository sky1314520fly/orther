import type {
  MaterialRecord,
  SourceDiversityStatus,
  SourceGroup,
  SourceGroupBasis,
  SourceGroupCaution,
  SourceGroupKey,
  SourceGroupingSnapshot,
} from "@distilly/protocol";

import { canonicalJson } from "../facts/canonical-json.js";
import { sha256Hex } from "../facts/checksum.js";
import { schemaUnsupported, storageCorrupt } from "../internal-errors.js";

const SOURCE_GROUPING_VERSION = "source-groups-v1";
const SOURCE_GROUP_KEY_NAMESPACE = `${SOURCE_GROUPING_VERSION}\0`;

const BASIS_ORDER: readonly SourceGroupBasis[] = [
  "same_raw",
  "same_private_conversation",
  "representation_of",
  "provider_artifact",
  "canonical_uri",
  "exact_republication",
  "unknown",
];

const CAUTION_ORDER: readonly SourceGroupCaution[] = [
  "access_conflict",
  "private_source",
  "restricted_source",
  "correction",
  "insufficient_public_proof",
];

type ProofKind = "raw" | "conversation" | "provider" | "uri" | "content";
type SourceAccess = MaterialRecord["source"]["access"];

interface LocalProof {
  readonly key: string;
  readonly kind: ProofKind;
  readonly representationEndpoint: boolean;
  readonly qualifyingAccess: boolean;
}

interface MutableLocalProof {
  readonly key: string;
  readonly kind: ProofKind;
  representationEndpoint: boolean;
  qualifyingAccess: boolean;
}

interface ProofUsage {
  readonly kind: ProofKind;
  readonly materialIndexes: Set<number>;
  readonly qualifyingAccesses: Set<SourceAccess>;
  representationEndpoint: boolean;
}

interface ComponentFacts {
  readonly proofKeys: Set<string>;
  readonly bases: Set<SourceGroupBasis>;
  accessConflict: boolean;
  hasOnlyPublicProof: boolean;
  hasPrivateSource: boolean;
  hasRestrictedSource: boolean;
  hasCorrection: boolean;
  hasConversation: boolean;
}

const compareUtf8 = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const createDisjointSet = (size: number) => {
  const parents = Array.from({ length: size }, (_, index) => index);
  const ranks = Array.from({ length: size }, () => 0);

  const find = (index: number): number => {
    const parent = parents[index]!;
    if (parent === index) return index;
    const root = find(parent);
    parents[index] = root;
    return root;
  };

  const union = (left: number, right: number): void => {
    let leftRoot = find(left);
    let rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const leftRank = ranks[leftRoot]!;
    const rightRank = ranks[rightRoot]!;
    if (leftRank < rightRank) {
      [leftRoot, rightRoot] = [rightRoot, leftRoot];
    }
    parents[rightRoot] = leftRoot;
    if (leftRank === rightRank) ranks[leftRoot] = leftRank + 1;
  };

  return { find, union };
};

const materialProofs = (record: MaterialRecord): readonly LocalProof[] => {
  const proofs = new Map<string, MutableLocalProof>();
  const add = (
    key: string,
    kind: ProofKind,
    representationEndpoint = false,
    qualifyingAccess = false,
  ): void => {
    const existing = proofs.get(key);
    if (existing === undefined) {
      proofs.set(key, { key, kind, representationEndpoint, qualifyingAccess });
      return;
    }
    existing.representationEndpoint ||= representationEndpoint;
    existing.qualifyingAccess ||= qualifyingAccess;
  };

  const addLocator = (
    locator: NonNullable<MaterialRecord["source"]["artifact"]>,
    representationEndpoint: boolean,
    qualifyingAccess: boolean,
  ): void => {
    if (locator.externalId !== undefined) {
      add(
        `provider-artifact-v1\0${locator.provider}\0${locator.externalId}`,
        "provider",
        representationEndpoint,
        qualifyingAccess,
      );
    }
    if (locator.canonicalUri !== undefined) {
      add(`uri-v1\0${locator.canonicalUri}`, "uri", representationEndpoint, qualifyingAccess);
    }
  };

  if (record.derivation.kind === "raw_extract") {
    add(`raw-v1\0${record.derivation.rawId}`, "raw");
  }
  if (record.conversationSourceKey !== undefined) {
    add(`conversation-v1\0${record.conversationSourceKey}`, "conversation");
  }
  if (record.source.artifact !== undefined) {
    addLocator(record.source.artifact, false, true);
  } else if (record.source.uri !== undefined) {
    add(`uri-v1\0${record.source.uri}`, "uri", false, true);
  }
  if (record.source.representationOf !== undefined) {
    addLocator(record.source.representationOf, true, false);
  }
  add(`content-v1\0${record.contentDigest}`, "content");

  return [...proofs.values()].sort((left, right) => compareUtf8(left.key, right.key));
};

const componentFacts = (): ComponentFacts => ({
  proofKeys: new Set(),
  bases: new Set(),
  accessConflict: false,
  hasOnlyPublicProof: false,
  hasPrivateSource: false,
  hasRestrictedSource: false,
  hasCorrection: false,
  hasConversation: false,
});

const basisForProof = (kind: ProofKind): SourceGroupBasis => {
  switch (kind) {
    case "raw":
      return "same_raw";
    case "conversation":
      return "same_private_conversation";
    case "provider":
      return "provider_artifact";
    case "uri":
      return "canonical_uri";
    case "content":
      return "exact_republication";
  }
};

const freezeGroup = (facts: ComponentFacts): SourceGroup => {
  const bases = BASIS_ORDER.filter((basis) => facts.bases.has(basis));
  if (bases.length === 0) bases.push("unknown");

  const diversityStatus: SourceDiversityStatus = facts.accessConflict
    ? "ineligible"
    : facts.hasOnlyPublicProof
      ? "eligible"
      : facts.hasPrivateSource ||
          facts.hasRestrictedSource ||
          facts.hasCorrection ||
          facts.hasConversation
        ? "ineligible"
        : "unknown";

  const cautionSet = new Set<SourceGroupCaution>();
  if (facts.accessConflict) cautionSet.add("access_conflict");
  if (facts.hasPrivateSource || facts.hasConversation) cautionSet.add("private_source");
  if (facts.hasRestrictedSource) cautionSet.add("restricted_source");
  if (facts.hasCorrection) cautionSet.add("correction");
  if (!facts.hasOnlyPublicProof) cautionSet.add("insufficient_public_proof");

  const proofKeys = [...facts.proofKeys].sort(compareUtf8);
  const key = `sg_${sha256Hex(
    new TextEncoder().encode(`${SOURCE_GROUP_KEY_NAMESPACE}${canonicalJson(proofKeys)}`),
  )}` as SourceGroupKey;
  const frozenBases = Object.freeze(bases);
  const frozenCautions = Object.freeze(CAUTION_ORDER.filter((caution) => cautionSet.has(caution)));
  return Object.freeze({
    key,
    bases: frozenBases,
    diversityStatus,
    cautions: frozenCautions,
  });
};

/**
 * Derives deterministic source groups for one complete material snapshot.
 *
 * @param records - Verified material records in any input order.
 * @param sourceGroupingVersion - Exact grouping algorithm selected by a brief or version.
 * @returns A stable MaterialId-to-group map whose component members share one frozen value.
 */
export const deriveSourceGroups = (
  records: readonly MaterialRecord[],
  sourceGroupingVersion: string,
): SourceGroupingSnapshot => {
  if (sourceGroupingVersion !== SOURCE_GROUPING_VERSION) {
    throw schemaUnsupported(`Unsupported source grouping version: ${sourceGroupingVersion}`);
  }

  const orderedRecords = [...records].sort((left, right) => compareUtf8(left.id, right.id));
  for (let index = 1; index < orderedRecords.length; index += 1) {
    if (orderedRecords[index - 1]!.id === orderedRecords[index]!.id) {
      throw storageCorrupt("Source grouping input contains a duplicate MaterialId.");
    }
  }

  const disjointSet = createDisjointSet(orderedRecords.length);
  const usages = new Map<string, ProofUsage>();
  for (const [materialIndex, record] of orderedRecords.entries()) {
    for (const proof of materialProofs(record)) {
      const usage = usages.get(proof.key);
      if (usage === undefined) {
        usages.set(proof.key, {
          kind: proof.kind,
          materialIndexes: new Set([materialIndex]),
          qualifyingAccesses: new Set(proof.qualifyingAccess ? [record.source.access] : []),
          representationEndpoint: proof.representationEndpoint,
        });
        continue;
      }
      const firstMaterial = usage.materialIndexes.values().next().value as number;
      disjointSet.union(firstMaterial, materialIndex);
      usage.materialIndexes.add(materialIndex);
      usage.representationEndpoint ||= proof.representationEndpoint;
      if (proof.qualifyingAccess) usage.qualifyingAccesses.add(record.source.access);
    }
  }

  const factsByRoot = new Map<number, ComponentFacts>();
  const factsFor = (materialIndex: number): ComponentFacts => {
    const root = disjointSet.find(materialIndex);
    const existing = factsByRoot.get(root);
    if (existing !== undefined) return existing;
    const created = componentFacts();
    factsByRoot.set(root, created);
    return created;
  };

  for (const [materialIndex, record] of orderedRecords.entries()) {
    const facts = factsFor(materialIndex);
    facts.hasPrivateSource ||= record.source.access === "private";
    facts.hasRestrictedSource ||= record.source.access === "restricted";
    facts.hasCorrection ||= record.kind === "correction";
    facts.hasConversation ||= record.conversationSourceKey !== undefined;
  }

  for (const [proofKey, usage] of usages) {
    const firstMaterial = usage.materialIndexes.values().next().value as number;
    const facts = factsFor(firstMaterial);
    facts.proofKeys.add(proofKey);
    if (usage.materialIndexes.size >= 2) {
      facts.bases.add(basisForProof(usage.kind));
      if (usage.representationEndpoint && (usage.kind === "provider" || usage.kind === "uri")) {
        facts.bases.add("representation_of");
      }
    }

    const hasPublic = usage.qualifyingAccesses.has("public");
    const hasNonPublic =
      usage.qualifyingAccesses.has("private") || usage.qualifyingAccesses.has("restricted");
    facts.accessConflict ||= hasPublic && hasNonPublic;
    facts.hasOnlyPublicProof ||= hasPublic && !hasNonPublic;
  }

  const groupByRoot = new Map<number, SourceGroup>();
  for (const [root, facts] of factsByRoot) groupByRoot.set(root, freezeGroup(facts));

  const groups = new Map<MaterialRecord["id"], SourceGroup>();
  for (const [materialIndex, record] of orderedRecords.entries()) {
    groups.set(record.id, groupByRoot.get(disjointSet.find(materialIndex))!);
  }
  return { sourceGroupingVersion: SOURCE_GROUPING_VERSION, groups };
};
