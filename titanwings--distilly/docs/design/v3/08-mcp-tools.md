> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 8. 模型面的五个 MCP 工具

### 8.1 公共规则

五个名字固定：

~~~text
distilly_get
distilly_ingest
distilly_pending
distilly_commit
distilly_correct
~~~

不能为了内部 API 更“优雅”增加 create、flush、research、collect 或 briefing 工具。create 是 ingest 的 subject target；flush 是 enqueue now；briefing 是 pending 的 action。需要凭据的 SourceAdapter collection 是 CLI / Panel 的直接用户动作，模型可以提示用户打开该入口，但不能代替用户确认、取得 secret 或调用一个隐藏的 collect 工具。

模型工具只覆盖当前人物闭环，不承担全库管理、市场浏览、批量 purge、关系图编辑或安装器管理。那些能力属于 SDK、CLI 或 Panel。

### 8.2 distilly_get

~~~ts
export type GetToolInput =
  | (WireRequest & {
      readonly action: "resolve";
      readonly subject: SubjectSelector;
    })
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
  | (WireRequest & {
      readonly action: "status";
      readonly subject: SubjectSelector;
    });

export type GetToolValue =
  | {
      readonly kind: "resolved";
      readonly subject: SubjectSummary;
    }
  | { readonly kind: "profile"; readonly subject: SubjectSummary; readonly profile: Profile }
  | { readonly kind: "prompt"; readonly subject: SubjectSummary; readonly prompt: string }
  | { readonly kind: "status"; readonly subject: SubjectSummary; readonly status: SubjectStatus }
  | { readonly kind: "not_found"; readonly query?: string }
  | {
      readonly kind: "ambiguous";
      readonly candidates: AmbiguousSubjectCandidates;
    };
~~~

query 只解析，不隐式创建。只有 profile / prompt 允许 versionId；resolve / status 携带 versionId 或任何 action 携带该分支未声明的 key 都 invalid_input，不得忽略。profile / prompt / status 在 selector 多候选时同样返回 ambiguous；模型必须询问用户。prompt 返回完整 current profile 投影，超宿主限制显式 context_too_large。

### 8.3 distilly_ingest

~~~ts
export type IngestSubjectTarget =
  | {
      readonly kind: "existing";
      readonly subjectId: SubjectId;
    }
  | {
      readonly kind: "create";
      readonly input: CreateSubjectInput;
    };

export type SourceMedium =
  | "article" | "webpage" | "post" | "video" | "audio"
  | "image" | "document" | "conversation" | "other";

export type SourceRole =
  | "first_party_expression"
  | "interview"
  | "editorial_reporting"
  | "reference"
  | "personal_communication";

export type SourceAccess = "public" | "restricted" | "private";

export type ArtifactLocator =
  | {
      readonly provider: string;
      readonly externalId: string;
      readonly canonicalUri?: string;
    }
  | {
      readonly provider: string;
      readonly externalId?: string;
      readonly canonicalUri: string;
    };

export type HostExtractionMethod =
  | "document_text"
  | "ocr"
  | "embedded_caption"
  | "automatic_caption"
  | "transcription"
  | "computer_use_transcript";

export type TextDerivationInput =
  | { readonly kind: "native_text" }
  | {
      readonly kind: "host_extract";
      readonly method: HostExtractionMethod;
      readonly producer: string;
      readonly producerVersion?: string;
      readonly language?: string;
    };

export interface MaterialSourceInput {
  readonly uri?: string;
  readonly title?: string;
  readonly medium: SourceMedium;
  readonly access: SourceAccess;
  readonly role?: SourceRole;
  readonly artifact?: ArtifactLocator;
  readonly representationOf?: ArtifactLocator;
  readonly capturedAt: IsoDateTime;
  readonly occurredAt?: IsoDateTime;
  readonly publishedAt?: IsoDateTime;
  readonly language?: string;
  readonly authors?: readonly string[];
}

export interface MaterialInput {
  readonly clientRef: string;
  readonly kind:
    | "web" | "document" | "message" | "email"
    | "transcript" | "derived_text";
  readonly content: string;
  readonly source: MaterialSourceInput;
  readonly derivation: TextDerivationInput;
  readonly participants?: readonly string[];
  readonly sensitivity?: "private" | "shareable";
  readonly flags?: readonly "suspicious_source"[];
}

export interface IngestToolInput extends WireRequest {
  readonly subject: IngestSubjectTarget;
  readonly materials: readonly MaterialInput[];
  readonly enqueue: "auto" | "now";
}

