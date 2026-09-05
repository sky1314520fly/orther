> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 14. Commit、证据校验、质量门与版本

### 14.1 CommitService 顺序

1. 在 wire 边界校验 schema、canonical patch bytes 与 RequestId preimage；先返回 exact operation replay，preimage 不同返回 idempotency_conflict。
2. 从 authoritative job/lease rows 解析 subject、generation、base 与 pinned BriefContract；active suspended 先返回 review_conflict。
3. 在一致 read snapshot 中读取 base version claims/material membership、current subject membership 和引用的 material metadata/blob，重建 EvidenceContext。
4. 依 §7.6 precedence 校验 job/generation/base/material set、lease id/session owner/expiry 与 echoed contract，再校验 operation targets、date range、evidence membership、quote 与 Unicode-scalar locator。
5. canonicalize accepted patch/resolved drafts，applyClaimPatch 并派生 ClaimId、strength、quality、ReviewReason、current/suspended disposition、VersionId、Profile 与 prompt bytes。
6. 打开唯一 SQLite write transaction，重新检查 RequestId、job/lease/generation/current/suspended revision均未变化；插入 immutable version metadata、claim/evidence/version membership与render metadata，更新 pointer/status，删除 pending/lease，并写 operation stable result和固定 events。
7. commit 后发布 watch invalidation；profile/prompt/Library projections按 transaction LSN 幂等追赶。

前五步任何失败都不写权威状态；第六步 precondition 变化使 transaction rollback并返回最窄 stale/lease/review error。suspended 是合法成功，不是 error；current 与 suspended 都在一个 transaction 中得到完整 immutable version并原子清除 pending/lease。没有 DistillCommitTransactionRecord、version staging、state.json swap 或 post-commit semantic recovery。
### 14.2 Hard reject

以下情况 hard reject：

- lease 不存在、过期、owner 不符；
- generation、baseVersion、materialSetHash 或回显的 briefContractDigest 与 lease 不匹配；
- 已有 active suspended；
- operation 指向不存在或不属于 base 的 claim，或同一个 base claim 被操作多次；
- facet 语法非法；
- EvidenceDraft 空、ref 不属于 briefing、MaterialId 跨主体；
- quote 不是真实 content 子串，locator 不满足 start<end / scalar bounds 或 slice 不匹配；
- validFrom 晚于 validTo，patch 产生重复 active ClaimId、supersede 环或无证据 active claim；
- accepted patch canonical UTF-8 bytes 大于 65,536，或出现首版 schema 没有的 relationOperations；
- 同 requestId 换了输入；
- 直接读取的 database row、foreign key 或 blob digest/schema 损坏。

回显 digest 不匹配按 stale_job 处理；digest 匹配但当前 binary 已不能执行 lease 固定的 source-grouping 或 draft schema 时按 schema_unsupported 处理。两种情况都不能尝试用当前默认算法提交。

模型可以根据 fieldPath 修正 invalid_input / evidence_invalid 后用新 requestId 重试；stale_job 必须重新 brief。所有 hard reject 都使 write transaction 不发生或 rollback，并保留 pending/lease；不能以“方便重试”为由改 authoritative state。

### 14.3 QualitySummary

~~~ts
export type Maturity = "sparse" | "forming" | "stable";

export interface QualitySummary {
  readonly sourceGroupingVersion: string;
  readonly activeClaimCount: number;
  readonly contestedClaimCount: number;
  readonly userAssertedClaimCount: number;
  readonly corroboratedClaimCount: number;
  readonly sourceGroupCount: number;
  readonly diversityEligibleSourceGroupCount: number;
  readonly unknownSourceGroupCount: number;
  readonly coveredCoreFacets: readonly CoreFacetName[];
  readonly uncoveredCoreFacets: readonly CoreFacetName[];
  readonly maturity: Maturity;
}
~~~

不提供一个看似精确的 0..1 总分。计数、来源和冲突更容易解释，也不会把模型意见伪装成测量。activeClaimCount/status=active、contestedClaimCount/status=contested、userAssertedClaimCount=active 且 strength=user_asserted、corroboratedClaimCount=active 且 evidence 跨至少两个 distinct eligible source groups。三个 source-group count 只对 candidate 的 active / contested claims **实际引用**的 MaterialId 去重计数；未引用材料、只被 superseded claim 引用的材料和 raw 不提高 maturity。sourceGroupCount 是全部被引用组；diversityEligibleSourceGroupCount 是其中 status=eligible 的子集；unknownSourceGroupCount 是其中 status=unknown 的子集，status=ineligible 的数量可由总数减去两者得到。这三个集合定义互斥且完整；同一视频的多种文本表示不增加 eligible count。

