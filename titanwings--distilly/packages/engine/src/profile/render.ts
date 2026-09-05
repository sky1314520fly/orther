import type {
  Claim,
  CoreFacetName,
  FacetPath,
  QualitySummary,
  SubjectId,
  VersionId,
} from "@distilly/protocol";

import { canonicalJson } from "../facts/canonical-json.js";
import { storageCorrupt } from "../internal-errors.js";
import { compareUtf8 } from "./claim-id.js";
import { CORE_FACET_ORDER } from "./quality.js";

/** Exact renderer literal persisted in every Step 7 version. */
export const PROFILE_RENDERER_VERSION = "profile-renderer-v1";

/** Structured semantic profile facts consumed by the pure renderer. */
export interface ProfileData {
  readonly subjectId: SubjectId;
  readonly displayName: string;
  readonly versionId: VersionId;
  readonly claims: readonly Claim[];
  readonly quality: QualitySummary;
}

/** Deterministic files and combined Markdown produced by profile-renderer-v1. */
export interface RenderedProfile {
  readonly core: Readonly<Record<CoreFacetName, string>>;
  readonly domains: Readonly<Record<string, string>>;
  readonly markdown: string;
}

/** Immutable complete profile shape accepted by the prompt renderer. */
export interface VersionedProfile extends ProfileData {
  readonly core: Readonly<Record<CoreFacetName, string>>;
  readonly domains: Readonly<Record<string, string>>;
  readonly rendered: string;
}

type RenderStatus = "active" | "contested";
type RenderKind = "core" | "domain";

interface RenderRecord {
  readonly id: Claim["id"];
  readonly facet: FacetPath;
  readonly strength: Claim["strength"];
  readonly text: string;
  readonly observedIn: readonly string[];
  readonly validFrom?: Claim["validFrom"];
  readonly validTo?: Claim["validTo"];
}

interface RenderBucket {
  readonly active: RenderRecord[];
  readonly contested: RenderRecord[];
}

interface RenderSection {
  readonly active: string;
  readonly contested: string;
}

const CORE_FACETS = new Set<string>(CORE_FACET_ORDER);
const rootOf = (facet: FacetPath): string => facet.split(".", 1)[0]!;

const recordFor = (claim: Claim, facet: FacetPath): RenderRecord => ({
  id: claim.id,
  facet,
  strength: claim.strength,
  text: claim.text,
  observedIn: claim.observedIn,
  ...(claim.validFrom === undefined ? {} : { validFrom: claim.validFrom }),
  ...(claim.validTo === undefined ? {} : { validTo: claim.validTo }),
});

const EMPTY_SECTION: RenderSection = { active: "[]", contested: "[]" };

const sectionsFor = (claims: readonly Claim[]): ReadonlyMap<string, RenderSection> => {
  const buckets = new Map<string, RenderBucket>();
  for (const claim of claims) {
    if (claim.status === "superseded") {
      continue;
    }
    const facet = claim.facet;
    const root = rootOf(facet);
    let bucket = buckets.get(root);
    if (bucket === undefined) {
      bucket = { active: [], contested: [] };
      buckets.set(root, bucket);
    }
    bucket[claim.status].push(recordFor(claim, facet));
  }

  const sections = new Map<string, RenderSection>();
  for (const [root, bucket] of buckets) {
    for (const status of ["active", "contested"] as const satisfies readonly RenderStatus[]) {
      bucket[status].sort((left, right) => compareUtf8(left.id, right.id));
    }
    sections.set(root, {
      active: canonicalJson(bucket.active),
      contested: canonicalJson(bucket.contested),
    });
  }
  return sections;
};

const section = (level: number, kind: RenderKind, root: string, records: RenderSection): string =>
  `${"#".repeat(level)} ${kind}.${root}\n\n` +
  `${"#".repeat(level + 1)} Active claims\n\n` +
  `    ${records.active}\n\n` +
  `${"#".repeat(level + 1)} Contested claims\n\n` +
  `    ${records.contested}\n`;

/**
 * Renders one facet root as its exact standalone profile artifact.
 *
 * @param facet - Facet whose first segment selects the rendered root.
 * @param claims - Complete candidate claims.
 * @returns Exact profile-renderer-v1 facet bytes as a string.
 */
export const renderFacet = (facet: FacetPath, claims: readonly Claim[]): string => {
  const root = rootOf(facet);
  const sections = sectionsFor(claims);
  return section(
    1,
    CORE_FACETS.has(root) ? "core" : "domain",
    root,
    sections.get(root) ?? EMPTY_SECTION,
  );
};

/**
 * Renders all seven core artifacts, non-empty domains, and combined profile Markdown.
 *
 * @param profile - Structured immutable profile data.
 * @returns Exact standalone and combined renderer artifacts.
 */
export const renderProfile = (profile: ProfileData): RenderedProfile => {
  const sections = sectionsFor(profile.claims);
  const coreEntries = CORE_FACET_ORDER.map(
    (root) => [root, section(1, "core", root, sections.get(root) ?? EMPTY_SECTION)] as const,
  );
  const core = Object.fromEntries(coreEntries) as Readonly<Record<CoreFacetName, string>>;

  const domainRoots = [...sections.keys()]
    .filter((root) => !CORE_FACETS.has(root))
    .sort(compareUtf8);
  const domainEntries = domainRoots.map(
    (root) => [root, section(1, "domain", root, sections.get(root)!)] as const,
  );
  const domains = Object.fromEntries(domainEntries) as Readonly<Record<string, string>>;

  const combinedCore = CORE_FACET_ORDER.map((root) =>
    section(3, "core", root, sections.get(root) ?? EMPTY_SECTION),
  ).join("\n");
  const combinedDomains =
    domainRoots.length === 0
      ? "    []\n"
      : domainRoots.map((root) => section(3, "domain", root, sections.get(root)!)).join("\n");
  const markdown =
    "# Distilly profile\n\n## Core facets\n\n" +
    combinedCore +
    "\n## Domain facets\n\n" +
    combinedDomains;
  return { core, domains, markdown };
};

/**
 * Renders the exact complete simulation prompt from one immutable Profile.
 *
 * @param profile - Complete version-time profile including combined rendering.
 * @returns Exact prompt.md content with one trailing LF.
 */
export const renderPrompt = (profile: VersionedProfile): string => {
  if (!profile.rendered.endsWith("\n") || profile.rendered.endsWith("\n\n")) {
    throw storageCorrupt("Rendered profile must have exactly one trailing LF.");
  }
  const metadata = canonicalJson({
    displayName: profile.displayName,
    maturity: profile.quality.maturity,
    subjectId: profile.subjectId,
    versionId: profile.versionId,
  });
  return (
    "# Distilly simulation context\n\n" +
    "## Subject metadata\n\n" +
    `    ${metadata}\n\n` +
    profile.rendered.slice(0, -1) +
    "\n\n## Behavior constraints\n\n" +
    "- This is an evidence-bounded simulation, not the person.\n" +
    "- Do not invent facts that are not recorded.\n" +
    "- Preserve recorded boundaries and explicitly acknowledge contested claims.\n"
  );
};
