# UIIIAIII Toolkit

A ComfyUI toolkit that keeps the node library organized and the interface readable — **category management first**, **full UI translation second**, and a set of **ready-to-use API media nodes** on top.

[中文说明见下方](#中文说明)

## Overview

1. **Node Category Manager** — rename, move, sort, hide and restore categories and nodes directly in the sidebar tree, with drag & drop and hot-reload rules that are independent of the interface language.
2. **Node & Plugin Translation** — menus, settings, node titles, ports, widgets and dropdown options in Chinese (and other languages), with per-plugin control, a built-in generator and reusable dictionaries. ComfyUI Nodes 2.0 is supported.
3. **Bundled Nodes** — Agnes Image/Video and ModelScope image models with unified multi-input workflows, plus text, background and seed utilities.

## 1. Node Category Manager

Manage cluttered node categories directly in the node library tree (left sidebar):

### Quick start

1. `Alt + Right-click` (default) a category or node to open the manage menu.
2. Drag nodes into an empty category to fill it.
3. Drop a node or category on the upper half of a row to sort it before that row.

### Details

- **Right-click menu**:
  - New subcategory / new top-level category (empty categories, fill them by dragging)
  - Rename, delete (move nodes out first), hide, restore to default
  - View hidden items, restore all categories
- **Drag & drop** to move nodes or whole categories
- Whole categories carry their subcategories and moved-in nodes when dragged
- Rules are stored as language-independent base paths and apply instantly (hot reload, no page refresh needed)
- Configurable drag button: `Alt + Right-click` (default) or plain `Right-click`

## 2. Node & Plugin Translation

- Translates ComfyUI menus, settings, node titles, inputs/outputs/widgets, and dropdown options into Chinese (and other languages)
- Per-plugin translation management panel with search, enable/disable, and a built-in translation generator (OpenAI-compatible API)
- Translation dictionary reuse keeps terminology consistent across runs
- **Nodes 2.0 support**: node titles, ports and widget names are translated through ComfyUI's official i18n language pack, generated from the same dictionaries
- Subgraph container labels are protected: user-defined input names are never replaced by widget translations
- The plugin itself stays English-first and is translated by its own translation feature, so the translation can be toggled independently of ComfyUI's UI language

> **Attribution**: The translation feature is derived from [AIGODLIKE-ComfyUI-Translation](https://github.com/AIGODLIKE/AIGODLIKE-ComfyUI-Translation) and ComfyUI-DD-Translation, with modifications. Thanks to the original authors.

## 3. Bundled Nodes

### Agnes AI

| Node | Description |
|---|---|
| Agnes Image (2.5 / 2.1 Flash) | One node for text-to-image, image editing and multi-image composition; switch models with the `model` dropdown. Reference image inputs expand as you connect them (up to 5) |
| Agnes Video (2.5 Flash) | One node for text-to-video, first/last-frame control, and reference images/audio (fixed 720P) |

### ModelScope API-Inference

| Node | Description |
|---|---|
| Qwen Image 2.1 | Unified text-to-image generation and image editing (up to 4 reference images, progressive inputs) |
| Qwen Image Edit | Image editing via Qwen-Image-Edit-2511 (up to 3 reference images, progressive inputs) |
| Krea 2 Turbo | Text-to-image generation via krea/Krea-2-Turbo |
| Z-Image Turbo | Text-to-image generation via Tongyi-MAI/Z-Image-Turbo |
| MOSS Image SFT | Text-to-image generation via openmoss/MOSS-Image-SFT (natural language, tags or JSON layout prompts) |
| MiniMax H3 Image | Text-to-image and image editing via MiniMax-H3-Image (up to 16 reference images, progressive inputs) |

### Utilities

| Node | Description |
|---|---|
| Text Input/Preview | Two-in-one text node with upstream auto-sync |
| Background Fill | Compose a foreground onto a solid color or background image, with feathering |
| Random Noise Seed | Random noise seed node (same as ComfyUI's RandomNoise) |

## Installation

### Via ComfyUI Manager (recommended)

Search for **UIIIAIII Toolkit** in ComfyUI-Manager and install.

### Manual

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/uiiiaiii/UIIIAIII_Toolkit.git
```

Then restart ComfyUI.

## Configuration

- **Agnes API Key**: `ComfyUI Settings → UIIIAIII Toolkit → ① Node API`
- **ModelScope API Token**: same place; get one at <https://modelscope.cn/my/myaccesstoken>
- **Translation API** (optional, for generating translations): `ComfyUI Settings → UIIIAIII Toolkit → ② Translation API`

## License

[GPL-3.0](LICENSE)

---

# 中文说明

一个让 ComfyUI 节点库更整齐、界面更易读的工具包：**优先解决分类管理**，其次是**完整的界面翻译**，最后附带一组**开箱可用的 API 媒体节点**。

## 概览

1. **节点分类管理**：在左侧节点库树中重命名、移动、排序、隐藏、恢复分类与节点，支持拖拽与实时生效规则，且规则与界面语言无关。
2. **节点与插件翻译**：菜单、设置、节点标题、端口、控件与下拉选项的中文（及其他语言）翻译，支持按插件管理、内置生成器与字典复用，兼容 ComfyUI Nodes 2.0。
3. **内置节点**：Agnes 图像/视频与 ModelScope 图像模型，统一的多输入工作流，另有文本、背景、种子等实用节点。

## 1. 节点分类管理

在左侧节点库树中直接整理混乱的分类：

### 三步上手

1. `Alt + 右键`（默认）分类或节点，打开管理菜单。
2. 把节点拖进空分类即可转正。
3. 拖到某行**上半部**即可排序到它前面。

### 详细功能

- **右键菜单**：
  - 新建子分类 / 新建主分类（空分类，拖入内容后转正）
  - 重命名、删除（节点先移出）、隐藏、恢复默认
  - 查看已隐藏列表、恢复所有分类
- **拖拽**移动节点或整个分类
- 拖动父分类时，其子分类与已移入的节点整体跟随
- 规则以与界面语言无关的基准路径存储，实时生效（无需刷新页面）
- 拖拽按键可配置：`Alt + 右键`（默认）或纯 `右键`

## 2. 节点与插件翻译

- 翻译 ComfyUI 菜单、设置、节点标题、输入/输出/控件与下拉选项
- 按插件管理翻译：搜索、启用/禁用、内置翻译生成器（OpenAI 兼容 API）
- 翻译字典复用，保证术语一致
- **支持 Nodes 2.0**：节点标题、端口与控件名通过 ComfyUI 官方 i18n 语言包翻译，语言包由同一套字典生成
- 子图容器标签受保护：用户自定义的输入名不会被控件译文覆盖
- 插件自身保持英文原版，通过自身翻译功能翻译，切换语言不依赖 ComfyUI 界面语言设置

> **来源声明**：翻译功能基于 [AIGODLIKE-ComfyUI-Translation](https://github.com/AIGODLIKE/AIGODLIKE-ComfyUI-Translation) 与 ComfyUI-DD-Translation 修改而来，感谢原作者。

## 3. 内置节点

### Agnes AI

| 节点 | 说明 |
|---|---|
| Agnes 图像（2.5 / 2.1 Flash） | 文生图、图生图与多图合成合一，`model` 下拉切换模型；参考图插槽随连接逐级展开（最多 5 张） |
| Agnes 视频（2.5 Flash） | 文生视频 / 首尾帧控制 / 参考图片与音频合一（固定 720P） |

### ModelScope API-Inference

| 节点 | 说明 |
|---|---|
| Qwen Image 2.1 | 文生图与图像编辑统一模型（最多 4 张参考图，逐级展开） |
| Qwen Image Edit | Qwen-Image-Edit-2511 图像编辑（最多 3 张参考图，逐级展开） |
| Krea 2 Turbo | krea/Krea-2-Turbo 文生图 |
| Z-Image Turbo | Tongyi-MAI/Z-Image-Turbo 文生图 |
| MOSS Image SFT | openmoss/MOSS-Image-SFT 文生图（支持自然语言、标签序列或 JSON 布局提示词） |
| MiniMax H3 图像 | MiniMax-H3-Image 文生图与图像编辑（最多 16 张参考图，逐级展开） |

### 实用工具

| 节点 | 说明 |
|---|---|
| 文本输入/预览 | 二合一文本节点，支持上游自动同步 |
| 背景填充 | 将前景合成到纯色或背景图上，支持羽化 |
| 随机噪波种子 | 与 ComfyUI 官方 RandomNoise 一致 |

## 安装

### 通过 ComfyUI Manager（推荐）

在 ComfyUI-Manager 中搜索 **UIIIAIII Toolkit** 安装。

### 手动安装

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/uiiiaiii/UIIIAIII_Toolkit.git
```

重启 ComfyUI 即可。

## 配置

- **Agnes API Key**：`ComfyUI 设置 → UIIIAIII Toolkit → ① 节点API`
- **ModelScope API Token**：同上；获取地址 <https://modelscope.cn/my/myaccesstoken>
- **翻译 API**（可选，用于生成翻译）：`ComfyUI 设置 → UIIIAIII Toolkit → ② 翻译API`

## 许可证

[GPL-3.0](LICENSE)
