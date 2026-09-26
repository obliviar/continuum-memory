# 图关系开发：样例、校验、种子检索与受限多跳召回

> **更新后请先读本节。** 权威 L2 类型以 `domain/relation-types.ts` 为准，存储使用上游新增的独立 `GraphRelationRepository`。下文第 1–5 步中的 `causal / contributes-to / before`、组合 bundle、assertion/status/support 字段属于旧样例与内部召回投影，不是当前 L2 持久化格式；它们已隔离到 `domain/recall-types.ts`，不可直接发布为 L2 快照。

## 与更新后的 L2 分支对齐

| 部分 | 当前约定 |
| --- | --- |
| 权威记录 | `GraphRelationRecord` 只来自 relation-types，保留 polarity、modality、assertionBasis、candidateId、nliObservationIds |
| 权威关系类型 | entails、contradicts、causes、precedes、explains；不将 contributes-to 自动改成 explains |
| L1 读取 | 原 `GraphReadView`，保留新版 resolveStatements 和层次版本参数，不向它添加权威 L2 存储职责 |
| 召回读取 | 新 `GraphRecallReadView` / `GraphRecallReadPort`；通过 `createL2GraphRecallAdapter` 组合精确 L1 与 L2 视图 |
| 旧样例 | `createInMemoryGraph` 与 `GraphRecallFixtureBundle` 仅用于既有流程回归；组合 revisions.relations 不影响真实 L1 版本协议 |
| 写入 | 复用上游 CAS 发布、加密持久化、candidateRevision/relationRevision 和 purge；召回适配器没有发布或迁移写入逻辑 |

`ports/graph-recall-ports.ts` 定义召回专用端口及扩展候选入口。原先直接从 graph-ports 导入扩展种子类型的调用方，应改用此文件；权威 L1 和 L2 的端口分别继续使用 graph-ports / graph-relation-ports。`GraphRelationEdge` 现在专指新版 L2 的 kind: relation / relationKind / relation 字段；内部适配边另名 GraphRecallRelationEdge，不再冲突导出。

### 新版读取的接入方式

```ts
const ports = createL2GraphRecallAdapter({
  coreReadPort,             // 真实且持续检查授权的 L1 读取端口
  relationReadPort,         // createGraphRelationReadPort(...)，绑定新版关系仓库
  coreEvidenceReader,      // 精确 V4 事实与 L1 来源
  readRelationSources,     // 宿主读取精确的 L2 关系来源片段，并验证删除/访问策略
  countTokens,             // 真实 tokenizer；对 L1 + L2 证据统一累计
  searchSeeds,             // 可选：宿主的问题候选检索，签名见适配器类型
})
const service = createBoundedGraphRecall(ports)
const result = await service.recallQuery({
  recallId: 'l2-query',
  query: '张三为什么没有上班？',
  view: {
    ...openRequest,
    expectedManifestId: currentCoreManifestId,
    expectedRelationManifestId: currentRelationManifestId,
  },
})
```

必须明确传入 expectedRelationManifestId，才能使用该适配器；不会自动挑选“最新”快照。query 规划见到此字段后使用新版类型：原因/后果只选择 causes，先后选择 precedes，related 可覆盖五类。explains 不是 causes 的同义词；需要解释关系时由宿主显式选择。无此字段时仍兼容旧样例的三类名称；L2 适配器拒绝旧名称，避免悄悄改变语义。

`searchSeeds(request, coreView, relationView)` 是宿主提供的**问题召回种子接口**，应处理身份约束、候选上限和输入的精确入口。它不是上游用于生成待审核关系的 selectGraphRelationPairSeeds 或 GraphRelationCandidatePort；不能把待审核候选直接当成答案事实。不提供 searchSeeds 时可使用指定 Claim 的 recall；recallQuery 明确返回不支持，直到宿主接好问题检索。此次没有接入真实 V4 Worker、模型进程或聊天 Runtime。

### 资格与语义边界

- 权威关系先由新版读取端口完成精确版本、授权与来源检查；召回再读取精确 L1 端点，仅允许可用于直接事实回答的记录。
- 当前直接事实遍历只使用已采纳、positive、asserted 且有效时间已知的关系。negative causes 不代表 causes；hypothetical/planned/reported 或未知时间记录不会被改写成肯定事实。它们可以留在权威仓库，需后续独立消费策略。
- entails 保持来源声称的蕴含关系，不自动执行传递证明；precedes 不当作 causes；explains 不当作因果事实。
- contradicts 在遍历和路径校验中按对称关系处理，仍保留权威记录原始端点顺序。答案包新增 relationDisputes，引用已读取的显式矛盾关系及双方命题；它与 exact-opposite-polarity-v1 的 disputes 分开，不能假装做过全局语义矛盾搜索。
- 查询只召回 causes 时，不会额外遍历所有 contradicts；精确反向断言检查依旧执行。需要显式矛盾关系时选择该类型；未选择不代表不存在矛盾关系。
- 原始 L2 记录保存在召回关系和答案关系的 authoritativeRecord；候选和 NLI 观察不会单独出现在返回关系集合中。旧 assertion/status/support 只是内部可消费状态，不回写权威记录。

### 版本、预算与失效

成功结果及 evidencePack 都携带 relationManifest，包括 coreManifestId、relationRevision 和 candidateRevision。每次读取与最终证据核验都检查 L1/L2 仍然有效；L1 关闭、L2 失效、manifest 变化或来源删除会中止读取。上游目前按完整 manifest 固定视图，因此即使只有 candidateRevision 变化，旧打开视图仍会失效；不会把旧、新候选快照混读。

L2 来源可能不属于任何 L1 Claim，所以通过显式的 readRelationSources 读取；适配器只允许读取已解析关系登记的精确片段。它不会利用关系引用扩大到任意原文全文。宿主仍须实现真实来源验证与安全读取，测试中的回调不能直接用作生产授权。

节点通过同一个 L1 视图计费；适配器对 L1/L2 读取的证据文本统一累计 token。L2 邻接读取修复为视图级累计 maxEdges，maxScanned 仅限制单页；不能跨起点或重放查询刷新边预算。多跳服务仍负责深度限制。图投影当前仍在读取时重建候选，尚未优化大图性能。

本次不改变上游 CAS 发布、加密快照、权威版本不可重写及 purge 规则。真实持久化的密钥保护、来源校验和生命周期事件仍由宿主提供。下文历史步骤描述旧样例的实现过程；接入当前分支时使用本节的新 L2 路径。

在已有类型和接口上，提供可重复的样例、一致性校验、固定快照的内存读取视图、本地种子检索，以及多个起点的单跳与受限多跳召回。可以从自然语言问题匹配候选命题，并补充宿主已解析的 Claim、实体和关系引用入口；之后按关系类型和方向读取相邻命题、事实文本和原文。多跳接口根据查询计划按固定关系类型与方向扩展，记录路径，并检查精确正反断言冲突、整理多个直接原因候选，输出带引用和检查缺口的回答证据包。尚未实现持久化写入、通用语义查询规划、完整语义矛盾判断、自动关系抽取或聊天接入。

