import type {
  CreateSubjectInput,
  IdentityHint,
  IngestSubjectTarget,
  SpaceId,
  SubjectId,
  SubjectSummary,
} from "@distilly/protocol";
import { BUILTIN_PEOPLE_SPACE_ID, WIRE_LIMITS } from "@distilly/protocol";

import { canonicalJsonBytes } from "../facts/canonical-json.js";
import { invalidInput, storageCorrupt } from "../internal-errors.js";
import { enforceCanonicalUtf8Limit } from "../utf8-boundary.js";

const EDGE_ASCII_WHITESPACE = /^[\t\n\r ]+|[\t\n\r ]+$/g;
const PROVIDER_GRAMMAR = /^[a-z][a-z0-9._-]*$/;
// v1 intentionally declares no provider handle as case-insensitive.
const CASE_INSENSITIVE_ACCOUNT_PROVIDERS = new Set<string>();

const compareUtf8 = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

const rejectNul = (value: string, fieldPath: string): void => {
  if (value.includes("\0")) throw invalidInput("Identity values cannot contain U+0000.", fieldPath);
};

/**
 * Normalizes a display label or alias with the frozen label-v1 rules.
 *
 * @param value - Raw display label or alias.
 * @param fieldPath - Input path reported when normalization fails.
 * @returns The canonical non-empty label.
 */
export const normalizeLabelV1 = (value: string, fieldPath = "displayName"): string => {
  const normalized = value.normalize("NFC").replace(EDGE_ASCII_WHITESPACE, "");
  if (normalized.length === 0) throw invalidInput("A normalized label cannot be empty.", fieldPath);
  rejectNul(normalized, fieldPath);
  return enforceCanonicalUtf8Limit(normalized, WIRE_LIMITS.labelBytes, fieldPath);
};

/**
 * Canonicalizes one absolute HTTP(S) locator without following redirects.
 *
 * @param value - Raw absolute URL.
 * @param fieldPath - Input path reported when normalization fails.
 * @returns The conservative WHATWG URL representation without a fragment.
 */
export const canonicalizeHttpUrl = (value: string, fieldPath: string): string => {
  rejectNul(value, fieldPath);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidInput("Identity locators must be absolute HTTP(S) URLs.", fieldPath);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw invalidInput("Identity locators must use HTTP or HTTPS.", fieldPath);
  }
  url.hash = "";
  return enforceCanonicalUtf8Limit(url.toString(), WIRE_LIMITS.uriBytes, fieldPath);
};

const normalizeProvider = (value: string, fieldPath: string): string => {
  const normalized = value.normalize("NFC").toLowerCase();
  if (!PROVIDER_GRAMMAR.test(normalized)) {
    throw invalidInput("Identity providers must be lowercase ASCII identifiers.", fieldPath);
  }
  return normalized;
};

const normalizeOpaque = (value: string, fieldPath: string): string => {
  const normalized = value.normalize("NFC");
  if (normalized.length === 0)
    throw invalidInput("An identity locator cannot be empty.", fieldPath);
  rejectNul(normalized, fieldPath);
  return enforceCanonicalUtf8Limit(normalized, WIRE_LIMITS.labelBytes, fieldPath);
};

/**
 * Applies the version-one provider-scoped identity-locator rules.
 *
 * @param hint - Caller-supplied identity hint.
 * @returns The canonical provider-scoped hint.
 */
const normalizeIdentityHint = (hint: IdentityHint): IdentityHint => {
  switch (hint.kind) {
    case "url":
      return { kind: "url", value: canonicalizeHttpUrl(hint.value, "identityHints.value") };
    case "account": {
      const handle = hint.handle.trim().normalize("NFC");
      if (handle.length === 0) {
        throw invalidInput("An account handle cannot be empty.", "identityHints.handle");
      }
      rejectNul(handle, "identityHints.handle");
      const provider = normalizeProvider(hint.provider, "identityHints.provider");
      const boundedHandle = enforceCanonicalUtf8Limit(
        handle,
        WIRE_LIMITS.labelBytes,
        "identityHints.handle",
      );
      return {
        kind: "account",
        provider,
        handle: CASE_INSENSITIVE_ACCOUNT_PROVIDERS.has(provider)
          ? boundedHandle.toLowerCase()
          : boundedHandle,
      };
    }
    case "external_id":
      return {
        kind: "external_id",
        provider: normalizeProvider(hint.provider, "identityHints.provider"),
        value: normalizeOpaque(hint.value, "identityHints.value"),
      };
    case "description":
      return {
        kind: "description",
        value: normalizeLabelV1(hint.value, "identityHints.value"),
      };
  }
};

