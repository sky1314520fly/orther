import { describe, expect, it } from "vitest";

import { DistillyError } from "@distilly/protocol";
import type { EngineClient, EngineMethodMap } from "@distilly/protocol";

import { fullPanelReread } from "./web-recovery.js";

const recoveryClient = (doctorError: Error): { client: EngineClient; calls: string[] } => {
  const calls: string[] = [];
  const dynamic = {
    call(method: keyof EngineMethodMap): Promise<unknown> {
      calls.push(method);
      if (method === "library.list" || method === "reviews.list") {
        return Promise.resolve({ items: [] });
      }
      if (method === "system.doctor") return Promise.reject(doctorError);
      return Promise.reject(new Error(`Unexpected recovery method: ${method}`));
    },
    watch: () => Promise.resolve(() => undefined),
    close: () => Promise.resolve(),
  };
  return { client: dynamic as EngineClient, calls };
};

describe("fullPanelReread", () => {
  it("completes Preview recovery when only deep Doctor is deferred", async () => {
    const fixture = recoveryClient(
      new DistillyError({
        code: "schema_unsupported",
        message: "Deep Doctor is deferred in this Developer Preview.",
        retryable: false,
        details: { kind: "preview_method_deferred", method: "system.doctor" },
      }),
    );

    await expect(fullPanelReread(fixture.client)).resolves.toBeUndefined();
    expect(fixture.calls).toEqual(["library.list", "reviews.list", "system.doctor"]);
  });

  it("still surfaces an unrelated non-retryable schema failure", async () => {
    const failure = new DistillyError({
      code: "schema_unsupported",
      message: "The stored schema is newer than this Panel.",
      retryable: false,
      details: { kind: "storage_schema_incompatible", method: "system.doctor" },
    });
    const fixture = recoveryClient(failure);

    await expect(fullPanelReread(fixture.client)).rejects.toBe(failure);
  });
});
