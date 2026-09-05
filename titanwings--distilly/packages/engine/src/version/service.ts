import { eventIdSchema, isoDateTimeSchema, versionIdSchema } from "@distilly/protocol";
import type {
  DiffInput,
  EventId,
  EventRecord,
  IsoDateTime,
  JsonObject,
  LineageEvent,
  LineageInput,
  LineagePage,
  SubjectStateRecord,
  VersionPage,
  VersionQuery,
  VersionRecord,
  VersionStatus,
  VersionId,
} from "@distilly/protocol";

import type { StoredVersion } from "../facts/version-store.js";
import { factNotFound, invalidInput, storageCorrupt } from "../internal-errors.js";
import { compareUtf8 } from "../profile/claim-id.js";
import { diffProfiles } from "../profile/diff.js";
import type { CommittedVersionReader } from "../read/committed-version-reader.js";
import { decodeCursor, encodeCursor } from "../read/cursor.js";
import { summarizeVersion } from "./summary.js";

const DEFAULT_PAGE_LIMIT = 50;

const statusFor = (
  version: VersionRecord,
  state: SubjectStateRecord,
  rejected: ReadonlySet<string>,
): VersionStatus => {
  if (state.currentVersionId === version.id) return "current";
  if (state.suspendedVersionId === version.id) return "suspended";
  return rejected.has(version.id) ? "rejected" : "historical";
};

const compareVersion = (left: StoredVersion, right: StoredVersion): number =>
  left.version.createdAt === right.version.createdAt
    ? compareUtf8(left.version.id, right.version.id)
    : left.version.createdAt > right.version.createdAt
      ? -1
      : 1;

const compareVersionToCursor = (version: StoredVersion, sort: readonly string[]): number => {
  if (sort.length !== 2)
    throw invalidInput("The version cursor has an invalid sort tuple.", "cursor");
  const [createdAt, versionId] = sort;
  if (createdAt === undefined || versionId === undefined) {
    throw invalidInput("The version cursor has an invalid sort tuple.", "cursor");
  }
  let parsedCreatedAt: IsoDateTime;
  let parsedVersionId: VersionId;
  try {
    parsedCreatedAt = isoDateTimeSchema.parse(createdAt);
    parsedVersionId = versionIdSchema.parse(versionId);
  } catch {
    throw invalidInput("The version cursor has an invalid sort tuple.", "cursor");
  }
  return version.version.createdAt === parsedCreatedAt
    ? compareUtf8(version.version.id, parsedVersionId)
    : version.version.createdAt > parsedCreatedAt
      ? -1
      : 1;
};

const versionFilters = (input: VersionQuery): JsonObject => ({ subjectId: input.subjectId });

const lineageKind = (
  record: EventRecord,
  versions: ReadonlyMap<string, StoredVersion>,
): LineageEvent["kind"] | undefined => {
  switch (record.event.kind) {
    case "version.current": {
      const version = versions.get(record.event.versionId!);
      if (version === undefined) {
        throw storageCorrupt("A current-version event references a missing immutable version.");
      }
      switch (version.version.creation.kind) {
        case "correction":
          return "corrected";
        case "bundle_import":
          return "imported";
        case "host_distill":
        case "renderer_only":
          return version.version.parentId === undefined ? "created" : "committed";
        case "rollback":
          throw storageCorrupt("A rollback version must use the rolled-back event kind.");
        default: {
          const exhaustive: never = version.version.creation;
          return exhaustive;
        }
      }
    }
    case "version.suspended":
      return "suspended";
    case "version.promoted":
      return "promoted";
    case "version.rejected":
      return record.relatedVersionId === undefined ? "rejected" : "candidate_replaced";
    case "version.rolled_back":
      return "rolled_back";
    case "subject.created":
    case "subject.archived":
    case "subject.purged":
    case "material.ingested":
    case "job.changed":
    case "relation.changed":
      return undefined;
    default: {
      const exhaustive: never = record.event.kind;
      return exhaustive;
    }
  }
};

const toLineageEvent = (
  record: EventRecord,
  versions: ReadonlyMap<string, StoredVersion>,
): LineageEvent | undefined => {
  const kind = lineageKind(record, versions);
  if (kind === undefined) return undefined;
  return {
    eventId: record.eventId,
    kind,
    ...(record.event.versionId === undefined ? {} : { versionId: record.event.versionId }),
    ...(record.relatedVersionId === undefined ? {} : { relatedVersionId: record.relatedVersionId }),
    actor: record.actor,
    at: record.event.at,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  };
};

const compareLineage = (left: LineageEvent, right: LineageEvent): number =>
  left.at === right.at ? compareUtf8(left.eventId, right.eventId) : left.at > right.at ? -1 : 1;

