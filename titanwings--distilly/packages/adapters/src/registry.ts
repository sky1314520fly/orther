import type { AdapterResource, SourceAdapter, SourceAdapterRegistration } from "./contracts.js";
import { adapterCapabilitiesRuntimeSchema, adapterIdRuntimeSchema } from "./schemas.js";

class DuplicateSourceAdapterError extends Error {
  public constructor(id: string) {
    super(`A source adapter is already registered for ${id}.`);
    this.name = "DuplicateSourceAdapterError";
  }
}

interface RegistryEntry {
  readonly adapter: SourceAdapter<AdapterResource>;
  readonly registration: SourceAdapterRegistration;
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

const requireMethod = (adapter: Record<string, unknown>, name: string): void => {
  if (typeof adapter[name] !== "function") {
    throw new TypeError(`Source adapter ${name} must be a function.`);
  }
};

const freezeRegistration = (registration: SourceAdapterRegistration): SourceAdapterRegistration => {
  const resourceKinds = registration.capabilities.resourceKinds.map((resource) =>
    Object.freeze({ ...resource }),
  );
  return Object.freeze({
    id: registration.id,
    mode: registration.mode,
    capabilities: Object.freeze({
      ...registration.capabilities,
      resourceKinds: Object.freeze(resourceKinds),
    }),
  });
};

const validateAdapter = <Resource extends AdapterResource>(
  candidate: SourceAdapter<Resource>,
): RegistryEntry => {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    throw new TypeError("Source adapter must be an object.");
  }
  const adapter = candidate as unknown as Record<string, unknown>;
  const id = adapterIdRuntimeSchema.parse(adapter.id);
  if (
    typeof adapter.resourceSchema !== "object" ||
    adapter.resourceSchema === null ||
    typeof (adapter.resourceSchema as Record<string, unknown>).parse !== "function"
  ) {
    throw new TypeError("Source adapter resourceSchema.parse must be a function.");
  }
  for (const method of ["capabilities", "preflight", "resolveSubject"]) {
    requireMethod(adapter, method);
  }
  if (adapter.mode === "delegated") requireMethod(adapter, "plan");
  else if (adapter.mode === "direct") requireMethod(adapter, "collect");
  else throw new TypeError("Source adapter mode must be delegated or direct.");

  const capabilities = adapterCapabilitiesRuntimeSchema.parse(candidate.capabilities());
  const registration = freezeRegistration({ id, mode: adapter.mode, capabilities });
  return {
    adapter: candidate,
    registration,
  };
};

/** Registry that keeps typed adapters private and exposes only content-free registrations. */
export class AdapterRegistry {
  readonly #entries = new Map<string, RegistryEntry>();

  /**
   * Registers one validated adapter without replacing an existing id.
   *
   * @param adapter - Direct or delegated adapter with its own strict resource parser.
   */
  public register<Resource extends AdapterResource>(adapter: SourceAdapter<Resource>): void {
    const entry = validateAdapter(adapter);
    if (this.#entries.has(entry.registration.id)) {
      throw new DuplicateSourceAdapterError(entry.registration.id);
    }
    this.#entries.set(entry.registration.id, entry);
  }

  /**
   * Returns an immutable content-free snapshot ordered by adapter id UTF-8 bytes.
   *
   * @returns Frozen registrations without callable adapter handles.
   */
  public list(): readonly SourceAdapterRegistration[] {
    return Object.freeze(
      [...this.#entries.values()]
        .map(({ registration }) => registration)
        .sort((left, right) => compareUtf8(left.id, right.id)),
    );
  }
}
