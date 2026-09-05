import { McpServer as SdkMcpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/server";
import { DistillyError, WIRE_VERSION, distillyMcpTools } from "@distilly/protocol";
import type {
  CommitResult,
  CommitToolInput,
  CommitToolOutput,
  CorrectToolInput,
  CorrectToolOutput,
  CorrectToolValue,
  DistillyWireError,
  EngineClient,
  GetToolInput,
  GetToolOutput,
  IngestToolInput,
  IngestToolOutput,
  McpToolContract,
  PendingToolInput,
  PendingToolOutput,
  ResolveSubjectResult,
  ReviewLaunch,
  ReviewRef,
  WireFailure,
  WireSuccess,
} from "@distilly/protocol";
import packageJson from "../package.json" with { type: "json" };

import { registerSdkServer } from "./internal.js";
import { projectAdvertisedSchema } from "./internal-schema.js";
import type { McpServer, McpServerOptions, ReviewPresenter } from "./types.js";

const SERVER_INFO = { name: "distilly", version: packageJson.version } as const;
const SERVER_CLOSE_DRAIN_TIMEOUT_MS = 5_000;
const [getContract, ingestContract, pendingContract, commitContract, correctContract] =
  distillyMcpTools;

const boundaryPassthroughValidator: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input: unknown): ReturnType<JsonSchemaValidator<T>> => ({
      valid: true as const,
      data: input as T,
      errorMessage: undefined,
    });
  },
};

const success = <T>(value: T): WireSuccess<T> => ({
  ok: true,
  wireVersion: WIRE_VERSION,
  value,
});

const failure = (error: DistillyWireError): WireFailure => ({
  ok: false,
  wireVersion: WIRE_VERSION,
  error,
});

const invalidToolInput = (): WireFailure =>
  failure({
    code: "invalid_input",
    message: "The Distilly tool input is invalid.",
    retryable: false,
    fieldPath: "input",
  });

const internalFailure = (): WireFailure =>
  failure({
    code: "internal_error",
    message: "The Distilly MCP adapter encountered an unexpected internal error.",
    retryable: false,
  });

const wireError = (error: DistillyError): DistillyWireError => {
  const common = {
    message: error.message,
    retryable: error.retryable,
    ...(error.fieldPath === undefined ? {} : { fieldPath: error.fieldPath }),
    ...(error.remediation === undefined ? {} : { remediation: error.remediation }),
    ...(error.details === undefined ? {} : { details: error.details }),
  };
  if (error.code === "already_exists") {
    if (error.subjectResolution?.kind !== "found") {
      throw new TypeError("already_exists requires a found subject resolution.");
    }
    return { ...common, code: error.code, subjectResolution: error.subjectResolution };
  }
  if (error.code === "ambiguous_subject") {
    if (error.subjectResolution?.kind !== "ambiguous") {
      throw new TypeError("ambiguous_subject requires ambiguous subject candidates.");
    }
    return { ...common, code: error.code, subjectResolution: error.subjectResolution };
  }
  if (error.code === "internal_error") return internalFailure().error;
  return { ...common, code: error.code };
};

const safeFailure = (error: unknown): WireFailure => {
  if (!(error instanceof DistillyError)) return internalFailure();
  try {
    return failure(wireError(error));
  } catch {
    return internalFailure();
  }
};

const queryFromResolveInput = (input: GetToolInput): string | undefined =>
  input.subject.kind === "query" ? input.subject.query : undefined;

const unresolvedGetValue = (
  input: GetToolInput,
  resolution: Exclude<ResolveSubjectResult, { readonly kind: "found" }>,
): GetToolOutput => {
  if (resolution.kind === "ambiguous") {
    return success({ kind: "ambiguous", candidates: resolution.candidates });
  }
  const query = queryFromResolveInput(input);
  return success({ kind: "not_found", ...(query === undefined ? {} : { query }) });
};

const handleGet = async (client: EngineClient, input: GetToolInput): Promise<GetToolOutput> => {
  const resolution = await client.call("subjects.resolve", { selector: input.subject });
  if (resolution.kind !== "found") return unresolvedGetValue(input, resolution);
  if (input.action === "resolve") {
    return success({ kind: "resolved", subject: resolution.subject });
  }

  const subjectId = resolution.subject.id;
  if (input.action === "profile") {
    const profile = await client.call("profiles.get", {
      subjectId,
      ...(input.versionId === undefined ? {} : { versionId: input.versionId }),
    });
    return success({ kind: "profile", subject: resolution.subject, profile });
  }
  if (input.action === "prompt") {
    const prompt = await client.call("profiles.prompt", {
      subjectId,
      ...(input.versionId === undefined ? {} : { versionId: input.versionId }),
    });
    return success({ kind: "prompt", subject: resolution.subject, prompt });
  }
  const status = await client.call("profiles.status", { subjectId });
  return success({ kind: "status", subject: resolution.subject, status });
};

