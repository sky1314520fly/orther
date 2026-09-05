import {
  DistillyError,
  actorContextSchema,
  engineMethodSchemas,
  mutationContextSchema,
} from "@distilly/protocol";
import type {
  ActorContext,
  CreateSubjectInput,
  EngineEvent,
  MutationContext,
  SubjectSummary,
} from "@distilly/protocol";

import type { Clock } from "../defaults/system-clock.js";
import { invalidInput } from "../internal-errors.js";
import type { EventBus } from "../ports/event-bus.js";
import type { IdGenerator } from "../ports/id-generator.js";
import {
  computeMutationInputChecksum,
  insertCompletedOperationInTransaction,
  insertEventInTransaction,
  replayCompletedMutation,
} from "../storage/mutation-ledger.js";
import type { SqliteEngineStore } from "../storage/sqlite-engine-store.js";
import { normalizeCreateSubjectInput } from "./identity.js";
import { createSubjectIdentityInTransaction } from "./transactional-identity.js";

export { summarizeSubject } from "./summary.js";

/** Concrete dependencies for standalone SQLite subject creation. */
export interface SubjectCreateServiceDependencies {
  readonly store: SqliteEngineStore;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly eventBus: EventBus;
  readonly hooks?: SubjectCreateServiceHooks;
}

/** Fault hooks used by transaction/crash tests at durable create boundaries. */
export interface SubjectCreateServiceHooks {
  /** Runs synchronously after all SQL writes and immediately before COMMIT. */
  readonly beforeTransactionCommit?: (requestId: MutationContext["requestId"]) => void;
  /** Runs after COMMIT and before post-commit invalidation publication. */
  readonly afterTransactionCommit?: (
    requestId: MutationContext["requestId"],
  ) => void | Promise<void>;
}

interface SubjectCreateOutcome {
  readonly result: SubjectSummary;
  readonly events: readonly EngineEvent[];
  readonly committed: boolean;
}

const parseCreateBoundary = <T>(parse: () => T, fieldPath: string): T => {
  try {
    return parse();
  } catch (error) {
    if (error instanceof DistillyError) throw error;
    throw invalidInput("The subjects.create boundary input is invalid.", fieldPath);
  }
};

/** Package-private standalone `subjects.create` mutation over SQLite/WAL authority. */
export class SubjectCreateService {
  readonly #dependencies: SubjectCreateServiceDependencies;

  /**
   * Creates a subject mutation from the root-scoped SQLite composition.
   *
   * @param dependencies - SQLite authority and trusted identity/event seams.
   */
  constructor(dependencies: SubjectCreateServiceDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Creates one subject with globally keyed replay and a post-commit invalidation event.
   *
   * @param rawInput - Untrusted method parameters parsed at this boundary.
   * @param rawActor - Trusted actor attached by the calling client composition.
   * @param rawMutation - Caller-owned RequestId retained across retries.
   * @returns The exact stored subject summary on both first execution and replay.
   */
  async create(
    rawInput: CreateSubjectInput,
    rawActor: ActorContext,
    rawMutation: MutationContext,
  ): Promise<SubjectSummary> {
    const input = parseCreateBoundary(
      () => engineMethodSchemas["subjects.create"].params.parse(rawInput),
      "params",
    );
    const actor = parseCreateBoundary(
      () => actorContextSchema.parse(rawActor) as ActorContext,
      "actor",
    );
    const mutation = parseCreateBoundary(
      () => mutationContextSchema.parse(rawMutation) as MutationContext,
      "requestId",
    );
    const normalized = normalizeCreateSubjectInput(input);
    const inputChecksum = computeMutationInputChecksum("subjects.create", normalized, actor);
    const storedReplay = this.#dependencies.store.read((database) =>
      replayCompletedMutation(database, {
        requestId: mutation.requestId,
        method: "subjects.create",
        inputChecksum,
        actor,
      }),
    );
    if (storedReplay !== undefined) return storedReplay;
    const candidateSubjectId = this.#dependencies.ids.subjectId();

    const outcome = this.#dependencies.store.write((database): SubjectCreateOutcome => {
      const replay = replayCompletedMutation(database, {
        requestId: mutation.requestId,
        method: "subjects.create",
        inputChecksum,
        actor,
      });
      if (replay !== undefined) return { result: replay, events: [], committed: false };

      const result = createSubjectIdentityInTransaction(
        database,
        normalized,
        this.#dependencies.ids,
        candidateSubjectId,
      );
      const now = this.#dependencies.clock.now();
      insertCompletedOperationInTransaction(database, {
        requestId: mutation.requestId,
        method: "subjects.create",
        subjectId: result.id,
        actor,
        inputChecksum,
        result,
        completedAt: now,
      });
      const event: EngineEvent = {
        kind: "subject.created",
        subjectId: result.id,
        at: now,
      };
      insertEventInTransaction(database, {
        eventId: this.#dependencies.ids.eventId(),
        event,
        actor,
        requestId: mutation.requestId,
      });
      this.#dependencies.hooks?.beforeTransactionCommit?.(mutation.requestId);
      return { result, events: [event], committed: true };
    });

    if (outcome.committed) {
      await this.#dependencies.hooks?.afterTransactionCommit?.(mutation.requestId);
      for (const event of outcome.events) await this.#dependencies.eventBus.publish(event);
    }
    return outcome.result;
  }
}