## 文件与用途

| 文件 | 作用 |
| --- | --- |
| `fixtures/fever-absence.ts` | 创建虚构的命题、关系、来源及事实版本；不读取或写入用户记忆 |
| `domain/validation.ts` | 检查 Claim/Relation 数据及对应投影边的一致性，返回错误代码和字段路径 |
| `domain/validation.test.ts` | 用正常及故意破坏的数据验证检查行为 |
| `projection/adjacency-index.ts` | 从语义关系边建立入边、出边索引，支持按方向和类型查邻居 |
| `repository/in-memory-graph.ts` | 实现直接关系读取及视图内的 `GraphSeedPort`，统一检查查询资格和预算 |
| `repository/in-memory-graph.test.ts` | 验证读取链路、方向、时间、权限、撤销、分页和预算 |
| `recall/one-hop-recall.ts` | 兼容入口：复用统一服务，保持最多一跳的原有行为 |
| `recall/graph-recall-service.ts` | 共用查询规划、证据读取与按起点执行的广度优先遍历，输出路径及中断状态 |
| `recall/bounded-graph-recall.ts` | 新入口：按请求的 maxHops 启用受限多跳 |
| `recall/bounded-graph-recall.test.ts` | 验证深度、环路、汇合、多起点路径、预算与中间记录资格 |
| `domain/claim-conflicts.ts` | 定义精确命题键、正反极性以及共同有效时间的冲突规则 |
| `recall/conflict-check.ts` | 分页查询反向断言并读取证据，记录已检查、未完成与不支持状态 |
| `recall/causal-alternatives.ts` | 按目标整理直接原因候选，合并重复支持并标记覆盖范围 |
| `recall/conflict-check.test.ts` | 验证冲突资格、分页、预算、证据完整性和多个原因候选 |
| `recall/answer-evidence.ts` | 将命题、关系、路径、冲突与来源装配成可引用的回答证据包 |
| `recall/answer-evidence.test.ts` | 验证引用完整性、争议沿路径传递、检查缺口与不完整数据拒绝 |
| `recall/one-hop-recall.test.ts` | 验证一跳边界、证据去重、预算中断和完整性标记 |
| `recall/lexical-seeds.ts` | 复用已有 BM25 索引，提供日期与部分否定表达过滤、词面候选排序 |
| `recall/query-recall.test.ts` | 验证自然语言候选定位、同视图扩展、无匹配、日期干扰和检索中断 |
| `recall/calendar-dates.ts` | 统一完整日历日期的识别与有效性检查，供检索和时间规划复用 |
| `recall/query-time-plan.ts` | 使用明确参考时间、固定 UTC 偏移量规划日期范围，保持 knownAt 不变 |
| `recall/query-time-plan.test.ts` | 验证日历边界、歧义拒绝及时间规划功能 |
| `recall/query-plan.ts` | 统一问题类型、目标文本、实体约束、时间、关系方向及证据要求 |
| `recall/query-plan.test.ts` | 验证各问题类型的计划，以及意图冲突、指代不清和显式覆盖 |
| `recall/multi-entry-recall.test.ts` | 验证多入口候选合并、多个起点共享预算、证据去重及未执行状态 |
| `index.ts` | 导出校验、索引、内存读取器和单跳/受限多跳召回及回答证据包；不导出测试样例 |

## 样例说明

- C1：张三 2026 年 9 月 20 日发烧。
- C2：张三同日没有上班。
- R1 第 1 版：来源 E1 明确声称因发烧未上班，连接 C1 → C2。
- C3：9 月 10 日没有上班，供后续时间过滤测试作为干扰。
- `createFeverAbsenceFixture(true)` 额外提供 E3 更正来源和 R1 第 2 版（撤销、被反驳），同时关闭旧关系版本的系统时间区间。旧版仍保留供审计。

日期和记录时间固定，每次创建相互独立的数据，不调用 API、不使用当前时钟。

## 使用方式

在本目录内的 TypeScript 模块中可以这样调用：

```ts
import { createFeverAbsenceFixture } from './fixtures/fever-absence'
import { validateGraphRelations } from './domain/validation'

const result = validateGraphRelations(createFeverAbsenceFixture())
// 正常样例：{ ok: true, issues: [] }
// 失败时：{ ok: false, issues: [{ code, path, message }, ...] }
```

在仓库根目录运行：

```text
npx --yes pnpm@9.12.0 --filter @continuum-memory/memory exec vitest run src/graph-core --no-file-parallelism --no-cache
npx --yes pnpm@9.12.0 --filter @continuum-memory/memory typecheck
```

## 检查的边界

检查精确版本引用、重复记录、来源原文哈希与 UTF-16 片段、作用域包含关系、上下文版本、时间区间、关系状态与证据角色、图边与关系记录的一致性。

当前只允许关系与端点引用同一个上下文版本；尚无上下文继承或跨场景桥接策略。作用域检查是结构检查，不能代替宿主的实际授权。

**校验通过不表示因果成立，也不表示记录可以进入当前答案。** 假设、待审核和已撤销关系可合法保存；内存读取器另外按查询的 valid/knownAt、权限、撤销和来源可用状态筛选。最终答案仍需后续召回及证据检查。

该函数接受已具备 TypeScript 结构的本地数据，不是接受任意 JSON 的完整协议校验器，也不验证规则证明、谓词参数模式、上下文环或所有图边类型。`factVersions` 是可信读取器提供的精确版本清单，本步骤只验证引用存在及作用域，不证明其文本与命题语义等价。

不会要求关系两端的事件时间重叠：先后关系和延迟后果可以连接不同时间的事件。不会根据文本自动推断关系，来源的 `supports`/`refutes` 语义仍需上游抽取与审核。

## 内存读取的调用顺序

1. 宿主调用 `createInMemoryGraph({ data, manifest, resolveAccess, countTokens })`。构造时先校验，再复制数据，外部修改不会改变已有快照。
2. 用 `openView({ access, temporal, budget, expectedManifestId, policyVersion })` 固定本次查询的范围、时间、版本和预算。
3. 对 C2 调用 `neighbors`，指定 `layer: 'semantic'`、`direction: 'in'`、`kinds: ['causal']`、分页大小与扫描上限，得到 C1 → C2 的边。逆向寻找原因不会把原来的因果方向倒置。
4. 用边上的 `relationRef` 调用 `resolveRelations`，再用关系的 `from` 调用 `resolveClaims`。
5. 用命题的 `fact` 调用 `evidenceReader.resolveFactVersions(view, refs)`，或用关系证据的 `source` 调用 `readSources(view, refs)`。原文读取只返回登记的片段。
6. 使用完调用 `view.close()`。测试文件的首个用例提供这条完整链路。

