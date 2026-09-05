import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import {
  DistillyError,
  BUILTIN_PEOPLE_SPACE_ID,
  materialSetHashSchema,
  spaceIdSchema,
  spaceSummarySchema,
  subjectIdSchema,
  subjectSummarySchema,
  versionIdSchema,
} from "@distilly/protocol";
import type {
  IdentityHint,
  SpaceId,
  SpaceSummary,
  SubjectId,
  SubjectSummary,
  VersionId,
} from "@distilly/protocol";

import {
  ambiguousSubject,
  factNotFound,
  storageCorrupt,
  subjectAlreadyExists,
} from "../internal-errors.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { NormalizedCreateSubjectInput } from "./identity.js";
import { findCreateConflict, normalizeCreateSubjectInput, normalizeLabelV1 } from "./identity.js";

interface SpaceRow {
  readonly id: unknown;
  readonly display_name: unknown;
  readonly canonical_label: unknown;
  readonly kind: unknown;
}

interface SubjectRow {
  readonly id: unknown;
  readonly space_id: unknown;
  readonly display_name: unknown;
  readonly canonical_label: unknown;
  readonly domain_pack: unknown;
  readonly lifecycle: unknown;
}

interface StateRow {
  readonly generation: unknown;
  readonly material_set_hash: unknown;
  readonly current_version_id: unknown;
  readonly suspended_version_id: unknown;
}

interface AliasRow {
  readonly alias: unknown;
  readonly canonical_label: unknown;
}

interface HintRow {
  readonly hint_key: unknown;
  readonly kind: unknown;
  readonly provider: unknown;
  readonly value: unknown;
  readonly locator_key: unknown;
}

interface SubjectIdRow {
  readonly subject_id: unknown;
}

interface AliasSubjectRow extends SubjectIdRow {
  readonly space_id: unknown;
  readonly existing_space_id: unknown;
}

const storedText = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw storageCorrupt(`SQLite ${label} is invalid.`);
  return value;
};

const storedNullableText = (value: unknown, label: string): string | undefined => {
  if (value === null) return undefined;
  return storedText(value, label);
};

const parseStored = <T>(parse: () => T, label: string): T => {
  try {
    return parse();
  } catch (error) {
    if (error instanceof DistillyError && error.code === "storage_corrupt") throw error;
    throw storageCorrupt(`SQLite ${label} is invalid.`, error);
  }
};

const queryOne = <T>(
  database: DatabaseSync,
  sql: string,
  values: readonly SQLInputValue[],
  label: string,
): T | undefined => {
  try {
    return database.prepare(sql).get(...values) as T | undefined;
  } catch (error) {
    throw storageCorrupt(`SQLite could not read ${label}.`, error);
  }
};

const queryAll = <T>(
  database: DatabaseSync,
  sql: string,
  values: readonly SQLInputValue[],
  label: string,
): readonly T[] => {
  try {
    return database.prepare(sql).all(...values) as unknown as readonly T[];
  } catch (error) {
    throw storageCorrupt(`SQLite could not read ${label}.`, error);
  }
};

const executeInsert = (
  database: DatabaseSync,
  sql: string,
  values: readonly SQLInputValue[],
  label: string,
): void => {
  try {
    database.prepare(sql).run(...values);
  } catch (error) {
    if (error instanceof DistillyError) throw error;
    throw storageCorrupt(`SQLite could not persist ${label}.`, error);
  }
};

const identityHintKey = (hint: IdentityHint): string => {
  switch (hint.kind) {
    case "url":
      return `url\0${hint.value}`;
    case "account":
      return `account\0${hint.provider}\0${hint.handle}`;
    case "external_id":
      return `external_id\0${hint.provider}\0${hint.value}`;
    case "description":
      return `description\0${hint.value}`;
  }
};

const storedIdentityHintKey = (hint: IdentityHint): string =>
  Buffer.from(identityHintKey(hint), "utf8").toString("hex");

