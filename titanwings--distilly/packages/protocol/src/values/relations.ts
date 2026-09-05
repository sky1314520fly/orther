import type { RelationId, SubjectId } from "../ids.js";
import type { EvidenceDraft } from "./claims.js";

export type RelationOperationDraft =
  | {
      readonly op: "add";
      readonly target: { readonly subjectId: SubjectId } | { readonly rawName: string };
      readonly type: string;
      readonly role?: Readonly<Record<string, string>>;
      readonly evidence: readonly EvidenceDraft[];
    }
  | {
      readonly op: "invalidate";
      readonly relationId: RelationId;
      readonly reason: string;
      readonly evidence: readonly EvidenceDraft[];
    };
