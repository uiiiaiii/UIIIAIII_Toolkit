# UIIIAIII Toolkit

A ComfyUI custom node pack: a powerful **node category manager**, multi-language **UI translation** for nodes and plugins, plus a set of bundled **API media nodes**.

[中文说明见下方](#中文说明)

## Features

### Node Category Manager

Manage cluttered node categories directly in the node library tree (left sidebar):

- **Right-click** any category or node (default `Alt + Right-click`) to open the manage menu:
  - New subcategory / new top-level category (empty categories, fill them by dragging)
  - Rename, delete (move nodes out first), hide, restore to default
  - View hidden items, restore all categories
- **Drag & drop** to move nodes or whole categories; drop on the upper half of a row to **sort** before it
- Whole categories carry their subcategories and moved-in nodes when dragged
- All rules are stored as language-independent base paths and apply instantly (hot reload, no page refresh needed)
- Configurable drag button: `Alt + Right-click` (default) or plain `Right-click`

### Node & Plugin Translation

- Translates ComfyUI menus, settings, node titles, inputs/outputs/widgets, and dropdown options into Chinese (and other languages)
- Per-plugin translation management panel with search, enable/disable, and a built-in translation generator (OpenAI-compatible API)
- Translation dictionary reuse keeps terminology consistent across runs

> **Attribution**: The translation feature is derived from [AIGODLIKE-ComfyUI-Translation](https://github.com/AIGODLIKE/AIGODLIKE-ComfyUI-Translation) and ComfyUI-DD-Translation, with modifications. Thanks to the original authors.

### Bundled Nodes

| Node | Description |
|---|---|
| Agnes Text to Image / Image to Image | Generate or edit images via the Agnes Image 2.1 Flash API |
| Agnes Text to Video / Image to Video / Keyframe Animation | Video generation via the Agnes Video V2.0 API |
| Qwen Image 2.1 | Unified text-to-image generation and image editing (up to 4 reference images) via ModelScope API-Inference |
| Qwen Image Edit | Image editing via Qwen-Image-Edit-2511 (ModelScope API-Inference) |
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

ComfyUI 自定义节点合集：强大的**节点分类管理**、节点与插件的多语言**界面翻译**，以及一组内置 **API 媒体节点**。

## 功能

### 节点分类管理

在左侧节点库树中直接整理混乱的分类：

- **右键**（默认 `Alt + 右键`）分类或节点打开管理菜单：
  - 新建子分类 / 新建主分类（空分类，拖入内容后转正）
  - 重命名、删除（节点先移出）、隐藏、恢复默认
  - 查看已隐藏列表、恢复所有分类
- **拖拽**移动节点或整个分类；拖到某行**上半部**即可排序到它前面
- 拖动父分类时，其子分类与已移入的节点整体跟随
- 规则以与界面语言无关的基准路径存储，实时生效（无需刷新页面）
- 拖拽按键可配置：`Alt + 右键`（默认）或纯 `右键`

### 节点与插件翻译

- 翻译 ComfyUI 菜单、设置、节点标题、输入/输出/控件与下拉选项
- 按插件管理翻译：搜索、启用/禁用、内置翻译生成器（OpenAI 兼容 API）
- 翻译字典复用，保证术语一致

> **来源声明**：翻译功能基于 [AIGODLIKE-ComfyUI-Translation](https://github.com/AIGODLIKE/AIGODLIKE-ComfyUI-Translation) 与 ComfyUI-DD-Translation 修改而来，感谢原作者。

### 内置节点

| 节点 | 说明 |
|---|---|
| Agnes 文生图 / 图生图 | 通过 Agnes Image 2.1 Flash API 生成或编辑图像 |
| Agnes 文生视频 / 图生视频 / 关键帧动画 | 通过 Agnes Video V2.0 API 生成视频 |
| Qwen Image 2.1 | 文生图与图像编辑统一模型（最多 4 张参考图），ModelScope API |
| Qwen Image Edit | Qwen-Image-Edit-2511 图像编辑（ModelScope API） |
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
