import { DistillyError } from "@distilly/protocol";
import type { EngineClient, LibraryPage } from "@distilly/protocol";

/**
 * Identifies the one deep Doctor response intentionally deferred by the Preview.
 *
 * @param error - Failure returned by the Doctor read.
 * @returns Whether recovery may continue without a Doctor snapshot.
 */
export const isDeferredPreviewDoctor = (error: unknown): boolean =>
  error instanceof DistillyError &&
  error.code === "schema_unsupported" &&
  error.retryable === false &&
  error.details?.["kind"] === "preview_method_deferred" &&
  error.details["method"] === "system.doctor";

/**
 * Discards all page cursors and completes the three Panel-wide recovery reads.
 *
 * @param client - Browser HTTP client whose query overload performs the reread.
 * @returns Completion after library, review, and doctor reads all validate.
 */
export const fullPanelReread = async (client: EngineClient): Promise<void> => {
  const readLibrary = async (): Promise<void> => {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page: LibraryPage = await client.call("library.list", {
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (seen.has(cursor)) throw new Error("Panel library cursor repeated during full reread.");
        seen.add(cursor);
      }
    } while (cursor !== undefined);
  };
  const readReviews = async (): Promise<void> => {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await client.call("reviews.list", {
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (seen.has(cursor)) throw new Error("Panel review cursor repeated during full reread.");
        seen.add(cursor);
      }
    } while (cursor !== undefined);
  };
  const readDoctor = async (): Promise<void> => {
    try {
      await client.call("system.doctor", {});
    } catch (error) {
      if (!isDeferredPreviewDoctor(error)) throw error;
    }
  };
  await Promise.all([readLibrary(), readReviews(), readDoctor()]);
};
