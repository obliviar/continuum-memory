# 本地交叉编码器：真实相关性评分实验

本轮已安装并运行真实模型，接通候选重排和证据筛选的实验路径。桌面默认仍使用局部宽候选＋原输出门槛；没有自动启用新模型，没有改写 L1/L2 事实或关系，也没有提交代码。

## 模型和职责

使用 [BAAI bge-reranker-base](https://huggingface.co/BAAI/bge-reranker-base) 的 [Xenova ONNX 转换版本](https://huggingface.co/Xenova/bge-reranker-base)。它联合编码问题和候选正文，输出相关性 logit；不同于仅分别编码文本再比较余弦相似度。它不是关系 NLI，不证明事实真值，也不能自动确定“我”对应哪个实体。

固定 revision `cbd4c47f870c4bb77534e06b8853de9c6e958b82`，q8 模型权重 279,301,077 字节。安装时按固定 SHA-256 / Git blob 校验全部文件；运行时再次校验并强制离线加载。本机安装目录是 `C:/Users/Lenovo/Documents/Codex/2026-09-17/referenced-chatgpt-conversation-this-is-an/models/reranker-base`，不在代码库内。

## 文件与功能

| 文件 | 用处 |
| --- | --- |
| `packages/embedding-onnx/src/reranker-manifest.ts` | 固定模型版本、文件大小和校验值 |
| `packages/embedding-onnx/scripts/install-reranker.mjs` | 显式下载并校验；召回时不自动下载 |
| `packages/embedding-onnx/src/onnx-reranker.ts` | 本地成对推理；预加载、有限批次、取消检查、资源释放 |
| `packages/memory/src/graph-core/recall/cross-encoder-selection.ts` | 将同一次评分复用于重排与证据筛选；严格校验 ID 和数值 |
| `packages/memory/src/graph-core/eval/cross-topic-comparison.ts` | 保留 A–F 基线，新增 G/H 真实模型对照与逐候选分数、耗时 |

模型必须在召回预算开始前加载。每次最多处理 256 个候选，默认每批 4 对；每对总长超过 512 tokens 时拒绝整个请求，不静默截断。底层正在执行的 ONNX 批次不能被瞬时打断，但批次前后都检查取消信号，过期结果不会返回或进入评分缓存。忙碌时拒绝新评分，不无限排队。缓存只保留最近一次查询、精确候选 ID/正文与模型版本对应的分数，不持久化正文。

`createCrossEncoderSelection(model, { minLogit })` 返回兼容现有接口的 `reranker` 和 `evidenceSelector`。只接 `reranker` 不会放宽原准入规则；同时接入 `evidenceSelector` 才能让低余弦候选依据独立相关性评分进入证据选择。访问、版本、来源及时间检查仍由现有 L1/L2 接口执行。

当前筛选规则是实验性 logit 门槛，首轮预先固定为 0。它不等于“答案正确概率 50%”，不提供语义充分性证明，也没有独立数据校准。因此它还不能替代完整的可回答性判断。

## 复现

从仓库根目录执行，路径按本机安装情况替换：

```powershell
node packages/embedding-onnx/scripts/install-reranker.mjs --directory '<本地重排模型目录>'
node packages/embedding-onnx/scripts/check-reranker.mjs --directory '<本地重排模型目录>'
node packages/memory/src/graph-core/eval/run-cross-topic-model.mjs --model-dir '<现有向量模型目录>' --reranker-dir '<本地重排模型目录>' --min-logit 0 --report '<报告.json>'
```

只有第一条命令下载公开模型；后两条使用离线模型和合成记忆。未配置 `--reranker-dir` 时仍只跑 A–F。新报告 schema 为 v3，记录模型版本、预加载时间、实验门槛、每批评分耗时及筛选失败。超时或评分器错误不能因恰好返回空集合而被计为“无答案正确”。

## 2026-10-01 真实模型结果

沿用 31 个合成问题、相同候选上限和 2 秒召回预算，评分调用保留默认 300ms 上限，未放宽预算，也未按这些题目调阈值。

| 路线 | 最终证据集合完全匹配 | 多返回错误证据的用例 | 评分失败 |
| --- | --- | --- | --- |
| F：局部宽候选＋原输出规则 | 15/29 | 0 | 0 |
| G：F＋真实模型重排 | 15/29 | 0 | 0 |
| H：真实模型重排＋logit≥0 筛选 | 20/29 | 3 | 0 |

三组候选完整覆盖均为 20/21。权限/删除/版本等既定边界检查均为 31/31，但这不代表“问谁答谁”已经正确：同一用户的记忆中可以合法包含其他人的事实，相关性模型仍会误选。

H 的错误包括：

- “我喜欢喝什么”额外返回小林的饮料偏好。现有实体目标规划不处理句中的单字代词“我”；模型没有替代身份绑定的能力。
- “小林做什么工作”额外返回小林的饮料偏好。相关不等于回答了所问属性。
- 更新用例额外返回另一种饮料偏好。旧版本没有泄露，但返回集合多于题目需要。

H 的 29 次实际评分中位耗时约 157ms，最大约 214ms；这是本机、最多 9 个短候选的小样本，不能推断 64 个长候选也能满足 300ms。保留逐次耗时，不作为稳定服务时延结论。

345 项无模型回归及原有 12 个直接召回用例通过；6 项真实本地运行检查通过。embedding-onnx、memory 类型检查通过；桌面 main 使用既有跨包配置覆盖参数后通过。未执行完整桌面打包或开启真实用户问答实验。

## 结论与下一步

真实模型能补回部分改写问题的相关事实，但当前筛选门槛引入了错误额外证据，故不切换桌面默认策略。下一轮优先补齐可信的当前用户→L1 实体绑定和所问属性约束，再用独立开发集校准筛选策略，并保留独立测试集。不要仅为了消除这里的 3 个错误调整门槛、添加饮料专用规则或固定只返回第一名；这会掩盖多答案与其他主题的缺口。
