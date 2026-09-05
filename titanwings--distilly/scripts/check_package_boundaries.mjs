#!/usr/bin/env node

/** Verify allowed workspace import directions and reject package cycles. */

import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const ALLOWED_INTERNAL_DEPENDENCIES = new Map([
  ["@distilly/protocol", new Set()],
  ["@distilly/adapters", new Set(["@distilly/protocol"])],
  ["@distilly/engine", new Set(["@distilly/protocol"])],
  [
    "@distilly/runtime",
    new Set([
      "@distilly/protocol",
      "@distilly/adapters",
      "@distilly/bindings",
      "@distilly/engine",
    ]),
  ],
  ["@distilly/bindings", new Set(["@distilly/protocol"])],
  ["distilly", new Set(["@distilly/protocol"])],
  ["@distilly/mcp", new Set(["@distilly/protocol"])],
  ["@distilly/panel", new Set(["@distilly/protocol", "@distilly/mcp"])],
  [
    "@distilly/cli",
    new Set([
      "@distilly/protocol",
      "@distilly/bindings",
      "@distilly/runtime",
      "distilly",
      "@distilly/mcp",
      "@distilly/panel",
    ]),
  ],
]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function repositoryPath(root, path) {
  const result = relative(root, path);
  return result === "" ? "." : result.replaceAll("\\", "/");
}

function isInside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function sourceExtension(path) {
  const match = /\.[^.\\/]+$/.exec(path);
  return match?.[0].toLowerCase();
}

async function sourceFiles(directory) {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return files;
    }
    throw error;
  }

  for (const entry of entries.sort((left, right) =>
    compareText(left.name, right.name),
  )) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(sourceExtension(path))) {
      files.push(path);
    }
  }
  return files;
}

async function discoverPackages(root, errors) {
  const packagesDirectory = resolve(root, "packages");
  let entries;
  try {
    entries = await readdir(packagesDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      errors.push("packages: [missing-packages-directory] expected workspace packages/");
      return [];
    }
    throw error;
  }

  const packages = [];
  for (const entry of entries.sort((left, right) =>
    compareText(left.name, right.name),
  )) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = resolve(packagesDirectory, entry.name);
    const manifestPath = resolve(directory, "package.json");
    let manifestText;
    try {
      manifestText = await readFile(manifestPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        errors.push(
          `${repositoryPath(root, manifestPath)}: [missing-package-manifest] expected package.json`,
        );
        continue;
      }
      throw error;
    }

    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch (error) {
      errors.push(
        `${repositoryPath(root, manifestPath)}: [invalid-package-manifest] ${error.message}`,
      );
      continue;
    }
    if (
      manifest === null ||
      typeof manifest !== "object" ||
      Array.isArray(manifest) ||
      typeof manifest.name !== "string" ||
      manifest.name.length === 0
    ) {
      errors.push(
        `${repositoryPath(root, manifestPath)}: [invalid-package-name] expected a non-empty string name`,
      );
      continue;
    }

    packages.push({
      directory,
      manifest,
      manifestPath,
      name: manifest.name,
      sourceDirectory: resolve(directory, "src"),
    });
  }

  if (packages.length === 0 && errors.length === 0) {
    errors.push("packages: [missing-workspace-packages] expected at least one package");
  }
  return packages;
}

