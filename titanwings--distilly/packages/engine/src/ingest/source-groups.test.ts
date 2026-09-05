import {
  captureAuditRefSchema,
  conversationSourceKeySchema,
  materialRecordSchema,
  rawIdSchema,
} from "@distilly/protocol";
import type {
  CaptureAuditRef,
  ConversationSourceKey,
  CorrectionProvenance,
  MaterialRecord,
  MaterialSource,
  RawId,
  TextDerivation,
} from "@distilly/protocol";
import { describe, expect, it } from "vitest";

import { sealFact } from "../facts/checksum.js";
import { deriveMaterialId, digestContent, digestProvenance } from "../facts/digests.js";
import { deriveSourceGroups } from "./source-groups.js";

const SUBJECT_ID = `subject_${"a".repeat(32)}` as MaterialRecord["subjectId"];
const STORED_AT = "2026-08-20T00:00:00.000Z" as MaterialRecord["storedAt"];
const RAW_ID = rawIdSchema.parse(`raw_${"b".repeat(64)}`);
const CONVERSATION_ID = conversationSourceKeySchema.parse(`conversation_${"c".repeat(64)}`);
const OTHER_CONVERSATION_ID = conversationSourceKeySchema.parse(`conversation_${"d".repeat(64)}`);
const CAPTURE_ONE = captureAuditRefSchema.parse(`capture_${"1".repeat(32)}`);
const CAPTURE_TWO = captureAuditRefSchema.parse(`capture_${"2".repeat(32)}`);
const SHARED_CAPTURE = captureAuditRefSchema.parse(`capture_${"3".repeat(32)}`);

const publicSource = (overrides: Partial<MaterialSource> = {}): MaterialSource => ({
  medium: "article",
  access: "public",
  capturedAt: STORED_AT,
  authors: [],
  ...overrides,
});

const rawDerivation = (rawId: RawId = RAW_ID): TextDerivation => ({
  kind: "raw_extract",
  rawId,
  method: "document_text",
  producer: "fixture-parser",
});

const captureSource = (): MaterialSource => ({
  medium: "conversation",
  access: "private",
  role: "personal_communication",
  capturedAt: STORED_AT,
  authors: [],
});

const captureDerivation = (): TextDerivation => ({
  kind: "host_extract",
  method: "computer_use_transcript",
  producer: "fixture-host",
});

interface MaterialFixtureInput {
  readonly label: string;
  readonly content?: string;
  readonly kind?: MaterialRecord["kind"];
  readonly source?: MaterialSource;
  readonly derivation?: TextDerivation;
  readonly sensitivity?: MaterialRecord["sensitivity"];
  readonly correctionProvenance?: CorrectionProvenance;
  readonly captureAuditRef?: CaptureAuditRef;
  readonly conversationSourceKey?: ConversationSourceKey;
}

const material = (input: MaterialFixtureInput): MaterialRecord => {
  const kind = input.kind ?? "web";
  const source = input.source ?? publicSource();
  const derivation = input.derivation ?? { kind: "native_text" };
  const sensitivity = input.sensitivity ?? "private";
  const contentDigest = digestContent(input.content ?? input.label);
  const provenance = {
    kind,
    source,
    derivation,
    participants: [],
    sensitivity,
    flags: [],
    ...(input.correctionProvenance === undefined
      ? {}
      : { correctionProvenance: input.correctionProvenance }),
    ...(input.captureAuditRef === undefined ? {} : { captureAuditRef: input.captureAuditRef }),
    ...(input.conversationSourceKey === undefined
      ? {}
      : { conversationSourceKey: input.conversationSourceKey }),
  } as const;
  const provenanceDigest = digestProvenance(provenance);
  const sourceIdentity = `fixture-v1:${input.label}`;
  const record = sealFact<MaterialRecord>({
    schemaVersion: 1,
    id: deriveMaterialId(sourceIdentity, provenanceDigest, contentDigest),
    subjectId: SUBJECT_ID,
    kind,
    contentDigest,
    provenanceDigest,
    sourceIdentity,
    source,
    derivation,
    participants: [],
    sensitivity,
    ...(input.correctionProvenance === undefined
      ? {}
      : { correctionProvenance: input.correctionProvenance }),
    ...(input.captureAuditRef === undefined ? {} : { captureAuditRef: input.captureAuditRef }),
    ...(input.conversationSourceKey === undefined
      ? {}
      : { conversationSourceKey: input.conversationSourceKey }),
    flags: [],
    storedAt: STORED_AT,
  });
  return materialRecordSchema.parse(record) as MaterialRecord;
};

