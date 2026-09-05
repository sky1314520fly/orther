import {
  DistillyError,
  WIRE_VERSION,
  decodeEngineEvent,
  engineMethodSchemas,
  isoDateTimeSchema,
  mutationContextSchema,
  wireFailureSchema,
} from "@distilly/protocol";
import type {
  EngineClient,
  EngineEvent,
  EngineMethodMap,
  MutationContext,
  MutationMethodName,
  QueryMethodName,
  Unsubscribe,
} from "@distilly/protocol";

import { PANEL_BODY_BYTES, PANEL_RESPONSE_BYTES, isMutationMethod } from "./transport.js";
import { PanelSseDecoder } from "./web-sse.js";
import type { PanelSseFrame } from "./web-sse.js";
import { fullPanelReread } from "./web-recovery.js";

const ORIGIN_PATTERN = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
const ACTION_NONCE_PATTERN = /^panel_action_[0-9a-f]{64}$/u;
const RECONNECT_BASE_MS = 100;
const RECONNECT_MAXIMUM_MS = 5_000;

/** Browser connection values retained only in memory for one Panel session. */
export interface HttpEngineClientOptions {
  readonly origin: string;
  readonly token: string;
  readonly onFullReread?: () => void;
}

interface WatchSubscription {
  controller?: AbortController;
  stopped: boolean;
}

const waitForReconnect = async (signal: AbortSignal, attempt: number): Promise<void> => {
  const milliseconds = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAXIMUM_MS);
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
};

const requestHeaders = (origin: string, token: string): Readonly<Record<string, string>> => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  Origin: origin,
});

const jsonBody = (value: unknown): string => {
  const body = JSON.stringify(value);
  if (body === undefined || new TextEncoder().encode(body).byteLength > PANEL_BODY_BYTES) {
    throw new DistillyError({
      code: "context_too_large",
      message: "The Panel request exceeds the 4 MiB transport limit.",
      retryable: false,
    });
  }
  return body;
};

const decodeResponseText = async (response: Response): Promise<unknown> => {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > PANEL_RESPONSE_BYTES) {
    throw new DistillyError({
      code: "context_too_large",
      message: "The Panel response exceeds the 16 MiB transport limit.",
      retryable: false,
    });
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DistillyError({
      code: "invalid_input",
      message: "The Panel response was not valid UTF-8.",
      retryable: false,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DistillyError({
      code: "invalid_input",
      message: "The Panel response was not valid JSON.",
      retryable: false,
    });
  }
};

const parseFailure = (value: unknown): DistillyError => {
  const parsed = wireFailureSchema.parse(value) as unknown as {
    readonly error: ConstructorParameters<typeof DistillyError>[0];
  };
  return new DistillyError(parsed.error);
};

const successValue = (value: unknown): unknown => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "ok,value,wireVersion" ||
    !("ok" in value) ||
    value.ok !== true ||
    !("wireVersion" in value) ||
    value.wireVersion !== WIRE_VERSION ||
    !("value" in value)
  ) {
    throw new Error("Panel success response was malformed.");
  }
  return value.value;
};

/** Browser-only EngineClient that uses authenticated loopback fetch and streaming SSE. */
export class HttpEngineClient implements EngineClient {
  readonly #origin: string;
  readonly #token: string;
  readonly #onFullReread: (() => void) | undefined;
  readonly #subscriptions = new Set<WatchSubscription>();
  #closed = false;

  /**
   * Creates a browser client without persisting its in-memory fragment token.
   *
   * @param options - Exact loopback origin, bearer token, and optional reread callback.
   */
  constructor(options: HttpEngineClientOptions) {
    const match = ORIGIN_PATTERN.exec(options.origin);
    if (match === null || Number(match[1]) > 65_535 || Number(match[1]) === 80) {
      throw new Error("Panel origin must be an exact IPv4 loopback origin with an explicit port.");
    }
    if (!TOKEN_PATTERN.test(options.token)) {
      throw new Error("Panel token must be exactly 64 lowercase hexadecimal characters.");
    }
    this.#origin = options.origin;
    this.#token = options.token;
    this.#onFullReread = options.onFullReread;
  }

