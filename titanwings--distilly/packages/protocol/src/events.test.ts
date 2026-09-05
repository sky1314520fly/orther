import { describe, expect, it, vi } from "vitest";

import { decodeEngineEvent, engineEventSchema } from "./schemas/events.js";

const subjectId = `subject_${"1".repeat(32)}`;
const versionId = `version_${"2".repeat(64)}`;
const at = "2026-08-20T00:00:00.000Z";

describe("EngineEvent transport boundary", () => {
  it("parses and dispatches every known event kind", () => {
    const kinds = [
      "subject.created",
      "subject.archived",
      "subject.purged",
      "material.ingested",
      "job.changed",
      "version.current",
      "version.suspended",
      "version.promoted",
      "version.rejected",
      "version.rolled_back",
      "relation.changed",
    ] as const;

    for (const kind of kinds) {
      const onEvent = vi.fn();
      const onFullReread = vi.fn();
      const value = {
        kind,
        subjectId,
        ...(kind.startsWith("version.") ? { versionId } : {}),
        at,
      };

      expect(decodeEngineEvent(value, { onEvent, onFullReread })).toEqual({
        kind: "event",
        event: value,
      });
      expect(onEvent).toHaveBeenCalledOnce();
      expect(onFullReread).not.toHaveBeenCalled();
    }
  });

  it.each([
    { kind: "version.future", subjectId, versionId, at },
    { kind: 42, subjectId, at },
    { subjectId, at },
  ])("returns schema_unsupported and requests a full reread for unknown kind %#", (value) => {
    const onEvent = vi.fn();
    const onFullReread = vi.fn();

    const result = decodeEngineEvent(value, { onEvent, onFullReread });

    expect(result).toMatchObject({
      kind: "schema_unsupported",
      error: { code: "schema_unsupported", retryable: false },
    });
    expect(onEvent).not.toHaveBeenCalled();
    expect(onFullReread).toHaveBeenCalledOnce();
  });

  it("rejects malformed known events without dispatching them", () => {
    const handlers = { onEvent: vi.fn(), onFullReread: vi.fn() };

    expect(() => decodeEngineEvent({ kind: "version.current", subjectId, at }, handlers)).toThrow();
    expect(() =>
      engineEventSchema.parse({ kind: "subject.created", subjectId, at, extra: true }),
    ).toThrow();
    expect(handlers.onEvent).not.toHaveBeenCalled();
    expect(handlers.onFullReread).not.toHaveBeenCalled();
  });
});
