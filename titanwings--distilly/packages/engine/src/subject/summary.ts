import type {
  SpaceRecord,
  SubjectRecord,
  SubjectStateRecord,
  SubjectSummary,
} from "@distilly/protocol";

/**
 * Projects verified legacy facts into the shared public identity summary.
 *
 * @param subject - Verified subject identity fact.
 * @param space - Verified owning space fact.
 * @param state - Verified authoritative subject state.
 * @returns The complete public subject summary.
 */
export const summarizeSubject = (
  subject: SubjectRecord,
  space: SpaceRecord,
  state: SubjectStateRecord,
): SubjectSummary => ({
  id: subject.id,
  displayName: subject.displayName,
  aliases: subject.aliases,
  identityHints: subject.identityHints,
  space: { id: space.id, displayName: space.displayName, kind: space.kind },
  lifecycle: subject.lifecycle,
  ...(state.currentVersionId === undefined ? {} : { currentVersionId: state.currentVersionId }),
});
