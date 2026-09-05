import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { distillyMcpTools } from "@distilly/protocol";
import { chromium } from "playwright";

const rootExports = await import("@distilly/cli");
const previewExports = await import("@distilly/cli/preview");
assert.deepEqual(Object.keys(rootExports), []);
assert.deepEqual(Object.keys(previewExports), ["openPreviewMcpApplication"]);

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const fixturePath = fileURLToPath(new URL("./stdio-preview.mjs", import.meta.url));
const panelAssets = fileURLToPath(new URL("../../panel/web/", import.meta.url));
const root = await mkdtemp(join(tmpdir(), "distilly-preview-mcp-built-"));
const initialClaim = "Mira builds reliable local-first systems.";
const promotedClaim = "Mira prioritizes auditable local-first systems.";
const rejectedClaim = "Mira delegates only after defining an auditable boundary.";
let requestCounter = 10;
const requestId = () => `req_${(requestCounter++).toString(16).padStart(32, "0")}`;

const withTimeout = async (label, operation, milliseconds = 10_000) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

const waitUntil = async (predicate) => {
  while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 10));
};

const connect = async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fixturePath],
    cwd: packageRoot,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      DISTILLY_PREVIEW_ROOT: root,
      DISTILLY_PREVIEW_PANEL_ASSETS: panelAssets,
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.setEncoding("utf8");
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const client = new Client({ name: "distilly-preview-built-smoke", version: "0.0.0" });
  await withTimeout("Preview MCP initialize", client.connect(transport));
  return { client, transport, stderr: () => stderr };
};

const output = (toolIndex, result) => {
  const contract = distillyMcpTools[toolIndex];
  assert.ok(contract);
  return contract.output.parse(result.structuredContent);
};

const currentProfile = async (client, subjectId) => {
  const result = output(
    0,
    await client.callTool({
      name: "distilly_get",
      arguments: {
        wireVersion: "3",
        requestId: requestId(),
        action: "profile",
        subject: { kind: "id", subjectId },
      },
    }),
  );
  assert.equal(result.ok && result.value.kind, "profile");
  return result.value.profile;
};

const assertCurrentClaims = async (client, subjectId, { includes, excludes = [] }) => {
  const profile = await currentProfile(client, subjectId);
  const texts = profile.claims.map((claim) => claim.text);
  for (const text of includes) {
    assert.ok(texts.includes(text), `Current Profile does not include: ${text}`);
  }
  for (const text of excludes) {
    assert.equal(texts.includes(text), false, `Current Profile unexpectedly includes: ${text}`);
  }
};

const acceptReviewAction = async (page, buttonName, reason) => {
  const dialogs = [];
  const listener = async (dialog) => {
    dialogs.push(dialog.type());
    if (dialog.type() === "confirm") await dialog.accept();
    else if (dialog.type() === "prompt") await dialog.accept(reason);
    else throw new Error(`Unexpected review dialog type: ${dialog.type()}`);
  };
  page.on("dialog", listener);
  try {
    await page.getByRole("button", { name: buttonName }).click();
    await page.getByText("No active suspended candidates.", { exact: true }).waitFor();
  } finally {
    page.off("dialog", listener);
  }
  assert.deepEqual(dialogs, ["confirm", "prompt"]);
};

const acceptRollback = async (page) => {
  const dialogs = [];
  const listener = async (dialog) => {
    dialogs.push(dialog.type());
    if (dialog.type() === "prompt") await dialog.accept("Restore the initial Profile.");
    else if (dialog.type() === "confirm") await dialog.accept();
    else throw new Error(`Unexpected rollback dialog type: ${dialog.type()}`);
  };
  page.on("dialog", listener);
  try {
    await page.getByRole("button", { name: "Rollback to this version" }).first().click();
    await page
      .getByText("Mira prioritizes auditable local-first systems.", { exact: true })
      .first()
      .waitFor({ state: "detached" });
  } finally {
    page.off("dialog", listener);
  }
  assert.deepEqual(dialogs, ["prompt", "confirm"]);
};

