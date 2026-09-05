import {
  DistillyError,
  requestIdSchema,
  subjectIdSchema,
  versionIdSchema,
} from "@distilly/protocol";
import type {
  Claim,
  LibraryEntry,
  MaterialSummary,
  MaterialView,
  Profile,
  ReviewItem,
  ReviewRef,
  RequestId,
  SubjectId,
  VersionSummary,
} from "@distilly/protocol";

import { HttpEngineClient } from "./web-client.js";
import { consumePanelFragment } from "./web-fragment.js";
import type { PanelInitialRoute } from "./web-fragment.js";
import { fullPanelReread, isDeferredPreviewDoctor } from "./web-recovery.js";

type UiRoute =
  | { readonly kind: "library" }
  | { readonly kind: "subject"; readonly subjectId?: SubjectId }
  | { readonly kind: "review"; readonly review?: ReviewRef }
  | { readonly kind: "settings" };

/** Browser UI lifecycle handle returned after the initial render and watch registration. */
export interface PanelWebHandle {
  /** Stops UI listeners and the browser HTTP client. */
  close(): Promise<void>;
}

/** Optional DOM seams used by embedded browser and UI tests. */
export interface PanelWebBootstrapOptions {
  readonly document?: Document;
  readonly window?: Window;
}

const element = <K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] => {
  const result = document.createElement(tag);
  if (className !== undefined) result.className = className;
  return result;
};

const textElement = <K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  text: string,
  className?: string,
): HTMLElementTagNameMap[K] => {
  const result = element(document, tag, className);
  result.textContent = text;
  return result;
};

const assertNever = (value: never, context: string): never => {
  throw new Error(`Unexpected ${context}: ${String(value)}`);
};

const appendDefinition = (
  document: Document,
  list: HTMLDListElement,
  key: string,
  value: string,
): void => {
  list.append(textElement(document, "dt", key), textElement(document, "dd", value));
};

const requestId = (): RequestId => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return requestIdSchema.parse(
    `req_${[...bytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`,
  );
};

const actionFailureMessage = (error: unknown): string =>
  error instanceof DistillyError ? `${error.code}: ${error.message}` : "Panel action failed.";

const derivationLabel = (material: MaterialView): string => {
  const derivation = material.record.derivation;
  switch (derivation.kind) {
    case "native_text":
      return derivation.kind;
    case "host_extract":
      return `${derivation.kind} · ${derivation.method} · ${derivation.producer}`;
    case "raw_extract":
      return `${derivation.kind} · ${derivation.method} · ${derivation.producer} · ${derivation.rawId}`;
    default:
      return assertNever(derivation, "material derivation");
  }
};

const artifactLocatorLabel = (
  locator: MaterialView["record"]["source"]["artifact"] | undefined,
): string => {
  if (locator === undefined) return "none";
  return [locator.provider, locator.externalId, locator.canonicalUri]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
};

const appendEvidenceMaterial = (
  document: Document,
  evidenceBlock: HTMLElement,
  material: MaterialView,
): void => {
  if (material.record.source.uri !== undefined) {
    const source = textElement(document, "a", material.record.source.uri);
    source.href = material.record.source.uri;
    source.rel = "noreferrer noopener";
    evidenceBlock.append(source);
  }
  const provenance = element(document, "dl", "fact-grid");
  appendDefinition(document, provenance, "Medium", material.record.source.medium);
  appendDefinition(document, provenance, "Access", material.record.source.access);
  appendDefinition(document, provenance, "Role", material.record.source.role ?? "unspecified");
  appendDefinition(
    document,
    provenance,
    "Artifact",
    artifactLocatorLabel(material.record.source.artifact),
  );
  appendDefinition(
    document,
    provenance,
    "Representation of",
    artifactLocatorLabel(material.record.source.representationOf),
  );
  appendDefinition(document, provenance, "Source group", material.sourceGroup.key);
  appendDefinition(document, provenance, "Diversity", material.sourceGroup.diversityStatus);
  appendDefinition(document, provenance, "Basis", material.sourceGroup.bases.join(", ") || "none");
  appendDefinition(
    document,
    provenance,
    "Cautions",
    material.sourceGroup.cautions.join(", ") || "none",
  );
  appendDefinition(document, provenance, "Captured at", material.record.source.capturedAt);
  appendDefinition(document, provenance, "Stored at", material.record.storedAt);
  appendDefinition(document, provenance, "Sensitivity", material.record.sensitivity);
  appendDefinition(document, provenance, "Derivation", derivationLabel(material));
  appendDefinition(document, provenance, "Raw available", material.rawAvailable ? "yes" : "no");
  appendDefinition(
    document,
    provenance,
    "Capture audit",
    material.record.captureAuditRef ?? "none",
  );
  evidenceBlock.append(
    provenance,
    textElement(document, "h5", "Material content"),
    textElement(document, "pre", material.content, "material-content"),
  );
};

