> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 13. Claim、Profile、Patch 与确定性渲染

### 13.1 七个内核面

~~~ts
export type CoreFacetName =
  | "identity"
  | "voice"
  | "psyche"
  | "relations"
  | "boundaries"
  | "texture"
  | "timeline";
~~~

| 内核面 | 内容 |
|---|---|
| identity | 名字、别名、复数角色、公开与私下身份 |
| voice | 口头禅、节奏、标点、真实对话例；没有例句就不能声称声音已成形 |
| psyche | 价值排序、矛盾、决策与回避方式 |
| relations | 对亲密、陌生、权威与群体的模式 |
| boundaries | 雷区、拒绝方式、不会做的事 |
| texture | 身体习惯、物件、口味、时间感与具体小事 |
| timeline | 有证据的变化与时间点 |

工作、亲密、技艺、家庭、公众表达等属于开放 domain。domainPack 只决定创建时建议哪些 domain，不制造新的 Person 子类。

### 13.2 Evidence 与 Claim

~~~ts
export interface EvidenceRef {
  readonly materialId: MaterialId;
  readonly quote: string;
  readonly locator?: {
    readonly start: number;
    readonly end: number;
  };
}

export type ClaimStatus =
  | "active" | "contested" | "superseded";

export type EvidenceStrength =
  | "user_asserted"
  | "single_source"
  | "corroborated"
  | "contested"
  | "imported_unverified";

export interface Claim {
  readonly id: ClaimId;
  readonly facet: FacetPath;
  readonly text: string;
  readonly evidence: readonly EvidenceRef[];
  readonly status: ClaimStatus;
  readonly strength: EvidenceStrength;
  readonly observedIn: readonly string[];
  readonly validFrom?: IsoDateTime;
  readonly validTo?: IsoDateTime;
  readonly createdIn: VersionId;
  readonly supersededBy?: ClaimId;
}
~~~

quote 必填且必须是规范化 content 的精确子串；locator 存在时必须正好指向 quote。locator 在 material-text-v1 规范化正文的 Unicode scalar sequence 上计数，start inclusive、end exclusive；不是 UTF-8 byte offset，也不是 JavaScript UTF-16 code-unit offset，必须满足 `0 <= start < end <= scalarLength(content)` 且该 scalar slice 等于 quote。允许同一 claim 引用旧版本材料与本 generation 新材料，但新增引用必须通过当前 material set membership。

### 13.3 Draft 不带 engine-owned 字段

~~~ts
export interface BriefEvidenceDraft {
  readonly kind: "brief_material";
  readonly materialRef: BriefMaterialRef;
  readonly quote: string;
  readonly locator?: { readonly start: number; readonly end: number };
}

export interface BaselineEvidenceDraft {
  readonly kind: "baseline_evidence";
  readonly claimId: ClaimId;
  readonly evidenceIndex: number;
}

export type EvidenceDraft = BriefEvidenceDraft | BaselineEvidenceDraft;

export interface ClaimDraft {
  readonly facet: FacetPath;
  readonly text: string;
  readonly evidence: readonly EvidenceDraft[];
  readonly observedIn?: readonly string[];
  readonly validFrom?: IsoDateTime;
  readonly validTo?: IsoDateTime;
}

export type ClaimOperation =
  | { readonly op: "add"; readonly claim: ClaimDraft }
  | {
      readonly op: "revise";
      readonly claimId: ClaimId;
      readonly replacement: ClaimDraft;
      readonly reason: string;
    }
  | {
      readonly op: "supersede";
      readonly claimId: ClaimId;
      readonly reason: string;
      readonly evidence: readonly EvidenceDraft[];
    }
  | {
      readonly op: "contest";
      readonly claimId: ClaimId;
      readonly reason: string;
      readonly evidence: readonly EvidenceDraft[];
    };

export interface DistillPatch {
  readonly operations: readonly ClaimOperation[];
  readonly reviewRequest?: { readonly note?: string };
  readonly notes?: string;
}
~~~

