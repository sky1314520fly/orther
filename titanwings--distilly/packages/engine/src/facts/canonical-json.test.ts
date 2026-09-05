import { describe, expect, it } from "vitest";

import {
  captureAuditRefSchema,
  contentDigestSchema,
  conversationSourceKeySchema,
  factChecksumSchema,
  isoDateTimeSchema,
  materialIdSchema,
  provenanceDigestSchema,
  rawIdSchema,
  subjectIdSchema,
} from "@distilly/protocol";
import type { FactEnvelope, MaterialRecord, VersionMaterialEntry } from "@distilly/protocol";

import { canonicalJson } from "./canonical-json.js";
import { computeFactChecksum, sealFact, sha256Hex, verifyFactChecksum } from "./checksum.js";
import {
  deriveMaterialId,
  digestContent,
  digestDistillPatch,
  digestMaterialProvenance,
  hashMaterialSet,
} from "./digests.js";

const GOLDEN_CONTENT = "Golden provenance material.\n";
const GOLDEN_CONTENT_DIGEST = contentDigestSchema.parse(
  "sha256_935fd613aff1bdea52b5f070f160ee9ceaf24ff98a2240cc2404e1ffc6642b72",
);
const GOLDEN_PROVENANCE_DIGEST = provenanceDigestSchema.parse(
  "provenance_sha256_d3a9fd03744274201d34885adb70a2fd8bbc8235e71862ffb7fbbdc9177b14d6",
);
const GOLDEN_MATERIAL_ID = materialIdSchema.parse(
  "mat_97dc7e53ebcb45e9b002c1762331e5b00fdae1da1aee16a91f3d55d3fa9c1bd4",
);
const GOLDEN_SOURCE_IDENTITY = "uri:https://mirror.example/transcript?view=full";
const GOLDEN_ARTIFACT = {
  provider: "youtube",
  externalId: "video-1",
  canonicalUri: "https://youtube.example/watch?v=video-1",
} as const;
const GOLDEN_REPRESENTATION = {
  provider: "publisher",
  externalId: "interview-1",
  canonicalUri: "https://publisher.example/interviews/1",
} as const;

const goldenMaterial: MaterialRecord = {
  schemaVersion: 1,
  checksum: factChecksumSchema.parse(`fact_sha256_${"0".repeat(64)}`),
  id: GOLDEN_MATERIAL_ID,
  subjectId: subjectIdSchema.parse(`subject_${"0".repeat(32)}`),
  kind: "transcript",
  contentDigest: GOLDEN_CONTENT_DIGEST,
  provenanceDigest: GOLDEN_PROVENANCE_DIGEST,
  sourceIdentity: GOLDEN_SOURCE_IDENTITY,
  source: {
    uri: "https://mirror.example/transcript?view=full",
    title: "Ignored display title",
    medium: "video",
    access: "restricted",
    role: "interview",
    artifact: GOLDEN_ARTIFACT,
    representationOf: GOLDEN_REPRESENTATION,
    capturedAt: isoDateTimeSchema.parse("2026-08-20T11:00:00.000Z"),
    occurredAt: isoDateTimeSchema.parse("2026-08-18T09:00:00.000Z"),
    publishedAt: isoDateTimeSchema.parse("2026-08-19T10:00:00.000Z"),
    language: "en",
    authors: ["Ada", "Grace"],
  },
  derivation: {
    kind: "host_extract",
    method: "transcription",
    producer: "host-transcriber",
    producerVersion: "2.1.0",
    language: "en",
  },
  participants: ["Ada", "Interviewer"],
  sensitivity: "private",
  flags: ["suspicious_source"],
  storedAt: isoDateTimeSchema.parse("2026-08-20T11:01:00.000Z"),
};