const routeFromHash = (hash: string): UiRoute => {
  const fragment = hash.startsWith("#/")
    ? hash.slice(2)
    : hash.startsWith("#")
      ? hash.slice(1)
      : hash;
  const segments = fragment.split("/");
  if (fragment === "" || (segments.length === 1 && segments[0] === "library")) {
    return { kind: "library" };
  }
  if (segments[0] === "subject") {
    if (segments.length === 1) return { kind: "subject" };
    if (segments.length === 2)
      return { kind: "subject", subjectId: subjectIdSchema.parse(segments[1]) };
  }
  if (segments[0] === "review") {
    if (segments.length === 1) return { kind: "review" };
    if (segments.length === 3) {
      return {
        kind: "review",
        review: {
          subjectId: subjectIdSchema.parse(segments[1]),
          candidateVersionId: versionIdSchema.parse(segments[2]),
        },
      };
    }
  }
  if (segments.length === 1 && segments[0] === "settings") return { kind: "settings" };
  return { kind: "library" };
};

const routeFromInitial = (route: PanelInitialRoute): UiRoute =>
  route.kind === "review" ? { kind: "review", review: route.review } : { kind: "library" };

const navigation = (document: Document, route: UiRoute): HTMLElement => {
  const nav = element(document, "nav", "primary-nav");
  nav.setAttribute("aria-label", "Panel pages");
  const items = [
    { label: "Library", href: "#/library", active: route.kind === "library" },
    { label: "Subject", href: "#/subject", active: route.kind === "subject" },
    { label: "Review", href: "#/review", active: route.kind === "review" },
    { label: "Settings & Doctor", href: "#/settings", active: route.kind === "settings" },
  ];
  for (const item of items) {
    const link = textElement(document, "a", item.label);
    link.href = item.href;
    if (item.active) link.setAttribute("aria-current", "page");
    nav.append(link);
  }
  return nav;
};

const quality = (document: Document, profile: Profile): HTMLElement => {
  const section = element(document, "section", "panel-card");
  section.append(textElement(document, "h2", "Quality"));
  const list = element(document, "dl", "fact-grid");
  appendDefinition(document, list, "Maturity", profile.quality.maturity);
  appendDefinition(document, list, "Active claims", String(profile.quality.activeClaimCount));
  appendDefinition(document, list, "Contested claims", String(profile.quality.contestedClaimCount));
  appendDefinition(document, list, "Source groups", String(profile.quality.sourceGroupCount));
  appendDefinition(
    document,
    list,
    "Diversity-eligible groups",
    String(profile.quality.diversityEligibleSourceGroupCount),
  );
  appendDefinition(document, list, "Grouping version", profile.quality.sourceGroupingVersion);
  section.append(list);
  return section;
};

const renderLibrary = async (
  document: Document,
  client: HttpEngineClient,
  main: HTMLElement,
): Promise<void> => {
  main.append(textElement(document, "h1", "Library"));
  const entries: LibraryEntry[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const page = await client.call("library.list", {
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    entries.push(...page.items);
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) throw new Error("Panel library cursor repeated.");
      seenCursors.add(cursor);
    }
  } while (cursor !== undefined);
  if (entries.length === 0) {
    main.append(textElement(document, "p", "No local people yet.", "empty-state"));
    return;
  }
  const list = element(document, "div", "card-list");
  for (const entry of entries) {
    list.append(renderLibraryEntry(document, entry));
  }
  main.append(list);
};