export interface IngestItemResult {
  readonly clientRef: string;
  readonly kind: "accepted" | "duplicate";
  readonly materialId: MaterialId;
  readonly contentDigest: ContentDigest;
}

export type IngestResult =
  | {
      readonly kind: "ingested";
      readonly subject: SubjectSummary;
      readonly created: boolean;
      readonly items: readonly IngestItemResult[];
      readonly materialSetHash: MaterialSetHash;
      readonly generation: number;
      readonly job?: PendingJob;
    }
  | {
      readonly kind: "unchanged";
      readonly subject: SubjectSummary;
      readonly items: readonly IngestItemResult[];
      readonly materialSetHash: MaterialSetHash;
      readonly generation: number;
      readonly job?: PendingJob;
    };

export type IngestToolValue = IngestResult;
~~~

materials 至少一项。create 与第一批 ingest 按 §9.4 在同一个 SQLite transaction 中完成；identity unique constraint 与 transaction-time conflict check 防止重复主体，任何材料校验失败时不留下空主体。web 必须有绝对 http(s) URI；默认 sensitivity = private。

enqueue = now 在整批 dedup 后按**完整集合**判断：如果集合相对 current 或最后 committed generation 有变化，就返回已存在或新建的 job，即使本批 items 全是 duplicate；这是领取尚未蒸馏集合，不是空作业。只有集合已经 committed 且没有 pending 时，才返回不带 job 的 unchanged。

### 8.4 distilly_pending

~~~ts
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
~~~

action 与成功结果是封闭映射：list 有至少一个 job 时返回 jobs，空列表返回 nothing_pending；brief 返回 briefing，目标已不再 pending 时返回 nothing_pending；renew 只返回 lease_renewed；release 只返回 released。lease owner、expiry、stale 与 schema 问题仍是 WireFailure，不伪装成其它 success kind。brief 是一次写操作，因为它认领 lease；因此整个 distilly_pending 工具不能标 readOnly。list 不返回材料正文。release 只释放当前调用者持有的 lease，不删除 job。

### 8.5 distilly_commit

~~~ts
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
  | {
      readonly kind: "current";
      readonly version: VersionSummary;
      readonly profile: Profile;
    }
  | {
      readonly kind: "suspended";
      readonly candidate: VersionSummary;
      readonly currentVersionId?: VersionId;
      readonly reasons: readonly ReviewReason[];
      readonly review: ReviewLaunch;
    };
~~~

工具输入没有 actor、claim id、profile confidence、version id 或 Markdown。briefContractDigest 只回显 briefing / lease 固定的合同摘要，不能让模型选择算法。重复 requestId + 相同 patch 返回相同版本；lease、brief contract、generation 或集合过期返回错误，不创建 candidate。

### 8.6 distilly_correct

~~~ts
export interface CorrectToolInput extends WireRequest {
  readonly subjectId: SubjectId;
  readonly text: string;
  readonly facet?: FacetPath;
  readonly supersedes?: readonly ClaimId[];
  readonly baseCandidateVersionId?: VersionId;
}

export interface CorrectToolValue {
  readonly kind: "suspended";
  readonly candidate: VersionSummary;
  readonly currentVersionId?: VersionId;
  readonly reasons: readonly ReviewReason[];
  readonly review: ReviewLaunch;
}
~~~

skill 只能在用户明确纠正人物事实时调用，不把模型自己的猜测包装成 correction。text 经 material-text-v1 后以完整规范化正文落盘；facet 缺省 corrections.unassigned。MCP actor 始终是 host，因此 CorrectionService 必须让该工具只返回 suspended，并带 relayed_correction；presenter 只把 ReviewRef 变成 ReviewLaunch，不能改变提交结果。用户在 Panel / CLI 确认或直接 correction 后才有 user actor。baseCandidateVersionId 只用于修正当前 active suspended target。

### 8.7 工具 annotations 与展示

每个 handler 的最终结果都使用 wire envelope；不能返回既不是 success、也不是 failure 的第三种 JSON：

~~~ts
export type GetToolOutput = WireSuccess<GetToolValue> | WireFailure;
export type IngestToolOutput = WireSuccess<IngestToolValue> | WireFailure;
export type PendingToolOutput = WireSuccess<PendingToolValue> | WireFailure;
export type CommitToolOutput = WireSuccess<CommitToolValue> | WireFailure;
export type CorrectToolOutput = WireSuccess<CorrectToolValue> | WireFailure;

