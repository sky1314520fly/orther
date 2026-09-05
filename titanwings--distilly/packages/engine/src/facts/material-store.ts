import {
  DistillyError,
  WIRE_LIMITS,
  materialIdSchema,
  materialRecordSchema,
} from "@distilly/protocol";
import type { MaterialId, MaterialRecord, RuntimeSchema, SubjectId } from "@distilly/protocol";
import { join } from "node:path";

import { storageCorrupt } from "../internal-errors.js";
import { Layout } from "../layout.js";
import { atomicCreateDirectory, atomicCreateFile } from "./atomic-write.js";
import { listFactDirectory } from "./directory-scan.js";
import { verifyMaterialIdentity } from "./digests.js";
import { createFactFile, readFactFile } from "./fact-file.js";
import { decodeUtf8, isMissing, readRegularFile } from "./safe-fs.js";
import type { FileSubjectStore } from "./subject-store.js";

const materialFactSchema: RuntimeSchema<MaterialRecord> = {
  parse(value) {
    return materialRecordSchema.parse(value) as MaterialRecord;
  },
};

const isDirectoryCollision = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "EEXIST" || error.code === "ENOTEMPTY");

const requireSubject = async (subjects: FileSubjectStore, subjectId: SubjectId): Promise<void> => {
  try {
    await subjects.read(subjectId);
  } catch (error) {
    if (error instanceof DistillyError && error.code === "not_found") {
      throw storageCorrupt("Material fact references a missing subject.", error);
    }
    throw error;
  }
};

/** Verified immutable material fact paired with its exact normalized body. */
export interface StoredMaterial {
  readonly record: MaterialRecord;
  readonly content: string;
}

/** Concrete local store for immutable material directories. */
export class FileMaterialStore {
  readonly #layout: Layout;
  readonly #subjects: FileSubjectStore;

  /**
   * Creates a material store with its required subject-fact dependency.
   *
   * @param layout - Confined local fact layout.
   * @param subjects - Store used to validate subject ownership.
   */
  constructor(layout: Layout, subjects: FileSubjectStore) {
    this.#layout = layout;
    this.#subjects = subjects;
  }

  /**
   * Publishes one immutable material directory or accepts an exact retry.
   *
   * @param record - Complete immutable material fact.
   * @param content - Normalized body whose digest is stored in the record.
   * @returns Completion after durable publication or exact retry validation.
   */
  async write(record: MaterialRecord, content: string): Promise<void> {
    let parsed: MaterialRecord;
    try {
      parsed = materialFactSchema.parse(record);
    } catch (error) {
      throw storageCorrupt("Material fact cannot be written because its schema is invalid.", error);
    }
    if (Buffer.byteLength(content, "utf8") > WIRE_LIMITS.materialContentBytes) {
      throw storageCorrupt("Material content exceeds its stored-content size limit.");
    }
    verifyMaterialIdentity(parsed, content);
    await requireSubject(this.#subjects, parsed.subjectId);

    const directory = this.#layout.materialDirectory(parsed.subjectId, parsed.id);
    try {
      await atomicCreateDirectory(this.#layout.root, directory, async (temporaryDirectory) => {
        await createFactFile(
          this.#layout.root,
          join(temporaryDirectory, "material.json"),
          parsed,
          materialFactSchema,
        );
        await atomicCreateFile(this.#layout.root, join(temporaryDirectory, "content.txt"), content);
      });
    } catch (error) {
      if (!isDirectoryCollision(error)) throw error;
      const existing = await this.read(parsed.subjectId, parsed.id);
      if (existing.record.checksum === parsed.checksum && existing.content === content) return;
      throw storageCorrupt("Immutable material id already contains a different fact.", error);
    }
  }

  /**
   * Reads and verifies one material record and its normalized body.
   *
   * @param subjectId - Owning subject path segment.
   * @param materialId - Material path segment.
   * @returns The verified record and exact stored content.
   */
  async read(subjectId: SubjectId, materialId: MaterialId): Promise<StoredMaterial> {
    await requireSubject(this.#subjects, subjectId);
    const record = await readFactFile(
      this.#layout.root,
      this.#layout.materialFile(subjectId, materialId),
      materialFactSchema,
    );
    if (record.subjectId !== subjectId) {
      throw storageCorrupt("Material subject id does not match its fact path.");
    }
    if (record.id !== materialId) {
      throw storageCorrupt("Material id does not match its fact path.");
    }

    let content: string;
    try {
      content = decodeUtf8(
        await readRegularFile(
          this.#layout.root,
          this.#layout.materialContentFile(subjectId, materialId),
          WIRE_LIMITS.materialContentBytes,
        ),
        "Material content",
      );
    } catch (error) {
      if (isMissing(error)) {
        throw storageCorrupt("Material directory is missing content.txt.", error);
      }
      if (error instanceof DistillyError && error.code === "not_found") {
        throw storageCorrupt("Material directory is missing content.txt.", error);
      }
      throw error;
    }
    verifyMaterialIdentity(record, content);
    const entries = await listFactDirectory(
      this.#layout.root,
      this.#layout.materialDirectory(subjectId, materialId),
    );
    if (
      entries.length !== 2 ||
      entries[0]?.name !== "content.txt" ||
      entries[0].kind !== "file" ||
      entries[1]?.name !== "material.json" ||
      entries[1].kind !== "file"
    ) {
      throw storageCorrupt("Material directory contains an unknown or missing entry.");
    }
    return { record, content };
  }

  /**
   * Lists every complete immutable material for one subject in canonical MaterialId order.
   *
   * Unknown, near-miss, non-directory, symbolic-link, or corrupt entries fail closed so verified
   * subject reads cannot overlook an orphan material fact.
   *
   * @param subjectId - Subject whose immutable materials are scanned.
   * @returns Every complete verified material and exact normalized body.
   */
  async list(subjectId: SubjectId): Promise<readonly StoredMaterial[]> {
    await requireSubject(this.#subjects, subjectId);
    const entries = await listFactDirectory(
      this.#layout.root,
      this.#layout.materialsDirectory(subjectId),
    );
    const materials: StoredMaterial[] = [];
    for (const entry of entries) {
      if (entry.kind !== "directory") {
        throw storageCorrupt("Material collection contains a non-directory artifact.");
      }
      let materialId: MaterialId;
      try {
        materialId = materialIdSchema.parse(entry.name);
      } catch (error) {
        throw storageCorrupt("Material collection contains an unknown directory name.", error);
      }
      materials.push(await this.read(subjectId, materialId));
    }
    return materials;
  }
}