function moduleSpecifiers(sourceFile) {
  const specifiers = [];
  const add = (literal, kind = "module") => {
    if (literal && ts.isStringLiteralLike(literal)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(literal.getStart());
      specifiers.push({ line: line + 1, value: literal.text });
    } else if (literal) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(literal.getStart());
      specifiers.push({ kind, line: line + 1 });
    }
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (node.arguments.length === 1 &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      add(
        node.arguments[0],
        node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? "dynamic import"
          : "require",
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function scriptKind(path) {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function isTestOnlySource(path) {
  return /(?:^|\/)(?:[^/]+\.)?(?:test|fixture|test-support)(?:\.[^/]*)?\.[cm]?[jt]sx?$/u.test(
    path,
  );
}

function isLegacyTestingSpecifier(specifier) {
  return /(?:^|\/)legacy-(?:file|sqlite)-/u.test(specifier);
}

function targetForBareSpecifier(specifier, packageNames) {
  for (const packageName of packageNames) {
    if (specifier === packageName || specifier.startsWith(`${packageName}/`)) {
      return packageName;
    }
  }
  if (specifier.startsWith("@distilly/")) {
    return specifier.split("/", 2).join("/");
  }
  return undefined;
}

function targetForDependencyAlias(
  specifier,
  packageNames,
  declaringDirectory,
  packageNamesByDirectory,
) {
  if (typeof specifier !== "string") {
    return undefined;
  }
  let reference;
  let acceptsNamedPackage = false;
  if (specifier.startsWith("npm:")) {
    reference = specifier.slice("npm:".length);
    acceptsNamedPackage = true;
  } else if (specifier.startsWith("workspace:")) {
    reference = specifier.slice("workspace:".length);
    acceptsNamedPackage = true;
  } else if (specifier.startsWith("link:")) {
    reference = specifier.slice("link:".length);
  } else if (specifier.startsWith("file:")) {
    reference = specifier.slice("file:".length);
  } else if (
    specifier === "." ||
    specifier === ".." ||
    specifier.startsWith("./") ||
    specifier.startsWith("../")
  ) {
    reference = specifier;
  } else {
    return undefined;
  }

  if (
    (reference === "." ||
      reference === ".." ||
      reference.startsWith("./") ||
      reference.startsWith("../"))
  ) {
    return packageNamesByDirectory.get(resolve(declaringDirectory, reference));
  }

  if (!acceptsNamedPackage) {
    return undefined;
  }

  for (const packageName of packageNames) {
    if (reference === packageName || reference.startsWith(`${packageName}@`)) {
      return packageName;
    }
  }
  return /^(@distilly\/[^/@]+)(?:@.*)?$/.exec(reference)?.[1];
}

function targetForSourceSpecifier(specifier, packageNames, aliases) {
  for (const [alias, target] of aliases) {
    if (specifier === alias || specifier.startsWith(`${alias}/`)) {
      return target;
    }
  }
  return targetForBareSpecifier(specifier, packageNames);
}

function packageForPath(path, packages) {
  return packages.find((candidate) => isInside(candidate.directory, path));
}

function addGraphEdge(graph, from, to, packageNames) {
  if (packageNames.has(to)) {
    graph.get(from)?.add(to);
  }
}

function validateEdge({ errors, from, location, target, kind }) {
  const allowed = ALLOWED_INTERNAL_DEPENDENCIES.get(from);
  if (allowed?.has(target)) {
    return;
  }
  errors.push(
    `${location}: [forbidden-internal-${kind}] ${from} may not depend on ${target}`,
  );
}

function cycleErrors(graph) {
  let nextIndex = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  const visit = (node) => {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of [...(graph.get(node) ?? [])].sort()) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(target)));
      }
    }

    if (lowLinks.get(node) === indices.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      components.push(component.sort());
    }
  };

  for (const node of [...graph.keys()].sort()) {
    if (!indices.has(node)) {
      visit(node);
    }
  }

  return components
    .filter(
      (component) =>
        component.length > 1 || graph.get(component[0])?.has(component[0]),
    )
    .map(
      (component) =>
        `packages: [dependency-cycle] internal package cycle includes ${component.join(
          ", ",
        )}`,
    );
}

