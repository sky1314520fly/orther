import { describe, expect, it, vi } from "vitest";

import { isoDateTimeSchema, subjectIdSchema, type EngineEvent } from "@distilly/protocol";

import { InProcessEventBus } from "./in-process-event-bus.js";

const EVENT: EngineEvent = {
  kind: "material.ingested",
  subjectId: subjectIdSchema.parse(`subject_${"0".repeat(32)}`),
  at: isoDateTimeSchema.parse("2026-08-20T00:00:00.000Z"),
};

describe("InProcessEventBus", () => {
  it("isolates a throwing observer from the mutation result and later observers", async () => {
    const bus = new InProcessEventBus();
    const later = vi.fn();
    bus.subscribe(() => {
      throw new Error("observer failed");
    });
    bus.subscribe(later);

    await expect(bus.publish(EVENT)).resolves.toBeUndefined();
    expect(later).toHaveBeenCalledWith(EVENT);
  });
});
