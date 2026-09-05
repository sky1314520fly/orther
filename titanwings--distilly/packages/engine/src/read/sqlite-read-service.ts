import type { DatabaseSync } from "node:sqlite";

import {
  DistillyError,
  eventIdSchema,
  isoDateTimeSchema,
  materialIdSchema,
  materialSetHashSchema,
  subjectIdSchema,
  versionIdSchema,
  WIRE_LIMITS,
} from "@distilly/protocol";
import type {
  EventId,
  EventRecord,
  DiffInput,
  GetMaterialInput,
  GetProfileInput,
  IsoDateTime,
  JsonObject,
  LibraryEntry,
  LibraryPage,
  LibraryPrivacy,
  LibraryQuery,
  LineageEvent,
  LineageInput,
  LineagePage,
  MaterialId,
  MaterialPage,
  MaterialQuery,
  MaterialSetHash,
  MaterialSummary,
  MaterialView,
  Profile,
  ProfileDiff,
  ResolveSubjectInput,
  ResolveSubjectResult,
  SourceGroupingContext,
  SubjectId,
  SubjectPage,
  SubjectQuery,
  SubjectRef,
  SubjectStatus,
  SubjectSummary,
  VersionId,
  VersionPage,
  VersionQuery,
} from "@distilly/protocol";

import { readSqliteReviewAuthorityInTransaction } from "../review/sqlite-authority.js";
import type { SqliteReviewAuthority } from "../review/sqlite-authority.js";
import { factNotFound, invalidInput, storageCorrupt } from "../internal-errors.js";
import { hashMaterialSet } from "../facts/digests.js";
import { deriveSourceGroups } from "../ingest/source-groups.js";
import { compareUtf8 } from "../profile/claim-id.js";
import { diffProfiles } from "../profile/diff.js";
import { renderProfile, renderPrompt } from "../profile/render.js";
import type { ContentAddressedBlobStore } from "../storage/content-addressed-blob-store.js";
import { readSqliteSubjectEventsInTransaction } from "../storage/sqlite-event-reader.js";
import type { SqliteEngineStore } from "../storage/sqlite-engine-store.js";
import {
  materialManifestFromSqlite,
  readSqliteMaterialsInTransaction,
  type SqliteMaterialDescriptor,
} from "../storage/sqlite-material-reader.js";
import { loadSubjectSummaryInTransaction } from "../subject/transactional-identity.js";
import {
  readSqliteVersionInTransaction,
  type SqliteStoredVersion,
} from "../version/sqlite-authority.js";
import { summarizeVersion } from "../version/summary.js";
import { decodeCursor, encodeCursor } from "./cursor.js";

const DEFAULT_PAGE_LIMIT = 50;
const SOURCE_GROUPING_VERSION = "source-groups-v1";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

interface SubjectAuthority {
  readonly summary: SubjectSummary;
  readonly state: SqliteReviewAuthority;
  readonly domainPack?: string;
}

interface MaterialSnapshot {
  readonly records: readonly SqliteMaterialDescriptor[];
  readonly currentMaterialIds: ReadonlySet<MaterialId>;
  readonly grouping: SourceGroupingContext;
}

interface CurrentMaterialAuthority {
  readonly generation: number;
  readonly materialSetHash?: MaterialSetHash;
  readonly pendingTotalMaterialCount?: number;
}

interface VersionLocator {
  readonly id: VersionId;
  readonly createdAt: IsoDateTime;
}

const parseStored = <T>(parse: () => T, label: string): T => {
  try {
    return parse();
  } catch (error) {
    throw storageCorrupt(`SQLite ${label} is invalid.`, error);
  }
};

const storedText = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw storageCorrupt(`SQLite ${label} is invalid.`);
  return value;
};

const storedNullableText = (value: unknown, label: string): string | undefined => {
  if (value === null) return undefined;
  return storedText(value, label);
};

const storedInteger = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw storageCorrupt(`SQLite ${label} is invalid.`);
  }
  return value;
};

const queryAll = (
  database: DatabaseSync,
  sql: string,
  values: readonly string[],
  label: string,
): readonly Readonly<Record<string, unknown>>[] => {
  try {
    return database.prepare(sql).all(...values);
  } catch (error) {
    throw storageCorrupt(`SQLite could not read ${label}.`, error);
  }
};

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

