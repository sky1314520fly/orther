import { chmod, mkdir, writeFile } from "@oh-my-opencode/memory-core/fs"
import { join } from "node:path"

import { loadFactsPersona, serializeFactsPayload } from "@oh-my-opencode/memory-core"

import type { FactsSpawnArgs, PrepareFactsSpawnInput } from "./spawn-types"
import { resolveSenpiLaunch } from "./senpi-command"

export async function prepareFactsSpawn(input: PrepareFactsSpawnInput): Promise<FactsSpawnArgs> {
  await mkdir(input.runDir, { recursive: true, mode: 0o700 })
  const payload = join(input.runDir, "facts-payload.json")
  const extraction = join(input.runDir, "extraction.jsonl")
  try {
    await (input.chmodFile ?? chmod)(payload, 0o600)
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
  }
  // ONE serializer, shared with the byte cap's measurement: a second stringify here would let
  // the written bytes drift past the cap the selection proved.
  await writeFile(payload, serializeFactsPayload(input.payload), { encoding: "utf8", mode: 0o600 })
  await chmod(payload, 0o400)
  const env: NodeJS.ProcessEnv = {
    ...input.env,
    FACTS_PAYLOAD_PATH: payload,
    FACTS_EXTRACTION_PATH: extraction,
    SENPI_MEMORY_FACTS: "1",
    SENPI_PTY_FORCE_PIPE: "1",
  }
  const args = [
    "-p",
    "--system-prompt", loadFactsPersona(),
    "--tools", "read,write",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--session-dir", input.runDir,
    "--model", input.model,
    ...(input.thinking === undefined ? [] : ["--thinking", input.thinking]),
    `Read ${payload} and write only ${extraction} according to the system prompt.`,
  ]
  const launch = input.senpiCommand === undefined
    ? resolveSenpiLaunch(input.env)
    : { command: input.senpiCommand, prefixArgs: input.senpiPrefixArgs ?? [] }
  return {
    runId: input.runId,
    attempt: input.attempt ?? 1,
    hardDeadlineAt: input.hardDeadlineAt ?? Date.now() + 15 * 60_000,
    model: input.model,
    ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
    ...(input.nextAttempt === undefined ? {} : { nextAttempt: input.nextAttempt }),
    command: launch.command,
    args: [...launch.prefixArgs, ...args],
    cwd: input.runDir,
    env,
    detached: true,
    paths: { runDir: input.runDir, payload, extraction },
  }
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}
