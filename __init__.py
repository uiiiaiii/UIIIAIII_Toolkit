"""
UIIIAIII Toolkit 自定义节点插件（由 ComfyUI-API 更名而来）

将多个自定义 API 打包为 ComfyUI 节点：

Agnes AI（https://agnes-ai.cn）：
- Agnes Image 2.1 Flash（文生图、图生图）
- Agnes Video V2.0（文生视频、图生视频、关键帧动画）

ModelScope（https://www.modelscope.cn）：
- Qwen-Image-Edit-2511（图像编辑）

文档参考：
- https://agnes-ai.cn/zh-Hans/docs/agnes-image-21-flash
- https://agnes-ai.cn/zh-Hans/docs/agnes-video-v20
- https://www.modelscope.cn/models/Qwen/Qwen-Image-Edit-2511

API Key 配置（以下方式任选其一）：
- 在 ComfyUI 设置 → UIIIAIII Toolkit → 节点API 中统一配置
- 在节点的 api_key 参数中填入
- 设置环境变量 AGNES_API_KEY / MODELSCOPE_API_TOKEN
"""

import logging
import json

# 设置日志
logger = logging.getLogger("UIIIAIII Toolkit")

# 导入节点定义和映射
from .nodes import (
    NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS,
)

# 导入 API 客户端（便于外部调用）
from . import agnes_client
from . import qwen_client
from . import config
from . import translator as translator_client
from . import node_extractor
from . import translation_writer
from . import translation_service  # 注册 /translation_node/* 界面翻译端点

# 插件版本
__version__ = "1.3.0"

# 插件信息
PLUGIN_INFO = {
    "name": "UIIIAIII Toolkit",
    "version": __version__,
    "author": "UIIIAIII Toolkit",
    "description": "Multi-API custom nodes: Agnes AI (text-to-image / image-to-image / text-to-video / image-to-video / keyframe animation) + ModelScope Qwen-Image-2.1 (unified text-to-image and editing) and Qwen-Image-Edit-2511 (image editing)",
    "models": [
        "agnes-image-2.1-flash",
        "agnes-video-v2.0",
        "Qwen-Image-2.1",
        "Qwen-Image-Edit-2511",
    ],
}

# 前端资源目录（注册设置界面）
WEB_DIRECTORY = "./web"

# ============================================================
# 注册 API Key 配置端点
# ============================================================

