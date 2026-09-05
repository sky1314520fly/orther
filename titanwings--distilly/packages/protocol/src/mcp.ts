import {
  commitToolInputSchema,
  commitToolOutputSchema,
  correctToolInputSchema,
  correctToolOutputSchema,
  getToolInputSchema,
  getToolInputJsonSchema,
  getToolOutputSchema,
  getToolOutputJsonSchema,
  ingestToolInputSchema,
  ingestToolInputJsonSchema,
  ingestToolOutputSchema,
  ingestToolOutputJsonSchema,
  pendingToolInputSchema,
  pendingToolInputJsonSchema,
  pendingToolOutputSchema,
  pendingToolOutputJsonSchema,
  commitToolInputJsonSchema,
  commitToolOutputJsonSchema,
  correctToolInputJsonSchema,
  correctToolOutputJsonSchema,
} from "./schemas/mcp.js";
import type {
  BriefContractDigest,
  ClaimId,
  FacetPath,
  JobId,
  LeaseId,
  MaterialSetHash,
  SubjectId,
  VersionId,
} from "./ids.js";
import type { JsonObject } from "./json.js";
import { JSON_SCHEMA_DIALECT } from "./json.js";
import type { DistillPatch } from "./values/claims.js";
import type { IngestResult, IngestSubjectTarget, MaterialInput } from "./values/materials.js";
import type { HostDistillBriefing, JobLease, PendingJob } from "./values/jobs.js";
import type { Profile } from "./values/profiles.js";
import type {
  AmbiguousSubjectCandidates,
  SubjectSelector,
  SubjectStatus,
  SubjectSummary,
} from "./values/subjects.js";
import type { ReviewLaunch, ReviewReason, VersionSummary } from "./values/versions.js";
import type { RuntimeSchema, WireFailure, WireRequest, WireSuccess } from "./wire.js";

/** Input accepted by the local subject/profile lookup tool. */
export type GetToolInput =
  | (WireRequest & { readonly action: "resolve"; readonly subject: SubjectSelector })
  | (WireRequest & {
      readonly action: "profile";
      readonly subject: SubjectSelector;
      readonly versionId?: VersionId;
    })
  | (WireRequest & {
      readonly action: "prompt";
      readonly subject: SubjectSelector;
      readonly versionId?: VersionId;
    })
  | (WireRequest & { readonly action: "status"; readonly subject: SubjectSelector });

export type GetToolValue =
  | { readonly kind: "resolved"; readonly subject: SubjectSummary }
  | { readonly kind: "profile"; readonly subject: SubjectSummary; readonly profile: Profile }
  | { readonly kind: "prompt"; readonly subject: SubjectSummary; readonly prompt: string }
  | { readonly kind: "status"; readonly subject: SubjectSummary; readonly status: SubjectStatus }
  | { readonly kind: "not_found"; readonly query?: string }
  | { readonly kind: "ambiguous"; readonly candidates: AmbiguousSubjectCandidates };

/** Input accepted by the atomic create-or-existing text ingest tool. */
export interface IngestToolInput extends WireRequest {
  readonly subject: IngestSubjectTarget;
  readonly materials: readonly MaterialInput[];
  readonly enqueue: "auto" | "now";
}

export type IngestToolValue = IngestResult;

export type PendingToolInput =
  | (WireRequest & {
      readonly action: "list";
      readonly subjectId?: SubjectId;
    })
  | (WireRequest & {
      readonly action: "brief";
      readonly jobId: JobId;
    })
  | (WireRequest & {
      readonly action: "renew";
      readonly jobId: JobId;
      readonly leaseId: LeaseId;
    })
  | (WireRequest & {
      readonly action: "release";
      readonly jobId: JobId;
      readonly leaseId: LeaseId;
      readonly reason?: string;
    });

export type PendingToolValue =
  | {
      readonly kind: "jobs";
      readonly jobs: readonly [PendingJob, ...PendingJob[]];
    }
  | { readonly kind: "briefing"; readonly briefing: HostDistillBriefing }
  | { readonly kind: "lease_renewed"; readonly lease: JobLease }
  | { readonly kind: "released"; readonly jobId: JobId }
  | { readonly kind: "nothing_pending" };

/** Input accepted by the evidence-bound distillation commit tool. */
export interface CommitToolInput extends WireRequest {
  readonly jobId: JobId;
  readonly generation: number;
  readonly leaseId: LeaseId;
  readonly briefContractDigest: BriefContractDigest;
  readonly materialSetHash: MaterialSetHash;
  readonly baseVersionId?: VersionId;
  readonly patch: DistillPatch;
}

export type CommitToolValue =
  | { readonly kind: "current"; readonly version: VersionSummary; readonly profile: Profile }
  | {
      readonly kind: "suspended";
      readonly candidate: VersionSummary;
      readonly currentVersionId?: VersionId;
      readonly reasons: readonly ReviewReason[];
      readonly review: ReviewLaunch;
    };

/** Input accepted when a user explicitly corrects a subject fact through a host. */
export interface CorrectToolInput extends WireRequest {
  readonly subjectId: SubjectId;
  readonly text: string;
  readonly facet?: FacetPath;
  readonly supersedes?: readonly ClaimId[];
  readonly baseCandidateVersionId?: VersionId;
}

/** Suspended result returned for every host-relayed correction. */
export interface CorrectToolValue {
  readonly kind: "suspended";
  readonly candidate: VersionSummary;
  readonly currentVersionId?: VersionId;
  readonly reasons: readonly ReviewReason[];
  readonly review: ReviewLaunch;
}

