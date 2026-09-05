import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DistillyError,
  engineMethodSchemas,
  requestIdSchema,
  subjectIdSchema,
} from "@distilly/protocol";
import type { CoreEngineClient, RequestId } from "@distilly/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openPreviewEngine, type PreviewEngineRuntime } from "./preview.js";

const roots: string[] = [];
const runtimes: PreviewEngineRuntime[] = [];
let requestCounter = 1;

const request = (): RequestId =>
  requestIdSchema.parse(`req_${(requestCounter++).toString(16).padStart(32, "0")}`);

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "distilly-preview-engine-"));
  roots.push(root);
  return root;
};

const open = async (root: string): Promise<PreviewEngineRuntime> => {
  const runtime = await openPreviewEngine({ root });
  runtimes.push(runtime);
  return runtime;
};

const close = async (runtime: PreviewEngineRuntime): Promise<void> => {
  await runtime.close();
  const index = runtimes.indexOf(runtime);
  if (index !== -1) runtimes.splice(index, 1);
};

const connect = (runtime: PreviewEngineRuntime): Promise<CoreEngineClient> =>
  runtime.connect({ actor: { kind: "sdk", id: "preview-engine-test" } });

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Developer Preview EngineRuntime", () => {
  it("rejects malformed or empty open options without resolving the process directory", async () => {
    const emptyRoot = await openPreviewEngine({ root: "" }).catch((error: unknown) => error);
    expect(emptyRoot).toMatchObject({
      code: "invalid_input",
      retryable: false,
    });
    expect(Object.hasOwn(emptyRoot as object, "cause")).toBe(false);
    await expect(openPreviewEngine({ root: ".", extra: true } as never)).rejects.toMatchObject({
      code: "invalid_input",
      retryable: false,
    });
  });

  it("atomically reserves one normalized in-process root and permits reopen after close", async () => {
    const root = await temporaryRoot();
    const attempts = await Promise.allSettled([open(root), open(join(root, "."))]);
    const opened = attempts.filter(
      (result): result is PromiseFulfilledResult<PreviewEngineRuntime> =>
        result.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(opened).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      code: "busy",
      retryable: true,
      message: "Another in-process Developer Preview Engine owns this root.",
    });

    await close(opened[0]!.value);
    const reopened = await open(root);
    await expect((await connect(reopened)).call("subjects.list", {})).resolves.toEqual({
      items: [],
    });
  });

  it("releases the synchronous reservation when opening storage fails", async () => {
    const parent = await temporaryRoot();
    const root = join(parent, "root");
    await writeFile(root, "not a directory", "utf8");

    await expect(openPreviewEngine({ root })).rejects.toBeDefined();
    await rm(root);
    await mkdir(root);

    const runtime = await open(root);
    await expect((await connect(runtime)).call("subjects.list", {})).resolves.toEqual({
      items: [],
    });
  });

  it("parses trusted session, params, mutation context, and Preview-disabled methods", async () => {
    const runtime = await open(await temporaryRoot());
    await expect(
      runtime.connect({ actor: { kind: "sdk", id: "valid" }, capacity: {} as never }),
    ).rejects.toMatchObject({ code: "invalid_input", retryable: false });
    await expect(
      runtime.connect({ actor: { kind: "future", id: "invalid" } as never }),
    ).rejects.toMatchObject({ code: "invalid_input", retryable: false });
    await expect(
      runtime.connect({
        actor: { kind: "sdk", id: "cannot-supply-owner" },
        leaseOwner: `lease_owner_${"f".repeat(32)}`,
      } as never),
    ).rejects.toMatchObject({ code: "invalid_input", retryable: false });

    const client = await connect(runtime);
    await expect(client.call("subjects.list", { limit: 0 } as never)).rejects.toMatchObject({
      code: "invalid_input",
      retryable: false,
    });

    const subjectId = subjectIdSchema.parse(`subject_${"a".repeat(32)}`);
    await expect(client.call("subjects.archive", { subjectId }, {} as never)).rejects.toMatchObject(
      { code: "invalid_input", retryable: false },
    );
    const unsupported = client.call("subjects.archive", { subjectId }, { requestId: request() });
    await expect(unsupported).rejects.toMatchObject({
      code: "schema_unsupported",
      retryable: false,
      message: "subjects.archive is not enabled in Distilly 0.1 Developer Preview.",
    });
    await expect(unsupported).rejects.toBeInstanceOf(DistillyError);

    const resultParser = vi
      .spyOn(engineMethodSchemas["subjects.list"].result, "parse")
      .mockImplementationOnce(() => {
        throw new Error("unsafe parser detail");
      });
    const invalidOutput = await client.call("subjects.list", {}).catch((error: unknown) => error);
    expect(invalidOutput).toMatchObject({
      code: "internal_error",
      retryable: false,
      message: "The Developer Preview Engine produced an invalid subjects.list result.",
    });
    expect(Object.hasOwn(invalidOutput as object, "cause")).toBe(false);
    resultParser.mockRestore();

    await client.close();
    await expect(client.call("subjects.list", {})).rejects.toMatchObject({
      code: "busy",
      retryable: false,
    });
    await expect(connect(runtime)).resolves.toBeDefined();
  });
});