这里的索引是从语义记录派生的查询工具，不会根据相似度创造因果边。接口返回的仍是“来源明确声称的关系”，不是已经证明的客观因果。

## 读取资格与时间

- 命题必须已审核、属于实际场景、明确断言且无附加条件，并具有直接支持证据；关系还须处于 active、explicit-claim、supported 状态。
- `valid` 检查事件发生时间，`knownAt` 检查系统记录、关闭及审核时间。区间均左闭右开；未知事件时间暂不进入结果。
- 查询撤销前的系统状态，可以读到当时有效的旧关系；撤销后不能自动退回旧版。来源当前已删除时，历史查询也不能读取该来源。
- 当前保守策略要求关系及两个端点分别匹配查询时间。查询 `before` 或延迟因果关系时，需要用覆盖两端事件的 overlap 区间；尚无自动扩大时间范围的查询规划器。
- 引用按种类、ID、版本精确解析。批量读取中任何一项不可用，整个批次返回错误，不悄悄省略该项。

## 宿主责任与实现边界

`resolveAccess` 必须接入可信宿主的授权查询，每次操作都会重新调用；不能直接把调用者传入的 access 对象作为授权依据。授权变化时宿主应更新 authorizationVersion。`countTokens` 必须接入实际使用的 tokenizer；测试中的固定计数只用于验证预算逻辑。`policyVersion` 是宿主记录查询策略的标识，当前实现使用上述固定策略，不根据任意版本字符串切换行为。

manifest 的 bundle ID、范围和修订号必须匹配输入。指纹由可信投影构建方负责生成；读取器不重新定义其计算规则。宿主在投影过期时调用 `invalidate()`，在来源删除时调用 `revokeSource(episodeId)`；这两个操作尚未接入真实数据库事件，也不会修改磁盘数据。

每个视图累计限制不同命题版本数、邻接边扫描数、耗时，以及返回原文/事实文本的 token 数。原文和事实文本重复读取也计费；节点元数据的最终提示词开销需由后续上下文组装器另行计算。分页区分 complete、more 和 budget-exhausted，游标绑定视图与查询。

内置种子检索累计执行 `maxSeeds`，受限多跳服务执行每个起点的 `maxHops` 深度限制，并共享读取器的节点、边、耗时和证据预算；邻接读取层自身只在 `maxHops = 0` 时禁止扩展，单跳兼容入口仍最多扩展原始起点的一层。规则绑定和证明尚未实现，相应接口明确返回不支持；读取视图现在提供 exact-opposite-polarity-v1 冲突策略，尚未支持完整语义或规则冲突检查；不能把该策略下的空结果解释为“全局没有冲突”。索引当前按整个邻接列表准备候选，分页限制的是资格扫描，不是严格的候选构造内存或耗时上限，适用于当前本地样例验证。

## 一跳召回：一次调用取得完整证据组

已有 `graph`（上文的内存读取器）和 `openRequest`（含授权、双时间、manifest、预算的 `GraphOpenViewRequest`）时，可以调用：

```ts
import { createOneHopGraphRecall } from './recall/one-hop-recall'

const recall = createOneHopGraphRecall({
  readPort: graph,
  evidenceReader: graph.evidenceReader,
})
const result = await recall.recall({
  recallId: 'why-absence-1',
  view: openRequest,
  seed: { kind: 'claim', id: 'C2', version: 1 },
  direction: 'in',
  kinds: ['causal'],
})
// 返回前自动关闭本次读取视图，无需调用者管理 close。
```

本地完整可运行的构造和调用示例在 `recall/one-hop-recall.test.ts` 的 setup 和首个用例中，不需要 API key。此时调用者已经知道 C2 的精确版本；把自然语言问题定位到 C2 是后续种子检索的任务。

结果包含：

| 字段 | 含义 |
| --- | --- |
| `claims` | 起点和已完成证据组中的端点命题，保留否定、时间等语义，并附事实文本 |
| `relations` | 明确记录的关系，保留 causal / contributes-to / before 区分和原方向 |
| `sources` | 按精确来源版本和片段去重的原文 |
| `groups` | 每条关系及其 from/to 命题引用；证据没有读全的组不会出现 |
| `searchScope` | 本次明确的起点、方向、关系类型和一跳范围 |
| `completeness` / `stopReason` | 指定范围已查完，或因为预算不足而中断 |
| `scannedEdges` | 实际邻接扫描数，包括被过滤的边；不等于输出关系条数 |

从 C2 逆向查 causal，会得到 C1 → C2 及对应原文，不会把因果方向翻转。即使预算允许五跳，也只查询原始起点的邻居，不会继续沿 C1 查询其他原因。查到 before 也不会将其改写为 causal。

每次调用只打开一个视图，共享同一组预算。`maxSeeds` 至少为 1；`maxHops = 0` 时只返回起点证据并标记 incomplete。共享事实文本和原文只读取一次，降低重复 token 消耗。原文读取器优先通过已访问的合法命题读取共享片段，避免额外占用无关命题的节点预算。

起点及其证据都无法读取时，直接返回错误。扩展途中预算用完时，只保留已完成的证据组并标记 incomplete；正在组装但证据不全的组及其孤立命题不会输出。已读取却最终丢弃的文本仍然消耗读取预算。对于删除、权限撤销、投影失效或最终复查超时，整个调用返回错误，不返回之前缓存的部分原文。所有成功或失败路径都会尝试关闭视图。

`complete-within-declared-scope` 只表示当前读取策略下、指定起点/方向/关系类型的一跳邻接范围已查完。它不意味着找到了现实中的全部原因，也不意味着完成了冲突检查。结果明确标记 `interpretation: 'source-asserted-relations'` 和 `conflictCheck: 'not-performed'`，不生成证明证书。

当前采用模块内部的 `OneHopGraphRecallResult`：已有通用 `GraphRecallResult` 的证据包没有关系字段，直接套用会丢失方向和关系来源。后续接入 Agent 前，应单独对齐通用协议的关系证据表示，而不是把这些关系伪装成规则证明。本步不改动通用协议或现有聊天流程。

## 自然语言入口：本地词面种子检索

在上述已构造的 `graph` 和 `openRequest` 上使用：

```ts
const service = createOneHopGraphRecall({
  readPort: graph,
  evidenceReader: graph.evidenceReader,
  seedPort: graph.seedPort,
})
const result = await service.recallQuery({
  recallId: 'why-absence-2',
  query: '张三2026年9月20日为什么没有上班？',
  view: openRequest,
})
```

完整可运行样例在 `recall/query-recall.test.ts`。固定样例下，查询匹配 C2，再逆向读取 R1，得到 C1 → C2 及 E1 原文。无需 API key，也未加载新的模型或依赖。

