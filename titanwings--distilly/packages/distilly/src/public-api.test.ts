import { describe, expect, it } from "vitest";

import * as publicApi from "./index.js";

describe("distilly public API", () => {
  it("keeps the browser-safe runtime root deliberately small", () => {
    expect(Object.keys(publicApi).sort()).toEqual(["Distilly", "DistillyError", "Person"]);
  });
});