export type JsonSchemaObject = JsonObject & {
  readonly $schema: typeof JSON_SCHEMA_DIALECT;
};

export interface McpToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface McpToolContract<Name extends string, Input, Output> {
  readonly name: Name;
  readonly title: string;
  readonly description: string;
  readonly input: RuntimeSchema<Input>;
  readonly output: RuntimeSchema<Output>;
  readonly inputSchema: JsonSchemaObject;
  readonly outputSchema: JsonSchemaObject;
  readonly annotations: McpToolAnnotations;
}

export declare const distillyMcpTools: readonly [
  McpToolContract<"distilly_get", GetToolInput, GetToolOutput> & {
    readonly title: "Read local person memory";
    readonly description: "Resolve a local subject or read its saved profile, prompt, or status.";
    readonly annotations: {
      readonly readOnlyHint: true;
      readonly destructiveHint: false;
      readonly idempotentHint: true;
      readonly openWorldHint: false;
    };
  },
  McpToolContract<"distilly_ingest", IngestToolInput, IngestToolOutput> & {
    readonly title: "Store local source material";
    readonly description: "Store supplied text and provenance for an existing or new local subject.";
    readonly annotations: {
      readonly readOnlyHint: false;
      readonly destructiveHint: false;
      readonly idempotentHint: true;
      readonly openWorldHint: false;
    };
  },
  McpToolContract<"distilly_pending", PendingToolInput, PendingToolOutput> & {
    readonly title: "Manage local distillation jobs";
    readonly description: "List local pending jobs or brief, renew, or release a distillation lease.";
    readonly annotations: {
      readonly readOnlyHint: false;
      readonly destructiveHint: false;
      readonly idempotentHint: true;
      readonly openWorldHint: false;
    };
  },
  McpToolContract<"distilly_commit", CommitToolInput, CommitToolOutput> & {
    readonly title: "Commit local distilled claims";
    readonly description: "Validate and commit an evidence-bounded claim patch to local profile memory.";
    readonly annotations: {
      readonly readOnlyHint: false;
      readonly destructiveHint: false;
      readonly idempotentHint: true;
      readonly openWorldHint: false;
    };
  },
  McpToolContract<"distilly_correct", CorrectToolInput, CorrectToolOutput> & {
    readonly title: "Correct local person memory";
    readonly description: "Store a relayed correction and open local review for its candidate version.";
    readonly annotations: {
      readonly readOnlyHint: false;
      readonly destructiveHint: false;
      readonly idempotentHint: true;
      readonly openWorldHint: false;
    };
  },
];
~~~

get 的 action 与 success kind 必须匹配：resolve→resolved、profile→profile、prompt→prompt、status→status；四个 action 均可返回 not_found / ambiguous。zod 用 action 建判别 schema，不接受空的“found”。handler 映射固定为 resolve→subjects.resolve；profile / prompt / status 先 resolve，再调 profiles.get / profiles.prompt / profiles.status；ingest→materials.ingest；pending 四 action 分别调 distill.pending / brief / renew / release；commit→distill.commit；correct→profiles.correct。create ingest 不得拆成 subjects.create + materials.ingest。commit / correct 的 presenter 只把 ReviewRef 换成 ReviewLaunch。MCP SDK 的 transport envelope 再包这份 structured value 时，presenter 仍保持该结构不变。

| 工具 | readOnlyHint | destructiveHint | idempotentHint | openWorldHint | 原因 |
|---|---:|---:|---:|---:|---|
| distilly_get | true | false | true | false | 只读取本地资料 |
| distilly_ingest | false | false | true | false | 追加本地事实与队列，requestId 幂等 |
| distilly_pending | false | false | true | false | brief / renew / release 会写 lease，requestId 幂等 |
| distilly_commit | false | false | true | false | 追加版本并更新 current / suspended，保留历史 |
| distilly_correct | false | false | true | false | 追加 correction 与版本，保留历史 |

distillyMcpTools 是 tools/list 与 handler 的唯一 descriptor source，顺序固定为 get、ingest、pending、commit、correct。input/output RuntimeSchema 与 draft-2020-12 JSON Schema 由同一 schema source 导出，根 schema 携带 JSON_SCHEMA_DIALECT；CI snapshot 完整 name、title、description、inputSchema、outputSchema 与四个 hints，不允许手写两份漂移。title / description 只陈述本地读取、材料保存、lease、commit 与 correction，不宣称工具会上网 research 或自行取得原文。任何工具都不直接发布互联网内容。以后 Profile Catalog publish 也不塞进这五个工具。

---
