import { DistillyError } from "@distilly/protocol";
import type { MutationContext, RequestId } from "@distilly/protocol";

interface SecureRandomSource {
  getRandomValues<T extends Uint8Array>(target: T): T;
}

const secureRandomSource = (): SecureRandomSource => {
  const source = (globalThis as { readonly crypto?: SecureRandomSource }).crypto;
  if (typeof source?.getRandomValues !== "function") {
    throw new DistillyError({
      code: "host_unsupported",
      message: "This runtime cannot generate a secure mutation request id.",
      retryable: false,
      remediation: "Use a runtime with Web Crypto getRandomValues support.",
    });
  }
  return source;
};

/**
 * Creates one caller-owned 128-bit mutation identity without importing Node APIs.
 *
 * @returns A fresh request id suitable for one top-level facade mutation.
 */
const createMutationRequestId = (): RequestId => {
  const bytes = secureRandomSource().getRandomValues(new Uint8Array(16));
  const suffix = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `req_${suffix}` as RequestId;
};

/**
 * Resolves the explicit request id or creates exactly one for a top-level mutation.
 *
 * @param requestId - Optional caller-provided identity retained across its own retry.
 * @returns The trusted mutation context passed to EngineClient.
 */
export const mutationContext = (requestId?: RequestId): MutationContext => ({
  requestId: requestId ?? createMutationRequestId(),
});
