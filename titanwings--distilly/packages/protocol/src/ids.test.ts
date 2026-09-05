import { describe, expect, expectTypeOf, it } from "vitest";

import { BUILTIN_PEOPLE_SPACE_ID } from "./ids.js";
import type { LeaseOwnerId, MaterialId, SpaceId, SubjectId } from "./ids.js";
import {
  brandedValueSchemas,
  briefMaterialRefSchema,
  digestSchemas,
  facetPathSchema,
  hostNameSchema,
  isoDateTimeSchema,
  requestIdSchema,
} from "./schemas/ids.js";

const HEX_64 = "0123456789abcdef".repeat(4);
const HEX_32 = "0123456789abcdef".repeat(2);

describe("compile-time brands", () => {
  it("keeps unrelated ids non-interchangeable", () => {
    expectTypeOf<SubjectId>().not.toEqualTypeOf<MaterialId>();
    expectTypeOf<LeaseOwnerId>().not.toEqualTypeOf<SubjectId>();
    expectTypeOf(BUILTIN_PEOPLE_SPACE_ID).toEqualTypeOf<SpaceId>();
  });
});

describe("built-in identities", () => {
  it("pins the reserved people space to one canonical SpaceId", () => {
    expect(BUILTIN_PEOPLE_SPACE_ID).toBe("space_00000000000000000000000000000001");
    expect(brandedValueSchemas.space.parse(BUILTIN_PEOPLE_SPACE_ID)).toBe(BUILTIN_PEOPLE_SPACE_ID);
  });
});

describe("digest wire schemas", () => {
  it.each([
    ["fact", `fact_sha256_${HEX_64}`],
    ["content", `sha256_${HEX_64}`],
    ["provenance", `provenance_sha256_${HEX_64}`],
    ["material", `mat_${HEX_64}`],
    ["materialSet", `set_sha256_${HEX_64}`],
    ["sourceGroup", `sg_${HEX_64}`],
    ["captureScope", `capture_scope_${HEX_64}`],
    ["conversation", `conversation_${HEX_64}`],
    ["briefContract", `brief_contract_${HEX_64}`],
  ] as const)("accepts a canonical %s value", (name, value) => {
    expect(digestSchemas[name].parse(value)).toBe(value);
  });

  it.each([
    `sha256_${HEX_64.slice(1)}`,
    `sha256_${HEX_64}0`,
    `sha256_${HEX_64.toUpperCase()}`,
    `src_${HEX_64.slice(0, 8)}`,
    `mat_${HEX_64.slice(0, 8)}`,
  ])("rejects truncated, extended, uppercase, and V2 identities: %s", (value) => {
    expect(() => digestSchemas.content.parse(value)).toThrow();
    expect(() => digestSchemas.material.parse(value)).toThrow();
  });
});

describe("non-digest branded value schemas", () => {
  it.each([
    ["subject", `subject_${HEX_32}`],
    ["space", `space_${HEX_32}`],
    ["job", `job_${HEX_32}`],
    ["lease", `lease_${HEX_32}`],
    ["leaseOwner", `lease_owner_${HEX_32}`],
    ["event", `event_${HEX_32}`],
    ["captureAudit", `capture_${HEX_32}`],
    ["raw", `raw_${HEX_64}`],
    ["version", `version_${HEX_64}`],
    ["claim", `claim_${HEX_64}`],
    ["relation", `relation_${HEX_64}`],
  ] as const)("accepts a canonical %s value", (name, value) => {
    expect(brandedValueSchemas[name].parse(value)).toBe(value);
  });

  it.each([
    ["subject", `subject_${HEX_32.slice(1)}`],
    ["space", `space_${HEX_32.toUpperCase()}`],
    ["job", `jobs_${HEX_32}`],
    ["leaseOwner", `lease_owner_${HEX_32.toUpperCase()}`],
    ["raw", `raw_${HEX_32}`],
    ["version", `version_${HEX_64}/x`],
  ] as const)("rejects a malformed %s value", (name, value) => {
    expect(() => brandedValueSchemas[name].parse(value)).toThrow();
  });

  it.each(["2026-08-20T08:09:10.123Z", "2000-02-29T23:59:59.000Z"])(
    "accepts canonical UTC milliseconds: %s",
    (value) => {
      expect(isoDateTimeSchema.parse(value)).toBe(value);
    },
  );

  it.each([
    "2026-08-20T08:09:10Z",
    "2026-08-20T16:09:10.123+08:00",
    "2026-02-30T08:09:10.123Z",
    "2026-08-20T08:09:60.123Z",
  ])("rejects a non-canonical or invalid timestamp: %s", (value) => {
    expect(() => isoDateTimeSchema.parse(value)).toThrow();
  });

  it.each(["codex", "claude-code", "host2"])("accepts a host slug: %s", (value) => {
    expect(hostNameSchema.parse(value)).toBe(value);
  });

  it.each(["2host", "Claude-Code", "host--name", "host-"])(
    "rejects a malformed host slug: %s",
    (value) => {
      expect(() => hostNameSchema.parse(value)).toThrow();
    },
  );

  it.each(["identity", "work.vocation", "corrections.unassigned"])(
    "accepts a facet path: %s",
    (value) => {
      expect(facetPathSchema.parse(value)).toBe(value);
    },
  );

  it.each(["", "1identity", "Work.vocation", "work..vocation", `a.${"b".repeat(33)}`])(
    "rejects a malformed facet path: %s",
    (value) => {
      expect(() => facetPathSchema.parse(value)).toThrow();
    },
  );

  it.each(["m001", "m042", "m999"])("accepts a briefing material ref: %s", (value) => {
    expect(briefMaterialRefSchema.parse(value)).toBe(value);
  });

  it.each(["m000", "m01", "m1000", "M001"])(
    "rejects a malformed briefing material ref: %s",
    (value) => {
      expect(() => briefMaterialRefSchema.parse(value)).toThrow();
    },
  );
});

describe("request id schema", () => {
  it("accepts one canonical 128-bit request id", () => {
    const value = `req_${"a".repeat(32)}`;
    expect(requestIdSchema.parse(value)).toBe(value);
  });

  it.each([
    "",
    "req_123",
    `req_${"A".repeat(32)}`,
    `req_${"a".repeat(31)}/`,
    `req_${"a".repeat(32)}0`,
    "../req_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "req_aaaaaaaaaaaaaaaa\\aaaaaaaaaaaaaaaa",
  ])("rejects an unsafe or non-canonical request id: %s", (value) => {
    expect(() => requestIdSchema.parse(value)).toThrow();
  });
});
