import type { EngineMethodMap, MutationMethodName } from "@distilly/protocol";

export const PANEL_BODY_BYTES = 4_194_304;
export const PANEL_RESPONSE_BYTES = 16_777_216;
export const PANEL_HEADER_BYTES = 16_384;
export const PANEL_SSE_EVENT_BYTES = 16_384;
export const PANEL_ACTION_NONCE_TTL_MS = 60_000;

const panelMutationMethodFlags = {
  "subjects.create": true,
  "subjects.archive": true,
  "subjects.purge": true,
  "materials.ingest": true,
  "materials.ingestFiles": true,
  "distill.brief": true,
  "distill.renew": true,
  "distill.release": true,
  "distill.commit": true,
  "distill.redistill": true,
  "profiles.correct": true,
  "versions.promote": true,
  "versions.reject": true,
  "versions.rollback": true,
  "hosts.install": true,
  "hosts.uninstall": true,
  "hosts.export": true,
  "library.rebuild": true,
  "bundles.import": true,
  "bundles.export": true,
} as const satisfies Readonly<Record<MutationMethodName, true>>;

export const panelMutationMethods = Object.freeze(
  Object.keys(panelMutationMethodFlags) as MutationMethodName[],
);

const mutationMethodSet = new Set<string>(panelMutationMethods);

/**
 * Returns whether a public engine method requires a MutationContext.
 *
 * @param method - Known method-map key.
 * @returns Whether the method is a mutation.
 */
export const isMutationMethod = (method: keyof EngineMethodMap): method is MutationMethodName =>
  mutationMethodSet.has(method);