const compareLineageToCursor = (event: LineageEvent, sort: readonly string[]): number => {
  if (sort.length !== 2)
    throw invalidInput("The lineage cursor has an invalid sort tuple.", "cursor");
  const [at, eventId] = sort;
  if (at === undefined || eventId === undefined) {
    throw invalidInput("The lineage cursor has an invalid sort tuple.", "cursor");
  }
  let parsedAt: IsoDateTime;
  let parsedEventId: EventId;
  try {
    parsedAt = isoDateTimeSchema.parse(at);
    parsedEventId = eventIdSchema.parse(eventId);
  } catch {
    throw invalidInput("The lineage cursor has an invalid sort tuple.", "cursor");
  }
  return event.at === parsedAt
    ? compareUtf8(event.eventId, parsedEventId)
    : event.at > parsedAt
      ? -1
      : 1;
};

const lineageFilters = (input: LineageInput): JsonObject => ({ subjectId: input.subjectId });

/** Verified immutable-version, semantic-diff, and lineage read operations. */
export class VersionService {
  readonly #committedVersions: CommittedVersionReader;

  /**
   * Creates version reads over authoritative state, immutable versions, and events.
   *
   * @param input - Coordinated committed-version snapshot reader.
   * @param input.committedVersions - Recovery- and lock-coordinated fact reader.
   */
  constructor(input: { readonly committedVersions: CommittedVersionReader }) {
    this.#committedVersions = input.committedVersions;
  }

  /**
   * Lists one stable page of verified immutable versions.
   *
   * @param input - Typed subject and page boundary.
   * @returns A stable page of version summaries.
   */
  async list(input: VersionQuery): Promise<VersionPage> {
    const result = await this.#committedVersions.withSnapshot(input.subjectId, (committed) => {
      const { events, state } = committed;
      const rejected = new Set(
        events
          .filter((event) => event.event.kind === "version.rejected")
          .map((event) => event.event.versionId!),
      );
      const sorted = [...committed.versions].sort(compareVersion);
      const filters = versionFilters(input);
      const boundary =
        input.cursor === undefined
          ? undefined
          : decodeCursor(input.cursor, "versions.list", filters);
      const remaining =
        boundary === undefined
          ? sorted
          : sorted.filter((version) => compareVersionToCursor(version, boundary) > 0);
      const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
      const selected = remaining.slice(0, limit);
      const items = selected.map((stored) =>
        summarizeVersion(stored.version, statusFor(stored.version, state, rejected)),
      );
      const last = selected.at(-1);
      return {
        items,
        ...(remaining.length <= limit || last === undefined
          ? {}
          : {
              nextCursor: encodeCursor("versions.list", filters, [
                last.version.createdAt,
                last.version.id,
              ]),
            }),
      };
    });
    return result;
  }

  /**
   * Computes a deterministic semantic diff between two verified versions.
   *
   * @param input - Typed subject and exact version pair.
   * @returns The deterministic profile diff.
   */
  async diff(input: DiffInput): Promise<ReturnType<typeof diffProfiles>> {
    const result = await this.#committedVersions.withSnapshot(input.subjectId, (committed) => {
      const before = committed.versionsById.get(input.before);
      const after = committed.versionsById.get(input.after);
      if (before === undefined || after === undefined) {
        throw factNotFound("A requested version diff references an unknown immutable version.");
      }
      return diffProfiles(before.profile, after.profile);
    });
    return result;
  }

  /**
   * Lists a stable page of durable version-lineage events.
   *
   * @param input - Typed subject and page boundary.
   * @returns A stable page of projected lineage events.
   */
  async lineage(input: LineageInput): Promise<LineagePage> {
    const result = await this.#committedVersions.withSnapshot(input.subjectId, (committed) => {
      const sorted = committed.events
        .flatMap((record) => {
          const event = toLineageEvent(record, committed.versionsById);
          return event === undefined ? [] : [event];
        })
        .sort(compareLineage);
      const filters = lineageFilters(input);
      const boundary =
        input.cursor === undefined
          ? undefined
          : decodeCursor(input.cursor, "versions.lineage", filters);
      const remaining =
        boundary === undefined
          ? sorted
          : sorted.filter((event) => compareLineageToCursor(event, boundary) > 0);
      const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
      const items = remaining.slice(0, limit);
      const last = items.at(-1);
      return {
        items,
        ...(remaining.length <= limit || last === undefined
          ? {}
          : { nextCursor: encodeCursor("versions.lineage", filters, [last.at, last.eventId]) }),
      };
    });
    return result;
  }
}
