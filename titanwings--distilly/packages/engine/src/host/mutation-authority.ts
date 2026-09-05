import type { DatabaseSync } from "node:sqlite";

import {
  DistillyError,
  actorContextSchema,
  engineMethodSchemas,
  factChecksumSchema,
  mutationContextSchema,
  requestIdSchema,
} from "@distilly/protocol";
import type {
  ActorContext,
  EngineMethodMap,
  ExportRef,
  HostExportInput,
  InstallInput,
  InstallRef,
  MutationContext,
  SubjectId,
  UninstallInput,
} from "@distilly/protocol";

import type { Clock } from "../defaults/system-clock.js";
import { canonicalJson } from "../facts/canonical-json.js";
import { invalidInput, storageCorrupt } from "../internal-errors.js";
import {
  computeMutationInputChecksum,
  insertCompletedOperationInTransaction,
  replayCompletedMutation,
} from "../storage/mutation-ledger.js";
import type { SqliteEngineStore } from "../storage/sqlite-engine-store.js";

/** Host mutations whose external effect is coordinated by the trusted Runtime. */
export type PreviewHostMutationMethod = "hosts.install" | "hosts.uninstall" | "hosts.export";

type HostParams<M extends PreviewHostMutationMethod> = EngineMethodMap[M]["params"];
type HostResult<M extends PreviewHostMutationMethod> = EngineMethodMap[M]["result"];

/**
 * SQLite half of the Preview's host projection protocol.
 *
 * Runtime performs the host filesystem effect only after `replay` returns undefined, then records
 * the stable result with `complete`. Actor identity remains a trusted Runtime input rather than a
 * value supplied by the model or Panel.
 */
export interface PreviewHostMutationAuthority {
  replay<M extends PreviewHostMutationMethod>(
    method: M,
    params: HostParams<M>,
    actor: ActorContext,
    mutation: MutationContext,
  ): Promise<HostResult<M> | undefined>;

  complete<M extends PreviewHostMutationMethod>(
    method: M,
    params: HostParams<M>,
    actor: ActorContext,
    mutation: MutationContext,
    result: HostResult<M>,
  ): Promise<HostResult<M>>;
}

interface InstallProvenanceRow {
  readonly request_id: unknown;
  readonly actor_json: unknown;
  readonly input_checksum: unknown;
}

interface ParsedMutation<M extends PreviewHostMutationMethod> {
  readonly method: M;
  readonly params: HostParams<M>;
  readonly actor: ActorContext;
  readonly mutation: MutationContext;
  readonly inputChecksum: ReturnType<typeof computeMutationInputChecksum>;
}

const isPreviewHostMutationMethod = (value: string): value is PreviewHostMutationMethod =>
  value === "hosts.install" || value === "hosts.uninstall" || value === "hosts.export";

const parseBoundary = <T>(parse: () => T, fieldPath: string): T => {
  try {
    return parse();
  } catch (error) {
    if (error instanceof DistillyError) throw error;
    throw invalidInput("The Preview host mutation boundary is invalid.", fieldPath);
  }
};

const parseStored = <T>(parse: () => T, label: string): T => {
  try {
    return parse();
  } catch (error) {
    if (error instanceof DistillyError) throw error;
    throw storageCorrupt(`SQLite ${label} is invalid.`, error);
  }
};

const storedText = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw storageCorrupt(`SQLite ${label} is invalid.`);
  return value;
};

const parseStoredJson = (value: string, label: string): unknown => {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw storageCorrupt(`SQLite ${label} is not valid JSON.`, error);
  }
};

const parseMutation = <M extends PreviewHostMutationMethod>(
  rawMethod: M,
  rawParams: HostParams<M>,
  rawActor: ActorContext,
  rawMutation: MutationContext,
): ParsedMutation<M> => {
  if (!isPreviewHostMutationMethod(rawMethod)) {
    throw invalidInput("The Preview host mutation method is invalid.", "method");
  }
  const params = parseBoundary(
    () => engineMethodSchemas[rawMethod].params.parse(rawParams) as HostParams<M>,
    "params",
  );
  const actor = parseBoundary(() => actorContextSchema.parse(rawActor) as ActorContext, "actor");
  const mutation = parseBoundary(
    () => mutationContextSchema.parse(rawMutation) as MutationContext,
    "mutation",
  );
  return {
    method: rawMethod,
    params,
    actor,
    mutation,
    inputChecksum: computeMutationInputChecksum(rawMethod, params, actor),
  };
};

