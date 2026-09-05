> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 9. 主体、空间与身份解析

### 9.1 主体 id 由引擎生成

~~~ts
export interface CreateSubjectInput {
  readonly displayName: string;
  readonly spaceId?: SpaceId;
  readonly space?: {
    readonly displayName: string;
    readonly kind: "people" | "fictional" | "custom";
  };
  readonly aliases?: readonly string[];
  readonly domainPack?: string;
  readonly identityHints?: readonly IdentityHint[];
}
~~~

调用方不提供 subjectId，也不决定 storage key。引擎生成不可变 id；displayName 与别名可变，改名不会使 EvidenceRef、关系或安装记录失效。

### 9.2 空间规则

- 真实人物缺省进入保留的 `BUILTIN_PEOPLE_SPACE_ID = "space_00000000000000000000000000000001"`；该 id 只接受 exact `{ id: BUILTIN_PEOPLE_SPACE_ID, displayName: "People", kind: "people" }` row。
- fictional 必须明确作品或世界空间；不能默认和真实人物混在一起。
- custom 空间由 SDK / Panel 创建，MCP create target 可以在同一次请求创建空间。
- 同名只在同一空间内构成歧义；跨空间查询必须显式允许。
- 关系默认不跨空间，跨空间 link 需要用户明确操作。

people bootstrap 在 SQLite transaction 内以保留 id insert-or-verify exact row；任一字段不同都是 storage_corrupt，不会换一个随机 people space。inline space 以 `(kind, canonical display label)` 的数据库唯一约束解析或创建，Library/search projection 只能加速候选，不能决定存在性。

`label-v1` 是唯一的 displayName / alias canonicalization：Unicode NFC，只移除首尾连续的 U+0009 / U+000A / U+000D / U+0020，保留大小写与内部 bytes；结果为空则 invalid_input。aliases 分别用同一函数，按 canonical UTF-8 bytes 去重、升序并存储。首版不 case-fold、不 fuzzy match、不压缩内部空白；规则升级必须用新版本，不静默改旧事实。

### 9.3 解析流程

normalize query → 精确 id / 别名 → provider-scoped identityHint → 同空间名称 → 候选列表。

结果只能是 found / not_found / ambiguous。候选排序可以使用精确命中、别名和身份 hint，但**阈值不能把多个候选压成一个**。模型看到 ambiguous 必须展示至少 displayName、space、identity hints。description 只用于展示与候选排序，永不参与唯一命中、already_exists 或合并；材料 URI 也不会因为“看起来像主页”就自动升级为身份 hint，只有显式创建、用户确认或受信 adapter resolve 才能写入。

identity locator 的 normalization 是版本化纯函数：URL 必须是绝对 http(s)，按 WHATWG 规则小写 scheme/host、移除 default port、fragment 和 dot segments，但不猜测 tracking query；provider id 统一 ASCII lowercase；externalId 做 Unicode NFC 后保持 opaque exact；handle trim + NFC，只有内置 provider table 明确声明 case-insensitive 时才 case-fold，未知 provider 保留大小写。`identity-locator-v1` 的 case-insensitive provider table 明确为空，所以首版所有 handle 都保留大小写；以后增加 provider 必须提升该规则版本并补迁移/兼容 fixture，不能静默改变旧事实判等。URL/account/external_id 分别按 canonical 值判等，不跨 kind 猜关联。

### 9.4 原子创建与重复

模型路径只有 ingest(create)。引擎先用 label-v1 和版本化 identity-locator 函数规范化 create target。进入 create/ingest 的唯一 SQLite transaction 后，按固定顺序重新检查：

- RequestId 已成功：返回 stored result；
- 任一 exact canonical url/account/external_id locator 命中唯一主体：already_exists，并在 typed subjectResolution 返回该 subject；同一 locator 关联多个主体是 storage_corrupt；
- 没有 exact locator 时，按 exact canonical displayName 或 alias 收集候选。如果候选在 target 也提供的某个 locator kind 上已有可证明的不同 canonical value，排除该候选；未提供该 kind 不算冲突；
- 排除后恰好一个候选：保守返回 already_exists 与该 subject，remediation 要求改用 existing target 或补充可区分 locator；
- 排除后两个以上候选：ambiguous_subject，并返回稳定排序 candidates；
- 无冲突：同一 transaction 插入 subject、第一批 material references、generation/job、operation 与 events。

description 永不参与唯一性、already_exists 或合并。space/locator/name 的 unique index 和事务内重查处理两个并发 create；不再为 candidate id、space catalog、identity 或 subject 建文件锁。

create target 在 normalization 后预分配 candidate SubjectId；只有 transaction 成功才可见。相同 RequestId 的重试由 operations row 返回同一个 SubjectId；失败或 conflict 不产生空主体。private capture 的 subject fallback 可以在 blob/MaterialId 计算前使用这个 candidate id，而数据库仍原子提交“主体 + 第一批材料”。

SQLite create/ingest foundation 同时落地独立 `subjects.create` 与 `materials.ingest`。两者复用 package-private、transaction-local 的 space / identity create primitive；`materials.ingest(create)` 永不经 EngineClient 或公开 `subjects.create` 串联第二个 mutation，而是在自己的单一 transaction 内直接创建主体与第一批材料，因此任何失败都不会留下空主体。

`canonicalizeIngestSubjectTarget` 负责把省略的 space 解释为内置 people、对 aliases / identityHints 去重并按 canonical bytes 排序，再生成授权 session 内存中的 target snapshot。capture grant 后 displayName、space、aliases、domainPack 或任一 locator 的语义变化都必须重新授权；数组顺序变化不算变化。
### 9.5 生命周期

archive 从默认列表、搜索和 Recall 中隐藏主体，但保留事实与血缘。purge 物理删除主体内容，只能由 Panel / CLI 的显式危险动作触发，不给模型工具。

self 只是在首次 setup 时可选创建的普通主体；不能用它绕过空间、证据或隐私规则。

---
