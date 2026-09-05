import { chmod, lstat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { isMissing } from "../facts/safe-fs.js";
import { schemaUnsupported, storageCorrupt } from "../internal-errors.js";
import {
  createStorageSchemaV1,
  isEmptyStorageDatabase,
  SQLITE_STORAGE_SCHEMA_VERSION,
  verifyStorageSchemaV1,
} from "./schema-v1.js";
import { StorageLayout } from "./storage-layout.js";
import { throwMappedStorageError } from "./storage-errors.js";

const DEFAULT_BUSY_TIMEOUT_MS = 250;
const MAXIMUM_BUSY_TIMEOUT_MS = 5_000;

/** Optional bounded connection policy used primarily by contention tests. */
export interface SqliteEngineStoreOptions {
  readonly busyTimeoutMs?: number;
}

const parseBusyTimeout = (value: number | undefined): number => {
  const timeout = value ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > MAXIMUM_BUSY_TIMEOUT_MS) {
    throw new RangeError(
      `busyTimeoutMs must be an integer between 0 and ${String(MAXIMUM_BUSY_TIMEOUT_MS)}.`,
    );
  }
  return timeout;
};

const pragmaNumber = (database: DatabaseSync, name: string): number => {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row?.[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw storageCorrupt(`SQLite ${name} mode is unreadable.`);
  }
  return value;
};

const readStorageVersion = (database: DatabaseSync): number => {
  const row = database.prepare("PRAGMA user_version").get() as
    { readonly user_version?: unknown } | undefined;
  if (typeof row?.user_version !== "number" || !Number.isSafeInteger(row.user_version)) {
    throw storageCorrupt("SQLite storage schema version is unreadable.");
  }
  return row.user_version;
};

