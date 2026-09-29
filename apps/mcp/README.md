# Codex 本地 MCP 验证入口

`server.ts` 通过 STDIO 向 Codex 提供 `remember`、`recall`、`list`、`forget` 四个工具，复用现有 V3 记忆存储、内容安全检查和召回逻辑。作用域固定为 `ownerId=local-user`、`agentId=codex`；工具参数不能切换到其他用户或 Agent。`remember` 会尝试本地 UIE-base，并在返回值中标出未审核建议；模型失败时回退规则，但明确提交的原句仍按原有手动写入语义保存。UIE 建议不存入图。

启动前必须设置 `CONTINUUM_MEMORY_MCP_DATA_PATH`，并用 Node.js 和 `tsx` 运行 `server.ts`。本验证入口把数据存为本地 JSON 明文，因此只用于虚构测试数据；`forget` 是逻辑删除，记录仍保留在文件中。它不会自动读取或保存 Codex 对话。

在 Codex 中把它注册为 STDIO MCP 服务后，新会话可调用上述四个工具。注册命令应指向本机实际的 Node.js、`tsx/dist/cli.mjs` 和 `server.ts` 绝对路径，并通过 `--env CONTINUUM_MEMORY_MCP_DATA_PATH=...` 指定独立测试数据文件。
