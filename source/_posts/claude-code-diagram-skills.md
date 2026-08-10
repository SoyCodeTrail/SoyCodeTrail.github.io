---
title: 用 5 种 AI 绘图 Skill 画 Claude Code 架构图——效果对比与选型指南
category: agent
platform: web
tags: ["Claude Code", "架构图", "Mermaid", "Excalidraw", "绘图工具", "AI"]
readTime: 15分钟
featured: true
date: 2026-08-03
---

# 用 5 种 AI 绘图 Skill 画同一个架构

画技术图是 AI 编程助手的常见需求——架构图、时序图、类图、流程图。但不同的绘图 Skill 风格和适用场景差异很大。

我用 **Claude Code 的架构**作为主题，分别用 5 个绘图 Skill 画了图，放到一起对比。看完你就知道该选哪个。

## Claude Code 是什么

Claude Code 是 Anthropic 出的 AI 编程助手，运行在终端里。它的核心架构：

- **用户交互层**：Terminal CLI + 斜杠命令 + 流式输出
- **AI 推理层**：调 Claude API + 流式解析 + 工具调用路由
- **工具执行层**：文件操作（Read/Write/Edit）+ Shell（Bash）+ 搜索（Grep/Glob）+ 子 Agent + Web
- **基础设施层**：MCP 协议 + 权限控制 + CLAUDE.md 项目记忆 + Git 集成

工作流程：用户输入 → 加入上下文 → 发 Claude API → 如果返回 tool_use 就执行工具 → 结果回传给 AI → 循环直到输出最终文本。

下面用 5 种 Skill 分别画这个架构。

---

## Skill 1：interactive-sequence-diagram（交互式时序图）

**风格**：Mermaid 渲染，蓝灰专业风，支持 5 主题切换、pan/zoom、搜索高亮、逐步回放。

**适合**：展示组件间的调用顺序和数据流向。

![Claude Code 请求处理时序图](https://soycodetrail.top/images/claude-code/claude-code-sequence.png)

这张图展示了从用户输入到最终输出的完整时序，包括工具调用循环。4 个阶段用不同颜色块标注：用户输入 → 发送 AI → 工具调用循环 → 输出结果。

**优点**：交互性强，可以搜索方法名、过滤参与者、逐步回放。最适合代码级调用链分析。
**缺点**：只能画时序图，不能画架构拓扑。

---

## Skill 2：interactive-class-diagram（交互式类图）

**风格**：Mermaid classDiagram，UML 标准风格，支持类过滤、点击复制类名。

**适合**：展示类的继承/组合/依赖关系。

![Claude Code 核心类关系图](https://soycodetrail.top/images/claude-code/claude-code-classes.png)

这张图把 Claude Code 的 13 个核心类按 4 个 namespace 分组（UserInterface / AIInference / ToolExecutor / Infrastructure），用箭头标注了组合和依赖关系。

**优点**：UML 标准格式，开发者熟悉。点击类名可以直接复制方便 grep 源码。
**缺点**：只能画类关系，不适合画数据流。

---

## Skill 3：fireworks-tech-graph（几何科技风）

**风格**：几何校验型技术示意图，支持 SVG/PNG/HTML 多格式输出和 GIF 动效。

**适合**：需要高精度几何排布的技术图，支持动画展示数据流。

![Claude Code 工具调用流程图](https://soycodetrail.top/images/claude-code/claude-code-tool-use.png)

这张图用 fireworks 的 Flat Icon 主题，展示了工具调用流程：用户输入 → Claude API → tool_use 路由 → 各类工具执行 → 结果回传循环。

**优点**：唯一支持 GIF 动效的 Skill，几何排布精确（有质量校验），输出格式最全。
**缺点**：配置复杂，学习曲线陡。

---

## Skill 4：architecture-diagram（深色工程架构图）

**风格**：固定深色主题（#020617 背景 + 网格），JetBrains Mono 字体，按组件类型语义配色。

**适合**：系统/基础设施/云架构的分层拓扑图，适合做 PPT 和文档头图。

![Claude Code 分层架构图](https://soycodetrail.top/images/claude-code/claude-code-architecture.png)

这张图用深色工程风展示 Claude Code 的 5 层架构，每层用语义配色（UI 青/Service 绿/AI 紫/Tool 琥珀/Infra 灰），箭头表示控制流和数据流，包括工具结果回流和权限校验回路。

**优点**：视觉最专业，固定深色主题适合技术演讲。自包含 HTML 无外部依赖。
**缺点**：风格固定，不能自定义主题。只适合架构拓扑，不适合时序/类关系。

---

## Skill 5：excalidraw-diagram-generator（手绘风格）

**风格**：Excalidraw 原生手绘风格，粗糙线条（roughness=1），温暖亲切。

**适合**：教学演示、博客配图、需要二次手动编辑的场景。

这是用 Excalidraw 官方引擎渲染的**真正的手绘风**（roughness=1，57 个元素）：

![Claude Code 架构图（Excalidraw 手绘风）](https://soycodetrail.top/images/claude-code/claude-code-excalidraw.png)

同时提供原生的 `.excalidraw` 文件（49KB），可以导入 [excalidraw.com](https://excalidraw.com) 打开手动编辑：

[下载 .excalidraw 文件](https://soycodetrail.top/images/claude-code/claude-code-excalidraw.excalidraw)

**优点**：唯一可以后续手动编辑的格式。手绘风格适合教学和轻场景。图表类型覆盖最广（流程/关系/思维导图/架构/泳道/类图/时序/ER）。
**缺点**：不能直接嵌入网页，用户需要下载后到 excalidraw.com 打开。

---

## 5 种 Skill 横向对比

| Skill | 输出格式 | 风格 | 最佳场景 | 可编辑 | 动效 |
|---|---|---|---|---|---|
| interactive-sequence | HTML + MD | Mermaid 蓝灰 | 时序调用链 | 改 Mermaid 源码 | 逐步回放 |
| interactive-class | HTML + MD | Mermaid UML | 类关系图 | 改 Mermaid 源码 | ❌ |
| fireworks-tech-graph | SVG + PNG + HTML | 几何科技风 | 精确技术示意图 | 改 JSON | GIF 动效 |
| architecture-diagram | HTML（内联 SVG） | 深色工程风 | 分层架构拓扑 | 改 SVG | ❌ |
| excalidraw | .excalidraw JSON | 手绘风 | 教学/博客/草稿 | Excalidraw 编辑器 | ❌ |

## 选型建议

- **画代码调用链** → interactive-sequence-diagram
- **画类继承关系** → interactive-class-diagram
- **画系统分层架构** → architecture-diagram
- **需要动画展示数据流** → fireworks-tech-graph
- **需要手绘风/可编辑** → excalidraw-diagram-generator
- **不确定选哪个** → 先用 excalidraw 草稿，定稿后用 architecture-diagram 出正式版

## 交互式 HTML 体验

除了 PNG 图片，时序图和类图还有交互式 HTML 版本（支持 5 主题切换、pan/zoom、搜索、回放）：

- [时序图 HTML](https://soycodetrail.top/images/claude-code/claude-code-sequence.html)
- [类图 HTML](https://soycodetrail.top/images/claude-code/claude-code-classes.html)

下载到本地用浏览器打开即可体验全部交互功能。
