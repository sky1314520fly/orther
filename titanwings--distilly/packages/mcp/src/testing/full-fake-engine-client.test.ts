import { engineMethodSchemas } from "@distilly/protocol";
import type { EngineMethodMap } from "@distilly/protocol";
import { describe, expect, it } from "vitest";

import { FULL_FAKE_ENGINE_RESULTS, FullFakeEngineClient } from "./full-fake-engine-client.js";

describe("full stdio fixture EngineClient", () => {
  it("provides a schema-valid deterministic result for all 35 methods", () => {
    const methods = Object.keys(FULL_FAKE_ENGINE_RESULTS) as (keyof EngineMethodMap)[];
    expect(methods).toHaveLength(35);
    expect(methods.toSorted()).toEqual(Object.keys(engineMethodSchemas).toSorted());

    for (const method of methods) {
      expect(() =>
        engineMethodSchemas[method].result.parse(FULL_FAKE_ENGINE_RESULTS[method]),
      ).not.toThrow();
    }
  });

  it("keeps watch and close deterministic without owning another resource", async () => {
    const client = new FullFakeEngineClient();
    const unsubscribe = await client.watch(() => undefined);
    expect(unsubscribe()).toBeUndefined();
    await client.close();
    expect(client.closeCalls).toBe(1);
  });
});
