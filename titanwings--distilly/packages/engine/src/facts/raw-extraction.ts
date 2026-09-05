import type { MaterialRecord } from "@distilly/protocol";

import { storageCorrupt } from "../internal-errors.js";
import { canonicalJson } from "./canonical-json.js";

/**
 * Encodes the authority tuple that keeps one raw input bound to one text extraction.
 *
 * @param record - A normalized material with engine-owned raw-extract provenance.
 * @returns Compact canonical JSON for comparison and persistence.
 */
export const canonicalRawTextJson = (record: MaterialRecord): string => {
  if (record.derivation.kind !== "raw_extract") {
    throw storageCorrupt("A canonical raw text tuple requires raw-extract provenance.");
  }
  return canonicalJson({
    contentDigest: record.contentDigest,
    kind: record.kind,
    method: record.derivation.method,
    producer: record.derivation.producer,
    ...(record.derivation.producerVersion === undefined
      ? {}
      : { producerVersion: record.derivation.producerVersion }),
    ...(record.derivation.language === undefined ? {} : { language: record.derivation.language }),
  });
};
