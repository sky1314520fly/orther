import type { BriefCapacity } from "@distilly/protocol";
import { describe, expect, it } from "vitest";

import { enforcePromptCapacity } from "./prompt-capacity.js";

const capacity = (
  maximumInputTokens: number,
  maximumToolResultBytes = maximumInputTokens,
): BriefCapacity => ({
  maximumInputTokens,
  maximumToolResultBytes,
  source: "sdk_explicit",
});

describe("profile prompt capacity", () => {
  it("returns the complete prompt at either exact boundary", () => {
    expect(enforcePromptCapacity("é", capacity(2))).toBe("é");
    expect(enforcePromptCapacity("ok", capacity(100, 2))).toBe("ok");
  });

  it("rejects a prompt over the trusted input or result budget without truncation", () => {
    expect(() => enforcePromptCapacity("é", capacity(1))).toThrowError(
      expect.objectContaining({ code: "context_too_large", retryable: false }),
    );
    expect(() => enforcePromptCapacity("long", capacity(100, 3))).toThrowError(
      expect.objectContaining({
        code: "context_too_large",
        details: {
          bytes: { serialized: 4 },
          tokens: { estimatedInput: 4 },
          limits: { maximumInputTokens: 100, maximumToolResultBytes: 3 },
        },
      }),
    );
  });

  it("keeps direct SDK reads unrestricted when no capacity was negotiated", () => {
    const prompt = "a complete prompt";
    expect(enforcePromptCapacity(prompt, undefined)).toBe(prompt);
  });
});