const readSubjectAuthority = (database: DatabaseSync, subjectId: SubjectId): SubjectAuthority => {
  const summary = loadSubjectSummaryInTransaction(database, subjectId);
  const state = readSqliteReviewAuthorityInTransaction(database, subjectId);
  if (summary.currentVersionId !== state.current?.version.id) {
    throw storageCorrupt("SQLite subject summary disagrees with current version authority.");
  }
  let domainPackRow: Readonly<Record<string, unknown>> | undefined;
  try {
    domainPackRow = database
      .prepare("SELECT domain_pack FROM subjects WHERE id = ?")
      .get(subjectId);
  } catch (error) {
    throw storageCorrupt("SQLite could not read subject domain pack.", error);
  }
  if (domainPackRow === undefined) {
    throw storageCorrupt("SQLite subject authority disappeared from its read snapshot.");
  }
  const domainPack = storedNullableText(domainPackRow.domain_pack, "subject domain pack");
  return {
    summary,
    state,
    ...(domainPack === undefined ? {} : { domainPack }),
  };
};

const statusFor = (authority: SubjectAuthority): SubjectStatus => ({
  subject: authority.summary,
  generation: authority.state.generation,
  ...(authority.state.materialSetHash === undefined
    ? {}
    : { materialSetHash: authority.state.materialSetHash }),
  ...(authority.state.pending === undefined ? {} : { pendingJobId: authority.state.pending.jobId }),
  ...(authority.state.suspended === undefined
    ? {}
    : { suspendedVersionId: authority.state.suspended.version.id }),
  ...(authority.state.current === undefined
    ? {}
    : { maturity: authority.state.current.version.quality.maturity }),
});

const listSubjectIds = (database: DatabaseSync): readonly SubjectId[] =>
  queryAll(database, "SELECT id FROM subjects ORDER BY id COLLATE BINARY", [], "subjects").map(
    (row) => parseStored(() => subjectIdSchema.parse(row.id), "subject id"),
  );

const listSubjects = (database: DatabaseSync): readonly SubjectSummary[] =>
  listSubjectIds(database)
    .map((subjectId) => loadSubjectSummaryInTransaction(database, subjectId))
    .sort(
      (left, right) =>
        compareUtf8(left.displayName, right.displayName) || compareUtf8(left.id, right.id),
    );

const normalizedText = (value: string): string => value.normalize("NFC").toLowerCase();

const normalizeResolutionQuery = (value: string): string => {
  const normalized = value.normalize("NFC").replace(/^[\t\n\r ]+|[\t\n\r ]+$/gu, "");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    Buffer.byteLength(normalized, "utf8") > WIRE_LIMITS.queryBytes
  ) {
    throw invalidInput("The subject resolution query is invalid.", "selector.query");
  }
  return normalized;
};

const identityValues = (subject: SubjectSummary): readonly string[] =>
  subject.identityHints.flatMap((hint): readonly string[] => {
    switch (hint.kind) {
      case "url":
      case "description":
        return [hint.value];
      case "account":
        return [hint.provider, hint.handle, `${hint.provider}:${hint.handle}`];
      case "external_id":
        return [hint.provider, hint.value, `${hint.provider}:${hint.value}`];
      default: {
        const exhaustive: never = hint;
        return exhaustive;
      }
    }
  });

const resolutionLocatorValues = (subject: SubjectSummary): readonly string[] =>
  subject.identityHints.flatMap((hint): readonly string[] => {
    switch (hint.kind) {
      case "url":
        return [hint.value];
      case "account":
        return [`${hint.provider}:${hint.handle}`];
      case "external_id":
        return [`${hint.provider}:${hint.value}`];
      case "description":
        return [];
      default: {
        const exhaustive: never = hint;
        return exhaustive;
      }
    }
  });

const subjectTextMatches = (subject: SubjectSummary, text: string): boolean => {
  const needle = normalizedText(text);
  return [
    subject.displayName,
    ...subject.aliases,
    subject.space.displayName,
    ...identityValues(subject),
  ].some((value) => normalizedText(value).includes(needle));
};

const subjectFilters = (input: SubjectQuery): JsonObject => ({
  ...(input.text === undefined ? {} : { text: input.text }),
  ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
  ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
});

