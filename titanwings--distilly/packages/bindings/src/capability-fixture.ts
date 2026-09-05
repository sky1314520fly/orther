import {
  contentDigestSchema,
  hostCapabilitiesSchema,
  hostPreflightSchema,
  type HostCapabilities,
  type HostName,
  type HostPreflight,
  type HostPreflightEvidence,
} from "@distilly/protocol";

import type {
  HostCapabilityBinding,
  HostCapabilityBindingOptions,
  HostContext,
} from "./protocol.js";

const SEMVER_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

const FAIL_CLOSED_CAPABILITIES: HostCapabilities = Object.freeze({
  webResearch: "unknown",
  localFileRead: "unknown",
  vision: "unknown",
  documentTextExtraction: "unknown",
  imageOcr: "unknown",
  audioTranscription: "unknown",
  videoCaptions: "unknown",
  privateUiCapture: "unavailable",
  windowScopedCapture: "unknown",
  captureDataPolicy: "unknown",
  structuredToolCalls: false,
  lifecycleHooks: Object.freeze([]),
  subruns: false,
  subrunsInheritMcp: false,
  opensLoopbackUrls: false,
});

const UNSUPPORTED_ERROR = Object.freeze({
  code: "host_unsupported" as const,
  message: "This host session does not provide a verified Distilly briefing capacity.",
  retryable: false as const,
  remediation:
    "Upgrade or restart the host, or install a release with a matching verified capacity fixture.",
});

interface ValidatedOptions {
  readonly load: (context: HostContext) => Promise<unknown>;
  readonly release: {
    readonly releaseVersion: string;
    readonly wireMajor: 3;
    readonly canonicalSkillDigest: `sha256_${string}`;
  };
}

interface PreservedFailureFields {
  readonly capabilities: HostCapabilities;
  readonly warnings: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};

const validateOptions = (options: unknown): ValidatedOptions | undefined => {
  try {
    if (!isRecord(options) || !hasExactKeys(options, ["provider", "release"])) return undefined;
    const provider = options.provider;
    const release = options.release;
    if (!isRecord(provider) || typeof provider.load !== "function" || !isRecord(release)) {
      return undefined;
    }
    const canonicalSkillDigest = contentDigestSchema.safeParse(release.canonicalSkillDigest);
    if (
      !hasExactKeys(release, ["releaseVersion", "wireMajor", "canonicalSkillDigest"]) ||
      typeof release.releaseVersion !== "string" ||
      release.releaseVersion.length > 1_024 ||
      !SEMVER_PATTERN.test(release.releaseVersion) ||
      release.wireMajor !== 3 ||
      !canonicalSkillDigest.success
    ) {
      return undefined;
    }

    const load = provider.load.bind(provider) as (context: HostContext) => Promise<unknown>;
    return {
      load,
      release: {
        releaseVersion: release.releaseVersion,
        wireMajor: 3,
        canonicalSkillDigest: canonicalSkillDigest.data,
      },
    };
  } catch {
    return undefined;
  }
};

type ParsedHostCapabilities = ReturnType<typeof hostCapabilitiesSchema.parse>;

const normalizeCapabilities = (
  capabilities: HostCapabilities | ParsedHostCapabilities,
): HostCapabilities => ({
  webResearch: capabilities.webResearch,
  localFileRead: capabilities.localFileRead,
  vision: capabilities.vision,
  documentTextExtraction: capabilities.documentTextExtraction,
  imageOcr: capabilities.imageOcr,
  audioTranscription: capabilities.audioTranscription,
  videoCaptions: capabilities.videoCaptions,
  privateUiCapture: capabilities.privateUiCapture,
  windowScopedCapture: capabilities.windowScopedCapture,
  captureDataPolicy: capabilities.captureDataPolicy,
  structuredToolCalls: capabilities.structuredToolCalls,
  lifecycleHooks: capabilities.lifecycleHooks,
  subruns: capabilities.subruns,
  subrunsInheritMcp: capabilities.subrunsInheritMcp,
  opensLoopbackUrls: capabilities.opensLoopbackUrls,
  ...(capabilities.maxContextTokens === undefined
    ? {}
    : { maxContextTokens: capabilities.maxContextTokens }),
  ...(capabilities.maxToolResultBytes === undefined
    ? {}
    : { maxToolResultBytes: capabilities.maxToolResultBytes }),
});