const handleIngest = async (
  client: EngineClient,
  input: IngestToolInput,
): Promise<IngestToolOutput> =>
  success(
    await client.call(
      "materials.ingest",
      { subject: input.subject, materials: input.materials, enqueue: input.enqueue },
      { requestId: input.requestId },
    ),
  );

const handlePending = async (
  client: EngineClient,
  input: PendingToolInput,
): Promise<PendingToolOutput> => {
  if (input.action === "list") {
    const jobs = await client.call("distill.pending", {
      ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
    });
    return jobs.length === 0
      ? success({ kind: "nothing_pending" })
      : success({ kind: "jobs", jobs: [jobs[0]!, ...jobs.slice(1)] });
  }
  if (input.action === "brief") {
    try {
      const briefing = await client.call(
        "distill.brief",
        { jobId: input.jobId },
        { requestId: input.requestId },
      );
      return success({ kind: "briefing", briefing });
    } catch (error) {
      if (error instanceof DistillyError && error.code === "nothing_pending") {
        return success({ kind: "nothing_pending" });
      }
      throw error;
    }
  }
  if (input.action === "renew") {
    const lease = await client.call(
      "distill.renew",
      { jobId: input.jobId, leaseId: input.leaseId },
      { requestId: input.requestId },
    );
    return success({ kind: "lease_renewed", lease });
  }
  await client.call(
    "distill.release",
    {
      jobId: input.jobId,
      leaseId: input.leaseId,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    },
    { requestId: input.requestId },
  );
  return success({ kind: "released", jobId: input.jobId });
};

const sameReviewRef = (left: ReviewRef, right: ReviewRef): boolean =>
  left.subjectId === right.subjectId && left.candidateVersionId === right.candidateVersionId;

const presentReview = async (
  presenter: ReviewPresenter,
  review: ReviewRef,
): Promise<ReviewLaunch> => {
  const launch = await presenter.present(review);
  if (!sameReviewRef(review, launch.ref)) {
    throw new TypeError("ReviewPresenter returned a launch for a different candidate.");
  }
  return launch;
};

const suspendedCommitValue = async (
  presenter: ReviewPresenter,
  result: Extract<CommitResult, { readonly kind: "suspended" }>,
): Promise<CorrectToolValue> => ({
  kind: "suspended",
  candidate: result.candidate,
  ...(result.currentVersionId === undefined ? {} : { currentVersionId: result.currentVersionId }),
  reasons: result.reasons,
  review: await presentReview(presenter, result.review),
});

const handleCommit = async (
  client: EngineClient,
  presenter: ReviewPresenter,
  input: CommitToolInput,
): Promise<CommitToolOutput> => {
  const result = await client.call(
    "distill.commit",
    {
      jobId: input.jobId,
      generation: input.generation,
      leaseId: input.leaseId,
      briefContractDigest: input.briefContractDigest,
      materialSetHash: input.materialSetHash,
      ...(input.baseVersionId === undefined ? {} : { baseVersionId: input.baseVersionId }),
      patch: input.patch,
    },
    { requestId: input.requestId },
  );
  return result.kind === "current"
    ? success({ kind: "current", version: result.version, profile: result.profile })
    : success(await suspendedCommitValue(presenter, result));
};

const handleCorrect = async (
  client: EngineClient,
  presenter: ReviewPresenter,
  input: CorrectToolInput,
): Promise<CorrectToolOutput> => {
  const result = await client.call(
    "profiles.correct",
    {
      subjectId: input.subjectId,
      correction: {
        text: input.text,
        ...(input.facet === undefined ? {} : { facet: input.facet }),
        ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
        ...(input.baseCandidateVersionId === undefined
          ? {}
          : { baseCandidateVersionId: input.baseCandidateVersionId }),
      },
    },
    { requestId: input.requestId },
  );
  if (result.kind !== "suspended") {
    throw new TypeError("profiles.correct must return a suspended candidate.");
  }
  return success(await suspendedCommitValue(presenter, result));
};

const execute = async <Input, Output extends { readonly ok: boolean }>(
  contract: McpToolContract<string, Input, Output>,
  rawInput: unknown,
  handler: (input: Input) => Promise<Output>,
): Promise<CallToolResult> => {
  let output: Output | WireFailure;
  let input: Input;
  try {
    input = contract.input.parse(rawInput);
  } catch {
    return encodeOutput(contract, invalidToolInput());
  }

  try {
    output = await handler(input);
  } catch (error) {
    output = safeFailure(error);
  }

  return encodeOutput(contract, output);
};