const parseSpaceRow = (row: SpaceRow): SpaceSummary => {
  const id = parseStored(() => spaceIdSchema.parse(row.id), "space id");
  const displayName = storedText(row.display_name, "space display name");
  const canonicalLabel = storedText(row.canonical_label, "space canonical label");
  const expectedLabel = parseStored(
    () => normalizeLabelV1(displayName, "space.displayName"),
    "space display name",
  );
  if (canonicalLabel !== expectedLabel) {
    throw storageCorrupt("SQLite space display name disagrees with its canonical label.");
  }
  return parseStored(
    () =>
      spaceSummarySchema.parse({
        id,
        displayName,
        kind: row.kind,
      }),
    "space record",
  );
};

const loadSpace = (database: DatabaseSync, spaceId: SpaceId): SpaceSummary | undefined => {
  const row = queryOne<SpaceRow>(
    database,
    `SELECT id, display_name, canonical_label, kind
     FROM spaces
     WHERE id = ?`,
    [spaceId],
    "a space",
  );
  return row === undefined ? undefined : parseSpaceRow(row);
};

const spaceHasSubjectReferences = (database: DatabaseSync, spaceId: SpaceId): boolean =>
  queryOne<{ readonly present: unknown }>(
    database,
    "SELECT 1 AS present FROM subjects WHERE space_id = ? LIMIT 1",
    [spaceId],
    "subject references to a space",
  ) !== undefined;

const verifyBuiltinPeopleSpace = (space: SpaceSummary): SpaceSummary => {
  if (
    space.id !== BUILTIN_PEOPLE_SPACE_ID ||
    space.displayName !== "People" ||
    space.kind !== "people"
  ) {
    throw storageCorrupt("The built-in People space does not match its canonical identity.");
  }
  return space;
};

const resolveSpace = (
  database: DatabaseSync,
  input: NormalizedCreateSubjectInput,
  ids: Pick<IdGenerator, "spaceId">,
): SpaceSummary => {
  if (input.space.kind === "existing") {
    const existing = loadSpace(database, input.space.spaceId);
    if (existing === undefined) {
      if (spaceHasSubjectReferences(database, input.space.spaceId)) {
        throw storageCorrupt("Subjects reference a missing requested space.");
      }
      throw factNotFound("The requested subject space was not found.");
    }
    return existing;
  }

  if (input.space.kind === "builtin_people") {
    const existing = loadSpace(database, BUILTIN_PEOPLE_SPACE_ID);
    if (existing !== undefined) return verifyBuiltinPeopleSpace(existing);
    if (spaceHasSubjectReferences(database, BUILTIN_PEOPLE_SPACE_ID)) {
      throw storageCorrupt("Subjects reference the missing built-in People space.");
    }
    executeInsert(
      database,
      `INSERT INTO spaces(id, display_name, canonical_label, kind)
       VALUES (?, ?, ?, ?)`,
      [BUILTIN_PEOPLE_SPACE_ID, "People", "People", "people"],
      "the built-in People space",
    );
    const created = loadSpace(database, BUILTIN_PEOPLE_SPACE_ID);
    if (created === undefined) {
      throw storageCorrupt("The built-in People space disappeared during creation.");
    }
    return verifyBuiltinPeopleSpace(created);
  }

  const existing = queryOne<SpaceRow>(
    database,
    `SELECT id, display_name, canonical_label, kind
     FROM spaces
     WHERE kind = ? AND canonical_label = ?`,
    [input.space.spaceKind, input.space.displayName],
    "an inline space",
  );
  if (existing !== undefined) {
    const parsed = parseSpaceRow(existing);
    if (parsed.displayName !== input.space.displayName || parsed.kind !== input.space.spaceKind) {
      throw storageCorrupt("An inline space lookup returned a conflicting canonical identity.");
    }
    return parsed;
  }

  const spaceId = parseStored(() => spaceIdSchema.parse(ids.spaceId()), "generated space id");
  executeInsert(
    database,
    `INSERT INTO spaces(id, display_name, canonical_label, kind)
     VALUES (?, ?, ?, ?)`,
    [spaceId, input.space.displayName, input.space.displayName, input.space.spaceKind],
    "an inline space",
  );
  const created = loadSpace(database, spaceId);
  if (created === undefined) throw storageCorrupt("An inline space disappeared during creation.");
  return created;
};