const summaryCursorBoundary = (
  sort: readonly string[],
  label: "subject" | "Library",
): readonly [string, SubjectId] => {
  if (sort.length !== 2)
    throw invalidInput(`The ${label} cursor has an invalid sort tuple.`, "cursor");
  const [displayName, subjectId] = sort;
  if (
    displayName === undefined ||
    subjectId === undefined ||
    displayName.length === 0 ||
    Buffer.byteLength(displayName, "utf8") > WIRE_LIMITS.labelBytes
  ) {
    throw invalidInput(`The ${label} cursor has an invalid sort tuple.`, "cursor");
  }
  try {
    return [displayName, subjectIdSchema.parse(subjectId)];
  } catch {
    throw invalidInput(`The ${label} cursor has an invalid sort tuple.`, "cursor");
  }
};

const compareSummaryToCursor = (
  subject: SubjectSummary,
  boundary: readonly [string, SubjectId],
): number => compareUtf8(subject.displayName, boundary[0]) || compareUtf8(subject.id, boundary[1]);

const resolutionResult = (candidates: readonly SubjectSummary[]): ResolveSubjectResult => {
  if (candidates.length === 0) return { kind: "not_found" };
  if (candidates.length === 1) return { kind: "found", subject: candidates[0]! };
  const [first, second, ...rest] = candidates;
  if (first === undefined || second === undefined) {
    throw storageCorrupt("An ambiguous resolution is missing candidates.");
  }
  return { kind: "ambiguous", candidates: [first, second, ...rest] };
};

const selectedProfile = (database: DatabaseSync, input: GetProfileInput): Profile => {
  const subject = loadSubjectSummaryInTransaction(database, input.subjectId);
  const versionId = input.versionId ?? subject.currentVersionId;
  if (versionId === undefined) {
    throw factNotFound("The subject does not have a current profile version.");
  }
  const stored = readSqliteVersionInTransaction(database, input.subjectId, versionId);
  if (stored === undefined) {
    throw factNotFound("The selected immutable profile version does not exist.");
  }
  return profileFor(stored);
};

const readCurrentMaterialAuthority = (
  database: DatabaseSync,
  subjectId: SubjectId,
): CurrentMaterialAuthority => {
  loadSubjectSummaryInTransaction(database, subjectId);
  let row: Readonly<Record<string, unknown>> | undefined;
  try {
    row = database
      .prepare(
        `SELECT subject_states.generation, subject_states.material_set_hash,
                pending_jobs.total_material_count
         FROM subject_states
         LEFT JOIN pending_jobs ON pending_jobs.subject_id = subject_states.subject_id
         WHERE subject_states.subject_id = ?`,
      )
      .get(subjectId);
  } catch (error) {
    throw storageCorrupt("SQLite could not read current material-set authority.", error);
  }
  if (row === undefined) {
    throw storageCorrupt("SQLite material-set authority disappeared from its read snapshot.");
  }
  const generation = storedInteger(row.generation, "subject generation");
  const materialSetHashText = storedNullableText(row.material_set_hash, "material-set hash");
  const materialSetHash =
    materialSetHashText === undefined
      ? undefined
      : parseStored(() => materialSetHashSchema.parse(materialSetHashText), "material-set hash");
  if ((generation === 0) !== (materialSetHash === undefined)) {
    throw storageCorrupt("SQLite generation disagrees with current material-set authority.");
  }
  const pendingTotalMaterialCount =
    row.total_material_count === null
      ? undefined
      : storedInteger(row.total_material_count, "pending total material count");
  return {
    generation,
    ...(materialSetHash === undefined ? {} : { materialSetHash }),
    ...(pendingTotalMaterialCount === undefined ? {} : { pendingTotalMaterialCount }),
  };
};

const verifyCurrentMaterialSet = (
  authority: CurrentMaterialAuthority,
  materials: readonly SqliteMaterialDescriptor[],
): void => {
  if (authority.materialSetHash === undefined) {
    if (materials.length !== 0) {
      throw storageCorrupt("SQLite material rows exist without material-set authority.");
    }
  } else if (
    materials.length === 0 ||
    hashMaterialSet(materialManifestFromSqlite(materials)) !== authority.materialSetHash
  ) {
    throw storageCorrupt("SQLite material rows disagree with material-set authority.");
  }
  if (
    authority.pendingTotalMaterialCount !== undefined &&
    authority.pendingTotalMaterialCount !== materials.length
  ) {
    throw storageCorrupt("SQLite pending material count disagrees with current material rows.");
  }
};

