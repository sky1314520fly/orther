import type { DatabaseSync } from "node:sqlite";

import {
  contentDigestSchema,
  materialIdSchema,
  materialRecordSchema,
  provenanceDigestSchema,
  subjectIdSchema,
} from "@distilly/protocol";
import type {
  ContentDigest,
  MaterialRecord,
  SubjectId,
  VersionMaterialEntry,
} from "@distilly/protocol";

import { canonicalJson } from "../facts/canonical-json.js";
import { verifyFactChecksum } from "../facts/checksum.js";
import { deriveMaterialId, digestMaterialProvenance } from "../facts/digests.js";
import { canonicalRawTextJson } from "../facts/raw-extraction.js";
import { storageCorrupt } from "../internal-errors.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** Verified SQLite material metadata and its immutable content pointer. */
export interface SqliteMaterialDescriptor {
  readonly record: MaterialRecord;
  readonly blobDigest: ContentDigest;
  readonly blobByteLength: number;
  readonly rawBlob?: {
    readonly digest: ContentDigest;
    readonly byteLength: number;
  };
}

const parseStored = <T>(parse: () => T, label: string): T => {
  try {
    return parse();
  } catch (error) {
    throw storageCorrupt(`SQLite ${label} is invalid.`, error);
  }
};

const parseJson = (value: string, label: string): unknown => {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw storageCorrupt(`SQLite ${label} is not valid JSON.`, error);
  }
};

const text = (row: Readonly<Record<string, unknown>>, key: string): string => {
  const value = row[key];
  if (typeof value !== "string") throw storageCorrupt(`SQLite ${key} is invalid.`);
  return value;
};

const nullableText = (row: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = row[key];
  if (value === null) return undefined;
  if (typeof value !== "string") throw storageCorrupt(`SQLite ${key} is invalid.`);
  return value;
};

const integer = (row: Readonly<Record<string, unknown>>, key: string): number => {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw storageCorrupt(`SQLite ${key} is invalid.`);
  }
  return value;
};

const utf8Blob = (row: Readonly<Record<string, unknown>>, key: string): string => {
  const value = row[key];
  if (!(value instanceof Uint8Array)) throw storageCorrupt(`SQLite ${key} is invalid.`);
  try {
    return UTF8_DECODER.decode(value);
  } catch (error) {
    throw storageCorrupt(`SQLite ${key} is not valid UTF-8.`, error);
  }
};

const materialIdentitySemantics = (record: MaterialRecord): unknown => {
  const source = Object.fromEntries(
    Object.entries(record.source).filter(([key]) => key !== "title" && key !== "capturedAt"),
  );
  return {
    id: record.id,
    subjectId: record.subjectId,
    kind: record.kind,
    contentDigest: record.contentDigest,
    provenanceDigest: record.provenanceDigest,
    sourceIdentity: record.sourceIdentity,
    source,
    derivation: record.derivation,
    participants: record.participants,
    sensitivity: record.sensitivity,
    ...(record.correctionProvenance === undefined
      ? {}
      : { correctionProvenance: record.correctionProvenance }),
    ...(record.captureAuditRef === undefined ? {} : { captureAuditRef: record.captureAuditRef }),
    ...(record.conversationSourceKey === undefined
      ? {}
      : { conversationSourceKey: record.conversationSourceKey }),
    flags: record.flags,
  };
};

/**
 * Returns the canonical SQLite identity payload that excludes first-seen display metadata.
 * @param record - Verified or prepared material record.
 * @returns Canonical JSON used by the SQLite identity column.
 */
export const canonicalMaterialIdentityJson = (record: MaterialRecord): string =>
  canonicalJson(materialIdentitySemantics(record));

/**
 * Reads and verifies every current material row for one subject inside a SQLite snapshot.
 *
 * @param database - Connection inside the caller's active transaction.
 * @param subjectId - Subject whose current membership is required.
 * @returns Canonically ordered metadata and blob pointers.
 */
