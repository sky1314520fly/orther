import js from "@eslint/js";
import jsdoc from "eslint-plugin-jsdoc";
import tseslint from "typescript-eslint";

const productSources = ["packages/*/src/**/*.ts"];

export default tseslint.config(
  {
    ignores: [
      "**/lib/**",
      "**/node_modules/**",
      "coverage/**",
      // Repository Python tools have their own gate.
      "scripts/**",
      "tests/**",
    ],
  },
  {
    files: [...productSources, "vitest.config.ts", "eslint.config.js"],
    extends: [js.configs.recommended],
  },
  {
    files: [...productSources, "vitest.config.ts"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // One compile face per package, plus a separate config for repo-level
        // programs that must not hang off the solution (design §25.1).
        project: ["./packages/*/tsconfig*.json", "./tsconfig.tools.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: productSources,
    plugins: { jsdoc },
    rules: {
      // An `any` needs an eslint-disable carrying its reason; an unused
      // directive is itself an error, so the reason cannot go stale silently.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true },
      ],
      // Type aliases are absent from the required contexts on purpose: a union
      // of literals or a branded string is its own description, and forcing a
      // block there produces prose that restates the declaration. Aliases that
      // do carry a constraint still get one, judged in review (design §27.9).
      "jsdoc/require-jsdoc": [
        "error",
        {
          publicOnly: true,
          require: { ClassDeclaration: true, FunctionDeclaration: true, MethodDefinition: true },
          contexts: ["TSInterfaceDeclaration", "TSEnumDeclaration"],
        },
      ],
      "jsdoc/require-param": "error",
      "jsdoc/require-param-description": "error",
      "jsdoc/require-returns": "error",
      "jsdoc/require-returns-description": "error",
    },
  },
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },
);