const materialFilters = (input: MaterialQuery): JsonObject => ({
  subjectId: input.subjectId,
  ...(input.kind === undefined ? {} : { kind: input.kind }),
  ...(input.atVersionId === undefined ? {} : { atVersionId: input.atVersionId }),
});

const materialCursorBoundary = (sort: readonly string[]): MaterialId => {
  if (sort.length !== 1) {
    throw invalidInput("The material cursor has an invalid sort tuple.", "cursor");
  }
  try {
    return materialIdSchema.parse(sort[0]);
  } catch {
    throw invalidInput("The material cursor has an invalid sort tuple.", "cursor");
  }
};

const materialSnapshot = (
  database: DatabaseSync,
  subjectId: SubjectId,
  atVersionId?: VersionId,
): MaterialSnapshot => {
  const authority = readCurrentMaterialAuthority(database, subjectId);
  const current = readSqliteMaterialsInTransaction(database, subjectId);
  verifyCurrentMaterialSet(authority, current);
  const currentMaterialIds = new Set(current.map(({ record }) => record.id));
  if (atVersionId === undefined) {
    return {
      records: current,
      currentMaterialIds,
      grouping: {
        algorithmVersion: SOURCE_GROUPING_VERSION,
        generation: authority.generation,
      },
    };
  }

  const version = readSqliteVersionInTransaction(database, subjectId, atVersionId);
  if (version === undefined) {
    throw factNotFound("The selected immutable version does not exist for this subject.");
  }
  const currentById = new Map(current.map((descriptor) => [descriptor.record.id, descriptor]));
  const records = version.manifest.items.map((entry) => {
    const descriptor = currentById.get(entry.materialId);
    if (
      descriptor === undefined ||
      descriptor.record.contentDigest !== entry.contentDigest ||
      descriptor.record.provenanceDigest !== entry.provenanceDigest
    ) {
      throw storageCorrupt("A version material membership disagrees with material authority.");
    }
    return descriptor;
  });
  return {
    records,
    currentMaterialIds,
    grouping: {
      algorithmVersion: version.version.quality.sourceGroupingVersion,
      generation: version.version.generation,
      versionId: version.version.id,
    },
  };
};

const decodeBody = (bytes: Uint8Array): string => {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw storageCorrupt("A material content blob is not valid UTF-8.", error);
  }
};

const scalarCount = (value: string): number => Array.from(value).length;

const listVersionLocators = (
  database: DatabaseSync,
  subjectId: SubjectId,
): readonly VersionLocator[] =>
  queryAll(
    database,
    `SELECT id, created_at
     FROM versions
     WHERE subject_id = ?
     ORDER BY created_at DESC, id COLLATE BINARY`,
    [subjectId],
    "subject versions",
  ).map((row) => ({
    id: parseStored(() => versionIdSchema.parse(row.id), "version id"),
    createdAt: parseStored(() => isoDateTimeSchema.parse(row.created_at), "version creation time"),
  }));

const versionFilters = (input: VersionQuery): JsonObject => ({ subjectId: input.subjectId });

const compareVersionToCursor = (version: VersionLocator, sort: readonly string[]): number => {
  if (sort.length !== 2) {
    throw invalidInput("The version cursor has an invalid sort tuple.", "cursor");
  }
  const [createdAt, versionId] = sort;
  let parsedCreatedAt: IsoDateTime;
  let parsedVersionId: VersionId;
  try {
    parsedCreatedAt = isoDateTimeSchema.parse(createdAt);
    parsedVersionId = versionIdSchema.parse(versionId);
  } catch {
    throw invalidInput("The version cursor has an invalid sort tuple.", "cursor");
  }
  return version.createdAt === parsedCreatedAt
    ? compareUtf8(version.id, parsedVersionId)
    : version.createdAt > parsedCreatedAt
      ? -1
      : 1;
};

