import type {
  CommitResult,
  CorrectionDraft,
  EngineClient,
  ExportOptions,
  ExportRef,
  HostName,
  IngestFilesInput,
  IngestFilesResult,
  IngestResult,
  InstallOptions,
  InstallRef,
  LineageInput,
  LineagePage,
  MaterialInput,
  PendingJob,
  Profile,
  ProfileDiff,
  RedistillInput,
  SubjectId,
  SubjectStatus,
  VersionId,
  VersionPage,
  VersionQuery,
  VersionSummary,
} from "@distilly/protocol";
import { DistillyError } from "@distilly/protocol";

import type { MutationOptions } from "./distilly.js";
import { mutationContext } from "./request-id.js";

/** Typed handle for every operation scoped to one subject id. */
export class Person {
  readonly #client: EngineClient;
  readonly id: SubjectId;

  /**
   * Creates a subject-scoped handle over an already-bound client session.
   *
   * @param client - Client whose trusted session is reused by this handle.
   * @param subjectId - Stable subject identity bound to every method.
   */
  constructor(client: EngineClient, subjectId: SubjectId) {
    this.#client = client;
    this.id = subjectId;
  }

  /**
   * Reads the current or selected immutable profile.
   *
   * @param options - Optional immutable version selector.
   * @param options.versionId - Exact immutable version to read.
   * @returns The verified profile.
   */
  async get(options?: { readonly versionId?: VersionId }): Promise<Profile> {
    return this.#client.call("profiles.get", {
      subjectId: this.id,
      ...(options?.versionId === undefined ? {} : { versionId: options.versionId }),
    });
  }

  /**
   * Reads the current or selected prompt projection.
   *
   * @param options - Optional immutable version selector.
   * @param options.versionId - Exact immutable version to read.
   * @returns Complete prompt text.
   */
  async prompt(options?: { readonly versionId?: VersionId }): Promise<string> {
    return this.#client.call("profiles.prompt", {
      subjectId: this.id,
      ...(options?.versionId === undefined ? {} : { versionId: options.versionId }),
    });
  }

  /**
   * Reads current subject distillation and review state.
   *
   * @returns Current subject status.
   */
  async status(): Promise<SubjectStatus> {
    return this.#client.call("profiles.status", { subjectId: this.id });
  }

  /**
   * Stores normalized text materials for this subject.
   *
   * @param materials - Text and provenance inputs.
   * @param options - Queueing policy for the resulting material set.
   * @param options.enqueue - Automatic or immediate queue policy.
   * @param mutation - Optional request identity for replay.
   * @returns Atomic ingest result.
   */
  async ingest(
    materials: readonly MaterialInput[],
    options: { readonly enqueue: "auto" | "now" },
    mutation?: MutationOptions,
  ): Promise<IngestResult> {
    return this.#client.call(
      "materials.ingest",
      {
        subject: { kind: "existing", subjectId: this.id },
        materials,
        enqueue: options.enqueue,
      },
      mutationContext(mutation?.requestId),
    );
  }

  /**
   * Stores raw files and any parser-derived materials for this subject.
   *
   * @param paths - Explicit local input paths.
   * @param options - Queueing and optional sensitivity policy.
   * @param mutation - Optional request identity for replay.
   * @returns Parsed and unparsed file results.
   */
  async ingestFiles(
    paths: readonly string[],
    options: Omit<IngestFilesInput, "subject" | "paths">,
    mutation?: MutationOptions,
  ): Promise<IngestFilesResult> {
    return this.#client.call(
      "materials.ingestFiles",
      {
        subject: { kind: "existing", subjectId: this.id },
        paths,
        enqueue: options.enqueue,
        ...(options.sensitivity === undefined ? {} : { sensitivity: options.sensitivity }),
      },
      mutationContext(mutation?.requestId),
    );
  }

  /**
   * Records a correction through the connected session actor.
   *
   * @param input - Correction text and optional claim targets.
   * @param mutation - Optional request identity for replay.
   * @returns Current or mechanically suspended correction result.
   */
  async correct(input: CorrectionDraft, mutation?: MutationOptions): Promise<CommitResult> {
    return this.#client.call(
      "profiles.correct",
      { subjectId: this.id, correction: input },
      mutationContext(mutation?.requestId),
    );
  }

  /**
   * Enqueues an explicit incremental or full redistillation.
   *
   * @param input - Redistillation mode and reason.
   * @param mutation - Optional request identity for replay.
   * @returns The pending job.
   */
  async redistill(
    input: Omit<RedistillInput, "subjectId">,
    mutation?: MutationOptions,
  ): Promise<PendingJob> {
    return this.#client.call(
      "distill.redistill",
      { subjectId: this.id, mode: input.mode, reason: input.reason },
      mutationContext(mutation?.requestId),
    );
  }

  /**
   * Lists immutable versions for this subject.
   *
   * @param options - Optional cursor and page limit.
   * @returns A page of version summaries in engine order.
   */
  async versions(options: Omit<VersionQuery, "subjectId"> = {}): Promise<VersionPage> {
    return this.#client.call("versions.list", {
      subjectId: this.id,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
  }

  /**
   * Computes a semantic diff between two immutable versions.
   *
   * @param before - Earlier version identity.
   * @param after - Later version identity.
   * @returns The engine-derived profile diff.
   */
  async diff(before: VersionId, after: VersionId): Promise<ProfileDiff> {
    return this.#client.call("versions.diff", { subjectId: this.id, before, after });
  }

  /**
   * Creates a new current version from an immutable historical version.
   *
   * @param input - Target version and required reason.
   * @param input.versionId - Immutable version to restore.
   * @param input.reason - Auditable rollback reason.
   * @param mutation - Optional request identity for replay.
   * @returns The rollback version summary.
   */
  async rollback(
    input: { readonly versionId: VersionId; readonly reason: string },
    mutation?: MutationOptions,
  ): Promise<VersionSummary> {
    return this.#client.call(
      "versions.rollback",
      { subjectId: this.id, targetVersionId: input.versionId, reason: input.reason },
      mutationContext(mutation?.requestId),
    );
  }

  /**
   * Reads projected lineage events for this subject.
   *
   * @param options - Optional cursor and page limit.
   * @returns A page of projected lineage events.
   */
  async lineage(options: Omit<LineageInput, "subjectId"> = {}): Promise<LineagePage> {
    return this.#client.call("versions.lineage", {
      subjectId: this.id,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
  }

  /**
   * Installs this subject's profile for a registered host.
   *
   * @param host - Registered host name.
   * @param options - Optional version and destination.
   * @param mutation - Optional request identity for replay.
   * @returns Installation manifest reference.
   */
  async install(
    host: HostName,
    options?: InstallOptions,
    mutation?: MutationOptions,
  ): Promise<InstallRef> {
    return this.#client.call(
      "hosts.install",
      {
        subjectId: this.id,
        host,
        ...(options === undefined ? {} : { options }),
      },
      mutationContext(mutation?.requestId),
    );
  }

  /**
   * Removes one engine-owned installation projection.
   *
   * @param ref - Installation manifest returned by install.
   * @param mutation - Optional request identity for replay.
   * @returns Completion after the engine returns its null wire result.
   */
  async uninstall(ref: InstallRef, mutation?: MutationOptions): Promise<void> {
    if (ref.subjectId !== this.id) {
      throw new DistillyError({
        code: "invalid_input",
        message: "Install reference does not belong to this Person.",
        retryable: false,
        fieldPath: "ref.subjectId",
      });
    }
    await this.#client.call(
      "hosts.uninstall",
      { install: ref },
      mutationContext(mutation?.requestId),
    );
  }

  /**
   * Exports this subject through a registered host renderer.
   *
   * @param host - Registered host name.
   * @param options - Destination and version policy.
   * @param mutation - Optional request identity for replay.
   * @returns Export manifest reference.
   */
  async export(
    host: HostName,
    options: ExportOptions,
    mutation?: MutationOptions,
  ): Promise<ExportRef> {
    return this.#client.call(
      "hosts.export",
      { subjectId: this.id, host, options },
      mutationContext(mutation?.requestId),
    );
  }

  /**
   * Archives this subject without deleting its facts.
   *
   * @param mutation - Optional request identity for replay.
   * @returns Completion after the engine returns its null wire result.
   */
  async archive(mutation?: MutationOptions): Promise<void> {
    await this.#client.call(
      "subjects.archive",
      { subjectId: this.id },
      mutationContext(mutation?.requestId),
    );
  }
}
