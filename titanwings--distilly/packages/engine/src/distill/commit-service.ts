import type { DatabaseSync } from "node:sqlite";

import {
  DistillyError,
  clientSessionContextSchema,
  engineMethodSchemas,
  mutationContextSchema,
} from "@distilly/protocol";
import type {
  ClientSessionContext,
  CommitInput,
  CommitResult,
  EngineEvent,
  IsoDateTime,
  MutationContext,
  PendingJobMarker,
  Profile,
  ReviewReason,
  SubjectStateRecord,
  VersionClaimsSnapshot,
  VersionMaterialManifest,
  VersionRecord,
  VersionSummary,
} from "@distilly/protocol";

import type { Clock } from "../defaults/system-clock.js";
import { canonicalJson } from "../facts/canonical-json.js";
import { sealFact } from "../facts/checksum.js";
import { digestDistillPatch, hashMaterialSet, verifyMaterialIdentity } from "../facts/digests.js";
import {
  invalidInput,
  leaseConflict,
  leaseExpired,
  reviewConflict,
  schemaUnsupported,
  staleJob,
  storageCorrupt,
} from "../internal-errors.js";
import { applyClaimPatch, finalizeClaims } from "../profile/apply-patch.js";
import {
  buildMaterialEvidenceIndex,
  strengthenClaims,
  summarizeQuality,
} from "../profile/quality.js";
import { PROFILE_RENDERER_VERSION, renderProfile, renderPrompt } from "../profile/render.js";
import { evaluateHostReviewReasons } from "../profile/review-gate.js";
import { deriveVersionId } from "../profile/version-id.js";
import type { EventBus } from "../ports/event-bus.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { ContentAddressedBlobStore } from "../storage/content-addressed-blob-store.js";
import {
  computeMutationInputChecksum,
  insertCompletedOperationInTransaction,
  insertEventInTransaction,
  replayCompletedMutation,
} from "../storage/mutation-ledger.js";
import {
  materialManifestFromSqlite,
  readSqliteMaterialsInTransaction,
} from "../storage/sqlite-material-reader.js";
import type { SqliteMaterialDescriptor } from "../storage/sqlite-material-reader.js";
import type { SqliteEngineStore } from "../storage/sqlite-engine-store.js";
import {
  insertSqliteVersionInTransaction,
  readSqliteVersionInTransaction,
} from "../version/sqlite-authority.js";
import type { SqliteStoredVersion } from "../version/sqlite-authority.js";
import { buildEvidenceContext } from "./evidence-context.js";
import type { PromptCatalog } from "./prompt-catalog.js";
import { resolveHostPatch } from "./resolve-evidence.js";
import {
  readSqlitePendingAuthorityInTransaction,
  sameSqlitePendingGeneration,
  sqliteLeaseActiveAt,
} from "./sqlite-pending-authority.js";
import type { SqlitePendingAuthority } from "./sqlite-pending-authority.js";
import { validateAcceptedPatchBytes } from "./validate-patch.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/** Fault-injection seams for the SQLite commit transaction and crash matrix. */
export interface CommitServiceHooks {
  /** Runs after deterministic preparation and before opening the write transaction. */
  readonly beforeCommitTransaction?: (
    requestId: MutationContext["requestId"],
  ) => void | Promise<void>;
  /** Runs synchronously after all SQL writes and immediately before SQLite COMMIT. */
  readonly beforeTransactionCommit?: (requestId: MutationContext["requestId"]) => void;
  /** Runs after SQLite COMMIT and before event publication. */
  readonly afterTransactionCommit?: (
    requestId: MutationContext["requestId"],
  ) => void | Promise<void>;
}

/** Concrete dependencies for one SQLite-backed host claim commit. */
export interface CommitServiceDependencies {
  readonly store: SqliteEngineStore;
  readonly blobs: ContentAddressedBlobStore;
  readonly promptCatalog: PromptCatalog;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly eventBus: EventBus;
  readonly hooks?: CommitServiceHooks;
}

interface CommitSnapshot {
  readonly authority: SqlitePendingAuthority;
  readonly subjectDisplayName: string;
  readonly materials: readonly SqliteMaterialDescriptor[];
  readonly baseline?: SqliteStoredVersion;
}