const renderLibraryEntry = (document: Document, entry: LibraryEntry): HTMLElement => {
  const article = element(document, "article", "panel-card");
  const link = textElement(document, "a", entry.subject.displayName, "person-link");
  link.href = `#/subject/${entry.subject.id}`;
  const title = element(document, "h2");
  title.append(link);
  article.append(title);
  const facts = element(document, "dl", "fact-grid");
  appendDefinition(document, facts, "Space", entry.subject.space.displayName);
  appendDefinition(document, facts, "Lifecycle", entry.subject.lifecycle);
  appendDefinition(document, facts, "Privacy", entry.privacy);
  appendDefinition(document, facts, "Status maturity", entry.status.maturity ?? "not distilled");
  appendDefinition(
    document,
    facts,
    "Current quality",
    entry.currentQuality?.maturity ?? "not distilled",
  );
  appendDefinition(
    document,
    facts,
    "Suspended quality",
    entry.suspendedQuality?.maturity ?? "none",
  );
  appendDefinition(document, facts, "Pending jobs", String(entry.pendingJobs));
  appendDefinition(document, facts, "Suspended versions", String(entry.suspendedVersions));
  appendDefinition(document, facts, "New materials", String(entry.newMaterialCount));
  appendDefinition(document, facts, "Last changed", entry.lastChangedAt);
  article.append(facts);
  return article;
};

const renderClaims = (
  document: Document,
  profile: Profile,
  materialById: ReadonlyMap<string, MaterialView>,
): HTMLElement => {
  const section = element(document, "section");
  section.append(textElement(document, "h2", "Claims & evidence"));
  const list = element(document, "div", "card-list");
  for (const claim of profile.claims) {
    const article = element(document, "article", "panel-card");
    article.append(textElement(document, "h3", claim.facet));
    article.append(textElement(document, "p", claim.text));
    const badge = textElement(document, "p", `${claim.status} · ${claim.strength}`, "badge-line");
    article.append(badge);
    for (const evidence of claim.evidence) {
      const material = materialById.get(evidence.materialId);
      const evidenceBlock = element(document, "blockquote", "evidence");
      evidenceBlock.append(textElement(document, "p", evidence.quote));
      if (material !== undefined) appendEvidenceMaterial(document, evidenceBlock, material);
      article.append(evidenceBlock);
    }
    list.append(article);
  }
  if (profile.claims.length === 0)
    list.append(textElement(document, "p", "No claims in this version."));
  section.append(list);
  return section;
};

const renderMaterials = (document: Document, materials: readonly MaterialView[]): HTMLElement => {
  const section = element(document, "section");
  section.append(textElement(document, "h2", "Materials"));
  const list = element(document, "div", "card-list");
  for (const material of materials) {
    const article = element(document, "article", "panel-card");
    article.append(
      textElement(document, "h3", material.record.source.title ?? material.record.kind),
    );
    const facts = element(document, "dl", "fact-grid");
    appendDefinition(document, facts, "Medium", material.record.source.medium);
    appendDefinition(document, facts, "Access", material.record.source.access);
    appendDefinition(document, facts, "Role", material.record.source.role ?? "unspecified");
    appendDefinition(
      document,
      facts,
      "Artifact",
      artifactLocatorLabel(material.record.source.artifact),
    );
    appendDefinition(
      document,
      facts,
      "Representation of",
      artifactLocatorLabel(material.record.source.representationOf),
    );
    appendDefinition(document, facts, "Derivation", derivationLabel(material));
    appendDefinition(document, facts, "Sensitivity", material.record.sensitivity);
    appendDefinition(document, facts, "Source group", material.sourceGroup.key);
    appendDefinition(document, facts, "Diversity", material.sourceGroup.diversityStatus);
    appendDefinition(document, facts, "Basis", material.sourceGroup.bases.join(", ") || "none");
    appendDefinition(
      document,
      facts,
      "Cautions",
      material.sourceGroup.cautions.join(", ") || "none",
    );
    appendDefinition(document, facts, "Grouping version", material.grouping.algorithmVersion);
    appendDefinition(document, facts, "Grouping generation", String(material.grouping.generation));
    appendDefinition(document, facts, "At version", material.grouping.versionId ?? "current");
    appendDefinition(
      document,
      facts,
      "Current generation",
      material.inCurrentGeneration ? "yes" : "no",
    );
    appendDefinition(document, facts, "Raw available", material.rawAvailable ? "yes" : "no");
    appendDefinition(document, facts, "Capture audit", material.record.captureAuditRef ?? "none");
    article.append(facts, textElement(document, "pre", material.content, "material-content"));
    list.append(article);
  }
  if (materials.length === 0) list.append(textElement(document, "p", "No materials in this view."));
  section.append(list);
  return section;
};

