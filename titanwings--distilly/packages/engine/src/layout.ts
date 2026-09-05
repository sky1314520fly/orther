import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  coreFacetNameSchema,
  eventIdSchema,
  facetPathSchema,
  materialIdSchema,
  requestIdSchema,
  spaceIdSchema,
  subjectIdSchema,
  versionIdSchema,
} from "@distilly/protocol";
import type {
  CoreFacetName,
  EventId,
  MaterialId,
  RequestId,
  SpaceId,
  SubjectId,
  VersionId,
} from "@distilly/protocol";

import { invalidInput } from "./internal-errors.js";

/** Deterministic paths under one configured Distilly fact root. */
export class Layout {
  readonly root: string;

  /**
   * Creates a confined layout rooted at an absolute local path.
   *
   * @param root - Local fact root that confines every derived path.
   */
  constructor(root: string) {
    if (root.trim().length === 0) throw invalidInput("DISTILLY_ROOT cannot be empty.", "root");
    this.root = resolve(root);
  }

  /**
   * Root directory containing space records.
   *
   * @returns The absolute spaces directory path.
   */
  spacesDirectory(): string {
    return this.inside("spaces");
  }

  /**
   * Root directory containing subject facts.
   *
   * @returns The absolute subjects directory path.
   */
  subjectsDirectory(): string {
    return this.inside("subjects");
  }

  /**
   * Root directory containing globally keyed operation facts.
   *
   * @returns The absolute operations directory path.
   */
  operationsDirectory(): string {
    return this.inside("operations");
  }

  /**
   * Root directory containing transaction journals.
   *
   * @returns The absolute transactions directory path.
   */
  transactionsDirectory(): string {
    return this.inside("transactions");
  }

  /**
   * Root directory containing disposable indexes.
   *
   * @returns The absolute index directory path.
   */
  indexDirectory(): string {
    return this.inside(".index");
  }

  /**
   * Path of one space record.
   *
   * @param spaceId - Space identifier used as the file name.
   * @returns The confined absolute space-record path.
   */
  spaceFile(spaceId: SpaceId): string {
    return this.inside("spaces", `${spaceIdSchema.parse(spaceId)}.json`);
  }

  /**
   * Directory containing one subject's facts.
   *
   * @param subjectId - Subject whose fact directory is requested.
   * @returns The confined absolute subject-directory path.
   */
  subjectDirectory(subjectId: SubjectId): string {
    return this.inside("subjects", subjectIdSchema.parse(subjectId));
  }

  /**
   * Candidate-safe subject lock that exists before the subject directory.
   *
   * @param subjectId - Subject whose mutation is serialized.
   * @returns The confined absolute subject-lock path.
   */
  subjectLock(subjectId: SubjectId): string {
    return this.inside("subjects", ".locks", `${subjectIdSchema.parse(subjectId)}.lock`);
  }

  /**
   * Path of one subject identity record.
   *
   * @param subjectId - Subject whose identity record is requested.
   * @returns The confined absolute subject-record path.
   */
  subjectFile(subjectId: SubjectId): string {
    return this.inside("subjects", subjectIdSchema.parse(subjectId), "subject.json");
  }

  /**
   * Path of one authoritative subject state record.
   *
   * @param subjectId - Subject whose current state is requested.
   * @returns The confined absolute state-record path.
   */
  stateFile(subjectId: SubjectId): string {
    return this.inside("subjects", subjectIdSchema.parse(subjectId), "state.json");
  }

  /**
   * Directory containing all immutable materials for one subject.
   *
   * @param subjectId - Subject that owns the material collection.
   * @returns The confined absolute material-collection path.
   */
  materialsDirectory(subjectId: SubjectId): string {
    return this.inside("subjects", subjectIdSchema.parse(subjectId), "knowledge", "materials");
  }

  /**
   * Directory containing one immutable material and its text.
   *
   * @param subjectId - Subject that owns the material.
   * @param materialId - Material identifier used as the directory name.
   * @returns The confined absolute material-directory path.
   */
  materialDirectory(subjectId: SubjectId, materialId: MaterialId): string {
    return resolve(this.materialsDirectory(subjectId), materialIdSchema.parse(materialId));
  }

