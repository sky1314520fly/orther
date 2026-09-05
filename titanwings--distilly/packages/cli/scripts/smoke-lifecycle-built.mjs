import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { distillyMcpTools } from "@distilly/protocol";

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cliEntry = join(packageRoot, "lib", "bin.js");
const root = await mkdtemp(join(tmpdir(), "distilly-cli-lifecycle-built-"));
const home = join(root, "home");
const hostBin = join(root, "host-bin");
const launcher = join(home, ".distilly", "bin", "distilly");
const environment = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  PATH: `${hostBin}${delimiter}${process.env.PATH ?? ""}`,
  NODE_NO_WARNINGS: "1",
};

const executable = async (name, version) => {
  const path = join(hostBin, name);
  await writeFile(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  printf '%s\\n' '${version}'\nfi\nexit 0\n`,
    { mode: 0o755 },
  );
  await chmod(path, 0o755);
};

const run = (...args) => {
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: packageRoot,
    env: environment,
    encoding: "utf8",
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${args.join(" ")} failed:\n${result.stderr}`);
  assert.equal(result.stderr, "");
  return result.stdout;
};

const exists = async (path) =>
  access(path).then(
    () => true,
    () => false,
  );

try {
  await mkdir(home);
  await mkdir(hostBin);
  await executable("codex", "codex-cli 0.146.0");
  await executable("claude", "2.1.221 (Claude Code)");
  await executable("openclaw", "OpenClaw 2026.3.25 (unrecorded)");
  await executable("hermes", "Hermes Agent v0.9.1 (unrecorded)");

  assert.match(run("setup", "--host", "codex"), /Restart the host/u);
  const doctor = JSON.parse(run("doctor"));
  assert.equal(doctor.ok, true);
  assert.deepEqual(
    doctor.hosts.map(({ host }) => host),
    ["codex"],
  );
  const unavailable = spawnSync(process.execPath, [cliEntry, "create"], {
    cwd: packageRoot,
    env: environment,
    encoding: "utf8",
  });
  assert.equal(unavailable.status, 2);
  assert.equal(unavailable.stdout, "");
  assert.match(unavailable.stderr, /unavailable Developer Preview command/u);
  for (const [host, ownedPath] of [
    ["claude-code", [".claude", "skills", "distilly"]],
    ["openclaw", [".openclaw", "extensions", "distilly"]],
    ["hermes", [".hermes", "skills", "distilly"]],
  ]) {
    const deferred = spawnSync(process.execPath, [cliEntry, "setup", "--host", host], {
      cwd: packageRoot,
      env: environment,
      encoding: "utf8",
    });
    assert.equal(deferred.status, 1);
    assert.equal(deferred.stdout, "");
    assert.match(deferred.stderr, /verified Distilly briefing capacity/u);
    assert.equal(await exists(join(home, ...ownedPath)), false);
  }

  const unsupported = spawnSync(process.execPath, [cliEntry, "setup", "--host", "other-host"], {
    cwd: packageRoot,
    env: environment,
    encoding: "utf8",
  });
  assert.equal(unsupported.status, 1);
  assert.equal(unsupported.stdout, "");
  assert.match(unsupported.stderr, /Legacy Skill compatibility guide/u);

  const codexMcp = JSON.parse(
    await readFile(join(home, "plugins", "distilly", ".mcp.json"), "utf8"),
  );
  assert.deepEqual(codexMcp.mcpServers.distilly, {
    command: launcher,
    args: ["mcp", "--host", "codex"],
  });
  const transport = new StdioClientTransport({
    command: launcher,
    args: ["mcp", "--host", "codex"],
    cwd: packageRoot,
    env: environment,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.setEncoding("utf8");
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const client = new Client({ name: "distilly-cli-lifecycle-smoke", version: "0.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map(({ name }) => name),
      distillyMcpTools.map(({ name }) => name),
    );
  } finally {
    await client.close();
  }
  assert.equal(stderr, "");

  const personData = join(home, ".distilly", "people", "keep.txt");
  await mkdir(dirname(personData), { recursive: true });
  await writeFile(personData, "keep me\n");
  assert.match(run("uninstall", "--host", "codex"), /person data was preserved/u);
  assert.equal(await exists(launcher), false);
  assert.equal(await exists(join(home, ".distilly", "install.json")), false);
  assert.equal(await readFile(personData, "utf8"), "keep me\n");
  assert.equal(await exists(join(home, ".distilly", "store.sqlite3")), true);
} finally {
  await rm(root, { recursive: true, force: true });
}
