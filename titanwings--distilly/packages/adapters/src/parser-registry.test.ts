import type { MaterialParser } from "./contracts.js";
import { describe, expect, it } from "vitest";

import { ParserRegistry } from "./parser-registry.js";

const parser = (id: string, accepts: readonly string[]): MaterialParser => ({
  id,
  accepts,
  parse() {
    return Promise.resolve({ warnings: [] });
  },
});

describe("ParserRegistry", () => {
  it("selects exact lowercase media types and lists parsers in stable order", () => {
    const registry = new ParserRegistry();
    const zeta = parser("zeta", ["text/plain"]);
    const alpha = parser("alpha", ["application/json"]);

    registry.register(zeta);
    registry.register(alpha);

    expect(registry.select("text/plain")).toBe(zeta);
    expect(registry.select("Text/Plain")).toBeUndefined();
    expect(registry.select("text/plain; charset=utf-8")).toBeUndefined();
    expect(registry.list().map(({ id }) => id)).toEqual(["alpha", "zeta"]);
    expect(Object.isFrozen(registry.list())).toBe(true);
  });

  it("rejects duplicate ids, repeated accepts, and cross-parser accept conflicts", () => {
    const registry = new ParserRegistry();
    registry.register(parser("first", ["text/plain"]));

    expect(() => registry.register(parser("first", ["text/markdown"]))).toThrowError(
      expect.objectContaining({ name: "DuplicateMaterialParserError" }),
    );
    expect(() => registry.register(parser("second", ["text/plain"]))).toThrowError(
      expect.objectContaining({ name: "ConflictingMediaTypeError" }),
    );
    expect(() =>
      new ParserRegistry().register(parser("repeat", ["text/plain", "text/plain"])),
    ).toThrow(TypeError);
    expect(registry.list().map(({ id }) => id)).toEqual(["first"]);
  });

  it("rejects malformed ids, accepts, media types, and parse functions", () => {
    const invalid: unknown[] = [
      null,
      {},
      parser("", ["text/plain"]),
      parser("uppercase", ["Text/Plain"]),
      parser("parameter", ["text/plain; charset=utf-8"]),
      parser("empty", []),
      { id: "missing-parse", accepts: ["text/plain"] },
    ];

    for (const candidate of invalid) {
      expect(() => new ParserRegistry().register(candidate as MaterialParser)).toThrow(TypeError);
    }
  });
});
