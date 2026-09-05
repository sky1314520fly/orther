import { describe, expect, it } from "vitest";

import { WIRE_LIMITS } from "@distilly/protocol";

import { decodeCursor, encodeCursor } from "./cursor.js";

describe("read-model cursor", () => {
  it("round-trips the complete sort tuple for the same normalized query", () => {
    const filters = { lifecycle: "active", text: "Mira" } as const;
    const cursor = encodeCursor("library.list", filters, ["Mira", "subject_1"]);

    expect(cursor).toMatch(/^cursor_v1_[A-Za-z0-9_-]+$/u);
    expect(decodeCursor(cursor, "library.list", filters)).toEqual(["Mira", "subject_1"]);
  });

  it("binds a cursor to both its method and normalized filters", () => {
    const cursor = encodeCursor("reviews.list", { subjectId: "subject_1" }, ["2026", "v1"]);

    expect(() => decodeCursor(cursor, "versions.list", { subjectId: "subject_1" })).toThrowError(
      expect.objectContaining({ code: "invalid_input", fieldPath: "cursor" }),
    );
    expect(() => decodeCursor(cursor, "reviews.list", { subjectId: "subject_2" })).toThrowError(
      expect.objectContaining({ code: "invalid_input", fieldPath: "cursor" }),
    );
  });

  it("contains a worst-case escaped legal display name within the dedicated cursor bound", () => {
    const displayName = "\0".repeat(WIRE_LIMITS.labelBytes);
    const cursor = encodeCursor("library.list", {}, [displayName, `subject_${"1".repeat(32)}`]);

    expect(Buffer.byteLength(cursor, "utf8")).toBeLessThanOrEqual(WIRE_LIMITS.cursorBytes);
    expect(decodeCursor(cursor, "library.list", {})).toEqual([
      displayName,
      `subject_${"1".repeat(32)}`,
    ]);
    expect(() =>
      decodeCursor("x".repeat(WIRE_LIMITS.cursorBytes + 1), "library.list", {}),
    ).toThrowError(expect.objectContaining({ code: "invalid_input", fieldPath: "cursor" }));
  });

  it.each(["cursor_v1_***", "cursor_v2_e30", "cursor_v1_eyJtZXRob2QiOiJ4In0", "not-a-cursor"])(
    "rejects malformed or incomplete cursor %s",
    (cursor) => {
      expect(() => decodeCursor(cursor, "library.list", {})).toThrowError(
        expect.objectContaining({ code: "invalid_input", fieldPath: "cursor" }),
      );
    },
  );
});