const lineageKind = (
  record: EventRecord,
  version: SqliteStoredVersion | undefined,
): LineageEvent["kind"] | undefined => {
  switch (record.event.kind) {
    case "version.current":
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
  version: SqliteStoredVersion | undefined,
): LineageEvent | undefined => {
  const kind = lineageKind(record, version);
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
  if (sort.length !== 2) {
    throw invalidInput("The lineage cursor has an invalid sort tuple.", "cursor");
  }
  const [at, eventId] = sort;
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

const privacyFor = (materials: readonly SqliteMaterialDescriptor[]): LibraryPrivacy => {
  if (materials.length === 0) return "none";
  const privateCount = materials.filter(({ record }) => record.sensitivity === "private").length;
  if (privateCount === 0) return "shareable";
  return privateCount === materials.length ? "private" : "mixed";
};

const lastChangedAt = (events: readonly EventRecord[]): IsoDateTime => {
  if (!events.some((record) => record.event.kind === "subject.created")) {
    throw storageCorrupt("A published subject has no creation-event baseline.");
  }
  const first = events[0];
  if (first === undefined) throw storageCorrupt("A published subject has no durable events.");
  return events.reduce(
    (latest, record) => (record.event.at > latest ? record.event.at : latest),
    first.event.at,
  );
};

const searchTermsFor = (
  authority: SubjectAuthority,
  privacy: LibraryPrivacy,
): readonly string[] => {
  const domains =
    authority.state.current === undefined
      ? []
      : Object.keys(profileFor(authority.state.current).domains);
  return [
    ...(authority.domainPack === undefined ? [] : [authority.domainPack]),
    ...domains,
    authority.summary.lifecycle,
    privacy,
    ...(authority.state.current === undefined
      ? []
      : [authority.state.current.version.quality.maturity]),
    ...(authority.state.pending === undefined ? [] : ["pending"]),
    ...(authority.state.suspended === undefined ? [] : ["suspended"]),
  ]
    .filter((term, index, terms) => terms.indexOf(term) === index)
    .sort(compareUtf8);
};

const libraryEntry = (database: DatabaseSync, subjectId: SubjectId): LibraryEntry => {
  const authority = readSubjectAuthority(database, subjectId);
  const materials = readSqliteMaterialsInTransaction(database, subjectId);
  verifyCurrentMaterialSet(
    {
      generation: authority.state.generation,
      ...(authority.state.materialSetHash === undefined
        ? {}
        : { materialSetHash: authority.state.materialSetHash }),
      ...(authority.state.pending === undefined
        ? {}
        : { pendingTotalMaterialCount: authority.state.pending.totalMaterialCount }),
    },
    materials,
  );
  const events = readSqliteSubjectEventsInTransaction(database, subjectId);
  const privacy = privacyFor(materials);
  const status = statusFor(authority);
  return {
    subject: authority.summary,
    status,
    privacy,
    searchTerms: searchTermsFor(authority, privacy),
    ...(authority.state.current === undefined
      ? {}
      : { currentQuality: authority.state.current.version.quality }),
    ...(authority.state.suspended === undefined
      ? {}
      : { suspendedQuality: authority.state.suspended.version.quality }),
    pendingJobs: authority.state.pending === undefined ? 0 : 1,
    suspendedVersions: authority.state.suspended === undefined ? 0 : 1,
    newMaterialCount: authority.state.pending?.addedMaterialCount ?? 0,
    lastChangedAt: lastChangedAt(events),
  };
};

const libraryFilters = (input: LibraryQuery): JsonObject => ({
  ...(input.text === undefined ? {} : { text: input.text }),
  ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
  ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
  ...(input.hasPending === undefined ? {} : { hasPending: input.hasPending }),
  ...(input.hasSuspended === undefined ? {} : { hasSuspended: input.hasSuspended }),
});

const libraryTextMatches = (entry: LibraryEntry, text: string): boolean => {
  const needle = normalizedText(text);
  return [
    entry.subject.displayName,
    ...entry.subject.aliases,
    entry.subject.space.displayName,
    ...identityValues(entry.subject),
    ...entry.searchTerms,
  ].some((value) => normalizedText(value).includes(needle));
};

/** Package-private verified reads over the Preview SQLite/WAL authority. */
export class SqliteReadService {
  readonly #store: SqliteEngineStore;
  readonly #blobs: ContentAddressedBlobStore;

  /**
   * Creates the read surface owned by one root-scoped Engine composition.
   * @param input - Root-scoped SQLite and blob authorities.
   * @param input.store - Consistent SQLite snapshot reader.
   * @param input.blobs - Content-addressed material body store.
   */
  constructor(input: {
    readonly store: SqliteEngineStore;
    readonly blobs: ContentAddressedBlobStore;
  }) {
    this.#store = input.store;
    this.#blobs = input.blobs;
  }

  /**
   * Lists a stable page of directly verified subject summaries.
   * @param input - Subject filters and optional cursor.
   * @returns A canonical subject page.
   */
  async listSubjects(input: SubjectQuery = {}): Promise<SubjectPage> {
    return Promise.resolve().then(() =>
      this.#store.read((database): SubjectPage => {
        const matching = listSubjects(database).filter(
          (subject) =>
            (input.text === undefined || subjectTextMatches(subject, input.text)) &&
            (input.spaceId === undefined || subject.space.id === input.spaceId) &&
            (input.lifecycle === undefined || subject.lifecycle === input.lifecycle),
        );
        const filters = subjectFilters(input);
        const boundary =
          input.cursor === undefined
            ? undefined
            : summaryCursorBoundary(
                decodeCursor(input.cursor, "subjects.list", filters),
                "subject",
              );
        const remaining =
          boundary === undefined
            ? matching
            : matching.filter((subject) => compareSummaryToCursor(subject, boundary) > 0);
        const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
        const items = remaining.slice(0, limit);
        const last = items.at(-1);
        return {
          items,
          ...(remaining.length <= limit || last === undefined
            ? {}
            : {
                nextCursor: encodeCursor("subjects.list", filters, [last.displayName, last.id]),
              }),
        };
      }),
    );
  }

  /**
   * Resolves an exact id, alias, provider-scoped hint, or display name.
   * @param input - Exact subject selector.
   * @returns Found, ambiguous, or absent resolution.
   */
  async resolveSubject(input: ResolveSubjectInput): Promise<ResolveSubjectResult> {
    return Promise.resolve().then(() =>
      this.#store.read((database): ResolveSubjectResult => {
        if (input.selector.kind === "id") {
          try {
            return {
              kind: "found",
              subject: loadSubjectSummaryInTransaction(database, input.selector.subjectId),
            };
          } catch (error) {
            if (error instanceof DistillyError && error.code === "not_found") {
              return { kind: "not_found" };
            }
            throw error;
          }
        }

        const selector = input.selector;
        const query = normalizeResolutionQuery(selector.query);
        const subjects = listSubjects(database).filter(
          (subject) => selector.spaceId === undefined || subject.space.id === selector.spaceId,
        );
        const exactId = subjects.filter((subject) => subject.id === query);
        if (exactId.length !== 0) return resolutionResult(exactId);
        const aliases = subjects.filter((subject) => subject.aliases.includes(query));
        if (aliases.length !== 0) return resolutionResult(aliases);
        const locators = subjects.filter((subject) =>
          resolutionLocatorValues(subject).includes(query),
        );
        if (locators.length !== 0) return resolutionResult(locators);
        return resolutionResult(subjects.filter((subject) => subject.displayName === query));
      }),
    );
  }

  /**
   * Returns one current or historical immutable profile.
   * @param input - Subject and optional immutable version selector.
   * @returns Deterministically rendered verified profile.
   */
  async getProfile(input: GetProfileInput): Promise<Profile> {
    return Promise.resolve().then(() =>
      this.#store.read((database) => selectedProfile(database, input)),
    );
  }

  /**
   * Renders the canonical prompt from one verified immutable profile.
   * @param input - Subject and optional immutable version selector.
   * @returns Byte-stable simulation prompt.
   */
  async prompt(input: GetProfileInput): Promise<string> {
    return renderPrompt(await this.getProfile(input));
  }

  /**
   * Aggregates current subject, pending, and version status.
   * @param input - Exact subject selector.
   * @returns Current verified subject status.
   */
  async status(input: SubjectRef): Promise<SubjectStatus> {
    return Promise.resolve().then(() =>
      this.#store.read((database) => statusFor(readSubjectAuthority(database, input.subjectId))),
    );
  }

  /**
   * Lists one MaterialId-ordered page and verifies only selected content blobs.
   * @param input - Subject snapshot, filters, and optional cursor.
   * @returns A canonical material page.
   */
  async listMaterials(input: MaterialQuery): Promise<MaterialPage> {
    const access = await this.#blobs.acquireReadAccess();
    try {
      const snapshot = this.#store.read((database) =>
        materialSnapshot(database, input.subjectId, input.atVersionId),
      );
      const groups = deriveSourceGroups(
        snapshot.records.map(({ record }) => record),
        snapshot.grouping.algorithmVersion,
      ).groups;
      const matching = snapshot.records.filter(
        ({ record }) => input.kind === undefined || record.kind === input.kind,
      );
      const filters = materialFilters(input);
      const boundary =
        input.cursor === undefined
          ? undefined
          : materialCursorBoundary(decodeCursor(input.cursor, "materials.list", filters));
      const remaining =
        boundary === undefined
          ? matching
          : matching.filter(({ record }) => compareUtf8(record.id, boundary) > 0);
      const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
      const selected = remaining.slice(0, limit);
      const items = await Promise.all(
        selected.map(async (descriptor): Promise<MaterialSummary> => {
          const sourceGroup = groups.get(descriptor.record.id);
          if (sourceGroup === undefined) {
            throw storageCorrupt("A grouped material snapshot is missing one manifest member.");
          }
          const content = decodeBody(
            await access.read(descriptor.blobDigest, descriptor.blobByteLength),
          );
          if (descriptor.rawBlob !== undefined) {
            await access.read(descriptor.rawBlob.digest, descriptor.rawBlob.byteLength);
          }
          return {
            record: descriptor.record,
            contentScalarCount: scalarCount(content),
            rawAvailable: descriptor.rawBlob !== undefined,
            inCurrentGeneration: snapshot.currentMaterialIds.has(descriptor.record.id),
            sourceGroup,
            grouping: snapshot.grouping,
          };
        }),
      );
      const last = selected.at(-1);
      return {
        items,
        ...(remaining.length <= limit || last === undefined
          ? {}
          : { nextCursor: encodeCursor("materials.list", filters, [last.record.id]) }),
      };
    } finally {
      await access.release();
    }
  }

  /**
   * Gets one exact material body from the current or selected historical snapshot.
   * @param input - Exact material locator and optional version snapshot.
   * @returns Verified material metadata, body, and grouping.
   */
  async getMaterial(input: GetMaterialInput): Promise<MaterialView> {
    const access = await this.#blobs.acquireReadAccess();
    try {
      const snapshot = this.#store.read((database) =>
        materialSnapshot(database, input.subjectId, input.atVersionId),
      );
      const selected = snapshot.records.find(({ record }) => record.id === input.materialId);
      if (selected === undefined) {
        throw factNotFound("The selected material is not present in this subject snapshot.");
      }
      const sourceGroup = deriveSourceGroups(
        snapshot.records.map(({ record }) => record),
        snapshot.grouping.algorithmVersion,
      ).groups.get(selected.record.id);
      if (sourceGroup === undefined) {
        throw storageCorrupt("A grouped material snapshot is missing the selected material.");
      }
      const content = decodeBody(await access.read(selected.blobDigest, selected.blobByteLength));
      if (selected.rawBlob !== undefined) {
        await access.read(selected.rawBlob.digest, selected.rawBlob.byteLength);
      }
      return {
        record: selected.record,
        content,
        rawAvailable: selected.rawBlob !== undefined,
        inCurrentGeneration: snapshot.currentMaterialIds.has(selected.record.id),
        sourceGroup,
        grouping: snapshot.grouping,
      };
    } finally {
      await access.release();
    }
  }

  /**
   * Lists one stable page of immutable version summaries.
   * @param input - Subject and optional page boundary.
   * @returns A canonical version page.
   */
  async listVersions(input: VersionQuery): Promise<VersionPage> {
    return Promise.resolve().then(() =>
      this.#store.read((database): VersionPage => {
        loadSubjectSummaryInTransaction(database, input.subjectId);
        const locators = listVersionLocators(database, input.subjectId);
        const filters = versionFilters(input);
        const boundary =
          input.cursor === undefined
            ? undefined
            : decodeCursor(input.cursor, "versions.list", filters);
        const remaining =
          boundary === undefined
            ? locators
            : locators.filter((locator) => compareVersionToCursor(locator, boundary) > 0);
        const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
        const selected = remaining.slice(0, limit);
        const items = selected.map((locator) => {
          const stored = readSqliteVersionInTransaction(database, input.subjectId, locator.id);
          if (stored === undefined || stored.version.createdAt !== locator.createdAt) {
            throw storageCorrupt("A listed version disappeared from its SQLite snapshot.");
          }
          return summarizeVersion(stored.version, stored.status);
        });
        const last = selected.at(-1);
        return {
          items,
          ...(remaining.length <= limit || last === undefined
            ? {}
            : {
                nextCursor: encodeCursor("versions.list", filters, [last.createdAt, last.id]),
              }),
        };
      }),
    );
  }

  /**
   * Computes a deterministic semantic diff between two immutable versions.
   * @param input - Subject and exact before/after version ids.
   * @returns Deterministic semantic profile diff.
   */
  async diffVersions(input: DiffInput): Promise<ProfileDiff> {
    return Promise.resolve().then(() =>
      this.#store.read((database): ProfileDiff => {
        loadSubjectSummaryInTransaction(database, input.subjectId);
        const before = readSqliteVersionInTransaction(database, input.subjectId, input.before);
        const after = readSqliteVersionInTransaction(database, input.subjectId, input.after);
        if (before === undefined || after === undefined) {
          throw factNotFound("A requested version diff references an unknown immutable version.");
        }
        return diffProfiles(profileFor(before), profileFor(after));
      }),
    );
  }

  /**
   * Lists stable durable lineage derived from verified subject event rows.
   * @param input - Subject and optional page boundary.
   * @returns A canonical lineage page.
   */
  async lineage(input: LineageInput): Promise<LineagePage> {
    return Promise.resolve().then(() =>
      this.#store.read((database): LineagePage => {
        loadSubjectSummaryInTransaction(database, input.subjectId);
        const versions = new Map<VersionId, SqliteStoredVersion>();
        const readVersion = (versionId: VersionId): SqliteStoredVersion => {
          const existing = versions.get(versionId);
          if (existing !== undefined) return existing;
          const stored = readSqliteVersionInTransaction(database, input.subjectId, versionId);
          if (stored === undefined) {
            throw storageCorrupt("A lineage event references a missing immutable version.");
          }
          versions.set(versionId, stored);
          return stored;
        };
        const events = readSqliteSubjectEventsInTransaction(database, input.subjectId)
          .flatMap((record) => {
            const version =
              record.event.versionId === undefined
                ? undefined
                : readVersion(record.event.versionId);
            if (record.relatedVersionId !== undefined) readVersion(record.relatedVersionId);
            const projected = toLineageEvent(record, version);
            return projected === undefined ? [] : [projected];
          })
          .sort(compareLineage);
        const filters = lineageFilters(input);
        const boundary =
          input.cursor === undefined
            ? undefined
            : decodeCursor(input.cursor, "versions.lineage", filters);
        const remaining =
          boundary === undefined
            ? events
            : events.filter((event) => compareLineageToCursor(event, boundary) > 0);
        const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
        const items = remaining.slice(0, limit);
        const last = items.at(-1);
        return {
          items,
          ...(remaining.length <= limit || last === undefined
            ? {}
            : { nextCursor: encodeCursor("versions.lineage", filters, [last.at, last.eventId]) }),
        };
      }),
    );
  }

  /**
   * Lists the local Library directly from one verified SQLite snapshot.
   * @param input - Library filters and optional page boundary.
   * @returns A canonical Library page.
   */
  async listLibrary(input: LibraryQuery = {}): Promise<LibraryPage> {
    return Promise.resolve().then(() =>
      this.#store.read((database): LibraryPage => {
        const entries = listSubjectIds(database)
          .map((subjectId) => libraryEntry(database, subjectId))
          .filter(
            (entry) =>
              (input.text === undefined || libraryTextMatches(entry, input.text)) &&
              (input.spaceId === undefined || entry.subject.space.id === input.spaceId) &&
              (input.lifecycle === undefined || entry.subject.lifecycle === input.lifecycle) &&
              (input.hasPending === undefined || (entry.pendingJobs === 1) === input.hasPending) &&
              (input.hasSuspended === undefined ||
                (entry.suspendedVersions === 1) === input.hasSuspended),
          )
          .sort(
            (left, right) =>
              compareUtf8(left.subject.displayName, right.subject.displayName) ||
              compareUtf8(left.subject.id, right.subject.id),
          );
        const filters = libraryFilters(input);
        const boundary =
          input.cursor === undefined
            ? undefined
            : summaryCursorBoundary(decodeCursor(input.cursor, "library.list", filters), "Library");
        const remaining =
          boundary === undefined
            ? entries
            : entries.filter((entry) => compareSummaryToCursor(entry.subject, boundary) > 0);
        const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
        const items = remaining.slice(0, limit);
        const last = items.at(-1);
        return {
          items,
          ...(remaining.length <= limit || last === undefined
            ? {}
            : {
                nextCursor: encodeCursor("library.list", filters, [
                  last.subject.displayName,
                  last.subject.id,
                ]),
              }),
        };
      }),
    );
  }
}