revise 产生新 ClaimId 并把旧 claim 标 superseded；不会原地改历史。contest 保留旧文本但改变候选版本中的状态与 strength。无 remove 操作，删除语义必须通过 supersede 并留下理由与证据。

brief_material 只能引用本 generation briefing 的新材料。baseline_evidence 只能引用 baseline 中已有 claim 的某条 EvidenceRef；引擎从 base version 重新读取并校验，宿主不能修改旧 quote。这样 revise 可以保留旧佐证并增加新材料，不需要把全部历史正文重新发给模型。reviewRequest 只能增加人工审核，不能绕过任何 hard reject 或降低风险等级。

宿主 patch 先解析成只在 engine 内部存在的 resolved 形状：

~~~ts
interface ResolvedClaimDraft extends Omit<ClaimDraft, "evidence"> {
  readonly evidence: readonly EvidenceRef[];
}

type ResolvedClaimOperation =
  | { readonly op: "add"; readonly claim: ResolvedClaimDraft }
  | {
      readonly op: "revise";
      readonly claimId: ClaimId;
      readonly replacement: ResolvedClaimDraft;
      readonly reason: string;
    }
  | {
      readonly op: "supersede" | "contest";
      readonly claimId: ClaimId;
      readonly reason: string;
      readonly evidence: readonly EvidenceRef[];
    };

interface ResolvedPatch {
  readonly operations: readonly ResolvedClaimOperation[];
  readonly reviewRequest?: { readonly note?: string };
}

interface ResolvedCorrectionReplacement {
  readonly facet: FacetPath;
  readonly text: string;
  readonly evidence: readonly [EvidenceRef];
  readonly observedIn: readonly [];
  readonly supersedes: readonly ClaimId[];
}
~~~

DistillPatch 首版没有 relationOperations，unknown-key schema 会直接拒绝该字段；§22 的关系草案只在后续独立 feature 以 additive 类型/方法加入，不留 feature flag placeholder。ResolvedPatch 与 ResolvedCorrectionReplacement 都不从 protocol 根导出，MCP / SDK 也不能构造。host patch 由 EvidenceResolver 从 §12.3 重建的 EvidenceContext 构造；CorrectionService 则在 correction content blob 已写入、且即将由同一 SQLite transaction 建立引用时构造窄 replacement algebra。两条路径随后进入同一个 claim canonicalization → quality → version transaction core，不伪造 BriefMaterialRef，也不存在 trusted commit 捷径。

ResolvedCorrectionReplacement 的 text/facet 分别逐字段等于 AcceptedCorrection；唯一 EvidenceRef 的 materialId 是 correctionMaterial.id，quote 是完整 normalized text，locator 必须是 Unicode scalar `{ start: 0, end: Array.from(text).length }`，observedIn 固定为空。它按普通 canonical resolved draft 计算一个新的 ClaimId，并且只新增一条 status=active、strength=user_asserted 的 claim。supersedes 逐字段等于 accepted 的 unique UTF-8-sorted tuple；每个 target 必须存在于选定内容基线且尚未 superseded，随后全部变为 status=superseded、supersededBy=同一 replacement id，其他字段保持。replacement id 重复、target missing/already superseded/duplicate、target 包含 replacement 或形成任何 cycle 都是 invalid_input。correction replacement 没有 caller/engine 发明的 reason string，也不能扩成多个 add/revise/contest 操作。

resolved draft 的 canonical form 固定包含 `facet`、`text`、canonical evidence 与 canonical `observedIn`（输入缺失时为 `[]`），并只在输入存在时包含 validFrom/validTo。EvidenceRef 先按完整 canonical JSON exact 去重，再按 UTF-8 tuple `(materialId, locatorKey, quote)` 排序，其中 locatorKey 在缺失时是空串、存在时是 canonical ASCII `${start}:${end}`；observedIn 按 exact string 去重并按 UTF-8 bytes 排序。validFrom 与 validTo 同时存在时必须 `validFrom <= validTo`。同一 DistillPatch 中每个 base active/contested ClaimId 至多被 revise/supersede/contest 一次；重复 target、target 不在 base、target 已 superseded、或由 revise/supersede 形成的 cycle 都 invalid_input。

