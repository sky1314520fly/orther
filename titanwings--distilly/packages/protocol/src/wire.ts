import type { RequestId } from "./ids.js";
import type { DistillyWireError } from "./errors.js";

/** Current incompatible wire protocol generation. */
export const WIRE_VERSION = "3" as const;

/** Common fields carried by every model-facing request. */
export interface WireRequest {
  readonly wireVersion: typeof WIRE_VERSION;
  readonly requestId: RequestId;
}

/** Successful model-facing result envelope. */
export interface WireSuccess<T> {
  readonly ok: true;
  readonly wireVersion: typeof WIRE_VERSION;
  readonly value: T;
}

/** Failed model-facing result envelope. */
export interface WireFailure {
  readonly ok: false;
  readonly wireVersion: typeof WIRE_VERSION;
  readonly error: DistillyWireError;
}

/** Minimal runtime-schema surface exposed without coupling consumers to Zod. */
export interface RuntimeSchema<T> {
  parse(value: unknown): T;
}
