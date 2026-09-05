#!/usr/bin/env node

import { resolvePreviewCliEnvironment, runPreviewCli } from "./main.js";

try {
  process.exitCode = await runPreviewCli(
    process.argv.slice(2),
    await resolvePreviewCliEnvironment(),
    { stdout: process.stdout, stderr: process.stderr },
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Distilly command failed."}\n`);
  process.exitCode = 1;
}
