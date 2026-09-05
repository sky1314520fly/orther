import { BUILTIN_HOSTS } from "@distilly/protocol";

import { createCapabilityBinding } from "../capability-fixture.js";
import type { HostCapabilityBinding, HostCapabilityBindingOptions } from "../protocol.js";

/**
 * Creates the OpenClaw capability binding around a trusted preflight provider.
 *
 * @param options - Provider and exact release tuple.
 * @returns OpenClaw capability binding.
 */
export const createOpenClawCapabilityBinding = (
  options: HostCapabilityBindingOptions,
): HostCapabilityBinding => createCapabilityBinding(BUILTIN_HOSTS.openclaw, options);