调用链：`打开一个视图 → GraphSeedPort.search → 选最多 maxSeeds 个候选 → 各起点一跳扩展并合并证据 → 关闭视图`。检索和扩展共用同一个视图，不会重置节点、时间或证据预算。内置检索将返回的候选计入该视图的种子和命题节点预算；索引内部的文本处理不属于返回给模型的证据 token，之后真正读取文本仍由证据读取器计费。

种子检索的实现规则：

- 先执行读取层的时间、授权、来源、审核、场景等资格检查，再建立本次查询的 BM25 索引。不可访问记录不参与索引分数统计。
- 仅索引命题对应的事实文本，不索引整段来源，避免“发烧”和“缺勤”共享原文时混淆起点。
- 复用仓库 `long-term/bm25-index.ts`；中文保留连续汉字段内的双字词片段，去除单字和部分问句词，避免跨标点、日期生造词片段。
- 当前固定门槛为查询词覆盖率至少 0.5、BM25 归一化分数至少 0.2。它们是未经过 benchmark 调优的本地基线参数；分数不是正确率、置信概率或因果强度。
- 未开启时间规划时，支持单个明确的 `YYYY-MM-DD`、`YYYY/M/D` 或中文年月日，要求候选事实文本或日期参数中存在同一天；不会改写 `view.temporal`，日期与视图范围不一致会无匹配。相对日期和日期范围需要下文的 `timePlanning`；缺少必要规划或日期无效时返回明确错误。
- 对“没有、没上、未上、not、never”等部分明确否定表达要求 negative 命题。这是有限规则，不能识别所有否定范围、反问或肯定语义；不应作为通用自然语言逻辑分析器。
- 问题类型和遍历方向由统一查询规划器决定，详见下文。未识别的问题不再默认查全部邻居；调用者可显式提供问题类型或完整遍历配置。

返回值的 `status`：

| 状态 | 含义 |
| --- | --- |
| `recalled` | 已对候选执行一跳召回；仍需检查 `recall.completeness` 和各起点进度，也可能没有符合要求的关系 |
| `no-match` | 本次词面检索完成，但没有达到门槛的候选；不表示数据库或现实中没有相关事实 |
| `seed-search-incomplete` | 候选扫描或预算不足，未选择起点，也不执行关系扩展 |
| `needs-clarification` | 问题类型、目标或指代尚不明确；没有打开视图或执行检索 |

`seeds` 保留候选引用、路由、分数、入口 origins 和扫描状态；`selection: 'top-k'` 表示最多选 maxSeeds 个去重后的起点，maxSeeds 为 1 时仍是单起点。同分按精确引用确定性排序，不代表消除了语义歧义。自然语言召回不具备自动同义改写、多实体消歧或跨语言匹配保证。

内存读取器新增可选 `maxSeedScanned`，默认 10000，允许 1–10000，按视图累计计算扫描过的命题记录（包括被过滤记录）。用完后不给出基于部分语料的“最高分候选”。当前 `GraphSeedPort` 没有游标输入，因此本实现只返回 complete 或 budget-exhausted；complete 表示在完整扫描后算完受 `maxSeeds` 限制的 top-K，不表示返回了所有匹配项。为了让权限与时间筛选发生在分数统计之前，当前每次查询重建符合条件的词面索引，适用于本地样例与小规模验证；尚未进行大规模性能优化。

## 时间查询规划：相对日期与明确范围

`recallQuery` 新增可选的 `timePlanning`，在打开视图之前完成解析。例如：

```ts
const result = await service.recallQuery({
  recallId: 'why-absence-yesterday',
  query: '张三昨天为什么没有上班？',
  view: openRequest,
  timePlanning: {
    referenceTime: Date.parse('2026-09-21T09:00:00+08:00'),
    utcOffsetMinutes: 480,
  },
})
```

这里“昨天”会变为 UTC+08:00 的 `[2026-09-20 00:00, 2026-09-21 00:00)`，然后检索 C2，再查询其因果关系。示例参考时间固定；实际应用由宿主在接收问题时提供参考时间，不从机器当前时钟或 knownAt 隐式推测。

三种时间各有用途：

| 参数 | 用途 |
| --- | --- |
| `referenceTime` | 解释用户说的“昨天”“上周”是哪个日历范围 |
| `view.temporal.valid` | 实际筛选事件发生的时间；开启规划且有可解析时间时，用解析范围替换 |
| `view.temporal.knownAt` | 限制系统截至何时知道的记录；规划始终保留调用者提供的值 |

传入 `timePlanning` 明确启用“以问题中的时间为准”：可能替换原有 valid 时间窗口。若宿主需要额外限制允许查询的事件时间，应在调用前检查计划，或用导出的 `planGraphQueryTime(query, temporal, options)` 先解析、检查，再决定是否执行。它不改变授权范围、manifest、预算或原始调用参数。没有时间表达时保留调用者的原时间窗口。

当前支持：

- 日：大前天、前天、昨天、今天、明天，以及 yesterday / today / tomorrow。
- 周：上上周、上周、本周、这周，以及 last week / this week；一周定义为周一零点到下一周一零点。
- 月和年：上个月、上月、本月、这个月、去年、今年及对应的 last/this month/year；按真实日历边界计算，包含闰年和跨年情况。
- 明确日期：完整年月日，及由“到、至、to、through”等连接的两个完整日期；终止日包含在内，例如 9 月 10 日到 9 月 20 日转换为 9 月 10 日零点到 9 月 21 日零点。

结果新增 `timePlan`，包含原问题、用于词面检索的文本、匹配到的时间表达、最终双时间、参考时间和偏移量。时间表达从词面查询中移除，事件时间由读取视图统一过滤；开启范围规划后，不再要求候选同时含范围两端的日期。词面文本会进行 NFKC 标准化，原始问题另行保留。未开启规划时 `timePlan` 为 null。

这是固定 UTC 偏移的日历规划，`utcOffsetMinutes: 480` 表示 UTC+08:00，不是 IANA 时区；不自动计算跨夏令时的边界。需要夏令时的宿主应自行解析两个边界并提供明确窗口。

目前对于多个相互竞争的时间表达、缺少年份的日期、“最近几天”、具体星期几、上午/下午或具体时刻、开放式之前/之后等，返回 invalid-request，留给调用者澄清或提供更明确的查询。没有时间规划时，已识别的相对时间也会报错，避免将“昨天”忽略后按旧窗口召回。这里是有限语法支持，不是通用自然语言时间理解。

范围查询仅扩展预算内选出的起点，不表示列举该范围内的所有事件。这里只添加功能与回归测试，没有新增对照测评或声称召回质量已经提升。

## 第 1 步：统一问题规划

`recallQuery` 现在先调用 `planGraphQuery`，然后才打开视图、寻找种子并扩展。旧的“为什么查入边，其余全部双向查”的分散规则已替换。

