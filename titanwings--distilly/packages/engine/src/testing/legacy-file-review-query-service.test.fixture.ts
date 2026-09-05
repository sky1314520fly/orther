import { isoDateTimeSchema, subjectIdSchema, versionIdSchema } from "@distilly/protocol";
import type {
  JsonObject,
  IsoDateTime,
  ReviewItem,
  ReviewPage,
  ReviewQuery,
  SubjectId,
  VersionId,
} from "@distilly/protocol";

import type { FileSubjectStore } from "../facts/subject-store.js";
import { invalidInput, storageCorrupt } from "../internal-errors.js";
import { compareUtf8 } from "../profile/claim-id.js";
import { diffProfiles } from "../profile/diff.js";
import type { CommittedVersionReader } from "../read/committed-version-reader.js";
import { decodeCursor, encodeCursor } from "../read/cursor.js";
import { summarizeVersion } from "../version/summary.js";

const DEFAULT_PAGE_LIMIT = 50;

const compareReview = (left: ReviewItem, right: ReviewItem): number => {
  if (left.candidate.createdAt !== right.candidate.createdAt) {
    return left.candidate.createdAt > right.candidate.createdAt ? -1 : 1;
  }
  const subjectOrder = compareUtf8(left.candidate.subjectId, right.candidate.subjectId);
  return subjectOrder === 0 ? compareUtf8(left.candidate.id, right.candidate.id) : subjectOrder;
};

const compareReviewToCursor = (item: ReviewItem, sort: readonly string[]): number => {
  if (sort.length !== 3)
    throw invalidInput("The review cursor has an invalid sort tuple.", "cursor");
  const [createdAt, subjectId, versionId] = sort;
  if (createdAt === undefined || subjectId === undefined || versionId === undefined) {
    throw invalidInput("The review cursor has an invalid sort tuple.", "cursor");
  }
  let parsedCreatedAt: IsoDateTime;
  let parsedSubjectId: SubjectId;
  let parsedVersionId: VersionId;
  try {
    parsedCreatedAt = isoDateTimeSchema.parse(createdAt);
    parsedSubjectId = subjectIdSchema.parse(subjectId);
    parsedVersionId = versionIdSchema.parse(versionId);
  } catch {
    throw invalidInput("The review cursor has an invalid sort tuple.", "cursor");
  }
  if (item.candidate.createdAt !== parsedCreatedAt) {
    return item.candidate.createdAt > parsedCreatedAt ? -1 : 1;
  }
  const subjectOrder = compareUtf8(item.candidate.subjectId, parsedSubjectId);
  return subjectOrder === 0 ? compareUtf8(item.candidate.id, parsedVersionId) : subjectOrder;
};

const queryFilters = (input: ReviewQuery): JsonObject =>
  input.subjectId === undefined ? {} : { subjectId: input.subjectId };

/** Retired file-fact review query retained only by unmigrated verified-read tests. */
export class LegacyFileReviewQueryService {
  readonly #subjects: FileSubjectStore;
  readonly #committedVersions: CommittedVersionReader;

  /**
   * Creates the retired file-fact query used only by unmigrated read tests.
   *
   * @param input - File stores and coordinated committed-version reader.
   * @param input.subjects - Retired published subject facts.
   * @param input.committedVersions - Retired coordinated committed-version snapshot reader.
   */
  constructor(input: {
    readonly subjects: FileSubjectStore;
    readonly committedVersions: CommittedVersionReader;
  }) {
    this.#subjects = input.subjects;
    this.#committedVersions = input.committedVersions;
  }

  /**
   * Lists one stable page from the retired file-backed review facts.
   *
   * @param input - Optional subject filter and cursor boundary.
   * @returns A verified review page for legacy read regression coverage.
   */
  async list(input: ReviewQuery = {}): Promise<ReviewPage> {
    await this.#committedVersions.reconcile();
    const subjects =
      input.subjectId === undefined
        ? await this.#subjects.listAll()
        : [await this.#subjects.read(input.subjectId)];
    const items: ReviewItem[] = [];
    for (const subject of subjects) {
      const item = await this.#committedVersions.withReconciledSnapshot(subject.id, (committed) => {
        const { state } = committed;
        if (state.suspendedVersionId === undefined) return undefined;
        const candidate = committed.versionsById.get(state.suspendedVersionId);
        if (candidate === undefined) {
          throw storageCorrupt("An active review references a missing committed candidate.");
        }
        const reasons = candidate.version.reviewReasons;
        if (reasons === undefined) {
          throw storageCorrupt(
            "An active suspended version is missing its canonical review reasons.",
          );
        }
        const current =
          state.currentVersionId === undefined
            ? undefined
            : committed.versionsById.get(state.currentVersionId);
        if (state.currentVersionId !== undefined && current === undefined) {
          throw storageCorrupt("An active review references a missing committed current version.");
        }
        return {
          candidate: summarizeVersion(candidate.version, "suspended"),
          ...(current === undefined
            ? {}
            : { current: summarizeVersion(current.version, "current") }),
          reasons,
          diff: diffProfiles(current?.profile, candidate.profile),
        } satisfies ReviewItem;
      });
      if (item !== undefined) items.push(item);
    }

    items.sort(compareReview);
    const filters = queryFilters(input);
    const boundary =
      input.cursor === undefined ? undefined : decodeCursor(input.cursor, "reviews.list", filters);
    const remaining =
      boundary === undefined
        ? items
        : items.filter((item) => compareReviewToCursor(item, boundary) > 0);
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    const selected = remaining.slice(0, limit);
    const last = selected.at(-1);
    return {
      items: selected,
      ...(remaining.length <= limit || last === undefined
        ? {}
        : {
            nextCursor: encodeCursor("reviews.list", filters, [
              last.candidate.createdAt,
              last.candidate.subjectId,
              last.candidate.id,
            ]),
          }),
    };
  }
}