const parseAliasRows = (rows: readonly AliasRow[]): readonly string[] =>
  rows.map((row) => {
    const alias = storedText(row.alias, "subject alias");
    const canonicalLabel = storedText(row.canonical_label, "subject alias canonical label");
    const expected = parseStored(() => normalizeLabelV1(alias, "aliases"), "subject alias");
    if (canonicalLabel !== expected) {
      throw storageCorrupt("SQLite subject alias disagrees with its canonical label.");
    }
    return alias;
  });

const parseHintRow = (row: HintRow): IdentityHint => {
  const hintKey = storedText(row.hint_key, "identity hint key");
  const kind = storedText(row.kind, "identity hint kind");
  const provider = storedNullableText(row.provider, "identity hint provider");
  const value = storedText(row.value, "identity hint value");
  const locatorKey = storedNullableText(row.locator_key, "identity locator key");
  let hint: IdentityHint;
  switch (kind) {
    case "url":
      if (provider !== undefined) {
        throw storageCorrupt("A URL identity hint cannot have a provider.");
      }
      hint = { kind, value };
      break;
    case "account":
      if (provider === undefined) {
        throw storageCorrupt("An account identity hint is missing its provider.");
      }
      hint = { kind, provider, handle: value };
      break;
    case "external_id":
      if (provider === undefined) {
        throw storageCorrupt("An external identity hint is missing its provider.");
      }
      hint = { kind, provider, value };
      break;
    case "description":
      if (provider !== undefined) {
        throw storageCorrupt("A description identity hint cannot have a provider.");
      }
      hint = { kind, value };
      break;
    default:
      throw storageCorrupt("SQLite identity hint kind is unsupported.");
  }
  const expectedKey = storedIdentityHintKey(hint);
  const normalizedHint = parseStored(
    () =>
      normalizeCreateSubjectInput({ displayName: "Stored identity", identityHints: [hint] })
        .identityHints[0],
    "identity hint",
  );
  if (normalizedHint === undefined || identityHintKey(normalizedHint) !== identityHintKey(hint)) {
    throw storageCorrupt("SQLite identity hint is not canonically normalized.");
  }
  if (hintKey !== expectedKey) {
    throw storageCorrupt("SQLite identity hint disagrees with its canonical key.");
  }
  const expectedLocator = hint.kind === "description" ? undefined : expectedKey;
  if (locatorKey !== expectedLocator) {
    throw storageCorrupt("SQLite identity hint disagrees with its locator key.");
  }
  return hint;
};

const validateVersionPointer = (
  database: DatabaseSync,
  subjectId: SubjectId,
  value: string | undefined,
  expectedStatus: "current" | "suspended",
): VersionId | undefined => {
  if (value === undefined) return undefined;
  const versionId = parseStored(() => versionIdSchema.parse(value), `${expectedStatus} version id`);
  const row = queryOne<{
    readonly subject_id: unknown;
    readonly status: unknown;
    readonly status_subject_id: unknown;
  }>(
    database,
    `SELECT versions.subject_id, version_statuses.status,
            version_statuses.subject_id AS status_subject_id
     FROM versions
     LEFT JOIN version_statuses ON version_statuses.version_id = versions.id
     WHERE versions.id = ?`,
    [versionId],
    `the ${expectedStatus} version pointer`,
  );
  if (
    row === undefined ||
    row.subject_id !== subjectId ||
    row.status_subject_id !== subjectId ||
    row.status !== expectedStatus
  ) {
    throw storageCorrupt(`SQLite ${expectedStatus} version pointer is inconsistent.`);
  }
  return versionId;
};