ClaimId 固定为 `claim_ + SHA-256("claim-v1\0" + canonicalJson({ subjectId, draft: canonicalResolvedDraft }))`。add/revise 产生 status=active 的新 id；revise 同时把旧 claim 变为 superseded 并设置 `supersededBy=<new id>`；supersede 把旧 claim 变为 superseded 且不得有 supersededBy；contest 保留旧 id、createdIn、facet/text/validity，合并旧 evidence 与本操作 resolved evidence后重新 canonicalize，令 status/strength=contested。未触及 claim 原样保留，empty operations 是合法 no-op candidate。operation/version rows 保存 accepted patch digest、canonical review reasons 与 stable result，因此 idempotent replay 不依赖重新解释宿主 draft。

### 13.4 Engine-owned 纯函数

~~~ts
export interface MaterialEvidenceFacts {
  readonly materialId: MaterialId;
  readonly sourceGroup: SourceGroup;
  readonly sourceRole?: SourceRole;
  readonly derivation: TextDerivation;
  readonly kind: MaterialRecord["kind"];
  readonly flags: readonly "suspicious_source"[];
}

export interface MaterialEvidenceIndex {
  readonly sourceGroupingVersion: string;
  readonly byMaterial: ReadonlyMap<MaterialId, MaterialEvidenceFacts>;
}

interface EvidenceContext {
  readonly contract: BriefContract;
  readonly byBriefRef: ReadonlyMap<BriefMaterialRef, MaterialRecord>;
  readonly baseClaims: ReadonlyMap<ClaimId, Claim>;
  readonly materialBodies: ReadonlyMap<MaterialId, string>;
  readonly grouping: SourceGroupingSnapshot;
}

export interface ProfileData {
  readonly subjectId: SubjectId;
  readonly displayName: string;
  readonly versionId: VersionId;
  readonly claims: readonly Claim[];
  readonly quality: QualitySummary;
}

export interface RenderedProfile {
  readonly core: Readonly<Record<CoreFacetName, string>>;
  readonly domains: Readonly<Record<string, string>>;
  readonly markdown: string;
}

export interface ProfileDiff {
  readonly added: readonly Claim[];
  readonly removed: readonly Claim[];
  readonly changed: readonly {
    readonly before: Claim;
    readonly after: Claim;
  }[];
  readonly changedFacets: readonly FacetPath[];
  readonly beforeQuality?: QualitySummary;
  readonly afterQuality: QualitySummary;
}

export declare function validateFacetPath(path: string): FacetPath;
export declare function resolveEvidence(
  draft: EvidenceDraft,
  context: EvidenceContext,
): EvidenceRef;
declare function resolveHostPatch(
  patch: DistillPatch,
  context: EvidenceContext,
): ResolvedPatch;
declare function deriveClaimId(
  subjectId: SubjectId,
  draft: ResolvedClaimDraft,
): ClaimId;
declare function applyClaimPatch(
  base: readonly Claim[],
  patch: ResolvedPatch,
): readonly Claim[];
declare function buildMaterialEvidenceIndex(
  records: readonly MaterialRecord[],
  grouping: SourceGroupingSnapshot,
): MaterialEvidenceIndex;
export declare function deriveEvidenceStrength(
  claim: Claim,
  materials: MaterialEvidenceIndex,
): EvidenceStrength;
export declare function summarizeQuality(
  claims: readonly Claim[],
  materials: MaterialEvidenceIndex,
): QualitySummary;
export declare function renderFacet(
  facet: FacetPath,
  claims: readonly Claim[],
): string;
export declare function renderProfile(profile: ProfileData): RenderedProfile;
export declare function renderPrompt(profile: Profile): string;
export declare function diffProfiles(before: Profile, after: Profile): ProfileDiff;
~~~

这些函数不读存储、不调用模型、不持有 clock。MaterialEvidenceIndex 必须从同一个 SourceGroupingSnapshot 构建，summarizeQuality 把 index.sourceGroupingVersion 原样写入结果；缺少版本或 group snapshot / index 版本不等时 hard reject，不能使用进程当前默认值。相同输入必须字节稳定；排序键、换行与标题固定。DraftValidator、MaterialHasher、ProfileRenderer 不做无状态 class。

