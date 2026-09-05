import { DistillyError } from "@distilly/protocol";

import { lockBusy, storageCorrupt } from "../internal-errors.js";

interface ErrorCodes {
  readonly code?: unknown;
  readonly errcode?: unknown;
}

const hasCode = (error: unknown): error is ErrorCodes =>
  typeof error === "object" && error !== null;

const sqlitePrimaryCode = (error: ErrorCodes): number | undefined =>
  typeof error.errcode === "number" && Number.isSafeInteger(error.errcode)
    ? error.errcode & 0xff
    : undefined;

/**
 * Maps recognized filesystem and SQLite failures onto stable Distilly errors.
 *
 * Unrecognized SQLite constraint errors remain available to the transaction-local
 * business primitive that owns their domain interpretation.
 *
 * @param error - Original storage or callback failure.
 * @param action - Content-free operation label used in the safe error message.
 * @returns The original typed/domain error or a stable storage error.
 */
export const mapStorageError = (error: unknown, action: string): unknown => {
  if (error instanceof DistillyError) return error;
  if (!hasCode(error)) return error;

  if (error.code === "EACCES" || error.code === "EPERM" || error.code === "EROFS") {
    return new DistillyError(
      {
        code: "permission_denied",
        message: `Distilly does not have permission to ${action}.`,
        retryable: false,
        remediation: "Grant the current user access to DISTILLY_ROOT and retry.",
      },
      { cause: error },
    );
  }
  if (error.code === "ENOTDIR" || error.code === "EISDIR" || error.code === "EEXIST") {
    return storageCorrupt(`Distilly storage has an invalid path while trying to ${action}.`, error);
  }

  const primaryCode = sqlitePrimaryCode(error);
  if (primaryCode === 5 || primaryCode === 6) {
    return lockBusy(`SQLite storage is busy while trying to ${action}.`);
  }
  if (primaryCode === 11 || primaryCode === 26) {
    return storageCorrupt(`SQLite storage is corrupt while trying to ${action}.`, error);
  }
  if (primaryCode === 19) {
    return storageCorrupt(`SQLite storage rejected inconsistent data while trying to ${action}.`);
  }
  if (primaryCode === 3 || primaryCode === 8 || primaryCode === 14 || primaryCode === 23) {
    return new DistillyError(
      {
        code: "permission_denied",
        message: `Distilly cannot open SQLite storage to ${action}.`,
        retryable: false,
        remediation: "Verify that DISTILLY_ROOT exists and is writable by the current user.",
      },
      { cause: error },
    );
  }
  return error;
};

/**
 * Throws a recognized storage failure as its stable Distilly error.
 *
 * @param error - Original storage or callback failure.
 * @param action - Content-free operation label used in the safe error message.
 */
export const throwMappedStorageError = (error: unknown, action: string): never => {
  throw mapStorageError(error, action);
};
