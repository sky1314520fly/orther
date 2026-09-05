> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 11. Ingest、去重、generation 与作业

### 11.1 IngestService 的步骤

1. 在 wire 边界解析并规范化整批输入；create target 预分配本次成功时使用的 SubjectId。整批任一材料非法时，数据库和产品可见 blob reference 都不变。
2. 绑定可信 capture context，计算 canonical content、ContentDigest、ProvenanceDigest、source identity 与 MaterialId，并通过通用 BlobStore put 保存正文。相同 digest 的 blob 幂等复用。
3. 打开唯一 SQLite write transaction，先做 RequestId replay/conflict，再按 §9.4 重新解析主体/空间/identity，并读取当前 generation、material membership、current version 与 pending job。
4. 对已存在 MaterialId 校验 content bytes/digest、provenance digest、source identity 与所有进入 identity 的 source semantics；完全相同是 duplicate，任何 hash collision 或 identity-bearing 不一致是 storage_corrupt。`title` 与 `capturedAt` 是明确不进入 MaterialId 的 first-seen display metadata：新的 RequestId 只改变这些字段时仍是 duplicate，不改写最初已存 row，也不升级为 corruption。新材料插入 metadata 与 blob reference。
5. 计算完整 material-set identity、generation 与 enqueue policy。需要作业时插入或替换 authoritative pending job；同 transaction 写 stable operation result 与 subject/material/job events。
6. commit 后发布 watch invalidation，并让 profile/Library/export worker按 LSN 追赶。projection 失败不改变 IngestResult 或已经提交的 generation。

create 与第一批材料使用同一个 transaction，因此不会留下空主体。进程在 blob put 后、database commit 前退出只留下未引用 blob；它不需要 ingest journal 或 cleanup branch。

### 11.2 必须是纯函数的算法

~~~ts
export interface NormalizedMaterial
  extends Omit<MaterialInput, "source" | "derivation"> {
  readonly content: string;
  readonly source: MaterialSource;
  readonly derivation: TextDerivation;
  readonly participants: readonly string[];
  readonly sensitivity: "private" | "shareable";
  readonly flags: readonly "suspicious_source"[];
}

interface NormalizedCorrectionMaterial {
  readonly kind: "correction";
  readonly content: string;
  readonly source: MaterialSource;
  readonly derivation: Extract<TextDerivation, { readonly kind: "native_text" }>;
  readonly participants: readonly string[];
  readonly sensitivity: "private";
  readonly flags: readonly "suspicious_source"[];
  readonly correctionProvenance: CorrectionProvenance;
}

declare function canonicalizeIngestSubjectTarget(
  target: IngestSubjectTarget,
): Uint8Array;
export declare function normalizeMaterial(input: MaterialInput): NormalizedMaterial;
declare function bindParsedMaterial(
  rawId: RawId,
  draft: ParsedMaterialDraft,
): NormalizedMaterial;
declare function normalizeCorrectionDraft(
  input: CorrectionDraft,
): AcceptedCorrection;
declare function normalizeCorrectionMaterial(
  input: AcceptedCorrection,
  actor: ActorContext,
  storedAt: IsoDateTime,
): NormalizedCorrectionMaterial;
export declare function digestContent(content: string): ContentDigest;
export declare function digestProvenance(
  input: NormalizedMaterial | NormalizedCorrectionMaterial,
  engineOwned?: {
    readonly captureAuditRef?: CaptureAuditRef;
    readonly conversationSourceKey?: ConversationSourceKey;
  },
): ProvenanceDigest;
export declare function deriveMaterialId(
  sourceIdentity: string,
  provenance: ProvenanceDigest,
  content: ContentDigest,
): MaterialId;
export declare function hashMaterialSet(
  records: readonly MaterialRecord[],
): MaterialSetHash;
export declare function deriveSourceGroups(
  records: readonly MaterialRecord[],
  sourceGroupingVersion: "source-groups-v1",
): SourceGroupingSnapshot;
~~~

