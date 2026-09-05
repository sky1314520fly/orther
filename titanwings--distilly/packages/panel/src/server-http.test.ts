import { createServer as createNetServer, Socket } from "node:net";
import type { Server as NetServer } from "node:net";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DistillyError,
  WIRE_VERSION,
  engineMethodSchemas,
  isoDateTimeSchema,
  requestIdSchema,
  subjectIdSchema,
  versionIdSchema,
} from "@distilly/protocol";
import type {
  EngineClient,
  EngineEvent,
  EngineMethodMap,
  MutationContext,
} from "@distilly/protocol";

import { PANEL_CSP, startPanelServer, startPanelServerWithSeams } from "./server-http.js";
import type { PanelHandle, PanelServerOptions } from "./server-http.js";
import { isMutationMethod, panelMutationMethods } from "./transport.js";
import { PANEL_RPC_FIXTURES } from "./testing/rpc-contract-fixtures.js";
import { PanelSseDecoder } from "./web-sse.js";

const TOKEN = "a".repeat(64);
const SUBJECT_ID = subjectIdSchema.parse(`subject_${"b".repeat(32)}`);
const VERSION_ID = versionIdSchema.parse(`version_${"c".repeat(64)}`);
const REQUEST_ID = requestIdSchema.parse(`req_${"d".repeat(32)}`);
const OTHER_REQUEST_ID = requestIdSchema.parse(`req_${"e".repeat(32)}`);
const AT = isoDateTimeSchema.parse("2026-08-21T01:02:03.000Z");

interface RecordedCall {
  readonly method: keyof EngineMethodMap;
  readonly params: unknown;
  readonly context?: MutationContext;
}

interface FakeClient {
  readonly client: EngineClient;
  readonly calls: RecordedCall[];
  readonly close: ReturnType<typeof vi.fn>;
  readonly emit: (event: EngineEvent) => void;
  readonly watched: () => number;
  readonly unsubscribed: () => number;
}

type FakeImplementation = (params: unknown, context?: MutationContext) => unknown;

const isFakeImplementation = (value: unknown): value is FakeImplementation =>
  typeof value === "function";

const fakeClient = (
  overrides: Partial<Record<keyof EngineMethodMap, unknown>> = {},
  eventsOnWatch: readonly EngineEvent[] = [],
): FakeClient => {
  const calls: RecordedCall[] = [];
  const watchers = new Set<(event: EngineEvent) => void>();
  let watchCount = 0;
  let unsubscribeCount = 0;
  const close = vi.fn(() => Promise.resolve());
  const dynamic = {
    call(
      method: keyof EngineMethodMap,
      params: unknown,
      context?: MutationContext,
    ): Promise<unknown> {
      calls.push({ method, params, ...(context === undefined ? {} : { context }) });
      if (Object.hasOwn(overrides, method)) {
        const override = overrides[method];
        return Promise.resolve(
          isFakeImplementation(override) ? override(params, context) : override,
        );
      }
      if (method === "library.list") return Promise.resolve({ items: [] });
      if (method === "library.rebuild") {
        return Promise.resolve({
          subjects: 2,
          jobs: 1,
          relations: 0,
          rebuiltAt: "2026-08-21T01:02:03.000Z",
        });
      }
      if (method === "subjects.archive") return Promise.resolve(null);
      if (method === "profiles.prompt") return Promise.resolve("x".repeat(16_777_216));
      return Promise.reject(new Error(`Unexpected fake method: ${method}`));
    },
    watch(handler: (event: EngineEvent) => void): Promise<() => void> {
      watchCount += 1;
      watchers.add(handler);
      for (const event of eventsOnWatch) handler(event);
      let active = true;
      return Promise.resolve(() => {
        if (active) {
          active = false;
          watchers.delete(handler);
          unsubscribeCount += 1;
        }
      });
    },
    close,
  };
  return {
    client: dynamic as EngineClient,
    calls,
    close,
    emit: (event) => {
      for (const watcher of watchers) watcher(event);
    },
    watched: () => watchCount,
    unsubscribed: () => unsubscribeCount,
  };
};

const ephemeralListen = async (server: HttpServer): Promise<number> =>
  await new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Missing ephemeral TCP address."));
      } else {
        resolve(address.port);
      }
    });
  });

const originOf = (handle: PanelHandle): string => handle.url.slice(0, handle.url.indexOf("/#"));

const authenticatedHeaders = (origin: string, token = TOKEN): Readonly<Record<string, string>> => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  Origin: origin,
});

const post = async (
  origin: string,
  path: string,
  body: unknown,
  token = TOKEN,
): Promise<Response> =>
  await fetch(`${origin}${path}`, {
    method: "POST",
    headers: authenticatedHeaders(origin, token),
    body: JSON.stringify(body),
  });

const waitUntil = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Panel test condition.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const rawRequest = async (port: number, path: string): Promise<{ status: number; body: string }> =>
  await new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers: { Host: `127.0.0.1:${port}` } },
      (response) => {
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    request.once("error", reject);
    request.end();
  });

interface RawHttpResponse {
  readonly status: number;
  readonly headers: ReadonlyMap<string, readonly string[]>;
  readonly body: string;
}

