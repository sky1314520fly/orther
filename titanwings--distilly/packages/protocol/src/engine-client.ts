import type { EngineEvent } from "./events.js";
import type { EngineMethodMap, MutationMethodName, QueryMethodName } from "./methods.js";
import type { MutationContext } from "./values.js";
import type {
  SystemBackupInput,
  SystemBackupResult,
  SystemRestoreInput,
  SystemRestoreResult,
} from "./values/hosts.js";

export type Unsubscribe = () => void;

/** Root-owner maintenance client kept outside ordinary business methods. */
export interface EngineAdministrationClient {
  backup(input: SystemBackupInput): Promise<SystemBackupResult>;
  restore(input: SystemRestoreInput): Promise<SystemRestoreResult>;
}

/** Typed client shared by SDK, MCP, CLI, panel, and runtime dispatchers. */
export interface EngineClient {
  /**
   * Calls a read-only engine method.
   *
   * @param method - Query method name.
   * @param params - Parameters paired with the selected method.
   * @returns The selected method's result.
   */
  call<M extends QueryMethodName>(
    method: M,
    params: EngineMethodMap[M]["params"],
  ): Promise<EngineMethodMap[M]["result"]>;

  /**
   * Calls an idempotent mutation engine method.
   *
   * @param method - Mutation method name.
   * @param params - Parameters paired with the selected method.
   * @param context - Trusted request identity for idempotency.
   * @returns The selected method's result.
   */
  call<M extends MutationMethodName>(
    method: M,
    params: EngineMethodMap[M]["params"],
    context: MutationContext,
  ): Promise<EngineMethodMap[M]["result"]>;

  /**
   * Subscribes to post-commit invalidation signals.
   *
   * @param handler - Event callback that should re-read affected state.
   * @returns An unsubscribe function.
   */
  watch(handler: (event: EngineEvent) => void): Promise<Unsubscribe>;

  /**
   * Detaches this client session without closing shared runtime resources.
   *
   * @returns Completion after the session is detached.
   */
  close(): Promise<void>;
}

export type RuntimeOwnedMethodName =
  "hosts.install" | "hosts.uninstall" | "hosts.export" | "system.doctor";

export type CoreMethodName = Exclude<keyof EngineMethodMap, RuntimeOwnedMethodName>;

/** Engine-core client before runtime-owned host and doctor composition. */
export interface CoreEngineClient {
  /**
   * Calls a core read-only method.
   *
   * @param method - Core query method name.
   * @param params - Parameters paired with the selected method.
   * @returns The selected method's result.
   */
  call<M extends Extract<CoreMethodName, QueryMethodName>>(
    method: M,
    params: EngineMethodMap[M]["params"],
  ): Promise<EngineMethodMap[M]["result"]>;

  /**
   * Calls a core idempotent mutation method.
   *
   * @param method - Core mutation method name.
   * @param params - Parameters paired with the selected method.
   * @param context - Trusted request identity for idempotency.
   * @returns The selected method's result.
   */
  call<M extends Extract<CoreMethodName, MutationMethodName>>(
    method: M,
    params: EngineMethodMap[M]["params"],
    context: MutationContext,
  ): Promise<EngineMethodMap[M]["result"]>;

  /**
   * Subscribes to post-commit invalidation signals.
   *
   * @param handler - Event callback that should re-read affected state.
   * @returns An unsubscribe function.
   */
  watch(handler: (event: EngineEvent) => void): Promise<Unsubscribe>;

  /**
   * Detaches this client session without closing shared engine resources.
   *
   * @returns Completion after the session is detached.
   */
  close(): Promise<void>;
}