const encodeOutput = <Output extends { readonly ok: boolean }>(
  contract: McpToolContract<string, unknown, Output>,
  output: Output | WireFailure,
): CallToolResult => {
  let parsed: Output;
  try {
    parsed = contract.output.parse(output);
  } catch {
    parsed = contract.output.parse(internalFailure());
  }
  return {
    content: [{ type: "text", text: JSON.stringify(parsed) }],
    structuredContent: parsed,
  };
};

const registerTool = <Input, Output extends { readonly ok: boolean }>(
  server: SdkMcpServer,
  lifecycle: DistillyMcpServer,
  contract: McpToolContract<string, Input, Output>,
  handler: (input: Input) => Promise<Output>,
  schemaProfile: McpServerOptions["schemaProfile"],
): void => {
  server.registerTool(
    contract.name,
    {
      title: contract.title,
      description: contract.description,
      // Protocol owns runtime input validation so invalid tool calls return the
      // same typed WireFailure as every other Distilly transport boundary.
      inputSchema: fromJsonSchema<Input>(
        projectAdvertisedSchema(contract.inputSchema, schemaProfile) as typeof contract.inputSchema,
        boundaryPassthroughValidator,
      ),
      outputSchema: fromJsonSchema<Output>(
        projectAdvertisedSchema(
          contract.outputSchema,
          schemaProfile,
        ) as typeof contract.outputSchema,
      ),
      annotations: contract.annotations,
    },
    async (input) =>
      lifecycle.runTool(
        () => execute(contract, input, handler),
        () => encodeOutput(contract, internalFailure()),
      ),
  );
};

class DistillyMcpServer implements McpServer {
  readonly #server: SdkMcpServer;
  readonly #closingPromise: Promise<void>;
  readonly #resolveClosing: () => void;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #inFlight = 0;
  #resolveDrain: (() => void) | undefined;

  constructor(server: SdkMcpServer) {
    this.#server = server;
    let resolveClosing = (): void => undefined;
    this.#closingPromise = new Promise<void>((resolve) => {
      resolveClosing = resolve;
    });
    this.#resolveClosing = resolveClosing;
  }

  /**
   * Exposes the package-internal transport-owner shutdown signal.
   *
   * @returns Completion as soon as close starts.
   * @internal
   */
  get closingPromise(): Promise<void> {
    return this.#closingPromise;
  }

  /**
   * Runs a tool only while the server accepts calls and tracks its drain.
   *
   * @param task - Tool call admitted before shutdown.
   * @param whenClosed - Typed result for a call arriving during shutdown.
   * @returns The tool result after its handler or shutdown projection finishes.
   * @internal
   */
  async runTool(
    task: () => Promise<CallToolResult>,
    whenClosed: () => CallToolResult,
  ): Promise<CallToolResult> {
    if (this.#closing) return whenClosed();
    this.#inFlight += 1;
    try {
      return await task();
    } finally {
      this.#inFlight -= 1;
      if (this.#inFlight === 0) this.#resolveDrain?.();
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#closeOwnedServer();
    return this.#closePromise;
  }

  async #closeOwnedServer(): Promise<void> {
    this.#closing = true;
    this.#resolveClosing();
    let drained = true;
    if (this.#inFlight > 0) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (completed: boolean): void => {
          if (settled) return;
          settled = true;
          drained = completed;
          clearTimeout(timeout);
          this.#resolveDrain = undefined;
          resolve();
        };
        const timeout = setTimeout(() => finish(false), SERVER_CLOSE_DRAIN_TIMEOUT_MS);
        this.#resolveDrain = () => finish(true);
      });
    }
    await this.#server.close();
    if (!drained) {
      throw new Error(`Distilly MCP server shutdown exceeded ${SERVER_CLOSE_DRAIN_TIMEOUT_MS}ms.`);
    }
  }
}

/**
 * Creates the exact five-tool MCP presenter over an already-bound client session.
 *
 * @param options - Injected client and local review presenter.
 * @returns A transport-neutral MCP server handle.
 */
export const createMcpServer = (options: McpServerOptions): McpServer => {
  const server = new SdkMcpServer(SERVER_INFO);
  const handle = new DistillyMcpServer(server);
  registerTool(
    server,
    handle,
    getContract,
    (input) => handleGet(options.client, input),
    options.schemaProfile,
  );
  registerTool(
    server,
    handle,
    ingestContract,
    (input) => handleIngest(options.client, input),
    options.schemaProfile,
  );
  registerTool(
    server,
    handle,
    pendingContract,
    (input) => handlePending(options.client, input),
    options.schemaProfile,
  );
  registerTool(
    server,
    handle,
    commitContract,
    (input) => handleCommit(options.client, options.reviewPresenter, input),
    options.schemaProfile,
  );
  registerTool(
    server,
    handle,
    correctContract,
    (input) => handleCorrect(options.client, options.reviewPresenter, input),
    options.schemaProfile,
  );

  registerSdkServer(handle, server, handle.closingPromise);
  return handle;
};