`material-text-v1` 仍固定 CRLF/CR→LF、Unicode NFC、逐行移除尾部 U+0020/U+0009，并保留原本是否有最终 LF；全 whitespace 结果 invalid_input。source URI、artifact locator、authors/participants/flags 与 sensitivity 继续使用 §9/§10 的 canonical rules。

MaterialId 与 blob id 是两个概念。blob 只对 canonical content bytes 求完整摘要；MaterialId 还绑定 source identity 与 provenance，因此同一正文可以有多个可审核来源。普通材料 source identity 仍按 canonical source URI → artifact external id → artifact URI → request-scoped clientRef 的版本化优先级派生。correction 使用 request-stable namespace并把 direct/relayed actor 进入 provenance，但 RequestId 不进入 blob address。

source grouping 是 versioned O(n) pure function，不读当前默认配置、不写存储。历史 version 保存它使用的 algorithm version 和结果所需 metadata；算法升级不能静默重算旧 QualitySummary。

### 11.3 enqueue 语义

| 值 | 行为 |
|---|---|
| auto | 未提交到 current version 的材料数 `>= 3`，或最早未提交材料距本次 ingest clock `>= 30 分钟`时建 job；这是 `auto-v1`，不是用户调参 |
| now | 只要当前 material set 与 current version membership 不同，或已有 pending，就立即创建/复用 job；集合相同且没有 pending 才不建 job |

baseline 来自 SQLite 中 current version 的 material membership；没有 current 时为空。duplicate-only attempt 仍评估 auto，没有 timer。相同 generation/material set 复用 JobId；新 generation 使用新 JobId 并让旧 lease 变 stale。

Correction 不接收 enqueue policy。每个 committed correction 都 generation+1 并建立 fresh no-lease pending job，让后续宿主可在用户断言基础上重新蒸馏；如果 correction version 已成为 current，addedMaterialCount 可以为 0。

### 11.4 Job 类型与权威

~~~ts
export type PublicJobState = "pending" | "leased" | "failed";

interface PendingJobBase {
  readonly id: JobId;
  readonly subjectId: SubjectId;
  readonly generation: number;
  readonly baseVersionId?: VersionId;
  readonly materialSetHash: MaterialSetHash;
  readonly addedMaterialCount: number;
  readonly totalMaterialCount: number;
  readonly queuedAt: IsoDateTime;
}

export type PendingJob =
  | (PendingJobBase & {
      readonly state: "pending";
      readonly leaseExpiresAt?: never;
      readonly failure?: never;
    })
  | (PendingJobBase & {
      readonly state: "leased";
      readonly leaseExpiresAt: IsoDateTime;
      readonly failure?: never;
    })
  | (PendingJobBase & {
      readonly state: "failed";
      readonly leaseExpiresAt?: never;
      readonly failure: PendingJobFailure;
    });
~~~

jobs/leases 表是作业的唯一权威，不存在另一个 state marker 或 queue database。public state 在读取 transaction 中由 job/lease rows 和 clock 派生：`now < expiresAt` 才是 leased，过期显示 pending。list 固定按 queuedAt ASC、JobId UTF-8 ASC，filter 在 limit 前应用。

Library 或 CLI 需要的 queue 文件只是带 LSN 的可选 projection/export。删除或损坏它不会丢 job；重建直接读取 authoritative rows。不得用 dirty marker、sibling database 或 projection lock模拟第二套事务。

### 11.5 新 generation

同一 subject 在 leased 时继续 ingest：

- transaction 插入新材料 reference；
- subject generation 增一；
- pending 使用新 job 整体替换，旧 lease 不再匹配；
- old worker commit 返回 stale_job；
- projection 随 LSN 追赶，不得恢复旧 job。

这条由同一 SQLite transaction 和 generation/revision 条件证明，不依赖“通常不会并发”。

---
