import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    // A command that ran nothing is not evidence (design/v3/27-testing-and-governance.md).
    passWithNoTests: false,
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/**/*.test.ts"],
      reporter: ["text", "json-summary"],
    },
  },
});