export const readSqliteMaterialsInTransaction = (
  database: DatabaseSync,
  subjectId: SubjectId,
): readonly SqliteMaterialDescriptor[] => {
  parseStored(() => subjectIdSchema.parse(subjectId), "material subject id");
  let rows: readonly Readonly<Record<string, unknown>>[];
  try {
    rows = database
      .prepare(
        `SELECT materials.material_id, materials.kind, materials.content_digest,
                materials.provenance_digest, materials.source_identity,
                materials.record_json, materials.identity_json, materials.blob_digest,
                materials.stored_at, blobs.byte_length AS blob_byte_length
         FROM materials
         LEFT JOIN blobs ON blobs.digest = materials.blob_digest
         WHERE materials.subject_id = ?
         ORDER BY materials.material_id COLLATE BINARY`,
      )
      .all(subjectId);
  } catch (error) {
    throw storageCorrupt("SQLite could not read subject material membership.", error);
  }
  return rows.map((row): SqliteMaterialDescriptor => {
    const recordJson = text(row, "record_json");
    const record = parseStored(
      () => materialRecordSchema.parse(parseJson(recordJson, "material record")) as MaterialRecord,
      "material record",
    );
    if (canonicalJson(record) !== recordJson) {
      throw storageCorrupt("SQLite material record is not canonically encoded.");
    }
    verifyFactChecksum(record);
    const materialId = parseStored(
      () => materialIdSchema.parse(text(row, "material_id")),
      "material id",
    );
    const contentDigest = parseStored(
      () => contentDigestSchema.parse(text(row, "content_digest")),
      "material content digest",
    );
    const provenanceDigest = parseStored(
      () => provenanceDigestSchema.parse(text(row, "provenance_digest")),
      "material provenance digest",
    );
    const sourceIdentity = utf8Blob(row, "source_identity");
    const storedIdentityJson = text(row, "identity_json");
    const blobDigest = parseStored(
      () => contentDigestSchema.parse(text(row, "blob_digest")),
      "material blob digest",
    );
    if (
      record.subjectId !== subjectId ||
      record.id !== materialId ||
      record.kind !== text(row, "kind") ||
      record.contentDigest !== contentDigest ||
      record.provenanceDigest !== provenanceDigest ||
      record.sourceIdentity !== sourceIdentity ||
      record.storedAt !== text(row, "stored_at") ||
      blobDigest !== contentDigest ||
      digestMaterialProvenance(record) !== provenanceDigest ||
      deriveMaterialId(sourceIdentity, provenanceDigest, contentDigest) !== materialId ||
      canonicalMaterialIdentityJson(record) !== storedIdentityJson
    ) {
      throw storageCorrupt("SQLite material columns disagree with their canonical record.");
    }
    let rawBlob: SqliteMaterialDescriptor["rawBlob"];
    if (record.derivation.kind === "raw_extract") {
      let rawRow: Readonly<Record<string, unknown>> | undefined;
      try {
        rawRow = database
          .prepare(
            `SELECT raw_materials.blob_digest, raw_materials.byte_length,
                    raw_materials.canonical_text_json
             FROM subject_raw_materials
             JOIN raw_materials ON raw_materials.raw_id = subject_raw_materials.raw_id
             JOIN blobs ON blobs.digest = raw_materials.blob_digest
             WHERE subject_raw_materials.subject_id = ?
               AND subject_raw_materials.raw_id = ?
               AND blobs.byte_length = raw_materials.byte_length`,
          )
          .get(subjectId, record.derivation.rawId);
      } catch (error) {
        throw storageCorrupt("SQLite could not read raw material authority.", error);
      }
      if (rawRow === undefined) {
        throw storageCorrupt("A raw-extracted material is missing its raw authority relation.");
      }
      const rawDigest = parseStored(
        () => contentDigestSchema.parse(text(rawRow, "blob_digest")),
        "raw blob digest",
      );
      if (record.derivation.rawId.slice(4) !== rawDigest.slice(7)) {
        throw storageCorrupt("A raw id disagrees with its immutable blob digest.");
      }
      const canonicalTextJson = nullableText(rawRow, "canonical_text_json");
      if (canonicalTextJson === undefined || canonicalTextJson !== canonicalRawTextJson(record)) {
        throw storageCorrupt("A raw-extracted material disagrees with its canonical text tuple.");
      }
      rawBlob = { digest: rawDigest, byteLength: integer(rawRow, "byte_length") };
    }
    return {
      record,
      blobDigest,
      blobByteLength: integer(row, "blob_byte_length"),
      ...(rawBlob === undefined ? {} : { rawBlob }),
    };
  });
};

/**
 * Converts canonical verified material rows into immutable version membership.
 *
 * @param materials - Canonically ordered verified material descriptors.
 * @returns Exact immutable membership entries.
 */
export const materialManifestFromSqlite = (
  materials: readonly SqliteMaterialDescriptor[],
): readonly VersionMaterialEntry[] =>
  materials.map(({ record }) => ({
    materialId: record.id,
    contentDigest: record.contentDigest,
    provenanceDigest: record.provenanceDigest,
  }));