const groupFor = (records: readonly MaterialRecord[], materialRecord: MaterialRecord) =>
  deriveSourceGroups(records, "source-groups-v1").groups.get(materialRecord.id)!;

const groupEntries = (records: readonly MaterialRecord[]) =>
  [...deriveSourceGroups(records, "source-groups-v1").groups].map(([materialId, group]) => [
    materialId,
    group,
  ]);

describe("source-groups-v1", () => {
  it("unions raw, conversation, representation, artifact, URI, and content bridges transitively", () => {
    const rawLeft = material({
      label: "raw-left",
      content: "raw left",
      kind: "document",
      derivation: rawDerivation(),
    });
    const rawRight = material({
      label: "raw-right",
      content: "raw-to-conversation",
      kind: "document",
      derivation: rawDerivation(),
    });
    const conversationLeft = material({
      label: "conversation-left",
      content: "raw-to-conversation",
      kind: "transcript",
      source: captureSource(),
      derivation: captureDerivation(),
      sensitivity: "private",
      captureAuditRef: CAPTURE_ONE,
      conversationSourceKey: CONVERSATION_ID,
    });
    const conversationRight = material({
      label: "conversation-right",
      content: "conversation-to-representation",
      kind: "transcript",
      source: captureSource(),
      derivation: captureDerivation(),
      sensitivity: "private",
      captureAuditRef: CAPTURE_TWO,
      conversationSourceKey: CONVERSATION_ID,
    });
    const representation = material({
      label: "representation",
      content: "conversation-to-representation",
      kind: "transcript",
      source: publicSource({
        medium: "video",
        representationOf: { provider: "video-host", externalId: "root-artifact" },
      }),
    });
    const artifactBridge = material({
      label: "artifact-bridge",
      source: publicSource({
        medium: "video",
        artifact: {
          provider: "video-host",
          externalId: "root-artifact",
          canonicalUri: "https://example.com/videos/root-artifact",
        },
      }),
    });
    const uriEndpoint = material({
      label: "uri-endpoint",
      source: publicSource({
        artifact: {
          provider: "archive",
          canonicalUri: "https://example.com/videos/root-artifact",
        },
      }),
    });
    const records = [
      rawLeft,
      rawRight,
      conversationLeft,
      conversationRight,
      representation,
      artifactBridge,
      uriEndpoint,
    ];

    const snapshot = deriveSourceGroups(records, "source-groups-v1");
    const group = snapshot.groups.get(rawLeft.id)!;
    expect(snapshot.sourceGroupingVersion).toBe("source-groups-v1");
    expect(records.every((record) => snapshot.groups.get(record.id) === group)).toBe(true);
    expect(group.bases).toEqual([
      "same_raw",
      "same_private_conversation",
      "representation_of",
      "provider_artifact",
      "canonical_uri",
      "exact_republication",
    ]);
    expect(group.diversityStatus).toBe("eligible");
    expect(group.cautions).toEqual(["private_source"]);
    expect(Object.isFrozen(group)).toBe(true);
    expect(Object.isFrozen(group.bases)).toBe(true);
    expect(Object.isFrozen(group.cautions)).toBe(true);
    expect(groupEntries(records)).toEqual(groupEntries([...records].reverse()));
  });

  it("uses source URI only as an artifact-free fallback and pins the full component hash", () => {
    const fallbackLeft = material({
      label: "fallback-left",
      source: publicSource({ uri: "https://example.com/fallback" }),
    });
    const fallbackRight = material({
      label: "fallback-right",
      source: publicSource({ uri: "https://example.com/fallback" }),
    });
    const fallbackGroup = groupFor([fallbackLeft, fallbackRight], fallbackLeft);
    expect(fallbackGroup.bases).toEqual(["canonical_uri"]);
    expect(fallbackGroup.diversityStatus).toBe("eligible");
    expect(fallbackGroup.cautions).toEqual([]);
    expect(fallbackGroup.key).toBe(
      "sg_91090d080f76befdfd8c9cc3dc1ec6c04f266432e9c576d6d49621eebc4f3d67",
    );

    const artifactLeft = material({
      label: "artifact-left",
      source: publicSource({
        uri: "https://example.com/shared-retrieval",
        artifact: { provider: "publisher-a", externalId: "left" },
      }),
    });
    const artifactRight = material({
      label: "artifact-right",
      source: publicSource({
        uri: "https://example.com/shared-retrieval",
        artifact: { provider: "publisher-b", externalId: "right" },
      }),
    });
    const artifactSnapshot = deriveSourceGroups([artifactLeft, artifactRight], "source-groups-v1");
    expect(artifactSnapshot.groups.get(artifactLeft.id)).not.toEqual(
      artifactSnapshot.groups.get(artifactRight.id),
    );
    expect(artifactSnapshot.groups.get(artifactLeft.id)?.bases).toEqual(["unknown"]);
  });

  it("sorts non-BMP and BMP proof keys by canonical UTF-8 bytes", () => {
    const record = material({
      label: "utf8-proof-order",
      source: publicSource({
        artifact: { provider: "unicode", externalId: "𐀀" },
        representationOf: { provider: "unicode", externalId: "" },
      }),
    });

    expect(groupFor([record], record).key).toBe(
      "sg_1323cb04095150568fb62eba5d6017d2b77b975ca32ad15a1774b9c23b7c8e80",
    );
  });

  it("pins every v1 proof-key namespace in component hash goldens", () => {
    const content = material({ label: "golden-content", content: "content-proof" });
    const raw = material({
      label: "golden-raw",
      content: "raw-proof",
      kind: "document",
      derivation: rawDerivation(),
    });
    const conversation = material({
      label: "golden-conversation",
      content: "conversation-proof",
      kind: "transcript",
      source: captureSource(),
      derivation: captureDerivation(),
      sensitivity: "private",
      captureAuditRef: CAPTURE_ONE,
      conversationSourceKey: CONVERSATION_ID,
    });
    const provider = material({
      label: "golden-provider",
      content: "provider-proof",
      source: publicSource({ artifact: { provider: "publisher", externalId: "story" } }),
    });
    const representation = material({
      label: "golden-representation",
      content: "provider-proof",
      source: publicSource({
        representationOf: { provider: "publisher", externalId: "story" },
      }),
    });
    const uri = material({
      label: "golden-uri",
      content: "uri-proof",
      source: publicSource({ uri: "https://example.com/proof" }),
    });

    expect({
      content: groupFor([content], content).key,
      raw: groupFor([raw], raw).key,
      conversation: groupFor([conversation], conversation).key,
      provider: groupFor([provider], provider).key,
      representation: groupFor([representation], representation).key,
      uri: groupFor([uri], uri).key,
    }).toEqual({
      content: "sg_e9d2358abd73a703033286c3a64d976b901d07a953ebdd387acdbb7fc5fd3f8f",
      raw: "sg_b577ce635444288b75921637f50561ec2c379e71bced6ef125b0fa8dc56fe0fc",
      conversation: "sg_1e3bffdb4de70090714759da5f67e41e214cdb09cc7282df260934a734091c8e",
      provider: "sg_ed6ab72eb174959e674b6a6bb25db03d628fe6381c9d7f666d2293f6b71b1a6d",
      representation: "sg_ed6ab72eb174959e674b6a6bb25db03d628fe6381c9d7f666d2293f6b71b1a6d",
      uri: "sg_55debfd0a763ef8f9b885d32a557e00ef36e0d02120ed705fd8124a15b868d2b",
    });
  });

  it("collapses exact republication without collapsing distinct material identities", () => {
    const left = material({
      label: "republication-left",
      content: "byte-identical publication",
      source: publicSource({ uri: "https://example.com/left" }),
    });
    const right = material({
      label: "republication-right",
      content: "byte-identical publication",
      source: publicSource({ uri: "https://example.com/right" }),
    });
    expect(left.id).not.toBe(right.id);

    const snapshot = deriveSourceGroups([left, right], "source-groups-v1");
    const group = snapshot.groups.get(left.id)!;
    expect(group).toBe(snapshot.groups.get(right.id));
    expect(group.bases).toEqual(["exact_republication"]);
    expect(group.diversityStatus).toBe("eligible");
    expect(group.cautions).toEqual([]);
  });

  it("groups a private conversation across grants but ignores CaptureAuditRef itself", () => {
    const firstGrant = material({
      label: "first-grant",
      kind: "transcript",
      source: captureSource(),
      derivation: captureDerivation(),
      sensitivity: "private",
      captureAuditRef: CAPTURE_ONE,
      conversationSourceKey: CONVERSATION_ID,
    });
    const secondGrant = material({
      label: "second-grant",
      kind: "transcript",
      source: captureSource(),
      derivation: captureDerivation(),
      sensitivity: "private",
      captureAuditRef: CAPTURE_TWO,
      conversationSourceKey: CONVERSATION_ID,
    });
    const conversationGroup = groupFor([firstGrant, secondGrant], firstGrant);
    expect(conversationGroup.bases).toEqual(["same_private_conversation"]);
    expect(conversationGroup.diversityStatus).toBe("ineligible");
    expect(conversationGroup.cautions).toEqual(["private_source", "insufficient_public_proof"]);

    const auditOnlyLeft = material({
      label: "audit-only-left",
      kind: "transcript",
      source: captureSource(),
      derivation: captureDerivation(),
      sensitivity: "private",
      captureAuditRef: SHARED_CAPTURE,
      conversationSourceKey: CONVERSATION_ID,
    });
    const auditOnlyRight = material({
      label: "audit-only-right",
      kind: "transcript",
      source: captureSource(),
      derivation: captureDerivation(),
      sensitivity: "private",
      captureAuditRef: SHARED_CAPTURE,
      conversationSourceKey: OTHER_CONVERSATION_ID,
    });
    const auditSnapshot = deriveSourceGroups([auditOnlyLeft, auditOnlyRight], "source-groups-v1");
    expect(auditSnapshot.groups.get(auditOnlyLeft.id)).not.toEqual(
      auditSnapshot.groups.get(auditOnlyRight.id),
    );
  });

  it("classifies public proof, unknown provenance, and non-public sources", () => {
    const unknown = material({ label: "unknown-public" });
    const eligible = material({
      label: "eligible-public",
      source: publicSource({ artifact: { provider: "press", externalId: "story-1" } }),
    });
    const privateRecord = material({
      label: "private-source",
      source: publicSource({
        access: "private",
        artifact: { provider: "private-store", externalId: "entry-1" },
      }),
    });
    const restricted = material({
      label: "restricted-source",
      source: publicSource({
        access: "restricted",
        artifact: { provider: "archive", externalId: "entry-2" },
      }),
    });
    const correction = material({
      label: "correction-source",
      kind: "correction",
      correctionProvenance: { kind: "direct_user" },
    });
    const representationOnly = material({
      label: "representation-only",
      source: publicSource({
        representationOf: { provider: "video-host", externalId: "unproven-root" },
      }),
    });
    const records = [unknown, eligible, privateRecord, restricted, correction, representationOnly];
    const snapshot = deriveSourceGroups(records, "source-groups-v1");

    expect(snapshot.groups.get(unknown.id)).toMatchObject({
      bases: ["unknown"],
      diversityStatus: "unknown",
      cautions: ["insufficient_public_proof"],
    });
    expect(snapshot.groups.get(eligible.id)).toMatchObject({
      bases: ["unknown"],
      diversityStatus: "eligible",
      cautions: [],
    });
    expect(snapshot.groups.get(privateRecord.id)).toMatchObject({
      diversityStatus: "ineligible",
      cautions: ["private_source", "insufficient_public_proof"],
    });
    expect(snapshot.groups.get(restricted.id)).toMatchObject({
      diversityStatus: "ineligible",
      cautions: ["restricted_source", "insufficient_public_proof"],
    });
    expect(snapshot.groups.get(correction.id)).toMatchObject({
      diversityStatus: "ineligible",
      cautions: ["correction", "insufficient_public_proof"],
    });
    expect(snapshot.groups.get(representationOnly.id)).toMatchObject({
      bases: ["unknown"],
      diversityStatus: "unknown",
      cautions: ["insufficient_public_proof"],
    });
  });

  it("makes same-proof access conflict dominant and keeps caution order stable", () => {
    const artifact = { provider: "shared-publisher", externalId: "shared-story" } as const;
    const publicRecord = material({
      label: "conflict-public",
      source: publicSource({ artifact }),
    });
    const privateRecord = material({
      label: "conflict-private",
      source: publicSource({ access: "private", artifact }),
    });
    const restrictedRecord = material({
      label: "conflict-restricted",
      source: publicSource({ access: "restricted", artifact }),
    });
    const correctionRecord = material({
      label: "conflict-correction",
      kind: "correction",
      source: publicSource({ artifact }),
      correctionProvenance: { kind: "direct_user" },
    });
    const group = groupFor(
      [publicRecord, privateRecord, restrictedRecord, correctionRecord],
      publicRecord,
    );

    expect(group.bases).toEqual(["provider_artifact"]);
    expect(group.diversityStatus).toBe("ineligible");
    expect(group.cautions).toEqual([
      "access_conflict",
      "private_source",
      "restricted_source",
      "correction",
      "insufficient_public_proof",
    ]);
  });

  it("rejects unknown algorithms and duplicate material identities", () => {
    const record = material({ label: "version-boundary" });
    expect(() => deriveSourceGroups([record], "source-groups-v2")).toThrowError(
      expect.objectContaining({ code: "schema_unsupported" }),
    );
    expect(() => deriveSourceGroups([record, record], "source-groups-v1")).toThrowError(
      expect.objectContaining({ code: "storage_corrupt" }),
    );
  });
});