const mutationSubjectId = <M extends PreviewHostMutationMethod>(
  method: M,
  params: HostParams<M>,
): SubjectId => {
  switch (method) {
    case "hosts.install":
      return (params as InstallInput).subjectId;
    case "hosts.uninstall":
      return (params as UninstallInput).install.subjectId;
    case "hosts.export":
      return (params as HostExportInput).subjectId;
  }
};

const assertResultMatchesRequest = <M extends PreviewHostMutationMethod>(
  method: M,
  params: HostParams<M>,
  result: HostResult<M>,
): void => {
  switch (method) {
    case "hosts.install": {
      const request = params as InstallInput;
      const install = result as InstallRef;
      if (
        install.subjectId !== request.subjectId ||
        install.host !== request.host ||
        (request.options?.versionId !== undefined &&
          install.versionId !== request.options.versionId)
      ) {
        throw invalidInput("The host installation result disagrees with its request.", "result");
      }
      return;
    }
    case "hosts.uninstall":
      return;
    case "hosts.export": {
      const request = params as HostExportInput;
      const exported = result as ExportRef;
      if (
        exported.subjectId !== request.subjectId ||
        exported.host !== request.host ||
        (request.options.versionId !== undefined &&
          exported.versionId !== request.options.versionId)
      ) {
        throw invalidInput("The host export result disagrees with its request.", "result");
      }
    }
  }
};

const readInstallProvenanceRows = (
  database: DatabaseSync,
  install: InstallRef,
): readonly InstallProvenanceRow[] => {
  try {
    return database
      .prepare(
        `SELECT request_id, actor_json, input_checksum
         FROM operations
         WHERE method = 'hosts.install'
           AND scope_subject_id = ?
           AND result_json = ?
         ORDER BY request_id`,
      )
      .all(install.subjectId, canonicalJson(install)) as unknown as readonly InstallProvenanceRow[];
  } catch (error) {
    throw storageCorrupt("SQLite could not verify installation provenance.", error);
  }
};

/**
 * Proves that an uninstall target is the exact stable result of a completed install operation.
 *
 * This runs before Runtime receives authorization to touch the manifest path. The operation row is
 * re-read through the shared ledger verifier so a string match cannot bypass actor, scope, schema,
 * or canonical-encoding checks.
 *
 * @param database - Connection inside the caller's consistent read or write transaction.
 * @param install - Strictly parsed installation reference that Runtime wants to remove.
 */
const assertInstallProvenanceInTransaction = (
  database: DatabaseSync,
  install: InstallRef,
): void => {
  const expectedResult = canonicalJson(install);
  const rows = readInstallProvenanceRows(database, install);
  if (rows.length === 0) {
    throw invalidInput(
      "The installation reference is not backed by a completed Distilly installation.",
      "params.install",
    );
  }

  const row = rows[0]!;
  const requestId = parseStored(
    () => requestIdSchema.parse(storedText(row.request_id, "install operation request id")),
    "install operation request id",
  );
  const inputChecksum = parseStored(
    () =>
      factChecksumSchema.parse(storedText(row.input_checksum, "install operation input checksum")),
    "install operation input checksum",
  );
  const actorJson = storedText(row.actor_json, "install operation actor");
  const actor = parseStored(
    () => actorContextSchema.parse(parseStoredJson(actorJson, "install operation actor")),
    "install operation actor",
  ) as ActorContext;
  if (canonicalJson(actor) !== actorJson) {
    throw storageCorrupt("SQLite install operation actor is not canonically encoded.");
  }
  const replay = replayCompletedMutation(database, {
    requestId,
    method: "hosts.install",
    inputChecksum,
    actor,
  });
  if (replay === undefined || canonicalJson(replay) !== expectedResult) {
    throw storageCorrupt("SQLite installation provenance disagrees with its stable result.");
  }
};