  /**
   * Calls one read-only engine method over authenticated RPC.
   *
   * @param method - Query method name.
   * @param params - Parameters correlated with that method.
   * @returns The validated engine result.
   */
  call<M extends QueryMethodName>(
    method: M,
    params: EngineMethodMap[M]["params"],
  ): Promise<EngineMethodMap[M]["result"]>;
  /**
   * Calls one mutation after acquiring a single-use action nonce.
   *
   * @param method - Mutation method name.
   * @param params - Parameters correlated with that method.
   * @param context - Stable request id used for engine idempotency.
   * @returns The validated engine result.
   */
  call<M extends MutationMethodName>(
    method: M,
    params: EngineMethodMap[M]["params"],
    context: MutationContext,
  ): Promise<EngineMethodMap[M]["result"]>;
  /**
   * Dispatches one runtime-correlated query or mutation envelope.
   *
   * @param method - Engine method name.
   * @param params - Parameters correlated with that method.
   * @param context - Required only for mutation methods.
   * @returns The validated engine result.
   */
  async call<M extends keyof EngineMethodMap>(
    method: M,
    params: EngineMethodMap[M]["params"],
    context?: MutationContext,
  ): Promise<EngineMethodMap[M]["result"]> {
    if (this.#closed) throw new Error("HttpEngineClient is closed.");
    const parsedParams = engineMethodSchemas[method].params.parse(params);
    let request: Readonly<Record<string, unknown>>;
    if (isMutationMethod(method)) {
      if (context === undefined) throw new Error("Mutation calls require a MutationContext.");
      const parsedContext = mutationContextSchema.parse(context);
      const nonceValue = await this.#post("/action-nonces", {
        wireVersion: WIRE_VERSION,
        method,
        params: parsedParams,
        requestId: parsedContext.requestId,
      });
      const nonceRecord =
        typeof nonceValue === "object" &&
        nonceValue !== null &&
        !Array.isArray(nonceValue) &&
        Object.keys(nonceValue).sort().join(",") === "actionNonce,expiresAt" &&
        "actionNonce" in nonceValue
          ? nonceValue
          : undefined;
      if (
        nonceRecord === undefined ||
        typeof nonceRecord.actionNonce !== "string" ||
        !ACTION_NONCE_PATTERN.test(nonceRecord.actionNonce) ||
        !("expiresAt" in nonceRecord)
      ) {
        throw new Error("Panel action nonce response was malformed.");
      }
      isoDateTimeSchema.parse(nonceRecord.expiresAt);
      request = {
        wireVersion: WIRE_VERSION,
        method,
        params: parsedParams,
        requestId: parsedContext.requestId,
        actionNonce: nonceRecord.actionNonce,
      };
    } else {
      if (context !== undefined) throw new Error("Query calls must not carry a MutationContext.");
      request = { wireVersion: WIRE_VERSION, method, params: parsedParams };
    }