const validateStateRow = (
  database: DatabaseSync,
  subjectId: SubjectId,
  row: StateRow,
): VersionId | undefined => {
  if (typeof row.generation !== "number" || !Number.isSafeInteger(row.generation)) {
    throw storageCorrupt("SQLite subject generation is invalid.");
  }
  if (row.generation < 0) throw storageCorrupt("SQLite subject generation is negative.");
  const materialSetHash = storedNullableText(row.material_set_hash, "material-set hash");
  if (materialSetHash !== undefined) {
    parseStored(() => materialSetHashSchema.parse(materialSetHash), "material-set hash");
  }
  if ((row.generation === 0) !== (materialSetHash === undefined)) {
    throw storageCorrupt("SQLite subject generation disagrees with its material-set hash.");
  }
  const currentVersionId = storedNullableText(row.current_version_id, "current version id");
  const suspendedVersionId = storedNullableText(row.suspended_version_id, "suspended version id");
  const current = validateVersionPointer(database, subjectId, currentVersionId, "current");
  validateVersionPointer(database, subjectId, suspendedVersionId, "suspended");
  return current;
};

/**
 * Loads one complete subject identity while the caller owns the SQLite transaction.
 *
 * @param database - Database connection inside the caller's active transaction.
 * @param subjectId - Engine-owned subject identity to load.
 * @returns The strictly validated public subject summary.
 */
export const loadSubjectSummaryInTransaction = (
  database: DatabaseSync,
  subjectId: SubjectId,
): SubjectSummary => {
  const parsedSubjectId = parseStored(() => subjectIdSchema.parse(subjectId), "subject id");
  const subject = queryOne<SubjectRow>(
    database,
    `SELECT id, space_id, display_name, canonical_label, domain_pack, lifecycle
     FROM subjects
     WHERE id = ?`,
    [parsedSubjectId],
    "a subject",
  );
  if (subject === undefined) throw factNotFound("The requested subject was not found.");

  const storedSubjectId = parseStored(() => subjectIdSchema.parse(subject.id), "subject id");
  if (storedSubjectId !== parsedSubjectId) {
    throw storageCorrupt("SQLite returned a different subject than requested.");
  }
  const spaceId = parseStored(() => spaceIdSchema.parse(subject.space_id), "subject space id");
  const displayName = storedText(subject.display_name, "subject display name");
  const canonicalLabel = storedText(subject.canonical_label, "subject canonical label");
  const expectedLabel = parseStored(() => normalizeLabelV1(displayName), "subject display name");
  if (canonicalLabel !== expectedLabel) {
    throw storageCorrupt("SQLite subject display name disagrees with its canonical label.");
  }
  const domainPack = subject.domain_pack;
  if (domainPack !== null && typeof domainPack !== "string") {
    throw storageCorrupt("SQLite subject domain pack is invalid.");
  }
  if (
    typeof domainPack === "string" &&
    parseStored(() => normalizeLabelV1(domainPack, "domainPack"), "subject domain pack") !==
      domainPack
  ) {
    throw storageCorrupt("SQLite subject domain pack is not canonically normalized.");
  }

  const loadedSpace = loadSpace(database, spaceId);
  if (loadedSpace === undefined) throw storageCorrupt("A subject is missing its owning space.");
  const space =
    spaceId === BUILTIN_PEOPLE_SPACE_ID ? verifyBuiltinPeopleSpace(loadedSpace) : loadedSpace;
  const state = queryOne<StateRow>(
    database,
    `SELECT generation, material_set_hash, current_version_id, suspended_version_id
     FROM subject_states
     WHERE subject_id = ?`,
    [parsedSubjectId],
    "subject state",
  );
  if (state === undefined) throw storageCorrupt("A subject is missing its authoritative state.");
  const currentVersionId = validateStateRow(database, parsedSubjectId, state);

  const aliases = parseAliasRows(
    queryAll<AliasRow>(
      database,
      `SELECT alias, canonical_label
       FROM subject_aliases
       WHERE subject_id = ?
       ORDER BY canonical_label COLLATE BINARY`,
      [parsedSubjectId],
      "subject aliases",
    ),
  );
  const identityHints = queryAll<HintRow>(
    database,
    `SELECT hint_key, kind, provider, value, locator_key
     FROM subject_identity_hints
     WHERE subject_id = ?
     ORDER BY hint_key COLLATE BINARY`,
    [parsedSubjectId],
    "subject identity hints",
  ).map(parseHintRow);

  return parseStored(
    () =>
      subjectSummarySchema.parse({
        id: parsedSubjectId,
        displayName,
        aliases,
        identityHints,
        space,
        lifecycle: subject.lifecycle,
        ...(currentVersionId === undefined ? {} : { currentVersionId }),
      }),
    "subject summary",
  ) as SubjectSummary;
};