/** SQLite implementation used only through the Preview Engine composition. */
export class SqlitePreviewHostMutationAuthority implements PreviewHostMutationAuthority {
  readonly #store: SqliteEngineStore;
  readonly #clock: Clock;

  /**
   * Creates the Runtime-facing authority over one root's single SQLite writer.
   *
   * @param dependencies - Store and canonical clock owned by the Engine composition.
   * @param dependencies.store - Root-scoped SQLite transaction authority.
   * @param dependencies.clock - Canonical completion timestamp source.
   */
  constructor(dependencies: { readonly store: SqliteEngineStore; readonly clock: Clock }) {
    this.#store = dependencies.store;
    this.#clock = dependencies.clock;
  }

  /**
   * Returns an exact completed result, or authorizes one new external effect.
   *
   * An unseen uninstall is authorized only after its exact InstallRef provenance is proven.
   *
   * @param method - Exact host mutation discriminant.
   * @param params - Strict Protocol method parameters.
   * @param actor - Trusted actor bound by Runtime.
   * @param mutation - Caller RequestId retained across retries.
   * @returns The stable prior result, or undefined when Runtime may perform the effect.
   */
  replay<M extends PreviewHostMutationMethod>(
    method: M,
    params: HostParams<M>,
    actor: ActorContext,
    mutation: MutationContext,
  ): Promise<HostResult<M> | undefined> {
    return Promise.resolve().then(() => {
      const parsed = parseMutation(method, params, actor, mutation);
      return this.#store.read((database) => {
        const replay = replayCompletedMutation(database, {
          requestId: parsed.mutation.requestId,
          method: parsed.method,
          inputChecksum: parsed.inputChecksum,
          actor: parsed.actor,
        }) as HostResult<M> | undefined;
        if (replay === undefined && parsed.method === "hosts.uninstall") {
          assertInstallProvenanceInTransaction(database, (parsed.params as UninstallInput).install);
        }
        return replay;
      });
    });
  }

  /**
   * Atomically records one host effect's strict stable result.
   *
   * @param method - Exact host mutation discriminant.
   * @param params - Same strict parameters used for the prior replay check.
   * @param actor - Same trusted actor used for the prior replay check.
   * @param mutation - Same caller RequestId used for the prior replay check.
   * @param rawResult - Result returned by the selected full HostBinding.
   * @returns The newly recorded result or exact winner of a concurrent replay.
   */
  complete<M extends PreviewHostMutationMethod>(
    method: M,
    params: HostParams<M>,
    actor: ActorContext,
    mutation: MutationContext,
    rawResult: HostResult<M>,
  ): Promise<HostResult<M>> {
    return Promise.resolve().then(() => {
      const parsed = parseMutation(method, params, actor, mutation);
      return this.#store.write((database) => {
        const replay = replayCompletedMutation(database, {
          requestId: parsed.mutation.requestId,
          method: parsed.method,
          inputChecksum: parsed.inputChecksum,
          actor: parsed.actor,
        }) as HostResult<M> | undefined;
        if (replay !== undefined) return replay;

        if (parsed.method === "hosts.uninstall") {
          assertInstallProvenanceInTransaction(database, (parsed.params as UninstallInput).install);
        }
        const result = parseBoundary(
          () => engineMethodSchemas[parsed.method].result.parse(rawResult) as HostResult<M>,
          "result",
        );
        assertResultMatchesRequest(parsed.method, parsed.params, result);
        insertCompletedOperationInTransaction(database, {
          requestId: parsed.mutation.requestId,
          method: parsed.method,
          subjectId: mutationSubjectId(parsed.method, parsed.params),
          actor: parsed.actor,
          inputChecksum: parsed.inputChecksum,
          result,
          completedAt: this.#clock.now(),
        });
        return result;
      });
    });
  }
}
