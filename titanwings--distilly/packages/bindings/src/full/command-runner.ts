import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { HostCommandRunner } from "../protocol.js";

const OUTPUT_LIMIT = 1_048_576;

// Host lifecycle commands do not need the caller's credential-bearing
// environment. Keep the inherited set deliberately small when a compatibility
// binding supplies an explicit environment. In particular, do not forward
// NODE_OPTIONS, provider API keys, cloud credentials, SSH variables, or the
// shell's complete environment to a host executable.
const SAFE_INHERITED_ENVIRONMENT_KEYS = [
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_DIRS",
  "XDG_DATA_DIRS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SYSTEMROOT",
  "WINDIR",
  "PATHEXT",
] as const;

const safeInheritedEnvironment = (): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const key of SAFE_INHERITED_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
};

const append = (chunks: Buffer[], chunk: Buffer): void => {
  const used = chunks.reduce((total, value) => total + value.length, 0);
  if (used >= OUTPUT_LIMIT) return;
  chunks.push(chunk.subarray(0, OUTPUT_LIMIT - used));
};

/**
 * Runs one host command without a shell.
 *
 * @param input - Checked executable, arguments, and isolated home.
 * @param input.executablePath - Absolute checked host executable.
 * @param input.args - Exact host lifecycle arguments.
 * @param input.homeDirectory - Isolated user home for the child process.
 * @param input.environment - Non-secret host-owned environment overrides.
 * @param input.input - Optional bounded confirmation input.
 * @returns Process exit status and bounded output.
 */
const run: HostCommandRunner["run"] = async ({
  executablePath,
  args,
  homeDirectory,
  environment,
  input,
}) => {
  // Existing Codex callers omit `environment`; compatibility bindings always
  // provide their own host environment.  Only create the Codex state
  // directory for the former, so OpenClaw/Hermes setup cannot leave an
  // unrelated `.codex` directory in an isolated home.
  const codexHome = environment === undefined ? join(homeDirectory, ".codex") : undefined;
  if (codexHome !== undefined) await mkdir(codexHome, { recursive: true });
  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn(executablePath, [...args], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        // Omitting `environment` preserves the historical Codex command
        // contract (Codex may resolve its own credentials). Compatibility
        // hosts always pass an explicit environment and receive only the
        // allowlisted, non-secret base above.
        ...(environment === undefined ? process.env : safeInheritedEnvironment()),
        HOME: homeDirectory,
        USERPROFILE: homeDirectory,
        ...(codexHome === undefined ? {} : { CODEX_HOME: codexHome }),
        ...environment,
      },
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input, "utf8");
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
};

export const defaultHostCommandRunner: HostCommandRunner = Object.freeze({ run });
