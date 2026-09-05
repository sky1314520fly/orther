import type { SpaceId, SpaceRecord } from "@distilly/protocol";
import { BUILTIN_PEOPLE_SPACE_ID, spaceIdSchema, spaceRecordSchema } from "@distilly/protocol";

import { storageCorrupt } from "../internal-errors.js";
import { Layout } from "../layout.js";
import { listFactDirectory } from "./directory-scan.js";
import { createFactFile, readFactFile } from "./fact-file.js";

const assertPathId = (requestedId: SpaceId, record: SpaceRecord): void => {
  if (record.id !== requestedId) {
    throw storageCorrupt("Space record id does not match its fact path.");
  }
};

const isFileCollision = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "EEXIST";

const SPACE_FILE_PATTERN = /^(space_[0-9a-f]{32})\.json$/u;
const SPACE_FILE_TEMP_PATTERN = /^\.space_[0-9a-f]{32}\.json\.[1-9][0-9]*\.[0-9a-f]{16}\.tmp$/u;
const assertBuiltinPeopleRecord = (record: SpaceRecord): void => {
  if (
    record.id === BUILTIN_PEOPLE_SPACE_ID &&
    (record.displayName !== "People" || record.kind !== "people")
  ) {
    throw storageCorrupt("Reserved built-in people space does not match its canonical record.");
  }
};

/** Concrete local store for immutable space identity facts. */
export class FileSpaceStore {
  readonly #layout: Layout;

  /**
   * Creates a space store for one fact layout.
   *
   * @param layout - Confined local fact layout.
   */
  constructor(layout: Layout) {
    this.#layout = layout;
  }

  /**
   * Creates one space fact or accepts an exact immutable retry.
   *
   * @param record - Complete space fact to publish.
   * @returns Completion after the durable replacement.
   */
  async write(record: SpaceRecord): Promise<void> {
    let parsed: SpaceRecord;
    try {
      parsed = spaceRecordSchema.parse(record);
    } catch (error) {
      throw storageCorrupt("Space fact cannot be written because its schema is invalid.", error);
    }
    assertBuiltinPeopleRecord(parsed);
    try {
      await createFactFile(
        this.#layout.root,
        this.#layout.spaceFile(parsed.id),
        parsed,
        spaceRecordSchema,
      );
    } catch (error) {
      if (!isFileCollision(error)) throw error;
      const existing = await this.read(parsed.id);
      if (existing.checksum === parsed.checksum) return;
      throw storageCorrupt("Immutable space id already contains a different fact.", error);
    }
  }

  /**
   * Reads and validates one space fact.
   *
   * @param spaceId - Space whose fact should be loaded.
   * @returns The verified persisted record.
   */
  async read(spaceId: SpaceId): Promise<SpaceRecord> {
    const record = await readFactFile(
      this.#layout.root,
      this.#layout.spaceFile(spaceId),
      spaceRecordSchema,
    );
    assertPathId(spaceId, record);
    assertBuiltinPeopleRecord(record);
    return record;
  }

  /**
   * Lists every verified space fact in canonical id order.
   *
   * @returns All verified space records.
   */
  async list(): Promise<readonly SpaceRecord[]> {
    const records: SpaceRecord[] = [];
    for (const entry of await listFactDirectory(
      this.#layout.root,
      this.#layout.spacesDirectory(),
    )) {
      const match = SPACE_FILE_PATTERN.exec(entry.name);
      if (match !== null) {
        if (entry.kind !== "file") {
          throw storageCorrupt("Space fact entry is not a regular file.");
        }
        records.push(await this.read(spaceIdSchema.parse(match[1])));
        continue;
      }
      if (SPACE_FILE_TEMP_PATTERN.test(entry.name) && entry.kind === "file") continue;
      throw storageCorrupt("Spaces directory contains an unknown entry.");
    }
    return records;
  }
}
