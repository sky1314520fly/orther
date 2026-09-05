> 本章由 [system-v3.md](../system-v3.md) 生成，属于当前生效的目标合同；当前已发布行为以 [architecture.md](../../architecture.md) 为准。请只编辑父文件，然后运行 `python3 scripts/sync_design_chapters.py`。

## 7. 协议约定、基础类型、错误与校验边界

### 7.1 协议包的职责

@distilly/protocol 只拥有跨包或跨进程的产品词汇：

- 品牌 id、枚举和值类型；
- EngineMethodMap、EngineEvent、EngineClient 与窄的 EngineAdministrationClient；
- 五个 MCP 工具的精确 name/title/description、runtime/JSON schema 与 annotations；
- DistillyErrorCode 与 wire error；
- zod 边界 schema 和协议版本常量。

它不读存储、不启动网络、不依赖 MCP SDK、不包含业务 service，也不导入任何其它 Distilly 包。SQLite row、storage schema、blob metadata、projection watermark、GC state 与任何 journal/recovery record 都是 Engine-private，不能因为测试方便进入公共 Protocol。

### 7.2 品牌 id

~~~ts
declare const brand: unique symbol;
export type Branded<T, B extends string> =
  T & { readonly [brand]: B };

export type SubjectId       = Branded<`subject_${string}`, "SubjectId">;
export type SpaceId         = Branded<`space_${string}`, "SpaceId">;
export type MaterialId      = Branded<`mat_${string}`, "MaterialId">;
export type RawId           = Branded<`raw_${string}`, "RawId">;
export type ContentDigest   = Branded<`sha256_${string}`, "ContentDigest">;
export type ProvenanceDigest = Branded<
  `provenance_sha256_${string}`,
  "ProvenanceDigest"
>;
export type MaterialSetHash = Branded<`set_sha256_${string}`, "MaterialSetHash">;
export type VersionId       = Branded<`version_${string}`, "VersionId">;
export type JobId           = Branded<`job_${string}`, "JobId">;
export type LeaseId         = Branded<`lease_${string}`, "LeaseId">;
export type LeaseOwnerId    = Branded<
  `lease_owner_${string}`,
  "LeaseOwnerId"
>;
export type ClaimId         = Branded<`claim_${string}`, "ClaimId">;
export type RelationId      = Branded<`relation_${string}`, "RelationId">;
export type RequestId       = Branded<`req_${string}`, "RequestId">;
export type EventId         = Branded<`event_${string}`, "EventId">;
export type IsoDateTime     = Branded<string, "IsoDateTime">;
export type HostName        = Branded<string, "HostName">;
export type FacetPath       = Branded<string, "FacetPath">;
export type SourceGroupKey  = Branded<`sg_${string}`, "SourceGroupKey">;
export type CaptureAuditRef = Branded<`capture_${string}`, "CaptureAuditRef">;
export type CaptureScopeDigest = Branded<
  `capture_scope_${string}`,
  "CaptureScopeDigest"
>;
export type ConversationSourceKey = Branded<
  `conversation_${string}`,
  "ConversationSourceKey"
>;
export type BriefContractDigest = Branded<
  `brief_contract_${string}`,
  "BriefContractDigest"
>;

export const BUILTIN_HOSTS = {
  codex: "codex" as HostName,
  claudeCode: "claude-code" as HostName,
  openclaw: "openclaw" as HostName,
  hermes: "hermes" as HostName,
} as const;

export const BUILTIN_PEOPLE_SPACE_ID =
  "space_00000000000000000000000000000001" as SpaceId;
~~~

RequestId 的 wire form 固定为 `req_` + 32 位小写十六进制，即 128-bit caller-generated randomness；空值、大写 hex、额外字符、斜杠、反斜杠和点段都 invalid_input。Engine 在 operations 表中用它做全局唯一幂等键；它不是文件名或锁名。SDK helper 与 Host/MCP presenter 每次顶层 mutation 生成一个，重试复用同一值。LeaseOwnerId 的 wire form 固定为 `lease_owner_` + 32 位小写十六进制；它由 engine 在创建每个 ClientSessionContext 时生成，不是公开 method params，也不能从 actor id 派生。BUILTIN_PEOPLE_SPACE_ID 是唯一非随机 SpaceId，只能指向 §9.2 的 exact built-in record；其余 SpaceId 由 generator 生成并避开该值。IsoDateTime 只接受经有效日历校验的 UTC 毫秒 RFC 3339 canonical form `YYYY-MM-DDTHH:mm:ss.sssZ`；offset、缺毫秒、leap second 与无效日期都 invalid_input。HostName 是 1..64 位 ASCII lowercase slug，grammar 为 `[a-z][a-z0-9]*(?:-[a-z0-9]+)*`。FacetPath 总长 1..128，由点分的 ASCII lowercase segment 组成；每段长 1..32 且 grammar 为 `[a-z][a-z0-9_]*`。