strength 也不接受宿主输入：沿用的 active user_asserted/imported_unverified 保留其来源语义，status=contested 固定 strength=contested；其它 active claim 用 candidate grouping 重算，至少两个 eligible groups 才是 corroborated，否则 single_source。superseded 保留其已有 strength 作为历史字段但不进入任何 quality count。coveredCoreFacets 是至少有一个 active claim 的 facet first segment，按七 core 固定顺序；uncoveredCoreFacets 是同一顺序的补集。domain、contested-only 或 superseded-only facet 不算 covered。

成熟度算法在 protocol schema major 内版本化：

- sparse：identity 或 voice 未覆盖，或覆盖少于三个 core facets；
- forming：identity 与 voice 已覆盖，覆盖至少三个 core facets，但未满足 stable；
- stable：identity 与 voice 已覆盖、至少五个 core facets、有至少两个 diversity-eligible source groups、contestedClaimCount=0。

correction 的 user_asserted 单独显示，不把它算成两个独立公开来源。来源 role 只解释 coverage，不参与 maturity；私人联系人不会因为“没有三家媒体”而 hard reject，只会诚实保持 sparse / forming 或来源集中。

### 14.4 ReviewReason 与自动 current

~~~ts
export type ReviewReason =
  | { readonly code: "identity_changed"; readonly claimIds: readonly ClaimId[] }
  | { readonly code: "coverage_decreased"; readonly facets: readonly FacetPath[] }
  | { readonly code: "voice_examples_removed"; readonly claimIds: readonly ClaimId[] }
  | { readonly code: "new_contested_claims"; readonly claimIds: readonly ClaimId[] }
  | { readonly code: "correction_conflict"; readonly claimIds: readonly ClaimId[] }
  | { readonly code: "source_diversity_decreased" }
  | { readonly code: "suspicious_source"; readonly materialIds: readonly MaterialId[] }
  | {
      readonly code: "relayed_correction";
      readonly actorKind: "host" | "sdk" | "executor" | "system";
    }
  | { readonly code: "imported_profile" }
  | { readonly code: "manual_review_requested"; readonly note?: string };
~~~

candidate 在没有任何 ReviewReason 时自动 current。第一版 QualityGate 只使用上述机械信号，不做第二次 LLM judge。reason tuple 按 union 中的 code 顺序固定为 identity_changed、coverage_decreased、voice_examples_removed、new_contested_claims、correction_conflict、source_diversity_decreased、suspicious_source、relayed_correction、imported_profile、manual_review_requested；每个 reason 最多一次，内部 claimIds/facets/materialIds exact 去重后按 UTF-8 bytes 升序。

host commit 有 base 时，identity_changed 是 before 中 first segment=identity 的 active ClaimId 在 after 不再 active；coverage_decreased 是 before.coveredCoreFacets 减 after；voice_examples_removed 是 before 中 first segment=voice 的 active ClaimId 在 after 不再 active；new_contested_claims 是 after contested ClaimId 减 before contested；source_diversity_decreased 当且仅当 after.diversityEligibleSourceGroupCount < before。suspicious_source 是 after active/contested 新引用、而 before active/contested 未引用且 MaterialRecord.flags 含 suspicious_source 的 MaterialId。manual_review_requested 当且仅当 accepted patch 带 reviewRequest，并保留其 canonical note。首个版本没有 base，跳过上述 identity/coverage/voice/contested/source-diversity delta reasons，但仍计算 suspicious_source 与 manual_review_requested；因此首版并非自动 clean。

CorrectionService 对 accepted supersedes 非空固定产生恰好一条 correction_conflict，其 claimIds 是 accepted exact unique UTF-8-sorted targets；空 supersedes 禁止该 reason，不从自由文本猜语义冲突。actor.kind=user 固定 direct_user provenance 且禁止 relayed_correction；其它 actor 固定 matching relayed provenance，并产生恰好一条 `relayed_correction(actorKind=actor.kind)`。correction 的 after 是选定 current/candidate 内容基线应用 §13.3 replacement 后的完整 claims，但所有 identity/coverage/voice/contested/source-diversity/suspicious delta gate 的 before 始终是 transaction-time previous current；没有 previous current 时用上段 first-version 规则，active suspended 不能成为已接受的风险基线。剩余机械 reasons 按同一固定顺序重新计算；不继承 candidate 的旧 reason tuple，也不能由 correction 降低或删除算出的 reason。imported_profile 仍只由 BundleImporter 设置；这些 reasons 不是 host commit 的推断项。current VersionRecord 不得有 reviewReasons；suspended VersionRecord 必须有与 CommitResult.reasons 逐字段相同的非空 tuple。该 tuple 进入 VersionId preimage，并由 operation stable result 精确重放。

出现 reason 时 candidate suspended，旧 current 保持。用户可以 promote 接受风险、reject 保留历史但不使用、correct 后产生新候选。Panel 与 CLI 都调用同一 ReviewService。