const configureConnection = (database: DatabaseSync, busyTimeoutMs: number): void => {
  database.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)}`);
  database.exec("PRAGMA foreign_keys = ON");
  const journal = database.prepare("PRAGMA journal_mode = WAL").get() as
    { readonly journal_mode?: unknown } | undefined;
  database.exec("PRAGMA synchronous = FULL");

  if (typeof journal?.journal_mode !== "string" || journal.journal_mode.toLowerCase() !== "wal") {
    throw storageCorrupt("SQLite storage did not enter WAL mode.");
  }
  if (pragmaNumber(database, "foreign_keys") !== 1) {
    throw storageCorrupt("SQLite foreign-key enforcement is disabled.");
  }
  if (pragmaNumber(database, "synchronous") !== 2) {
    throw storageCorrupt("SQLite storage did not enter FULL synchronous mode.");
  }
};

const inspectDatabaseTarget = async (layout: StorageLayout): Promise<boolean> => {
  let rootStatus;
  try {
    rootStatus = await lstat(layout.root);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    throw storageCorrupt("DISTILLY_ROOT is not a regular directory.");
  }

  try {
    const databaseStatus = await lstat(layout.databaseFile);
    if (databaseStatus.isSymbolicLink() || !databaseStatus.isFile()) {
      throw storageCorrupt("SQLite storage path is not a regular file.");
    }
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  return true;
};

const preflightStorage = (database: DatabaseSync): boolean => {
  database.exec("BEGIN");
  let transactionActive = true;
  try {
    const version = readStorageVersion(database);
    if (version === 0) {
      if (!isEmptyStorageDatabase(database)) {
        throw schemaUnsupported("Unversioned SQLite storage is not empty.");
      }
    } else if (version === SQLITE_STORAGE_SCHEMA_VERSION) {
      verifyStorageSchemaV1(database);
    } else {
      throw schemaUnsupported(`SQLite storage schema version ${String(version)} is unsupported.`);
    }
    database.exec("COMMIT");
    transactionActive = false;
    return version === 0;
  } catch (error) {
    if (transactionActive) database.exec("ROLLBACK");
    throw error;
  }
};

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";

/**
 * Private SQLite/WAL transaction authority for one DISTILLY_ROOT.
 *
 * Transaction callbacks are deliberately synchronous: all preparation happens
 * before entering one short database transaction.
 */
export class SqliteEngineStore {
  readonly root: string;
  readonly databaseFile: string;

  private closed = false;

  private constructor(
    private readonly database: DatabaseSync,
    layout: StorageLayout,
  ) {
    this.root = layout.root;
    this.databaseFile = layout.databaseFile;
  }

  /**
   * Opens or initializes schema v1 under one private root.
   *
   * @param root - Configured DISTILLY_ROOT.
   * @param options - Optional bounded SQLite busy timeout.
   * @returns A verified WAL-backed store.
   */
  static async open(
    root: string,
    options: SqliteEngineStoreOptions = {},
  ): Promise<SqliteEngineStore> {
    const layout = new StorageLayout(root);
    const busyTimeoutMs = parseBusyTimeout(options.busyTimeoutMs);
    let database: DatabaseSync | undefined;
    try {
      if (!(await inspectDatabaseTarget(layout))) await layout.verifyDatabaseTarget();
      database = new DatabaseSync(layout.databaseFile);
      database.exec(`PRAGMA busy_timeout = ${String(busyTimeoutMs)}`);
      const shouldInitialize = preflightStorage(database);

      await layout.verifyDatabaseTarget();
      await chmod(layout.databaseFile, 0o600);
      configureConnection(database, busyTimeoutMs);

      if (shouldInitialize) {
        database.exec("BEGIN IMMEDIATE");
        let transactionActive = true;
        try {
          const currentVersion = readStorageVersion(database);
          if (currentVersion === 0) {
            if (!isEmptyStorageDatabase(database)) {
              throw schemaUnsupported("Unversioned SQLite storage is not empty.");
            }
            createStorageSchemaV1(database);
          } else if (currentVersion !== SQLITE_STORAGE_SCHEMA_VERSION) {
            throw schemaUnsupported(
              `SQLite storage schema version ${String(currentVersion)} is unsupported.`,
            );
          }
          database.exec("COMMIT");
          transactionActive = false;
        } catch (error) {
          if (transactionActive) database.exec("ROLLBACK");
          throw error;
        }
      }

      verifyStorageSchemaV1(database);
      return new SqliteEngineStore(database, layout);
    } catch (error) {
      try {
        database?.close();
      } catch {
        // Preserve the opening failure, which is the actionable cause.
      }
      return throwMappedStorageError(error, "open its local database");
    }
  }

  /**
   * Runs one synchronous reader inside a consistent SQLite snapshot.
   *
   * @param work - Synchronous database callback; returning a Promise is rejected.
   * @returns The callback result.
   */
  read<T>(work: (database: DatabaseSync) => T): T {
    this.assertOpen();
    let transactionActive = false;
    try {
      this.database.exec("BEGIN");
      transactionActive = true;
      const result = work(this.database);
      if (isThenable(result)) {
        transactionActive = false;
        return this.rejectThenable(result);
      }
      this.database.exec("COMMIT");
      transactionActive = false;
      return result;
    } catch (error) {
      if (transactionActive) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // The original read failure remains the useful error.
        }
      }
      return throwMappedStorageError(error, "read its local database");
    }
  }

  /**
   * Runs one synchronous business mutation inside BEGIN IMMEDIATE.
   *
   * @param work - Synchronous database callback; returning a Promise is rejected.
   * @returns The callback result after commit.
   */
  write<T>(work: (database: DatabaseSync) => T): T {
    this.assertOpen();
    let transactionActive = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      transactionActive = true;
      const result = work(this.database);
      if (isThenable(result)) {
        transactionActive = false;
        return this.rejectThenable(result);
      }
      this.database.exec("COMMIT");
      transactionActive = false;
      return result;
    } catch (error) {
      if (transactionActive) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // The original mutation failure remains the useful error.
        }
      }
      return throwMappedStorageError(error, "write its local database");
    }
  }

  /** Closes the owned SQLite connection; repeated calls are harmless. */
  close(): void {
    if (this.closed) return;
    try {
      this.database.close();
      this.closed = true;
    } catch (error) {
      throwMappedStorageError(error, "close its local database");
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("SqliteEngineStore is closed.");
  }

  private rejectThenable(result: PromiseLike<unknown>): never {
    void Promise.resolve(result).catch(() => undefined);
    try {
      this.database.exec("ROLLBACK");
    } finally {
      try {
        this.database.close();
      } finally {
        this.closed = true;
      }
    }
    throw new TypeError("SQLite transaction callbacks must be synchronous.");
  }
}
