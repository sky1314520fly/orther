import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import packageJson from "#package-manifest" with { type: "json" };
import {
  DistillyError,
  WIRE_VERSION,
  decodeEngineEvent,
  distillyWireErrorSchema,
  engineEventSchema,
  engineMethodSchemas,
  isoDateTimeSchema,
  requestIdSchema,
  wireFailureSchema,
} from "@distilly/protocol";
import type {
  DistillyWireError,
  EngineClient,
  EngineEvent,
  EngineMethodMap,
  MutationContext,
  MutationMethodName,
  RequestId,
  Unsubscribe,
  WireFailure,
} from "@distilly/protocol";

import { loadPanelAssets } from "./server-assets.js";
import {
  PANEL_ACTION_NONCE_TTL_MS,
  PANEL_BODY_BYTES,
  PANEL_HEADER_BYTES,
  PANEL_RESPONSE_BYTES,
  PANEL_SSE_EVENT_BYTES,
  isMutationMethod,
} from "./transport.js";

export const PANEL_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'";

const TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
const ACTION_NONCE_PATTERN = /^panel_action_[0-9a-f]{64}$/u;

type Clock = () => number;

/** Dependencies and fixed listener coordinates for a Panel server. */
export interface PanelServerOptions {
  readonly client: EngineClient;
  readonly assetsDir: string;
  readonly port: number;
}

interface PanelServerSeams {
  readonly tokenFactory?: () => string;
  readonly actionNonceFactory?: () => string;
  readonly clock?: Clock;
  readonly listen?: (server: Server, port: number) => Promise<number>;
  readonly highWaterMark?: number;
}

/** Running loopback Panel transport. It borrows the injected EngineClient. */
export interface PanelHandle {
  readonly url: string;

  /** Stops HTTP and SSE resources owned by this handle. */
  close(): Promise<void>;
}

interface ParsedQuery {
  readonly kind: "query";
  readonly method: keyof EngineMethodMap;
  readonly params: EngineMethodMap[keyof EngineMethodMap]["params"];
}

interface ParsedMutation {
  readonly kind: "mutation";
  readonly method: MutationMethodName;
  readonly params: EngineMethodMap[MutationMethodName]["params"];
  readonly requestId: RequestId;
  readonly actionNonce: string;
}

type ParsedRpc = ParsedQuery | ParsedMutation;

interface ParsedNonceRequest {
  readonly method: MutationMethodName;
  readonly params: EngineMethodMap[MutationMethodName]["params"];
  readonly requestId: RequestId;
}

interface NonceRecord {
  readonly binding: Buffer;
  readonly expiresAt: number;
}

class PanelRequestError extends Error {
  readonly wireError: DistillyWireError;
  readonly status: number;

  constructor(wireError: DistillyWireError, status = 400) {
    super(wireError.message);
    this.name = "PanelRequestError";
    this.wireError = wireError;
    this.status = status;
  }
}

interface DynamicEngineClient {
  call(
    method: keyof EngineMethodMap,
    params: EngineMethodMap[keyof EngineMethodMap]["params"],
    context?: MutationContext,
  ): Promise<unknown>;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
};

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};

const methodName = (value: unknown): keyof EngineMethodMap | undefined => {
  if (typeof value !== "string" || !Object.hasOwn(engineMethodSchemas, value)) return undefined;
  return value as keyof EngineMethodMap;
};

const invalidInput = (message: string, fieldPath?: string): DistillyWireError => ({
  code: "invalid_input",
  message,
  retryable: false,
  ...(fieldPath === undefined ? {} : { fieldPath }),
});

const internalFailure = (): DistillyWireError => ({
  code: "internal_error",
  message: "The Panel request failed internally.",
  retryable: false,
});

const contextTooLarge = (): DistillyWireError => ({
  code: "context_too_large",
  message: "The Panel response exceeds the 16 MiB transport limit.",
  retryable: false,
  remediation: "Request a smaller page or narrower view.",
});

const bodyTooLarge = (): DistillyWireError => ({
  code: "invalid_input",
  message: "The Panel request exceeds the 4 MiB transport limit.",
  retryable: false,
  details: { size: PANEL_BODY_BYTES + 1, limit: PANEL_BODY_BYTES },
});

