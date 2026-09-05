import type { DatabaseSync } from "node:sqlite";

import { schemaUnsupported, storageCorrupt } from "../internal-errors.js";

/** Current private SQLite authority schema used by the TypeScript engine preview. */
export const SQLITE_STORAGE_SCHEMA_VERSION = 1;

interface SchemaObject {
  readonly type: "index" | "table";
  readonly name: string;
  readonly tableName: string;
  readonly sql: string;
}

const table = (name: string, sql: string): SchemaObject => ({
  type: "table",
  name,
  tableName: name,
  sql,
});

const index = (name: string, tableName: string, sql: string): SchemaObject => ({
  type: "index",
  name,
  tableName,
  sql,
});

const SCHEMA_OBJECTS = [
  table(
    "spaces",
    `CREATE TABLE spaces (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  canonical_label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('people', 'fictional', 'custom')),
  CHECK (length(display_name) > 0),
  CHECK (length(canonical_label) > 0)
) STRICT`,
  ),
  table(
    "subjects",
    `CREATE TABLE subjects (
  id TEXT PRIMARY KEY NOT NULL,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL,
  canonical_label TEXT NOT NULL,
  domain_pack TEXT,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'archived')),
  CHECK (length(display_name) > 0),
  CHECK (length(canonical_label) > 0)
) STRICT`,
  ),
  table(
    "subject_aliases",
    `CREATE TABLE subject_aliases (
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  canonical_label TEXT NOT NULL,
  PRIMARY KEY (subject_id, canonical_label),
  CHECK (length(alias) > 0),
  CHECK (length(canonical_label) > 0)
) STRICT`,
  ),
  table(
    "subject_identity_hints",
    `CREATE TABLE subject_identity_hints (
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  hint_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('url', 'account', 'external_id', 'description')),
  provider TEXT,
  value TEXT NOT NULL,
  locator_key TEXT,
  PRIMARY KEY (subject_id, hint_key),
  CHECK (length(hint_key) > 0),
  CHECK (length(value) > 0),
  CHECK (
    (kind = 'url' AND provider IS NULL AND locator_key IS NOT NULL) OR
    (kind IN ('account', 'external_id') AND provider IS NOT NULL AND locator_key IS NOT NULL) OR
    (kind = 'description' AND provider IS NULL AND locator_key IS NULL)
  )
) STRICT`,
  ),
  table(
    "blobs",
    `CREATE TABLE blobs (
  digest TEXT PRIMARY KEY NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0 AND byte_length <= 9007199254740991)
) STRICT`,
  ),
  table(
    "raw_materials",
    `CREATE TABLE raw_materials (
  raw_id TEXT PRIMARY KEY NOT NULL,
  blob_digest TEXT NOT NULL UNIQUE REFERENCES blobs(digest) ON DELETE RESTRICT,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0 AND byte_length <= 9007199254740991),
  canonical_text_json TEXT CHECK (
    canonical_text_json IS NULL OR json_valid(canonical_text_json)
  ),
  CHECK (substr(raw_id, 5) = substr(blob_digest, 8))
) STRICT`,
  ),
  table(
    "subject_raw_materials",
    `CREATE TABLE subject_raw_materials (
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  raw_id TEXT NOT NULL REFERENCES raw_materials(raw_id) ON DELETE RESTRICT,
  media_type TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  stored_at TEXT NOT NULL,
  PRIMARY KEY (subject_id, raw_id),
  CHECK (length(media_type) > 0)
) STRICT`,
  ),
  table(
    "materials",
    `CREATE TABLE materials (
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  material_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (
    kind IN ('web', 'document', 'message', 'email', 'transcript', 'derived_text', 'correction')
  ),
  content_digest TEXT NOT NULL,
  provenance_digest TEXT NOT NULL,
  source_identity BLOB NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  identity_json TEXT NOT NULL CHECK (json_valid(identity_json)),
  blob_digest TEXT NOT NULL REFERENCES blobs(digest) ON DELETE RESTRICT,
  stored_at TEXT NOT NULL,
  PRIMARY KEY (subject_id, material_id),
  UNIQUE (subject_id, material_id, content_digest, provenance_digest),
  CHECK (length(source_identity) > 0),
  CHECK (blob_digest = content_digest)
) STRICT`,
  ),
  table(
    "versions",
    `CREATE TABLE versions (
  id TEXT PRIMARY KEY NOT NULL,
  subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  subject_display_name TEXT NOT NULL,
  parent_id TEXT,
  derived_from_candidate_version_id TEXT,
  generation INTEGER NOT NULL CHECK (generation > 0 AND generation <= 9007199254740991),
  material_set_hash TEXT NOT NULL,
  material_count INTEGER NOT NULL CHECK (material_count > 0 AND material_count <= 9007199254740991),
  creation_json TEXT NOT NULL CHECK (json_valid(creation_json)),
  created_disposition TEXT NOT NULL CHECK (created_disposition IN ('current', 'suspended')),
  actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
  quality_json TEXT NOT NULL CHECK (json_valid(quality_json)),
  renderer_version TEXT NOT NULL,
  review_reasons_json TEXT CHECK (review_reasons_json IS NULL OR json_valid(review_reasons_json)),
  accepted_patch_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  UNIQUE (id, subject_id),
  UNIQUE (subject_id, id),
  CHECK (length(subject_display_name) > 0),
  CHECK (length(renderer_version) > 0),
  CHECK (
    (created_disposition = 'current' AND review_reasons_json IS NULL) OR
    (created_disposition = 'suspended' AND review_reasons_json IS NOT NULL)
  ),
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK (derived_from_candidate_version_id IS NULL OR derived_from_candidate_version_id <> id),
  FOREIGN KEY (subject_id, parent_id)
    REFERENCES versions(subject_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (subject_id, derived_from_candidate_version_id)
    REFERENCES versions(subject_id, id) ON DELETE RESTRICT
) STRICT`,
  ),
  table(
    "version_statuses",
    `CREATE TABLE version_statuses (
  version_id TEXT PRIMARY KEY NOT NULL,
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('current', 'suspended', 'historical', 'rejected')),
  FOREIGN KEY (version_id, subject_id) REFERENCES versions(id, subject_id) ON DELETE CASCADE
) STRICT`,
  ),
  table(
    "version_materials",
    `CREATE TABLE version_materials (
  version_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal <= 9007199254740991),
  material_id TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  provenance_digest TEXT NOT NULL,
  PRIMARY KEY (version_id, ordinal),
  UNIQUE (version_id, material_id),
  FOREIGN KEY (version_id, subject_id) REFERENCES versions(id, subject_id) ON DELETE CASCADE,
  FOREIGN KEY (subject_id, material_id, content_digest, provenance_digest)
    REFERENCES materials(subject_id, material_id, content_digest, provenance_digest)
    ON DELETE RESTRICT
) STRICT`,
  ),
  table(
    "version_claims",
    `CREATE TABLE version_claims (
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  subject_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal <= 9007199254740991),
  claim_id TEXT NOT NULL,
  facet TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'contested', 'superseded')),
  strength TEXT NOT NULL CHECK (
    strength IN ('user_asserted', 'single_source', 'corroborated', 'contested', 'imported_unverified')
  ),
  observed_in_json TEXT NOT NULL CHECK (json_valid(observed_in_json)),
  valid_from TEXT,
  valid_to TEXT,
  created_in_version_id TEXT NOT NULL,
  superseded_by_claim_id TEXT,
  PRIMARY KEY (version_id, ordinal),
  UNIQUE (version_id, claim_id),
  FOREIGN KEY (version_id, superseded_by_claim_id)
    REFERENCES version_claims(version_id, claim_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (version_id, subject_id)
    REFERENCES versions(id, subject_id) ON DELETE CASCADE,
  FOREIGN KEY (created_in_version_id, subject_id)
    REFERENCES versions(id, subject_id) ON DELETE RESTRICT,
  CHECK (length(facet) > 0),
  CHECK (length(text) > 0),
  CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from <= valid_to),
  CHECK (
    (status = 'superseded') OR
    superseded_by_claim_id IS NULL
  ),
  CHECK (
    (status = 'contested' AND strength = 'contested') OR
    (status <> 'contested' AND strength <> 'contested')
  )
) STRICT`,
  ),
  table(
    "version_claim_evidence",
    `CREATE TABLE version_claim_evidence (
  version_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal <= 9007199254740991),
  material_id TEXT NOT NULL,
  quote TEXT NOT NULL,
  locator_start INTEGER,
  locator_end INTEGER,
  PRIMARY KEY (version_id, claim_id, ordinal),
  FOREIGN KEY (version_id, claim_id)
    REFERENCES version_claims(version_id, claim_id) ON DELETE CASCADE,
  FOREIGN KEY (version_id, material_id)
    REFERENCES version_materials(version_id, material_id) ON DELETE RESTRICT,
  CHECK (length(quote) > 0),
  CHECK (
    (locator_start IS NULL AND locator_end IS NULL) OR
    (locator_start IS NOT NULL AND locator_end IS NOT NULL AND
     locator_start >= 0 AND locator_start < locator_end)
  )
) STRICT`,
  ),
  table(
    "subject_states",
    `CREATE TABLE subject_states (
  subject_id TEXT PRIMARY KEY NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation >= 0 AND generation <= 9007199254740991),
  material_set_hash TEXT,
  current_version_id TEXT,
  suspended_version_id TEXT,
  CHECK (
    (generation = 0 AND material_set_hash IS NULL) OR
    (generation > 0 AND material_set_hash IS NOT NULL)
  ),
  CHECK (current_version_id IS NULL OR current_version_id <> suspended_version_id),
  FOREIGN KEY (subject_id, current_version_id)
    REFERENCES versions(subject_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (subject_id, suspended_version_id)
    REFERENCES versions(subject_id, id) ON DELETE RESTRICT
) STRICT`,
  ),
  table(
    "pending_jobs",
    `CREATE TABLE pending_jobs (
  subject_id TEXT PRIMARY KEY NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL CHECK (generation >= 0 AND generation <= 9007199254740991),
  base_version_id TEXT,
  material_set_hash TEXT NOT NULL,
  added_material_count INTEGER NOT NULL CHECK (
    added_material_count >= 0 AND added_material_count <= 9007199254740991
  ),
  total_material_count INTEGER NOT NULL CHECK (
    total_material_count >= 0 AND total_material_count <= 9007199254740991
  ),
  queued_at TEXT NOT NULL,
  FOREIGN KEY (subject_id, base_version_id)
    REFERENCES versions(subject_id, id) ON DELETE RESTRICT,
  CHECK (added_material_count <= total_material_count)
) STRICT`,
  ),
  table(
    "job_leases",
    `CREATE TABLE job_leases (
  job_id TEXT PRIMARY KEY NOT NULL REFERENCES pending_jobs(job_id) ON DELETE CASCADE,
  lease_id TEXT NOT NULL UNIQUE,
  lease_owner TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  brief_contract_digest TEXT NOT NULL,
  source_grouping_version TEXT NOT NULL CHECK (source_grouping_version = 'source-groups-v1'),
  prompt_version TEXT NOT NULL,
  draft_schema_version INTEGER NOT NULL CHECK (draft_schema_version = 1),
  CHECK (length(lease_id) > 0),
  CHECK (length(lease_owner) > 0),
  CHECK (length(acquired_at) > 0),
  CHECK (length(expires_at) > 0),
  CHECK (length(brief_contract_digest) > 0),
  CHECK (length(prompt_version) > 0),
  CHECK (expires_at > acquired_at)
) STRICT`,
  ),
  table(
    "operations",
    `CREATE TABLE operations (
  request_id TEXT PRIMARY KEY NOT NULL,
  method TEXT NOT NULL,
  scope_subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
  input_checksum TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  completed_at TEXT NOT NULL,
  CHECK (length(method) > 0)
) STRICT`,
  ),
  table(
    "operation_result_blobs",
    `CREATE TABLE operation_result_blobs (
  request_id TEXT PRIMARY KEY NOT NULL REFERENCES operations(request_id) ON DELETE CASCADE,
  blob_digest TEXT NOT NULL REFERENCES blobs(digest) ON DELETE RESTRICT,
  byte_length INTEGER NOT NULL CHECK (
    byte_length > 0 AND byte_length <= 9007199254740991
  )
) STRICT`,
  ),
  table(
    "events",
    `CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (sequence <= 9007199254740991),
  event_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL REFERENCES operations(request_id) ON DELETE RESTRICT,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  occurred_at TEXT NOT NULL
) STRICT`,
  ),
  index(
    "space_kind_label_unique",
    "spaces",
    "CREATE UNIQUE INDEX space_kind_label_unique ON spaces(kind, canonical_label)",
  ),
  index(
    "subject_name_lookup",
    "subjects",
    "CREATE INDEX subject_name_lookup ON subjects(space_id, canonical_label, id)",
  ),
  index(
    "subject_alias_lookup",
    "subject_aliases",
    "CREATE INDEX subject_alias_lookup ON subject_aliases(canonical_label, subject_id)",
  ),
  index(
    "subject_identity_locator_unique",
    "subject_identity_hints",
    `CREATE UNIQUE INDEX subject_identity_locator_unique
ON subject_identity_hints(locator_key)
WHERE locator_key IS NOT NULL`,
  ),
  index(
    "material_id_lookup",
    "materials",
    "CREATE INDEX material_id_lookup ON materials(material_id, subject_id)",
  ),
  index(
    "subject_raw_material_lookup",
    "subject_raw_materials",
    "CREATE INDEX subject_raw_material_lookup ON subject_raw_materials(raw_id, subject_id)",
  ),
  index(
    "version_subject_created_lookup",
    "versions",
    "CREATE INDEX version_subject_created_lookup ON versions(subject_id, created_at, id)",
  ),
  index(
    "version_status_subject_lookup",
    "version_statuses",
    "CREATE INDEX version_status_subject_lookup ON version_statuses(subject_id, status, version_id)",
  ),
  index(
    "version_current_subject_unique",
    "version_statuses",
    `CREATE UNIQUE INDEX version_current_subject_unique
ON version_statuses(subject_id)
WHERE status = 'current'`,
  ),
  index(
    "version_suspended_subject_unique",
    "version_statuses",
    `CREATE UNIQUE INDEX version_suspended_subject_unique
ON version_statuses(subject_id)
WHERE status = 'suspended'`,
  ),
  index(
    "version_evidence_material_lookup",
    "version_claim_evidence",
    `CREATE INDEX version_evidence_material_lookup
ON version_claim_evidence(material_id, version_id, claim_id)`,
  ),
  index(
    "pending_job_order",
    "pending_jobs",
    "CREATE INDEX pending_job_order ON pending_jobs(queued_at, job_id)",
  ),
  index(
    "operation_subject_lookup",
    "operations",
    "CREATE INDEX operation_subject_lookup ON operations(scope_subject_id, completed_at, request_id)",
  ),
  index(
    "operation_result_blob_lookup",
    "operation_result_blobs",
    `CREATE INDEX operation_result_blob_lookup
ON operation_result_blobs(blob_digest, request_id)`,
  ),
  index(
    "event_subject_sequence",
    "events",
    "CREATE INDEX event_subject_sequence ON events(subject_id, sequence)",
  ),
] as const satisfies readonly SchemaObject[];

