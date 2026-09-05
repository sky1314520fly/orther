import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { requireSdkServer, whenMcpServerClosing } from "./internal.js";
import type { McpServer } from "./types.js";

/** Cancellable process-lifecycle wait used by the stdio owner. */
interface ShutdownWaiter {
  readonly promise: Promise<void>;
  cancel(): void;
}

const createShutdownWaiter = (): ShutdownWaiter => {
  if (process.stdin.readableEnded) {
    return { promise: Promise.resolve(), cancel: () => undefined };
  }
  let cleanup = (): void => undefined;
  const promise = new Promise<void>((resolve, reject) => {
    const onShutdown = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    cleanup = (): void => {
      process.stdin.off("end", onShutdown);
      process.stdin.off("error", onError);
      process.off("SIGINT", onShutdown);
      process.off("SIGTERM", onShutdown);
    };
    process.stdin.once("end", onShutdown);
    process.stdin.once("error", onError);
    process.once("SIGINT", onShutdown);
    process.once("SIGTERM", onShutdown);
  });
  return { promise, cancel: cleanup };
};

/**
 * Serves one Distilly MCP connection over the current process's stdio.
 *
 * @param server - Handle returned by createMcpServer.
 * @returns Completion after stdin closes and transport teardown finishes.
 */
export const runStdio = async (server: McpServer): Promise<void> => {
  const sdkServer = requireSdkServer(server);
  const shutdown = createShutdownWaiter();
  let rejectTransportFailure: (error: Error) => void = () => undefined;
  let acceptingTransportFailure = true;
  const transportFailure = new Promise<never>((_resolve, reject) => {
    rejectTransportFailure = reject;
  });
  const handle = serveStdio(() => sdkServer, {
    onerror: (error) => {
      if (acceptingTransportFailure) rejectTransportFailure(error);
    },
  });
  let primaryError: unknown;
  let primaryFailed = false;
  try {
    await Promise.race([shutdown.promise, transportFailure, whenMcpServerClosing(server)]);
  } catch (error) {
    primaryError = error;
    primaryFailed = true;
  }

  acceptingTransportFailure = false;
  shutdown.cancel();
  let teardownError: unknown;
  let teardownFailed = false;
  try {
    await handle.close();
  } catch (error) {
    teardownError = error;
    teardownFailed = true;
  }
  try {
    await server.close();
  } catch (error) {
    if (!teardownFailed) {
      teardownError = error;
      teardownFailed = true;
    }
  }
  if (primaryFailed) throw primaryError;
  if (teardownFailed) throw teardownError;
};
