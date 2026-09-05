> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 22. 关系、提及与图

### 22.1 第一版优先级

关系不阻塞公开人物单主体首发；公开语义与 SQLite authority contract 先定，核心闭环和 Panel 通过后落地。相似 affinity 仍然后置。

### 22.2 Relation

~~~ts
export interface Relation {
  readonly id: RelationId;
  readonly spaceId: SpaceId;
  readonly sourceSubjectId: SubjectId;
  readonly targetSubjectId: SubjectId;
  readonly type: string;
  readonly role?: Readonly<Record<string, string>>;
  readonly evidence: readonly EvidenceRef[];
  readonly status: "active" | "invalidated";
  readonly validFrom?: IsoDateTime;
  readonly validTo?: IsoDateTime;
  readonly extractedFrom?: VersionId;
}
~~~

type 使用开放点分路径，如 work.founded、family.parent、canon.rival、fanon.ally。同人内容必须标 fanon。方向性由 source / target 与 role 表达，不靠 id 排序暗示。

关系和相似分开：

| | Relation | Affinity |
|---|---|---|
| 来源 | 材料明确写出或用户确认 | 多主体 claims 的派生相似 |
| 存储 | SQLite authoritative relation rows/events | 可重建 affinity/search projection |
| 首版 | 核心后落地 | 不做 |

### 22.3 RelationOperationDraft

首发 DistillPatch **没有** relationOperations，closed-object schema 对该 unknown key 返回 invalid_input。下列 RelationOperationDraft 只属于后续 additive relation slice；该 slice 必须新增明确 method/patch discriminant、SQLite transaction 与 gate 后才可启用，不能用 feature flag 偷偷接受或静默丢弃：

~~~ts
export type RelationOperationDraft =
  | {
      readonly op: "add";
      readonly target:
        | { readonly subjectId: SubjectId }
        | { readonly rawName: string };
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

interface ResolvedRelationOperation {
  readonly op: "add" | "invalidate";
  readonly targetSubjectId?: SubjectId;
  readonly relationId?: RelationId;
  readonly type?: string;
  readonly role?: Readonly<Record<string, string>>;
  readonly reason?: string;
  readonly evidence: readonly EvidenceRef[];
}

export interface LinkInput {
  readonly sourceSubjectId: SubjectId;
  readonly targetSubjectId: SubjectId;
  readonly type: string;
  readonly role?: Readonly<Record<string, string>>;
  readonly evidence: readonly EvidenceRef[];
}

export interface InvalidateRelationInput {
  readonly relationId: RelationId;
  readonly reason: string;
}

export interface NeighborQuery {
  readonly subjectId: SubjectId;
  readonly typePrefix?: string;
}

export type RelationMethodExtension = Readonly<{
  readonly "relations.link": Method<LinkInput, Relation>;
  readonly "relations.invalidate": Method<InvalidateRelationInput, EmptyResult>;
  readonly "relations.neighbors": Method<NeighborQuery, readonly Relation[]>;
}>;
~~~

rawName 不自动建边，进入 PendingMention。多个候选必须由用户 resolve。

RelationMethodExtension 是关系 slice 落地时整体加入 EngineMethodMap 的 additive 合同；在实现与 runtime schemas 同时存在前，它不是首发 methods 的一部分。ResolvedRelationOperation 只在 engine 内部使用，由与 claims 相同的 evidence resolver 产生。

### 22.4 复杂度

- 新建 subject O(1)；
- commit 添加 k 条关系 O(k)；
- neighbor query 走 (subjectId, type) projection，O(k)；
- graph rebuild O(subjects + relations + mentions)；
- commit 禁止扫描全图或做所有人两两比较；
- affinity 以后使用倒排候选或查询时计算，不物化全图宽边。

### 22.5 事实与投影

relation rows 与 add/invalidate events 在同一个 SQLite transaction 中提交；当前 Relation 可由 status row直接读取，完整审计仍能重放events。graph/search是带LSN的可删投影；损坏时 neighbor返回index_unavailable/remediation，不悄悄扫描blob或export。

---
