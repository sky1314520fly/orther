import { DistillyError, subjectIdSchema, subjectRecordSchema } from "@distilly/protocol";
import type { RuntimeSchema, SpaceId, SubjectId, SubjectRecord } from "@distilly/protocol";
import { lstat } from "node:fs/promises";

import { storageCorrupt } from "../internal-errors.js";
import { Layout } from "../layout.js";
import { listFactDirectory } from "./directory-scan.js";
import { readFactFile, replaceFactFile } from "./fact-file.js";
import { assertNoSymlinkPath, isMissing } from "./safe-fs.js";
import type { FileSpaceStore } from "./space-store.js";

const subjectFactSchema: RuntimeSchema<SubjectRecord> = {
  parse(value) {
    return subjectRecordSchema.parse(value) as SubjectRecord;
  },
};

const assertPathId = (requestedId: SubjectId, record: SubjectRecord): void => {
  if (record.id !== requestedId) {
    throw storageCorrupt("Subject record id does not match its fact path.");
  }
};

const requireSpace = async (spaces: FileSpaceStore, record: SubjectRecord): Promise<void> => {
  try {
    await spaces.read(record.spaceId);
  } catch (error) {
    if (error instanceof DistillyError && error.code === "not_found") {
      throw storageCorrupt("Subject record references a missing space fact.", error);
    }
    throw error;
  }
};

const SUBJECT_DIRECTORY_PATTERN = /^subject_[0-9a-f]{32}$/u;

/** Concrete local store for mutable subject identity facts. */
export class FileSubjectStore {
  readonly #layout: Layout;
  readonly #spaces: FileSpaceStore;

  /**
   * Creates a subject store with its required space-fact dependency.
   *
   * @param layout - Confined local fact layout.
   * @param spaces - Store used to validate the subject's space reference.
   */
  constructor(layout: Layout, spaces: FileSpaceStore) {
    this.#layout = layout;
    this.#spaces = spaces;
  }

  /**
   * Atomically writes a subject whose referenced space already exists.
   *
   * @param record - Complete subject fact to publish.
   * @returns Completion after the durable replacement.
   */
  async write(record: SubjectRecord): Promise<void> {
    let parsed: SubjectRecord;
    try {
      parsed = subjectFactSchema.parse(record);
    } catch (error) {
      throw storageCorrupt("Subject fact cannot be written because its schema is invalid.", error);
    }
    await requireSpace(this.#spaces, parsed);
    await replaceFactFile(
      this.#layout.root,
      this.#layout.subjectFile(parsed.id),
      parsed,
      subjectFactSchema,
    );
  }

  /**
   * Reads a subject and verifies its path id and space reference.
   *
   * @param subjectId - Subject whose identity fact should be loaded.
   * @returns The verified persisted record.
   */
  async read(subjectId: SubjectId): Promise<SubjectRecord> {
    const record = await readFactFile(
      this.#layout.root,
      this.#layout.subjectFile(subjectId),
      subjectFactSchema,
    );
    assertPathId(subjectId, record);
    await requireSpace(this.#spaces, record);
    return record;
  }

  /**
   * Proves that a create candidate has no stable subject directory in any form.
   *
   * @param subjectId - Candidate subject whose final directory must be absent.
   */
  async assertDirectoryAbsent(subjectId: SubjectId): Promise<void> {
    const directory = this.#layout.subjectDirectory(subjectId);
    await assertNoSymlinkPath(this.#layout.root, this.#layout.subjectsDirectory());
    try {
      await lstat(directory);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    throw storageCorrupt("A not-yet-created subject already has a stable directory.");
  }

  /**
   * Lists verified subjects in one space in canonical SubjectId order.
   *
   * @param spaceId - Space whose subjects should be listed.
   * @returns Verified subjects belonging to the space.
   */
  async listBySpace(spaceId: SpaceId): Promise<readonly SubjectRecord[]> {
    await this.#spaces.read(spaceId);
    return (await this.listAll()).filter((record) => record.spaceId === spaceId);
  }

  /**
   * Lists every verified subject in canonical SubjectId order.
   *
   * @returns All verified subject records.
   */
  async listAll(): Promise<readonly SubjectRecord[]> {
    const records: SubjectRecord[] = [];
    for (const entry of await listFactDirectory(
      this.#layout.root,
      this.#layout.subjectsDirectory(),
    )) {
      if (entry.name === ".locks") {
        if (entry.kind !== "directory") {
          throw storageCorrupt("Reserved subjects entry is not a real directory.");
        }
        continue;
      }
      if (!SUBJECT_DIRECTORY_PATTERN.test(entry.name) || entry.kind !== "directory") {
        throw storageCorrupt("Subjects directory contains an unknown entry.");
      }
      let record: SubjectRecord;
      try {
        record = await this.read(subjectIdSchema.parse(entry.name));
      } catch (error) {
        if (error instanceof DistillyError && error.code === "not_found") {
          throw storageCorrupt("Published subject directory is missing its subject fact.", error);
        }
        throw error;
      }
      records.push(record);
    }
    return records;
  }
}
