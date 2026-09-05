import { BUILTIN_HOSTS } from "@distilly/protocol";

import { createCapabilityBinding } from "../capability-fixture.js";
import type { HostCapabilityBinding, HostCapabilityBindingOptions } from "../protocol.js";

/**
 * Creates the Claude Code capability-only binding for an injected trusted preflight provider.
 *
 * @param options - Provider and exact active release tuple.
 * @returns Claude Code capability-only binding.
 */
export const createClaudeCodeCapabilityBinding = (
  options: HostCapabilityBindingOptions,
): HostCapabilityBinding => createCapabilityBinding(BUILTIN_HOSTS.claudeCode, options);
