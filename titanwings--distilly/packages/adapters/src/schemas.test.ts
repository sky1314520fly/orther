import { WIRE_LIMITS } from "@distilly/protocol";
import { describe, expect, it } from "vitest";

import type { AdapterResource, AdapterResourceSchema, SourceStatus } from "./contracts.js";
import {
  adapterConfigRuntimeSchema,
  adapterPreflightResultRuntimeSchema,
  agentPlanRuntimeSchema,
  externalSubjectRefRuntimeSchema,
  userCollectionMethodSchemas,
} from "./schemas.js";

const hex = (character: string, length: number): string => character.repeat(length);
const subjectId = `subject_${hex("1", 32)}`;
const spaceId = `space_${hex("2", 32)}`;
const materialId = `mat_${hex("3", 64)}`;
const contentDigest = `sha256_${hex("4", 64)}`;
const materialSetHash = `set_sha256_${hex("5", 64)}`;
const capturedAt = "2026-08-31T00:00:00.000Z";

const registration = {
  id: "fixture",
  mode: "direct" as const,
  capabilities: {
    resolveSubject: true,
    plan: false,
    collect: true,
    requiresSecret: true,
    resourceKinds: [{ kind: "documents", availability: "available" as const }],
  },
};

const status: SourceStatus = {
  registration,
  configured: true,
  warnings: [],
};

const action = {
  selection: {
    adapterId: "fixture",
    resource: {
      kind: "documents",
      locator: "folder-1",
      options: { includeArchived: false },
    },
  },
  subject: { subjectId },
  externalSubjectQuery: "Ada",
  objective: "Collect authored design documents.",
  since: capturedAt,
  limit: 20,
};

const subject = {
  id: subjectId,
  displayName: "Ada",
  aliases: [],
  identityHints: [],
  space: { id: spaceId, displayName: "People", kind: "people" as const },
  lifecycle: "active" as const,
};

const ingestResult = {
  kind: "ingested" as const,
  subject,
  created: false,
  items: [
    {
      clientRef: "document-1",
      kind: "accepted" as const,
      materialId,
      contentDigest,
    },
  ],
  materialSetHash,
  generation: 1,
};

describe("userCollectionMethodSchemas", () => {
  it("keeps the exact four-method surface and parses every params/result pair", () => {
    expect(Object.keys(userCollectionMethodSchemas)).toEqual([
      "source.list",
      "source.configure",
      "source.preflight",
      "source.collect",
    ]);

    expect(userCollectionMethodSchemas["source.list"].params.parse(null)).toBeNull();
    expect(userCollectionMethodSchemas["source.list"].result.parse([status])).toEqual([status]);
    expect(
      userCollectionMethodSchemas["source.configure"].params.parse({
        adapterId: "fixture",
        config: {
          values: { region: "international" },
          secretRefs: { apiKey: "env:DISTILLY_FIXTURE_API_KEY" },
        },
      }),
    ).toEqual({
      adapterId: "fixture",
      config: {
        values: { region: "international" },
        secretRefs: { apiKey: "env:DISTILLY_FIXTURE_API_KEY" },
      },
    });
    expect(userCollectionMethodSchemas["source.configure"].result.parse(status)).toEqual(status);
    expect(userCollectionMethodSchemas["source.preflight"].params.parse(action)).toEqual(action);
    expect(
      userCollectionMethodSchemas["source.preflight"].result.parse({
        adapter: { ok: true, warnings: [] },
        subjects: [
          {
            adapterId: "fixture",
            externalId: "external-1",
            displayName: "Ada",
            canonicalUri: "https://example.test/ada",
            identityHints: [],
          },
        ],
      }),
    ).toEqual({
      adapter: { ok: true, warnings: [] },
      subjects: [
        {
          adapterId: "fixture",
          externalId: "external-1",
          displayName: "Ada",
          canonicalUri: "https://example.test/ada",
          identityHints: [],
        },
      ],
    });
    expect(userCollectionMethodSchemas["source.collect"].params.parse(action)).toEqual(action);
    expect(
      userCollectionMethodSchemas["source.collect"].result.parse({
        materialCount: 1,
        ingestResults: [ingestResult],
      }),
    ).toEqual({ materialCount: 1, ingestResults: [ingestResult] });
  });

  it("rejects unknown envelope keys and invalid Protocol-owned nested values", () => {
    expect(() =>
      userCollectionMethodSchemas["source.configure"].params.parse({
        adapterId: "fixture",
        config: { values: {} },
        token: "not-allowed",
      }),
    ).toThrow();
    expect(() =>
      userCollectionMethodSchemas["source.preflight"].params.parse({
        ...action,
        subject: { subjectId: "subject_invalid" },
      }),
    ).toThrow();
    expect(() =>
      userCollectionMethodSchemas["source.collect"].params.parse({
        ...action,
        since: "2026-08-31",
      }),
    ).toThrow();
    expect(() =>
      userCollectionMethodSchemas["source.collect"].result.parse({
        materialCount: 1,
        ingestResults: [{ ...ingestResult, materialSetHash: "set_bad" }],
      }),
    ).toThrow();
    expect(() =>
      userCollectionMethodSchemas["source.list"].result.parse([
        { ...status, registration: { ...registration, callableAdapter: {} } },
      ]),
    ).toThrow();
  });

  it("keeps public values separate from opaque secret references", () => {
    expect(
      adapterConfigRuntimeSchema.parse({
        values: { region: "china" },
        secretRefs: {
          apiKey: "keychain:distilly/fixture/api-key",
          clientSecret: "env:DISTILLY_FIXTURE_CLIENT_SECRET",
        },
      }),
    ).toEqual({
      values: { region: "china" },
      secretRefs: {
        apiKey: "keychain:distilly/fixture/api-key",
        clientSecret: "env:DISTILLY_FIXTURE_CLIENT_SECRET",
      },
    });

    for (const key of [
      "api_key",
      "APIKey",
      "accessToken",
      "client-secret",
      "password",
      "privateKey",
    ]) {
      expect(() => adapterConfigRuntimeSchema.parse({ values: { [key]: "plaintext" } })).toThrow();
    }
    expect(() =>
      adapterConfigRuntimeSchema.parse({
        values: { region: "china" },
        secretRefs: { region: "env:DISTILLY_REGION" },
      }),
    ).toThrow();
  });

  it("allows extension resources but bounds them to finite JSON before adapter dispatch", () => {
    const parsed = userCollectionMethodSchemas["source.preflight"].params.parse(action);
    expect(parsed.selection.resource).toEqual(action.selection.resource);

    const cycle: Record<string, unknown> = { kind: "documents" };
    cycle.self = cycle;
    expect(() =>
      userCollectionMethodSchemas["source.preflight"].params.parse({
        ...action,
        selection: { adapterId: "fixture", resource: cycle },
      }),
    ).toThrow();
    expect(() =>
      userCollectionMethodSchemas["source.preflight"].params.parse({
        ...action,
        selection: {
          adapterId: "fixture",
          resource: { kind: "documents", score: Number.NaN },
        },
      }),
    ).toThrow();
    expect(() =>
      userCollectionMethodSchemas["source.preflight"].params.parse({
        ...action,
        selection: {
          adapterId: "fixture",
          resource: Object.fromEntries(
            Array.from({ length: WIRE_LIMITS.openRecordEntries + 1 }, (_, index) => [
              index === 0 ? "kind" : `key-${index}`,
              index === 0 ? "documents" : index,
            ]),
          ),
        },
      }),
    ).toThrow();

    let nested: unknown = "leaf";
    for (let depth = 0; depth < 2_000; depth += 1) nested = { nested };
    let deepError: unknown;
    try {
      userCollectionMethodSchemas["source.preflight"].params.parse({
        ...action,
        selection: {
          adapterId: "fixture",
          resource: { kind: "documents", nested },
        },
      });
    } catch (error) {
      deepError = error;
    }
    expect(deepError).toBeInstanceOf(Error);
    expect(deepError).not.toBeInstanceOf(RangeError);
    expect((deepError as Error).name).toBe("ZodError");
  });

  it("requires each adapter to apply its own strict resource schema", () => {
    interface DocumentResource extends AdapterResource {
      readonly kind: "documents";
      readonly locator: string;
    }
    const strictResourceSchema: AdapterResourceSchema<DocumentResource> = {
      parse(input: unknown): DocumentResource {
        if (
          typeof input !== "object" ||
          input === null ||
          Array.isArray(input) ||
          Object.keys(input).sort().join(",") !== "kind,locator" ||
          (input as Record<string, unknown>).kind !== "documents" ||
          typeof (input as Record<string, unknown>).locator !== "string"
        ) {
          throw new TypeError("invalid document resource");
        }
        return input as DocumentResource;
      },
    };

    expect(strictResourceSchema.parse({ kind: "documents", locator: "folder-1" })).toEqual({
      kind: "documents",
      locator: "folder-1",
    });
    expect(() =>
      strictResourceSchema.parse({ kind: "documents", locator: "folder-1", extra: true }),
    ).toThrow();
  });
});

