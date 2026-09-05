import { isoDateTimeSchema, subjectIdSchema, versionIdSchema } from "@distilly/protocol";
import type {
  JsonObject,
  IsoDateTime,
  Profile,
  ReviewItem,
  ReviewPage,
  ReviewQuery,
  SubjectId,
  VersionId,
} from "@distilly/protocol";

import { invalidInput } from "../internal-errors.js";
import { compareUtf8 } from "../profile/claim-id.js";
import { diffProfiles } from "../profile/diff.js";
import { renderProfile } from "../profile/render.js";
import { decodeCursor, encodeCursor } from "../read/cursor.js";
import type { SqliteEngineStore } from "../storage/sqlite-engine-store.js";
import type { SqliteStoredVersion } from "../version/sqlite-authority.js";
import { summarizeVersion } from "../version/summary.js";
import {
  listSqliteReviewSubjectIdsInTransaction,
  readSqliteActiveReviewAuthorityInTransaction,
} from "./sqlite-authority.js";

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

const profileFor = (stored: SqliteStoredVersion): Profile => {
  const rendered = renderProfile({
    subjectId: stored.version.subjectId,
    displayName: stored.version.subjectDisplayName,
    versionId: stored.version.id,
    claims: stored.claims.claims,
    quality: stored.version.quality,
  });
  return {
    subjectId: stored.version.subjectId,
    displayName: stored.version.subjectDisplayName,
    versionId: stored.version.id,
    claims: stored.claims.claims,
    core: rendered.core,
    domains: rendered.domains,
    rendered: rendered.markdown,
    quality: stored.version.quality,
  };
};

/** Verified projection of the currently active suspended candidate for each subject. */
export class ReviewQueryService {
  readonly #store: SqliteEngineStore;

  /**
   * Creates review reads over authoritative subject state and immutable versions.
   *
   * @param input - SQLite authority used for one consistent review snapshot.
   * @param input.store - Single-writer Engine store with snapshot reads.
   */
  constructor(input: { readonly store: SqliteEngineStore }) {
    this.#store = input.store;
  }

  /**
   * Lists one stable page of authoritative active reviews.
   *
   * @param input - Typed optional subject filter and page boundary.
   * @returns A verified page of current-versus-candidate review items.
   */
  list(input: ReviewQuery = {}): Promise<ReviewPage> {
    return Promise.resolve().then(() => {
      const items = this.#store.read((database): ReviewItem[] => {
        const subjectIds =
          input.subjectId === undefined
            ? listSqliteReviewSubjectIdsInTransaction(database)
            : [input.subjectId];
        return subjectIds.flatMap((subjectId) => {
          const authority = readSqliteActiveReviewAuthorityInTransaction(database, subjectId);
          const candidate = authority.suspended;
          if (candidate === undefined) return [];
          const reasons = candidate.version.reviewReasons;
          if (reasons === undefined) return [];
          const current = authority.current;
          return [
            {
              candidate: summarizeVersion(candidate.version, "suspended"),
              ...(current === undefined
                ? {}
                : { current: summarizeVersion(current.version, "current") }),
              reasons,
              diff: diffProfiles(
                current === undefined ? undefined : profileFor(current),
                profileFor(candidate),
              ),
            } satisfies ReviewItem,
          ];
        });
      });

      items.sort(compareReview);
      const filters = queryFilters(input);
      const boundary =
        input.cursor === undefined
          ? undefined
          : decodeCursor(input.cursor, "reviews.list", filters);
      const remaining =
        boundary === undefined
          ? items
          : items.filter((item) => compareReviewToCursor(item, boundary) > 0);
      const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
      const selected = remaining.slice(0, limit);
      const last = selected.at(-1);
      const result: ReviewPage = {
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
      return result;
    });
  }
}
