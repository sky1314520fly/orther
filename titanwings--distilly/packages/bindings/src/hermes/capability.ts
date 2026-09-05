import { BUILTIN_HOSTS } from "@distilly/protocol";

import { createCapabilityBinding } from "../capability-fixture.js";
import type { HostCapabilityBinding, HostCapabilityBindingOptions } from "../protocol.js";

/**
 * Creates the Hermes capability binding around a trusted preflight provider.
 *
 * @param options - Provider and exact release tuple.
 * @returns Hermes capability binding.
 */
export const createHermesCapabilityBinding = (
  options: HostCapabilityBindingOptions,
): HostCapabilityBinding => createCapabilityBinding(BUILTIN_HOSTS.hermes, options);
