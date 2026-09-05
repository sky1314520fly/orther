import { access, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import ts from "typescript";

const moduleSpecifiers = (path: string, source: string): readonly string[] => {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  const add = (literal: ts.Expression | undefined, kind: string): void => {
    if (literal === undefined) return;
    if (!ts.isStringLiteralLike(literal)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile));
      throw new Error(`${path}:${String(line + 1)} uses a non-literal ${kind}.`);
    }
    specifiers.push(literal.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier, "module specifier");
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression, "require");
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal, "import type");
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      add(node.arguments.length === 1 ? node.arguments[0] : undefined, "dynamic import");
      if (node.arguments.length !== 1) throw new Error(`${path} uses an invalid dynamic import.`);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      add(node.arguments.length === 1 ? node.arguments[0] : undefined, "require");
      if (node.arguments.length !== 1) throw new Error(`${path} uses an invalid require call.`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
};

const resolveModule = async (from: string, specifier: string): Promise<string | undefined> => {
  if (!specifier.startsWith(".")) return undefined;
  const candidate = resolve(dirname(from), specifier);
  const paths =
    extname(candidate) === ".js"
      ? [`${candidate.slice(0, -3)}.ts`]
      : [candidate, `${candidate}.ts`];
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // Try the next TypeScript source candidate.
    }
  }
  return undefined;
};

const walkImports = async (entry: string): Promise<ReadonlySet<string>> => {
  const visited = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (visited.has(path)) continue;
    visited.add(path);
    const source = await readFile(path, "utf8");
    for (const specifier of moduleSpecifiers(path, source)) {
      const target = await resolveModule(path, specifier);
      if (target !== undefined && !target.endsWith(".test.ts")) pending.push(target);
    }
  }
  return visited;
};

describe("SQLite production composition boundary", () => {
  it("discovers literal dynamic imports and rejects computed module loaders", () => {
    expect(
      moduleSpecifiers(
        "fixture.ts",
        'export { value } from "./static.js"; void import("./dynamic.js"); require("./cjs.js");',
      ),
    ).toEqual(["./static.js", "./dynamic.js", "./cjs.js"]);
    expect(() => moduleSpecifiers("fixture.ts", "void import(computed);")).toThrow(
      "non-literal dynamic import",
    );
    expect(() => moduleSpecifiers("fixture.ts", "require(computed);")).toThrow(
      "non-literal require",
    );
  });

  it("has no transitive dependency on legacy file authority, locks, recovery, or projections", async () => {
    const entry = resolve(dirname(fileURLToPath(import.meta.url)), "composition.ts");
    const modules = [...(await walkImports(entry))].map((path) => path.replaceAll("\\", "/"));
    const forbidden = modules.filter(
      (path) =>
        /\/facts\/(?:current-profile-projection|event-store|material-store|operation-store|space-store|state-store|subject-store|transaction-store|version-manifest-store|version-store)\.ts$/.test(
          path,
        ) ||
        /\/(?:correction|review)\/(?:journal|recovery|staging|transaction)\.ts$/.test(path) ||
        path.includes("/transaction/") ||
        path.includes("/queue/") ||
        path.includes("/projection/") ||
        path.includes("legacy-file"),
    );

    expect(forbidden).toEqual([]);
  });
});
