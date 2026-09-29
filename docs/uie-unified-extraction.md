# 统一 UIE 提取入口

桌面、CLI、HTTP server 和 MCP 使用 `@continuum-memory/memory` 的同一套本地
UIE-base 模型桥接及结果转换。模型成功时保留规则提取的既有记忆候选，并附加
`requiresReview: true` 的 UIE 候选；模型不可用、超时、输出异常或图记录失败时
仅返回规则候选。UIE 候选不会因模型分数高而自动写成已确认事实。

## 配置

CLI、server、MCP 读取以下环境变量；桌面仍可从 `config.json` 配置同名模型路径。

- `CONTINUUM_MEMORY_UIE_PYTHON`：Python 虚拟环境中 `python.exe` 的绝对路径。
- `CONTINUUM_MEMORY_UIE_MODEL_PATH`：直接指向包含 `model_state.pdparams` 的
  UIE-base Taskflow checkpoint 目录；或使用 `CONTINUUM_MEMORY_UIE_MODEL_HOME`
  指向包含 `taskflow/information_extraction/uie-base` 的模型根目录。
- `CONTINUUM_MEMORY_UIE_SCRIPT_PATH`：仅在自定义部署布局时覆盖共享 Python 桥接脚本路径。

Windows 开发机在没有显式配置时沿用 `D:\Models\UIE-mini` 的既有默认位置；
其他环境找不到模型时自动使用规则提取。Python 桥接在同一进程内复用已加载的
Taskflow，并顺序处理请求；空闲五分钟后释放。冷启动仍可能较慢，不能据此保证
聊天或批量写入的低延迟。

## 各入口边界

- 桌面：自动捕获在所有提取模式下尝试 UIE。规则候选照常参与原有记忆写入；
  UIE 图结果按图提取开关进入现有加密记录、身份确认和 L1 审核流程。
  `uie` 模式仍强制保存图候选；`smart` 模式保留额外的聊天模型提取。
- CLI/server：自动捕获运行 UIE + 规则组合，但目前只有 V3 存储。UIE 候选在
  保守校验中隔离，尚无可发布的 L1 审核仓库；不能把“已调用 UIE”等同于“已入图”。
- MCP：`remember` 仍只保存用户明确提交的原句。UIE 提取结果作为未审核建议返回，
  不写入图；失败时仍保存原句并报告规则模式。

进一步统一 L1 发布需要为 CLI/server/MCP 分别接入有作用域隔离的原文捕获、
加密图提取存储、身份确认和审核入口，而不是放宽 `requiresReview` 写入策略。
