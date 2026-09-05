import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { distillyMcpTools } from "@distilly/protocol";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const releaseVersion = "0.1.0-preview.1";
const repositoryRoot = resolve(new URL("../../..", import.meta.url).pathname);
const nodePath = await realpath(process.execPath);
const forbiddenSentinel = "__DISTILLY_LAUNCHER_ABSOLUTE_PATH__";

const parseArgs = () => {
  let packagePath;
  let codexPath;
  for (let index = 2; index < process.argv.length; index += 1) {
    const option = process.argv[index];
    const value = process.argv[index + 1];
    if ((option === "--package" || option === "--codex") && value !== undefined) {
      if (option === "--package") packagePath = resolve(value);
      else codexPath = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(
      "Usage: verify-codex-package.mjs --package <absolute-directory> --codex <absolute-executable>",
    );
  }
  if (!isAbsolute(packagePath ?? "") || !isAbsolute(codexPath ?? "")) {
    throw new Error("The package and Codex paths must be absolute.");
  }
  return { packagePath, codexPath };
};

const compareUtf8 = (left, right) =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const inside = (root, candidate) => {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const walk = async (root, current = root) => {
  const files = [];
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => compareUtf8(left.name, right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    assert.equal(entry.isSymbolicLink(), false, `artifact symlink: ${path}`);
    if (entry.isDirectory()) files.push(...(await walk(root, path)));
    else {
      assert.equal(entry.isFile(), true, `artifact special file: ${path}`);
      files.push(relative(root, path).split(sep).join("/"));
    }
  }
  return files;
};

const scanArtifact = async (root) => {
  const files = await walk(root);
  assert.equal(files.includes("preview-runtime-manifest.json"), true);
  assert.equal(
    files.some((path) => path.endsWith(".mcp.json.template")),
    false,
  );
  for (const path of files) {
    assert.equal(/\.test\.|\.spec\.|playwright|(?:^|\/)testing(?:\/|$)/iu.test(path), false);
    const bytes = await readFile(join(root, path));
    assert.equal(bytes.includes(Buffer.from(forbiddenSentinel)), false, path);
    assert.equal(bytes.includes(Buffer.from(repositoryRoot)), false, path);
    assert.equal(bytes.includes(Buffer.from("workspace:*")), false, path);
  }
};

const run = (executable, args, options) => {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(
    result.status,
    0,
    `${basename(executable)} ${args.join(" ")} failed:\n${result.stderr}`,
  );
  return { stdout: result.stdout, stderr: result.stderr };
};

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

let requestCounter = 1;
const requestId = () => `req_${(requestCounter++).toString(16).padStart(32, "0")}`;

const output = (toolIndex, result) => {
  const contract = distillyMcpTools[toolIndex];
  assert.ok(contract);
  return contract.output.parse(result.structuredContent);
};

const waitUntil = async (predicate) => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("MCP child did not exit.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
};

const connect = async (launcher, environment, cwd) => {
  const transport = new StdioClientTransport({
    command: launcher,
    args: ["mcp", "--host", "codex"],
    cwd,
    env: environment,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.setEncoding("utf8");
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const client = new Client({ name: "distilly-package-e2e", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
};

const close = async (connection) => {
  await connection.client.close();
  await waitUntil(() => connection.transport.pid === null);
  assert.equal(connection.stderr(), "");
};

const { packagePath: sourcePackage, codexPath: configuredCodex } = parseArgs();
const codexPath = await realpath(configuredCodex);
const codexVersion = run(codexPath, ["--version"], {
  cwd: repositoryRoot,
  env: process.env,
});
assert.equal(codexVersion.stdout.trim(), "codex-cli 0.146.0");
assert.equal(codexVersion.stderr, "");
await scanArtifact(sourcePackage);

const testRoot = await mkdtemp(join(tmpdir(), "Distilly Package 蒸馏 "));
const home = join(testRoot, "home 用户");
const codexHome = join(home, ".codex");
const workspace = join(testRoot, "workspace 空间");
const extracted = join(testRoot, "extracted 包");
const removedExtraction = join(testRoot, "removed 包");
const codexDirectory = dirname(configuredCodex);
const nodeDirectory = dirname(nodePath);
const environment = {
  HOME: home,
  USERPROFILE: home,
  CODEX_HOME: codexHome,
  TMPDIR: testRoot,
  PATH: [nodeDirectory, codexDirectory, "/usr/bin", "/bin"].join(delimiter),
  LANG: process.env.LANG ?? "en_US.UTF-8",
  TERM: process.env.TERM ?? "dumb",
  NODE_NO_WARNINGS: "1",
};

try {
  await mkdir(codexHome, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await cp(sourcePackage, extracted, { recursive: true, force: false, errorOnExist: true });
  const bootstrapEntry = join(extracted, "packages/cli/lib/bin.js");
  const setup = run(nodePath, [bootstrapEntry, "setup", "--host", "codex"], {
    cwd: workspace,
    env: environment,
  });
  assert.equal(setup.stderr, "");
  assert.match(setup.stdout, /Installed Distilly 0\.1\.0-preview\.1 for codex/u);

  const installManifestPath = join(home, ".distilly", "install.json");
  const installManifest = JSON.parse(await readFile(installManifestPath, "utf8"));
  const runtimeRoot = join(home, ".distilly", "runtime", releaseVersion);
  const launcher = join(home, ".distilly", "bin", "distilly");
  assert.equal(installManifest.releaseVersion, releaseVersion);
  assert.equal(installManifest.entryPath, join(runtimeRoot, "packages/cli/lib/bin.js"));
  assert.equal(inside(runtimeRoot, installManifest.entryPath), true);
  assert.equal(inside(extracted, installManifest.entryPath), false);

  const installedPlugin = join(home, "plugins", "distilly");
  const installedMcp = JSON.parse(await readFile(join(installedPlugin, ".mcp.json"), "utf8"));
  assert.deepEqual(installedMcp, {
    mcpServers: {
      distilly: { command: launcher, args: ["mcp", "--host", "codex"] },
    },
  });
  assert.equal(
    (await readFile(join(installedPlugin, ".mcp.json"))).includes(Buffer.from(forbiddenSentinel)),
    false,
  );

  await rename(extracted, removedExtraction);
  const doctor = run(launcher, ["doctor", "--host", "codex"], {
    cwd: workspace,
    env: environment,
  });
  assert.equal(doctor.stderr, "");
  assert.deepEqual(JSON.parse(doctor.stdout), {
    ok: true,
    installed: true,
    releaseVersion,
    launcherReachable: true,
    hosts: [
      {
        host: "codex",
        installed: true,
        executableReachable: true,
        launcherReachable: true,
        wireCompatible: true,
        warnings: [],
      },
    ],
    warnings: [],
  });

  const pluginList = JSON.parse(
    run(codexPath, ["plugin", "list", "--json"], { cwd: workspace, env: environment }).stdout,
  );
  assert.equal(pluginList.installed.length, 1);
  assert.deepEqual(
    {
      pluginId: pluginList.installed[0].pluginId,
      version: pluginList.installed[0].version,
      installed: pluginList.installed[0].installed,
      enabled: pluginList.installed[0].enabled,
    },
    { pluginId: "distilly@personal", version: releaseVersion, installed: true, enabled: true },
  );
  const mcpList = JSON.parse(
    run(codexPath, ["mcp", "list", "--json"], { cwd: workspace, env: environment }).stdout,
  );
  assert.deepEqual(
    mcpList.map(({ name }) => name),
    ["distilly"],
  );
  assert.deepEqual(mcpList[0].transport, {
    type: "stdio",
    command: launcher,
    args: ["mcp", "--host", "codex"],
    env: null,
    env_vars: [],
    cwd: null,
  });

  const hostSpawnedEnvironment = { ...environment };
  delete hostSpawnedEnvironment.CODEX_HOME;
  const hostSpawned = await connect(launcher, hostSpawnedEnvironment, workspace);
  try {
    const listed = await hostSpawned.client.listTools();
    assert.deepEqual(
      listed.tools.map(({ name }) => name),
      distillyMcpTools.map(({ name }) => name),
    );
  } finally {
    await close(hostSpawned);
  }

  const first = await connect(launcher, environment, workspace);
  let subjectId;
  try {
    assert.deepEqual(first.client.getServerVersion(), {
      name: "distilly",
      version: releaseVersion,
    });
    const listed = await first.client.listTools();
    assert.deepEqual(
      listed.tools.map(({ name, title, description, inputSchema, outputSchema, annotations }) => ({
        name,
        title,
        description,
        inputSchema,
        outputSchema,
        annotations,
      })),
      distillyMcpTools.map(
        ({ name, title, description, inputSchema, outputSchema, annotations }) => ({
          name,
          title,
          description,
          inputSchema,
          outputSchema,
          annotations,
        }),
      ),
    );

    const ingested = output(
      1,
      await first.client.callTool({
        name: "distilly_ingest",
        arguments: {
          wireVersion: "3",
          requestId: requestId(),
          subject: {
            kind: "create",
            input: { displayName: "Mira Chen", aliases: ["Mira"], identityHints: [] },
          },
          materials: [
            {
              clientRef: "package-private-note",
              kind: "document",
              content: "Mira builds reliable local-first systems and explains evidence precisely.",
              source: {
                medium: "document",
                access: "private",
                capturedAt: "2026-09-01T00:00:00.000Z",
              },
              derivation: { kind: "native_text" },
            },
          ],
          enqueue: "now",
        },
      }),
    );
    assert.equal(ingested.ok && ingested.value.kind, "ingested");
    subjectId = ingested.value.subject.id;

    const pending = output(
      2,
      await first.client.callTool({
        name: "distilly_pending",
        arguments: {
          wireVersion: "3",
          requestId: requestId(),
          action: "list",
          subjectId,
        },
      }),
    );
    assert.equal(pending.ok && pending.value.kind, "jobs");
    const job = pending.value.jobs[0];
    assert.ok(job);
    const brief = output(
      2,
      await first.client.callTool({
        name: "distilly_pending",
        arguments: {
          wireVersion: "3",
          requestId: requestId(),
          action: "brief",
          jobId: job.id,
        },
      }),
    );
    assert.equal(brief.ok && brief.value.kind, "briefing");
    const briefing = brief.value.briefing;
    const materialRef = briefing.materials[0]?.ref;
    assert.ok(materialRef);
    const committed = output(
      3,
      await first.client.callTool({
        name: "distilly_commit",
        arguments: {
          wireVersion: "3",
          requestId: requestId(),
          jobId: briefing.job.id,
          generation: briefing.job.generation,
          leaseId: briefing.lease.id,
          briefContractDigest: briefing.contract.digest,
          materialSetHash: briefing.job.materialSetHash,
          patch: {
            operations: [
              {
                op: "add",
                claim: {
                  facet: "identity",
                  text: "Mira builds reliable local-first systems.",
                  evidence: [
                    {
                      kind: "brief_material",
                      materialRef,
                      quote: "Mira builds reliable local-first systems",
                    },
                  ],
                },
              },
            ],
          },
        },
      }),
    );
    assert.equal(committed.ok && committed.value.kind, "current");
    const prompt = output(
      0,
      await first.client.callTool({
        name: "distilly_get",
        arguments: {
          wireVersion: "3",
          requestId: requestId(),
          action: "prompt",
          subject: { kind: "id", subjectId },
        },
      }),
    );
    assert.equal(prompt.ok && prompt.value.kind, "prompt");
    assert.match(prompt.value.prompt, /reliable local-first systems/u);

    const corrected = output(
      4,
      await first.client.callTool({
        name: "distilly_correct",
        arguments: {
          wireVersion: "3",
          requestId: requestId(),
          subjectId,
          text: "Mira prioritizes auditable local-first systems.",
        },
      }),
    );
    assert.equal(corrected.ok && corrected.value.kind, "suspended");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const dialogs = [];
      page.on("dialog", async (dialog) => {
        dialogs.push(dialog.type());
        if (dialog.type() === "confirm") await dialog.accept();
        else if (dialog.type() === "prompt") await dialog.accept("Package E2E promotion.");
        else await dialog.dismiss();
      });
      await page.goto(corrected.value.review.url);
      await page
        .getByRole("heading", { name: corrected.value.candidate.id, exact: true })
        .waitFor();
      await page.getByRole("button", { name: "Promote candidate" }).click();
      await page
        .getByText("This review link is stale.", { exact: true })
        .waitFor({ timeout: 10_000 })
        .catch(async (error) => {
          throw new Error(
            `Panel promotion did not settle (${dialogs.join(",")}): ${await page.locator("body").innerText()}`,
            { cause: error },
          );
        });
      assert.deepEqual(dialogs, ["confirm", "prompt"]);
      await page.close();
    } finally {
      await browser.close();
    }
    const profile = output(
      0,
      await first.client.callTool({
        name: "distilly_get",
        arguments: {
          wireVersion: "3",
          requestId: requestId(),
          action: "profile",
          subject: { kind: "id", subjectId },
        },
      }),
    );
    assert.equal(profile.ok && profile.value.kind, "profile");
    assert.equal(
      profile.value.profile.claims.some(
        ({ text }) => text === "Mira prioritizes auditable local-first systems.",
      ),
      true,
    );
  } finally {
    await close(first);
  }

  const installPerson = run(launcher, ["install", subjectId, "--host", "codex"], {
    cwd: workspace,
    env: environment,
  });
  assert.equal(installPerson.stderr, "");
  assert.match(installPerson.stdout, /Installed subject_/u);
  const skillRoot = join(codexHome, "skills");
  const personDirectories = (await readdir(skillRoot, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && !entry.name.startsWith("."),
  );
  assert.equal(personDirectories.length, 1);
  const personSkillRoot = join(skillRoot, personDirectories[0].name);
  assert.deepEqual((await readdir(personSkillRoot)).sort(compareUtf8), [
    ".distilly-install.json",
    "SKILL.md",
  ]);
  const personSkillPath = join(personSkillRoot, "SKILL.md");
  const personSkill = await readFile(personSkillPath, "utf8");
  assert.match(personSkill, /Mira prioritizes auditable local-first systems/u);
  assert.doesNotMatch(personSkill, /package-private-note/u);

  const promptInput = JSON.parse(
    run(
      codexPath,
      ["-C", workspace, "debug", "prompt-input", "Use the installed Distilly person Profile."],
      { cwd: workspace, env: environment },
    ).stdout,
  );
  assert.equal(JSON.stringify(promptInput).includes(personSkillPath), true);

  const reopened = await connect(launcher, environment, workspace);
  try {
    const profile = output(
      0,
      await reopened.client.callTool({
        name: "distilly_get",
        arguments: {
          wireVersion: "3",
          requestId: requestId(),
          action: "profile",
          subject: { kind: "id", subjectId },
        },
      }),
    );
    assert.equal(profile.ok && profile.value.kind, "profile");
  } finally {
    await close(reopened);
  }

  const storePath = join(home, ".distilly", "store.sqlite3");
  const beforeStore = sha256(await readFile(storePath));
  const beforeSkill = sha256(await readFile(personSkillPath));
  const uninstall = run(launcher, ["uninstall", "--host", "codex"], {
    cwd: workspace,
    env: environment,
  });
  assert.equal(uninstall.stderr, "");
  assert.match(uninstall.stdout, /person data was preserved/u);
  assert.equal(await exists(launcher), false);
  assert.equal(await exists(runtimeRoot), false);
  assert.equal(await exists(installManifestPath), false);
  assert.equal(sha256(await readFile(storePath)), beforeStore);
  assert.equal(sha256(await readFile(personSkillPath)), beforeSkill);

  const afterPlugins = JSON.parse(
    run(codexPath, ["plugin", "list", "--json"], { cwd: workspace, env: environment }).stdout,
  );
  assert.deepEqual(afterPlugins.installed, []);
  const afterMcp = JSON.parse(
    run(codexPath, ["mcp", "list", "--json"], { cwd: workspace, env: environment }).stdout,
  );
  assert.deepEqual(afterMcp, []);
  const afterPrompt = JSON.parse(
    run(
      codexPath,
      ["-C", workspace, "debug", "prompt-input", "Use the installed Distilly person Profile."],
      { cwd: workspace, env: environment },
    ).stdout,
  );
  const afterPromptText = JSON.stringify(afterPrompt);
  assert.equal(afterPromptText.includes(personSkillPath), true);
  assert.doesNotMatch(afterPromptText, /distilly:distilly/u);

  process.stdout.write(
    `${JSON.stringify({ releaseVersion, subjectId, personSkillPath, preserved: true })}\n`,
  );
} finally {
  await rm(testRoot, { recursive: true, force: true });
}