interface PreparedCommit {
  readonly snapshot: CommitSnapshot;
  readonly claims: VersionClaimsSnapshot;
  readonly manifest: VersionMaterialManifest;
  readonly quality: VersionRecord["quality"];
  readonly reasons?: readonly [ReviewReason, ...ReviewReason[]];
  readonly profile: Profile;
  readonly versionId: VersionRecord["id"];
  readonly creation: Extract<VersionRecord["creation"], { readonly kind: "host_distill" }>;
  readonly acceptedPatchDigest: ReturnType<typeof digestDistillPatch>;
}

interface CommitTransactionOutcome {
  readonly result: CommitResult;
  readonly events: readonly EngineEvent[];
  readonly committed: boolean;
}

const parseBoundary = <T>(parse: () => T, fieldPath: string): T => {
  try {
    return parse();
  } catch (error) {
    if (error instanceof DistillyError) throw error;
    throw invalidInput("The distillation commit boundary input is invalid.", fieldPath);
  }
};

const nonEmptyReasons = (
  reasons: readonly ReviewReason[],
): readonly [ReviewReason, ...ReviewReason[]] | undefined => {
  const [first, ...rest] = reasons;
  return first === undefined ? undefined : [first, ...rest];
};

const versionSummary = (
  version: VersionRecord,
  status: "current" | "suspended",
): VersionSummary => ({
  id: version.id,
  subjectId: version.subjectId,
  ...(version.parentId === undefined ? {} : { parentId: version.parentId }),
  ...(version.derivedFromCandidateVersionId === undefined
    ? {}
    : { derivedFromCandidateVersionId: version.derivedFromCandidateVersionId }),
  generation: version.generation,
  materialSetHash: version.materialSetHash,
  creation: version.creation,
  status,
  actor: version.actor,
  quality: version.quality,
  createdAt: version.createdAt,
});

const requireMatchingInput = (
  input: CommitInput,
  session: ClientSessionContext,
  authority: SqlitePendingAuthority,
  now: IsoDateTime,
): void => {
  if (authority.suspendedVersionId !== undefined) throw reviewConflict();
  if (
    authority.jobId !== input.jobId ||
    authority.generation !== input.generation ||
    authority.baseVersionId !== input.baseVersionId ||
    authority.currentVersionId !== input.baseVersionId ||
    authority.materialSetHash !== input.materialSetHash
  ) {
    throw staleJob();
  }
  const lease = authority.lease;
  if (lease === undefined) throw leaseConflict("The commit job has no active lease.");
  if (lease.contract.digest !== input.briefContractDigest) {
    throw staleJob("The commit brief contract no longer matches the active lease.");
  }
  if (lease.id !== input.leaseId || lease.owner !== session.leaseOwner) {
    throw leaseConflict("The commit lease belongs to a different session or is not active.");
  }
  if (!sqliteLeaseActiveAt(lease, now)) throw leaseExpired();
};

const readCommitSnapshot = (
  database: DatabaseSync,
  input: CommitInput,
  session: ClientSessionContext,
  now: IsoDateTime,
): CommitSnapshot => {
  const authority = readSqlitePendingAuthorityInTransaction(database, input.jobId);
  if (authority === undefined) throw staleJob();
  requireMatchingInput(input, session, authority, now);
  const subjectRow = database
    .prepare("SELECT display_name FROM subjects WHERE id = ?")
    .get(authority.subjectId) as { readonly display_name?: unknown } | undefined;
  if (typeof subjectRow?.display_name !== "string" || subjectRow.display_name.length === 0) {
    throw storageCorrupt("SQLite commit subject is missing its display name.");
  }
  const materials = readSqliteMaterialsInTransaction(database, authority.subjectId);
  const manifest = materialManifestFromSqlite(materials);
  if (
    materials.length !== authority.totalMaterialCount ||
    hashMaterialSet(manifest) !== authority.materialSetHash
  ) {
    throw storageCorrupt("SQLite pending authority disagrees with current material membership.");
  }
  const baseline =
    authority.currentVersionId === undefined
      ? undefined
      : readSqliteVersionInTransaction(database, authority.subjectId, authority.currentVersionId);
  if (
    (authority.currentVersionId === undefined) !== (baseline === undefined) ||
    (baseline !== undefined && baseline.status !== "current")
  ) {
    throw storageCorrupt("SQLite current version pointer has no verified current authority.");
  }
  return {
    authority,
    subjectDisplayName: subjectRow.display_name,
    materials,
    ...(baseline === undefined ? {} : { baseline }),
  };
};