const loadReferencedSubjectSummary = (
  database: DatabaseSync,
  subjectId: SubjectId,
  label: string,
): SubjectSummary => {
  try {
    return loadSubjectSummaryInTransaction(database, subjectId);
  } catch (error) {
    if (error instanceof DistillyError && error.code === "not_found") {
      throw storageCorrupt(`SQLite ${label} points to a missing subject.`, error);
    }
    throw error;
  }
};

const exactLocatorSubject = (
  database: DatabaseSync,
  input: NormalizedCreateSubjectInput,
): SubjectSummary | undefined => {
  const subjectIds = new Set<SubjectId>();
  for (const hint of input.identityHints) {
    if (hint.kind === "description") continue;
    const rows = queryAll<SubjectIdRow>(
      database,
      `SELECT subject_id
       FROM subject_identity_hints
       WHERE locator_key = ?
       ORDER BY subject_id COLLATE BINARY`,
      [storedIdentityHintKey(hint)],
      "an identity locator",
    );
    if (rows.length > 1) {
      throw storageCorrupt("More than one subject owns the same canonical identity locator.");
    }
    for (const row of rows) {
      subjectIds.add(
        parseStored(() => subjectIdSchema.parse(row.subject_id), "identity locator subject id"),
      );
    }
  }
  if (subjectIds.size > 1) {
    const candidates = [...subjectIds]
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((subjectId) => loadReferencedSubjectSummary(database, subjectId, "identity locator"));
    const [first, second, ...rest] = candidates;
    if (first === undefined || second === undefined) {
      throw storageCorrupt("An ambiguous locator result requires at least two candidates.");
    }
    throw ambiguousSubject([first, second, ...rest]);
  }
  const [subjectId] = subjectIds;
  return subjectId === undefined
    ? undefined
    : loadReferencedSubjectSummary(database, subjectId, "identity locator");
};

