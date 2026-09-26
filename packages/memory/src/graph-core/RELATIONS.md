# L2 关系层（v1）

L2 使用独立的关系快照；不修改现有 V4 持久化格式，也不把向量相似度或 NLI 分数直接写成语义图边。第一版的关系两端必须是精确版本的 L1 `GraphClaimRef`；事件框架尚未进入 L1，因此不在本版端点集合中。

## 写入路径

1. `selectGraphRelationPairSeeds` 合并原文线索、结构化匹配、向量种子与已采纳关系的一跳邻居，限制候选数。返回值只是“值得比较”的 Claim 对。
2. 候选生成器确定关系类型、方向、原文提示与假设文本，形成 `GraphRelationCandidate`。本地 NLI 适配器经 `GraphNliJudgePort` 评分，将三类分数与模型／预处理版本保存为 `GraphNliObservation`。
3. 审核或可信写入策略基于原文证据、时间、上下文及权限作决定。`NEUTRAL` 不是“无关系”；`ENTAILMENT` 也不能单独证明因果。
4. 只有来源支持且被采纳的 `GraphRelationRecord` 才进入权威关系集合。发布时验证精确 L1 端点、同作用域／上下文、来源、敏感级别、双时间和历史版本；完整快照以 CAS 原子替换。模型候选更新不增加 `relationRevision`。

`GraphRelationRepository` 接受持久化和可信来源校验适配器。生产环境应传入 `createEncryptedGraphRelationPersistence`、由宿主提供的操作系统密钥保护函数，以及能够核验来源版本、删除标记、作用域和来源访问策略的 `verifySources`。不传持久化适配器只适合测试。

## 读取与失效

`GraphRelationReadPort` 绑定一个仍然有效的 L1 视图和精确 L2 manifest。读取关系及有界邻居时重查授权与来源；图边仅为携带 `relationRef` 的可重建投影，并保留关系极性和模态。L3/L4 可通过其现有的 `relationRevision` 引用已发布的 L2 版本。

来源或 Claim 删除时，宿主应先停止读取并调用 `purge`，原子清除关联关系、候选和 NLI 观察，随后重建并发布新的 ready 快照。如果旧 Claim 已从 L1 快照移走，宿主还需传入受影响的精确 Claim 引用。`invalidate` 只关闭旧视图，不替代清除。加密文件没有明文备份；物理介质残留和宿主级备份仍由宿主的数据删除策略负责。

本层尚未接入具体 NLI 进程／服务、现有 V4 Worker 或 `GraphAnswerEvidenceBundle`。这些适配器可以并行实现，但不能将候选分数绕过审核发布为权威关系。
## 与受限召回的连接

`recall/l2-recall-adapter.ts` 的 `createL2GraphRecallAdapter` 将精确 L1/L2 视图接入现有受限多跳召回和内部 `GraphAnswerEvidencePack`。输入须指定 expectedRelationManifestId；读取时保留五种关系的原义、权威原记录和 L2 manifest，不将旧样例 contributes-to 自动转换为 explains。宿主须提供 L1 读取、L2 来源读取、tokenizer，以及可选的问题种子检索回调。

当前直接事实遍历只纳入 positive/asserted、已审核且有效时间已知的权威关系；其他模态和极性仍可存储，但不被适配器改写为正向事实。显式 contradicts 按对称关系返回，并与精确正反断言审查分开呈现。候选和 NLI 分数仍不能直接进入答案证据。

此适配器不替代 CAS 写入或删除级联，也尚未自动接入 V4 Worker、NLI 服务或聊天 Runtime。桌面聊天目前只在实验开关下接入 V4 标量到 L1 的直接召回，不支持 L2 多跳。详细接口和旧样例兼容边界见 [README](./README.md)。

桌面端对 owner 级跨会话查询显式启用 `includeOwnedSessions`，使此前以会话 scope 写入的 V4 事实仍可被同一 owner 的直接图召回访问。事实和来源仍逐条接受读取策略检查；带明确 session 的查询保持精确会话隔离。没有已知有效时间的事实仍不进入该图适配器。
