# 本地 UIE-base 实体与信息提取

在桌面版“方案 A 设置 → 事实提取”选择“本地 UIE-base”。该模式保留原有规则抽取，并用本地 PaddleNLP `uie-base` 补充实体、字段和主体—关系—客体候选。选择前要求 V4 影子存储及候选审核服务可用；模型失败时回退到规则抽取。

默认使用本机路径：

```json
{
  "uiePythonPath": "D:\\Models\\UIE-mini\\.venv-paddle\\Scripts\\python.exe",
  "uieModelHome": "D:\\Models\\UIE-mini"
}
```

也可在 `config.json` 改路径，或设置 `CONTINUUM_MEMORY_UIE_PYTHON` 与 `CONTINUUM_MEMORY_UIE_MODEL_HOME`。模型目录应包含 `taskflow/information_extraction/uie-base/model_state.pdparams`。打包版内置 Python 桥接脚本，但 Python 环境和权重仍由本机提供；不自动下载。

“试提取实体与信息”仅做本地预览，不写入记忆。输出分为 `entities`、`fields`、`relations`；每项保留原文片段、Unicode 码点起止位置和模型分数。正式 UIE 模式中，原有规则候选优先；UIE 新增字段和关系只进入 V4 待审核列表，用户明确批准前不会成为正式 V3 记忆或 L2 图边。实体提及不会单独写成长期事实。重处理仍保持这一审核限制。

当前 schema 覆盖测试集中的影视、图书、歌曲、人物、机构等 25 类关系，以及姓名、职业、所在地、喜好、当前项目字段。它是固定的第一版 schema，不代表模型可从任意文本可靠识别任意关系。已观察到“在某公司工作、住在上海”被误联为“公司总部在上海”，因此不能仅凭模型分数自动发布关系。抽取一次需启动本地 Python 进程；输入上限 4000 字，超时 60 秒时自动回退规则。