const failure = (error: DistillyWireError): WireFailure =>
  wireFailureSchema.parse({
    ok: false,
    wireVersion: WIRE_VERSION,
    error,
  }) as unknown as WireFailure;

const errorFromDistilly = (error: DistillyError): DistillyWireError =>
  distillyWireErrorSchema.parse({
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.fieldPath === undefined ? {} : { fieldPath: error.fieldPath }),
    ...(error.remediation === undefined ? {} : { remediation: error.remediation }),
    ...(error.details === undefined ? {} : { details: error.details }),
    ...(error.subjectResolution === undefined
      ? {}
      : { subjectResolution: error.subjectResolution }),
  }) as unknown as DistillyWireError;

const commonHeaders = (): Readonly<Record<string, string>> => ({
  "Cache-Control": "no-store",
  "Content-Security-Policy": PANEL_CSP,
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

const sendBytes = (
  response: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  headers: Readonly<Record<string, string>> = {},
): void => {
  response.writeHead(status, {
    ...commonHeaders(),
    ...headers,
    "Content-Length": String(body.byteLength),
    "Content-Type": contentType,
  });
  response.end(body);
};

const jsonBytes = (value: unknown): Buffer => {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("Panel response is not JSON serializable.");
  return Buffer.from(text, "utf8");
};

const sendJson = (
  response: ServerResponse,
  status: number,
  value: unknown,
  responseOverflowStatus = 413,
  headers: Readonly<Record<string, string>> = {},
): void => {
  let body: Buffer;
  try {
    body = jsonBytes(value);
  } catch {
    body = jsonBytes(failure(internalFailure()));
    status = 500;
  }
  if (body.byteLength > PANEL_RESPONSE_BYTES) {
    body = jsonBytes(failure(contextTooLarge()));
    status = responseOverflowStatus;
  }
  sendBytes(response, status, "application/json; charset=utf-8", body, headers);
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const declared = request.headers["content-length"];
  if (declared !== undefined) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new PanelRequestError(invalidInput("Content-Length must be a non-negative integer."));
    }
    if (length > PANEL_BODY_BYTES) throw new PanelRequestError(bodyTooLarge(), 413);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > PANEL_BODY_BYTES) throw new PanelRequestError(bodyTooLarge(), 413);
    chunks.push(Uint8Array.from(bytes));
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
  } catch {
    throw new PanelRequestError(invalidInput("Request body must be valid UTF-8."));
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PanelRequestError(invalidInput("Request body must be valid JSON."));
  }
};

const parseRpc = (value: unknown): ParsedRpc => {
  const record = asRecord(value);
  if (record === undefined || record.wireVersion !== WIRE_VERSION) {
    throw new PanelRequestError(
      invalidInput('RPC body must be an exact wireVersion "3" object.', "wireVersion"),
    );
  }
  const method = methodName(record.method);
  if (method === undefined) {
    throw new PanelRequestError(invalidInput("Unknown engine method.", "method"));
  }

  if (isMutationMethod(method)) {
    if (!hasExactKeys(record, ["wireVersion", "method", "params", "requestId", "actionNonce"])) {
      throw new PanelRequestError(
        invalidInput("Mutation RPC fields do not match the exact envelope."),
      );
    }
    let requestId: RequestId;
    try {
      requestId = requestIdSchema.parse(record.requestId);
    } catch {
      throw new PanelRequestError(invalidInput("requestId has an invalid shape.", "requestId"));
    }
    if (typeof record.actionNonce !== "string" || !ACTION_NONCE_PATTERN.test(record.actionNonce)) {
      throw new PanelRequestError(invalidInput("actionNonce has an invalid shape.", "actionNonce"));
    }
    const params = engineMethodSchemas[method].params.parse(record.params);
    return { kind: "mutation", method, params, requestId, actionNonce: record.actionNonce };
  }

  if (!hasExactKeys(record, ["wireVersion", "method", "params"])) {
    throw new PanelRequestError(invalidInput("Query RPC fields do not match the exact envelope."));
  }
  const params = engineMethodSchemas[method].params.parse(record.params);
  return { kind: "query", method, params };
};