try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.get("/agnes-api-keys")
    async def get_api_keys(request):
        """获取 API Key 配置（不返回完整 key，仅返回是否已配置）"""
        cfg = config.load_config()
        # 返回完整 key 供前端加载到设置项
        return web.json_response(cfg)

    @PromptServer.instance.routes.post("/agnes-api-keys")
    async def save_api_keys(request):
        """保存 API Key 配置"""
        try:
            data = await request.json()
            agnes_key = data.get("agnes_api_key", "")
            modelscope_key = data.get("modelscope_api_key", "")

            # 读取现有配置并更新
            cfg = config.load_config()
            cfg["agnes_api_key"] = agnes_key
            cfg["modelscope_api_key"] = modelscope_key

            success = config.save_config(cfg)
            if success:
                logger.info("API Key 配置已更新")
                return web.json_response({"status": "ok"})
            else:
                return web.json_response({"status": "error", "message": "Save failed"}, status=500)
        except Exception as e:
            logger.error("保存 API Key 配置异常：%s", e)
            return web.json_response({"status": "error", "message": str(e)}, status=500)

    logger.info("API Key 配置端点已注册：GET/POST /agnes-api-keys")

    # ============================================================
    # 翻译相关端点
    # ============================================================

    @PromptServer.instance.routes.get("/agnes-translate/status")
    async def translate_status(request):
        """获取翻译功能状态：API 配置 + 输出目录"""
        try:
            cfg = config.get_translator_config()
            output_status = translation_writer.get_output_status()
            return web.json_response({
                "translator_configured": bool(cfg["api_key"]),
                "base_url": cfg["base_url"],
                "model": cfg["model"],
                "output_mode": cfg["output_mode"],
                "target_lang": cfg.get("target_lang", "zh-CN"),
                "use_translated_dict": cfg.get("use_translated_dict", True),
                "output_status": output_status,
            })
        except Exception as e:
            logger.error("获取翻译状态失败：%s", e)
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.get("/agnes-translate/list-plugins")
    async def list_plugins(request):
        """列出 custom_nodes 下所有插件目录"""
        try:
            plugins = node_extractor.list_custom_plugins()
            # 运行时归属：按模块 __file__ 真实路径统计每个插件的已加载节点数
            # （对 MAPPINGS 定义在子模块/动态注册/sys.path 注入导入的插件均有效）
            runtime_counts: dict = {}
            try:
                runtime_map = node_extractor.get_runtime_nodes_by_plugin()
                runtime_counts = {k: len(v) for k, v in runtime_map.items()}
            except Exception as e:
                logger.warning("运行时节点归属统计失败：%s", e)
            # 为每个插件解析节点数量：AST 静态解析 与 运行时归属 取较大值
            import os
            for plugin in plugins:
                ast_count = 0
                try:
                    init_file = os.path.join(plugin["path"], "__init__.py")
                    class_names = node_extractor._parse_node_class_mappings_from_ast(init_file)
                    ast_count = len(class_names)
                except Exception:
                    ast_count = 0
                runtime_count = runtime_counts.get(plugin["name"], 0)
                plugin["node_count"] = max(ast_count, runtime_count)
            return web.json_response({"plugins": plugins})
        except Exception as e:
            logger.error("列出插件失败：%s", e)
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/agnes-translate/extract-selected")
    async def extract_selected(request):
        """
        提取画布选中节点的定义

        请求体 JSON：
        {"class_names": ["AgnesTextToImage", "AgnesImageToImage"]}
        """
        try:
            data = await request.json()
            class_names = data.get("class_names", [])
            if not class_names:
                return web.json_response({"error": "Missing class_names"}, status=400)

            result = node_extractor.extract_selected_nodes(class_names)

            # 同时提取分类
            categories = node_extractor.extract_categories_from_nodes(result["nodes"])

            return web.json_response({
                "nodes": result["nodes"],
                "not_found": result["not_found"],
                "categories": categories,
                "node_count": len(result["nodes"]),
            })
        except Exception as e:
            logger.error("提取选中节点失败：%s", e)
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/agnes-translate/extract-plugin")
    async def extract_plugin(request):
        """
        提取整个插件目录的节点定义

        请求体 JSON：
        {"plugin_name": "UIIIAIII Toolkit"}
        """
        try:
            data = await request.json()
            plugin_name = data.get("plugin_name", "")
            if not plugin_name:
                return web.json_response({"error": "Missing plugin_name"}, status=400)

            result = node_extractor.extract_plugin_nodes(plugin_name)

            # 同时提取分类
            categories = node_extractor.extract_categories_from_nodes(result["nodes"])

            # 同时提取菜单/UI 文本（扫描插件 web/ 目录下的 JS 文件）
            menus = node_extractor.extract_plugin_menus(plugin_name)

            return web.json_response({
                "plugin_name": result["plugin_name"],
                "plugin_path": result["plugin_path"],
                "nodes": result["nodes"],
                "not_loaded": result["not_loaded"],
                "categories": categories,
                "menus": menus,
                "node_count": len(result["nodes"]),
                "menu_count": len(menus),
            })
        except FileNotFoundError as e:
            return web.json_response({"error": str(e)}, status=404)
        except Exception as e:
            logger.error("提取插件节点失败：%s", e)
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/agnes-translate/translate")
    async def do_translate(request):
        """
        执行翻译并写入文件

        请求体 JSON：
        {
            "nodes": {...},            # 待翻译的节点定义
            "categories": {...},        # 可选，待翻译的分类
            "plugin_name": "..."        # 插件名（用作文件名）
        }
        """
        try:
            data = await request.json()
            nodes_data = data.get("nodes", {})
            categories_data = data.get("categories", {})
            menus_data = data.get("menus", {})
            plugin_name = data.get("plugin_name", "selected_nodes")
            # 读取 target_lang：优先用请求体传入的，否则用配置文件的
            # （输出固定写入本插件 locales，立即生效）
            translator_cfg = config.get_translator_config()
            target_lang = data.get("target_lang") or translator_cfg.get("target_lang", "zh-CN")

            if not nodes_data and not menus_data:
                return web.json_response({"error": "Nothing to translate"}, status=400)

            # 调用翻译 API（translator.py 内部会自动分批翻译节点和菜单）
            # 合并节点、分类、菜单到一个 JSON
            combined = {}
            if nodes_data:
                combined["nodes"] = nodes_data
            if categories_data:
                combined["categories"] = categories_data
            if menus_data:
                combined["menus"] = menus_data

            translated = translator_client.translate_nodes(combined)

            # 拆分结果
            translated_nodes = translated.get("nodes", {})
            translated_categories = translated.get("categories", {})
            translated_menus = translated.get("menus", {})

            # 写入文件（输出固定写入本插件 locales 目录）
            write_result = translation_writer.write_translation(
                plugin_name=plugin_name,
                translated_nodes=translated_nodes,
                translated_categories=translated_categories,
                translated_menus=translated_menus,
                target_lang=target_lang,
            )

            # 统计翻译比例
            input_node_count = len(nodes_data) if isinstance(nodes_data, dict) else 0
            input_menu_count = len(menus_data) if isinstance(menus_data, dict) else 0
            actual_translated_count = write_result.get("translated_count", len(translated_nodes))
            actual_menu_count = write_result.get("menu_count", len(translated_menus))
            missing_count = max(0, input_node_count - len(translated_nodes))

            return web.json_response({
                "status": write_result["status"],
                "mode": write_result["mode"],
                "nodes_file": write_result["nodes_file"],
                "categories_file": write_result["categories_file"],
                "menus_file": write_result.get("menus_file", ""),
                "message": write_result["message"],
                "input_count": input_node_count,              # 发送的节点数
                "translated_count": actual_translated_count,  # 实际写入的有效节点数
                "missing_count": missing_count,                # API 丢失的节点数（已用原文补全）
                "merged_count": write_result.get("merged_count", actual_translated_count),
                "menu_input_count": input_menu_count,         # 发送的菜单文本数
                "menu_translated_count": actual_menu_count,   # 实际翻译的菜单文本数
                "dict_hits": translated.get("dict_hits", 0),  # 复用已翻译字典的条目数
            })
        except Exception as e:
            logger.error("翻译失败：%s", e)
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/agnes-translate/config")
    async def save_translate_config(request):
        """保存翻译 API 配置"""
        try:
            data = await request.json()
            # 部分更新：仅覆盖请求体中显式提供的字段（如字典开关只传 use_translated_dict）
            use_dict = data.get("use_translated_dict")
            if isinstance(use_dict, str):
                use_dict = use_dict.lower() == "true"

            success = config.save_translator_config(
                base_url=data.get("base_url"),
                api_key=data.get("api_key"),
                model=data.get("model"),
                target_lang=data.get("target_lang"),
                use_translated_dict=use_dict,
            )
            if success:
                logger.info("翻译 API 配置已更新（目标语言：%s）", data.get("target_lang") or "未变更")
                return web.json_response({"status": "ok"})
            else:
                return web.json_response({"error": "Save failed"}, status=500)
        except Exception as e:
            logger.error("保存翻译配置失败：%s", e)
            return web.json_response({"error": str(e)}, status=500)

    logger.info("翻译功能端点已注册：/agnes-translate/*")

    # ============================================================
    # 节点分类管理端点（category_overrides.json 规则存取）
    # ============================================================

    import os as _os
    _CATEGORY_OVERRIDES_FILE = _os.path.join(_os.path.dirname(_os.path.abspath(__file__)), "category_overrides.json")

    @PromptServer.instance.routes.get("/uiiiaiii/category-overrides")
    async def get_category_overrides(request):
        """读取节点分类管理规则（无文件时返回空规则）"""
        try:
            if _os.path.isfile(_CATEGORY_OVERRIDES_FILE):
                with open(_CATEGORY_OVERRIDES_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                data.setdefault("empty_categories", [])
                data.setdefault("hidden_nodes", [])
                data.setdefault("order_rules", [])
                if "drag_trigger" not in data:
                    # 兼容旧字段 drag_modifier
                    data["drag_trigger"] = {"mouse": "right", "modifier": data.get("drag_modifier", "alt")}
                return web.json_response(data)
            return web.json_response({"category_rename": {}, "hidden_categories": [], "node_move": {}, "empty_categories": [], "hidden_nodes": [], "order_rules": [], "drag_trigger": {"mouse": "right", "modifier": "alt"}})
        except Exception as e:
            logger.error("读取分类规则失败：%s", e)
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/uiiiaiii/category-overrides")
    async def set_category_overrides(request):
        """保存节点分类管理规则（整体覆盖写入）"""
        try:
            data = await request.json()
            clean = {
                "category_rename": {str(k): str(v) for k, v in (data.get("category_rename") or {}).items() if k and v},
                "hidden_categories": [str(x) for x in (data.get("hidden_categories") or []) if x],
                "node_move": {str(k): str(v) for k, v in (data.get("node_move") or {}).items() if k and v},
                "empty_categories": list(dict.fromkeys(str(x) for x in (data.get("empty_categories") or []) if x)),
                "hidden_nodes": list(dict.fromkeys(str(x) for x in (data.get("hidden_nodes") or []) if x)),
            }
            # 排序规则：[{type: cat|node, key, before}]
            order_rules = []
            for r in (data.get("order_rules") or []):
                if not isinstance(r, dict):
                    continue
                t, k, b = str(r.get("type") or ""), str(r.get("key") or ""), str(r.get("before") or "")
                if t in ("cat", "node") and k and b:
                    order_rules.append({"type": t, "key": k, "before": b})
            clean["order_rules"] = order_rules
            # 拖拽方式：{mouse: left|right, modifier: ""|ctrl/alt/shift 组合}
            trigger = data.get("drag_trigger") or {}
            if not isinstance(trigger, dict):
                trigger = {}
            mouse = str(trigger.get("mouse") or "right").lower()
            mod = str(trigger.get("modifier") or "").lower()
            allowed_mods = {"", "alt"}  # 仅支持：右键 / Alt+右键
            clean["drag_trigger"] = {
                "mouse": mouse if mouse in ("left", "right") else "right",
                "modifier": mod if mod in allowed_mods else "alt",
            }
            with open(_CATEGORY_OVERRIDES_FILE, "w", encoding="utf-8") as f:
                json.dump(clean, f, ensure_ascii=False, indent=2)
            logger.info("分类规则已保存（重命名 %d / 隐藏 %d / 移动 %d / 空分类 %d / 隐藏节点 %d / 排序 %d）",
                        len(clean["category_rename"]), len(clean["hidden_categories"]),
                        len(clean["node_move"]), len(clean["empty_categories"]),
                        len(clean["hidden_nodes"]), len(clean["order_rules"]))
            return web.json_response({"status": "ok"})
        except Exception as e:
            logger.error("保存分类规则失败：%s", e)
            return web.json_response({"error": str(e)}, status=500)

except ImportError:
    logger.warning("无法导入 PromptServer，API Key 配置端点未注册")

# 日志输出
logger.info(
    "UIIIAIII Toolkit 插件已加载（v%s）：提供 8 个节点（Agnes 文生图/图生图/文生视频/图生视频/关键帧动画 + ModelScope Qwen-Image-2.1 文生图与图像编辑 + Qwen-Image-Edit-2511 图像编辑 + 文本输入/预览）",
    __version__,
)