运行时 schema 还要校验每个品牌 id 的前缀、长度和字符集。品牌只解决编译期混用，不替代边界校验。

跨方法共享的主体词汇也固定在 protocol，不让 Panel、CLI 与 MCP 各造一份近似类型：

~~~ts
export type SubjectLifecycle = "active" | "archived";

export type IdentityHint =
  | { readonly kind: "url"; readonly value: string }
  | {
      readonly kind: "account";
      readonly provider: string;
      readonly handle: string;
    }
  | {
      readonly kind: "external_id";
      readonly provider: string;
      readonly value: string;
    }
  | { readonly kind: "description"; readonly value: string };

export interface SpaceSummary {
  readonly id: SpaceId;
  readonly displayName: string;
  readonly kind: "people" | "fictional" | "custom";
}

export interface SubjectSummary {
  readonly id: SubjectId;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly identityHints: readonly IdentityHint[];
  readonly space: SpaceSummary;
  readonly lifecycle: SubjectLifecycle;
  readonly currentVersionId?: VersionId;
}

export type AmbiguousSubjectCandidates = readonly [
  SubjectSummary,
  SubjectSummary,
  ...SubjectSummary[],
];

export interface SubjectStatus {
  readonly subject: SubjectSummary;
  readonly generation: number;
  readonly materialSetHash?: MaterialSetHash;
  readonly pendingJobId?: JobId;
  readonly suspendedVersionId?: VersionId;
  readonly maturity?: Maturity;
}

export interface SubjectRef {
  readonly subjectId: SubjectId;
}

export type SubjectSelector =
  | { readonly kind: "id"; readonly subjectId: SubjectId }
  | {
      readonly kind: "query";
      readonly query: string;
      readonly spaceId?: SpaceId;
    };