const renderVersions = (
  document: Document,
  client: HttpEngineClient,
  versions: readonly VersionSummary[],
  rerender: () => Promise<void>,
): HTMLElement => {
  const section = element(document, "section");
  section.append(textElement(document, "h2", "Versions"));
  const list = element(document, "div", "card-list");
  for (const version of versions) {
    const article = element(document, "article", "panel-card");
    article.append(textElement(document, "h3", `${version.status} · ${version.id}`));
    article.append(textElement(document, "p", `${version.creation.kind} · ${version.createdAt}`));
    if (version.status === "historical") {
      const button = textElement(document, "button", "Rollback to this version");
      const status = textElement(document, "p", "", "action-status");
      status.hidden = true;
      button.type = "button";
      button.addEventListener("click", () => {
        const reason = window
          .prompt("Why are you rolling back to this historical version?")
          ?.trim();
        if (reason === undefined || reason.length === 0) return;
        if (!window.confirm("Create a new current version from this historical version?")) return;
        button.disabled = true;
        status.hidden = true;
        void (async () => {
          try {
            await client.call(
              "versions.rollback",
              { subjectId: version.subjectId, targetVersionId: version.id, reason },
              { requestId: requestId() },
            );
            await rerender();
          } catch (error) {
            status.textContent = actionFailureMessage(error);
            status.hidden = false;
          } finally {
            button.disabled = false;
          }
        })();
      });
      article.append(button, status);
    }
    list.append(article);
  }
  section.append(list);
  return section;
};

const renderSubject = async (
  document: Document,
  client: HttpEngineClient,
  main: HTMLElement,
  subjectId: SubjectId | undefined,
  rerender: () => Promise<void>,
): Promise<void> => {
  main.append(textElement(document, "h1", "Subject"));
  if (subjectId === undefined) {
    main.append(
      textElement(document, "p", "Choose a person from Library to inspect their profile."),
    );
    return;
  }
  const status = await client.call("profiles.status", { subjectId });
  main.append(textElement(document, "p", status.subject.displayName, "lede"));
  const readMaterials = async (): Promise<readonly MaterialSummary[]> => {
    const summaries: MaterialSummary[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await client.call("materials.list", {
        subjectId,
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      summaries.push(...page.items);
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (seen.has(cursor)) throw new Error("Panel material cursor repeated.");
        seen.add(cursor);
      }
    } while (cursor !== undefined);
    return summaries;
  };
  const readVersions = async (): Promise<readonly VersionSummary[]> => {
    const versions: VersionSummary[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await client.call("versions.list", {
        subjectId,
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      });
      versions.push(...page.items);
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (seen.has(cursor)) throw new Error("Panel version cursor repeated.");
        seen.add(cursor);
      }
    } while (cursor !== undefined);
    return versions;
  };
  const [materialSummaries, versions] = await Promise.all([readMaterials(), readVersions()]);
  const materials = await Promise.all(
    materialSummaries.map((summary) =>
      client.call("materials.get", { subjectId, materialId: summary.record.id }),
    ),
  );
  const materialById = new Map(materials.map((material) => [material.record.id, material]));

  if (status.subject.currentVersionId !== undefined) {
    const profile = await client.call("profiles.get", { subjectId });
    main.append(quality(document, profile));
    const facets = element(document, "section", "panel-card");
    facets.append(textElement(document, "h2", "Profile"));
    for (const [name, value] of Object.entries(profile.core)) {
      facets.append(textElement(document, "h3", name), textElement(document, "p", value));
    }
    for (const [name, value] of Object.entries(profile.domains)) {
      facets.append(textElement(document, "h3", name), textElement(document, "p", value));
    }
    main.append(facets, renderClaims(document, profile, materialById));
  } else {
    main.append(textElement(document, "p", "This person has no current profile version."));
  }
  main.append(
    renderMaterials(document, materials),
    renderVersions(document, client, versions, rerender),
  );
};