const parseRawHttpResponse = (raw: string): RawHttpResponse => {
  const separator = raw.indexOf("\r\n\r\n");
  if (separator < 0) throw new Error("Panel raw response omitted its header terminator.");
  const rawHeaders = raw.slice(0, separator);
  const lines = rawHeaders.split("\r\n");
  const statusMatch = /^HTTP\/1\.1 (?<status>[0-9]{3}) /u.exec(lines[0] ?? "");
  if (statusMatch?.groups?.status === undefined) {
    throw new Error("Panel raw response omitted its HTTP status.");
  }
  const headers = new Map<string, string[]>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error("Panel raw response contained a malformed header.");
    const name = line.slice(0, colon).toLowerCase();
    const values = headers.get(name) ?? [];
    values.push(line.slice(colon + 1).trimStart());
    headers.set(name, values);
  }
  return {
    status: Number(statusMatch.groups.status),
    headers,
    body: raw.slice(separator + 4),
  };
};

const rawHttpExchange = async (
  port: number,
  method: string,
  path: string,
  headers: readonly (readonly [string, string])[],
  body = "",
): Promise<RawHttpResponse> =>
  await new Promise<RawHttpResponse>((resolve, reject) => {
    const socket = new Socket();
    let responseBytes = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      responseBytes += chunk;
    });
    socket.once("end", () => resolve(parseRawHttpResponse(responseBytes)));
    socket.once("error", reject);
    socket.connect(port, "127.0.0.1", () => {
      socket.end(
        [
          `${method} ${path} HTTP/1.1`,
          ...headers.map(([name, value]) => `${name}: ${value}`),
          "",
          body,
        ].join("\r\n"),
      );
    });
  });

const rawJsonHeaders = (origin: string, body: string): readonly (readonly [string, string])[] => [
  ["Host", new URL(origin).host],
  ["Authorization", `Bearer ${TOKEN}`],
  ["Content-Type", "application/json"],
  ["Origin", origin],
  ["Content-Length", String(Buffer.byteLength(body))],
  ["Connection", "close"],
];

type VersionEventKind = "version.suspended" | "version.promoted" | "version.rolled_back";

const versionEvent = (kind: VersionEventKind): EngineEvent => ({
  kind,
  subjectId: SUBJECT_ID,
  versionId: VERSION_ID,
  at: AT,
});

const repeatVersionEvent = (kind: VersionEventKind, count: number): readonly EngineEvent[] =>
  Array.from({ length: count }, () => versionEvent(kind));

const engineFrameByteLength = (event: EngineEvent): number =>
  Buffer.byteLength(
    `event: engine\ndata:${JSON.stringify({
      at: event.at,
      kind: event.kind,
      ...(event.subjectId === undefined ? {} : { subjectId: event.subjectId }),
      ...(event.versionId === undefined ? {} : { versionId: event.versionId }),
    })}\n\n`,
  );

const exactSseBufferEvents = (): readonly EngineEvent[] => [
  ...repeatVersionEvent("version.promoted", 1),
  ...repeatVersionEvent("version.suspended", 19),
  ...repeatVersionEvent("version.rolled_back", 53),
];

const oversizedSseBufferEvents = (): readonly EngineEvent[] => [
  ...repeatVersionEvent("version.suspended", 20),
  ...repeatVersionEvent("version.rolled_back", 53),
];

const trackedNodeHeaderBytes = (
  path: string,
  headers: readonly (readonly [string, string])[],
): number =>
  Buffer.byteLength(path) +
  headers.reduce(
    (total, [name, value]) => total + Buffer.byteLength(name) + Buffer.byteLength(value),
    0,
  );

const reservePort = async (): Promise<{ readonly server: NetServer; readonly port: number }> => {
  const server = createNetServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") reject(new Error("No reserved port."));
      else resolve(address.port);
    });
  });
  return { server, port };
};

const closeNetServer = async (server: NetServer): Promise<void> =>
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