  /**
   * Path of one immutable material record.
   *
   * @param subjectId - Subject that owns the material.
   * @param materialId - Material whose record is requested.
   * @returns The confined absolute material-record path.
   */
  materialFile(subjectId: SubjectId, materialId: MaterialId): string {
    return this.inside(
      "subjects",
      subjectIdSchema.parse(subjectId),
      "knowledge",
      "materials",
      materialIdSchema.parse(materialId),
      "material.json",
    );
  }

  /**
   * Path of one immutable material body.
   *
   * @param subjectId - Subject that owns the material.
   * @param materialId - Material whose text is requested.
   * @returns The confined absolute material-content path.
   */
  materialContentFile(subjectId: SubjectId, materialId: MaterialId): string {
    return this.inside(
      "subjects",
      subjectIdSchema.parse(subjectId),
      "knowledge",
      "materials",
      materialIdSchema.parse(materialId),
      "content.txt",
    );
  }

  /**
   * Directory containing immutable events for one subject.
   *
   * @param subjectId - Subject that owns the event facts.
   * @returns The confined absolute event directory.
   */
  eventsDirectory(subjectId: SubjectId): string {
    return this.inside("subjects", subjectIdSchema.parse(subjectId), "events");
  }

  /**
   * Path of one immutable event record.
   *
   * @param subjectId - Subject that owns the event.
   * @param eventId - Event identifier used as the file name.
   * @returns The confined absolute event-record path.
   */
  eventFile(subjectId: SubjectId, eventId: EventId): string {
    return resolve(this.eventsDirectory(subjectId), `${eventIdSchema.parse(eventId)}.json`);
  }

  /**
   * Path of one globally keyed completed operation or purge tombstone.
   *
   * @param requestId - Globally unique request identifier.
   * @returns The confined absolute operation-fact path.
   */
  operationFile(requestId: RequestId): string {
    return this.inside("operations", `${requestIdSchema.parse(requestId)}.json`);
  }

  /**
   * Cross-process lock for one globally unique request id.
   *
   * @param requestId - Globally unique request identifier.
   * @returns The confined absolute request-lock path.
   */
  requestLock(requestId: RequestId): string {
    return this.inside("operations", ".locks", `${requestIdSchema.parse(requestId)}.lock`);
  }

  /**
   * Path of one root transaction journal.
   *
   * @param requestId - Journal request identifier.
   * @returns The confined absolute transaction-record path.
   */
  transactionFile(requestId: RequestId): string {
    return this.inside("transactions", `${requestIdSchema.parse(requestId)}.json`);
  }

  /**
   * Directory containing one immutable profile version.
   *
   * @param subjectId - Subject that owns the version.
   * @param versionId - Immutable profile version identifier.
   * @returns The confined absolute version-directory path.
   */
  versionDirectory(subjectId: SubjectId, versionId: VersionId): string {
    return this.inside(
      "subjects",
      subjectIdSchema.parse(subjectId),
      "versions",
      versionIdSchema.parse(versionId),
    );
  }

  /**
   * Directory containing one subject's immutable versions and fixed staging area.
   *
   * @param subjectId - Subject that owns the versions.
   * @returns The confined absolute versions-directory path.
   */
  versionsDirectory(subjectId: SubjectId): string {
    return this.inside("subjects", subjectIdSchema.parse(subjectId), "versions");
  }

  /**
   * Path of immutable metadata for one profile version.
   *
   * @param subjectId - Subject that owns the version.
   * @param versionId - Immutable profile version identifier.
   * @returns The absolute version-record path.
   */
  versionFile(subjectId: SubjectId, versionId: VersionId): string {
    return resolve(this.versionDirectory(subjectId, versionId), "version.json");
  }

  /**
   * Path of the immutable material manifest for one profile version.
   *
   * @param subjectId - Subject that owns the version.
   * @param versionId - Immutable profile version identifier.
   * @returns The absolute version-material-manifest path.
   */
  versionMaterialManifestFile(subjectId: SubjectId, versionId: VersionId): string {
    return resolve(this.versionDirectory(subjectId, versionId), "materials.json");
  }