| 问题类型 | 默认关系和方向 | 要补齐的信息 |
| --- | --- | --- |
| cause：为什么缺勤、缺勤原因是什么 | 入向 causal / contributes-to | 原因或促成因素 |
| effect：发烧造成了什么影响 | 出向 causal / contributes-to | 后果 |
| before：缺勤之前发生了什么 | 入向 before | 更早的事件 |
| after：发烧之后发生了什么 | 出向 before | 更晚的事件 |
| related：与发烧相关的记忆 | 双向三类直接关系 | 关联命题 |

规划器从有限句式中保留目标事件措辞，去掉“造成了什么影响”等提问部分，再把目标文本送入种子检索。因此“张三发烧造成了什么影响”以“张三发烧”为起点线索，不把“影响”也当成事实关键词。目标仍标记为 candidate-needed；文本解析不是事实确认或命题身份解析。

返回结果新增 `queryPlan`，包含：

- `questionType`、`missingInformation`：要问什么、缺少哪个信息槽。
- `target`：目标文本、宿主提供的精确实体引用，以及身份是否已绑定。
- `temporal`、`timePlan`：复用现有时间规划结果，保留 knownAt。
- `traversal`：允许的关系类型、方向以及规则来源；待澄清时为 null。
- `requiredEvidence`：目标命题、关联命题、关系记录、原文片段。
- `followUpChecks`：竞争解释和冲突检查的后续要求。这里只记录要求，不表示已经完成；当前召回仍报告 conflictCheck 为 not-performed。

人物姓名不会被硬编码或猜成实体 ID。例如“李明为什么缺勤”保留目标文本，但 entityResolution 为 not-resolved，仍只能进行词面候选检索。宿主已有身份解析结果时，可传入：

```ts
const result = await service.recallQuery({
  recallId: 'cause-with-identity',
  query: '他为什么没有上班？',
  view: openRequest,
  constraints: {
    entities: [{ kind: 'entity', id: 'zhang-san', version: 1 }],
    targetText: '没有上班',
    questionType: 'cause',
  },
})
```

实体引用必须由可信宿主提供。内置种子检索要求所有指定实体以精确版本出现在候选 Claim 参数中，并继续执行原有权限、时间和来源检查。这是对起点的约束，不要求路径上的所有关联命题都包含同一个人物。没有显式实体约束时不增加身份过滤，也不宣称已经解决同名消歧。

“他为什么……”没有实体绑定、“为什么？”缺少目标、多个不同问题意图同时出现，或没有识别到问题类型时，返回 needs-clarification、原因列表和空候选，不打开视图、不消耗检索预算。此时空 `seeds` 是未执行查询的占位结构，不能把其 completion 当成已搜索全库；应先判断顶层 status。

宿主可用 `constraints.questionType`、`constraints.targetText` 提供已解析的约束。显式 `direction` / `kinds` 仍可覆盖规则；实际覆盖的遍历标记为 custom / caller，不冒充自动识别的因果查询。无法识别意图时，只提供其中一个遍历选项不足以补齐计划。

兼容性变化：无关系意图的普通问题不再自动扩展全部关系；无效日期和缺少参考时间的问题在打开视图之前报错。`recall` 的指定命题调用保持原有行为。统一计划本身不执行遍历；第 3 步的独立入口已支持受限多跳，完整语义冲突检查仍未实现；第 4 步只开放精确正反断言检查。

## 第 2 步：多入口候选与多个起点

`recallQuery` 接受可选的 `seedEntries`，例子如下（引用必须来自当前数据版本，不能随意编造）：

```ts
const result = await service.recallQuery({
  recallId: 'multi-entry-example',
  query: '张三为什么没有上班？',
  view: { ...openRequest, budget: { ...openRequest.budget, maxSeeds: 3 } },
  seedEntries: {
    claims: [{ kind: 'claim', id: 'C2', version: 1 }],
    entities: [{ kind: 'entity', id: 'zhang-san', version: 1 }],
    relations: [{ kind: 'relation', id: 'R1', version: 1 }],
  },
})
```

已实现的候选入口：

| 入口 | 如何定位 Claim | origins 标记 |
| --- | --- | --- |
| Claim 文本 | 现有 BM25 对合格事实文本排序，默认启用 | claim-text |
| 精确 Claim 引用 | 宿主已经定位目标后直接提供引用，仍检查可读资格、日期和否定约束 | claim-ref |
| 精确 Entity 引用 | 用实体到 Claim 的索引获取关联命题，继续按目标事件文本过滤和排序 | entity-ref |
| 精确关系引用 | 读取符合计划类型的关系；查入向时以 to 为目标，出向时以 from 为目标，双向时两端均可候选 | relation-ref |

`constraints.entities` 是对所有起点必须满足的硬约束，也自动用于实体入口；`seedEntries.entities` 只提供额外检索入口，不将其他入口全部限制为该实体。实体成员关系本身不代表事件相关，实体入口仍要求词面匹配门槛。Claim 和关系的精确引用由宿主负责与问题对齐，允许越过词面分数门槛，但不会越过权限、时间、删除、版本、审核、显式日期、否定及实体硬约束。

三种显式引用列表各最多 1000 项。结果按 Claim 精确版本合并 origins；同一 Claim 从多个入口命中，也只占一个种子和节点名额。普通候选取命中入口中的最高 BM25 分数，宿主精确 Claim/关系入口优先级分数为 1；这些分数只是当前候选选择策略，不是概率或事实正确性保证。各入口合并后统一按 maxSeeds 截断，不为每个入口重新分配预算。

关系入口的来源记录先检查资格，但不在这一步作为答案证据发布。来源删除、关系撤销、关系类型不合或端点不合格时，该入口不提供候选。真正输出关系仍需后续邻接查询、关系读取及证据组装；不会把提供一个 relationRef 当成证明。

`maxSeedScanned` 现在累计覆盖 Claim 扫描和去重后的显式关系入口查找。任一路径触及扫描上限，整个候选阶段返回 seed-search-incomplete 和空候选，不发布基于部分扫描的排名。实体入口复用 Claim 资格结果与反向索引，其文本评分成本仍受视图耗时检查约束，尚未做大型图性能优化。

多个起点按排名顺序扩展，共享同一个读取视图、节点/边/时间/证据预算及证据缓存，不把新发现的邻居继续排入队列。共享命题、事实文本、关系和原文去重；重复扫描仍计扫描成本。同一关系从两个端点到达时，只输出一个关系组。

结果新增：

- `recall.searchScope.seeds`：全部计划起点。原 `searchScope.seed` 保留为第一个起点，便于旧调用迁移。
- `recall.seedProgress`：每个起点的 complete、incomplete 或 not-started，分别表示指定的一跳范围查完、因预算/跳数限制未完成、尚未开始。
- `seeds.items[].origins`：候选入口及精确引用；旧外部适配器可以不提供此可选字段。

后续起点预算不足时保留之前完整证据组，标记整体 incomplete；未读全的组不进入输出。授权撤销、来源删除、过期视图或最终复查失败仍返回错误。候选全部选出并不等于所有起点都完成扩展，调用者应同时检查 seedProgress 和 completeness。

