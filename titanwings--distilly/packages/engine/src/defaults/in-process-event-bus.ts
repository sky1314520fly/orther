import type { EngineEvent } from "@distilly/protocol";

import type { EventBus } from "../ports/event-bus.js";

/** Synchronous in-process invalidation bus used by the internal composition. */
export class InProcessEventBus implements EventBus {
  readonly #listeners = new Set<(event: EngineEvent) => void | Promise<void>>();

  /**
   * Publishes one post-commit invalidation to a stable listener snapshot.
   *
   * @param event - Invalidation event persisted by the transaction.
   */
  async publish(event: EngineEvent): Promise<void> {
    for (const listener of [...this.#listeners]) {
      try {
        await listener(event);
      } catch {
        // A post-commit observer cannot change the mutation result or starve later observers.
      }
    }
  }

  /**
   * Registers a listener and returns an idempotent unsubscribe callback.
   *
   * @param listener - Callback invoked for subsequent invalidations.
   * @returns A callback that removes the listener.
   */
  subscribe(listener: (event: EngineEvent) => void | Promise<void>): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