try {
  const first = await connect();
  let subjectId;
  try {
    const listed = await first.client.listTools();
    assert.deepEqual(
      listed.tools.map(({ name }) => name),
      distillyMcpTools.map(({ name }) => name),
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
              clientRef: "built-note",
              kind: "document",
              content: "Mira builds reliable local-first systems and explains evidence precisely.",
              source: {
                medium: "document",
                access: "private",
                capturedAt: "2026-08-31T20:00:00.000Z",
              },
              derivation: { kind: "native_text" },
            },
          ],
          enqueue: "now",
        },
      }),
    );
    assert.equal(ingested.ok, true);
    assert.equal(ingested.value.kind, "ingested");
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

    const profile = output(
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
    assert.equal(profile.ok && profile.value.kind, "prompt");
    assert.match(profile.value.prompt, /reliable local-first systems/u);

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
    const reviewUrl = new URL(corrected.value.review.url);
    const health = await fetch(`${reviewUrl.origin}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      panelVersion: "0.1.0-preview.1",
      status: "ready",
      wireVersion: "3",
    });

    const browser = await chromium.launch({ headless: true });
    try {
      const pageErrors = [];
      const trackPageErrors = (browserPage) => {
        browserPage.on("pageerror", (error) => pageErrors.push(error));
        browserPage.on("console", (message) => {
          if (message.type() === "error") pageErrors.push(new Error(message.text()));
        });
      };
      let page = await browser.newPage();
      trackPageErrors(page);

      await page.goto(corrected.value.review.url);
      await page.getByRole("heading", { name: "Review" }).waitFor();
      await page
        .getByRole("heading", { name: corrected.value.candidate.id, exact: true })
        .waitFor();
      await page.getByText(promotedClaim, { exact: true }).first().waitFor();

      await page.getByRole("link", { name: "Library" }).click();
      await page.getByRole("heading", { name: "Library" }).waitFor();
      await page.getByRole("link", { name: "Mira Chen", exact: true }).click();
      await page.getByRole("heading", { name: "Subject" }).waitFor();
      await page.getByText(initialClaim, { exact: true }).first().waitFor();

      await page.getByRole("link", { name: "Review" }).click();
      await page
        .getByRole("heading", { name: corrected.value.candidate.id, exact: true })
        .waitFor();
      await acceptReviewAction(page, "Promote candidate", "Promote the first correction.");
      await assertCurrentClaims(first.client, subjectId, {
        includes: [initialClaim, promotedClaim],
      });

      const secondCorrection = output(
        4,
        await first.client.callTool({
          name: "distilly_correct",
          arguments: {
            wireVersion: "3",
            requestId: requestId(),
            subjectId,
            text: rejectedClaim,
          },
        }),
      );
      assert.equal(secondCorrection.ok && secondCorrection.value.kind, "suspended");
      await page.close();
      page = await browser.newPage();
      trackPageErrors(page);
      await page.goto(secondCorrection.value.review.url);
      await page.getByRole("heading", { name: "Review" }).waitFor();
      await page
        .getByRole("heading", { name: secondCorrection.value.candidate.id, exact: true })
        .waitFor();
      await page.getByText(rejectedClaim, { exact: true }).first().waitFor();
      await page.getByRole("link", { name: "Review" }).click();
      await acceptReviewAction(page, "Reject candidate", "Reject the second correction.");
      await assertCurrentClaims(first.client, subjectId, {
        includes: [initialClaim, promotedClaim],
        excludes: [rejectedClaim],
      });

      await page.getByRole("link", { name: "Library" }).click();
      await page.getByRole("link", { name: "Mira Chen", exact: true }).click();
      await page.getByRole("heading", { name: "Subject" }).waitFor();
      await acceptRollback(page);
      await assertCurrentClaims(first.client, subjectId, {
        includes: [initialClaim],
        excludes: [promotedClaim, rejectedClaim],
      });

      assert.equal(pageErrors.length, 0, pageErrors.map((error) => error.stack).join("\n"));
    } finally {
      await browser.close();
    }
  } finally {
    await withTimeout("first Preview MCP close", first.client.close(), 5_000);
    await withTimeout(
      "first Preview child exit",
      waitUntil(() => first.transport.pid === null),
      5_000,
    );
    assert.equal(first.stderr(), "");
  }

  const reopened = await connect();
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
    assert.equal(profile.value.subject.id, subjectId);
    const reopenedClaims = profile.value.profile.claims.map((claim) => claim.text);
    assert.ok(reopenedClaims.includes(initialClaim));
    assert.equal(reopenedClaims.includes(promotedClaim), false);
    assert.equal(reopenedClaims.includes(rejectedClaim), false);
  } finally {
    await withTimeout("reopened Preview MCP close", reopened.client.close(), 5_000);
    await withTimeout(
      "reopened Preview child exit",
      waitUntil(() => reopened.transport.pid === null),
      5_000,
    );
    assert.equal(reopened.stderr(), "");
  }
} finally {
  await rm(root, { force: true, recursive: true });
}
