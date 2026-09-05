import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WIRE_VERSION,
  isoDateTimeSchema,
  requestIdSchema,
  subjectIdSchema,
} from "@distilly/protocol";
import type {
  EngineClient,
  EngineEvent,
  EngineMethodMap,
  MutationContext,
} from "@distilly/protocol";

import { startPanelServerWithSeams } from "./server-http.js";
import type { PanelHandle } from "./server-http.js";
import { HttpEngineClient } from "./web-client.js";

const TOKEN = "a".repeat(64);
const SUBJECT_ID = subjectIdSchema.parse(`subject_${"b".repeat(32)}`);
const REQUEST_ID = requestIdSchema.parse(`req_${"c".repeat(32)}`);

const doctorSnapshot = {
  runtime: { productVersion: "0.0.0", wireVersion: WIRE_VERSION, promptVersion: "test" },
  storage: {
    rootLabel: "local test root",
    writable: true,
    schemaSupported: true,
    projectionsDirty: false,
    pendingBlobGcCount: 0,
  },
  panel: { loopbackOnly: true, authentication: "enabled" },
  extensions: [],
} as const;

const listenEphemeral = async (server: Server): Promise<number> =>
  await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("Missing address."));
      else resolve(address.port);
    });
  });

const closeServer = async (server: Server): Promise<void> =>
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

const readRequestBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) {
    chunks.push(Uint8Array.from(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
};

const sendJson = (response: ServerResponse, value: unknown): void => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
};

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for web-client condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("HttpEngineClient", () => {
  const panelHandles: PanelHandle[] = [];
  const rawServers: Server[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(panelHandles.splice(0).map(async (handle) => await handle.close()));
    await Promise.all(rawServers.splice(0).map(async (server) => await closeServer(server)));
    await Promise.all(
      directories.splice(0).map(async (directory) => await rm(directory, { recursive: true })),
    );
  });

  it("performs real authenticated query, nonce-backed mutation, and event fetches", async () => {
    const assetsDir = await mkdtemp(join(await realpath(tmpdir()), "distilly-web-client-"));
    directories.push(assetsDir);
    await Promise.all([
      writeFile(join(assetsDir, "index.html"), "<!doctype html>"),
      writeFile(join(assetsDir, "app.js"), "export {};\n"),
      writeFile(join(assetsDir, "app.css"), "body {}\n"),
    ]);
    const calls: { method: keyof EngineMethodMap; context?: MutationContext }[] = [];
    const watchers = new Set<(event: EngineEvent) => void>();
    const borrowedClose = vi.fn(() => Promise.resolve());
    const dynamic = {
      call(
        method: keyof EngineMethodMap,
        _params: unknown,
        context?: MutationContext,
      ): Promise<unknown> {
        calls.push({ method, ...(context === undefined ? {} : { context }) });
        if (method === "library.list") return Promise.resolve({ items: [] });
        if (method === "subjects.archive") return Promise.resolve(null);
        return Promise.reject(new Error(`Unexpected method ${method}`));
      },
      watch(handler: (event: EngineEvent) => void): Promise<() => void> {
        watchers.add(handler);
        return Promise.resolve(() => watchers.delete(handler));
      },
      close: borrowedClose,
    };
    const panel = await startPanelServerWithSeams(
      { client: dynamic as EngineClient, assetsDir, port: 1 },
      { tokenFactory: () => TOKEN, listen: listenEphemeral },
    );
    panelHandles.push(panel);
    const origin = panel.url.slice(0, panel.url.indexOf("/#"));
    const client = new HttpEngineClient({ origin, token: TOKEN });

    await expect(client.call("library.list", {})).resolves.toEqual({ items: [] });
    await expect(
      client.call("subjects.archive", { subjectId: SUBJECT_ID }, { requestId: REQUEST_ID }),
    ).resolves.toBeNull();
    expect(calls).toEqual([
      { method: "library.list" },
      { method: "subjects.archive", context: { requestId: REQUEST_ID } },
    ]);

    const onEvent = vi.fn();
    const unsubscribe = await client.watch(onEvent);
    for (const watcher of watchers) {
      watcher({
        kind: "material.ingested",
        subjectId: SUBJECT_ID,
        at: isoDateTimeSchema.parse("2026-08-21T02:03:04.000Z"),
      });
    }
    await waitUntil(() => onEvent.mock.calls.length === 1);
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({ kind: "material.ingested" });
    unsubscribe();
    await client.close();
    expect(borrowedClose).not.toHaveBeenCalled();
  });

  it("turns an unknown event into complete paged rereads without calling the handler", async () => {
    let libraryReads = 0;
    let reviewReads = 0;
    let doctorReads = 0;
    const raw = createServer((request, response) => {
      const run = async (): Promise<void> => {
        expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
        const address = raw.address();
        if (address === null || typeof address === "string") throw new Error("Missing address.");
        expect(request.headers.origin).toBe(`http://127.0.0.1:${address.port}`);
        const body = await readRequestBody(request);
        if (request.url === "/rpc") {
          const method = (body as { readonly method?: string }).method;
          if (method === "library.list") libraryReads += 1;
          else if (method === "reviews.list") reviewReads += 1;
          else if (method === "system.doctor") doctorReads += 1;
          else throw new Error(`Unexpected reread method: ${String(method)}`);
          const pageReads = method === "library.list" ? libraryReads : reviewReads;
          sendJson(response, {
            ok: true,
            wireVersion: WIRE_VERSION,
            value:
              method === "system.doctor"
                ? doctorSnapshot
                : pageReads === 1
                  ? { items: [], nextCursor: `${method}-next` }
                  : { items: [] },
          });
          return;
        }
        if (request.url === "/events") {
          expect(body).toEqual({ wireVersion: WIRE_VERSION });
          response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
          response.write('event: ready\ndata:{"wireVersion":"3"}\n\n');
          response.write(
            `event: engine\ndata:${JSON.stringify({
              kind: "future.event",
              subjectId: SUBJECT_ID,
              at: "2026-08-21T02:03:04.000Z",
            })}\n\n`,
          );
          return;
        }
        response.writeHead(404).end();
      };
      void run().catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error("raw test server failed"));
      });
    });
    rawServers.push(raw);
    const port = await listenEphemeral(raw);
    const onFullReread = vi.fn();
    const client = new HttpEngineClient({
      origin: `http://127.0.0.1:${port}`,
      token: TOKEN,
      onFullReread,
    });
    const onEvent = vi.fn();
    await client.watch(onEvent);
    await waitUntil(
      () =>
        libraryReads === 2 &&
        reviewReads === 2 &&
        doctorReads === 1 &&
        onFullReread.mock.calls.length === 1,
    );
    expect(onEvent).not.toHaveBeenCalled();
    await client.close();
  });

  it.each(["eof", "parse error"] as const)(
    "reconnects after an unexpected stream %s and rereads exactly once",
    async (failureMode) => {
      let eventConnections = 0;
      const reads = { library: 0, review: 0, doctor: 0 };
      const raw = createServer((request, response) => {
        const run = async (): Promise<void> => {
          const body = await readRequestBody(request);
          if (request.url === "/rpc") {
            const method = (body as { readonly method?: string }).method;
            if (method === "library.list") reads.library += 1;
            else if (method === "reviews.list") reads.review += 1;
            else if (method === "system.doctor") reads.doctor += 1;
            else throw new Error(`Unexpected recovery method: ${String(method)}`);
            sendJson(response, {
              ok: true,
              wireVersion: WIRE_VERSION,
              value: method === "system.doctor" ? doctorSnapshot : { items: [] },
            });
            return;
          }
          if (request.url === "/events") {
            expect(body).toEqual({ wireVersion: WIRE_VERSION });
            eventConnections += 1;
            response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
            response.write('event: ready\ndata:{"wireVersion":"3"}\n\n');
            if (eventConnections === 1) {
              if (failureMode === "parse error") {
                response.end("event: engine\ndata:{broken\n\n");
              } else {
                response.end();
              }
            }
            return;
          }
          response.writeHead(404).end();
        };
        void run().catch((error: unknown) => {
          response.destroy(
            error instanceof Error ? error : new Error("raw recovery server failed"),
          );
        });
      });
      rawServers.push(raw);
      const port = await listenEphemeral(raw);
      const onFullReread = vi.fn();
      const client = new HttpEngineClient({
        origin: `http://127.0.0.1:${port}`,
        token: TOKEN,
        onFullReread,
      });

      const unsubscribe = await client.watch(vi.fn());
      await waitUntil(() => eventConnections === 2 && onFullReread.mock.calls.length === 1);
      expect(reads).toEqual({ library: 1, review: 1, doctor: 1 });
      unsubscribe();
      await client.close();
      expect(onFullReread).toHaveBeenCalledTimes(1);
    },
  );

  it("does not reread when unsubscribe or client close intentionally aborts a stream", async () => {
    const responses = new Set<ServerResponse>();
    const raw = createServer((request, response) => {
      const run = async (): Promise<void> => {
        await readRequestBody(request);
        if (request.url !== "/events") throw new Error(`Unexpected request: ${request.url}`);
        responses.add(response);
        response.once("close", () => responses.delete(response));
        response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        response.write('event: ready\ndata:{"wireVersion":"3"}\n\n');
      };
      void run().catch((error: unknown) => response.destroy(error as Error));
    });
    rawServers.push(raw);
    const port = await listenEphemeral(raw);
    const onFullReread = vi.fn();
    const client = new HttpEngineClient({
      origin: `http://127.0.0.1:${port}`,
      token: TOKEN,
      onFullReread,
    });

    const unsubscribe = await client.watch(vi.fn());
    unsubscribe();
    await waitUntil(() => responses.size === 0);
    const secondUnsubscribe = await client.watch(vi.fn());
    await client.close();
    secondUnsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onFullReread).not.toHaveBeenCalled();
  });

  it("rejects a pending watch when close aborts the stream before ready", async () => {
    let attempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        attempts += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted.", "AbortError")),
            { once: true },
          );
        });
      }),
    );
    const client = new HttpEngineClient({
      origin: "http://127.0.0.1:43111",
      token: TOKEN,
    });

    const watching = client.watch(vi.fn());
    await waitUntil(() => attempts === 1);
    await client.close();
    await expect(watching).rejects.toThrow("ended before its ready frame");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(attempts).toBe(1);
  });

  it.each(["unsubscribe", "close"] as const)(
    "backs off persistent reconnect failures and lets %s interrupt the delay",
    async (stopKind) => {
      const ready = new TextEncoder().encode('event: ready\ndata:{"wireVersion":"3"}\n\n');
      let attempts = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          attempts += 1;
          if (attempts !== 1) return Promise.reject(new Error("Panel server is unavailable."));
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(ready);
                  controller.close();
                },
              }),
              { headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
            ),
          );
        }),
      );
      const client = new HttpEngineClient({
        origin: "http://127.0.0.1:43111",
        token: TOKEN,
      });

      const unsubscribe = await client.watch(vi.fn());
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(attempts).toBeLessThanOrEqual(3);
      if (stopKind === "unsubscribe") unsubscribe();
      else await client.close();
      const attemptsAtStop = attempts;
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(attempts).toBe(attemptsAtStop);
      unsubscribe();
      await client.close();
    },
  );

  it("rejects non-exact origins/tokens and calls after close", async () => {
    for (const origin of [
      "https://127.0.0.1:43111",
      "http://localhost:43111",
      "http://127.0.0.1",
      "http://127.0.0.1:80",
      "http://127.0.0.1:70000",
      "http://127.0.0.1:43111/path",
    ]) {
      expect(() => new HttpEngineClient({ origin, token: TOKEN })).toThrow("exact IPv4 loopback");
    }
    expect(
      () => new HttpEngineClient({ origin: "http://127.0.0.1:43111", token: "A".repeat(64) }),
    ).toThrow("lowercase hexadecimal");

    const client = new HttpEngineClient({ origin: "http://127.0.0.1:43111", token: TOKEN });
    await Promise.all([client.close(), client.close()]);
    await expect(client.call("library.list", {})).rejects.toThrow("closed");
    await expect(client.watch(vi.fn())).rejects.toThrow("closed");
  });
});