此步实现的是内存图中的显式引用入口和多起点一跳召回。尚未实现自动实体消歧、关系文本索引、向量到 Claim 的真实 V4 适配，以及社区/摘要入口；不会用同一词面结果冒充这些能力。第 3 步的多跳接口见下文；第 4 步已增加受限冲突检查和多原因候选整理，后续完善面向回答的证据组装。

## 第 3 步：由查询计划约束的多跳遍历

新入口 `createBoundedGraphRecall` 复用前两步的请求格式，支持指定起点的 `recall` 和自然语言入口 `recallQuery`。旧 `createOneHopGraphRecall` 继续最多一跳，不因传入更大的 maxHops 自动变成多跳。

```ts
const service = createBoundedGraphRecall({
  readPort: graph,
  evidenceReader: graph.evidenceReader,
  seedPort: graph.seedPort,
})
const result = await service.recallQuery({
  recallId: 'bounded-cause',
  query: '张三为什么没有上班？',
  view: {
    ...openRequest,
    budget: { ...openRequest.budget, maxSeeds: 3, maxHops: 2 },
  },
})
```

“原因”计划沿入向 causal / contributes-to 扩展；“后果”沿出向；先后问题只走 before。整个遍历使用同一计划中的类型集合与方向，不根据中途文本擅自改变策略，也不遍历相似/共现导航边。所有扩展记录继续经过权限、删除状态、精确版本、valid/knownAt、上下文、审核及来源检查。每一跳都沿用同一时间范围；跨日期链条需要宿主提供覆盖端点的合理时间范围，本轮没有自动放宽时间策略。

每个起点执行广度优先遍历（先 1 跳，再 2 跳），达到 maxHops 的节点保留证据，但不再读取其邻接关系。多个起点仍按候选优先级依次处理，共享一个视图和节点/边/耗时/证据预算；先前起点可以耗尽预算，尚未开始的起点如实标记 not-started，暂未实现起点间公平轮转。

每个起点有独立的已发现节点表，避免一个起点的访问影响另一个起点的可达性。命题、关系、事实文本、来源证据在所有起点间共享和去重；邻接重复扫描仍计入边预算。遇到祖先节点（含沿同一边往回走）记录 cycle-skipped；遇到其他已发现节点记录 revisit-skipped。两者都不重复入队，但已经完整核验的关系仍进入证据组。这里的“环”指遍历回路，不是对现实因果矛盾的判定。

### 路径与完整性字段

| 字段 | 含义 |
| --- | --- |
| `searchScope.maxHops` | 此次声明的最大遍历深度，多跳入口取请求中的值 |
| `pathPolicy` | 固定为 one-shortest-path-per-root-and-claim：每个起点到每个命题保留一条最短发现路径，不枚举所有路径 |
| `paths` | 前驱表：root、target、depth、parent、via；起点的 parent/via 为 null，逐级追溯 parent 可重建路径 |
| `traversalTrace` | 合格关系的实际遍历方向、深度和发现/跳过动作；未通过资格检查的记录不泄漏到日志 |
| `depthFrontier` | 已发现且位于深度上限的命题；没有读取它们的邻接，不能断言其后没有其他证据 |
| `groups` / `relations` | 保留关系原本的 from/to；与遍历方向分开 |
| `seedProgress` | 每个起点在声明深度内的完成情况 |

前驱表避免复制每条完整路径带来的大量重复数据。菱形汇合的其他关系仍在 groups 和 traversalTrace 中，但 paths 只记录首次发现的最短路径；路径数不是所有解释数量，也不是置信度。

- 所有待扩展节点查完，且没有深度边界：stopReason 为 neighbors-exhausted。
- 所有应扩展节点查完，但存在深度边界：stopReason 为 depth-limit。此时 complete-within-declared-scope 只代表声明深度内的合格邻接已检查；不能代表全图查完或答案充分。
- 节点、边或证据预算不足：返回已完整装配的组与路径，标记 budget-exhausted / incomplete；不发布缺少证据的半条路径。
- 超时、授权撤销、来源删除或视图失效导致最终复查失败：返回错误，避免把先前缓存的证据当成仍然可用的结果。
- 多跳入口 maxHops = 0 的声明范围仅包含起点，返回起点路径与 depth-limit；旧单跳入口仍保持 hop-budget / incomplete 的兼容行为。

例如已有 `C4 → C1 → C2` 两条来源明确声称的因果关系，从 C2 反向查找时可得到 `C2 → C1 → C4` 的遍历路径。输出仍只含原来的 `C4 → C1` 和 `C1 → C2` 两条关系，不生成 `C4 → C2` 的新命题，更不把传递路径当作完整因果证明。混合关系链同样不自动推导结论。

多跳功能用合成图检验代码行为，尚未证明真实数据召回质量提升。第 4 步已加入下述受限检查，但仍未增加完整规则证明，也没有接入真实 V4 写入、持久化发布或 Agent 聊天运行时。

## 第 4 步：精确冲突检查与多个原因候选

`createBoundedGraphRecall` 现在自动执行：遍历及证据读取 → 对已返回命题做精确冲突检查 → 整理直接原因候选 → 构建回答证据包 → 最终资格复查 → 关闭视图。指定起点和自然语言查询均使用此流程。`createOneHopGraphRecall` 保持原有兼容行为，conflictCheck 为 not-performed，不额外消耗冲突检查预算。

### 能检查什么

精确冲突必须同时满足：相同 owner/agent/session 作用域、相同上下文版本、相同谓词和全部具名参数（实体 ID/版本、字面量类型和值、数值单位均精确匹配），一条 positive、一条 negative，且两条记录与查询时间范围存在共同有效时刻。参数的书写顺序不影响匹配。

例：同一人、同一天、同一上下文，“张三上班了”与“张三没有上班”可以被标记为相反断言。较早时段上班、较晚时段未上班，不会仅因为都落在一个宽泛查询区间里就被判为冲突。不同人物或事件参数不匹配时也不构成该策略的冲突。

反向断言通过结构化索引查找，不要求它已经连接到当前遍历路径。每条候选仍经过权限、精确版本、knownAt、删除状态、审核、事实模态、上下文及来源检查；不扫描不可访问语料来断言用户“应该知道”的矛盾。旧版本、未知有效时间、条件命题与未审核命题不参与当前检查。

这是 `exact-opposite-polarity-v1`，不是通用事实判定器。暂不识别近义改写、别名合并、跨上下文或跨 session 冲突、两个不同正值之间的单值属性冲突、隐含规则矛盾或因果链矛盾。尤其不会读取 `cardinality: single` 就自动裁定两个不同正值冲突；这种检查需另行补齐谓词约束验证。

### 结果怎么读