describe("adapter-facing runtime schemas", () => {
  it("parses closed preflight, subject, and plan contracts", () => {
    expect(
      adapterPreflightResultRuntimeSchema.parse({
        ok: false,
        error: {
          code: "adapter_failed",
          message: "Fixture adapter is unavailable.",
          retryable: true,
        },
        warnings: ["Retry after checking the configured scope."],
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "adapter_failed",
        message: "Fixture adapter is unavailable.",
        retryable: true,
      },
      warnings: ["Retry after checking the configured scope."],
    });
    expect(
      externalSubjectRefRuntimeSchema.parse({
        adapterId: "fixture",
        externalId: "external-1",
        displayName: "Ada",
        identityHints: [{ kind: "description", value: "Design lead" }],
      }),
    ).toEqual({
      adapterId: "fixture",
      externalId: "external-1",
      displayName: "Ada",
      identityHints: [{ kind: "description", value: "Design lead" }],
    });
    expect(
      agentPlanRuntimeSchema.parse({
        questions: ["Which decisions should be sampled?"],
        suggestedQueries: ["Ada design decisions"],
      }),
    ).toEqual({
      questions: ["Which decisions should be sampled?"],
      suggestedQueries: ["Ada design decisions"],
    });
  });

  it("rejects unknown keys, non-http identities, and over-limit actions", () => {
    expect(() =>
      adapterPreflightResultRuntimeSchema.parse({ ok: true, warnings: [], token: "secret" }),
    ).toThrow();
    expect(() =>
      externalSubjectRefRuntimeSchema.parse({
        adapterId: "fixture",
        externalId: "external-1",
        displayName: "Ada",
        canonicalUri: "file:///private/person",
        identityHints: [],
      }),
    ).toThrow();
    expect(() =>
      userCollectionMethodSchemas["source.collect"].params.parse({
        ...action,
        limit: WIRE_LIMITS.listLimit + 1,
      }),
    ).toThrow();
    expect(() =>
      userCollectionMethodSchemas["source.collect"].params.parse({
        ...action,
        selection: {
          adapterId: "fixture",
          resource: {
            kind: "documents",
            body: "鲸".repeat(Math.ceil(WIRE_LIMITS.toolInputBytes / 3)),
          },
        },
      }),
    ).toThrow();
  });
});