const stateForEvidence = (snapshot: CommitSnapshot): SubjectStateRecord => {
  const authority = snapshot.authority;
  const lease = authority.lease;
  if (lease === undefined) throw storageCorrupt("A commit snapshot lost its verified lease.");
  const pending: PendingJobMarker = {
    jobId: authority.jobId,
    generation: authority.generation,
    ...(authority.baseVersionId === undefined ? {} : { baseVersionId: authority.baseVersionId }),
    materialSetHash: authority.materialSetHash,
    addedMaterialCount: authority.addedMaterialCount,
    totalMaterialCount: authority.totalMaterialCount,
    queuedAt: authority.queuedAt,
    lease: {
      id: lease.id,
      owner: lease.owner,
      acquiredAt: lease.acquiredAt,
      expiresAt: lease.expiresAt,
      contract: lease.contract,
    },
  };
  return sealFact<SubjectStateRecord>({
    schemaVersion: 2,
    subjectId: authority.subjectId,
    generation: authority.generation,
    materialSetHash: authority.materialSetHash,
    materialManifest: materialManifestFromSqlite(snapshot.materials),
    ...(authority.currentVersionId === undefined
      ? {}
      : { currentVersionId: authority.currentVersionId }),
    ...(authority.suspendedVersionId === undefined
      ? {}
      : { suspendedVersionId: authority.suspendedVersionId }),
    pending,
  });
};

const assertPinnedContractAvailable = async (
  promptCatalog: PromptCatalog,
  authority: SqlitePendingAuthority,
): Promise<void> => {
  const contract = authority.lease?.contract;
  if (contract === undefined) throw storageCorrupt("A commit snapshot lost its brief contract.");
  const available = await promptCatalog.load();
  if (
    contract.sourceGroupingVersion !== available.sourceGroupingVersion ||
    contract.promptVersion !== available.promptVersion ||
    contract.draftSchemaVersion !== available.draftSchemaVersion ||
    contract.digest !== available.digest
  ) {
    throw schemaUnsupported("The commit lease pins an unavailable distillation algorithm.");
  }
};

const prepareCommit = (
  input: CommitInput,
  session: ClientSessionContext,
  snapshot: CommitSnapshot,
  materialBodies: ReadonlyMap<SqliteMaterialDescriptor["record"]["id"], string>,
): PreparedCommit => {
  const state = stateForEvidence(snapshot);
  const storedMaterials = snapshot.materials.map(({ record }) => {
    const content = materialBodies.get(record.id);
    if (content === undefined) throw storageCorrupt("A commit material body is missing.");
    return { record, content };
  });
  const contract = snapshot.authority.lease!.contract;
  const context = buildEvidenceContext({
    subjectId: snapshot.authority.subjectId,
    state,
    materials: storedMaterials,
    ...(snapshot.baseline === undefined ? {} : { baseline: snapshot.baseline }),
    contract,
  });
  const resolved = resolveHostPatch(input.patch, context);
  const baseClaims = [...context.baseClaims.values()];
  const provisional = applyClaimPatch(snapshot.authority.subjectId, baseClaims, resolved);
  const evidenceIndex = buildMaterialEvidenceIndex(
    snapshot.materials.map(({ record }) => record),
    context.grouping,
  );
  const strengthened = strengthenClaims(provisional, evidenceIndex);
  const quality = summarizeQuality(strengthened, evidenceIndex);
  const reasons = nonEmptyReasons(
    evaluateHostReviewReasons({
      ...(snapshot.baseline === undefined
        ? {}
        : {
            before: {
              claims: snapshot.baseline.claims.claims,
              quality: snapshot.baseline.version.quality,
            },
          }),
      after: { claims: strengthened, quality },
      materials: evidenceIndex,
      ...(resolved.reviewRequest === undefined ? {} : { reviewRequest: resolved.reviewRequest }),
    }),
  );
  const disposition = reasons === undefined ? "current" : "suspended";
  const creation = {
    kind: "host_distill",
    briefContractDigest: contract.digest,
    promptVersion: contract.promptVersion,
    draftSchemaVersion: contract.draftSchemaVersion,
  } as const;
  const identity = {
    subjectId: snapshot.authority.subjectId,
    subjectDisplayName: snapshot.subjectDisplayName,
    generation: snapshot.authority.generation,
    materialSetHash: snapshot.authority.materialSetHash,
    ...(snapshot.authority.currentVersionId === undefined
      ? {}
      : { parentId: snapshot.authority.currentVersionId }),
    creation,
    actor: session.actor,
    createdDisposition: disposition,
    rendererVersion: PROFILE_RENDERER_VERSION,
    ...(reasons === undefined ? {} : { reviewReasons: reasons }),
    quality,
  } as const;
  const versionId = deriveVersionId(identity, strengthened);
  const claims = finalizeClaims(strengthened, versionId);
  const rendering = renderProfile({
    subjectId: snapshot.authority.subjectId,
    displayName: snapshot.subjectDisplayName,
    versionId,
    claims,
    quality,
  });
  const profile: Profile = {
    subjectId: snapshot.authority.subjectId,
    displayName: snapshot.subjectDisplayName,
    versionId,
    claims,
    core: rendering.core,
    domains: rendering.domains,
    rendered: rendering.markdown,
    quality,
  };
  void renderPrompt(profile);
  return {
    snapshot,
    claims: sealFact<VersionClaimsSnapshot>({
      schemaVersion: 1,
      subjectId: snapshot.authority.subjectId,
      versionId,
      claims,
    }),
    manifest: sealFact<VersionMaterialManifest>({
      schemaVersion: 1,
      items: state.materialManifest,
    }),
    quality,
    ...(reasons === undefined ? {} : { reasons }),
    profile,
    versionId,
    creation,
    acceptedPatchDigest: digestDistillPatch(input.patch),
  };
};

