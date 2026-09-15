"""
翻译结果写入模块

将翻译后的节点定义写入本插件（UIIIAIII Toolkit）的语言数据目录 JSON 文件。

输出位置（固定）：
- 写入本插件 locales/<语言>/Nodes|Categories|Menus/<plugin>.json，刷新页面立即生效

文件格式遵循界面翻译插件规范：
- Nodes/<plugin>.json：{ClassName: {title, inputs, outputs, widgets}}
- Categories/<plugin>.json：{category_segment: translated_segment}
"""

import os
import json
import logging
from typing import Dict, Any

logger = logging.getLogger("UIIIAIII Toolkit")


# ============================================================
# 路径解析
# ============================================================

def _get_locales_base() -> str:
    """
    获取语言数据根目录（本插件内 locales/）

    Returns:
        UIIIAIII Toolkit/locales 的绝对路径
    """
    plugin_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(plugin_dir, "locales")


# ============================================================
# 写入函数
# ============================================================

def write_translation(
    plugin_name: str,
    translated_nodes: Dict[str, Any],
    translated_categories: Dict[str, str],
    translated_menus: Dict[str, str] = None,
    target_lang: str = "zh-CN",
) -> Dict[str, Any]:
    """
    将翻译结果写入本插件（UIIIAIII Toolkit）的语言数据 JSON 文件

    Args:
        plugin_name: 插件名（用作文件名，如 "selected_nodes"）
        translated_nodes: 翻译后的节点定义 {ClassName: {title, inputs, outputs, widgets}}
        translated_categories: 翻译后的分类 {segment: translated_segment}
        translated_menus: 翻译后的菜单文本 {english: translated}
        target_lang: 目标语言代码（如 zh-CN / en / ja），决定写入的语言子目录

    Returns:
        {
            "status": "ok" | "error",
            "mode": "auto",
            "nodes_file": str,
            "categories_file": str,
            "menus_file": str,
            "message": str
        }
    """
    if translated_menus is None:
        translated_menus = {}

    # 安全的文件名（去除路径分隔符）
    safe_name = plugin_name.replace("/", "_").replace("\\", "_").replace(" ", "_")
    if not safe_name.endswith(".json"):
        nodes_filename = f"{safe_name}.json"
        categories_filename = f"{safe_name}.json"
        menus_filename = f"{safe_name}.json"
    else:
        nodes_filename = safe_name
        categories_filename = safe_name
        menus_filename = safe_name

    # 输出根目录：本插件 locales（按 target_lang 分子目录，界面翻译直接生效）
    output_base = _get_locales_base()
    actual_mode = "auto"

    nodes_dir = os.path.join(output_base, target_lang, "Nodes")
    categories_dir = os.path.join(output_base, target_lang, "Categories")
    menus_dir = os.path.join(output_base, target_lang, "Menus")

    # 创建目录
    os.makedirs(nodes_dir, exist_ok=True)
    os.makedirs(categories_dir, exist_ok=True)
    if translated_menus:
        os.makedirs(menus_dir, exist_ok=True)

    nodes_file = os.path.join(nodes_dir, nodes_filename)
    categories_file = os.path.join(categories_dir, categories_filename)
    menus_file = os.path.join(menus_dir, menus_filename) if translated_menus else ""

    # 写入节点翻译文件
    try:
        # 清理翻译结果：去除内部字段（category 不写入 Nodes 文件）
        clean_nodes: Dict[str, Any] = {}
        for class_name, node_def in translated_nodes.items():
            if not isinstance(node_def, dict):
                continue
            clean_def: Dict[str, Any] = {}
            # title
            if "title" in node_def and node_def["title"]:
                clean_def["title"] = node_def["title"]
            # description（节点级描述，悬停节点标题时显示）
            if "description" in node_def and node_def["description"]:
                clean_def["description"] = node_def["description"]
            # inputs / outputs / widgets：过滤 value==key 的未翻译条目
            # 若不过滤，脏数据（英文原样）会进入翻译文件并被界面翻译前端的
            # translatedValueSet 误判为"已翻译"，导致该词永远无法再翻译。
            for field in ("inputs", "outputs", "widgets"):
                raw = node_def.get(field)
                if isinstance(raw, dict) and raw:
                    filtered = {k: v for k, v in raw.items() if k != v}
                    if filtered:
                        clean_def[field] = filtered
            # 仅在非空时写入
            if clean_def:
                clean_nodes[class_name] = clean_def

        # 合并已有文件内容：文件级合并 + 节点级替换
        # - 文件级合并：保留文件中本次未翻译的节点（避免丢失其他节点的翻译）
        # - 节点级替换：本次翻译的节点用新定义完全替换老定义（不残留旧字段）
        #   因为 translator.py 已用原始值补全 API 省略的字段，新定义是完整的
        merged_nodes: Dict[str, Any] = {}
        if os.path.isfile(nodes_file):
            try:
                with open(nodes_file, "r", encoding="utf-8") as f:
                    existing = json.load(f)
                if isinstance(existing, dict):
                    merged_nodes = existing
                    logger.info("已读取已有翻译文件：%s（含 %d 个节点）", nodes_file, len(merged_nodes))
            except Exception as e:
                logger.warning("读取已有翻译文件失败，将覆盖写入：%s", e)

        # 节点级替换：本次翻译的节点直接替换老定义
        # 未在本次翻译范围内的节点保留原样
        for class_name, new_def in clean_nodes.items():
            merged_nodes[class_name] = new_def

        with open(nodes_file, "w", encoding="utf-8") as f:
            json.dump(merged_nodes, f, ensure_ascii=False, indent=4)
        logger.info("节点翻译已写入：%s（本次 %d 个，合并后共 %d 个）",
                    nodes_file, len(clean_nodes), len(merged_nodes))
    except Exception as e:
        return {
            "status": "error",
            "mode": actual_mode,
            "nodes_file": nodes_file,
            "categories_file": categories_file,
            "message": f"写入节点文件失败：{e}",
        }

    # 写入分类翻译文件（合并已有分类，避免多次翻译丢失旧分类）
    try:
        if translated_categories:
            # 读取已有分类翻译并合并
            merged_categories: Dict[str, str] = {}
            if os.path.isfile(categories_file):
                try:
                    with open(categories_file, "r", encoding="utf-8") as f:
                        existing_cats = json.load(f)
                    if isinstance(existing_cats, dict):
                        merged_categories = existing_cats
                except Exception as e:
                    logger.warning("读取已有分类翻译失败，将覆盖写入：%s", e)

            # 过滤 value==key 的未翻译项，再合并（新翻译覆盖旧翻译，旧翻译中未涉及的保留）
            merged_categories.update({k: v for k, v in translated_categories.items() if k != v})

            with open(categories_file, "w", encoding="utf-8") as f:
                json.dump(merged_categories, f, ensure_ascii=False, indent=4)
            logger.info("分类翻译已写入：%s（本次 %d 项，合并后共 %d 项）",
                        categories_file, len(translated_categories), len(merged_categories))
        else:
            # 没有分类需要翻译，不创建文件
            categories_file = ""
    except Exception as e:
        return {
            "status": "error",
            "mode": actual_mode,
            "nodes_file": nodes_file,
            "categories_file": categories_file,
            "message": f"写入分类文件失败：{e}",
        }

    # 写入菜单翻译文件（合并已有菜单，避免多次翻译丢失旧菜单）
    if translated_menus and menus_file:
        try:
            # 读取已有菜单翻译并合并
            merged_menus: Dict[str, str] = {}
            if os.path.isfile(menus_file):
                try:
                    with open(menus_file, "r", encoding="utf-8") as f:
                        existing_menus = json.load(f)
                    if isinstance(existing_menus, dict):
                        merged_menus = existing_menus
                except Exception as e:
                    logger.warning("读取已有菜单翻译失败，将覆盖写入：%s", e)

            # 过滤 value==key 的未翻译项，再合并（新翻译覆盖旧翻译，旧翻译中未涉及的保留）
            merged_menus.update({k: v for k, v in translated_menus.items() if k != v})

            with open(menus_file, "w", encoding="utf-8") as f:
                json.dump(merged_menus, f, ensure_ascii=False, indent=4)
            logger.info("菜单翻译已写入：%s（本次 %d 项，合并后共 %d 项）",
                        menus_file, len(translated_menus), len(merged_menus))
        except Exception as e:
            return {
                "status": "error",
                "mode": actual_mode,
                "nodes_file": nodes_file,
                "categories_file": categories_file,
                "menus_file": menus_file,
                "message": f"写入菜单文件失败：{e}",
            }

    return {
        "status": "ok",
        "mode": actual_mode,
        "nodes_file": nodes_file,
        "categories_file": categories_file,
        "menus_file": menus_file,
        "translated_count": len(clean_nodes),       # 本次翻译的节点数
        "merged_count": len(merged_nodes),           # 合并后文件中的总节点数
        "menu_count": len(translated_menus),         # 本次翻译的菜单数
        "message": f"翻译已写入：{nodes_file}" + (f"，{categories_file}" if categories_file else "") + (f"，{menus_file}" if menus_file else ""),
    }


# ============================================================
# 状态查询
# ============================================================

def get_output_status() -> Dict[str, Any]:
    """
    获取输出目录状态（供前端展示）

    Returns:
        {"locales_path": str}
    """
    return {
        "locales_path": _get_locales_base(),
    }