const reviewReason = (reason: ReviewItem["reasons"][number]): string => {
  switch (reason.code) {
    case "coverage_decreased":
      return `${reason.code}: ${reason.facets.join(", ")}`;
    case "identity_changed":
    case "voice_examples_removed":
    case "new_contested_claims":
    case "correction_conflict":
      return `${reason.code}: ${reason.claimIds.join(", ")}`;
    case "suspicious_source":
      return `${reason.code}: ${reason.materialIds.join(", ")}`;
    case "relayed_correction":
      return `${reason.code}: ${reason.actorKind}`;
    case "manual_review_requested":
      return `${reason.code}${reason.note === undefined ? "" : `: ${reason.note}`}`;
    case "source_diversity_decreased":
    case "imported_profile":
      return reason.code;
    default:
      return assertNever(reason, "review reason");
  }
};

const actionButton = (
  document: Document,
  client: HttpEngineClient,
  item: ReviewItem,
  method: "versions.promote" | "versions.reject",
  rerender: () => Promise<void>,
): HTMLElement => {
  const label = method === "versions.promote" ? "Promote candidate" : "Reject candidate";
  const control = element(document, "div", "action-control");
  const button = textElement(document, "button", label);
  const status = textElement(document, "p", "", "action-status");
  status.hidden = true;
  button.type = "button";
  button.addEventListener("click", () => {
    if (!window.confirm(`${label}? This changes the active review state.`)) return;
    const reason = window.prompt("Optional audit reason")?.trim();
    button.disabled = true;
    status.hidden = true;
    void (async () => {
      try {
        await client.call(
          method,
          {
            subjectId: item.candidate.subjectId,
            candidateVersionId: item.candidate.id,
            ...(reason === undefined || reason.length === 0 ? {} : { reason }),
          },
          { requestId: requestId() },
        );
        await rerender();
      } catch (error) {
        status.textContent = actionFailureMessage(error);
        status.hidden = false;
      } finally {
        button.disabled = false;
      }
    })();
  });
  control.append(button, status);
  return control;
};

const renderReviewItem = (
  document: Document,
  client: HttpEngineClient,
  item: ReviewItem,
  beforeMaterialById: ReadonlyMap<string, MaterialView>,
  afterMaterialById: ReadonlyMap<string, MaterialView>,
  rerender: () => Promise<void>,
): HTMLElement => {
  const article = element(document, "article", "panel-card review-card");
  article.append(textElement(document, "h2", item.candidate.id));
  const reasons = element(document, "ul");
  for (const reason of item.reasons)
    reasons.append(textElement(document, "li", reviewReason(reason)));
  article.append(reasons);
  const diff = element(document, "dl", "fact-grid");
  appendDefinition(document, diff, "Added claims", String(item.diff.added.length));
  appendDefinition(document, diff, "Removed claims", String(item.diff.removed.length));
  appendDefinition(document, diff, "Changed claims", String(item.diff.changed.length));
  appendDefinition(document, diff, "Changed facets", item.diff.changedFacets.join(", ") || "none");
  appendDefinition(document, diff, "Candidate maturity", item.diff.afterQuality.maturity);
  if (item.diff.beforeQuality !== undefined) {
    appendDefinition(document, diff, "Current maturity", item.diff.beforeQuality.maturity);
  }
  article.append(diff);
  const claims = element(document, "section", "review-claims");
  claims.append(textElement(document, "h3", "Claim changes"));
  const renderClaim = (
    label: string,
    claim: Claim,
    materialById: ReadonlyMap<string, MaterialView>,
  ): HTMLElement => {
    const claimCard = element(document, "section", "review-claim");
    claimCard.append(textElement(document, "h4", `${label} · ${claim.facet}`));
    claimCard.append(textElement(document, "p", claim.text));
    claimCard.append(
      textElement(document, "p", `${claim.status} · ${claim.strength}`, "badge-line"),
    );
    for (const evidence of claim.evidence) {
      const evidenceBlock = element(document, "blockquote", "evidence");
      evidenceBlock.append(textElement(document, "p", evidence.quote));
      const material = materialById.get(evidence.materialId);
      if (material !== undefined) appendEvidenceMaterial(document, evidenceBlock, material);
      claimCard.append(evidenceBlock);
    }
    return claimCard;
  };
  for (const claim of item.diff.added)
    claims.append(renderClaim("Added", claim, afterMaterialById));
  for (const change of item.diff.changed) {
    claims.append(
      renderClaim("Changed before", change.before, beforeMaterialById),
      renderClaim("Changed after", change.after, afterMaterialById),
    );
  }
  for (const claim of item.diff.removed)
    claims.append(renderClaim("Removed", claim, beforeMaterialById));
  if (
    item.diff.added.length === 0 &&
    item.diff.changed.length === 0 &&
    item.diff.removed.length === 0
  ) {
    claims.append(textElement(document, "p", "No claim content changed."));
  }
  article.append(claims);
  const actions = element(document, "div", "actions");
  actions.append(
    actionButton(document, client, item, "versions.promote", rerender),
    actionButton(document, client, item, "versions.reject", rerender),
  );
  article.append(actions);
  return article;
};

