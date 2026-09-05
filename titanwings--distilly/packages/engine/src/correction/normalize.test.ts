import {
  DistillyError,
  WIRE_LIMITS,
  claimIdSchema,
  hostNameSchema,
  requestIdSchema,
  subjectIdSchema,
  type ActorContext,
  type FacetPath,
  type IsoDateTime,
} from "@distilly/protocol";
import { describe, expect, it } from "vitest";

import { verifyFactChecksum } from "../facts/checksum.js";
import {
  correctionProvenanceForActor,
  deriveCorrectionSourceIdentity,
  digestAcceptedCorrection,
  normalizeCorrectionDraft,
  prepareCorrectionMaterial,
} from "./normalize.js";

const SUBJECT_ID = subjectIdSchema.parse(`subject_${"1".repeat(32)}`);
const REQUEST_ID = requestIdSchema.parse(`req_${"2".repeat(32)}`);
const AT = "2026-08-31T12:00:00.000Z" as IsoDateTime;
const CLAIM_A = claimIdSchema.parse(`claim_${"a".repeat(64)}`);
const CLAIM_B = claimIdSchema.parse(`claim_${"b".repeat(64)}`);
const CODEX = hostNameSchema.parse("codex");

const expectCode = (run: () => unknown, code: string): DistillyError => {
  try {
    run();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(DistillyError);
    expect(error).toMatchObject({ code });
    return error as DistillyError;
  }
};

describe("AcceptedCorrection normalization", () => {
  it("normalizes material-text-v1, defaults the facet, and UTF-8 sorts exact targets", () => {
    expect(
      normalizeCorrectionDraft({
        text: "Cafe\u0301  \r\nnext\t\r",
        supersedes: [CLAIM_B, CLAIM_A],
      }),
    ).toEqual({
      text: "Café\nnext\n",
      facet: "corrections.unassigned",
      supersedes: [CLAIM_A, CLAIM_B],
    });
  });

  it("rejects duplicate targets and NFC expansion past the 16 KiB correction bound", () => {
    expectCode(
      () =>
        normalizeCorrectionDraft({
          text: "Correction",
          supersedes: [CLAIM_A, CLAIM_A],
        }),
      "invalid_input",
    );
    const rawAtLimit = "\u0344".repeat(WIRE_LIMITS.correctionTextBytes / 2);
    expect(new TextEncoder().encode(rawAtLimit)).toHaveLength(WIRE_LIMITS.correctionTextBytes);
    const error = expectCode(() => normalizeCorrectionDraft({ text: rawAtLimit }), "invalid_input");
    expect(error).toMatchObject({ fieldPath: "correction.text" });
  });

  it("freezes the accepted digest and request-scoped source identity preimages", () => {
    const correction = normalizeCorrectionDraft({
      text: "Use explicit evidence.",
      facet: "boundaries.evidence" as FacetPath,
      supersedes: [CLAIM_B, CLAIM_A],
    });
    expect(digestAcceptedCorrection(correction)).toBe(
      "sha256_10f196d5aab264f148575c9ffeffb58cdc77de483a2d263e3d0bdd2c4ade7206",
    );
    expect(deriveCorrectionSourceIdentity(REQUEST_ID)).toBe(`correction-request-v1\0${REQUEST_ID}`);
  });

  it("binds direct and relayed provenance and seals a private full-body material", () => {
    const user: ActorContext = { kind: "user", id: "panel-user" };
    const host: ActorContext = { kind: "host", id: "codex-session", host: CODEX };
    expect(correctionProvenanceForActor(user)).toEqual({ kind: "direct_user" });
    expect(correctionProvenanceForActor(host)).toEqual({
      kind: "relayed",
      actorKind: "host",
      actorId: "codex-session",
    });

    const correction = normalizeCorrectionDraft({ text: "Use explicit evidence." });
    const prepared = prepareCorrectionMaterial(correction, SUBJECT_ID, REQUEST_ID, host, AT);
    expect(() => verifyFactChecksum(prepared.record)).not.toThrow();
    expect(prepared).toMatchObject({
      content: "Use explicit evidence.",
      record: {
        subjectId: SUBJECT_ID,
        kind: "correction",
        sourceIdentity: `correction-request-v1\0${REQUEST_ID}`,
        source: {
          medium: "other",
          access: "private",
          role: "personal_communication",
          capturedAt: AT,
          authors: [],
        },
        derivation: { kind: "native_text" },
        participants: [],
        sensitivity: "private",
        correctionProvenance: {
          kind: "relayed",
          actorKind: "host",
          actorId: "codex-session",
        },
        flags: [],
        storedAt: AT,
      },
    });
  });
});