const verifyCommitReplay = (database: DatabaseSync, result: CommitResult): CommitResult => {
  const summary = result.kind === "current" ? result.version : result.candidate;
  const stored = readSqliteVersionInTransaction(database, summary.subjectId, summary.id);
  if (stored === undefined || stored.version.createdDisposition !== result.kind) {
    throw storageCorrupt("SQLite commit replay is missing its immutable version authority.");
  }
  const expectedSummary = versionSummary(stored.version, result.kind);
  if (canonicalJson(expectedSummary) !== canonicalJson(summary)) {
    throw storageCorrupt("SQLite commit replay disagrees with its immutable version summary.");
  }
  if (result.kind === "current") {
    const rendering = renderProfile({
      subjectId: stored.version.subjectId,
      displayName: stored.version.subjectDisplayName,
      versionId: stored.version.id,
      claims: stored.claims.claims,
      quality: stored.version.quality,
    });
    const profile: Profile = {
      subjectId: stored.version.subjectId,
      displayName: stored.version.subjectDisplayName,
      versionId: stored.version.id,
      claims: stored.claims.claims,
      core: rendering.core,
      domains: rendering.domains,
      rendered: rendering.markdown,
      quality: stored.version.quality,
    };
    if (canonicalJson(profile) !== canonicalJson(result.profile)) {
      throw storageCorrupt("SQLite commit replay profile disagrees with version authority.");
    }
  } else if (
    canonicalJson(stored.version.reviewReasons) !== canonicalJson(result.reasons) ||
    stored.version.parentId !== result.currentVersionId ||
    result.review.subjectId !== stored.version.subjectId ||
    result.review.candidateVersionId !== stored.version.id
  ) {
    throw storageCorrupt("SQLite suspended replay disagrees with its review authority.");
  }
  return result;
};

const sameMaterialMembership = (
  left: readonly SqliteMaterialDescriptor[],
  right: readonly SqliteMaterialDescriptor[],
): boolean =>
  left.length === right.length &&
  left.every((material, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      material.record.id === other.record.id &&
      material.record.contentDigest === other.record.contentDigest &&
      material.record.provenanceDigest === other.record.provenanceDigest
    );
  });

const retireCurrentVersionInTransaction = (
  database: DatabaseSync,
  prepared: PreparedCommit,
  disposition: "current" | "suspended",
): void => {
  const authority = prepared.snapshot.authority;
  if (disposition === "current" && authority.currentVersionId !== undefined) {
    const status = database
      .prepare(
        `UPDATE version_statuses
         SET status = 'historical'
         WHERE version_id = ? AND subject_id = ? AND status = 'current'`,
      )
      .run(authority.currentVersionId, authority.subjectId);
    if (status.changes !== 1) {
      throw storageCorrupt("SQLite current version status changed before commit.");
    }
  }
};

