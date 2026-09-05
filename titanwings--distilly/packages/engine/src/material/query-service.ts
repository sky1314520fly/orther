import { materialIdSchema } from "@distilly/protocol";
import type {
  GetMaterialInput,
  JsonObject,
  MaterialId,
  MaterialPage,
  MaterialQuery,
  MaterialSummary,
  MaterialView,
  SourceGroupingContext,
  SubjectId,
  VersionMaterialEntry,
} from "@distilly/protocol";

import type { FileMaterialStore, StoredMaterial } from "../facts/material-store.js";
import {
  factNotFound,
  invalidInput,
  schemaUnsupported,
  storageCorrupt,
} from "../internal-errors.js";
import { deriveSourceGroups } from "../ingest/source-groups.js";
import { compareUtf8 } from "../profile/claim-id.js";
import type { CommittedVersionReader } from "../read/committed-version-reader.js";
import { decodeCursor, encodeCursor } from "../read/cursor.js";

const DEFAULT_PAGE_LIMIT = 50;
const SOURCE_GROUPING_VERSION = "source-groups-v1";

interface MaterialSnapshot {
  readonly records: readonly StoredMaterial[];
  readonly currentMaterialIds: ReadonlySet<MaterialId>;
  readonly grouping: SourceGroupingContext;
}

const readManifest = async (
  materials: FileMaterialStore,
  subjectId: SubjectId,
  entries: readonly VersionMaterialEntry[],
): Promise<readonly StoredMaterial[]> => {
  const stored = await Promise.all(
    entries.map(async (entry) => {
      const material = await materials.read(subjectId, entry.materialId);
      if (
        material.record.contentDigest !== entry.contentDigest ||
        material.record.provenanceDigest !== entry.provenanceDigest
      ) {
        throw storageCorrupt("A material read snapshot does not match its verified manifest.");
      }
      if (material.record.derivation.kind === "raw_extract") {
        throw schemaUnsupported("Raw-extracted material reads require the future RawStore slice.");
      }
      return material;
    }),
  );
  return stored.sort((left, right) => compareUtf8(left.record.id, right.record.id));
};

const scalarCount = (value: string): number => Array.from(value).length;

const queryFilters = (input: MaterialQuery): JsonObject => ({
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

/** Verified material list and exact-content reads for current or historical snapshots. */
export class MaterialQueryService {
  readonly #materials: FileMaterialStore;
  readonly #committedVersions: CommittedVersionReader;

  /**
   * Creates material reads over verified state and immutable versions.
   *
   * @param input - Fact stores required to resolve complete material snapshots.
   * @param input.materials - Immutable material records and bodies.
   * @param input.committedVersions - Coordinated committed-version snapshot reader.
   */
  constructor(input: {
    readonly materials: FileMaterialStore;
    readonly committedVersions: CommittedVersionReader;
  }) {
    this.#materials = input.materials;
    this.#committedVersions = input.committedVersions;
  }

  private async snapshot(
    subjectId: SubjectId,
    atVersionId?: MaterialQuery["atVersionId"],
  ): Promise<MaterialSnapshot> {
    return this.#committedVersions.withSnapshot(subjectId, async (committed) => {
      const { state } = committed;
      const currentMaterialIds = new Set(state.materialManifest.map((entry) => entry.materialId));
      if (atVersionId === undefined) {
        return {
          records: await readManifest(this.#materials, subjectId, state.materialManifest),
          currentMaterialIds,
          grouping: {
            algorithmVersion: SOURCE_GROUPING_VERSION,
            generation: state.generation,
          },
        };
      }

      const version = committed.versionsById.get(atVersionId);
      if (version === undefined) {
        throw factNotFound("The selected immutable version does not exist for this subject.");
      }
      return {
        records: await readManifest(this.#materials, subjectId, version.manifest.items),
        currentMaterialIds,
        grouping: {
          algorithmVersion: version.version.quality.sourceGroupingVersion,
          generation: version.version.generation,
          versionId: version.version.id,
        },
      };
    });
  }

  /**
   * Lists one stable MaterialId-ordered page without material bodies.
   *
   * @param input - Typed material filters and page boundary.
   * @returns A verified page of material summaries.
   */
  async list(input: MaterialQuery): Promise<MaterialPage> {
    const snapshot = await this.snapshot(input.subjectId, input.atVersionId);
    const groups = deriveSourceGroups(
      snapshot.records.map((material) => material.record),
      snapshot.grouping.algorithmVersion,
    ).groups;
    const matching = snapshot.records.filter(
      (material) => input.kind === undefined || material.record.kind === input.kind,
    );
    const filters = queryFilters(input);
    const boundary =
      input.cursor === undefined
        ? undefined
        : decodeCursor(input.cursor, "materials.list", filters);
    const boundaryMaterialId =
      boundary === undefined ? undefined : materialCursorBoundary(boundary);
    const remaining =
      boundaryMaterialId === undefined
        ? matching
        : matching.filter((material) => compareUtf8(material.record.id, boundaryMaterialId) > 0);
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    const selected = remaining.slice(0, limit);
    const items: MaterialSummary[] = selected.map((material) => {
      const sourceGroup = groups.get(material.record.id);
      if (sourceGroup === undefined) {
        throw storageCorrupt("A grouped material snapshot is missing one manifest member.");
      }
      return {
        record: material.record,
        contentScalarCount: scalarCount(material.content),
        rawAvailable: false,
        inCurrentGeneration: snapshot.currentMaterialIds.has(material.record.id),
        sourceGroup,
        grouping: snapshot.grouping,
      };
    });
    const last = selected.at(-1);
    const result: MaterialPage = {
      items,
      ...(remaining.length <= limit || last === undefined
        ? {}
        : {
            nextCursor: encodeCursor("materials.list", filters, [last.record.id]),
          }),
    };
    return result;
  }

  /**
   * Reads one exact material body from the selected verified snapshot.
   *
   * @param input - Typed exact material locator.
   * @returns The verified material, body, and grouping context.
   */
  async get(input: GetMaterialInput): Promise<MaterialView> {
    const snapshot = await this.snapshot(input.subjectId, input.atVersionId);
    const selected = snapshot.records.find((material) => material.record.id === input.materialId);
    if (selected === undefined) {
      throw factNotFound("The selected material is not present in this subject snapshot.");
    }
    const sourceGroup = deriveSourceGroups(
      snapshot.records.map((material) => material.record),
      snapshot.grouping.algorithmVersion,
    ).groups.get(selected.record.id);
    if (sourceGroup === undefined) {
      throw storageCorrupt("A grouped material snapshot is missing the selected material.");
    }
    const result: MaterialView = {
      record: selected.record,
      content: selected.content,
      rawAvailable: false,
      inCurrentGeneration: snapshot.currentMaterialIds.has(selected.record.id),
      sourceGroup,
      grouping: snapshot.grouping,
    };
    return result;
  }
}
