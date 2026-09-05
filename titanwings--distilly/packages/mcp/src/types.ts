import type { EngineClient, ReviewLaunch, ReviewRef } from "@distilly/protocol";

/** Host-specific advertised-schema dialects supported by the MCP adapter. */
export type McpSchemaProfile = "openclaw" | "hermes";

/** Opens or reuses the local review surface for one suspended candidate. */
export interface ReviewPresenter {
  /**
   * Presents one immutable review reference.
   *
   * @param review - Candidate selected by the engine.
   * @returns A launch target for exactly the same candidate.
   */
  present(review: ReviewRef): Promise<ReviewLaunch>;
}

/** Dependencies for the transport-neutral five-tool presenter. */
export interface McpServerOptions {
  readonly client: EngineClient;
  readonly reviewPresenter: ReviewPresenter;
  /**
   * Optional host-side schema projection. Canonical descriptors remain the
   * wire contract; projections only accommodate a host's advertised-schema
   * parser and never relax server-side validation.
   */
  readonly schemaProfile?: McpSchemaProfile;
}

/** Transport-neutral server handle. It does not own the injected EngineClient. */
export interface McpServer {
  /**
   * Stops transports owned by this server handle.
   *
   * @returns Completion after the server is closed.
   */
  close(): Promise<void>;
}