| 字段 | 含义 |
| --- | --- |
| `conflictCheck` | not-performed、complete-within-policy、incomplete 或 unsupported |
| `conflictAudit.policy` | 本轮执行的精确冲突策略 |
| `conflictAudit.targets` | 遍历结束时已返回的命题及每个命题的 complete/incomplete/not-started 状态 |
| `conflictAudit.pairs` | 已核实的相反断言对，两侧事实文本和来源均已读齐；同一对只返回一次 |
| `conflictAudit.scanned` / `reason` | 实际候选扫描量和结束原因 |
| `causalAlternatives` | 按目标命题整理直接原因、关系引用、多个原因标记与检查覆盖状态 |

`complete-within-policy` 表示对本次 targets 的可访问记录完成了该策略检查，即使发现冲突也可能是这个状态；是否发现冲突应看 pairs。它不表示“没有冲突”，不表示该命题一定真实，也不覆盖全库其他命题。

原 `completeness` / `stopReason` / `seedProgress` 仍描述**遍历阶段**，不会因随后冲突检查成功而把未完成遍历变成完成。消费结果时必须同时看 conflictCheck；可能出现“遍历完成，但冲突检查因预算不足而 incomplete”。旧适配器未声明 `view.conflictPolicy` 时返回 unsupported，不能伪装为检查完成。

冲突证据加入 `claims` / `sources`，但不补造图边或路径。新增的反向命题不作为新遍历起点，也不递归扩大本轮冲突 targets。路径只指向原有遍历命题；冲突对通过独立的 pairs 引用两侧证据。返回前统一复查全部命题和关系资格，来源删除、授权撤销或最终复查失败会让整次调用报错。

### 多个原因与覆盖范围

同一目标的 causal / contributes-to 入向关系按原因命题分组；同一结构化原因、极性和有效区间的重复记录或多条支持关系合并为一个候选原因，同时保留所有引用。两个不同原因时 hasMultipleCauses 为 true，interpretation 固定为 candidates-may-coexist：它们可以同时成立，不直接等同于互相排斥的“竞争解释”，也不自动选出唯一原因。

coverage 为 complete-within-declared-scope 仅表示该目标在此次指定类型集合中的入向邻接已查完；例如只选择 causal 时，不能认为 contributes-to 也已查完。因预算中断则 incomplete；位于跳数边界、未扩展、只做出向或只做 before 查询时为 not-checked。这里只整理直接原因候选，尚未构造多条完整解释之间的互斥、排序或择优机制。

### 预算和工程边界

内存读取器新增宿主配置 `maxConflictScanned`，默认 10000，允许 1–10000，限制同一视图内所有命题和分页累计扫描的候选数。它与 maxSeedScanned、边扫描计数分开，不把冲突记录假装成遍历边；每页仍受 maxScanned 限制。召回编排本身另设每次审查累计 10000 项的上限，防止外部适配器用不断变化的游标无限分页。游标绑定视图、目标与策略，不能跨查询复用。

冲突读取继续与遍历共用 maxNodes、maxElapsedMs 和 maxEvidenceTokens。读不齐反向事实文本或来源时，不发布半个冲突对或未完成的反向命题，返回 incomplete；该次尝试已消耗的预算不退回。扫描截断、适配器不支持、来源失效均有显式状态或错误，空 pairs 不能单独作为“无冲突”的判断依据。

当前功能仍依赖结构化命题与来源已被正确抽取、规范化和审核。测试仅验证代码机制，不是公开 benchmark 成绩。第 5 步已将路径、直接关系、反向证据、检查覆盖与缺口组织成下面的回答证据包。

## 第 5 步：回答证据包

单跳与多跳召回结果新增 `evidencePack`。原有 claims、relations、sources、paths 和检查字段保留，证据包在它们的基础上做确定性的组织与引用映射，不重新检索、不调用 LLM、不自动选择结论。缺少来源、精确引用不匹配、路径断裂或冲突对缺端点时拒绝构建，整次召回不会发布半成品。

```ts
const result = await service.recallQuery({
  recallId: 'answer-evidence-example',
  query: '张三为什么没有上班？',
  view: openRequest,
})
if (!result.ok) {
  // 处理来源失效、授权变更、版本或结构错误。
} else if (result.value.status === 'recalled' && result.value.recall) {
  const packet = result.value.recall.evidencePack
  // 后续回答端读取 packet.facts、relations、paths、disputes、gaps，
  // 引用 packet.sources，并同时保留原问题及 result.value.queryPlan。
}
```

needs-clarification、no-match 和 seed-search-incomplete 仍返回 recall: null，不会制造空证据包来伪装已完成召回。指定 Claim 的 recall 成功时同样返回 evidencePack。`buildGraphAnswerEvidence(raw)` 也可单独调用，但这是对可信、已读取的类型化结果的纯组织函数，不是任意 JSON 的安全验证器，不重新检查当前授权，也不让过期的缓存重新获得可用资格。

### 内容与引用

| 字段 | 用途 |
| --- | --- |
| `sources` | 带 source-N 编号的精确来源片段，保留 episodeId、contentHash、locator、scope 和文本 |
| `facts` | 带 fact-N 编号的命题：原始 Claim/Fact 精确版本、文本、结构化参数、正反极性、上下文、有效时间和来源引用 |
| `relations` | 带 relation-N 编号的直接关系，保留原来的 from/to 方向、类型、上下文、有效时间和来源引用 |
| `paths` | 带 path-N 编号的前驱表；用 parentPathId 回溯路径，用 viaRelationId 找到每一跳的关系证据 |
| `disputes` | 相反断言双方的 fact 编号，可据此同时引用两边来源 |
| `alternatives` | 目标及各个直接原因的 fact/relation 编号、覆盖范围与可能并存标记 |
| `coverage` | 版本、查询范围、起点进度、遍历边界、冲突策略与逐命题检查进度 |
| `gaps` | 未完成遍历、深度边界、未完成/不支持/未执行的冲突检查，以及原因检查缺口 |

所有短编号只在当前证据包内有效，不可当作数据库 ID 或跨次召回的稳定编号；持久身份仍用精确 ref。来源片段集中保存一次，各证据项只引用 sourceId，避免每条路径重复复制全文。候选已选中但因预算未开始的起点仍出现在 coverage/gaps 的精确引用中，不为它虚构 fact 或来源。

### 三种证据状态

- `opposed`：已经找到并读齐相反证据，usage 为 report-disagreement，回答应披露分歧并关联双方来源。
- `unchecked`：对应检查未完成、未执行或不支持，usage 为 attribute-with-check-gap，不能当成“没有反证”。
- `no-opposition-found-within-policy`：该命题在当前可访问范围及精确策略下已检查完且未发现相反断言，usage 为 attribute-to-source；只能归因于来源，不能解释为已证明为真。

命题携带各自的检查状态，关系的 endpointState 只汇总两个端点，**不是对关系本身做了完整矛盾证明**。路径的 state 汇总全部前驱命题：即使最后一个命题无争议，只要中间命题存在相反证据，路径也标记 opposed。它表示使用这条证据链时必须披露争议，并不将争议传播成其他命题已经为假。

