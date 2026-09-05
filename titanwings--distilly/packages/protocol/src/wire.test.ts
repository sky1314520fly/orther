import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { DistillyError } from "./errors.js";
import type { DistillyWireError } from "./errors.js";
import { WIRE_LIMITS } from "./json.js";
import {
  distillyWireErrorSchema,
  wireFailureSchema,
  wireRequestSchema,
  wireSuccessSchema,
} from "./schemas/wire.js";
import { WIRE_VERSION } from "./wire.js";

const subject = {
  id: `subject_${"1".repeat(32)}`,
  displayName: "Ada",
  aliases: [],
  identityHints: [],
  space: {
    id: `space_${"2".repeat(32)}`,
    displayName: "People",
    kind: "people",
  },
  lifecycle: "active",
} as const;

describe("wire boundary", () => {
  it("parses the current request and rejects unknown or legacy fields", () => {
    const value = { wireVersion: WIRE_VERSION, requestId: `req_${"1".repeat(32)}` };
    expect(wireRequestSchema.parse(value)).toEqual(value);
    expect(() => wireRequestSchema.parse({ ...value, actor: "user" })).toThrow();
    expect(() => wireRequestSchema.parse({ ...value, wireVersion: "2" })).toThrow();
    expect(() => wireRequestSchema.parse({ ...value, requestId: "" })).toThrow();
  });

  it("keeps success and failure as disjoint exact envelopes", () => {
    const success = wireSuccessSchema(z.strictObject({ count: z.number().int() }));
    expect(success.parse({ ok: true, wireVersion: "3", value: { count: 1 } })).toEqual({
      ok: true,
      wireVersion: "3",
      value: { count: 1 },
    });
    expect(() => success.parse({ ok: false, wireVersion: "3", value: { count: 1 } })).toThrow();
    expect(
      wireFailureSchema.parse({
        ok: false,
        wireVersion: "3",
        error: { code: "invalid_input", message: "bad input", retryable: false },
      }),
    ).toBeDefined();
  });

  it("preserves stable error fields in the SDK error", () => {
    const cause = new Error("transport");
    const error = new DistillyError(
      {
        code: "evidence_invalid",
        message: "quote is not present",
        retryable: true,
        fieldPath: "patch.operations.0.claim.evidence.0.quote",
      },
      { cause },
    );

    expect(error).toMatchObject({
      name: "DistillyError",
      code: "evidence_invalid",
      retryable: true,
      fieldPath: "patch.operations.0.claim.evidence.0.quote",
      cause,
    });
  });

  it("accepts the transport-safe internal error code", () => {
    type InternalWireError = Extract<DistillyWireError, { code: "internal_error" }>;
    const value = {
      code: "internal_error",
      message: "An internal error occurred.",
      retryable: false,
    } as const;

    expectTypeOf<InternalWireError["retryable"]>().toEqualTypeOf<false>();
    expectTypeOf<InternalWireError["details"]>().toEqualTypeOf<undefined>();
    expect(distillyWireErrorSchema.parse(value)).toEqual(value);
    expect(new DistillyError(value)).toMatchObject({
      name: "DistillyError",
      code: "internal_error",
      retryable: false,
    });
    expect(() => distillyWireErrorSchema.parse({ ...value, retryable: true })).toThrow();
    for (const diagnostic of [
      { fieldPath: "adapter.output" },
      { remediation: "Retry with raw exception details." },
      { details: { stack: "secret stack" } },
      { subjectResolution: { kind: "found", subject } },
    ]) {
      expect(() => distillyWireErrorSchema.parse({ ...value, ...diagnostic })).toThrow();
    }
  });

  it("requires typed subject resolution for identity collisions", () => {
    const alreadyExists = {
      code: "already_exists",
      message: "subject exists",
      retryable: false,
      subjectResolution: { kind: "found", subject },
    } as const;
    expect(distillyWireErrorSchema.parse(alreadyExists)).toEqual(alreadyExists);
    expect(() =>
      distillyWireErrorSchema.parse({
        code: "already_exists",
        message: "subject exists",
        retryable: false,
      }),
    ).toThrow();

    expect(
      distillyWireErrorSchema.parse({
        code: "ambiguous_subject",
        message: "choose a subject",
        retryable: false,
        subjectResolution: {
          kind: "ambiguous",
          candidates: [subject, { ...subject, id: `subject_${"3".repeat(32)}` }],
        },
      }),
    ).toBeDefined();
    expect(() =>
      distillyWireErrorSchema.parse({
        code: "ambiguous_subject",
        message: "choose a subject",
        retryable: false,
        subjectResolution: { kind: "ambiguous", candidates: [subject] },
      }),
    ).toThrow();
    expect(() =>
      distillyWireErrorSchema.parse({
        code: "not_found",
        message: "missing",
        retryable: false,
        subjectResolution: { kind: "found", subject },
      }),
    ).toThrow();

    expect(() =>
      distillyWireErrorSchema.parse({
        ...alreadyExists,
        subjectResolution: {
          kind: "found",
          subject: {
            ...subject,
            aliases: Array.from(
              { length: WIRE_LIMITS.smallArrayItems + 1 },
              (_, index) => `alias-${index}`,
            ),
          },
        },
      }),
    ).toThrow();

    expect(() =>
      distillyWireErrorSchema.parse({
        ...alreadyExists,
        subjectResolution: {
          kind: "found",
          subject: {
            ...subject,
            identityHints: Array.from({ length: WIRE_LIMITS.smallArrayItems + 1 }, (_, index) => ({
              kind: "description",
              value: `hint-${index}`,
            })),
          },
        },
      }),
    ).toThrow();
  });

  it("accepts only finite acyclic JSON details", () => {
    expect(
      distillyWireErrorSchema.parse({
        code: "invalid_input",
        message: "bad input",
        retryable: false,
        details: { attempt: 1, nested: [true, null, "value"] },
      }),
    ).toBeDefined();
    expect(() =>
      distillyWireErrorSchema.parse({
        code: "invalid_input",
        message: "bad input",
        retryable: false,
        details: { value: Number.POSITIVE_INFINITY },
      }),
    ).toThrow();

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      distillyWireErrorSchema.parse({
        code: "invalid_input",
        message: "bad input",
        retryable: false,
        details: cyclic,
      }),
    ).toThrow();
  });
});