const updatePointersInTransaction = (
  database: DatabaseSync,
  prepared: PreparedCommit,
  disposition: "current" | "suspended",
): void => {
  const authority = prepared.snapshot.authority;
  const pointer = database
    .prepare(
      disposition === "current"
        ? `UPDATE subject_states
           SET current_version_id = ?, suspended_version_id = NULL
           WHERE subject_id = ? AND generation = ? AND material_set_hash = ?
             AND current_version_id IS ? AND suspended_version_id IS NULL`
        : `UPDATE subject_states
           SET suspended_version_id = ?
           WHERE subject_id = ? AND generation = ? AND material_set_hash = ?
             AND current_version_id IS ? AND suspended_version_id IS NULL`,
    )
    .run(
      prepared.versionId,
      authority.subjectId,
      authority.generation,
      authority.materialSetHash,
      authority.currentVersionId ?? null,
    );
  if (pointer.changes !== 1) throw staleJob("The subject pointers changed before commit.");
};

/** SQLite/WAL coordinator for deterministic host claim commits. */
export class CommitService {
  readonly #dependencies: CommitServiceDependencies;

  /**
   * Creates the SQLite host-commit coordinator.
   *
   * @param dependencies - SQLite, blob, prompt, clock, id, and event seams.
   */
  constructor(dependencies: CommitServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Commits one claim-only host patch against its active leased generation.
   *
   * @param rawInput - Untrusted host commit parameters.
   * @param rawSession - Trusted actor and lease-owner session.
   * @param rawMutation - Globally idempotent request context.
   * @returns Exact stored current or suspended commit result.
   */
  async commit(
    rawInput: CommitInput,
    rawSession: ClientSessionContext,
    rawMutation: MutationContext,
  ): Promise<CommitResult> {
    const input = parseBoundary(
      () => engineMethodSchemas["distill.commit"].params.parse(rawInput),
      "params",
    );
    validateAcceptedPatchBytes(input.patch);
    const session = parseBoundary(
      () => clientSessionContextSchema.parse(rawSession) as ClientSessionContext,
      "session",
    );
    const mutation = parseBoundary(
      () => mutationContextSchema.parse(rawMutation) as MutationContext,
      "requestId",
    );
    const inputChecksum = computeMutationInputChecksum("distill.commit", input, session.actor, {
      leaseOwnerId: session.leaseOwner,
    });
    const earlyReplay = this.#dependencies.store.read((database) => {
      const result = replayCompletedMutation(database, {
        requestId: mutation.requestId,
        method: "distill.commit",
        inputChecksum,
        actor: session.actor,
      });
      return result === undefined ? undefined : verifyCommitReplay(database, result);
    });
    if (earlyReplay !== undefined) return earlyReplay;

