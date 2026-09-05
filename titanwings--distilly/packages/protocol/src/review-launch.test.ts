import { describe, expect, it } from "vitest";

import { reviewLaunchSchema } from "./schemas/versions.js";

const TOKEN = "a".repeat(64);
const SUBJECT_ID = `subject_${"b".repeat(32)}`;
const CANDIDATE_VERSION_ID = `version_${"c".repeat(64)}`;
const ref = {
  subjectId: SUBJECT_ID,
  candidateVersionId: CANDIDATE_VERSION_ID,
} as const;

const reviewUrl = (port = "43123") =>
  `http://127.0.0.1:${port}/#${TOKEN}/review/${SUBJECT_ID}/${CANDIDATE_VERSION_ID}`;

describe("review launch boundary", () => {
  it("accepts the exact loopback Panel review route and valid port limits", () => {
    for (const port of ["1", "81", "43123", "65535"]) {
      const value = { ref, url: reviewUrl(port) };
      expect(reviewLaunchSchema.parse(value)).toEqual(value);
    }
  });

  it.each([
    ["https", reviewUrl().replace("http://", "https://")],
    ["localhost", reviewUrl().replace("127.0.0.1", "localhost")],
    ["IPv6", reviewUrl().replace("127.0.0.1", "[::1]")],
    ["missing explicit port", reviewUrl().replace(":43123", "")],
    ["userinfo", reviewUrl().replace("127.0.0.1", "user@127.0.0.1")],
    ["query", reviewUrl().replace("/#", "/?source=test#")],
    ["non-root path", reviewUrl().replace("/#", "/panel/#")],
    ["zero port", reviewUrl("0")],
    ["default HTTP port", reviewUrl("80")],
    ["port with a leading zero", reviewUrl("043123")],
    ["port above TCP range", reviewUrl("65536")],
    ["uppercase token", reviewUrl().replace(TOKEN, "A".repeat(64))],
    ["short token", reviewUrl().replace(TOKEN, "a".repeat(63))],
    ["wrong route", reviewUrl().replace("/review/", "/reviews/")],
    ["trailing slash", `${reviewUrl()}/`],
  ])("rejects %s", (_case, url) => {
    expect(() => reviewLaunchSchema.parse({ ref, url })).toThrow();
  });

  it("rejects routes whose subject or candidate does not exactly match ref", () => {
    expect(() =>
      reviewLaunchSchema.parse({
        ref,
        url: reviewUrl().replace(SUBJECT_ID, `subject_${"d".repeat(32)}`),
      }),
    ).toThrow();
    expect(() =>
      reviewLaunchSchema.parse({
        ref,
        url: reviewUrl().replace(CANDIDATE_VERSION_ID, `version_${"e".repeat(64)}`),
      }),
    ).toThrow();
  });
});
