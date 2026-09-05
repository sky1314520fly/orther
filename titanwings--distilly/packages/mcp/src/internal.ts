import type { McpServer as SdkMcpServer } from "@modelcontextprotocol/server";

import type { McpServer } from "./types.js";

interface RegisteredServer {
  readonly sdk: SdkMcpServer;
  readonly closing: Promise<void>;
}

const sdkServers = new WeakMap<McpServer, RegisteredServer>();

/**
 * Registers the SDK implementation hidden behind a public server handle.
 *
 * @param handle - Public package handle used as the lookup key.
 * @param server - SDK server hidden from the public package surface.
 * @param closing - Signal emitted as soon as the public handle starts closing.
 */
export const registerSdkServer = (
  handle: McpServer,
  server: SdkMcpServer,
  closing: Promise<void>,
): void => {
  sdkServers.set(handle, { sdk: server, closing });
};

/**
 * Returns the SDK implementation for a handle created by this package.
 *
 * @param handle - Public package handle returned by createMcpServer.
 * @returns The corresponding SDK server implementation.
 */
export const requireSdkServer = (handle: McpServer): SdkMcpServer => {
  const registered = sdkServers.get(handle);
  if (registered === undefined) {
    throw new TypeError("runStdio requires a server returned by createMcpServer().");
  }
  return registered.sdk;
};

/**
 * Returns the package-internal signal used by a transport owner to observe close.
 *
 * @param handle - Public package handle returned by createMcpServer.
 * @returns Completion as soon as close starts, before its bounded drain finishes.
 */
export const whenMcpServerClosing = (handle: McpServer): Promise<void> => {
  const registered = sdkServers.get(handle);
  if (registered === undefined) {
    throw new TypeError("runStdio requires a server returned by createMcpServer().");
  }
  return registered.closing;
};