每个 subject **最多一个 active suspended target**。存在 suspended 时，新的 brief / ordinary commit / rollback 返回 review_conflict；ingest 仍可继续并排队，但不覆盖待审目标。promote / reject 必须同时校验 candidate 仍是 state.suspended 且 candidate.parentId === state.currentVersionId。针对待审版本的 correction 必须显式传 baseCandidateVersionId：新版本仍以当前版本作为 parent / CAS 基线，以旧 candidate claims 作为内容派生基线，并在 derivedFromCandidateVersionId 记录这条边；同一事务把旧 candidate 转为已定义的 rejected 状态、写 candidate_replaced event，再产生新的 current 或 suspended。省略 target 时若已有 suspended，同样返回 review_conflict。

### 14.5 新证据可以降低质量

V2 的“材料只增加，所以置信只能增加”不成立：新来源可能直接反驳旧结论，或暴露原材料是转载。V3 把冲突表示为 contested claim 与 review reason；它不是蒸馏失败的同义词。

同一 material set 默认不自动重跑，因此外部模型随机性不会持续制造版本。用户显式 redistill 时，结果可不同；系统记录 executor、model、promptVersion、draft hash，并用 diff / gate 管理差异。

### 14.6 Version

~~~ts
export type VersionStatus =
  | "current" | "suspended" | "historical" | "rejected";

export type CreatedDisposition = "current" | "suspended";

export type VersionCreation =
  | {
      readonly kind: "host_distill";
      readonly briefContractDigest: BriefContractDigest;
      readonly promptVersion: string;
      readonly draftSchemaVersion: number;
    }
  | { readonly kind: "correction"; readonly correctionMaterialId: MaterialId }
  | { readonly kind: "rollback"; readonly targetVersionId: VersionId }
  | { readonly kind: "bundle_import"; readonly bundleDigest: ContentDigest }
  | { readonly kind: "renderer_only"; readonly sourceVersionId: VersionId };

interface VersionRecord {
  readonly id: VersionId;
  readonly subjectId: SubjectId;
  readonly subjectDisplayName: string;
  readonly parentId?: VersionId;
  readonly derivedFromCandidateVersionId?: VersionId;
  readonly generation: number;
  readonly materialSetHash: MaterialSetHash;
  readonly materialCount: number;
  readonly creation: VersionCreation;
  readonly createdDisposition: CreatedDisposition;
  readonly actor: ActorContext;
  readonly quality: QualitySummary;
  readonly rendererVersion: string;
  readonly reviewReasons?: readonly [ReviewReason, ...ReviewReason[]];
  readonly createdAt: IsoDateTime;
}

export interface VersionSummary {
  readonly id: VersionId;
  readonly subjectId: SubjectId;
  readonly parentId?: VersionId;
  readonly derivedFromCandidateVersionId?: VersionId;
  readonly generation: number;
  readonly materialSetHash: MaterialSetHash;
  readonly creation: VersionCreation;
  readonly status: VersionStatus;
  readonly actor: ActorContext;
  readonly quality: QualitySummary;
  readonly createdAt: IsoDateTime;
}

export interface ReviewRef {
  readonly subjectId: SubjectId;
  readonly candidateVersionId: VersionId;
}

export interface ReviewLaunch {
  readonly ref: ReviewRef;
  readonly url: string;
}
~~~

VersionId 由引擎根据 version-time subject displayName、parent/content lineage、generation、material membership、canonical claims/quality、creation、actor、renderer 与 review reasons 的版本化 preimage 确定；调用方不可指定。VersionCreation 是互斥来源合同：host_distill 固定 lease contract，correction、rollback、bundle import 与 renderer-only 记录各自真实来源，不能伪造 sentinel briefing。

SQLite transaction 一次插入 immutable version row、排序 material membership、canonical claim/evidence membership 与 creation lineage。version row 后续不 update；promote/reject 只改变独立 status/pointer rows并追加 event。parentId 是创建时 current/CAS 基线；derivedFromCandidateVersionId 只在 correction 替代 suspended candidate 时存在。rollback 创建新 immutable descendant，不把 current pointer倒回旧 row。

subjectDisplayName 是 version-time snapshot并进入 VersionId；历史 Profile/prompt 不读取以后可变的 subject displayName。reviewReasons 当且仅当 createdDisposition=suspended 时存在且非空，current 时缺失。material membership 必须按 MaterialId canonical order、无重复，并与 materialSetHash/materialCount一致；claim evidence 只能引用该 membership。

Profile、prompt 和 human-readable version JSON/Markdown 是由 immutable version snapshot和 pinned renderer重建的 export/projection，不是 version commit 的第二套权威文件。普通 version/profile/material read 在一个 SQLite read transaction中读取直接需要的 row与blob并验证对应 digest/foreign keys；不为每次查询重放所有 history/event/render output。doctor、restore 和 bundle import负责完整 lineage、deterministic id、evidence quote与renderer audit。

privacy purge 可以删除受影响的 authoritative rows/references并保留content-free tombstone；零引用 blob由通用GC处理。archive与reject不删除immutable history。

---
