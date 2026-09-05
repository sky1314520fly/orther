import { hostNameSchema, type HostName } from "@distilly/protocol";

import type { HostRegistryBinding } from "./protocol.js";

class DuplicateHostBindingError extends Error {
  public constructor(host: HostName) {
    super(`A host binding is already registered for ${host}.`);
    this.name = "DuplicateHostBindingError";
  }
}

const compareUtf8 = (left: string, right: string): number => {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
};

const requireMethod = (binding: Record<string, unknown>, name: string): void => {
  if (typeof binding[name] !== "function") {
    throw new TypeError(`Host binding ${name} must be a function.`);
  }
};

const validateBinding = (candidate: HostRegistryBinding): HostRegistryBinding => {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new TypeError("Host binding must be an object.");
  }
  const binding = candidate as unknown as Record<string, unknown>;
  const host = hostNameSchema.safeParse(binding.host);
  if (!host.success) throw new TypeError("Host binding host must be a valid HostName.");
  requireMethod(binding, "preflight");

  if (binding.kind === "capability") return candidate;
  if (binding.kind !== "full") {
    throw new TypeError("Host binding kind must be capability or full.");
  }

  for (const method of [
    "createInjector",
    "createFormRenderer",
    "installPlugin",
    "uninstallPlugin",
    "doctor",
  ]) {
    requireMethod(binding, method);
  }
  if (
    binding.createPrivateUiCaptureController !== undefined &&
    typeof binding.createPrivateUiCaptureController !== "function"
  ) {
    throw new TypeError(
      "Host binding createPrivateUiCaptureController must be a function when present.",
    );
  }
  return candidate;
};

/** Registry of exactly one capability or full binding per validated host name. */
export class HostRegistry {
  readonly #bindings = new Map<HostName, HostRegistryBinding>();

  /**
   * Registers one validated binding without replacing an existing host entry.
   *
   * @param binding - Capability or full binding to register.
   */
  public register(binding: HostRegistryBinding): void {
    const validated = validateBinding(binding);
    if (this.#bindings.has(validated.host)) {
      throw new DuplicateHostBindingError(validated.host);
    }
    this.#bindings.set(validated.host, validated);
  }

  /**
   * Returns the exact binding registered for a validated host name.
   *
   * @param host - Validated host name to look up.
   * @returns Registered binding, or undefined when the host is absent.
   */
  public get(host: HostName): HostRegistryBinding | undefined {
    const parsed = hostNameSchema.safeParse(host);
    if (!parsed.success) throw new TypeError("Host must be a valid HostName.");
    return this.#bindings.get(parsed.data);
  }

  /**
   * Returns an immutable snapshot ordered by canonical UTF-8 host-name bytes.
   *
   * @returns Frozen, deterministically ordered registry snapshot.
   */
  public list(): readonly HostRegistryBinding[] {
    return Object.freeze(
      [...this.#bindings.values()].sort((left, right) => compareUtf8(left.host, right.host)),
    );
  }
}