首版 renderer version 固定为 literal `profile-renderer-v1`。facet 的第一个 segment 若属于七个 core 就归入该 core，否则归入 domain root；FacetPath grammar 使 domain root 可直接作为 `domains/<root>.md` 的 safe filename。七个 core 的唯一顺序是 identity、voice、psyche、relations、boundaries、texture、timeline，domain root 与每组 ClaimId 都按 UTF-8 bytes 升序。superseded 不渲染；active 与 contested 分开且不可混排。

每条渲染 record 的 exact key set 是 `id,facet,strength,text,observedIn`，validFrom/validTo 只在存在时加入；对象和数组都用 §6.3 compact canonical JSON。claim text 因而总是 JSON string，换行、`#`、反引号、HTML 与 Markdown metacharacters 都被 JSON escape/包围，不能创建 renderer 结构。一个 root 的 exact section function 是：

~~~text
section(level, kind, root) =
  "#" * level + " " + kind + "." + root + "\n\n" +
  "#" * (level + 1) + " Active claims\n\n" +
  "    " + canonicalJson(activeRecords) + "\n\n" +
  "#" * (level + 1) + " Contested claims\n\n" +
  "    " + canonicalJson(contestedRecords) + "\n"
~~~

`activeRecords` 与 `contestedRecords` 是该 root、该 status 的 exact records，各按 ClaimId UTF-8 排序；空组写 literal `[]`。七个 core 文件分别是 `section(1,"core",name)`，每个 domain 文件是 `section(1,"domain",root)`。完整 profile.md 固定为 `"# Distilly profile\n\n## Core facets\n\n" + sevenCoreSectionsAtLevel3.join("\n") + "\n## Domain facets\n\n" + (domains.length === 0 ? "    []\n" : domainSectionsAtLevel3.join("\n"))`。所有 facet file、domain file 与 combined profile.md 尾部恰好一个 LF；不得加 BOM、行尾空格或第二个空行。

prompt 固定为下列拼接；subject metadata 是 exact key set `displayName,maturity,subjectId,versionId` 的 compact canonical JSON object，并放在四空格 indented code line 中。`profile.renderedWithoutFinalLf` 只移除 combined profile 的唯一尾 LF；renderPrompt 只接收完整 Profile，不读取 SubjectSummary/SubjectRecord：

~~~text
# Distilly simulation context

## Subject metadata

    <canonicalJson({displayName,maturity,subjectId,versionId})>

<profile.renderedWithoutFinalLf>

## Behavior constraints

- This is an evidence-bounded simulation, not the person.
- Do not invent facts that are not recorded.
- Preserve recorded boundaries and explicitly acknowledge contested claims.
~~~

prompt.md 尾部也恰好一个 LF。Profile.core/domains/rendered 与 `renderPrompt(Profile)` 是 deterministic version outputs；数据库保存它们的版本化语义或 digest，export/projection 可生成 profile/profile.md、七个 core、排序 domain 与 prompt.md。投影用 source LSN 原子发布完整一代；历史 export 永不从 mutable current subject displayName 重渲染。

### 13.5 Profile 与单真相

~~~ts
export interface Profile {
  readonly subjectId: SubjectId;
  readonly displayName: string;
  readonly versionId: VersionId;
  readonly claims: readonly Claim[];
  readonly core: Readonly<Record<CoreFacetName, string>>;
  readonly domains: Readonly<Record<string, string>>;
  readonly rendered: string;
  readonly quality: QualitySummary;
}
~~~

Profile.displayName 是 version-time SubjectRecord.displayName 快照，必须等于同 version 的 VersionRecord.subjectDisplayName；它和 claims/quality/rendered 一样不可从以后改名的 SubjectRecord 回填。Renderer 只添加上述固定标题、JSON records 与行为说明，不能新造人物判断。首版 prompt 注入整份 rendered，不按 strength 或所谓 salience 丢内容；contested claims 只出现在明确的 Contested claims 数组，不伪装成确定事实。

---