export type GetToolOutput = WireSuccess<GetToolValue> | WireFailure;
export type IngestToolOutput = WireSuccess<IngestToolValue> | WireFailure;
export type PendingToolOutput = WireSuccess<PendingToolValue> | WireFailure;
export type CommitToolOutput = WireSuccess<CommitToolValue> | WireFailure;
export type CorrectToolOutput = WireSuccess<CorrectToolValue> | WireFailure;

export const DISTILLY_MCP_TOOL_NAMES = [
  "distilly_get",
  "distilly_ingest",
  "distilly_pending",
  "distilly_commit",
  "distilly_correct",
] as const;

export type DistillyMcpToolName = (typeof DISTILLY_MCP_TOOL_NAMES)[number];

/** Canonical MCP hints carried by every Distilly tool descriptor. */
export interface McpToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/** Serializable JSON Schema object accepted by MCP tool registration. */
export type JsonSchemaObject = JsonObject & {
  readonly $schema: typeof JSON_SCHEMA_DIALECT;
  readonly type: "object";
};

/** Transport-neutral MCP tool descriptor owned by the protocol package. */
export interface McpToolContract<Name extends string, Input, Output> {
  readonly name: Name;
  readonly title: string;
  readonly description: string;
  /** Authoritative boundary parser, including byte and cross-field constraints. */
  readonly input: RuntimeSchema<Input>;
  /** Authoritative result parser used before returning a tool result. */
  readonly output: RuntimeSchema<Output>;
  /** MCP projection; `x-distilly-*` keywords preserve constraints draft-2020-12 cannot express. */
  readonly inputSchema: JsonSchemaObject;
  /** MCP projection; callers that ignore extension keywords still receive runtime-validated output. */
  readonly outputSchema: JsonSchemaObject;
  readonly annotations: McpToolAnnotations;
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const satisfies McpToolAnnotations;

const localMutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const satisfies McpToolAnnotations;

const distillyGetToolContract = {
  name: "distilly_get",
  title: "Read local person memory",
  description: "Resolve a local subject or read its saved profile, prompt, or status.",
  inputSchema: getToolInputJsonSchema,
  outputSchema: getToolOutputJsonSchema,
  input: getToolInputSchema,
  output: getToolOutputSchema,
  annotations: readOnlyAnnotations,
} as const satisfies McpToolContract<"distilly_get", GetToolInput, GetToolOutput>;

const distillyIngestToolContract = {
  name: "distilly_ingest",
  title: "Store local source material",
  description: "Store supplied text and provenance for an existing or new local subject.",
  inputSchema: ingestToolInputJsonSchema,
  outputSchema: ingestToolOutputJsonSchema,
  input: ingestToolInputSchema,
  output: ingestToolOutputSchema,
  annotations: localMutationAnnotations,
} as const satisfies McpToolContract<"distilly_ingest", IngestToolInput, IngestToolOutput>;

const distillyPendingToolContract = {
  name: "distilly_pending",
  title: "Manage local distillation jobs",
  description: "List local pending jobs or brief, renew, or release a distillation lease.",
  inputSchema: pendingToolInputJsonSchema,
  outputSchema: pendingToolOutputJsonSchema,
  input: pendingToolInputSchema,
  output: pendingToolOutputSchema,
  annotations: localMutationAnnotations,
} as const satisfies McpToolContract<"distilly_pending", PendingToolInput, PendingToolOutput>;

const distillyCommitToolContract = {
  name: "distilly_commit",
  title: "Commit local distilled claims",
  description: "Validate and commit an evidence-bounded claim patch to local profile memory.",
  inputSchema: commitToolInputJsonSchema,
  outputSchema: commitToolOutputJsonSchema,
  input: commitToolInputSchema,
  output: commitToolOutputSchema,
  annotations: localMutationAnnotations,
} as const satisfies McpToolContract<"distilly_commit", CommitToolInput, CommitToolOutput>;

const distillyCorrectToolContract = {
  name: "distilly_correct",
  title: "Correct local person memory",
  description: "Store a relayed correction and open local review for its candidate version.",
  inputSchema: correctToolInputJsonSchema,
  outputSchema: correctToolOutputJsonSchema,
  input: correctToolInputSchema,
  output: correctToolOutputSchema,
  annotations: localMutationAnnotations,
} as const satisfies McpToolContract<"distilly_correct", CorrectToolInput, CorrectToolOutput>;

/** Exact model-facing tool inventory; private capture is deliberately absent. */
export const distillyMcpTools = [
  distillyGetToolContract,
  distillyIngestToolContract,
  distillyPendingToolContract,
  distillyCommitToolContract,
  distillyCorrectToolContract,
] as const;

/** Allowed successful result kinds for each read action. */
export const GET_TOOL_SUCCESS_KINDS_BY_ACTION = {
  resolve: ["resolved", "not_found", "ambiguous"],
  profile: ["profile", "not_found", "ambiguous"],
  prompt: ["prompt", "not_found", "ambiguous"],
  status: ["status", "not_found", "ambiguous"],
} as const satisfies Readonly<Record<GetToolInput["action"], readonly GetToolValue["kind"][]>>;

/** Allowed successful result kinds for each pending action. */
export const PENDING_TOOL_SUCCESS_KINDS_BY_ACTION = {
  list: ["jobs", "nothing_pending"],
  brief: ["briefing", "nothing_pending"],
  renew: ["lease_renewed"],
  release: ["released"],
} as const satisfies Readonly<
  Record<PendingToolInput["action"], readonly PendingToolValue["kind"][]>
>;