interface SchemaRow {
  readonly type: unknown;
  readonly name: unknown;
  readonly tbl_name: unknown;
  readonly sql: unknown;
}

const readUserVersion = (database: DatabaseSync): number => {
  const row = database.prepare("PRAGMA user_version").get() as
    { readonly user_version?: unknown } | undefined;
  if (typeof row?.user_version !== "number" || !Number.isSafeInteger(row.user_version)) {
    throw storageCorrupt("SQLite storage schema version is unreadable.");
  }
  return row.user_version;
};

const readSchemaRows = (database: DatabaseSync): readonly SchemaRow[] =>
  database
    .prepare(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
       WHERE name NOT GLOB 'sqlite_*'
       ORDER BY type, name`,
    )
    .all() as unknown as readonly SchemaRow[];

const sortedExpectedSchema = (): readonly SchemaObject[] =>
  [...SCHEMA_OBJECTS].sort((left, right) => {
    if (left.type !== right.type) return left.type < right.type ? -1 : 1;
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });

/**
 * Creates schema v1 inside the caller's active write transaction.
 *
 * @param database - Open SQLite connection already configured by the store.
 */
export const createStorageSchemaV1 = (database: DatabaseSync): void => {
  for (const object of SCHEMA_OBJECTS) database.exec(object.sql);
  database.exec(`PRAGMA user_version = ${SQLITE_STORAGE_SCHEMA_VERSION}`);
};

/**
 * Returns whether a version-zero database contains no Distilly schema objects.
 *
 * @param database - Open SQLite connection to inspect.
 * @returns Whether schema v1 can be initialized without overwriting unknown data.
 */
export const isEmptyStorageDatabase = (database: DatabaseSync): boolean =>
  readUserVersion(database) === 0 && readSchemaRows(database).length === 0;

/**
 * Verifies the exact private schema-v1 shape and relational integrity.
 *
 * @param database - Open SQLite connection configured with foreign keys enabled.
 */
export const verifyStorageSchemaV1 = (database: DatabaseSync): void => {
  const version = readUserVersion(database);
  if (version !== SQLITE_STORAGE_SCHEMA_VERSION) {
    throw schemaUnsupported(`SQLite storage schema version ${String(version)} is unsupported.`);
  }

  const actual = readSchemaRows(database);
  const expected = sortedExpectedSchema();
  if (
    actual.length !== expected.length ||
    !expected.every((object, position) => {
      const row = actual[position];
      return (
        row?.type === object.type &&
        row.name === object.name &&
        row.tbl_name === object.tableName &&
        row.sql === object.sql
      );
    })
  ) {
    throw storageCorrupt("SQLite storage schema v1 does not match its canonical shape.");
  }

  const integrityRows = database.prepare("PRAGMA quick_check").all() as unknown as readonly Record<
    string,
    unknown
  >[];
  if (integrityRows.length !== 1 || integrityRows[0]?.quick_check !== "ok") {
    throw storageCorrupt("SQLite storage failed its integrity check.");
  }

  const foreignKeyFailures = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyFailures.length !== 0) {
    throw storageCorrupt("SQLite storage contains invalid foreign-key references.");
  }
};