    const blobAccess = await this.#dependencies.blobs.acquireReadAccess();
    try {
      const snapshot = this.#dependencies.store.read((database) =>
        readCommitSnapshot(database, input, session, this.#dependencies.clock.now()),
      );
      await assertPinnedContractAvailable(this.#dependencies.promptCatalog, snapshot.authority);
      const materialBodies = new Map<SqliteMaterialDescriptor["record"]["id"], string>();
      for (const material of snapshot.materials) {
        const bytes = await blobAccess.read(material.blobDigest, material.blobByteLength);
        let content: string;
        try {
          content = UTF8_DECODER.decode(bytes);
        } catch (error) {
          throw storageCorrupt("A commit material blob is not valid UTF-8.", error);
        }
        verifyMaterialIdentity(material.record, content);
        materialBodies.set(material.record.id, content);
      }
      const prepared = prepareCommit(input, session, snapshot, materialBodies);
      await this.#dependencies.hooks?.beforeCommitTransaction?.(mutation.requestId);
      const outcome = this.#dependencies.store.write((database): CommitTransactionOutcome => {
        const replay = replayCompletedMutation(database, {
          requestId: mutation.requestId,
          method: "distill.commit",
          inputChecksum,
          actor: session.actor,
        });
        if (replay !== undefined) {
          return { result: verifyCommitReplay(database, replay), events: [], committed: false };
        }
        const authority = readSqlitePendingAuthorityInTransaction(database, input.jobId);
        if (authority === undefined) throw staleJob();
        const now = this.#dependencies.clock.now();
        requireMatchingInput(input, session, authority, now);
        if (!sameSqlitePendingGeneration(prepared.snapshot.authority, authority)) {
          throw staleJob("The pending generation changed before commit.");
        }
        const currentMaterials = readSqliteMaterialsInTransaction(database, authority.subjectId);
        if (!sameMaterialMembership(prepared.snapshot.materials, currentMaterials)) {
          throw staleJob("The material membership changed before commit.");
        }
        const subject = database
          .prepare("SELECT display_name FROM subjects WHERE id = ?")
          .get(authority.subjectId) as { readonly display_name?: unknown } | undefined;
        if (subject?.display_name !== prepared.snapshot.subjectDisplayName) {
          throw staleJob("The subject identity changed before commit.");
        }
        const disposition = prepared.reasons === undefined ? "current" : "suspended";
        const version = sealFact<VersionRecord>({
          schemaVersion: 1,
          id: prepared.versionId,
          subjectId: authority.subjectId,
          subjectDisplayName: prepared.snapshot.subjectDisplayName,
          ...(authority.currentVersionId === undefined
            ? {}
            : { parentId: authority.currentVersionId }),
          generation: authority.generation,
          materialSetHash: authority.materialSetHash,
          materialCount: prepared.manifest.items.length,
          creation: prepared.creation,
          createdDisposition: disposition,
          ...(prepared.reasons === undefined ? {} : { reviewReasons: prepared.reasons }),
          actor: session.actor,
          quality: prepared.quality,
          rendererVersion: PROFILE_RENDERER_VERSION,
          createdAt: now,
        });
        retireCurrentVersionInTransaction(database, prepared, disposition);
        insertSqliteVersionInTransaction(database, {
          version,
          manifest: prepared.manifest,
          claims: prepared.claims,
          status: disposition,
          acceptedPatchDigest: prepared.acceptedPatchDigest,
        });
        updatePointersInTransaction(database, prepared, disposition);
        const removed = database
          .prepare(
            `DELETE FROM pending_jobs
             WHERE subject_id = ? AND job_id = ? AND generation = ?
               AND material_set_hash = ? AND base_version_id IS ?`,
          )
          .run(
            authority.subjectId,
            authority.jobId,
            authority.generation,
            authority.materialSetHash,
            authority.baseVersionId ?? null,
          );
        if (removed.changes !== 1) throw staleJob("The pending job changed before commit.");
        const summary = versionSummary(version, disposition);
        const result: CommitResult =
          prepared.reasons === undefined
            ? { kind: "current", version: summary, profile: prepared.profile }
            : {
                kind: "suspended",
                candidate: summary,
                ...(authority.currentVersionId === undefined
                  ? {}
                  : { currentVersionId: authority.currentVersionId }),
                reasons: prepared.reasons,
                review: { subjectId: authority.subjectId, candidateVersionId: version.id },
              };
        insertCompletedOperationInTransaction(database, {
          requestId: mutation.requestId,
          method: "distill.commit",
          subjectId: authority.subjectId,
          actor: session.actor,
          inputChecksum,
          result,
          completedAt: now,
        });
        const events: readonly EngineEvent[] = [
          {
            kind: disposition === "current" ? "version.current" : "version.suspended",
            subjectId: authority.subjectId,
            versionId: version.id,
            at: now,
          },
          { kind: "job.changed", subjectId: authority.subjectId, at: now },
        ];
        for (const event of events) {
          insertEventInTransaction(database, {
            eventId: this.#dependencies.ids.eventId(),
            event,
            actor: session.actor,
            requestId: mutation.requestId,
          });
        }
        this.#dependencies.hooks?.beforeTransactionCommit?.(mutation.requestId);
        return { result, events, committed: true };
      });
      if (outcome.committed) {
        await this.#dependencies.hooks?.afterTransactionCommit?.(mutation.requestId);
        for (const event of outcome.events) await this.#dependencies.eventBus.publish(event);
      }
      return outcome.result;
    } finally {
      await blobAccess.release();
    }
  }
}