  /**
   * Path of the immutable claims snapshot for one profile version.
   *
   * @param subjectId - Subject that owns the version.
   * @param versionId - Immutable profile version identifier.
   * @returns The absolute version-claims-snapshot path.
   */
  versionClaimsFile(subjectId: SubjectId, versionId: VersionId): string {
    return resolve(this.versionDirectory(subjectId, versionId), "claims.json");
  }

  /**
   * Profile-artifact directory inside one immutable version.
   *
   * @param subjectId - Subject that owns the version.
   * @param versionId - Immutable profile version identifier.
   * @returns The absolute immutable profile-artifact directory.
   */
  versionProfileDirectory(subjectId: SubjectId, versionId: VersionId): string {
    return resolve(this.versionDirectory(subjectId, versionId), "profile");
  }

  /**
   * Combined profile projection inside one immutable version.
   *
   * @param subjectId - Subject that owns the version.
   * @param versionId - Immutable profile version identifier.
   * @returns The absolute combined-profile path.
   */
  versionProfileFile(subjectId: SubjectId, versionId: VersionId): string {
    return resolve(this.versionProfileDirectory(subjectId, versionId), "profile.md");
  }

  /**
   * One canonical core-facet projection inside an immutable version.
   *
   * @param subjectId - Subject that owns the version.
   * @param versionId - Immutable profile version identifier.
   * @param facet - Canonical core facet whose projection is requested.
   * @returns The absolute core-facet projection path.
   */
  versionCoreProfileFile(subjectId: SubjectId, versionId: VersionId, facet: CoreFacetName): string {
    return resolve(
      this.versionProfileDirectory(subjectId, versionId),
      `${coreFacetNameSchema.parse(facet)}.md`,
    );
  }

  /**
   * Domain-projection directory inside one immutable version.
   *
   * @param subjectId - Subject that owns the version.
   * @param versionId - Immutable profile version identifier.
   * @returns The absolute immutable domain-projection directory.
   */
  versionDomainsDirectory(subjectId: SubjectId, versionId: VersionId): string {
    return resolve(this.versionProfileDirectory(subjectId, versionId), "domains");
  }

  /**
   * One safe-root domain projection inside an immutable version.
   *
   * @param subjectId - Subject that owns the version.
   * @param versionId - Immutable profile version identifier.
   * @param domainRoot - Valid single-segment FacetPath root.
   * @returns The absolute immutable domain-projection path.
   */
  versionDomainProfileFile(subjectId: SubjectId, versionId: VersionId, domainRoot: string): string {
    return resolve(
      this.versionDomainsDirectory(subjectId, versionId),
      `${this.safeFacetRoot(domainRoot)}.md`,
    );
  }

  /**
   * Complete prompt projection inside one immutable version.
   *
   * @param subjectId - Subject that owns the version.
   * @param versionId - Immutable profile version identifier.
   * @returns The absolute immutable prompt path.
   */
  versionPromptFile(subjectId: SubjectId, versionId: VersionId): string {
    return resolve(this.versionDirectory(subjectId, versionId), "prompt.md");
  }

  /**
   * Current-profile projection directory rebuilt from an immutable version.
   *
   * @param subjectId - Subject whose current projection is requested.
   * @returns The absolute current-profile directory.
   */
  currentProfileDirectory(subjectId: SubjectId): string {
    return resolve(this.subjectDirectory(subjectId), "profile");
  }

  /**
   * Fixed sibling staging directory for one journal-owned current projection rebuild.
   *
   * @param requestId - Commit journal that owns the rebuild.
   * @param subjectId - Subject whose projection is being rebuilt.
   * @param versionId - Immutable source version.
   * @returns The absolute sibling staging directory.
   */
  currentProfileStagingDirectory(
    requestId: RequestId,
    subjectId: SubjectId,
    versionId: VersionId,
  ): string {
    return resolve(
      this.subjectDirectory(subjectId),
      `.profile.staging.${requestIdSchema.parse(requestId)}.${versionIdSchema.parse(versionId)}`,
    );
  }