describe("canonical fact hashes", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(canonicalJson({ z: 1, a: { y: true, x: [2, 1] } })).toBe(
      '{"a":{"x":[2,1],"y":true},"z":1}',
    );
    expect(canonicalJson({ a: { x: [2, 1], y: true }, z: 1 })).toBe(
      canonicalJson({ z: 1, a: { y: true, x: [2, 1] } }),
    );
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("rejects values that are not finite acyclic JSON", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cycles/u);
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow(/finite/u);
    expect(() => canonicalJson({ missing: undefined })).toThrow(/JSON values/u);
    expect(() => canonicalJson(new Date())).toThrow(/plain objects/u);
  });

  it("uses full stable SHA-256 values and excludes the checksum field", () => {
    expect(sha256Hex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(digestContent("hello")).toBe(
      "sha256_2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );

    interface ExampleFact extends FactEnvelope<1> {
      readonly name: string;
      readonly order: readonly number[];
    }
    const fact = sealFact<ExampleFact>({ schemaVersion: 1, name: "Ada", order: [1, 2] });
    expect(fact.checksum).toBe(
      "fact_sha256_4740594bcdc243808e1e9834622fbb3422574b6dce04c09b49396650504b7672",
    );
    expect(computeFactChecksum({ ...fact, checksum: `fact_sha256_${"0".repeat(64)}` })).toBe(
      fact.checksum,
    );
    const corrupted: ExampleFact = { ...fact, name: "Grace" };
    expect(() => verifyFactChecksum(corrupted)).toThrow(/checksum/u);
  });

  it("pins the accepted claim-patch digest namespace and canonical bytes", () => {
    expect(digestDistillPatch({ operations: [] })).toBe(
      "sha256_0a7da371318bb6f058df1497434d4773901dbd4ccd1a928ea91e4675c828e09d",
    );
  });

  it("hashes material sets independently of caller order", () => {
    const a: VersionMaterialEntry = {
      materialId: materialIdSchema.parse(`mat_${"1".repeat(64)}`),
      contentDigest: contentDigestSchema.parse(`sha256_${"2".repeat(64)}`),
      provenanceDigest: provenanceDigestSchema.parse(`provenance_sha256_${"3".repeat(64)}`),
    };
    const b: VersionMaterialEntry = {
      materialId: materialIdSchema.parse(`mat_${"4".repeat(64)}`),
      contentDigest: contentDigestSchema.parse(`sha256_${"5".repeat(64)}`),
      provenanceDigest: provenanceDigestSchema.parse(`provenance_sha256_${"6".repeat(64)}`),
    };
    expect(hashMaterialSet([a, b])).toBe(hashMaterialSet([b, a]));
    expect(hashMaterialSet([a, b])).toBe(
      "set_sha256_55860eadc879742bb8a2ab8d3cc3727c183a22f903241d8961c429f7290a82c6",
    );
    expect(hashMaterialSet([a])).not.toBe(hashMaterialSet([a, b]));
  });

  it("pins provenance and material identities to independent golden vectors", () => {
    expect(digestContent(GOLDEN_CONTENT)).toBe(GOLDEN_CONTENT_DIGEST);
    expect(digestMaterialProvenance(goldenMaterial)).toBe(GOLDEN_PROVENANCE_DIGEST);
    expect(
      deriveMaterialId(GOLDEN_SOURCE_IDENTITY, GOLDEN_PROVENANCE_DIGEST, GOLDEN_CONTENT_DIGEST),
    ).toBe(GOLDEN_MATERIAL_ID);
    expect(
      deriveMaterialId(
        "uri:https://other.example/transcript",
        GOLDEN_PROVENANCE_DIGEST,
        GOLDEN_CONTENT_DIGEST,
      ),
    ).not.toBe(GOLDEN_MATERIAL_ID);
  });

  it("hashes every grouping, safety, and export-relevant provenance field", () => {
    const baseline = digestMaterialProvenance(goldenMaterial);
    const includedVariants: readonly (readonly [string, MaterialRecord])[] = [
      ["kind", { ...goldenMaterial, kind: "derived_text" }],
      [
        "source.medium",
        { ...goldenMaterial, source: { ...goldenMaterial.source, medium: "audio" } },
      ],
      [
        "source.access",
        { ...goldenMaterial, source: { ...goldenMaterial.source, access: "private" } },
      ],
      [
        "source.role",
        {
          ...goldenMaterial,
          source: { ...goldenMaterial.source, role: "editorial_reporting" },
        },
      ],
      [
        "source.artifact.provider",
        {
          ...goldenMaterial,
          source: {
            ...goldenMaterial.source,
            artifact: { ...GOLDEN_ARTIFACT, provider: "vimeo" },
          },
        },
      ],
      [
        "source.artifact.externalId",
        {
          ...goldenMaterial,
          source: {
            ...goldenMaterial.source,
            artifact: { ...GOLDEN_ARTIFACT, externalId: "video-2" },
          },
        },
      ],
      [
        "source.artifact.canonicalUri",
        {
          ...goldenMaterial,
          source: {
            ...goldenMaterial.source,
            artifact: {
              ...GOLDEN_ARTIFACT,
              canonicalUri: "https://youtube.example/watch?v=video-2",
            },
          },
        },
      ],
      [
        "source.representationOf.provider",
        {
          ...goldenMaterial,
          source: {
            ...goldenMaterial.source,
            representationOf: { ...GOLDEN_REPRESENTATION, provider: "archive" },
          },
        },
      ],
      [
        "source.representationOf.externalId",
        {
          ...goldenMaterial,
          source: {
            ...goldenMaterial.source,
            representationOf: {
              ...GOLDEN_REPRESENTATION,
              externalId: "interview-2",
            },
          },
        },
      ],
      [
        "source.representationOf.canonicalUri",
        {
          ...goldenMaterial,
          source: {
            ...goldenMaterial.source,
            representationOf: {
              ...GOLDEN_REPRESENTATION,
              canonicalUri: "https://publisher.example/interviews/2",
            },
          },
        },
      ],
      [
        "source.occurredAt",
        {
          ...goldenMaterial,
          source: {
            ...goldenMaterial.source,
            occurredAt: isoDateTimeSchema.parse("2026-08-18T09:01:00.000Z"),
          },
        },
      ],
      [
        "source.publishedAt",
        {
          ...goldenMaterial,
          source: {
            ...goldenMaterial.source,
            publishedAt: isoDateTimeSchema.parse("2026-08-19T10:01:00.000Z"),
          },
        },
      ],
      [
        "source.language",
        { ...goldenMaterial, source: { ...goldenMaterial.source, language: "fr" } },
      ],
      [
        "source.authors",
        { ...goldenMaterial, source: { ...goldenMaterial.source, authors: ["Ada"] } },
      ],
      ["derivation", { ...goldenMaterial, derivation: { kind: "native_text" } }],
      ["participants", { ...goldenMaterial, participants: ["Ada"] }],
      ["sensitivity", { ...goldenMaterial, sensitivity: "shareable" }],
      ["flags", { ...goldenMaterial, flags: [] }],
    ];
    for (const [field, variant] of includedVariants) {
      expect(digestMaterialProvenance(variant), field).not.toBe(baseline);
    }

    const rawDerived = (rawId: ReturnType<typeof rawIdSchema.parse>): MaterialRecord => ({
      ...goldenMaterial,
      derivation: {
        kind: "raw_extract",
        rawId,
        method: "transcription",
        producer: "engine-parser",
        producerVersion: "1.0.0",
        language: "en",
      },
    });
    expect(
      digestMaterialProvenance(rawDerived(rawIdSchema.parse(`raw_${"1".repeat(64)}`))),
    ).not.toBe(digestMaterialProvenance(rawDerived(rawIdSchema.parse(`raw_${"2".repeat(64)}`))));

    const directCorrection: MaterialRecord = {
      ...goldenMaterial,
      kind: "correction",
      correctionProvenance: { kind: "direct_user" },
    };
    const relayedCorrection: MaterialRecord = {
      ...directCorrection,
      correctionProvenance: { kind: "relayed", actorKind: "host", actorId: "codex" },
    };
    expect(digestMaterialProvenance(directCorrection)).not.toBe(
      digestMaterialProvenance(relayedCorrection),
    );
    expect(
      digestMaterialProvenance({
        ...relayedCorrection,
        correctionProvenance: { kind: "relayed", actorKind: "sdk", actorId: "codex" },
      }),
    ).not.toBe(digestMaterialProvenance(relayedCorrection));
    expect(
      digestMaterialProvenance({
        ...relayedCorrection,
        correctionProvenance: { kind: "relayed", actorKind: "host", actorId: "claude" },
      }),
    ).not.toBe(digestMaterialProvenance(relayedCorrection));

    const capturedTranscript: MaterialRecord = {
      ...goldenMaterial,
      source: {
        medium: "conversation",
        access: "private",
        role: "personal_communication",
        capturedAt: isoDateTimeSchema.parse("2026-08-20T12:00:00.000Z"),
        authors: ["Friend"],
      },
      derivation: {
        kind: "host_extract",
        method: "computer_use_transcript",
        producer: "codex",
      },
      participants: ["Friend"],
      sensitivity: "private",
      captureAuditRef: captureAuditRefSchema.parse(`capture_${"1".repeat(32)}`),
      conversationSourceKey: conversationSourceKeySchema.parse(`conversation_${"2".repeat(64)}`),
      flags: [],
    };
    expect(
      digestMaterialProvenance({
        ...capturedTranscript,
        captureAuditRef: captureAuditRefSchema.parse(`capture_${"3".repeat(32)}`),
      }),
    ).not.toBe(digestMaterialProvenance(capturedTranscript));
    expect(
      digestMaterialProvenance({
        ...capturedTranscript,
        conversationSourceKey: conversationSourceKeySchema.parse(`conversation_${"4".repeat(64)}`),
      }),
    ).not.toBe(digestMaterialProvenance(capturedTranscript));
    const {
      captureAuditRef: capturedAuditRef,
      conversationSourceKey: capturedConversationSourceKey,
      ...unstampedTranscript
    } = capturedTranscript;
    expect(capturedAuditRef).toBeDefined();
    expect(capturedConversationSourceKey).toBeDefined();
    expect(digestMaterialProvenance(unstampedTranscript)).not.toBe(
      digestMaterialProvenance(capturedTranscript),
    );
  });

  it("excludes observation metadata from the provenance digest", () => {
    const baseline = digestMaterialProvenance(goldenMaterial);
    const excludedVariants: readonly (readonly [string, MaterialRecord])[] = [
      [
        "source.uri",
        {
          ...goldenMaterial,
          source: { ...goldenMaterial.source, uri: "https://other.example/transcript" },
        },
      ],
      [
        "source.title",
        { ...goldenMaterial, source: { ...goldenMaterial.source, title: "Later title" } },
      ],
      [
        "source.capturedAt",
        {
          ...goldenMaterial,
          source: {
            ...goldenMaterial.source,
            capturedAt: isoDateTimeSchema.parse("2026-08-20T13:00:00.000Z"),
          },
        },
      ],
      [
        "storedAt",
        { ...goldenMaterial, storedAt: isoDateTimeSchema.parse("2026-08-20T13:01:00.000Z") },
      ],
      [
        "sourceIdentity",
        { ...goldenMaterial, sourceIdentity: "uri:https://other.example/transcript" },
      ],
    ];
    for (const [field, variant] of excludedVariants) {
      expect(digestMaterialProvenance(variant), field).toBe(baseline);
    }
  });
});
