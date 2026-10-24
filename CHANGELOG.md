# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-24

### Added

- 侧边栏 / 编辑器标签双形态桌宠面板，共享同一段对话。
- 内置矢量形象：呼吸、眨眼、摆尾、开心、警觉、思考、害羞、打盹等动画。
- 点击桌宠播放音效并增加好感度；长时间编码会提醒休息。
- 三种 AI 后端：Ollama、任意 OpenAI 兼容接口、VS Code 语言模型 API。
- 流式对话、Markdown 渲染、代码块一键复制、对话历史持久化。
- 代码辅助命令：讲解、诊断修复、重构、生成测试、生成 Git 提交信息。
- 保存文件 / 出现报错时桌宠主动反应，并可直接触发修复流程。
- 资料查询：支持直接抓取 URL；可选 Tavily / Serper 联网搜索。
- 形象库：导入 Live2D（model3.json）、VRM/GLB、单张图片；一键切换。
- 按需加载的 Live2D（PixiJS）与 3D（three.js + three-vrm）渲染器。
- 音效库：按场景绑定自定义音效，未绑定则使用内置合成音。
- 系统语音合成朗读回复，语速与音量可调。
- 默认立绘 / 默认音效的打包约定（`assets/default`、`assets/sounds`）。
- 随包附带默认形象（金属水管贴纸）与点击音效（金属管敲击声）。