const sameSpaceNameCandidates = (
  database: DatabaseSync,
  input: NormalizedCreateSubjectInput,
  spaceId: SpaceId,
): readonly SubjectSummary[] => {
  const labels = [input.displayName, ...input.aliases];
  const placeholders = labels.map(() => "?").join(", ");
  const directRows = queryAll<SubjectIdRow>(
    database,
    `SELECT id AS subject_id
     FROM subjects
     WHERE space_id = ? AND canonical_label IN (${placeholders})
     ORDER BY subject_id COLLATE BINARY`,
    [spaceId, ...labels],
    "same-space subject display names",
  );
  const aliasRows = queryAll<AliasSubjectRow>(
    database,
    `SELECT aliases.subject_id, subjects.space_id, spaces.id AS existing_space_id
     FROM subject_aliases AS aliases
     LEFT JOIN subjects ON subjects.id = aliases.subject_id
     LEFT JOIN spaces ON spaces.id = subjects.space_id
     WHERE aliases.canonical_label IN (${placeholders})
     ORDER BY aliases.subject_id COLLATE BINARY`,
    labels,
    "matching subject aliases",
  );
  const candidates = new Map<SubjectId, SubjectSummary>();
  for (const row of directRows) {
    const subjectId = parseStored(
      () => subjectIdSchema.parse(row.subject_id),
      "name candidate subject id",
    );
    const subject = loadReferencedSubjectSummary(database, subjectId, "subject name candidate");
    candidates.set(subject.id, subject);
  }
  for (const row of aliasRows) {
    const subjectId = parseStored(
      () => subjectIdSchema.parse(row.subject_id),
      "subject alias owner id",
    );
    if (row.space_id === null) {
      throw storageCorrupt("SQLite subject alias points to a missing subject.");
    }
    const ownerSpaceId = parseStored(
      () => spaceIdSchema.parse(row.space_id),
      "subject alias owner space id",
    );
    if (row.existing_space_id === null) {
      throw storageCorrupt("SQLite subject alias owner references a missing space.");
    }
    const existingOwnerSpaceId = parseStored(
      () => spaceIdSchema.parse(row.existing_space_id),
      "subject alias existing owner space id",
    );
    if (existingOwnerSpaceId !== ownerSpaceId) {
      throw storageCorrupt("SQLite subject alias owner resolved through a different space.");
    }
    if (ownerSpaceId !== spaceId) continue;
    const subject = loadReferencedSubjectSummary(database, subjectId, "subject alias");
    candidates.set(subject.id, subject);
  }
  return [...candidates.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
};

const assertExactLocatorAvailable = (
  database: DatabaseSync,
  input: NormalizedCreateSubjectInput,
): void => {
  const locatorMatch = exactLocatorSubject(database, input);
  if (locatorMatch !== undefined) throw subjectAlreadyExists(locatorMatch);
};

const assertSameSpaceNameAvailable = (
  database: DatabaseSync,
  input: NormalizedCreateSubjectInput,
  spaceId: SpaceId,
): void => {
  const conflict = findCreateConflict(input, sameSpaceNameCandidates(database, input, spaceId));
  if (conflict.kind === "already_exists") throw subjectAlreadyExists(conflict.subject);
  if (conflict.kind === "ambiguous") {
    const [first, second, ...rest] = conflict.candidates;
    if (first === undefined || second === undefined) {
      throw storageCorrupt("An ambiguous subject result requires at least two candidates.");
    }
    throw ambiguousSubject([first, second, ...rest]);
  }
};

const insertHint = (database: DatabaseSync, subjectId: SubjectId, hint: IdentityHint): void => {
  const key = storedIdentityHintKey(hint);
  const provider = hint.kind === "account" || hint.kind === "external_id" ? hint.provider : null;
  const value = hint.kind === "account" ? hint.handle : hint.value;
  executeInsert(
    database,
    `INSERT INTO subject_identity_hints(
       subject_id, hint_key, kind, provider, value, locator_key
     ) VALUES (?, ?, ?, ?, ?, ?)`,
    [subjectId, key, hint.kind, provider, value, hint.kind === "description" ? null : key],
    "a subject identity hint",
  );
};

/**
 * Resolves and creates one subject identity inside the caller's active write transaction.
 *
 * Standalone create and ingest(create) share this primitive; it never calls a public service.
 *
 * @param database - Database connection inside the caller's active write transaction.
 * @param input - Canonical create identity fields.
 * @param ids - Trusted space-id generator used only when an inline space is absent.
 * @param candidateSubjectId - Subject id preallocated before opening the transaction.
 * @returns The newly persisted and strictly reloaded subject summary.
 */
export const createSubjectIdentityInTransaction = (
  database: DatabaseSync,
  input: NormalizedCreateSubjectInput,
  ids: Pick<IdGenerator, "spaceId">,
  candidateSubjectId: SubjectId,
): SubjectSummary => {
  const subjectId = parseStored(
    () => subjectIdSchema.parse(candidateSubjectId),
    "generated subject id",
  );
  assertExactLocatorAvailable(database, input);
  const space = resolveSpace(database, input, ids);
  assertSameSpaceNameAvailable(database, input, space.id);

  executeInsert(
    database,
    `INSERT INTO subjects(
       id, space_id, display_name, canonical_label, domain_pack, lifecycle
     ) VALUES (?, ?, ?, ?, ?, 'active')`,
    [subjectId, space.id, input.displayName, input.displayName, input.domainPack ?? null],
    "a subject identity",
  );
  for (const alias of input.aliases) {
    executeInsert(
      database,
      `INSERT INTO subject_aliases(subject_id, alias, canonical_label)
       VALUES (?, ?, ?)`,
      [subjectId, alias, alias],
      "a subject alias",
    );
  }
  for (const hint of input.identityHints) insertHint(database, subjectId, hint);
  executeInsert(
    database,
    `INSERT INTO subject_states(
       subject_id, generation, material_set_hash, current_version_id, suspended_version_id
     ) VALUES (?, 0, NULL, NULL, NULL)`,
    [subjectId],
    "initial subject state",
  );
  return loadSubjectSummaryInTransaction(database, subjectId);
};
