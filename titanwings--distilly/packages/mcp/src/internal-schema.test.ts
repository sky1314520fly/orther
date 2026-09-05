import { distillyMcpTools } from "@distilly/protocol";
import { describe, expect, it } from "vitest";

import { advertisedToolContractDigest, projectAdvertisedSchema } from "./internal-schema.js";

describe("host advertised-schema contract", () => {
  it("preserves the historical canonical descriptor digest", () => {
    expect(advertisedToolContractDigest(undefined)).toBe(
      "sha256_a5ef4303fa29360416008448f12dd4b01f325143633e7fa2298c2094f73a6eda",
    );
  });

  it.each([
    ["openclaw", "sha256_e65ea0206530bad80cce26f83f5730f3cadd28569c233f0f58fc0f8338ce7fbd"],
    ["hermes", "sha256_cb214ba3d6c23bdd25bbd8327e5987bec55735224ec4a6f35acf4c92a304f38e"],
  ] as const)("binds the %s projection to a stable digest", (profile, digest) => {
    expect(advertisedToolContractDigest(profile)).toBe(digest);
    expect(advertisedToolContractDigest(profile)).not.toBe(advertisedToolContractDigest(undefined));
  });

  it("removes unsupported dialect metadata only from projected schemas", () => {
    const canonical = distillyMcpTools[0]?.inputSchema;
    expect(canonical).toBeDefined();
    expect(projectAdvertisedSchema(canonical, undefined)).toBe(canonical);
    const projected = projectAdvertisedSchema(canonical, "openclaw");
    expect(projected).not.toHaveProperty("$schema");
    expect(projected).not.toHaveProperty("$defs");
  });
});