const parseNonceRequest = (value: unknown): ParsedNonceRequest => {
  const record = asRecord(value);
  if (
    record === undefined ||
    !hasExactKeys(record, ["wireVersion", "method", "params", "requestId"]) ||
    record.wireVersion !== WIRE_VERSION
  ) {
    throw new PanelRequestError(
      invalidInput("Action nonce body does not match the exact envelope."),
    );
  }
  const method = methodName(record.method);
  if (method === undefined || !isMutationMethod(method)) {
    throw new PanelRequestError(
      invalidInput("Action nonces are available only for mutation methods.", "method"),
    );
  }
  return {
    method,
    params: engineMethodSchemas[method].params.parse(record.params),
    requestId: requestIdSchema.parse(record.requestId),
  };
};

const parseEventsRequest = (value: unknown): void => {
  const record = asRecord(value);
  if (
    record === undefined ||
    !hasExactKeys(record, ["wireVersion"]) ||
    record.wireVersion !== WIRE_VERSION
  ) {
    throw new PanelRequestError(invalidInput('Events body must be exactly {"wireVersion":"3"}.'));
  }
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Canonical JSON does not support non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = asRecord(value);
  if (record === undefined) throw new Error("Canonical JSON value is not JSON-safe.");
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
};

const nonceBinding = (
  token: string,
  method: MutationMethodName,
  requestId: RequestId,
  params: unknown,
): Buffer =>
  createHash("sha256")
    .update("panel-action-binding-v1\0", "utf8")
    .update(token, "utf8")
    .update("\0", "utf8")
    .update(method, "utf8")
    .update("\0", "utf8")
    .update(requestId, "utf8")
    .update("\0", "utf8")
    .update(
      createHash("sha256")
        .update("panel-action-params-v1\0", "utf8")
        .update(canonicalJson(params), "utf8")
        .digest(),
    )
    .digest();

const equalToken = (expected: string, value: string | undefined): boolean => {
  if (value === undefined || !value.startsWith("Bearer ")) return false;
  const actual = value.slice("Bearer ".length);
  if (!TOKEN_PATTERN.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
};

const rawHeaderValues = (request: IncomingMessage, name: string): readonly string[] => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) {
      const value = request.rawHeaders[index + 1];
      if (value !== undefined) values.push(value);
    }
  }
  return values;
};

const hasExactHost = (request: IncomingMessage, hostHeader: string): boolean => {
  const values = rawHeaderValues(request, "host");
  return values.length === 1 && values[0] === hostHeader;
};

const hasAllowedStaticOrigin = (request: IncomingMessage, origin: string): boolean => {
  const values = rawHeaderValues(request, "origin");
  return values.length === 0 || (values.length === 1 && values[0] === origin);
};

const hasJsonContentType = (request: IncomingMessage): boolean => {
  const values = rawHeaderValues(request, "content-type");
  return (
    values.length === 1 &&
    (values[0] === "application/json" || values[0] === "application/json; charset=utf-8")
  );
};

const validateSecurity = (
  request: IncomingMessage,
  origin: string,
  hostHeader: string,
  token: string,
): "host_or_origin" | "authorization" | undefined => {
  if (!hasExactHost(request, hostHeader)) return "host_or_origin";
  const origins = rawHeaderValues(request, "origin");
  if (origins.length !== 1 || origins[0] !== origin) return "host_or_origin";
  const authorizations = rawHeaderValues(request, "authorization");
  if (authorizations.length !== 1 || !equalToken(token, authorizations[0])) {
    return "authorization";
  }
  return undefined;
};

const listen = async (server: Server, port: number): Promise<number> =>
  await new Promise<number>((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Panel server did not receive a TCP address."));
        return;
      }
      resolvePromise(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });

const sseFrame = (event: string, value: unknown): Buffer =>
  Buffer.from(`event: ${event}\ndata:${canonicalJson(value)}\n\n`, "utf8");

const closeServer = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      if (error === undefined) resolvePromise();
      else reject(error);
    });
  });
};

/**
 * Starts an authenticated loopback HTTP/SSE Panel with package-private test seams.
 *
 * @param options - Borrowed client, verified asset directory, and fixed listener address.
 * @param seams - Deterministic randomness and time used only by package tests.
 * @returns A handle for the successfully listening server.
 */