const identityHintKey = (hint: IdentityHint): string => {
  switch (hint.kind) {
    case "url":
      return `url\0${hint.value}`;
    case "account":
      return `account\0${hint.provider}\0${hint.handle}`;
    case "external_id":
      return `external_id\0${hint.provider}\0${hint.value}`;
    case "description":
      return `description\0${hint.value}`;
  }
};

const normalizeHints = (hints: readonly IdentityHint[] | undefined): readonly IdentityHint[] => {
  const unique = new Map<string, IdentityHint>();
  for (const hint of hints ?? []) {
    const normalized = normalizeIdentityHint(hint);
    unique.set(identityHintKey(normalized), normalized);
  }
  return [...unique.entries()]
    .sort(([left], [right]) => compareUtf8(left, right))
    .map(([, hint]) => hint);
};

const normalizeAliases = (aliases: readonly string[] | undefined): readonly string[] => {
  const unique = new Set((aliases ?? []).map((alias) => normalizeLabelV1(alias, "aliases")));
  return [...unique].sort(compareUtf8);
};

/** Canonical create-target fields used inside the identity locks. */
export interface NormalizedCreateSubjectInput {
  readonly displayName: string;
  readonly space:
    | { readonly kind: "builtin_people"; readonly spaceId: SpaceId }
    | { readonly kind: "existing"; readonly spaceId: SpaceId }
    | {
        readonly kind: "inline";
        readonly displayName: string;
        readonly spaceKind: "people" | "fictional" | "custom";
      };
  readonly aliases: readonly string[];
  readonly domainPack?: string;
  readonly identityHints: readonly IdentityHint[];
}

/**
 * Canonicalizes a create target before subject-id allocation or locking.
 *
 * @param input - Caller-supplied subject identity.
 * @returns The stable fields used by duplicate checks and persisted facts.
 */
export const normalizeCreateSubjectInput = (
  input: CreateSubjectInput,
): NormalizedCreateSubjectInput => {
  if (input.spaceId !== undefined && input.space !== undefined) {
    throw invalidInput("spaceId and inline space are mutually exclusive.", "space");
  }
  const normalizedInlineLabel =
    input.space === undefined
      ? undefined
      : normalizeLabelV1(input.space.displayName, "space.displayName");
  const space: NormalizedCreateSubjectInput["space"] =
    input.spaceId === BUILTIN_PEOPLE_SPACE_ID ||
    (input.space?.kind === "people" && normalizedInlineLabel === "People")
      ? { kind: "builtin_people", spaceId: BUILTIN_PEOPLE_SPACE_ID }
      : input.spaceId !== undefined
        ? { kind: "existing", spaceId: input.spaceId }
        : input.space !== undefined
          ? {
              kind: "inline",
              displayName: normalizedInlineLabel!,
              spaceKind: input.space.kind,
            }
          : { kind: "builtin_people", spaceId: BUILTIN_PEOPLE_SPACE_ID };

  return {
    displayName: normalizeLabelV1(input.displayName),
    space,
    aliases: normalizeAliases(input.aliases),
    ...(input.domainPack === undefined
      ? {}
      : { domainPack: normalizeLabelV1(input.domainPack, "domainPack") }),
    identityHints: normalizeHints(input.identityHints),
  };
};

/** Canonical form retained by authorization and ingest sessions. */
export type NormalizedIngestSubjectTarget =
  | { readonly kind: "existing"; readonly subjectId: SubjectId }
  | { readonly kind: "create"; readonly input: NormalizedCreateSubjectInput };

