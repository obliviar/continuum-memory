# 应用图标

六款预设主题共用已确认的“记忆环”设计，使用设计稿原有图形、配色与光感。

## 资源与入口

- 原始设计稿：`resources/branding/continuum-icons-approved-v1.png`。
- 运行时图标：`src/renderer/public/brand/icons/`，构建时复制到 `dist/renderer/brand/icons/`。
- 每款均提供透明背景的 256px PNG 和包含 16、20、24、32、40、48、64、128、256px 的 ICO。
- 桌面快捷方式和打包程序默认使用 `continuum-memory-v1.ico`（松石与纸白）。
- 程序窗口、侧栏、聊天头像、空白页与主题选择器使用对应主题的图标；切换主题后即时更新。
- 自定义颜色继续使用可着色的矢量标志，窗口图标回退到品牌默认款。

## 构建与维护

`scripts/generate-app-icons.cjs` 使用 Electron 从确认稿提取图标，保留原始图形与材质，不重新生成画面。`manifest.json` 记录来源校验值、取图范围与 ICO 尺寸。

在正常终端中执行 `pnpm icons:generate` 可以重新生成资源；若环境设置了 `ELECTRON_RUN_AS_NODE`，需先移除该变量。

`package.json` 已配置 Windows 图标。项目保持原有的独立资源编辑流程：`scripts/package-versioned.ps1` 在写入版本信息时，同时通过 rcedit 将默认 ICO 写入打包 EXE。