export interface SubjectQuery {
  readonly text?: string;
  readonly spaceId?: SpaceId;
  readonly lifecycle?: SubjectLifecycle;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SubjectPage {
  readonly items: readonly SubjectSummary[];
  readonly nextCursor?: string;
}

export interface ResolveSubjectInput {
  readonly selector: SubjectSelector;
}

export type ResolveSubjectResult =
  | { readonly kind: "found"; readonly subject: SubjectSummary }
  | { readonly kind: "not_found" }
  | { readonly kind: "ambiguous"; readonly candidates: AmbiguousSubjectCandidates };

export interface PurgeSubjectInput extends SubjectRef {
  readonly confirmation: string;
}

export type PurgeResult =
  | {
      readonly subjectId: SubjectId;
      readonly logicalDeletion: "complete";
      readonly physicalDeletion: "complete";
    }
  | {
      readonly subjectId: SubjectId;
      readonly logicalDeletion: "complete";
      readonly physicalDeletion: "pending";
      readonly pendingBlobCount: number;
    };

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export const JSON_SCHEMA_DIALECT =
  "https://json-schema.org/draft/2020-12/schema" as const;

export const WIRE_LIMITS = {
  toolInputBytes: 4_194_304,
  labelBytes: 1_024,
  queryBytes: 4_096,
  uriBytes: 8_192,
  reasonBytes: 8_192,
  claimTextBytes: 16_384,
  quoteBytes: 65_536,
  correctionTextBytes: 16_384,
  materialContentBytes: 1_048_576,
  ingestMaterials: 32,
  smallArrayItems: 64,
  patchOperations: 256,
  evidencePerOperation: 64,
  openRecordEntries: 64,
  listLimit: 200,
} as const;

~~~

除 JsonObject 和类型中显式写出的开放 Record 外，所有 public object runtime schema 都拒绝 unknown keys，JSON Schema 递归使用 additionalProperties=false。所有整数必须是 safe integer；generation、count、index 与 locator 为非负数，limit 为 1..WIRE_LIMITS.listLimit。JsonValue 只允许可编码 JSON 的有限值，不接受 undefined、bigint、函数、symbol、非有限 number 或循环。

WIRE_LIMITS 的 string 上限按 UTF-8 bytes 计；必填模型字符串为非空，optional string 出现时也不能是空值。displayName、alias、provider/handle/externalId、domainPack、clientRef、title、language、author/participant、producer/version 和可见 label 用 labelBytes；query 用 queryBytes；URI 用 uriBytes；reason/review note/general notes 用 reasonBytes；claim text 用 claimTextBytes；evidence quote 用 quoteBytes；correction text 用 correctionTextBytes；每份 MaterialInput.content 用 materialContentBytes。correctionTextBytes 有意逐值等于 claimTextBytes=16,384，因为完整 correction 正文立即成为 replacement Claim.text 与其 full-body quote；它不能借 quoteBytes 的 65,536 上限绕过 claim schema。aliases、identityHints、authors、participants、supersedes、observedIn 与普通 evidence 数组最多 smallArrayItems；每批 ingest 最多 ingestMaterials，patch 最多 patchOperations，单个 operation 最多 evidencePerOperation，显式开放 Record 最多 openRecordEntries。一个完整工具输入的 canonical UTF-8 JSON 最多 toolInputBytes；超限在业务 service 之前 invalid_input，不由各入口自造更宽阈值。

schema 验证 raw wire value 后，引擎凡经 Unicode NFC、label trim、material-text-v1 或 WHATWG URL serialization 得到 canonical string，都必须对 canonical UTF-8 bytes 再应用原字段上限；raw value 合法但 canonical bytes 扩张超限仍返回 invalid_input。Engine-private storage 派生字段有自己的 storage schema 上限，不能反向扩大或收窄 public wire。

### 7.3 Wire envelope 与幂等

~~~ts
export const WIRE_VERSION = "3" as const;

export interface WireRequest {
  readonly wireVersion: typeof WIRE_VERSION;
  readonly requestId: RequestId;
}

export interface WireSuccess<T> {
  readonly ok: true;
  readonly wireVersion: typeof WIRE_VERSION;
  readonly value: T;
}

export interface WireFailure {
  readonly ok: false;
  readonly wireVersion: typeof WIRE_VERSION;
  readonly error: DistillyWireError;
}
~~~

所有写工具都要求 requestId。相同 requestId 与相同 trusted input checksum 重试返回相同结果；普通 mutation 的 preimage 是 method + canonical params + session actor，distill.brief/renew/release/**commit** 还含 session LeaseOwnerId，brief 再含 canonical BriefCapacity。相同 requestId 配不同 method、input、actor、lease owner 或 brief capacity 返回 idempotency_conflict。RequestId 本身不进入 inputChecksum。SDK 可以由客户端 helper 生成 requestId，但引擎不接受空值。

### 7.4 Actor 由入口派生

~~~ts
export interface ActorContext {
  readonly kind: "user" | "host" | "sdk" | "executor" | "system";
  readonly id: string;
  readonly host?: HostName;
}

export interface MutationContext {
  readonly requestId: RequestId;
}

export interface ClientSessionContext {
  readonly actor: ActorContext;
  readonly leaseOwner: LeaseOwnerId;
  readonly capacity?: BriefCapacity;
}
~~~

ActorContext、LeaseOwnerId 与 capacity 在创建 EngineClient 或完成 RPC/MCP 握手时由可信 composition 派生，不出现在 ingest / brief / renew / release / commit / correct 的模型参数中。每次 EngineClient session 必须使用不同的 engine-owned LeaseOwnerId；重连得到新 owner，不能借 actor id 或 caller label 继承旧 lease。PrivateUiCaptureContext 不属于 ClientSessionContext 或 protocol wire；它是 engine 在验证活跃 grant 后封装在一次性 capture session 内的私有状态，普通 EngineRuntime.connect、MCP tool input、聊天正文和公开 SDK 都不能构造、cast 或重放它。普通 SDK 固定为 sdk，CLI / Panel 的直接动作由它们自己的入口绑定 user，MCP 固定为 host，后台 worker 固定为 executor；这些 client 都不获得 storage capability。

MCP correct 仍记录真实 actor=host。它可以记录“宿主转述了用户原话”的 correction provenance，但不能冒充直接 user 动作。普通 SDK 的 Person.correct 同样记录 actor=sdk，而不是把 SDK 调用者猜成 user。CorrectionService 对所有非 user actor 写 relayed provenance、加入 relayed_correction reason 并 suspended；只有 Panel / CLI 的明确 correct、promote、reject 操作能记录 actor=user。actor 是审计来源，不代替 Engine session 授权或数据库访问边界。

### 7.5 错误码

~~~ts
export type DistillyErrorCode =
  | "invalid_input"
  | "not_found"
  | "already_exists"
  | "ambiguous_subject"
  | "idempotency_conflict"
  | "nothing_pending"
  | "lease_conflict"
  | "lease_expired"
  | "stale_job"
  | "briefing_too_large"
  | "evidence_invalid"
  | "context_too_large"
  | "review_conflict"
  | "busy"
  | "storage_corrupt"
  | "schema_unsupported"
  | "index_unavailable"
  | "host_unsupported"
  | "adapter_failed"
  | "permission_denied"
  | "internal_error";

interface DistillyWireErrorBase {
  readonly message: string;
  readonly retryable: boolean;
  readonly fieldPath?: string;
  readonly remediation?: string;
  readonly details?: JsonObject;
}

export type DistillyWireError =
  | (DistillyWireErrorBase & {
      readonly code: "already_exists";
      readonly subjectResolution: {
        readonly kind: "found";
        readonly subject: SubjectSummary;
      };
    })
  | (DistillyWireErrorBase & {
      readonly code: "ambiguous_subject";
      readonly subjectResolution: {
        readonly kind: "ambiguous";
        readonly candidates: AmbiguousSubjectCandidates;
      };
    })
  | {
      readonly code: "internal_error";
      readonly message: string;
      readonly retryable: false;
      readonly fieldPath?: never;
      readonly remediation?: never;
      readonly details?: never;
      readonly subjectResolution?: never;
    }
  | (DistillyWireErrorBase & {
      readonly code: Exclude<
        DistillyErrorCode,
        "already_exists" | "ambiguous_subject" | "internal_error"
      >;
      readonly subjectResolution?: never;
    });
~~~

not_found、ambiguous_subject 和 nothing_pending 在有对应判别结果的工具 action 里不是 transport error；同一状态在 SDK 的直接方法里可以成为 DistillyError。但 ingest(create) 的唯一 identity 冲突是 already_exists WireFailure，必须带一个 found subject；同空间多候选是 ambiguous_subject WireFailure，必须带至少两个 candidates。MCP handler 不把这些预期业务分支伪装成服务器崩溃，也不把 candidate 藏在无类型 details。

错误 message 给人读，code 给程序分支。code 在 wire major 3 内只加不改；details 只能是 JsonObject，不能包含材料正文、secret 或绝对内部路径。`internal_error` 只供 transport / presenter 把真正未分类的实现异常归一成最后一道、脱敏的 WireFailure：固定 retryable=false，details/fieldPath/remediation/subjectResolution 均缺失，也不带原异常 message、stack、路径或输入内容。已知的 schema、domain、storage、host 和 adapter 失败必须保留更窄 code，不能为了少写分支统一降成 internal_error。

### 7.6 八道运行时校验边界

| 边界 | 校验内容 | 失败 |
|---|---|---|
| MCP / 模型工具输入 | wireVersion、判别字段、id、长度、枚举 | invalid_input |
| HTTP / 未来 daemon RPC | 与 EngineMethodMap 对应的 params | invalid_input |
| ingest material | 来源必填规则、正文大小、时间、URI、路径逃逸 | invalid_input / adapter_failed |
| private capture ingest | 可信 session、subject-target/scope digest、expiry、computer_use_transcript、一次性状态 | permission_denied / invalid_input |
| pending brief / commit | job、generation、lease、brief contract、base、集合 hash | lease_* / stale_job / schema_unsupported |
| claim patch | operation、facet、目标 claim、证据集合、quote | invalid_input / evidence_invalid |
| Engine storage read | query 直接使用的 row/foreign key/canonical id 与 blob digest | schema_unsupported / storage_corrupt |
| 配置读取 | 已知字段、类型、secret reference | invalid_input |
| 插件 / bundle / adapter 输入 | manifest、bundle 签名、第三方产物 | host_unsupported / adapter_failed |

同进程、类型已知的 service 调用不重复套 schema；纯函数依靠类型与 focused tests。所有外部字符串先校验再用于路径。

distill.commit 的错误优先级先走唯一外部 wire/runtime schema：method envelope、id/enum、patch canonical bytes、结构、局部 date range 与 locator `start < end` 任一不合法都立即 `invalid_input`，不得为优先级另造一套宽松 pre-parser。边界合法后依次处理同 RequestId replay/conflict、active suspended=`review_conflict`、job/generation/base/material set/echoed digest=`stale_job`、matching job 下 lease 缺失或 id/owner 不符=`lease_conflict`、`now >= expiresAt`=`lease_expired`、pinned grouping/draft 实现不可用=`schema_unsupported`；再处理依赖 verified facts 的 patch target/cycle=`invalid_input` 与 evidence ref/membership/quote/locator=`evidence_invalid`，最后才是 fact schema/storage 错误。每个失败都返回这个最窄 code；不得把 stale、lease、unsupported 或 evidence 问题统一包装成 invalid_input。除 exact completed/terminal replay 外，这些失败都零写入并保留 pending/lease。

---