export const startPanelServerWithSeams = async (
  options: PanelServerOptions,
  seams: PanelServerSeams,
): Promise<PanelHandle> => {
  if (
    !Number.isSafeInteger(options.port) ||
    options.port < 1 ||
    options.port > 65_535 ||
    options.port === 80
  ) {
    throw new Error("Panel port must be an integer from 1 through 65535 other than 80.");
  }
  const assets = await loadPanelAssets(options.assetsDir);
  const token = seams.tokenFactory?.() ?? randomBytes(32).toString("hex");
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error("Panel token must be exactly 64 lowercase hexadecimal characters.");
  }
  const clock = seams.clock ?? Date.now;
  const dynamicClient = options.client as unknown as DynamicEngineClient;
  const nonces = new Map<string, NonceRecord>();
  const sessions = new Set<() => void>();
  let origin = "";
  let hostHeader = "";
  const healthBody = Buffer.from(
    `${JSON.stringify({
      panelVersion: packageJson.version,
      status: "ready",
      wireVersion: WIRE_VERSION,
    })}\n`,
    "utf8",
  );

  const server = createServer(
    {
      // Node rejects when its tracked count reaches maxHeaderSize, so +1 keeps
      // the contract's exact 16 KiB boundary legal and rejects its first byte over.
      maxHeaderSize: PANEL_HEADER_BYTES + 1,
      // The application maps a missing Host to the contract's generic HTTP 403.
      requireHostHeader: false,
      ...(seams.highWaterMark === undefined ? {} : { highWaterMark: seams.highWaterMark }),
    },
    (request, response) => {
      const run = async (): Promise<void> => {
        const target = request.url;
        if (target === undefined) {
          sendJson(response, 400, failure(invalidInput("Request target is required.")));
          return;
        }

        const asset = assets.get(target);
        const allowedMethod =
          asset !== undefined || target === "/health"
            ? "GET"
            : ["/rpc", "/events", "/action-nonces"].includes(target)
              ? "POST"
              : undefined;
        if (allowedMethod === undefined) {
          sendJson(response, 404, failure(invalidInput("Unknown Panel route.")));
          return;
        }
        if (request.method !== allowedMethod) {
          sendJson(
            response,
            405,
            failure(invalidInput("Panel route rejected this HTTP method.")),
            413,
            { Allow: allowedMethod },
          );
          return;
        }

        if (asset !== undefined) {
          if (!hasExactHost(request, hostHeader) || !hasAllowedStaticOrigin(request, origin)) {
            sendJson(response, 403, failure(invalidInput("Panel request rejected.")));
            return;
          }
          sendBytes(response, 200, asset.contentType, asset.body);
          return;
        }

        if (target === "/health") {
          if (!hasExactHost(request, hostHeader) || !hasAllowedStaticOrigin(request, origin)) {
            sendJson(response, 403, failure(invalidInput("Panel request rejected.")));
            return;
          }
          sendBytes(response, 200, "application/json; charset=utf-8", healthBody);
          return;
        }

        const securityFailure = validateSecurity(request, origin, hostHeader, token);
        if (securityFailure !== undefined) {
          sendJson(
            response,
            securityFailure === "authorization" ? 401 : 403,
            failure(invalidInput("Panel request rejected.")),
          );
          return;
        }
        if (!hasJsonContentType(request)) {
          sendJson(response, 415, failure(invalidInput("Panel Content-Type was rejected.")));
          return;
        }

        let body: unknown;
        try {
          body = await readBody(request);
        } catch (error) {
          const wireError =
            error instanceof PanelRequestError
              ? error.wireError
              : invalidInput("Panel request body was rejected.");
          sendJson(
            response,
            error instanceof PanelRequestError ? error.status : 400,
            failure(wireError),
          );
          return;
        }

        if (target === "/action-nonces") {
          let parsed: ParsedNonceRequest;
          try {
            parsed = parseNonceRequest(body);
          } catch {
            sendJson(response, 400, failure(invalidInput("Action nonce request was rejected.")));
            return;
          }
          const now = clock();
          if (!Number.isFinite(now)) {
            sendJson(response, 500, failure(internalFailure()));
            return;
          }
          for (const [storedNonce, record] of nonces) {
            if (now >= record.expiresAt) nonces.delete(storedNonce);
          }
          const actionNonce =
            seams.actionNonceFactory?.() ?? `panel_action_${randomBytes(32).toString("hex")}`;
          if (!ACTION_NONCE_PATTERN.test(actionNonce) || nonces.has(actionNonce)) {
            sendJson(response, 500, failure(internalFailure()));
            return;
          }
          let expiresAt: string;
          try {
            expiresAt = isoDateTimeSchema.parse(
              new Date(now + PANEL_ACTION_NONCE_TTL_MS).toISOString(),
            );
          } catch {
            sendJson(response, 500, failure(internalFailure()));
            return;
          }
          nonces.set(actionNonce, {
            binding: nonceBinding(token, parsed.method, parsed.requestId, parsed.params),
            expiresAt: now + PANEL_ACTION_NONCE_TTL_MS,
          });
          sendJson(response, 200, {
            ok: true,
            wireVersion: WIRE_VERSION,
            value: { actionNonce, expiresAt },
          });
          return;
        }

        if (target === "/events") {
          try {
            parseEventsRequest(body);
          } catch {
            sendJson(response, 400, failure(invalidInput("Events request was rejected.")));
            return;
          }

          let unsubscribe: Unsubscribe | undefined;
          let closed = false;
          let active = false;
          let pendingBytes = 0;
          const pendingFrames: Buffer[] = [];
          let backpressured = false;
          let queuedBytes = 0;
          const queuedFrames: Buffer[] = [];
          function cleanup(): void {
            if (closed) return;
            closed = true;
            sessions.delete(cleanup);
            response.off("drain", flushQueuedFrames);
            pendingFrames.length = 0;
            queuedFrames.length = 0;
            pendingBytes = 0;
            queuedBytes = 0;
            try {
              unsubscribe?.();
            } catch {
              // The subscription is already detached from the response.
            }
            if (!response.writableEnded) response.end();
          }
          function flushQueuedFrames(): void {
            if (closed) return;
            backpressured = false;
            while (queuedFrames.length > 0) {
              const frame = queuedFrames.shift();
              if (frame === undefined) break;
              queuedBytes -= frame.byteLength;
              if (!response.write(frame)) {
                backpressured = true;
                return;
              }
            }
          }
          function writeActiveFrame(frame: Buffer): void {
            if (closed) return;
            if (backpressured) {
              if (queuedBytes + frame.byteLength > PANEL_SSE_EVENT_BYTES) {
                cleanup();
                return;
              }
              queuedFrames.push(frame);
              queuedBytes += frame.byteLength;
              return;
            }
            if (!response.write(frame)) backpressured = true;
          }
          sessions.add(cleanup);
          response.once("close", cleanup);
          response.on("drain", flushQueuedFrames);

          try {
            unsubscribe = await options.client.watch((untrustedEvent: EngineEvent) => {
              if (closed) return;
              let event: EngineEvent | undefined;
              try {
                decodeEngineEvent(untrustedEvent, {
                  onEvent: (parsed) => {
                    event = parsed;
                  },
                  onFullReread: () => {
                    cleanup();
                  },
                });
                if (event === undefined) return;
                const parsed = engineEventSchema.parse(event);
                const frame = sseFrame("engine", parsed);
                if (frame.byteLength > PANEL_SSE_EVENT_BYTES) {
                  cleanup();
                  return;
                }
                if (!active) {
                  pendingBytes += frame.byteLength;
                  if (pendingBytes > PANEL_SSE_EVENT_BYTES) cleanup();
                  else pendingFrames.push(frame);
                  return;
                }
                writeActiveFrame(frame);
              } catch {
                cleanup();
              }
            });
          } catch {
            closed = true;
            sessions.delete(cleanup);
            response.off("drain", flushQueuedFrames);
            pendingFrames.length = 0;
            queuedFrames.length = 0;
            pendingBytes = 0;
            queuedBytes = 0;
            if (!response.headersSent && !response.writableEnded) {
              sendJson(response, 500, failure(internalFailure()));
            }
            return;
          }
          if (closed) {
            unsubscribe();
            return;
          }
          response.writeHead(200, {
            ...commonHeaders(),
            Connection: "keep-alive",
            "Content-Type": "text/event-stream; charset=utf-8",
            "X-Accel-Buffering": "no",
          });
          response.flushHeaders();
          const ready = sseFrame("ready", { wireVersion: WIRE_VERSION });
          active = true;
          writeActiveFrame(ready);
          for (const frame of pendingFrames) {
            writeActiveFrame(frame);
            if (closed) return;
          }
          pendingFrames.length = 0;
          pendingBytes = 0;
          return;
        }

        let rpc: ParsedRpc;
        try {
          rpc = parseRpc(body);
        } catch (error) {
          sendJson(
            response,
            error instanceof PanelRequestError ? 400 : 200,
            failure(invalidInput("RPC request was rejected.")),
          );
          return;
        }

        if (rpc.kind === "mutation") {
          const record = nonces.get(rpc.actionNonce);
          const now = clock();
          const expected = nonceBinding(token, rpc.method, rpc.requestId, rpc.params);
          if (
            record === undefined ||
            !Number.isFinite(now) ||
            now >= record.expiresAt ||
            record.binding.byteLength !== expected.byteLength ||
            !timingSafeEqual(record.binding, expected)
          ) {
            sendJson(response, 400, failure(invalidInput("Panel action nonce rejected.")));
            return;
          }
          nonces.delete(rpc.actionNonce);
        }

        try {
          const value =
            rpc.kind === "mutation"
              ? await dynamicClient.call(rpc.method, rpc.params, { requestId: rpc.requestId })
              : await dynamicClient.call(rpc.method, rpc.params);
          const parsedResult = engineMethodSchemas[rpc.method].result.parse(value);
          const success = {
            ok: true,
            wireVersion: WIRE_VERSION,
            value: parsedResult,
          } as const;
          sendJson(response, 200, success, 200);
        } catch (error) {
          if (error instanceof DistillyError) {
            sendJson(response, 200, failure(errorFromDistilly(error)));
          } else {
            sendJson(response, 200, failure(internalFailure()));
          }
        }
      };

      void run().catch(() => {
        if (!response.headersSent) sendJson(response, 500, failure(internalFailure()));
        else response.destroy();
      });
    },
  );
  server.requestTimeout = 0;
  server.on("clientError", (error, socket) => {
    if ((error as NodeJS.ErrnoException).code !== "HPE_HEADER_OVERFLOW") {
      socket.destroy();
      return;
    }
    if (!socket.writable) return;
    const body = jsonBytes(
      failure(invalidInput("Panel request headers exceed the 16 KiB transport limit.")),
    );
    socket.end(
      [
        "HTTP/1.1 431 Request Header Fields Too Large",
        ...Object.entries(commonHeaders()).map(([name, value]) => `${name}: ${value}`),
        "Connection: close",
        `Content-Length: ${body.byteLength}`,
        "Content-Type: application/json; charset=utf-8",
        "",
        body.toString("utf8"),
      ].join("\r\n"),
    );
  });

  let actualPort: number;
  try {
    actualPort = await (seams.listen ?? listen)(server, options.port);
  } catch (error) {
    await closeServer(server).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new DistillyError({
        code: "busy",
        message: `Panel port ${options.port} is already in use.`,
        retryable: true,
      });
    }
    throw error;
  }
  origin = `http://127.0.0.1:${actualPort}`;
  hostHeader = `127.0.0.1:${actualPort}`;

  let closePromise: Promise<void> | undefined;
  return {
    url: `${origin}/#${token}`,
    close: () => {
      closePromise ??= (async () => {
        nonces.clear();
        for (const closeSession of [...sessions]) closeSession();
        const closing = closeServer(server);
        server.closeAllConnections();
        await closing;
      })();
      return closePromise;
    },
  };
};

/**
 * Starts the production Panel server with cryptographic randomness and wall-clock expiry.
 *
 * @param options - Borrowed client, verified asset directory, and fixed listener address.
 * @returns A handle for the successfully listening server.
 */
export const startPanelServer = async (options: PanelServerOptions): Promise<PanelHandle> =>
  await startPanelServerWithSeams(options, {});