describe("Panel HTTP server", () => {
  let assetsDir: string;
  const handles: PanelHandle[] = [];

  beforeEach(async () => {
    assetsDir = await mkdtemp(join(await realpath(tmpdir()), "distilly-panel-assets-"));
    await Promise.all([
      writeFile(join(assetsDir, "index.html"), "<!doctype html><title>Panel</title>"),
      writeFile(join(assetsDir, "app.js"), "export {};\n"),
      writeFile(join(assetsDir, "app.css"), "body { color: black; }\n"),
    ]);
  });

  afterEach(async () => {
    await Promise.all(handles.splice(0).map(async (handle) => await handle.close()));
    await rm(assetsDir, { recursive: true, force: true });
  });

  const start = async (
    fake: FakeClient,
    seams: {
      readonly clock?: () => number;
      readonly actionNonceFactory?: () => string;
      readonly tokenFactory?: () => string;
      readonly highWaterMark?: number;
    } = {},
  ): Promise<PanelHandle> => {
    const options: PanelServerOptions = {
      client: fake.client,
      assetsDir,
      port: 1,
    };
    const handle = await startPanelServerWithSeams(options, {
      tokenFactory: seams.tokenFactory ?? (() => TOKEN),
      ...(seams.clock === undefined ? {} : { clock: seams.clock }),
      ...(seams.actionNonceFactory === undefined
        ? {}
        : { actionNonceFactory: seams.actionNonceFactory }),
      ...(seams.highWaterMark === undefined ? {} : { highWaterMark: seams.highWaterMark }),
      listen: ephemeralListen,
    });
    handles.push(handle);
    return handle;
  };

  it("serves only fixed local assets and a person-free health response with exact hardening", async () => {
    const fake = fakeClient();
    const handle = await start(fake);
    const origin = originOf(handle);

    const index = await fetch(`${origin}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("<title>Panel</title>");
    expect(index.headers.get("content-security-policy")).toBe(PANEL_CSP);
    expect(index.headers.get("cache-control")).toBe("no-store");
    expect(index.headers.get("x-content-type-options")).toBe("nosniff");
    expect(index.headers.get("referrer-policy")).toBe("no-referrer");
    expect(index.headers.get("cross-origin-resource-policy")).toBe("same-origin");

    const health = await fetch(`${origin}/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await health.text()).toBe(
      '{"panelVersion":"0.1.0-preview.1","status":"ready","wireVersion":"3"}\n',
    );
    for (const path of [
      "/%2e%2e/app.js",
      "/%ZZ",
      "/app%2Ejs",
      "/app.js?cache=1",
      "//app.js",
      "/%2fapp.js",
      "/%5capp.js",
      "/%00app.js",
    ]) {
      expect(await rawRequest(Number(new URL(origin).port), path)).toMatchObject({ status: 404 });
    }
    expect((await fetch(`${origin}/missing`)).status).toBe(404);
    expect(
      (await fetch(`${origin}/`, { headers: { Origin: "http://attacker.invalid" } })).status,
    ).toBe(403);
    expect((await fetch(`${origin}/health`, { headers: { Origin: "null" } })).status).toBe(403);
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects every POST endpoint's Bearer, Host, Origin, and CORS preflight matrix", async () => {
    const fake = fakeClient();
    const handle = await start(fake);
    const origin = originOf(handle);
    const port = Number(new URL(origin).port);
    const endpoints = [
      {
        path: "/rpc",
        body: JSON.stringify({ wireVersion: WIRE_VERSION, method: "library.list", params: {} }),
      },
      {
        path: "/action-nonces",
        body: JSON.stringify({
          wireVersion: WIRE_VERSION,
          method: "subjects.archive",
          params: { subjectId: SUBJECT_ID },
          requestId: REQUEST_ID,
        }),
      },
      { path: "/events", body: JSON.stringify({ wireVersion: WIRE_VERSION }) },
    ] as const;
    const without = (
      headers: readonly (readonly [string, string])[],
      name: string,
    ): readonly (readonly [string, string])[] =>
      headers.filter(([headerName]) => headerName.toLowerCase() !== name.toLowerCase());
    const replace = (
      headers: readonly (readonly [string, string])[],
      name: string,
      value: string,
    ): readonly (readonly [string, string])[] => [...without(headers, name), [name, value]];
    const genericFailure = {
      ok: false,
      wireVersion: WIRE_VERSION,
      error: {
        code: "invalid_input",
        message: "Panel request rejected.",
        retryable: false,
      },
    };

    for (const endpoint of endpoints) {
      const base = rawJsonHeaders(origin, endpoint.body);
      const cases = [
        { label: "missing Bearer", status: 401, headers: without(base, "Authorization") },
        {
          label: "wrong Bearer",
          status: 401,
          headers: replace(base, "Authorization", `Bearer ${"f".repeat(64)}`),
        },
        {
          label: "multiple Bearer",
          status: 401,
          headers: [...base, ["Authorization", `Bearer ${TOKEN}`] as const],
        },
        { label: "missing Host", status: 403, headers: without(base, "Host") },
        { label: "wrong Host", status: 403, headers: replace(base, "Host", "localhost") },
        {
          label: "multiple Host",
          status: 403,
          headers: [...base, ["Host", new URL(origin).host] as const],
        },
        { label: "missing Origin", status: 403, headers: without(base, "Origin") },
        { label: "null Origin", status: 403, headers: replace(base, "Origin", "null") },
        {
          label: "cross-site Origin",
          status: 403,
          headers: replace(base, "Origin", "http://attacker.invalid"),
        },
        {
          label: "multiple Origin",
          status: 403,
          headers: [...base, ["Origin", origin] as const],
        },
      ] as const;
      for (const securityCase of cases) {
        const response = await rawHttpExchange(
          port,
          "POST",
          endpoint.path,
          securityCase.headers,
          endpoint.body,
        );
        expect(response.status, `${endpoint.path}: ${securityCase.label}`).toBe(
          securityCase.status,
        );
        expect(JSON.parse(response.body), `${endpoint.path}: ${securityCase.label}`).toEqual(
          genericFailure,
        );
        expect(response.headers.has("access-control-allow-origin")).toBe(false);
        expect(response.headers.has("access-control-allow-headers")).toBe(false);
        expect(response.headers.has("access-control-allow-methods")).toBe(false);
      }

      for (const preflightOrigin of [origin, "http://attacker.invalid"]) {
        const preflight = await rawHttpExchange(port, "OPTIONS", endpoint.path, [
          ["Host", new URL(origin).host],
          ["Origin", preflightOrigin],
          ["Access-Control-Request-Method", "POST"],
          ["Access-Control-Request-Headers", "authorization, content-type"],
          ["Content-Length", "0"],
          ["Connection", "close"],
        ]);
        expect(preflight.status, `${endpoint.path}: CORS preflight from ${preflightOrigin}`).toBe(
          405,
        );
        expect(preflight.headers.get("allow")).toEqual(["POST"]);
        expect(preflight.headers.has("access-control-allow-origin")).toBe(false);
        expect(preflight.headers.has("access-control-allow-headers")).toBe(false);
        expect(preflight.headers.has("access-control-allow-methods")).toBe(false);
      }
    }
    expect(fake.calls).toHaveLength(0);
    expect(fake.watched()).toBe(0);
  });

  it("keeps POST content type and RPC envelopes strict before any client call", async () => {
    const fake = fakeClient();
    const handle = await start(fake);
    const origin = originOf(handle);
    const body = { wireVersion: WIRE_VERSION, method: "library.list", params: {} };

    expect(
      (
        await fetch(`${origin}/rpc`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}`, Origin: origin },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(415);
    const wrongMethod = await fetch(`${origin}/health`, { method: "POST" });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
    expect(
      (
        await post(origin, "/rpc", {
          ...body,
          requestId: REQUEST_ID,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(origin, "/rpc", {
          wireVersion: WIRE_VERSION,
          method: "subjects.archive",
          params: { subjectId: SUBJECT_ID },
          requestId: "req_bad",
          actionNonce: `panel_action_${"1".repeat(64)}`,
        })
      ).status,
    ).toBe(400);
    expect(fake.calls).toHaveLength(0);
    expect(fake.watched()).toBe(0);
  });

  it("accepts only the exact events body before registering a watcher", async () => {
    const fake = fakeClient();
    const handle = await start(fake);
    const origin = originOf(handle);
    const invalidBodies: readonly unknown[] = [
      {},
      { wireVersion: "2" },
      { wireVersion: WIRE_VERSION, extra: true },
      [],
      null,
    ];

    for (const body of invalidBodies) {
      const response = await post(origin, "/events", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        ok: false,
        wireVersion: WIRE_VERSION,
        error: { code: "invalid_input", retryable: false },
      });
    }
    for (const body of ["", '{"wireVersion":"3"} {}']) {
      const response = await fetch(`${origin}/events`, {
        method: "POST",
        headers: authenticatedHeaders(origin),
        body,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        ok: false,
        wireVersion: WIRE_VERSION,
        error: { code: "invalid_input", retryable: false },
      });
    }
    expect(fake.calls).toHaveLength(0);
    expect(fake.watched()).toBe(0);
  });

  it("requires an action nonce field on every mutation method", async () => {
    const fake = fakeClient();
    const handle = await start(fake);
    const origin = originOf(handle);
    for (const method of panelMutationMethods) {
      const response = await post(origin, "/rpc", {
        wireVersion: WIRE_VERSION,
        method,
        params: {},
        requestId: REQUEST_ID,
      });
      expect(response.status, method).toBe(400);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("round-trips every exact EngineMethodMap query and mutation with correlated calls", async () => {
    const methods = Object.keys(PANEL_RPC_FIXTURES) as (keyof EngineMethodMap)[];
    expect(methods).toHaveLength(35);
    expect(methods.toSorted()).toEqual(Object.keys(engineMethodSchemas).toSorted());
    const results = Object.fromEntries(
      methods.map((method) => [method, PANEL_RPC_FIXTURES[method].result]),
    ) as Partial<Record<keyof EngineMethodMap, unknown>>;
    const fake = fakeClient(results);
    const handle = await start(fake);
    const origin = originOf(handle);
    const expectedCalls: RecordedCall[] = [];

    for (const [index, method] of methods.entries()) {
      const fixture = PANEL_RPC_FIXTURES[method];
      const params = engineMethodSchemas[method].params.parse(fixture.params);
      const value = engineMethodSchemas[method].result.parse(fixture.result);
      const requestId = requestIdSchema.parse(`req_${index.toString(16).padStart(32, "0")}`);
      let actionNonce: string | undefined;
      if (isMutationMethod(method)) {
        const nonceResponse = await post(origin, "/action-nonces", {
          wireVersion: WIRE_VERSION,
          method,
          params: fixture.params,
          requestId,
        });
        expect(nonceResponse.status, `${method} nonce`).toBe(200);
        const grant = (await nonceResponse.json()) as {
          readonly value: { readonly actionNonce: string };
        };
        actionNonce = grant.value.actionNonce;
        expectedCalls.push({ method, params, context: { requestId } });
      } else {
        expectedCalls.push({ method, params });
      }

      const response = await post(origin, "/rpc", {
        wireVersion: WIRE_VERSION,
        method,
        params: fixture.params,
        ...(isMutationMethod(method) ? { requestId, actionNonce } : {}),
      });
      expect(response.status, method).toBe(200);
      expect(await response.json(), method).toEqual({
        ok: true,
        wireVersion: WIRE_VERSION,
        value,
      });
    }
    expect(fake.calls).toEqual(expectedCalls);

    await handle.close();
    expect(fake.close).not.toHaveBeenCalled();
  });

  it("carries legal-method params and result validation failures inside HTTP 200", async () => {
    const fake = fakeClient({ "library.list": { items: [], unexpected: true } });
    const handle = await start(fake);
    const origin = originOf(handle);
    const invalidParams = await post(origin, "/rpc", {
      wireVersion: WIRE_VERSION,
      method: "library.list",
      params: { limit: 0 },
    });
    expect(invalidParams.status).toBe(200);
    expect(await invalidParams.json()).toMatchObject({
      ok: false,
      error: { code: "invalid_input", retryable: false },
    });
    expect(fake.calls).toHaveLength(0);

    const invalidResult = await post(origin, "/rpc", {
      wireVersion: WIRE_VERSION,
      method: "library.list",
      params: {},
    });
    expect(invalidResult.status).toBe(200);
    expect(await invalidResult.json()).toMatchObject({
      ok: false,
      error: { code: "internal_error", retryable: false },
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("preserves every correlated DistillyError field inside an HTTP 200 WireFailure", async () => {
    const subject = engineMethodSchemas["subjects.create"].result.parse(
      PANEL_RPC_FIXTURES["subjects.create"].result,
    );
    const params = engineMethodSchemas["subjects.create"].params.parse(
      PANEL_RPC_FIXTURES["subjects.create"].params,
    );
    const error = {
      code: "already_exists",
      message: "The subject already exists.",
      retryable: false,
      fieldPath: "displayName",
      remediation: "Use the existing subject id.",
      details: { match: "exact", confidence: 1 },
      subjectResolution: { kind: "found", subject },
    } as const;
    const fake = fakeClient({
      "subjects.create": () => Promise.reject(new DistillyError(error)),
    });
    const handle = await start(fake);
    const origin = originOf(handle);
    const request = {
      wireVersion: WIRE_VERSION,
      method: "subjects.create",
      params,
      requestId: REQUEST_ID,
    } as const;
    const nonceResponse = await post(origin, "/action-nonces", request);
    expect(nonceResponse.status).toBe(200);
    const nonce = (await nonceResponse.json()) as {
      readonly value: { readonly actionNonce: string };
    };

    const response = await post(origin, "/rpc", {
      ...request,
      actionNonce: nonce.value.actionNonce,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      wireVersion: WIRE_VERSION,
      error,
    });
    expect(fake.calls).toEqual([
      { method: "subjects.create", params, context: { requestId: REQUEST_ID } },
    ]);
  });

  it("binds a mutation nonce independently to method, request id, and canonical params", async () => {
    const fake = fakeClient({
      "versions.promote": PANEL_RPC_FIXTURES["versions.promote"].result,
    });
    let nonceIndex = 1;
    const nonce = (): string => `panel_action_${String(nonceIndex++).repeat(64).slice(0, 64)}`;
    const handle = await start(fake, { actionNonceFactory: nonce });
    const origin = originOf(handle);
    const nonceRequest = {
      wireVersion: WIRE_VERSION,
      method: "versions.promote",
      params: {
        subjectId: SUBJECT_ID,
        candidateVersionId: `version_${"1".repeat(64)}`,
        reason: "Accept reviewed risk.",
      },
      requestId: REQUEST_ID,
    } as const;
    const issued = await post(origin, "/action-nonces", nonceRequest);
    const issuedBody = (await issued.json()) as {
      value: { actionNonce: string; expiresAt: string };
    };
    expect(issuedBody.value.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    const mutation = {
      ...nonceRequest,
      params: {
        reason: nonceRequest.params.reason,
        candidateVersionId: nonceRequest.params.candidateVersionId,
        subjectId: nonceRequest.params.subjectId,
      },
      actionNonce: issuedBody.value.actionNonce,
    };

    expect(
      (
        await post(origin, "/rpc", {
          ...mutation,
          method: "versions.reject",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(origin, "/rpc", {
          ...mutation,
          requestId: OTHER_REQUEST_ID,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(origin, "/rpc", {
          ...mutation,
          params: { ...mutation.params, reason: "Different canonical params." },
        })
      ).status,
    ).toBe(400);
    expect(fake.calls).toHaveLength(0);

    expect((await post(origin, "/rpc", mutation)).status).toBe(200);
    expect((await post(origin, "/rpc", mutation)).status).toBe(400);
    expect(fake.calls).toEqual([
      {
        method: "versions.promote",
        params: mutation.params,
        context: { requestId: REQUEST_ID },
      },
    ]);
  });

  it("does not restore a consumed nonce after an EngineClient failure", async () => {
    const fake = fakeClient({
      "subjects.archive": () => Promise.reject(new Error("fixture client failure")),
    });
    const handle = await start(fake);
    const origin = originOf(handle);
    const request = {
      wireVersion: WIRE_VERSION,
      method: "subjects.archive",
      params: { subjectId: SUBJECT_ID },
      requestId: REQUEST_ID,
    } as const;
    const grant = (await (await post(origin, "/action-nonces", request)).json()) as {
      readonly value: { readonly actionNonce: string };
    };
    const mutation = { ...request, actionNonce: grant.value.actionNonce };

    const failed = await post(origin, "/rpc", mutation);
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({
      ok: false,
      error: { code: "internal_error", retryable: false },
    });
    expect((await post(origin, "/rpc", mutation)).status).toBe(400);
    expect(fake.calls).toEqual([
      {
        method: "subjects.archive",
        params: request.params,
        context: { requestId: REQUEST_ID },
      },
    ]);
  });

  it("does not restore a consumed nonce when a legal mutation result exceeds 16 MiB", async () => {
    const base = engineMethodSchemas["profiles.correct"].result.parse(
      PANEL_RPC_FIXTURES["profiles.correct"].result,
    );
    if (base.kind !== "current") throw new Error("Expected a current correction fixture.");
    const fake = fakeClient({
      "profiles.correct": {
        ...base,
        profile: { ...base.profile, rendered: "x".repeat(16_777_216) },
      },
    });
    const handle = await start(fake);
    const origin = originOf(handle);
    const request = {
      wireVersion: WIRE_VERSION,
      method: "profiles.correct",
      params: PANEL_RPC_FIXTURES["profiles.correct"].params,
      requestId: REQUEST_ID,
    } as const;
    const grant = (await (await post(origin, "/action-nonces", request)).json()) as {
      readonly value: { readonly actionNonce: string };
    };
    const mutation = { ...request, actionNonce: grant.value.actionNonce };

    const oversized = await post(origin, "/rpc", mutation);
    expect(oversized.status).toBe(200);
    expect(await oversized.json()).toMatchObject({
      ok: false,
      error: { code: "context_too_large", retryable: false },
    });
    expect((await post(origin, "/rpc", mutation)).status).toBe(400);
    expect(fake.calls).toEqual([
      {
        method: "profiles.correct",
        params: engineMethodSchemas["profiles.correct"].params.parse(request.params),
        context: { requestId: REQUEST_ID },
      },
    ]);
  });

  it("does not restore a consumed nonce when the caller drops the response connection", async () => {
    let resolveCall: (() => void) | undefined;
    const blockedCall = new Promise<null>((resolve) => {
      resolveCall = () => resolve(null);
    });
    const fake = fakeClient({ "subjects.archive": () => blockedCall });
    const handle = await start(fake);
    const origin = originOf(handle);
    const request = {
      wireVersion: WIRE_VERSION,
      method: "subjects.archive",
      params: { subjectId: SUBJECT_ID },
      requestId: REQUEST_ID,
    } as const;
    const grant = (await (await post(origin, "/action-nonces", request)).json()) as {
      readonly value: { readonly actionNonce: string };
    };
    const mutation = { ...request, actionNonce: grant.value.actionNonce };
    const controller = new AbortController();
    const interrupted = fetch(`${origin}/rpc`, {
      method: "POST",
      headers: authenticatedHeaders(origin),
      body: JSON.stringify(mutation),
      signal: controller.signal,
    });
    await waitUntil(() => fake.calls.length === 1);
    controller.abort();
    await expect(interrupted).rejects.toMatchObject({ name: "AbortError" });
    resolveCall?.();

    expect((await post(origin, "/rpc", mutation)).status).toBe(400);
    expect(fake.calls).toEqual([
      {
        method: "subjects.archive",
        params: request.params,
        context: { requestId: REQUEST_ID },
      },
    ]);
  });

  it("atomically lets only one concurrent RPC consume the same nonce", async () => {
    const fake = fakeClient();
    const handle = await start(fake, {
      actionNonceFactory: () => `panel_action_${"9".repeat(64)}`,
    });
    const origin = originOf(handle);
    const request = {
      wireVersion: WIRE_VERSION,
      method: "subjects.archive",
      params: { subjectId: SUBJECT_ID },
      requestId: REQUEST_ID,
    };
    const grant = (await (await post(origin, "/action-nonces", request)).json()) as {
      value: { actionNonce: string };
    };
    const statuses = await Promise.all([
      post(origin, "/rpc", { ...request, actionNonce: grant.value.actionNonce }),
      post(origin, "/rpc", { ...request, actionNonce: grant.value.actionNonce }),
    ]).then((responses) => responses.map((response) => response.status).sort());
    expect(statuses).toEqual([200, 400]);
    expect(fake.calls).toHaveLength(1);
  });

  it("expires an unused action nonce at exactly 60 seconds", async () => {
    const fake = fakeClient();
    let now = 1_000;
    const handle = await start(fake, {
      clock: () => now,
      actionNonceFactory: () => `panel_action_${"e".repeat(64)}`,
    });
    const origin = originOf(handle);
    const request = {
      wireVersion: WIRE_VERSION,
      method: "subjects.archive",
      params: { subjectId: SUBJECT_ID },
      requestId: REQUEST_ID,
    };
    const issued = (await (await post(origin, "/action-nonces", request)).json()) as {
      value: { actionNonce: string; expiresAt: string };
    };
    expect(issued.value.expiresAt).toBe("1970-01-01T00:01:01.000Z");
    now += 60_000;
    expect(
      (await post(origin, "/rpc", { ...request, actionNonce: issued.value.actionNonce })).status,
    ).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  it("accepts a 4 MiB request body exactly and rejects its first byte over", async () => {
    const fake = fakeClient();
    const handle = await start(fake);
    const origin = originOf(handle);
    const rpcBody = JSON.stringify({
      wireVersion: WIRE_VERSION,
      method: "library.list",
      params: {},
    });
    const exactBody = rpcBody + " ".repeat(4_194_304 - Buffer.byteLength(rpcBody));
    expect(Buffer.byteLength(exactBody)).toBe(4_194_304);

    const exact = await fetch(`${origin}/rpc`, {
      method: "POST",
      headers: authenticatedHeaders(origin),
      body: exactBody,
    });
    expect(exact.status).toBe(200);
    expect(await exact.json()).toEqual({
      ok: true,
      wireVersion: WIRE_VERSION,
      value: { items: [] },
    });

    const oversized = await fetch(`${origin}/rpc`, {
      method: "POST",
      headers: authenticatedHeaders(origin),
      body: `${exactBody} `,
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({
      ok: false,
      wireVersion: WIRE_VERSION,
      error: {
        code: "invalid_input",
        message: "The Panel request exceeds the 4 MiB transport limit.",
        retryable: false,
        details: { size: 4_194_305, limit: 4_194_304 },
      },
    });
    expect(fake.calls).toEqual([{ method: "library.list", params: {} }]);
  });

  it("writes a 16 MiB response exactly and replaces its first byte over before writing", async () => {
    const emptyEnvelopeBytes = Buffer.byteLength(
      JSON.stringify({ ok: true, wireVersion: WIRE_VERSION, value: "" }),
    );
    let prompt = "x".repeat(16_777_216 - emptyEnvelopeBytes);
    const fake = fakeClient({ "profiles.prompt": () => prompt });
    const handle = await start(fake);
    const origin = originOf(handle);
    const request = {
      wireVersion: WIRE_VERSION,
      method: "profiles.prompt",
      params: { subjectId: SUBJECT_ID },
    } as const;

    const exact = await post(origin, "/rpc", request);
    expect(exact.status).toBe(200);
    expect(exact.headers.get("content-length")).toBe("16777216");
    const exactBytes = Buffer.from(await exact.arrayBuffer());
    expect(exactBytes.byteLength).toBe(16_777_216);
    const exactEnvelope = JSON.parse(exactBytes.toString("utf8")) as {
      readonly ok: boolean;
      readonly wireVersion: string;
      readonly value: string;
    };
    expect(exactEnvelope.ok).toBe(true);
    expect(exactEnvelope.wireVersion).toBe(WIRE_VERSION);
    expect(exactEnvelope.value).toHaveLength(16_777_216 - emptyEnvelopeBytes);

    prompt += "x";
    const oversized = await post(origin, "/rpc", request);
    expect(oversized.status).toBe(200);
    expect(await oversized.json()).toEqual({
      ok: false,
      wireVersion: WIRE_VERSION,
      error: {
        code: "context_too_large",
        message: "The Panel response exceeds the 16 MiB transport limit.",
        retryable: false,
        remediation: "Request a smaller page or narrower view.",
      },
    });
    expect(fake.calls).toEqual([
      { method: "profiles.prompt", params: request.params },
      { method: "profiles.prompt", params: request.params },
    ]);
  });

  it("registers watch before ready, streams compact events, and unsubscribes on disconnect", async () => {
    const earlyEvent = {
      kind: "job.changed",
      subjectId: SUBJECT_ID,
      at: isoDateTimeSchema.parse("2026-08-21T01:02:03.000Z"),
    } as const;
    const fake = fakeClient({}, [earlyEvent]);
    const handle = await start(fake);
    const origin = originOf(handle);
    const controller = new AbortController();
    const response = await fetch(`${origin}/events`, {
      method: "POST",
      headers: authenticatedHeaders(origin),
      body: JSON.stringify({ wireVersion: WIRE_VERSION }),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("last-event-id")).toBeNull();
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new PanelSseDecoder();
    const frames = [];
    while (frames.length < 2) {
      const chunk = await reader?.read();
      expect(chunk?.done).toBe(false);
      frames.push(...decoder.push(chunk?.value ?? new Uint8Array()));
    }
    expect(frames).toEqual([
      { event: "ready", data: '{"wireVersion":"3"}' },
      {
        event: "engine",
        data: `{"at":"2026-08-21T01:02:03.000Z","kind":"job.changed","subjectId":"${SUBJECT_ID}"}`,
      },
    ]);
    controller.abort();
    await waitUntil(() => fake.unsubscribed() === 1);
  });

  it("buffers exactly 16 KiB before ready and disconnects on the first byte over", async () => {
    const exactEvents = exactSseBufferEvents();
    const oversizedEvents = oversizedSseBufferEvents();
    expect(exactEvents.reduce((total, event) => total + engineFrameByteLength(event), 0)).toBe(
      16_384,
    );
    expect(oversizedEvents.reduce((total, event) => total + engineFrameByteLength(event), 0)).toBe(
      16_385,
    );

    const exactFake = fakeClient({}, exactEvents);
    const exactHandle = await start(exactFake);
    const exactOrigin = originOf(exactHandle);
    const controller = new AbortController();
    const exactResponse = await fetch(`${exactOrigin}/events`, {
      method: "POST",
      headers: authenticatedHeaders(exactOrigin),
      body: JSON.stringify({ wireVersion: WIRE_VERSION }),
      signal: controller.signal,
    });
    expect(exactResponse.status).toBe(200);
    const reader = exactResponse.body?.getReader();
    if (reader === undefined) throw new Error("Expected a readable SSE response body.");
    const chunks: Buffer[] = [];
    let total = 0;
    const expectedBytes = Buffer.byteLength('event: ready\ndata:{"wireVersion":"3"}\n\n') + 16_384;
    while (total < expectedBytes) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Exact-limit SSE stream ended before all frames arrived.");
      const bytes = Buffer.from(chunk.value);
      chunks.push(bytes);
      total += bytes.byteLength;
    }
    expect(total).toBe(expectedBytes);
    const streamed = Buffer.concat(chunks, total).toString("utf8");
    expect(streamed.startsWith('event: ready\ndata:{"wireVersion":"3"}\n\n')).toBe(true);
    expect(streamed.match(/event: engine\n/gu)).toHaveLength(exactEvents.length);
    expect(exactFake.unsubscribed()).toBe(0);
    controller.abort();
    await waitUntil(() => exactFake.unsubscribed() === 1);

    const oversizedFake = fakeClient({}, oversizedEvents);
    const oversizedHandle = await start(oversizedFake);
    const oversizedOrigin = originOf(oversizedHandle);
    const oversizedResponse = await fetch(`${oversizedOrigin}/events`, {
      method: "POST",
      headers: authenticatedHeaders(oversizedOrigin),
      body: JSON.stringify({ wireVersion: WIRE_VERSION }),
    });
    expect(oversizedResponse.status).toBe(200);
    expect(await oversizedResponse.text()).toBe("");
    expect(oversizedFake.watched()).toBe(1);
    expect(oversizedFake.unsubscribed()).toBe(1);
    expect(oversizedFake.calls).toHaveLength(0);
  });

  it("queues a slow consumer after backpressure and disconnects on bounded overflow", async () => {
    const fake = fakeClient();
    const handle = await start(fake, { highWaterMark: 1 });
    const origin = originOf(handle);
    const response = await fetch(`${origin}/events`, {
      method: "POST",
      headers: authenticatedHeaders(origin),
      body: JSON.stringify({ wireVersion: WIRE_VERSION }),
    });
    expect(response.status).toBe(200);

    fake.emit(versionEvent("version.promoted"));
    expect(fake.unsubscribed()).toBe(0);
    for (const event of oversizedSseBufferEvents()) fake.emit(event);
    await waitUntil(() => fake.unsubscribed() === 1);
    expect(await response.text()).toContain('event: ready\ndata:{"wireVersion":"3"}\n\n');
    expect(fake.watched()).toBe(1);
    expect(fake.calls).toHaveLength(0);
  });

  it("accepts exactly 16 KiB of tracked request headers and returns 431 at +1", async () => {
    const fake = fakeClient();
    const handle = await start(fake);
    const origin = originOf(handle);
    const port = Number(new URL(origin).port);
    const body = JSON.stringify({
      wireVersion: WIRE_VERSION,
      method: "library.list",
      params: {},
    });
    const baseHeaders = [...rawJsonHeaders(origin, body), ["X-Fill", ""] as const];
    const fillBytes = 16_384 - trackedNodeHeaderBytes("/rpc", baseHeaders);
    expect(fillBytes).toBeGreaterThan(0);
    const exactHeaders = baseHeaders.map(([name, value]) =>
      name === "X-Fill" ? ([name, "x".repeat(fillBytes)] as const) : ([name, value] as const),
    );
    expect(trackedNodeHeaderBytes("/rpc", exactHeaders)).toBe(16_384);

    const exact = await rawHttpExchange(port, "POST", "/rpc", exactHeaders, body);
    expect(exact.status).toBe(200);
    expect(JSON.parse(exact.body)).toEqual({
      ok: true,
      wireVersion: WIRE_VERSION,
      value: { items: [] },
    });

    const oversizedHeaders = exactHeaders.map(([name, value]) =>
      name === "X-Fill" ? ([name, `${value}x`] as const) : ([name, value] as const),
    );
    expect(trackedNodeHeaderBytes("/rpc", oversizedHeaders)).toBe(16_385);
    const oversized = await rawHttpExchange(port, "POST", "/rpc", oversizedHeaders, body);
    expect(oversized.status).toBe(431);
    expect(JSON.parse(oversized.body)).toEqual({
      ok: false,
      wireVersion: WIRE_VERSION,
      error: {
        code: "invalid_input",
        message: "Panel request headers exceed the 16 KiB transport limit.",
        retryable: false,
      },
    });
    expect(fake.calls).toEqual([{ method: "library.list", params: {} }]);
  });

  it("rejects public port zero, invalid test tokens, symlink assets, and occupied ports", async () => {
    const fake = fakeClient();
    for (const port of [0, -1, 1.5, 80, 65_536, Number.NaN]) {
      await expect(startPanelServer({ client: fake.client, assetsDir, port })).rejects.toThrow(
        "1 through 65535 other than 80",
      );
    }
    await expect(
      startPanelServerWithSeams(
        { client: fake.client, assetsDir, port: 1 },
        { tokenFactory: () => "A".repeat(64), listen: ephemeralListen },
      ),
    ).rejects.toThrow("lowercase hexadecimal");

    const symlinkDir = await mkdtemp(join(await realpath(tmpdir()), "distilly-panel-symlink-"));
    try {
      await Promise.all([
        symlink(join(assetsDir, "index.html"), join(symlinkDir, "index.html")),
        writeFile(join(symlinkDir, "app.js"), "export {};\n"),
        writeFile(join(symlinkDir, "app.css"), "body {}\n"),
      ]);
      await expect(
        startPanelServerWithSeams(
          { client: fake.client, assetsDir: symlinkDir, port: 1 },
          { tokenFactory: () => TOKEN, listen: ephemeralListen },
        ),
      ).rejects.toThrow("symlink");
    } finally {
      await rm(symlinkDir, { recursive: true, force: true });
    }

    const symlinkParent = await mkdtemp(
      join(await realpath(tmpdir()), "distilly-panel-parent-symlink-"),
    );
    const linkedAssetsDir = join(symlinkParent, "assets");
    try {
      await symlink(assetsDir, linkedAssetsDir);
      await expect(
        startPanelServerWithSeams(
          { client: fake.client, assetsDir: linkedAssetsDir, port: 1 },
          { tokenFactory: () => TOKEN, listen: ephemeralListen },
        ),
      ).rejects.toThrow("symlink");
    } finally {
      await rm(symlinkParent, { recursive: true, force: true });
    }

    const reserved = await reservePort();
    try {
      await expect(
        startPanelServer({
          client: fake.client,
          assetsDir,
          port: reserved.port,
        }),
      ).rejects.toMatchObject({ code: "busy", retryable: true });
    } finally {
      await closeNetServer(reserved.server);
    }
  });
});
