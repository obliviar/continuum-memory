# PDF 与 Word Skill

桌面内置 `PDF 文档` 和 `Word 文档` 两个可调用工作流。输入区的纸夹按钮选择 PDF / DOCX，“文档”按钮查看当前对话的已选文件和生成结果。选择工作流后，可以要求聊天模型读取、总结或生成新文件；模型通过固定文档工具完成实际操作。

## 当前能力

- `document_list`：列出当前对话登记的文件。
- `document_read`：读取 PDF 指定页的文字，或 DOCX 按顺序的段落、标题和表格。默认最多 12,000 字符；PDF 默认前五页，每次最多二十页。结果标记截断和扫描件限制。
- `document_create`：生成独立的新 PDF / DOCX，支持标题、段落、列表及表格，不覆盖原件。输出会重新打开并进行结构验证。
- `document_preview`：PDF 生成前三页的 PNG；Word 返回段落/表格结构预览，不代表真实 Word 分页。
- 桌面文档面板提供预览、打开文件和查看位置。PDF 图片本地显示；模型收到图片位置并不表示它已经视觉检查过页面。

不支持旧 `.doc`、宏、修订批注、复杂公式、扫描 PDF 的 OCR、签名/加密 PDF 的编辑或 PDF 表单填写。原有 Codex 完整文档 Skill 仍保留其专用依赖提示；新增的是适配桌面工具的 PDF/Word 工作流。

## 运行时

使用应用自带的固定 `resources/document_tools.py`，不执行 Skill 提供的任意脚本。处理请求为 JSON 数据，子进程以 `shell:false` 启动，限定大小和超时时间，并统一 UTF-8。

Python 依赖：`python-docx`、`pypdf`、`reportlab`。PDF 页面预览需要 Poppler 的 `pdftoppm`。当前机器自动发现 Codex 的预装依赖；其他部署可配置：

- `CONTINUUM_MEMORY_DOCUMENT_PYTHON`：安装这些库的 Python 可执行文件路径。
- `CONTINUUM_MEMORY_PDF_RENDERER`：`pdftoppm` 可执行文件路径。

打包时会复制固定处理脚本；不会自动下载 Python 或依赖。启动探测缺少依赖时，对应 Skill 显示不可用。

## 文件与分区

每个对话在其分区下独立保存 `documents/inputs`、`documents/outputs` 和 `documents/previews`。输入由用户通过选择框登记并复制为稳定副本，模型仅能用当前分区的 `document_id` 调用文档工具。

目录索引使用系统保护的 `documents.enc`；PDF/DOCX/PNG 文件按原格式保存，便于本机打开，不属于加密记忆正文。文档读取与模型生成内容不会自动发布为 L1/L2。读取任务所需的文本按工具调用传给当前 API。

文档工具禁止以任意路径读取、跨分区 ID 访问、路径式输出名或覆盖原文件；读取和预览核对实际文件路径。每次选择最多十个、不超过 20 MB 的 PDF / DOCX。

## 验证

真实 Python 测试覆盖中文 PDF/DOCX 生成与读取、表格、PDF 页面渲染、非法内容、路径逃逸、导入、分区隔离和索引恢复。Electron 模拟 API 测试通过实际模型函数调用生成两种格式，并确认预览图加载、Word 结构显示及重启恢复。Word 的真实分页视觉检查需要在 Word 中完成。

文档与 Skill 专项 12 项通过；类型检查和构建通过。全量回归中 967 项通过、17 项跳过，既有性能测试首次 P95 为 101.16 ms（门槛 100 ms），单独复测为 97.48 ms 并通过。另新增的多步工具工作流测试通过，未放宽原性能阈值。
