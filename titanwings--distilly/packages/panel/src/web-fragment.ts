import { reviewRefSchema } from "@distilly/protocol";
import type { ReviewRef } from "@distilly/protocol";

const TOKEN_PATTERN = /^[0-9a-f]{64}$/u;

export type PanelInitialRoute =
  { readonly kind: "library" } | { readonly kind: "review"; readonly review: ReviewRef };

/** Token and initial route extracted before asynchronous Panel work starts. */
export interface ConsumedPanelFragment {
  readonly token: string;
  readonly route: PanelInitialRoute;
}

/**
 * Reads the in-memory bearer token and immediately removes it from browser history.
 *
 * @param location - Current browser location containing the launch fragment.
 * @param history - Browser history used for synchronous token removal.
 * @returns The memory-only token and validated initial route.
 */
export const consumePanelFragment = (
  location: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState" | "state">,
): ConsumedPanelFragment => {
  const fragment = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  const segments = fragment.split("/");
  const token = segments[0];
  if (token === undefined || !TOKEN_PATTERN.test(token)) {
    throw new Error("Panel URL fragment does not contain a valid bearer token.");
  }

  const base = `${location.pathname}${location.search}`;
  history.replaceState(history.state, "", base);
  if (segments.length === 1) {
    return { token, route: { kind: "library" } };
  }

  if (segments.length !== 4 || segments[1] !== "review") {
    throw new Error("Panel URL fragment contains an unsupported route.");
  }
  const review = reviewRefSchema.parse({
    subjectId: segments[2],
    candidateVersionId: segments[3],
  });
  history.replaceState(
    history.state,
    "",
    `${base}#/review/${review.subjectId}/${review.candidateVersionId}`,
  );
  return { token, route: { kind: "review", review } };
};
