import { describe, expect, it } from "vitest";

import type { SpaceId, SubjectId, SubjectSummary } from "@distilly/protocol";
import { BUILTIN_PEOPLE_SPACE_ID, DistillyError, WIRE_LIMITS } from "@distilly/protocol";

import {
  canonicalizeHttpUrl,
  canonicalizeIngestSubjectTarget,
  findCreateConflict,
  normalizeCreateSubjectInput,
  normalizeLabelV1,
} from "./identity.js";

const SPACE_ID = "space_11111111111111111111111111111111" as SpaceId;

const summary = (
  suffix: string,
  displayName: string,
  identityHints: SubjectSummary["identityHints"] = [],
  aliases: readonly string[] = [],
): SubjectSummary => ({
  id: `subject_${suffix.repeat(32)}` as SubjectId,
  displayName,
  aliases,
  identityHints,
  space: { id: SPACE_ID, displayName: "People", kind: "people" },
  lifecycle: "active",
});

describe("subject identity v1", () => {
  it("normalizes labels without folding case or internal bytes", () => {
    expect(normalizeLabelV1(" \tCafe\u0301  Person\r")).toBe("Café  Person");
    expect(normalizeLabelV1("\u00a0Ada\u00a0")).toBe("\u00a0Ada\u00a0");
    expect(() => normalizeLabelV1("\t\n\r ")).toThrowError(DistillyError);
  });

  it("reapplies the label byte bound after NFC expansion", () => {
    const exact = "x".repeat(WIRE_LIMITS.labelBytes);
    const expandsPastLimit = `${"x".repeat(WIRE_LIMITS.labelBytes - 2)}\u0344`;
    expect(Buffer.byteLength(expandsPastLimit, "utf8")).toBe(WIRE_LIMITS.labelBytes);
    expect(Buffer.byteLength(expandsPastLimit.normalize("NFC"), "utf8")).toBe(
      WIRE_LIMITS.labelBytes + 2,
    );
    expect(normalizeLabelV1(exact)).toBe(exact);
    expect(() => normalizeLabelV1(expandsPastLimit)).toThrowError(
      expect.objectContaining({ code: "invalid_input", fieldPath: "displayName" }),
    );
  });

  it("canonicalizes absolute HTTP URLs conservatively", () => {
    expect(canonicalizeHttpUrl("HTTPS://Example.COM:443/a/../b?q=1#bio", "url")).toBe(
      "https://example.com/b?q=1",
    );
    expect(() => canonicalizeHttpUrl("ftp://example.com/a", "url")).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });

  it("reapplies the URI byte bound after WHATWG percent encoding", () => {
    const prefix = "https://example.com/";
    const exact = `${prefix}${"x".repeat(WIRE_LIMITS.uriBytes - prefix.length)}`;
    const expandsPastLimit = prefix + "é".repeat((WIRE_LIMITS.uriBytes - prefix.length) / 2);
    expect(Buffer.byteLength(exact, "utf8")).toBe(WIRE_LIMITS.uriBytes);
    expect(canonicalizeHttpUrl(exact, "url")).toBe(exact);
    expect(Buffer.byteLength(expandsPastLimit, "utf8")).toBe(WIRE_LIMITS.uriBytes);
    expect(Buffer.byteLength(new URL(expandsPastLimit).toString(), "utf8")).toBeGreaterThan(
      WIRE_LIMITS.uriBytes,
    );
    expect(() => canonicalizeHttpUrl(expandsPastLimit, "url")).toThrowError(
      expect.objectContaining({ code: "invalid_input", fieldPath: "url" }),
    );
  });

  it("canonicalizes create targets and gives omitted spaces the reserved people id", () => {
    const left = canonicalizeIngestSubjectTarget({
      kind: "create",
      input: {
        displayName: " Ada ",
        aliases: ["B", "A", "B"],
        identityHints: [
          { kind: "account", provider: "GitHub", handle: " Ada " },
          { kind: "url", value: "https://EXAMPLE.com/#x" },
        ],
      },
    });
    const right = canonicalizeIngestSubjectTarget({
      kind: "create",
      input: {
        displayName: "Ada",
        aliases: ["A", "B"],
        identityHints: [
          { kind: "url", value: "https://example.com/" },
          { kind: "account", provider: "github", handle: "Ada" },
        ],
      },
    });

    expect(left.target).toEqual({
      kind: "create",
      input: {
        displayName: "Ada",
        space: { kind: "builtin_people", spaceId: BUILTIN_PEOPLE_SPACE_ID },
        aliases: ["A", "B"],
        identityHints: [
          { kind: "account", provider: "github", handle: "Ada" },
          { kind: "url", value: "https://example.com/" },
        ],
      },
    });
    expect(left.bytes).toEqual(right.bytes);
    expect(
      canonicalizeIngestSubjectTarget({
        kind: "create",
        input: { displayName: "Ada", spaceId: BUILTIN_PEOPLE_SPACE_ID },
      }).target,
    ).toMatchObject({ kind: "create", input: { space: { kind: "builtin_people" } } });
    expect(
      canonicalizeIngestSubjectTarget({
        kind: "create",
        input: { displayName: "Ada", space: { displayName: "People", kind: "people" } },
      }).target,
    ).toMatchObject({ kind: "create", input: { space: { kind: "builtin_people" } } });
  });

  it("keeps account handle case when the frozen v1 provider table is empty", () => {
    const upper = normalizeCreateSubjectInput({
      displayName: "Ada",
      identityHints: [{ kind: "account", provider: "github", handle: "Ada" }],
    });
    const lower = normalizeCreateSubjectInput({
      displayName: "Ada",
      identityHints: [{ kind: "account", provider: "github", handle: "ada" }],
    });
    expect(upper.identityHints).not.toEqual(lower.identityHints);
  });

  it("rejects mutually exclusive space selectors", () => {
    expect(() =>
      normalizeCreateSubjectInput({
        displayName: "Ada",
        spaceId: SPACE_ID,
        space: { displayName: "Other", kind: "custom" },
      }),
    ).toThrowError(expect.objectContaining({ code: "invalid_input", fieldPath: "space" }));
  });

  it("prefers exact locators and rejects duplicate locator ownership", () => {
    const target = normalizeCreateSubjectInput({
      displayName: "Ada",
      identityHints: [{ kind: "url", value: "https://example.com/ada#about" }],
    });
    const exact = summary("1", "Different", [{ kind: "url", value: "https://EXAMPLE.com/ada" }]);
    expect(findCreateConflict(target, [exact])).toEqual({
      kind: "already_exists",
      subject: exact,
    });
    expect(() =>
      findCreateConflict(target, [exact, summary("2", "Other", exact.identityHints)]),
    ).toThrowError(expect.objectContaining({ code: "storage_corrupt" }));
  });

  it("returns stable exact-name candidates and excludes proven locator conflicts", () => {
    const target = normalizeCreateSubjectInput({
      displayName: "Ada",
      identityHints: [{ kind: "account", provider: "github", handle: "ada-new" }],
    });
    const excluded = summary("3", "Ada", [
      { kind: "account", provider: "github", handle: "different" },
    ]);
    const first = summary("1", "Ada");
    const second = summary("2", "Other", [], ["Ada"]);

    expect(findCreateConflict(target, [second, excluded, first])).toEqual({
      kind: "ambiguous",
      candidates: [first, second],
    });
    expect(findCreateConflict(target, [excluded])).toEqual({ kind: "none" });
  });

  it("never treats descriptions as unique locators", () => {
    const target = normalizeCreateSubjectInput({
      displayName: "Ada",
      identityHints: [{ kind: "description", value: "mathematician" }],
    });
    const candidate = summary("1", "Different", [{ kind: "description", value: "mathematician" }]);
    expect(findCreateConflict(target, [candidate])).toEqual({ kind: "none" });
  });
});