/**
 * Returns both the normalized target and its stable canonical bytes.
 *
 * @param target - Existing or create subject target.
 * @returns The normalized target and byte-for-byte canonical representation.
 */
export const canonicalizeIngestSubjectTarget = (
  target: IngestSubjectTarget,
): { readonly target: NormalizedIngestSubjectTarget; readonly bytes: Uint8Array } => {
  const normalized: NormalizedIngestSubjectTarget =
    target.kind === "existing"
      ? { kind: "existing", subjectId: target.subjectId }
      : { kind: "create", input: normalizeCreateSubjectInput(target.input) };
  return { target: normalized, bytes: canonicalJsonBytes(normalized) };
};

const exactLocatorKeys = (hints: readonly IdentityHint[]): ReadonlySet<string> =>
  new Set(
    hints
      .filter((hint) => hint.kind !== "description")
      .map((hint) => identityHintKey(normalizeIdentityHint(hint))),
  );

const comparableLocatorGroups = (
  hints: readonly IdentityHint[],
): ReadonlyMap<string, ReadonlySet<string>> => {
  const groups = new Map<string, Set<string>>();
  for (const rawHint of hints) {
    const hint = normalizeIdentityHint(rawHint);
    if (hint.kind === "description") continue;
    const group =
      hint.kind === "url" ? "url" : `${hint.kind}\0${normalizeProvider(hint.provider, "provider")}`;
    const values = groups.get(group) ?? new Set<string>();
    values.add(identityHintKey(hint));
    groups.set(group, values);
  }
  return groups;
};

const setsIntersect = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean => {
  for (const value of left) if (right.has(value)) return true;
  return false;
};

const hasProvenDifferentLocator = (
  targetHints: readonly IdentityHint[],
  candidateHints: readonly IdentityHint[],
): boolean => {
  const target = comparableLocatorGroups(targetHints);
  const candidate = comparableLocatorGroups(candidateHints);
  for (const [group, targetValues] of target) {
    const candidateValues = candidate.get(group);
    if (candidateValues !== undefined && !setsIntersect(targetValues, candidateValues)) return true;
  }
  return false;
};

/** Result of the deterministic create-target duplicate check. */
export type CreateConflict =
  | { readonly kind: "none" }
  | { readonly kind: "already_exists"; readonly subject: SubjectSummary }
  | { readonly kind: "ambiguous"; readonly candidates: readonly SubjectSummary[] };

/**
 * Applies the frozen exact-locator then exact-name create conflict rules.
 *
 * @param input - Normalized target being considered for creation.
 * @param candidates - Existing subjects in the resolved space.
 * @returns The stable conflict outcome.
 */
export const findCreateConflict = (
  input: NormalizedCreateSubjectInput,
  candidates: readonly SubjectSummary[],
): CreateConflict => {
  const targetLocators = exactLocatorKeys(input.identityHints);
  const exactLocatorMatches = candidates.filter((candidate) =>
    setsIntersect(targetLocators, exactLocatorKeys(candidate.identityHints)),
  );
  const orderedLocatorMatches = [...exactLocatorMatches].sort((left, right) =>
    compareUtf8(left.id, right.id),
  );
  if (orderedLocatorMatches.length > 1) {
    throw storageCorrupt("More than one subject owns the same canonical identity locator.");
  }
  if (orderedLocatorMatches.length === 1) {
    return { kind: "already_exists", subject: orderedLocatorMatches[0]! };
  }

  const targetNames = new Set([input.displayName, ...input.aliases]);
  const nameMatches = candidates
    .filter((candidate) =>
      [candidate.displayName, ...candidate.aliases].some((name) => targetNames.has(name)),
    )
    .filter((candidate) => !hasProvenDifferentLocator(input.identityHints, candidate.identityHints))
    .sort((left, right) => compareUtf8(left.id, right.id));

  if (nameMatches.length === 0) return { kind: "none" };
  if (nameMatches.length === 1) {
    return { kind: "already_exists", subject: nameMatches[0]! };
  }
  return { kind: "ambiguous", candidates: nameMatches };
};