/** Return deterministic diagnostics for package-boundary violations under root. */
export async function verify(root = process.cwd()) {
  const workspaceRoot = resolve(root);
  const errors = [];
  const packages = await discoverPackages(workspaceRoot, errors);
  const packageNames = new Set();
  for (const packageEntry of packages) {
    if (packageNames.has(packageEntry.name)) {
      errors.push(
        `${repositoryPath(workspaceRoot, packageEntry.manifestPath)}: [duplicate-package-name] ${packageEntry.name}`,
      );
    }
    packageNames.add(packageEntry.name);
    if (!ALLOWED_INTERNAL_DEPENDENCIES.has(packageEntry.name)) {
      errors.push(
        `${repositoryPath(workspaceRoot, packageEntry.manifestPath)}: [missing-boundary-rule] ${packageEntry.name}`,
      );
    }
  }

  const orderedPackageNames = [...packageNames].sort(
    (left, right) => right.length - left.length || compareText(left, right),
  );
  const packagesByPath = [...packages].sort(
    (left, right) => right.directory.length - left.directory.length,
  );
  const packageNamesByDirectory = new Map(
    packages.map((packageEntry) => [packageEntry.directory, packageEntry.name]),
  );
  const graph = new Map([...packageNames].sort().map((name) => [name, new Set()]));

  for (const packageEntry of packages) {
    const internalAliases = new Map();
    for (const section of DEPENDENCY_SECTIONS) {
      const dependencies = packageEntry.manifest[section];
      if (dependencies === undefined) {
        continue;
      }
      if (
        dependencies === null ||
        typeof dependencies !== "object" ||
        Array.isArray(dependencies)
      ) {
        errors.push(
          `${repositoryPath(workspaceRoot, packageEntry.manifestPath)}: [invalid-dependency-section] ${section} must be an object`,
        );
        continue;
      }
      for (const dependency of Object.keys(dependencies).sort()) {
        const aliasTarget = targetForDependencyAlias(
          dependencies[dependency],
          orderedPackageNames,
          packageEntry.directory,
          packageNamesByDirectory,
        );
        if (aliasTarget !== undefined) {
          internalAliases.set(dependency, aliasTarget);
        }
        const target =
          aliasTarget ?? targetForBareSpecifier(dependency, orderedPackageNames);
        if (target === undefined) {
          continue;
        }
        const location = `${repositoryPath(workspaceRoot, packageEntry.manifestPath)}#${section}`;
        if (!packageNames.has(target)) {
          errors.push(
            `${location}: [missing-internal-package] ${dependency} resolves to absent ${target}`,
          );
          continue;
        }
        addGraphEdge(graph, packageEntry.name, target, packageNames);
        validateEdge({
          errors,
          from: packageEntry.name,
          kind: "dependency",
          location,
          target,
        });
      }
    }

    const orderedInternalAliases = [...internalAliases].sort(
      ([left], [right]) => right.length - left.length || compareText(left, right),
    );

    for (const path of await sourceFiles(packageEntry.sourceDirectory)) {
      const sourceText = await readFile(path, "utf8");
      const sourceFile = ts.createSourceFile(
        path,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        scriptKind(path),
      );
      for (const diagnostic of sourceFile.parseDiagnostics) {
        const position = diagnostic.start ?? 0;
        const { line } = sourceFile.getLineAndCharacterOfPosition(position);
        errors.push(
          `${repositoryPath(workspaceRoot, path)}:${line + 1}: [source-parse-error] ${ts.flattenDiagnosticMessageText(
            diagnostic.messageText,
            " ",
          )}`,
        );
      }

      const seen = new Set();
      for (const specifier of moduleSpecifiers(sourceFile)) {
        const key = `${specifier.line}\0${specifier.kind ?? ""}\0${specifier.value ?? ""}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const location = `${repositoryPath(workspaceRoot, path)}:${specifier.line}`;
        if (specifier.value === undefined) {
          errors.push(
            `${location}: [non-static-module-specifier] ${specifier.kind} target must be a string literal`,
          );
          continue;
        }
        if (specifier.value.startsWith(".")) {
          if (
            packageEntry.name === "@distilly/engine" &&
            isLegacyTestingSpecifier(specifier.value) &&
            !isTestOnlySource(path)
          ) {
            errors.push(
              `${location}: [legacy-test-only-import] production Engine source cannot import a legacy test fixture`,
            );
          }
          const targetPackage = packageForPath(
            resolve(dirname(path), specifier.value),
            packagesByPath,
          );
          if (targetPackage && targetPackage.name !== packageEntry.name) {
            errors.push(
              `${location}: [cross-package-relative-import] ${packageEntry.name} bypasses ${targetPackage.name}'s package entry`,
            );
            addGraphEdge(
              graph,
              packageEntry.name,
              targetPackage.name,
              packageNames,
            );
            validateEdge({
              errors,
              from: packageEntry.name,
              kind: "import",
              location,
              target: targetPackage.name,
            });
          }
          continue;
        }

        const target = targetForSourceSpecifier(
          specifier.value,
          orderedPackageNames,
          orderedInternalAliases,
        );
        if (target === undefined) {
          continue;
        }
        if (!packageNames.has(target)) {
          errors.push(
            `${location}: [missing-internal-package] ${specifier.value} resolves to absent ${target}`,
          );
          continue;
        }
        addGraphEdge(graph, packageEntry.name, target, packageNames);
        validateEdge({
          errors,
          from: packageEntry.name,
          kind: "import",
          location,
          target,
        });
      }
    }
  }

  errors.push(...cycleErrors(graph));
  return [...new Set(errors)].sort();
}

async function main() {
  if (process.argv.length > 3) {
    console.error("usage: node scripts/check_package_boundaries.mjs [workspace-root]");
    process.exitCode = 2;
    return;
  }
  const root = process.argv[2] ?? process.cwd();
  const errors = await verify(root);
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    process.exitCode = 1;
    return;
  }
  console.log("package boundaries: ok");
}

const invokedPath = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(`package boundaries: ${error.stack ?? error.message ?? error}`);
    process.exitCode = 1;
  });
}