const renderReview = async (
  document: Document,
  client: HttpEngineClient,
  main: HTMLElement,
  review: ReviewRef | undefined,
  rerender: () => Promise<void>,
): Promise<void> => {
  main.append(textElement(document, "h1", "Review"));
  const reviewItems: ReviewItem[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const page = await client.call("reviews.list", {
      limit: 200,
      ...(review === undefined ? {} : { subjectId: review.subjectId }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    reviewItems.push(...page.items);
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) throw new Error("Panel review cursor repeated.");
      seenCursors.add(cursor);
    }
  } while (cursor !== undefined);
  const items =
    review === undefined
      ? reviewItems
      : reviewItems.filter(
          (item) =>
            item.candidate.subjectId === review.subjectId &&
            item.candidate.id === review.candidateVersionId,
        );
  if (items.length === 0) {
    if (review !== undefined) await fullPanelReread(client);
    main.append(
      textElement(
        document,
        "p",
        review === undefined ? "No active suspended candidates." : "This review link is stale.",
        "empty-state",
      ),
    );
    return;
  }
  if (review !== undefined && (items.length !== 1 || reviewItems.length !== 1)) {
    await fullPanelReread(client);
    main.append(textElement(document, "p", "This review link is stale.", "empty-state"));
    return;
  }
  for (const item of items) {
    const readMaterialsAt = async (atVersionId: VersionSummary["id"]): Promise<MaterialView[]> => {
      const materialSummaries: MaterialSummary[] = [];
      let materialCursor: string | undefined;
      const seenMaterialCursors = new Set<string>();
      do {
        const page = await client.call("materials.list", {
          subjectId: item.candidate.subjectId,
          atVersionId,
          limit: 200,
          ...(materialCursor === undefined ? {} : { cursor: materialCursor }),
        });
        materialSummaries.push(...page.items);
        materialCursor = page.nextCursor;
        if (materialCursor !== undefined) {
          if (seenMaterialCursors.has(materialCursor)) {
            throw new Error("Panel material cursor repeated.");
          }
          seenMaterialCursors.add(materialCursor);
        }
      } while (materialCursor !== undefined);
      return await Promise.all(
        materialSummaries.map((summary) =>
          client.call("materials.get", {
            subjectId: item.candidate.subjectId,
            materialId: summary.record.id,
            atVersionId,
          }),
        ),
      );
    };
    const [afterMaterials, beforeMaterials] = await Promise.all([
      readMaterialsAt(item.candidate.id),
      item.current === undefined ? Promise.resolve([]) : readMaterialsAt(item.current.id),
    ]);
    const beforeMaterialById = new Map(
      beforeMaterials.map((material) => [material.record.id, material]),
    );
    const afterMaterialById = new Map(
      afterMaterials.map((material) => [material.record.id, material]),
    );
    main.append(
      renderReviewItem(document, client, item, beforeMaterialById, afterMaterialById, rerender),
    );
  }
};

const renderSettings = async (
  document: Document,
  client: HttpEngineClient,
  main: HTMLElement,
): Promise<void> => {
  main.append(textElement(document, "h1", "Settings & Doctor"));
  let snapshot;
  try {
    snapshot = await client.call("system.doctor", {});
  } catch (error) {
    if (!isDeferredPreviewDoctor(error)) throw error;
    main.append(
      textElement(
        document,
        "p",
        "Deep Doctor is not enabled in this Developer Preview.",
        "empty-state",
      ),
    );
    return;
  }
  const sections = [
    ["Runtime", snapshot.runtime],
    ["Storage", snapshot.storage],
    ["Panel security", snapshot.panel],
  ] as const;
  for (const [name, values] of sections) {
    const section = element(document, "section", "panel-card");
    section.append(textElement(document, "h2", name));
    const facts = element(document, "dl", "fact-grid");
    for (const [key, value] of Object.entries(values))
      appendDefinition(document, facts, key, String(value));
    section.append(facts);
    main.append(section);
  }
  const extensions = element(document, "section", "panel-card");
  extensions.append(textElement(document, "h2", "Extensions"));
  for (const extension of snapshot.extensions) {
    extensions.append(
      textElement(
        document,
        "p",
        `${extension.kind} · ${extension.id} · ${extension.ok ? "ok" : "unavailable"}${
          extension.warnings.length === 0 ? "" : ` · ${extension.warnings.join(", ")}`
        }`,
      ),
    );
  }
  main.append(extensions);
};

/**
 * Consumes the fragment token synchronously, then boots the four-page local Panel.
 *
 * @param options - Optional browser window and document seams.
 * @returns A handle that detaches UI listeners and fetch streams.
 */
export const bootstrapPanel = async (
  options: PanelWebBootstrapOptions = {},
): Promise<PanelWebHandle> => {
  const browserWindow = options.window ?? window;
  const document = options.document ?? browserWindow.document;
  const root = document.querySelector<HTMLElement>("#app");
  if (root === null) throw new Error("Panel document is missing #app.");

  const consumed = consumePanelFragment(browserWindow.location, browserWindow.history);
  let initialRoute: UiRoute | undefined = routeFromInitial(consumed.route);
  let rendering = false;
  let queued = false;
  let closed = false;
  let lastSubjectId: SubjectId | undefined;

  const client = new HttpEngineClient({
    origin: browserWindow.location.origin,
    token: consumed.token,
    onFullReread: () => {
      void render();
    },
  });

  const render = async (): Promise<void> => {
    if (closed) return;
    if (rendering) {
      queued = true;
      return;
    }
    rendering = true;
    try {
      const route = initialRoute ?? routeFromHash(browserWindow.location.hash);
      initialRoute = undefined;
      if (route.kind === "subject" && route.subjectId !== undefined)
        lastSubjectId = route.subjectId;
      root.replaceChildren(navigation(document, route));
      const main = element(document, "main");
      main.setAttribute("aria-live", "polite");
      root.append(main);
      try {
        switch (route.kind) {
          case "library":
            await renderLibrary(document, client, main);
            break;
          case "subject":
            await renderSubject(document, client, main, route.subjectId ?? lastSubjectId, render);
            break;
          case "review":
            await renderReview(document, client, main, route.review, render);
            break;
          case "settings":
            await renderSettings(document, client, main);
            break;
          default:
            assertNever(route, "Panel route");
        }
      } catch (error) {
        const message =
          error instanceof DistillyError ? `${error.code}: ${error.message}` : "Panel read failed.";
        main.replaceChildren(
          textElement(document, "h1", "Panel error"),
          textElement(document, "p", message),
        );
      }
    } finally {
      rendering = false;
      if (queued) {
        queued = false;
        void render();
      }
    }
  };

  const onHashChange = (): void => {
    void render();
  };
  browserWindow.addEventListener("hashchange", onHashChange);
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = await client.watch(() => {
      void render();
    });
    await render();
  } catch (error) {
    browserWindow.removeEventListener("hashchange", onHashChange);
    unsubscribe?.();
    await client.close();
    throw error;
  }

  return {
    close: async () => {
      if (closed) return;
      closed = true;
      browserWindow.removeEventListener("hashchange", onHashChange);
      unsubscribe?.();
      await client.close();
    },
  };
};