const forcePrivateCaptureUnavailable = (
  capabilities: HostCapabilities | ParsedHostCapabilities,
): HostCapabilities => ({
  ...normalizeCapabilities(capabilities),
  privateUiCapture: "unavailable",
});

const unsupported = (
  capabilities: HostCapabilities = FAIL_CLOSED_CAPABILITIES,
  warnings: readonly string[] = [],
): HostPreflight => ({
  ok: false,
  capabilities: forcePrivateCaptureUnavailable(capabilities),
  error: { ...UNSUPPORTED_ERROR },
  warnings: [...warnings],
});

const preserveKnownSuccessMismatch = (payload: unknown): PreservedFailureFields | undefined => {
  try {
    if (!isRecord(payload) || payload.ok !== true) return undefined;
    const actualKeys = Object.keys(payload);
    const allowedKeys = new Set(["ok", "capabilities", "capacity", "evidence", "warnings"]);
    if (
      actualKeys.some((key) => !allowedKeys.has(key)) ||
      !("capabilities" in payload) ||
      !("warnings" in payload)
    ) {
      return undefined;
    }

    const capabilities = hostCapabilitiesSchema.safeParse(payload.capabilities);
    if (!capabilities.success) return undefined;
    const failure = hostPreflightSchema.safeParse({
      ok: false,
      capabilities: capabilities.data,
      error: UNSUPPORTED_ERROR,
      warnings: payload.warnings,
    });
    if (!failure.success || failure.data.ok) return undefined;
    return {
      capabilities: normalizeCapabilities(failure.data.capabilities),
      warnings: failure.data.warnings,
    };
  } catch {
    return undefined;
  }
};

const evidenceMatches = (
  host: HostName,
  context: HostContext,
  evidence: HostPreflightEvidence,
  options: ValidatedOptions,
): boolean =>
  evidence.host === host &&
  evidence.environment === context.environment &&
  evidence.releaseVersion === options.release.releaseVersion &&
  evidence.wireMajor === options.release.wireMajor &&
  evidence.canonicalSkillDigest === options.release.canonicalSkillDigest;

const runPreflight = async (
  host: HostName,
  context: HostContext,
  options: ValidatedOptions | undefined,
): Promise<HostPreflight> => {
  if (options === undefined) return unsupported();

  let payload: unknown;
  try {
    payload = await options.load(context);
  } catch {
    return unsupported();
  }

  let parsed: ReturnType<typeof hostPreflightSchema.safeParse>;
  try {
    parsed = hostPreflightSchema.safeParse(payload);
  } catch {
    return unsupported();
  }
  if (!parsed.success) {
    const preserved = preserveKnownSuccessMismatch(payload);
    return preserved === undefined
      ? unsupported()
      : unsupported(preserved.capabilities, preserved.warnings);
  }

  const preflight = parsed.data;
  const capabilities = forcePrivateCaptureUnavailable(preflight.capabilities);
  if (!preflight.ok) return unsupported(capabilities, preflight.warnings);
  if (!evidenceMatches(host, context, preflight.evidence, options)) {
    return unsupported(capabilities, preflight.warnings);
  }

  return {
    ok: true,
    capabilities,
    capacity: preflight.capacity,
    evidence: preflight.evidence,
    warnings: [...preflight.warnings],
  };
};

/**
 * Creates one capability-only binding around a trusted provider.
 *
 * @param host - Exact host owned by the package-local adapter.
 * @param options - Provider and release tuple to verify.
 * @returns Capability binding that fails closed on any unverified payload.
 */
export const createCapabilityBinding = (
  host: HostName,
  options: HostCapabilityBindingOptions,
): HostCapabilityBinding => {
  const validated = validateOptions(options);
  return Object.freeze({
    kind: "capability" as const,
    host,
    preflight: (context: HostContext) => runPreflight(host, context, validated),
  });
};
