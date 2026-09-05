import type { MaterialInput } from "@distilly/protocol";
import { describe, expect, it } from "vitest";

import type {
  AdapterResource,
  DelegatedSourceAdapter,
  DirectSourceAdapter,
  SourceAdapter,
} from "./contracts.js";
import { AdapterRegistry } from "./registry.js";

interface FixtureResource extends AdapterResource {
  readonly kind: "documents";
  readonly locator: string;
}

const resourceSchema = {
  parse(input: unknown): FixtureResource {
    if (
      typeof input !== "object" ||
      input === null ||
      Array.isArray(input) ||
      Object.keys(input).length !== 2 ||
      (input as Record<string, unknown>).kind !== "documents" ||
      typeof (input as Record<string, unknown>).locator !== "string"
    ) {
      throw new TypeError("invalid fixture resource");
    }
    return input as FixtureResource;
  },
};

const capabilities = () => ({
  resolveSubject: true,
  plan: false,
  collect: true,
  requiresSecret: true,
  resourceKinds: [
    {
      kind: "documents",
      availability: "available" as const,
    },
  ],
});

const direct = (id: string): DirectSourceAdapter<FixtureResource> => ({
  id,
  mode: "direct",
  resourceSchema,
  capabilities,
  preflight: () => Promise.resolve({ ok: true, warnings: [] }),
  resolveSubject: () => Promise.resolve([]),
  async *collect(): AsyncIterable<MaterialInput> {
    await Promise.resolve();
    const materials: MaterialInput[] = [];
    yield* materials;
  },
});

const delegated = (id: string): DelegatedSourceAdapter<FixtureResource> => ({
  id,
  mode: "delegated",
  resourceSchema,
  capabilities: () => ({ ...capabilities(), plan: true, collect: false }),
  preflight: () => Promise.resolve({ ok: true, warnings: [] }),
  resolveSubject: () => Promise.resolve([]),
  plan: () => Promise.resolve({ questions: [], suggestedQueries: [] }),
});

const registerUnknown = (registry: AdapterRegistry, candidate: unknown): void => {
  registry.register(candidate as SourceAdapter<AdapterResource>);
};

describe("AdapterRegistry", () => {
  it("registers both modes but lists only frozen content-free snapshots", () => {
    const registry = new AdapterRegistry();
    const zeta = direct("zeta");
    const alpha = delegated("alpha");

    registry.register(zeta);
    registry.register(alpha);

    const snapshot = registry.list();
    expect(snapshot.map(({ id }) => id)).toEqual(["alpha", "zeta"]);
    expect(snapshot.map(({ mode }) => mode)).toEqual(["delegated", "direct"]);
    expect(Object.keys(snapshot[0] ?? {}).sort()).toEqual(["capabilities", "id", "mode"]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(Object.isFrozen(snapshot[0]?.capabilities)).toBe(true);
    expect(Object.isFrozen(snapshot[0]?.capabilities.resourceKinds)).toBe(true);
    expect(() => (snapshot as unknown[]).push({})).toThrow(TypeError);

    registry.register(direct("beta"));
    expect(snapshot.map(({ id }) => id)).toEqual(["alpha", "zeta"]);
    expect(registry.list().map(({ id }) => id)).toEqual(["alpha", "beta", "zeta"]);
  });

  it("snapshots capabilities at registration instead of exposing mutable adapter state", () => {
    let available: "available" | "unavailable" = "available";
    const adapter = direct("mutable");
    adapter.capabilities = () => ({
      ...capabilities(),
      resourceKinds: [{ kind: "documents", availability: available }],
    });
    const registry = new AdapterRegistry();

    registry.register(adapter);
    available = "unavailable";

    expect(registry.list()[0]?.capabilities.resourceKinds).toEqual([
      { kind: "documents", availability: "available" },
    ]);
  });

  it("rejects malformed adapters without mutating the registry", () => {
    const invalid = [
      null,
      {},
      { ...direct("valid"), id: "" },
      { ...direct("valid"), mode: "other" },
      { ...direct("valid"), resourceSchema: {} },
      { ...direct("valid"), capabilities: undefined },
      { ...direct("valid"), preflight: undefined },
      { ...direct("valid"), resolveSubject: undefined },
      { ...direct("valid"), collect: undefined },
      { ...delegated("valid"), plan: undefined },
      {
        ...direct("valid"),
        capabilities: () => ({ ...capabilities(), requiresSecret: "yes" }),
      },
    ];

    for (const candidate of invalid) {
      const registry = new AdapterRegistry();
      expect(() => registerUnknown(registry, candidate)).toThrow();
      expect(registry.list()).toEqual([]);
    }
  });

  it("rejects duplicates synchronously without replacing the first adapter", () => {
    const registry = new AdapterRegistry();
    registry.register(direct("same"));

    expect(() => registry.register(delegated("same"))).toThrowError(
      expect.objectContaining({ name: "DuplicateSourceAdapterError" }),
    );
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.mode).toBe("direct");
  });
});
