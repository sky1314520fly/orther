import type { EngineEvent } from "@distilly/protocol";

/** Package-internal post-commit invalidation bus. */
export interface EventBus {
  publish(event: EngineEvent): Promise<void>;
  subscribe(listener: (event: EngineEvent) => void | Promise<void>): () => void;
}