    const value = await this.#post("/rpc", request);
    return engineMethodSchemas[method].result.parse(value);
  }

  async #post(path: string, value: unknown): Promise<unknown> {
    const response = await fetch(`${this.#origin}${path}`, {
      method: "POST",
      headers: requestHeaders(this.#origin, this.#token),
      body: jsonBody(value),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    const envelope = await decodeResponseText(response);
    if (
      typeof envelope === "object" &&
      envelope !== null &&
      "ok" in envelope &&
      envelope.ok === false
    ) {
      throw parseFailure(envelope);
    }
    if (!response.ok) throw new Error(`Panel HTTP request failed with status ${response.status}.`);
    return successValue(envelope);
  }

  async #fullReread(): Promise<void> {
    await fullPanelReread(this);
    this.#onFullReread?.();
  }

  async #handleFrame(
    frame: PanelSseFrame,
    handler: (event: EngineEvent) => void,
    onReady: () => void,
  ): Promise<void> {
    if (frame.event === "ready") {
      const value = JSON.parse(frame.data) as unknown;
      if (
        typeof value !== "object" ||
        value === null ||
        Object.keys(value).length !== 1 ||
        !("wireVersion" in value) ||
        value.wireVersion !== WIRE_VERSION
      ) {
        throw new Error("Panel SSE ready frame was malformed.");
      }
      onReady();
      return;
    }
    if (frame.event !== "engine") {
      await this.#fullReread();
      return;
    }
    const value = JSON.parse(frame.data) as unknown;
    let needsReread = false;
    decodeEngineEvent(value, {
      onEvent: handler,
      onFullReread: () => {
        needsReread = true;
      },
    });
    if (needsReread) await this.#fullReread();
  }

  /**
   * Opens one authenticated POST SSE stream; unsubscribe aborts only that stream.
   *
   * @param handler - Callback for each validated known engine event.
   * @returns An idempotent abort function for this stream.
   */
  async watch(handler: (event: EngineEvent) => void): Promise<Unsubscribe> {
    if (this.#closed) throw new Error("HttpEngineClient is closed.");
    const subscription: WatchSubscription = { stopped: false };
    this.#subscriptions.add(subscription);
    let initiallyReady = false;
    let resolveReady: (() => void) | undefined;
    let rejectReady: ((error: unknown) => void) | undefined;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    let recoveryPending = false;
    let reconnectAttempt = 0;

    const run = async (): Promise<void> => {
      try {
        while (!this.#closed && !subscription.stopped) {
          const controller = new AbortController();
          subscription.controller = controller;
          let connectionReady = false;
          try {
            const response = await fetch(`${this.#origin}/events`, {
              method: "POST",
              headers: requestHeaders(this.#origin, this.#token),
              body: jsonBody({ wireVersion: WIRE_VERSION }),
              cache: "no-store",
              credentials: "omit",
              redirect: "error",
              referrerPolicy: "no-referrer",
              signal: controller.signal,
            });
            if (!response.ok || response.body === null) {
              const envelope = await decodeResponseText(response);
              throw parseFailure(envelope);
            }
            if (response.headers.get("content-type") !== "text/event-stream; charset=utf-8") {
              await response.body.cancel();
              throw new Error("Panel SSE response Content-Type was malformed.");
            }

            const decoder = new PanelSseDecoder();
            const reader = response.body.getReader();
            const handleFrames = async (frames: readonly PanelSseFrame[]): Promise<void> => {
              for (const frame of frames) {
                let frameReady = false;
                await this.#handleFrame(frame, handler, () => {
                  frameReady = true;
                  connectionReady = true;
                  if (!initiallyReady) {
                    initiallyReady = true;
                    resolveReady?.();
                  }
                });
                if (frame.event === "engine") reconnectAttempt = 0;
                if (frameReady && recoveryPending) {
                  recoveryPending = false;
                  await this.#fullReread();
                }
              }
            };
            try {
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                await handleFrames(decoder.push(chunk.value));
              }
              await handleFrames(decoder.finish());
            } finally {
              reader.releaseLock();
            }
            if (!connectionReady) {
              throw new Error("Panel SSE stream ended before its ready frame.");
            }
            throw new Error("Panel SSE stream disconnected.");
          } catch (error) {
            if (this.#closed || subscription.stopped || controller.signal.aborted) break;
            if (!initiallyReady) {
              subscription.stopped = true;
              rejectReady?.(error);
              break;
            }
            recoveryPending = true;
            await waitForReconnect(controller.signal, reconnectAttempt);
            reconnectAttempt = Math.min(reconnectAttempt + 1, 16);
          } finally {
            if (subscription.controller === controller) delete subscription.controller;
          }
        }
      } finally {
        this.#subscriptions.delete(subscription);
        if (!initiallyReady) {
          rejectReady?.(new Error("Panel SSE watch ended before its ready frame."));
        }
      }
    };
    void run();

    try {
      await readyPromise;
    } catch (error) {
      subscription.stopped = true;
      subscription.controller?.abort();
      this.#subscriptions.delete(subscription);
      throw error;
    }

    return () => {
      if (subscription.stopped) return;
      subscription.stopped = true;
      this.#subscriptions.delete(subscription);
      subscription.controller?.abort();
    };
  }

  /** Aborts this browser client's streams without closing the server-side EngineClient. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const subscription of this.#subscriptions) {
      subscription.stopped = true;
      subscription.controller?.abort();
    }
    this.#subscriptions.clear();
    await Promise.resolve();
  }
}