仅在冲突检查中发现的命题标记为 counter-evidence，保留自己的事实和来源，通过 disputes 关联原命题；不会成为新图路径。每个起点到每个命题仍只保留一条最短发现路径，未改变第 3 步的遍历策略。

### 回答端必须保留的边界

证据包固定标记 interpretation 为 source-attributed-evidence-not-proof、contentRole 为 untrusted-evidence-data，并给出 answerConstraints：引用来源、披露冲突与检查缺口、不自动推导传递结论、不自动选择唯一原因、不把缺少记录解释成事实为假。原文和事实文本始终属于证据数据；这些结构标记不是提示注入防御的完整实现，后续 Runtime 接入时还需将数据与指令分开处理。

例如存有 `A → B → C` 两条关系，包中保留两条直接关系及可回溯路径，不增加“A 导致 C”的推导命题。多个原因可以并存，packet 不自动输出唯一解释。coverage.answerSufficiency 固定为 not-assessed：完成受限搜索不代表足以回答整个问题。

证据包在读取视图关闭前构建，随后统一复查全部命题和关系；若构建期间已超时、授权撤销或来源不可用，仍返回错误。返回后它只是当次快照，不能作为长期有效的访问许可。

maxEvidenceTokens 目前计量证据读取内容，不等于将整个 JSON 序列化后的提示词 token 总量。未来回答端应使用证据包或原始结果中的一种表示，避免两份重复放入上下文，并在真实模型上下文预算内按完整证据组裁剪。不能只截掉反向证据或检查缺口，却仍保留确定性说法。本轮没有接入提示词构建、模型调用或自动裁剪。

本轮新增 21 项证据包测试，覆盖引用映射、争议沿路径传递、多个原因、检查缺口、无匹配/需澄清状态、单跳兼容及损坏引用拒绝。它们验证代码行为，不代表真实数据上的召回质量提升。

更新后的分支已提供权威 L2 持久化与 CAS 发布，本次新增了召回到该读取层的适配。后续仍需对接真实 V4/L1 与宿主来源、种子检索和生命周期事件，再将证据包接入 Agent Runtime 和使用反馈。


### V4 current-state staging input

`collectV4RecallInputs` (`adapters/v4-recall-input.ts`) reads a pinned V4 repository snapshot.
It returns exact fact versions and evidence episodes plus per-fact rejection reasons within the
requested exact owner/agent/session scope. A trusted host `canRead` callback is mandatory for
both facts and episodes. The callback must implement actual access policy; this helper does not
authorize remote transmission. Collection never writes to V4 or creates accepted graph records.

The initial subset requires active, verified, asserted, signed, unconditional scalar facts,
a known valid-time start, matching latest version and available direct supporting evidence.
Entity objects and JSON require explicit semantic mapping and are currently rejected. Fact valid
time is preserved, not filtered by collection time; the eventual query reader must apply query
time constraints. Historical import is unsupported because historical versions lack complete
policy and verification metadata. Rejections are internal diagnostics, not user-facing evidence.

This is a staging boundary only. Persisted semantic decisions (predicate roles, entity identity,
context, review), L1 publication, source hashing, query-time lifecycle/authorization rechecks,
V4 query seed wiring and runtime injection are still required. A successful collection is not a
live read view and must never be served as an enduring authorization grant.


## Desktop V4 → L1 → Agent direct-fact route

The opt-in desktop route is now connected through `AgentMemoryPort.graph` and `core`'s
`graphRecall` dependency. Set `CONTINUUM_GRAPH_MEMORY=1` in the process environment before
starting the development app. The desktop must have V4 enabled and ready; this switch does not
migrate unverified records, enable remote sharing, or fall back to V3 if the graph route fails.
Restart the development app after changing the switch. It does not update an already packaged EXE.

PowerShell, from the repository root:

```powershell
$env:CONTINUUM_GRAPH_MEMORY = '1'
pnpm --filter @continuum-memory/electron dev
```

Remove the switch with `Remove-Item Env:CONTINUUM_GRAPH_MEMORY` and restart to return to the
existing runtime route. No user data or settings are changed by setting this environment variable.

### Supported data and meaning

`projectV4ScalarInputs` maps verified, active, asserted, signed, unconditional V4 scalar facts
with known valid-time starts and exact latest versions. Subject IDs stay string literals; no
entity identity is guessed. Predicate roles are `subject` and `value`, cardinality comes from V4,
and inference is disabled. The deterministic mapping policy accepts only this mechanical typed
representation, not the truth of a sentence or an inferred relationship. Source edits and privacy
changes alter the exact L1 identity. Unknown time, entity/JSON values, legacy-unverified facts,
conditions and unavailable sources remain excluded. This can leave an existing V4 installation
with few or zero eligible facts; no missing fields are invented to make the demo appear populated.

The projection is a scoped, rebuildable L1 checkpoint with exact source hashes. It is not a
multi-writer semantic decision registry or a CAS publication service. The desktop uses separate
`memory-graph-l1.enc` and OS-protected `memory-graph-l1.key` files, with authenticated encryption
and atomic replacement. Every V4 publication first erases the derived checkpoint, even with the
graph switch off. A failed erasure blocks publication. This does not promise forensic disk erasure.

### Reading and runtime

Each recall reconstructs the current eligible view from the authoritative V4 repository, intersects
host and requested permissions, searches real canonical text/predicates with local BM25, and
rechecks source state, content hashes, evidence links, current authorization and revision before
returning. Stored L1 text is never sufficient authority to return a fact. Historical transaction
views, causal/ordering questions, hierarchy and proofs explicitly fail as unsupported. Query dates
are parsed by the existing fixed-offset time planner and applied to valid time. Omitted session
currently selects only sessionless records; this subset is declared in the trace rather than
claiming all-session coverage. Lookup/collection is capped at 10,000 facts and elapsed budgets
are checked before return; synchronous projection work is not preemptible and is not suitable
for large repositories. Ranking is a lexical baseline, not a learned semantic ranker.

Core waits for capture and hooks before reading; on each model/tool round it obtains a new graph
result and replaces the system evidence block. It escapes untrusted entries, preserves polarity,
valid time and citations `[G1]`, and budgets the complete graph prompt. The desktop uses UTF-8
byte length as a conservative byte-BPE token upper bound, not an exact model tokenizer. Hosts
with a known tokenizer can inject it. The counter does not budget the rest of the conversation.
Usage receipts distinguish injected/cited/ignored and are bounded, session-local and idempotent
while retained; citation is never verification. Durable feedback analytics are not implemented.

This first host route is **direct L1 only**. The independent bounded L2 traversal remains available
in `l2-recall-adapter.ts` but is not automatically connected to this scoped scalar checkpoint.
There is no real-user-memory quality claim: tests use synthetic V4 records, a real repository,
encrypted temporary files and a stub LLM. No user corpus or paid model API is accessed by tests.