  /**
   * Fixed sibling backup used only while replacing one current projection.
   *
   * @param requestId - Commit journal that owns the rebuild.
   * @param subjectId - Subject whose projection is being rebuilt.
   * @param versionId - Immutable source version.
   * @returns The absolute sibling backup directory.
   */
  currentProfileBackupDirectory(
    requestId: RequestId,
    subjectId: SubjectId,
    versionId: VersionId,
  ): string {
    return resolve(
      this.subjectDirectory(subjectId),
      `.profile.previous.${requestIdSchema.parse(requestId)}.${versionIdSchema.parse(versionId)}`,
    );
  }

  /**
   * Combined current profile projection.
   *
   * @param subjectId - Subject whose projection is requested.
   * @returns The absolute combined current-profile path.
   */
  currentProfileFile(subjectId: SubjectId): string {
    return resolve(this.currentProfileDirectory(subjectId), "profile.md");
  }

  /**
   * One canonical core-facet current projection.
   *
   * @param subjectId - Subject whose projection is requested.
   * @param facet - Canonical core facet whose projection is requested.
   * @returns The absolute current core-facet path.
   */
  currentCoreProfileFile(subjectId: SubjectId, facet: CoreFacetName): string {
    return resolve(
      this.currentProfileDirectory(subjectId),
      `${coreFacetNameSchema.parse(facet)}.md`,
    );
  }

  /**
   * Directory containing current domain projections.
   *
   * @param subjectId - Subject whose domain projections are requested.
   * @returns The absolute current domain-projection directory.
   */
  currentDomainsDirectory(subjectId: SubjectId): string {
    return resolve(this.currentProfileDirectory(subjectId), "domains");
  }

  /**
   * One safe-root current domain projection.
   *
   * @param subjectId - Subject whose projection is requested.
   * @param domainRoot - Valid single-segment FacetPath root.
   * @returns The absolute current domain-projection path.
   */
  currentDomainProfileFile(subjectId: SubjectId, domainRoot: string): string {
    return resolve(this.currentDomainsDirectory(subjectId), `${this.safeFacetRoot(domainRoot)}.md`);
  }

  /**
   * Current prompt projection.
   *
   * @param subjectId - Subject whose prompt projection is requested.
   * @returns The absolute current prompt path.
   */
  currentPromptFile(subjectId: SubjectId): string {
    return resolve(this.currentProfileDirectory(subjectId), "prompt.md");
  }

  /**
   * Path of the disposable canonical Library projection.
   *
   * @returns The confined absolute Library projection path.
   */
  libraryFile(): string {
    return this.inside(".index", "library.json");
  }

  /**
   * Path of the exact fixed-byte Library projection dirty marker.
   *
   * @returns The confined absolute Library dirty-marker path.
   */
  libraryDirtyFile(): string {
    return this.inside(".index", "library.dirty");
  }

  /**
   * Path of the owner-token Library writer intent marker.
   *
   * @returns The confined absolute Library intent-marker path.
   */
  libraryIntentFile(): string {
    return this.inside(".index", "library.intent");
  }

  /**
   * Cross-process lock covering every Library projection read and write.
   *
   * @returns The confined absolute Library lock-directory path.
   */
  libraryLock(): string {
    return this.inside(".index", "library.lock");
  }

  /**
   * Verifies that a derived path remains below this root.
   *
   * @param path - Candidate path to validate against the configured root.
   */
  assertInside(path: string): void {
    const absolute = resolve(path);
    const fromRoot = relative(this.root, absolute);
    if (
      fromRoot === "" ||
      (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
    ) {
      return;
    }
    throw invalidInput("Fact path escapes DISTILLY_ROOT.");
  }

  private inside(...segments: readonly string[]): string {
    const path = resolve(this.root, ...segments);
    this.assertInside(path);
    return path;
  }

  private safeFacetRoot(value: string): string {
    const parsed = facetPathSchema.parse(value);
    if (parsed.includes(".")) {
      throw invalidInput("Profile domain file name must be one facet root.");
    }
    return parsed;
  }
}
