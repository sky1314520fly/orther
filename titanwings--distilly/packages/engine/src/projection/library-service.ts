import { DistillyError } from "@distilly/protocol";
import type { LibraryPage, LibraryQuery } from "@distilly/protocol";

import type { LibraryProjection } from "./library-projection.js";

/** Reconciliation-gated Library query operations. */
export class LibraryService {
  readonly #projection: LibraryProjection;
  readonly #reconcile: () => Promise<void>;

  /**
   * Creates Library operations that cannot observe a prepared-journal clean-stale window.
   *
   * @param input - Projection and root recovery callback.
   * @param input.projection - Durable query-only Library projection.
   * @param input.reconcile - Root prepared-journal reconciliation callback.
   */
  constructor(input: {
    readonly projection: LibraryProjection;
    readonly reconcile: () => Promise<void>;
  }) {
    this.#projection = input.projection;
    this.#reconcile = input.reconcile;
  }

  /**
   * Lists only the durable projection after root prepared-journal reconciliation.
   *
   * @param input - Typed Library filters and page boundary.
   * @returns The validated canonical Library page.
   */
  async list(input: LibraryQuery): Promise<LibraryPage> {
    try {
      await this.#reconcile();
    } catch (error) {
      if (!(error instanceof DistillyError) || error.code !== "busy") throw error;
    }
    try {
      return await this.#projection.query(input);
    } catch (error) {
      if (!(error instanceof DistillyError) || error.code !== "busy") throw error;
      await this.#reconcile();
      return this.#projection.query(input);
    }
  }
}
