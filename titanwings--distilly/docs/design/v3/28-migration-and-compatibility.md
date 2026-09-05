> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 28. Python、legacy import、存储与协议演进

### 28.1 旧产品线隔离

已发布 `dot-skill` 的 Python tools、prompts、生成样例与根 Skill 留在独立的 legacy maintenance branch；它们不复制到 `distilly-plugin`。当前分支只保留仓库构建所需的 Python 脚本，V3 prompt 资产位于 `packages/engine/prompts`，TypeScript 产品不 import 或 shell 调旧 writer。尚无已核验 Plugin binding 的宿主可以由用户明确选择该分支作为独立 Legacy Skill 兼容模式，但 Plugin/runtime 不自动取得、执行或注册它，也不把它计入原生宿主支持。未来迁移器只读取用户明确选择的旧导出或合成 fixture，不依赖当前源码树中存在旧实现。

### 28.2 LegacySkillMigrator

~~~ts
export interface MigrationProbe {
  readonly sourcePath: string;
}

export interface MigrationInput extends MigrationProbe {
  readonly targetSpaceId?: SpaceId;
}

export interface MigrationPlan {
  readonly planId: string;
  readonly sourceFormat: string;
  readonly subjects: readonly {
    readonly displayName: string;
    readonly materialCount: number;
    readonly claimCount: number;
  }[];
  readonly warnings: readonly string[];
  readonly unknownFields: readonly string[];
  readonly digest: ContentDigest;
}

export interface MigrationApplyInput {
  readonly plan: MigrationPlan;
  readonly confirmation: string;
}

export interface MigrationResult {
  readonly subjects: readonly SubjectSummary[];
  readonly reviews: readonly ReviewRef[];
}

export interface LegacyMigrator {
  readonly sourceFormat: string;
  canRead(input: MigrationProbe): Promise<boolean>;
  migrate(input: MigrationInput): Promise<MigrationPlan>;
  apply(input: MigrationApplyInput): Promise<MigrationResult>;
}

export declare class LegacySkillMigrator implements LegacyMigrator {
  readonly sourceFormat: string;
  canRead(input: MigrationProbe): Promise<boolean>;
  migrate(input: MigrationInput): Promise<MigrationPlan>;
  apply(input: MigrationApplyInput): Promise<MigrationResult>;
}
~~~

import 两阶段：

1. plan：读取真实 fixture，列主体、来源、目标 facets、未知字段以及将创建的 blob 与 product records；
2. apply：用户确认后把整份 plan 作为一个顶层 mutation / RequestId；先 put 需要的 blobs，再用一个 SQLite transaction 原子创建该 plan 的全部 subjects、versions、operations 与 events。任一 subject 失败则整份 apply 不可见，不做隐含部分成功，也不直接写 projection。

只支持 fixture 覆盖的 schema；没有 schema 或未知版本按明确 migration profile 处理或拒绝，不猜。work.md 职责进入 vocation domain，persona voice / texture / psyche 拆成有“legacy import”证据的 claims；无法恢复逐句来源时 strength 标 imported_unverified 并 suspended。

### 28.3 未发布的 V2/V3 存储不是兼容目标

V2 TypeScript 产品、文件事实版 V3 与 `~/.distilly/` 产品格式都从未发布；没有真实用户事实、公开版本或 remote ref 依赖它们。因此首个 SQLite storage schema 从 v1 开始，不为工作区实验代码建迁移器、dual-write 或兼容读取器。旧代码只作为删除与语义对照，不作为磁盘输入。

V1/V2 文档和旧 V3 commit 可从 Git 历史查看，用于理解哪些替代曾经成立，不作为实现要求。唯一真实 legacy 输入是已发布 dot-skill 的 `work.md` / `persona.md` / `SKILL.md`；它通过 §28.2 的用户确认 import，而不是 storage migration。

### 28.4 独立版本维度

| 版本 | 控制什么 | 兼容策略 |
|---|---|---|
| wireVersion | MCP / RPC 字段与判别语义 | major 不兼容直接拒绝 |
| storageSchemaVersion | SQLite schema 与约束 | 发布后才需要显式、备份后的 migration；未知拒绝 |
| blobLayoutVersion | digest preimage 与 content-addressed layout | immutable；新增版本不原地改旧 blob |
| projectionVersion | Library/search/graph/profile export shape | 可丢弃并从 authority 重建 |
| promptVersion | host distill instructions | 历史记录；变更 snapshot |
| bundleSchemaVersion | import / export / Catalog | 验签前先校验；独立升级 |

engineVersion、pluginVersion 是发布版本，不能替代这些兼容维度。

### 28.5 Additive 与 breaking

wire major 3 内允许：

- 新的可选输入字段；
- 新的结果字段；
- 明确可安全 default 的新 event kind；
- 新 engine method（不改变旧 method）。

必须升 major：

- 改字段含义或默认副作用；
- 删除 / 重命名工具、method、错误码；
- 把完整 briefing 改成分页但沿用同一判别形状；
- 改 EvidenceRef 引用对象；
- 允许调用方传 actor / id 等 engine-owned 字段。

产品发布后的 storage migration 只前向、显式、可 dry-run：先创建完整 backup，再在 SQLite transaction 中迁移 metadata，或在 sibling root 构造并全量验证后切换；不逐文件原地猜测升级。projection version 变化不迁移 authority，只重建。首发前的内部 schema 直接随实现替换，不积累假兼容层。

### 28.6 旧线退役条件

从独立的 `dot-skill` legacy 维护线退役旧实现，仍需同时满足：CLI / Plugin 覆盖已发布用户入口；migrator 对真实 legacy fixtures 全绿；fresh-install 与升级文档发布；用户有至少一个版本周期的迁移窗口；发布策略已明确。`distilly-plugin` 当前树不复制旧实现，不等于 legacy 维护线已经退役。

---
