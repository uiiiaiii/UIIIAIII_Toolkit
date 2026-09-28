"""
节点定义提取模块

提供两种提取方式：
1. 选中节点：从 ComfyUI 当前已加载的 NODE_CLASS_MAPPINGS 中反射指定类名
2. 插件目录全部节点：扫描 custom_nodes/<plugin>/__init__.py 的 NODE_CLASS_MAPPINGS，
   使用 AST 解析提取类名（不导入避免副作用），再从已加载映射反射完整定义

提取的字段：
- title（节点 display name）
- description（节点级描述，悬停节点标题时显示）
- category（分类路径）
- inputs（输入端口名 → 翻译名）
- outputs（输出端口名 → 翻译名，含 OUTPUT_TOOLTIPS 原文）
- widgets（控件名 → 翻译名，含字段 tooltip 原文）

提取结果用于翻译，结构与 UIIIAIII Toolkit/locales/<lang>/Nodes/<plugin>.json 一致：
{
    "ClassName": {
        "title": "...",
        "description": "...",
        "category": "...",
        "inputs": {...},
        "outputs": {...},
        "widgets": {...}
    }
}

tooltip 翻译说明：
界面翻译前端用 tooltip 原文作为 key 在 inputs/widgets/outputs 字典中
查找翻译，因此提取时把字段 tooltip 原文也作为 key 加入对应字典。
"""

import os
import sys
import ast
import json
import logging
import re
import time
from typing import Dict, Any, List, Optional

import folder_paths

logger = logging.getLogger("UIIIAIII Toolkit")


# ============================================================
# 工具：反射单个节点类的定义
# ============================================================

def _get_field_tooltip(spec: Any) -> Optional[str]:
    """
    从 INPUT_TYPES 的字段 spec 中提取 tooltip 文本

    spec 常见结构：
        (Type, {"tooltip": "...", ...})   元组形式
        [Type, {"tooltip": "...", ...}]   列表形式

    Args:
        spec: INPUT_TYPES 中某字段的定义

    Returns:
        tooltip 字符串；不存在则返回 None
    """
    try:
        if isinstance(spec, (tuple, list)) and len(spec) >= 2:
            options = spec[1]
            if isinstance(options, dict):
                tooltip = options.get("tooltip")
                if tooltip and isinstance(tooltip, str) and tooltip.strip():
                    return tooltip.strip()
    except Exception:
        pass
    return None


# 控件类型集合：这些类型在 INPUT_TYPES 中通常渲染为控件（而非连接端口）
# INT/FLOAT → 数值输入框；BOOLEAN → 复选框；STRING → 文本框
# 列表型（COMBO）→ 下拉选择框
WIDGET_TYPE_NAMES = {"INT", "FLOAT", "BOOLEAN"}


def _is_connection_input(spec: Any) -> bool:
    """
    判断 INPUT_TYPES 中的字段是否为连接端口（而非控件）

    判断规则：
    1. 如果 options 中设置了 forceInput: True → 连接端口
    2. 如果 spec[0] 是列表/元组（COMBO 类型）→ 控件
    3. 如果 spec[0] 是字符串且在 WIDGET_TYPE_NAMES 中 → 控件
    4. 如果 spec[0] 是字符串 "STRING"：
       - 有 default 或 multiline 选项 → 控件（文本框）
       - 否则 → 连接端口（可作为文本端口连接）
    5. 其他类型（IMAGE/MASK/MODEL/CLIP/VAE/CONDITIONING/LATENT 等）→ 连接端口
    6. 如果 spec[0] 是类对象（非字符串）→ 连接端口

    Args:
        spec: INPUT_TYPES 中某字段的定义

    Returns:
        True 表示是连接端口，False 表示是控件
    """
    if not isinstance(spec, (tuple, list)) or len(spec) < 1:
        return False

    spec_type = spec[0]
    options = spec[1] if len(spec) >= 2 and isinstance(spec[1], dict) else {}

    # 规则 0：V3 DynamicCombo 是下拉控件（含内嵌参数，见 _extract_node_def）
    if spec_type == "COMFY_DYNAMICCOMBO_V3":
        return False

    # 规则 1：forceInput 显式指定为连接端口
    if options.get("forceInput"):
        return True

    # 规则 2：COMBO 类型（列表）是控件
    if isinstance(spec_type, (list, tuple)):
        return False

    # 规则 3-5：字符串类型名判断
    if isinstance(spec_type, str):
        if spec_type in WIDGET_TYPE_NAMES:
            return False  # INT/FLOAT/BOOLEAN 是控件
        if spec_type == "STRING":
            # STRING 可能是控件也可能是连接端口
            # 有 default 值或 multiline 选项时视为控件
            if "default" in options or options.get("multiline"):
                return False
            # 否则视为连接端口
            return True
        # 其他类型名（IMAGE/MASK/MODEL/CLIP/VAE/CONDITIONING/LATENT/CONTROL_NET 等）
        return True

    # 规则 6：类对象视为连接端口
    return True


def _extract_node_def(node_class, class_name: str) -> Dict[str, Any]:
    """
    从已加载的节点类反射出翻译所需的字段

    Args:
        node_class: 节点类对象
        class_name: 类名（NODE_CLASS_MAPPINGS 的 key）

    Returns:
        {
            "title": str,
            "description": str,           # 节点级描述（悬停节点标题）
            "category": str,
            "inputs": {name: name},
            "outputs": {name: name},
            "widgets": {name: name}       # 含字段名与 tooltip 原文
        }
    """
    result: Dict[str, Any] = {}

    # title：优先 NODE_DISPLAY_NAME_MAPPINGS，退化使用类名
    try:
        import nodes as comfy_nodes
        display_names = getattr(comfy_nodes, "NODE_DISPLAY_NAME_MAPPINGS", {})
        title = display_names.get(class_name, "")
        if not title:
            title = class_name
        result["title"] = title
    except Exception:
        result["title"] = class_name

    # description：节点级描述（鼠标悬停节点标题时显示）
    # 来自节点类的 DESCRIPTION 类属性
    try:
        desc = getattr(node_class, "DESCRIPTION", None)
        if desc and isinstance(desc, str) and desc.strip():
            result["description"] = desc.strip()
    except Exception:
        pass

    # category
    try:
        cat = getattr(node_class, "CATEGORY", None)
        if cat:
            result["category"] = cat
    except Exception:
        pass

    # inputs / outputs / widgets：调用 INPUT_TYPES() 反射
    try:
        input_types = node_class.INPUT_TYPES()
    except Exception as e:
        logger.warning("反射 %s.INPUT_TYPES() 失败：%s", class_name, e)
        input_types = {}

    # inputs（连接端口）和 widgets（控件）分别提取
    # 界面翻译前端会分别在 t.inputs 和 t.widgets 字典中查找翻译，
    # 因此连接端口名必须放入 inputs 字典，控件名放入 widgets 字典，
    # 否则对应端口的 label 不会被翻译。
    # tooltip 提取：字段 spec 的 options 字典中可能含 "tooltip" 键，
    # 界面翻译前端用 tooltip 原文作为 key 在对应字典中查找翻译。
    inputs_map: Dict[str, str] = {}
    widgets_map: Dict[str, str] = {}
    for section in ("required", "optional"):
        section_data = input_types.get(section, {})
        if not isinstance(section_data, dict):
            continue
        for name, spec in section_data.items():
            # 根据类型判断是连接端口还是控件
            is_input = _is_connection_input(spec)
            target_map = inputs_map if is_input else widgets_map
            # 字段名作为 key
            if name not in target_map:
                target_map[name] = name
            # 字段 tooltip 原文作为额外 key（悬停输入/控件时显示的说明）
            tooltip = _get_field_tooltip(spec)
            if tooltip and tooltip not in target_map:
                target_map[tooltip] = tooltip
            # V3 DynamicCombo：递归提取内嵌选项的参数名与 tooltip
            # （如 lowres_mode 下的 lowres_scale/lowres_width/lowres_megapixels）
            if (isinstance(spec, (tuple, list)) and len(spec) >= 2
                    and isinstance(spec[1], dict)
                    and spec[0] == "COMFY_DYNAMICCOMBO_V3"):
                for opt in (spec[1].get("options") or []):
                    if not isinstance(opt, dict):
                        continue
                    opt_inputs = opt.get("inputs")
                    if not isinstance(opt_inputs, dict):
                        continue
                    for sec2 in ("required", "optional"):
                        sd2 = opt_inputs.get(sec2, {})
                        if not isinstance(sd2, dict):
                            continue
                        for sub_name, sub_spec in sd2.items():
                            if sub_name not in target_map:
                                target_map[sub_name] = sub_name
                            sub_tip = _get_field_tooltip(sub_spec)
                            if sub_tip and sub_tip not in target_map:
                                target_map[sub_tip] = sub_tip

    # outputs：RETURN_NAMES + OUTPUT_TOOLTIPS
    # 界面翻译前端用输出端口的 tooltip 原文作为 key 在 outputs 字典中查找翻译
    outputs_map: Dict[str, str] = {}
    try:
        return_names = getattr(node_class, "RETURN_NAMES", None)
        return_types = getattr(node_class, "RETURN_TYPES", None)
        if return_names and return_types:
            # RETURN_NAMES 长度可能与 RETURN_TYPES 不同，取较短的
            count = min(len(return_names), len(return_types))
            for i in range(count):
                name = return_names[i]
                if name and name not in outputs_map:
                    outputs_map[name] = name
        elif return_types:
            # 没有 RETURN_NAMES，使用 RETURN_TYPES（通常是类型名）
            for name in return_types:
                if name and name not in outputs_map:
                    outputs_map[name] = name
        # 输出端口 tooltip（OUTPUT_TOOLTIPS 与 RETURN_TYPES 一一对应）
        output_tooltips = getattr(node_class, "OUTPUT_TOOLTIPS", None)
        if output_tooltips and isinstance(output_tooltips, (list, tuple)):
            for tooltip in output_tooltips:
                if (tooltip and isinstance(tooltip, str)
                        and tooltip.strip() and tooltip not in outputs_map):
                    outputs_map[tooltip] = tooltip.strip()
    except Exception as e:
        logger.debug("反射 %s RETURN_NAMES/OUTPUT_TOOLTIPS 失败：%s", class_name, e)

    if outputs_map:
        result["outputs"] = outputs_map
    if inputs_map:
        result["inputs"] = inputs_map
    if widgets_map:
        result["widgets"] = widgets_map

    return result


# ============================================================
# 选中节点提取
# ============================================================

def extract_selected_nodes(class_names: List[str]) -> Dict[str, Any]:
    """
    从 ComfyUI 已加载的 NODE_CLASS_MAPPINGS 中提取指定类名的节点定义

    Args:
        class_names: 节点类名列表（comfyClass）

    Returns:
        {
            "<plugin_name>": "selected",
            "nodes": {ClassName: {title, category, inputs, outputs, widgets}},
            "not_found": [ClassName, ...]
        }
    """
    import nodes as comfy_nodes

    node_mappings = comfy_nodes.NODE_CLASS_MAPPINGS
    display_names = getattr(comfy_nodes, "NODE_DISPLAY_NAME_MAPPINGS", {})

    result: Dict[str, Any] = {"nodes": {}, "not_found": []}

    for class_name in class_names:
        node_class = node_mappings.get(class_name)
        if not node_class:
            result["not_found"].append(class_name)
            continue

        try:
            node_def = _extract_node_def(node_class, class_name)
            result["nodes"][class_name] = node_def
        except Exception as e:
            logger.error("提取节点 %s 定义失败：%s", class_name, e)
            result["not_found"].append(class_name)

    return result


# ============================================================
# 插件目录提取（AST 解析）
# ============================================================

def list_custom_plugins() -> List[Dict[str, Any]]:
    """
    列出 custom_nodes 目录下所有插件（与 ComfyUI 的加载范围保持一致）

    ComfyUI 会加载两种形态的自定义节点：
    - 目录型：<dir>/__init__.py
    - 单文件型：<name>.py（如 ComfyUI 自带的 websocket_image_save.py）
    两种都会进入列表，保证"ComfyUI 能识别的插件"都可用一键翻译。

    Returns:
        [{"name": "UIIIAIII Toolkit", "path": "...", "node_count": 6}, ...]
        node_count 为 None 表示尚未解析或非 ComfyUI 插件
    """
    custom_nodes_paths = folder_paths.get_folder_paths("custom_nodes")
    plugins: List[Dict[str, Any]] = []

    for base_path in custom_nodes_paths:
        if not os.path.isdir(base_path):
            continue
        for entry in os.listdir(base_path):
            entry_path = os.path.join(base_path, entry)
            # 跳过隐藏项与已知非插件项
            if entry.startswith(".") or entry.startswith("__"):
                continue
            if os.path.isdir(entry_path):
                # 目录型：需包含 __init__.py
                if not os.path.isfile(os.path.join(entry_path, "__init__.py")):
                    continue
                plugins.append({
                    "name": entry,
                    "path": entry_path,
                    "node_count": None,
                })
            elif entry.endswith(".py"):
                # 单文件型：ComfyUI 同样会加载
                plugins.append({
                    "name": entry[:-3],
                    "path": entry_path,
                    "node_count": None,
                })

    return plugins


def _parse_node_class_mappings_from_ast(init_file_path: str) -> List[str]:
    """
    使用 AST 解析插件的 __init__.py，提取 NODE_CLASS_MAPPINGS 的 key 列表

    优势：不导入模块，避免副作用（某些插件导入时会执行网络请求或加载模型）

    支持的写法：
    1. NODE_CLASS_MAPPINGS = {"ClassA": ClassA, "ClassB": ClassB}
    2. NODE_CLASS_MAPPINGS = {**other_dict, "ClassA": ClassA}
    3. NODE_CLASS_MAPPINGS.update({"ClassA": ClassA})
    4. from .nodes import NODE_CLASS_MAPPINGS（递归解析子模块）

    Args:
        init_file_path: __init__.py 的完整路径

    Returns:
        类名列表（字符串）
    """
    try:
        with open(init_file_path, "r", encoding="utf-8") as f:
            source = f.read()
    except Exception as e:
        logger.warning("读取 %s 失败：%s", init_file_path, e)
        return []

    try:
        tree = ast.parse(source, filename=init_file_path)
    except SyntaxError as e:
        logger.warning("解析 %s 语法失败：%s", init_file_path, e)
        return []

    class_names: List[str] = []
    plugin_dir = os.path.dirname(init_file_path)

    for node in ast.walk(tree):
        # 处理赋值语句：NODE_CLASS_MAPPINGS = {...}
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "NODE_CLASS_MAPPINGS":
                    if isinstance(node.value, ast.Dict):
                        for key in node.value.keys:
                            if isinstance(key, ast.Constant) and isinstance(key.value, str):
                                class_names.append(key.value)
                    elif isinstance(node.value, ast.DictComp):
                        # 字典推导式：{k: v for ...}
                        # 难以静态提取，跳过
                        pass

        # 处理 NODE_CLASS_MAPPINGS.update({...})
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            call = node.value
            if (isinstance(call.func, ast.Attribute)
                and call.func.attr == "update"
                and isinstance(call.func.value, ast.Name)
                and call.func.value.id == "NODE_CLASS_MAPPINGS"):
                for arg in call.args:
                    if isinstance(arg, ast.Dict):
                        for key in arg.keys:
                            if isinstance(key, ast.Constant) and isinstance(key.value, str):
                                class_names.append(key.value)

        # 处理 from .xxx import NODE_CLASS_MAPPINGS（递归解析子模块）
        if isinstance(node, ast.ImportFrom):
            if node.module and any(
                alias.name == "NODE_CLASS_MAPPINGS" for alias in node.names
            ):
                # 构造子模块文件路径
                # node.module 是相对模块名（如 "nodes" 或 "subpkg.nodes"）
                module_parts = node.module.split(".")
                # 去掉前导相对层级（node.level 表示相对导入层级）
                if node.level and node.level > 0:
                    # 相对导入，node.level=1 表示当前包
                    # 模块路径相对于 plugin_dir
                    pass
                sub_module_path = _resolve_submodule_path(plugin_dir, module_parts)
                if sub_module_path and os.path.isfile(sub_module_path):
                    logger.info("递归解析子模块：%s", sub_module_path)
                    sub_class_names = _parse_node_class_mappings_from_ast(sub_module_path)
                    class_names.extend(sub_class_names)

    return class_names


def _resolve_submodule_path(base_dir: str, module_parts: List[str]) -> Optional[str]:
    """
    根据模块名列表解析子模块文件路径

    尝试两种路径：
    - base_dir/module_parts[0]/module_parts[1]/.../__init__.py（包）
    - base_dir/module_parts[0]/module_parts[1]/....py（模块）

    Args:
        base_dir: 插件根目录
        module_parts: 模块名拆分（如 ["nodes"] 或 ["subpkg", "nodes"]）

    Returns:
        文件路径，找不到则返回 None
    """
    if not module_parts:
        return None

    rel_path = os.path.join(*module_parts)

    # 尝试作为包：base_dir/rel_path/__init__.py
    pkg_init = os.path.join(base_dir, rel_path, "__init__.py")
    if os.path.isfile(pkg_init):
        return pkg_init

    # 尝试作为模块文件：base_dir/rel_path.py
    mod_file = os.path.join(base_dir, rel_path + ".py")
    if os.path.isfile(mod_file):
        return mod_file

    return None


def _scan_runtime_nodes_for_plugin(plugin_name: str, node_mappings: Dict[str, Any]) -> List[str]:
    """
    运行时降级扫描：当 AST 解析失败时，从已加载的 NODE_CLASS_MAPPINGS 中
    找出属于指定插件的节点类名

    判断依据：节点类的 __module__ 属性是否包含插件目录名
    （插件目录名中的 - 会被 Python 转换为 _，如 "UIIIAIII Toolkit" → "ComfyUI_API"）

    Args:
        plugin_name: 插件目录名（如 "UIIIAIII Toolkit"）
        node_mappings: ComfyUI 的 NODE_CLASS_MAPPINGS

    Returns:
        属于该插件的类名列表
    """
    # 插件目录名可能的模块名变体（- → _）
    plugin_module_name = plugin_name.replace("-", "_")
    class_names: List[str] = []

    for class_name, node_class in node_mappings.items():
        try:
            module = getattr(node_class, "__module__", "") or ""
            rel_module = getattr(node_class, "RELATIVE_PYTHON_MODULE", "") or ""
            # 检查模块路径是否包含插件名（处理 - 和 _ 的变体）
            match = (
                plugin_name in module
                or plugin_module_name in module
                or plugin_name in rel_module
                or plugin_module_name in rel_module
            )
            if match:
                class_names.append(class_name)
        except Exception:
            pass

    return class_names


def get_runtime_nodes_by_plugin() -> Dict[str, List[str]]:
    """
    归属所有已加载节点到插件目录（直接使用 ComfyUI 自身的注册信息）

    ComfyUI 加载自定义节点时，会给每一个注册进全局 NODE_CLASS_MAPPINGS 的节点类
    写入 RELATIVE_PYTHON_MODULE = "custom_nodes.<插件目录名>"
    （NODE_CLASS_MAPPINGS 与 V3 comfy_entrypoint 两种注册路径均会写入，
    对编译实现 nodes.pyd 等同样有效）。

    因此无需再做 __file__ 路径推断：没有该属性的类只可能是 ComfyUI 核心
    节点（不属于任何插件目录），直接跳过即可。

    Returns:
        {插件目录名: [已加载的节点类名, ...]}
    """
    import nodes as comfy_nodes

    # 插件名集合（用于 RELATIVE_PYTHON_MODULE 末段归属校验）：
    # 目录型取目录名，单文件型取 .py 文件名（去掉扩展名）
    plugin_dir_names = set()
    for b in folder_paths.get_folder_paths("custom_nodes"):
        if not os.path.isdir(b):
            continue
        try:
            for entry in os.listdir(b):
                if entry.startswith(".") or entry.startswith("__"):
                    continue
                if os.path.isdir(os.path.join(b, entry)):
                    plugin_dir_names.add(entry)
                elif entry.endswith(".py"):
                    plugin_dir_names.add(entry[:-3])
        except Exception:
            pass

    by_plugin: Dict[str, List[str]] = {}
    for class_name, node_class in comfy_nodes.NODE_CLASS_MAPPINGS.items():
        try:
            rel_module = getattr(node_class, "RELATIVE_PYTHON_MODULE", "") or ""
            if not rel_module.startswith("custom_nodes."):
                continue  # ComfyUI 核心节点 / 非标准注册，无插件归属
            cand = rel_module.rsplit(".", 1)[-1]
            if cand in plugin_dir_names:
                by_plugin.setdefault(cand, []).append(class_name)
        except Exception:
            continue

    return by_plugin


def extract_plugin_nodes(plugin_name: str) -> Dict[str, Any]:
    """
    提取指定插件目录下所有节点的定义

    流程：
    1. 在 custom_nodes/<plugin_name>/__init__.py 中用 AST 解析提取 NODE_CLASS_MAPPINGS 的 key
    2. 从 ComfyUI 已加载的 NODE_CLASS_MAPPINGS 中反射每个类的完整定义

    Args:
        plugin_name: 插件目录名（如 "UIIIAIII Toolkit"）

    Returns:
        {
            "plugin_name": str,
            "plugin_path": str,
            "nodes": {ClassName: {...}},
            "not_loaded": [ClassName, ...]  # 已在 AST 中发现但未加载的类
        }
    """
    custom_nodes_paths = folder_paths.get_folder_paths("custom_nodes")
    plugin_path: Optional[str] = None

    for base_path in custom_nodes_paths:
        candidate = os.path.join(base_path, plugin_name)
        if os.path.isdir(candidate):
            plugin_path = candidate
            break
        # 单文件型插件：<name>.py
        if os.path.isfile(candidate + ".py"):
            plugin_path = candidate + ".py"
            break

    if not plugin_path:
        raise FileNotFoundError(f"Plugin directory not found: {plugin_name}")

    if plugin_path.endswith(".py"):
        # 单文件型：直接解析该 .py 文件
        source_file = plugin_path
    else:
        source_file = os.path.join(plugin_path, "__init__.py")
        if not os.path.isfile(source_file):
            raise FileNotFoundError(f"Plugin __init__.py not found: {source_file}")

    # AST 解析提取类名
    ast_class_names = _parse_node_class_mappings_from_ast(source_file)

    if not ast_class_names:
        logger.warning("插件 %s 未在 __init__.py 中找到 NODE_CLASS_MAPPINGS 字面量定义，降级到运行时扫描", plugin_name)

    # 从已加载的 NODE_CLASS_MAPPINGS 反射
    import nodes as comfy_nodes
    node_mappings = comfy_nodes.NODE_CLASS_MAPPINGS

    # 降级逻辑：当 AST 解析返回空时，从运行时 NODE_CLASS_MAPPINGS 中扫描属于该插件的节点
    # 优先用 __file__ 真实路径归属（对 sys.path 注入 / 子模块拼装等任何导入方式均有效），
    # 失败再退回模块名子串匹配
    if not ast_class_names:
        try:
            runtime_by_plugin = get_runtime_nodes_by_plugin()
            ast_class_names = runtime_by_plugin.get(plugin_name) or []
        except Exception as e:
            logger.warning("运行时按文件路径归属失败：%s", e)
            ast_class_names = []
        if not ast_class_names:
            ast_class_names = _scan_runtime_nodes_for_plugin(plugin_name, node_mappings)
        if ast_class_names:
            logger.info("运行时扫描找到 %d 个属于插件 %s 的节点", len(ast_class_names), plugin_name)

    result: Dict[str, Any] = {
        "plugin_name": plugin_name,
        "plugin_path": plugin_path,
        "nodes": {},
        "not_loaded": [],
    }

    for class_name in ast_class_names:
        node_class = node_mappings.get(class_name)
        if not node_class:
            # 该类在 AST 中存在但未加载（可能插件未启用或导入失败）
            result["not_loaded"].append(class_name)
            continue

        try:
            node_def = _extract_node_def(node_class, class_name)
            result["nodes"][class_name] = node_def
        except Exception as e:
            logger.error("提取节点 %s 定义失败：%s", class_name, e)
            result["not_loaded"].append(class_name)

    return result


# ============================================================
# 分类提取
# ============================================================

def extract_categories_from_nodes(nodes_data: Dict[str, Any]) -> Dict[str, str]:
    """
    从节点定义中提取需要翻译的分类字符串

    界面翻译的 Categories 格式是扁平的 key-value：
    {"UIIIAIII Toolkit": "UIIIAIII Toolkit", "Agnes": "Agnes"}

    Args:
        nodes_data: extract_selected_nodes / extract_plugin_nodes 的 nodes 字段

    Returns:
        {category_segment: category_segment}  待翻译的分类片段
    """
    categories: Dict[str, str] = {}
    for class_name, node_def in nodes_data.items():
        cat = node_def.get("category", "")
        if not cat:
            continue
        # 按 / 分割，每个片段都需要翻译
        for seg in cat.split("/"):
            seg = seg.strip()
            if seg and seg not in categories:
                categories[seg] = seg

    return categories


# ============================================================
# 前端扩展能力识别（ComfyUI 注册信息 + JS 静态分析）
# ============================================================

# 设置面板 API 特征：app.ui.settings.addSetting({...}) / registerExtension({settings: [...]})
_SETTINGS_API_PATTERNS = [
    re.compile(r"\baddSetting\s*\("),
    re.compile(r"\bsettings\s*:\s*\["),
]

# 菜单 API 特征：扩展钩子名 / addMenuItem 调用
_MENU_API_PATTERNS = [
    re.compile(r"\bgetCanvasMenuItems\b"),
    re.compile(r"\bgetNodeMenuItems\b"),
    re.compile(r"\bgetExtraMenuOptions\b"),
    re.compile(r"\bgetCanvasMenuOptions\b"),
    re.compile(r"\bgetNodeMenuOptions\b"),
    re.compile(r"\baddMenuItem\s*\("),
]

# 命令/快捷键声明特征
_COMMANDS_API_PATTERNS = [
    re.compile(r"\bcommands\s*:\s*\["),
    re.compile(r"\bkeybindings\s*:\s*\["),
]

# 扩展注册入口（几乎所有前端插件都有，仅用于说明性判断，不作为 UI 存在性依据）
_EXT_REGISTER_PATTERN = re.compile(r"\bregisterExtension\s*\(")

# ComfyUI 扩展菜单钩子名称清单（前端运行时采集与静态识别共用）
MENU_HOOK_NAMES = [
    "getCanvasMenuItems",
    "getNodeMenuItems",
    "getExtraMenuOptions",
    "getCanvasMenuOptions",
    "getNodeMenuOptions",
]


def _iter_js_files(web_dir: str) -> List[str]:
    """列出 web 目录下所有 JS 文件（.js / .mjs）"""
    js_files: List[str] = []
    try:
        for root, _dirs, files in os.walk(web_dir):
            for f in files:
                if f.endswith(".js") or f.endswith(".mjs"):
                    js_files.append(os.path.join(root, f))
    except Exception:
        pass
    return js_files


def get_registered_extension_dirs() -> Dict[str, str]:
    """
    读取 ComfyUI 已注册的前端扩展目录（权威来源）

    ComfyUI 加载自定义节点时会把声明的 web 目录注册进 nodes.EXTENSION_WEB_DIRS：
    - pyproject.toml 的 [tool.comfy] web 字段 → key 为项目名（如 "comfyui-kjnodes"）
    - __init__.py 的 WEB_DIRECTORY 属性 → key 为模块名（即插件目录名）
    value 为 web 目录的绝对路径，可据此反查插件目录，无需依赖命名一致。

    Returns:
        {扩展注册名: web 目录绝对路径}
    """
    try:
        import nodes as comfy_nodes
        raw = getattr(comfy_nodes, "EXTENSION_WEB_DIRS", None) or {}
        return {str(k): os.path.abspath(v) for k, v in raw.items()}
    except Exception as e:
        logger.warning("读取 EXTENSION_WEB_DIRS 失败：%s", e)
        return {}


def map_extensions_to_plugins(plugin_paths: List[str]) -> Dict[str, Dict[str, Any]]:
    """
    将 ComfyUI 注册的前端扩展归属到插件目录（用 web 目录路径反查，命名无关）

    Args:
        plugin_paths: 插件目录绝对路径列表（单文件插件传 .py 路径）

    Returns:
        {插件路径: {"registered": bool, "ext_names": [注册名...]}}
    """
    web_dirs = get_registered_extension_dirs()
    result: Dict[str, Dict[str, Any]] = {}

    for path in plugin_paths:
        info: Dict[str, Any] = {"registered": False, "ext_names": []}
        if path and not path.endswith(".py") and os.path.isdir(path):
            plugin_abs = os.path.normcase(os.path.abspath(path))
            for ext_name, web_dir in web_dirs.items():
                web_abs = os.path.normcase(os.path.abspath(web_dir))
                try:
                    # web 目录位于插件目录内（ComfyUI 用 os.path.join(module_path, web_dir) 拼接）
                    if os.path.commonpath([plugin_abs, web_abs]) == plugin_abs:
                        info["ext_names"].append(ext_name)
                except ValueError:
                    continue
            info["ext_names"].sort()
            info["registered"] = bool(info["ext_names"])
        result[path] = info

    return result


def analyze_plugin_ui(plugin_path: str, registered: bool = False) -> Dict[str, Any]:
    """
    静态识别插件的前端 UI 能力（设置面板 / 菜单 / 命令），只判存在性不提取文案

    判定依据是 ComfyUI 扩展的已知 API 模式（非泛化字符串扫描）：
    - has_settings: 命中 addSetting( 或 settings: [（设置面板声明）
    - has_menu: 命中菜单钩子名或 addMenuItem(
    - has_commands: 命中 commands: [ 或 keybindings: [

    Args:
        plugin_path: 插件目录路径（或单文件 .py 路径）
        registered: ComfyUI 是否真实注册了该插件的前端扩展（EXTENSION_WEB_DIRS）

    Returns:
        {
            "has_ui": bool,             # 是否声明了任何设置/菜单/命令 UI
            "has_settings": bool,
            "has_menu": bool,
            "has_commands": bool,
            "menu_hooks": [钩子名...],
            "has_web_registered": bool, # ComfyUI 注册信息（权威）
        }
    """
    has_settings = False
    has_menu = False
    has_commands = False
    has_label_assign = False
    menu_hooks: List[str] = []

    web_dir = _resolve_plugin_web_dir(plugin_path)
    if web_dir:
        for js_file in _iter_js_files(web_dir):
            try:
                with open(js_file, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()
            except Exception:
                continue

            if not has_settings and any(p.search(content) for p in _SETTINGS_API_PATTERNS):
                has_settings = True
            if not has_commands and any(p.search(content) for p in _COMMANDS_API_PATTERNS):
                has_commands = True
            if not has_label_assign and any(p.search(content) for p in _LABEL_ASSIGN_PATTERNS):
                has_label_assign = True
            for hook in MENU_HOOK_NAMES:
                if hook not in menu_hooks and hook in content:
                    menu_hooks.append(hook)
            if not has_menu and (menu_hooks or any(p.search(content) for p in _MENU_API_PATTERNS)):
                has_menu = True

    return {
        "has_ui": bool(has_settings or has_menu or has_commands or has_label_assign),
        "has_settings": has_settings,
        "has_menu": has_menu,
        "has_commands": has_commands,
        "has_label_assign": has_label_assign,
        "menu_hooks": menu_hooks,
        "has_web_registered": bool(registered),
    }


# ============================================================
# 运行时扩展采集（前端上报）与插件归属匹配
# ============================================================

# 前端运行时采集的扩展声明缓存（POST /agnes-translate/runtime-ui 上报）
_runtime_extensions: List[Dict[str, Any]] = []
_runtime_sidebar_tabs: List[Dict[str, Any]] = []
_runtime_node_widgets: List[Dict[str, Any]] = []
_runtime_dom_texts: set = set()
_runtime_updated_at: float = 0.0

# 注册名匹配时的通用词（不参与核心词判定）
_GENERIC_NAME_TOKENS = {"comfyui", "comfy", "custom", "node", "nodes", "extension", "extensions"}


def update_runtime_extensions(
    extensions: List[Dict[str, Any]],
    sidebar_tabs: Optional[List[Dict[str, Any]]] = None,
    node_widgets: Optional[List[Dict[str, Any]]] = None,
    dom_texts: Optional[List[str]] = None,
) -> int:
    """
    更新前端上报的运行时数据缓存

    前端从 app.extensions / DOM 采集每个扩展真实声明与显示的 UI 信息：
    - settings: 设置面板项（name/tooltip）
    - settingsCategories: 设置面板分组路径（如 ["KJNodes","Performance"]）
    - commands: 命令面板项（label）
    - hooks: 菜单钩子（getCanvasMenuItems 等函数是否存在）
    - menuTexts: 运行时捕获的真实菜单文案
    - badgeTexts: 关于页徽章等不定结构字段的字符串
    另有三个补充来源：
    - sidebar_tabs: 侧边栏标签页 [{id, texts}]（按 id 归属插件）
    - node_widgets: 画布节点上的控件文案 [{comfyClass, widgets}]（按 comfyClass 归属）
    - dom_texts: 页面当前显示的全局文本集合（终极兜底，用于确认/豁免）

    Args:
        extensions: 扩展声明列表
        sidebar_tabs: 侧边栏标签列表（可选）
        node_widgets: 节点控件文案列表（可选）
        dom_texts: DOM 全局文案列表（可选）

    Returns:
        收录的扩展数量
    """
    global _runtime_extensions, _runtime_sidebar_tabs, _runtime_node_widgets
    global _runtime_dom_texts, _runtime_updated_at

    cleaned: List[Dict[str, Any]] = []
    for ext in extensions or []:
        if not isinstance(ext, dict):
            continue
        name = str(ext.get("name") or "").strip()
        if not name:
            continue

        settings: List[Dict[str, str]] = []
        for s in (ext.get("settings") or []):
            if isinstance(s, dict):
                settings.append({
                    "name": str(s.get("name") or "").strip(),
                    "tooltip": str(s.get("tooltip") or "").strip(),
                })

        # 设置面板分组路径（设置面板中的分类层级，会显示在界面上）
        settings_categories: List[str] = []
        for c in (ext.get("settingsCategories") or []):
            if isinstance(c, str):
                cs = c.strip()
                if cs and cs not in settings_categories:
                    settings_categories.append(cs)

        # 关于页徽章等不定结构字段的字符串
        badge_texts: List[str] = []
        for b in (ext.get("badgeTexts") or []):
            if isinstance(b, str):
                bs = b.strip()
                if bs and bs not in badge_texts:
                    badge_texts.append(bs)

        commands: List[Dict[str, str]] = []
        for c in (ext.get("commands") or []):
            if isinstance(c, dict):
                label = str(c.get("label") or "").strip()
                if label:
                    commands.append({"label": label})

        hooks = [h for h in (ext.get("hooks") or []) if isinstance(h, str) and h in MENU_HOOK_NAMES]

        # 运行时捕获的真实菜单文案（显示过才会存在）
        menu_texts: List[str] = []
        for t in (ext.get("menuTexts") or []):
            if isinstance(t, str):
                s = t.strip()
                if s and len(s) <= 200 and s not in menu_texts:
                    menu_texts.append(s)

        # 只保留有 UI 价值的扩展
        if (not settings and not commands and not hooks and not menu_texts
                and not settings_categories and not badge_texts):
            continue
        cleaned.append({
            "name": name, "settings": settings, "commands": commands,
            "hooks": hooks, "menu_texts": menu_texts,
            "settings_categories": settings_categories, "badge_texts": badge_texts,
        })

    # 侧边栏标签页
    tabs_clean: List[Dict[str, Any]] = []
    for t in sidebar_tabs or []:
        if not isinstance(t, dict):
            continue
        tid = str(t.get("id") or "").strip()
        if not tid:
            continue
        texts = [str(x).strip() for x in (t.get("texts") or [])
                 if isinstance(x, str) and str(x).strip()]
        if texts:
            tabs_clean.append({"id": tid, "texts": texts})

    # 画布节点控件文案
    nw_clean: List[Dict[str, Any]] = []
    for nw in node_widgets or []:
        if not isinstance(nw, dict):
            continue
        cls = str(nw.get("comfyClass") or "").strip()
        if not cls:
            continue
        widgets = [str(x).strip() for x in (nw.get("widgets") or [])
                   if isinstance(x, str) and str(x).strip()]
        if widgets:
            nw_clean.append({"comfyClass": cls, "widgets": widgets})

    # DOM 全局文案集合（兜底：真实显示过的文案）
    dom_clean: set = set()
    for t in dom_texts or []:
        if isinstance(t, str):
            s = t.strip()
            if 2 <= len(s) <= 200 and len(dom_clean) < 5000:
                dom_clean.add(s)

    _runtime_extensions = cleaned
    _runtime_sidebar_tabs = tabs_clean
    _runtime_node_widgets = nw_clean
    _runtime_dom_texts = dom_clean
    _runtime_updated_at = time.time()
    logger.info(
        "运行时数据已更新：扩展 %d / 侧边栏 %d / 节点控件 %d / DOM 文案 %d",
        len(cleaned), len(tabs_clean), len(nw_clean), len(dom_clean),
    )
    return len(cleaned)


def _normalize_ident(text: str) -> str:
    """归一化标识名：小写并去除分隔符（- _ . 空格）"""
    return re.sub(r"[-_.\s]+", "", (text or "").lower())


def _extension_matches_names(ext_name: str, registered_names: List[str]) -> bool:
    """
    运行时扩展名与插件注册名模糊匹配

    运行时扩展的 name 由插件作者自定义（如 "KJNodes.CanvasBackground"），
    与 ComfyUI 注册名（如 "comfyui-kjnodes"）命名习惯不同，采用多级宽松匹配：
    ① 归一化后双向包含（"UIIIAIII Toolkit" ↔ "UIIIAIII_Toolkit"）
    ② 注册名核心词（>=4 字符、去掉 comfyui/node 等通用词）全部出现在扩展名中
       （"comfyui-kjnodes" 核心词 "kjnodes" ⊂ "kjnodescontextmenu"）
    """
    ext_norm = _normalize_ident(ext_name)
    if not ext_norm:
        return False

    for reg_name in registered_names or []:
        reg_norm = _normalize_ident(reg_name)
        if not reg_norm:
            continue
        # ① 双向包含
        if reg_norm in ext_norm or ext_norm in reg_norm:
            return True
        # ② 核心词匹配
        core_tokens = [
            p for p in re.split(r"[-_.\s]+", reg_name.lower())
            if len(p) >= 4 and p not in _GENERIC_NAME_TOKENS
        ]
        if core_tokens and all(tok in ext_norm for tok in core_tokens):
            return True

    return False


def _locate_plugin_path(plugin_name: str) -> Optional[str]:
    """在 custom_nodes 路径中定位插件（目录型优先，其次单文件型）"""
    for base_path in folder_paths.get_folder_paths("custom_nodes"):
        candidate = os.path.join(base_path, plugin_name)
        if os.path.isdir(candidate):
            return candidate
        if os.path.isfile(candidate + ".py"):
            return candidate + ".py"
    return None


def _class_belongs_to_plugin(class_name: str, plugin_name: str) -> bool:
    """节点类是否属于指定插件（ComfyUI 注册信息：RELATIVE_PYTHON_MODULE 末段即插件目录名）"""
    try:
        import nodes as comfy_nodes
        node_class = comfy_nodes.NODE_CLASS_MAPPINGS.get(class_name)
        if not node_class:
            return False
        rel = getattr(node_class, "RELATIVE_PYTHON_MODULE", "") or ""
        return rel.rsplit(".", 1)[-1] == plugin_name
    except Exception:
        return False


def get_runtime_ui_for_plugin(plugin_name: str) -> Dict[str, Any]:
    """
    汇总匹配到指定插件的运行时数据（供提取时补强 UI 识别与文案）

    归属方式：
    - 扩展声明/侧边栏：ComfyUI 注册名（EXTENSION_WEB_DIRS）与扩展名/tab id 模糊匹配
    - 节点控件文案：按 comfyClass 的 RELATIVE_PYTHON_MODULE 直接归属（权威）
    - DOM 全局文案：不归属，作为"真实显示过"的确认集合整体返回

    Returns:
        {
            "matched": [运行时扩展名...],
            "settings_texts": [设置项 name/tooltip...],
            "settings_categories": [设置面板分组路径片段...],
            "commands_texts": [命令 label...],
            "menu_texts": [运行时捕获的菜单文案...],
            "menu_hooks": [钩子名...],
            "badge_texts": [关于页徽章文案...],
            "sidebar_texts": [侧边栏标签文案...],
            "node_widget_texts": [节点上显示的控件文案...],
            "dom_texts": {DOM 全局文案集合},
            "has_settings": bool,
            "has_menu": bool,
        }
    """
    result: Dict[str, Any] = {
        "matched": [],
        "settings_texts": [],
        "settings_categories": [],
        "commands_texts": [],
        "menu_texts": [],
        "menu_hooks": [],
        "badge_texts": [],
        "sidebar_texts": [],
        "node_widget_texts": [],
        "dom_texts": set(),
        "has_settings": False,
        "has_menu": False,
    }

    if not (_runtime_extensions or _runtime_sidebar_tabs or _runtime_node_widgets or _runtime_dom_texts):
        return result

    plugin_path = _locate_plugin_path(plugin_name)
    if not plugin_path:
        return result

    registered_names = map_extensions_to_plugins([plugin_path]).get(plugin_path, {}).get("ext_names", [])

    settings_texts: List[str] = []
    settings_categories: List[str] = []
    commands_texts: List[str] = []
    menu_texts: List[str] = []
    menu_hooks: List[str] = []
    badge_texts: List[str] = []
    sidebar_texts: List[str] = []
    node_widget_texts: List[str] = []

    # 扩展声明（需注册名匹配）
    if registered_names:
        for ext in _runtime_extensions:
            if not _extension_matches_names(ext.get("name", ""), registered_names):
                continue
            result["matched"].append(ext["name"])
            for s in ext.get("settings") or []:
                for t in (s.get("name"), s.get("tooltip")):
                    if t and t not in settings_texts:
                        settings_texts.append(t)
            for c in ext.get("settings_categories") or []:
                if c and c not in settings_categories:
                    settings_categories.append(c)
            for c in ext.get("commands") or []:
                label = c.get("label")
                if label and label not in commands_texts:
                    commands_texts.append(label)
            for t in ext.get("menu_texts") or []:
                if t and t not in menu_texts:
                    menu_texts.append(t)
            for h in ext.get("hooks") or []:
                if h not in menu_hooks:
                    menu_hooks.append(h)
            for b in ext.get("badge_texts") or []:
                if b and b not in badge_texts:
                    badge_texts.append(b)

    # 侧边栏标签（按 tab id 与注册名匹配；无注册名时退化为目录名）
    tab_names = list(registered_names) if registered_names else [plugin_name]
    for tab in _runtime_sidebar_tabs:
        if not _extension_matches_names(tab.get("id", ""), tab_names):
            continue
        for t in tab.get("texts") or []:
            if t and t not in sidebar_texts:
                sidebar_texts.append(t)

    # 节点控件文案（按 comfyClass 的 RELATIVE_PYTHON_MODULE 归属，权威）
    for nw in _runtime_node_widgets:
        if not _class_belongs_to_plugin(nw.get("comfyClass", ""), plugin_name):
            continue
        for w in nw.get("widgets") or []:
            if w and w not in node_widget_texts:
                node_widget_texts.append(w)

    result["settings_texts"] = settings_texts
    result["settings_categories"] = settings_categories
    result["commands_texts"] = commands_texts
    result["menu_texts"] = menu_texts
    result["menu_hooks"] = menu_hooks
    result["badge_texts"] = badge_texts
    result["sidebar_texts"] = sidebar_texts
    result["node_widget_texts"] = node_widget_texts
    result["dom_texts"] = _runtime_dom_texts
    result["has_settings"] = bool(settings_texts)
    result["has_menu"] = bool(menu_hooks) or bool(commands_texts) or bool(menu_texts)
    return result


# ============================================================
# 菜单文本提取（扫描插件前端 JS 文件）
# ============================================================

# 正则：匹配 JS 中的字符串字面量（双引号、单引号、反引号）
# 只提取含有空格的英文短语（菜单文本通常含空格），排除变量名和 CSS 类名
_JS_STRING_PATTERNS = [
    re.compile(r'"([^"\\]*(?:\\.[^"\\]*)*)"'),  # 双引号字符串
    re.compile(r"'([^'\\]*(?:\\.[^'\\]*)*)'"),  # 单引号字符串
    re.compile(r'`([^`\\]*(?:\\.[^`\\]*)*)`'),   # 模板字符串（简单匹配，不处理 ${}）
]

# 排除的模式：这些字符串不可能是菜单文本
_EXCLUDE_PATTERNS = re.compile(
    r"^("
    r"https?://|"              # URL
    r"file://|"                # 文件路径
    r"[.#/<]|"                 # CSS 选择器、路径、HTML 片段
    r"[-+]\S|"                 # 以连字符/加号紧跟字符开头（如 -vertical、-0.125em）
    r"@|"                      # CSS at 规则（如 @keyframes）
    r"\d[\d\s.,]*\s*(px|rem|em|pt|vh|vw)\b"   # 样式数值（如 10px、0 8px、1.5rem）
    r")"
    r"|[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$",   # 命名空间标识（如 KJNodes.helpPopup）
    re.IGNORECASE,
)

# CJK 字符（源文案已是中文/日文/韩文时无需翻译，避免"中→中"的无意义调用）
_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]")

# 字段级锚点：这些 UI 专用字段后紧跟的字符串字面量几乎必然是界面文案（高置信）
_FIELD_LITERAL_PATTERNS = [
    re.compile(r'\bcontent\s*:\s*"((?:[^"\\]|\\.)*)"'),
    re.compile(r"\bcontent\s*:\s*'((?:[^'\\]|\\.)*)'"),
    re.compile(r'\btooltip\s*:\s*"((?:[^"\\]|\\.)*)"'),
    re.compile(r"\btooltip\s*:\s*'((?:[^'\\]|\\.)*)'"),
    re.compile(r'\blabel\s*:\s*"((?:[^"\\]|\\.)*)"'),
    re.compile(r"\blabel\s*:\s*'((?:[^'\\]|\\.)*)'"),
    re.compile(r'\baddMenuItem\s*\(\s*"((?:[^"\\]|\\.)*)"'),
    re.compile(r"\baddMenuItem\s*\(\s*'((?:[^'\\]|\\.)*)'"),
    # DOM API 文案（属性赋值 / 对象字段，覆盖 placeholder / aria-label / textContent）
    re.compile(r'\bplaceholder\s*[:=]\s*"((?:[^"\\]|\\.)*)"'),
    re.compile(r"\bplaceholder\s*[:=]\s*'((?:[^'\\]|\\.)*)'"),
    re.compile(r'\baria-label["\']?\s*[:=]\s*"((?:[^"\\]|\\.)*)"'),
    re.compile(r"\baria-label['\"]?\s*[:=]\s*'((?:[^'\\]|\\.)*)'"),
    re.compile(r'\btextContent\s*=\s*"((?:[^"\\]|\\.)*)"'),
    re.compile(r"\btextContent\s*=\s*'((?:[^'\\]|\\.)*)'"),
    # 翻译调用锚点（tr/i18n/translate/localize 的首参字符串）：
    # 从调用处直接提取，不依赖全局引号配对
    # （JS 文件中的未配对引号会让全量扫描错位、跳过真实字符串）
    re.compile(r'\b(?:tr|i18n|translate|localize)\s*\(\s*"((?:[^"\\]|\\.)*)"'),
    re.compile(r"\b(?:tr|i18n|translate|localize)\s*\(\s*'((?:[^'\\]|\\.)*)'"),
    re.compile(r'\b(?:tr|i18n|translate|localize)\s*\(\s*`([^`$]*?)`'),
]

# 控件 label 赋值锚点：插件运行时改写的控件显示名（如 cw.label = "detector_confidence"）
# 这类字符串是真实显示文案，可能是下划线命名，因此用宽松判定并入
_LABEL_ASSIGN_PATTERNS = [
    re.compile(r'\.label\s*=\s*"((?:[^"\\]|\\.)*)"'),
    re.compile(r"\.label\s*=\s*'((?:[^'\\]|\\.)*)'"),
]

# 设置面板锚点：锚点后窗口内的 name 字段值（设置项标题，高置信）
# 窗口法而非全局匹配 name:（name 在 JS 中过于通用）
_SETTINGS_ANCHOR_RE = re.compile(r"\b(?:addSetting\s*\(|settings\s*:\s*\[)")
_SETTINGS_WINDOW_SIZE = 3000
_NAME_LITERAL_PATTERNS = [
    re.compile(r'\bname\s*:\s*"((?:[^"\\]|\\.)*)"'),
    re.compile(r"\bname\s*:\s*'((?:[^'\\]|\\.)*)'"),
]

# 设置项 combo 选项值（窗口内 options 数组：纯字符串项 或 {value, text} 对象的 text）
_OPTIONS_ARRAY_RE = re.compile(r"\boptions\s*:\s*\[([^\]]*)\]")
_OPTION_VALUE_RE = re.compile(
    r'\btext\s*:\s*"([^"]{2,})"'
    r"|\btext\s*:\s*'([^']{2,})'"
    r'|"([^"]{2,})"'
    r"|'([^']{2,})'"
)

# UI 上下文锚点：全量扫描候选的邻近过滤依据
# 只有出现在菜单/设置代码附近（±300 字符）的字符串才可能是界面文案，
# 远离任何 UI 代码的字符串（类型定义、日志、内部状态等）一律丢弃
_UI_CONTEXT_RE = re.compile(
    r"content\s*:|label\s*:|tooltip\s*:|MenuItems|MenuOptions|"
    r"addMenuItem|menuItem|\btr\s*\("
)
_UI_CONTEXT_WINDOW = 300


def _extract_field_level_texts(content: str) -> List[str]:
    """
    提取字段级 UI 文案（高置信）

    只取 UI 专用字段后的字符串字面量：
    - content: / tooltip: / label: / addMenuItem( 首参
    - settings 声明锚点窗口内的 name:（设置项标题）与 options 选项值
    """
    texts: List[str] = []

    for pat in _FIELD_LITERAL_PATTERNS:
        for m in pat.finditer(content):
            t = m.group(1).strip()
            if t:
                texts.append(t)

    # 设置面板声明窗口内的设置项标题与选项值
    for anchor in _SETTINGS_ANCHOR_RE.finditer(content):
        window = content[anchor.end(): anchor.end() + _SETTINGS_WINDOW_SIZE]
        for pat in _NAME_LITERAL_PATTERNS:
            for m in pat.finditer(window):
                t = m.group(1).strip()
                if t:
                    texts.append(t)
        # combo 选项值（纯字符串项或 {value, text} 对象的 text）
        for arr in _OPTIONS_ARRAY_RE.finditer(window):
            for m in _OPTION_VALUE_RE.finditer(arr.group(1)):
                t = (m.group(1) or m.group(2) or m.group(3) or m.group(4) or "").strip()
                if t:
                    texts.append(t)

    return texts


def _is_runtime_ui_text(text: str) -> bool:
    """
    运行时采集文案的判定（比静态判定宽松）

    运行时来源（节点控件 label/name、设置项、侧边栏、菜单捕获等）都是
    "真实显示在界面上"的文本：即使形如下划线命名的内部字段名
    （如插件把控件显示名改写为 detector_confidence），也应纳入翻译。

    仅排除：CJK 源文案、URL/路径/样式值、无字母或字母过少的字符串。
    """
    if not text or len(text) < 2 or len(text) > 500:
        return False
    if _CJK_RE.search(text):
        return False
    if _EXCLUDE_PATTERNS.match(text):
        return False
    if not re.search(r"[a-zA-Z]", text):
        return False
    if len(re.findall(r"[a-zA-Z]", text)) < 2:
        return False
    return True


def _load_existing_menu_keys(plugin_name: str) -> set:
    """
    读取该插件已有翻译字典的英文 key（历史翻译过的界面文案）

    这些条目已被验证是真实界面文案，作为"保护名单"：
    即使邻近过滤判定为噪声也保留，避免重新翻译时丢失已有条目。
    """
    keys: set = set()
    locales_root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "locales")
    if not os.path.isdir(locales_root):
        return keys

    candidates = {plugin_name, plugin_name.replace(" ", "_"), plugin_name.replace(" ", "-")}
    for lang in os.listdir(locales_root):
        menu_dir = os.path.join(locales_root, lang, "Menus")
        if not os.path.isdir(menu_dir):
            continue
        for cand in candidates:
            menu_file = os.path.join(menu_dir, f"{cand}.json")
            if not os.path.isfile(menu_file):
                continue
            try:
                with open(menu_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    keys.update(data.keys())
            except Exception:
                continue
    return keys


def _is_likely_menu_text(text: str, max_len: int = 100, min_len: int = 3) -> bool:
    """
    判断字符串是否可能是菜单/UI 文本

    规则：
    1. 长度在 [min_len, max_len] 内（字段级/tooltip 来源可放宽为 [2, 500]）
    2. 必须包含至少一个空格（菜单文本通常是短语，如 "Add Node"）
       或是单个有意义的英文单词（如 "Clone"、"Save"）
    3. 不以 . # / http 开头（排除 CSS 选择器、路径、URL）
    4. 不全是数字或特殊字符
    5. 至少包含一个英文字母
    6. 不全是小写单词（排除变量名，如 "clickHandler"）
       例外：单个常见动词（如 "save"、"load"）保留

    Args:
        text: 待判断的字符串
        max_len: 长度上限（默认 100；tooltip 等字段级来源可传 500）
        min_len: 长度下限（默认 3；tr() 字段级来源可传 2，兼容 "OK"）

    Returns:
        True 表示可能是菜单文本
    """
    if not text or len(text) < min_len or len(text) > max_len:
        return False

    # 排除 CSS 选择器、路径、URL
    if _EXCLUDE_PATTERNS.match(text):
        return False

    # 含 CJK 字符（源文案已是中文/日文/韩文，无需翻译）
    if _CJK_RE.search(text):
        return False

    # 无空格的短词若含引号/大括号/冒号/反斜杠 → JS 代码碎片（如 :{content:'）
    if " " not in text.strip() and re.search(r"['\"{}:\\]", text):
        return False

    # CSS 语句特征：以 CSS 属性名开头并含分号（如 border-radius:3px;padding:6px 10px）
    # 注意：句中含分号是合法文案（如 "Current: xxx; yyy"），不能用简单的 ";" 判断
    if re.match(r"^[a-z-]+\s*:\s*[^;]{1,80};", text):
        return False
    # CSS 属性名冒号开头且值为数值（如 border-radius:3px 无分号形式）
    if re.match(r"^[a-z][a-z-]{2,}\s*:\s*\d", text):
        return False

    # CSS 选择器特征（如 "label, [class*='label'], span"）
    if "*=" in text or re.search(r"\[(class|id|data-|href|type)[^\]]*[=\]]", text):
        return False

    # 全小写连字符命名（CSS 类名，如 setting-item）
    if re.match(r"^[a-z][a-z0-9]*(-[a-z0-9]+)+$", text):
        return False

    # JS Unicode 转义序列（如 \u9762\u79ef：源文案按转义写法书写，通常是中文等非拉丁文本）
    if re.search(r"\\u[0-9a-fA-F]{4}", text):
        return False

    # CSS/代码块残留特征（如 ".p-badge {\n  display: inline-flex;\n ..."）
    if "{\\n" in text or "{\\r" in text:
        return False

    # 必须包含至少一个英文字母
    if not re.search(r"[a-zA-Z]", text):
        return False

    # 至少包含 2 个字母（排除纯数字/符号；不要求连续，兼容 "e.g. 2.0" 这类文案）
    if len(re.findall(r"[a-zA-Z]", text)) < 2:
        return False

    # 含空格的短语 → 很可能是菜单文本
    if " " in text.strip():
        # 排除全是小写的多词短语（通常是变量名或代码）
        # 但 "Add Node" 这种首字母大写的保留
        return True

    # 单个单词：判断是否是有意义的菜单词
    # 排除驼峰命名（如 clickHandler、getData）
    if re.match(r"^[a-z]+[A-Z]", text):
        return False

    # 排除下划线命名（如 node_count、api_key）
    if "_" in text and text.islower():
        return False

    # 排除全大写（通常是常量，如 MAX_VALUE）
    if text.isupper() and len(text) > 4:
        return False

    # 首字母大写的单词或全小写的短单词 → 可能是菜单文本
    if text[0].isupper() or (text.islower() and len(text) <= 15):
        return True

    return False


def _resolve_plugin_web_dir(plugin_path: str) -> Optional[str]:
    """
    解析插件的前端目录

    优先级：
    1. ComfyUI 注册信息（EXTENSION_WEB_DIRS，权威）——pyproject.toml 的
       [tool.comfy] web 与 __init__.py 的 WEB_DIRECTORY 都会在这里落地，
       通过 web 目录路径反查插件，命名无关；能覆盖只用 pyproject 声明的插件
    2. __init__.py 里声明的 WEB_DIRECTORY（如 "./js"）
    3. 回退默认的 "web/" 目录
    单文件插件无前端目录，返回 None。
    """
    if plugin_path.endswith(".py"):
        return None

    # 1) ComfyUI 注册信息（权威，路径反查）
    plugin_abs = os.path.normcase(os.path.abspath(plugin_path))
    for web_dir in get_registered_extension_dirs().values():
        web_abs = os.path.normcase(os.path.abspath(web_dir))
        try:
            if os.path.commonpath([plugin_abs, web_abs]) == plugin_abs and os.path.isdir(web_abs):
                return web_dir
        except ValueError:
            continue

    # 2) __init__.py 的 WEB_DIRECTORY 声明
    web_rel = "web"
    try:
        init_file = os.path.join(plugin_path, "__init__.py")
        with open(init_file, "r", encoding="utf-8", errors="ignore") as f:
            m = re.search(r'WEB_DIRECTORY\s*=\s*["\']([^"\']+)["\']', f.read())
        if m and m.group(1).strip():
            web_rel = m.group(1).strip("/\\") or "web"
    except Exception:
        pass
    web_dir = os.path.join(plugin_path, web_rel)
    if os.path.isdir(web_dir):
        return web_dir

    # 3) 默认 web/
    fallback = os.path.join(plugin_path, "web")
    return fallback if os.path.isdir(fallback) else None


def plugin_has_web_js(plugin_path: str) -> bool:
    """插件是否包含前端 JS 文件（纯前端插件 node_count=0 但菜单文本可翻译）"""
    web_dir = _resolve_plugin_web_dir(plugin_path)
    if not web_dir:
        return False
    try:
        for _root, _dirs, files in os.walk(web_dir):
            if any(f.endswith(".js") or f.endswith(".mjs") for f in files):
                return True
    except Exception:
        pass
    return False


def extract_plugin_menus(plugin_name: str, runtime_ui: Optional[Dict[str, Any]] = None) -> Dict[str, str]:
    """
    提取插件的菜单/设置类 UI 文案

    分三步，先判存在性再提取，避免对没有 UI 的插件误提取：
    1. 能力闸门：插件必须真实声明了设置面板/菜单/命令（静态 API 模式命中，
       或运行时采集确认），否则直接返回空
    2. 字段级提取（高置信）：content/tooltip/label/addMenuItem( 与设置项 name
    3. 全量扫描（补充）：覆盖动态构造（变量引用、tr() 包装）的菜单文案

    Args:
        plugin_name: 插件目录名
        runtime_ui: 前端运行时采集的该插件扩展信息（可选，来自 /agnes-translate/runtime-ui）：
            {"settings_texts": [...], "menu_hooks": [...], "has_settings": bool, "has_menu": bool}

    Returns:
        {english_text: english_text}  待翻译的菜单文本字典
    """
    plugin_path = _locate_plugin_path(plugin_name)
    if not plugin_path:
        return {}

    # 解析插件声明的前端目录（WEB_DIRECTORY，如 "./js"；回退 web/）
    web_dir = _resolve_plugin_web_dir(plugin_path)
    js_files = _iter_js_files(web_dir) if web_dir else []

    if not js_files:
        logger.info("插件 %s 无前端目录或 JS 文件，跳过菜单提取", plugin_name)
        return {}

    # 能力闸门：静态 API 模式 + ComfyUI 注册信息 + 运行时确认
    ext_info = map_extensions_to_plugins([plugin_path]).get(plugin_path, {})
    caps = analyze_plugin_ui(plugin_path, registered=ext_info.get("registered", False))

    runtime_ui = runtime_ui or {}
    has_ui = (
        caps["has_settings"] or caps["has_menu"] or caps["has_commands"]
        or caps.get("has_label_assign")
        or bool(runtime_ui.get("has_settings"))
        or bool(runtime_ui.get("has_menu"))
        or bool(runtime_ui.get("menu_hooks"))
        or bool(runtime_ui.get("menu_texts"))
        or bool(runtime_ui.get("sidebar_texts"))
        or bool(runtime_ui.get("node_widget_texts"))
        or bool(runtime_ui.get("badge_texts"))
    )
    if not has_ui:
        logger.info(
            "插件 %s 未声明设置面板/菜单/命令（静态与运行时均无特征），跳过菜单提取",
            plugin_name,
        )
        return {}

    logger.info(
        "扫描插件 %s 的 %d 个 JS 文件（设置=%s 菜单=%s 命令=%s 已注册=%s）",
        plugin_name, len(js_files),
        caps["has_settings"], caps["has_menu"], caps["has_commands"],
        caps["has_web_registered"],
    )

    # 已有字典条目作为保护名单（历史翻译过的真实界面文案，邻近过滤时豁免）
    protected = _load_existing_menu_keys(plugin_name)

    # 运行时扩展注册名（内部标识，不是界面文案，永不提取）
    runtime_ext_names = {str(n).strip().lower() for n in (runtime_ui.get("matched") or [])}

    # DOM 全局文案集合（真实显示过的文案：即使远离 UI 代码也保留）
    dom_texts = runtime_ui.get("dom_texts") or set()

    menus: Dict[str, str] = {}
    field_texts: List[str] = []
    label_texts: List[str] = []

    for js_file in js_files:
        try:
            with open(js_file, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()

            # 1) 字段级提取（高置信，UI 专用字段后的字面量）
            field_texts.extend(_extract_field_level_texts(content))

            # 1b) 控件 label 赋值文案（运行时改写的显示名，如 detector_confidence）
            for pat in _LABEL_ASSIGN_PATTERNS:
                for m in pat.finditer(content):
                    lt = m.group(1).strip()
                    if lt:
                        label_texts.append(lt)

            # 2) 全量扫描（补充：变量引用 / tr() 包装等动态构造的菜单文案）
            for pattern in _JS_STRING_PATTERNS:
                for match in pattern.finditer(content):
                    text = match.group(1).strip()
                    # 跳过跨行匹配：菜单/UI 文本不会换行，
                    # 模板字符串跨行匹配到的多是代码碎片
                    if "\n" in text or "\r" in text:
                        continue
                    # 跳过以代码标点开头/结尾的片段（模板字符串内联代码残留）
                    # 注意：不含 ":" 与引号（它们是合法文案的常见结尾，如 "Target category:"）
                    if re.match(r"^[,;)\]}=+*/>&|]+", text) or re.search(r"[,;(\[{=+*/<&|]$", text):
                        continue
                    # tr()/i18n() 等翻译调用内的字符串是明确 UI 文案：长度上限放宽到 200
                    ui_call = re.search(
                        r"\b(?:tr|i18n|translate|localize)\s*\(\s*[\"'`]\s*$",
                        content[max(0, match.start() - 40):match.start()],
                    )
                    if not _is_likely_menu_text(text, max_len=200 if ui_call else 100) or text in menus:
                        continue
                    # 跳过 console.* 调试输出的消息参数（非 UI 文本）
                    prefix = content[max(0, match.start() - 50):match.start()]
                    if re.search(r"console\.(error|warn|log|info)\s*\(\s*[`'\"\s]*$", prefix):
                        continue
                    # 跳过 id: 字段值（设置项/命令的内部标识，非界面文案）
                    if re.search(r"\bid\s*:\s*[\"'\s]*$", prefix):
                        continue
                    # 跳过运行时扩展注册名（内部标识）
                    if text.lower() in runtime_ext_names:
                        continue
                    # 跳过含模板插值 ${...} 的字符串（运行时消息，非界面常量文本）
                    if "${" in text:
                        continue
                    # 邻近 UI 上下文过滤：远离菜单/设置代码的字符串不是界面文案
                    # 豁免：既有字典保护名单、DOM 中真实显示过的文案
                    ctx = content[max(0, match.start() - _UI_CONTEXT_WINDOW):match.end() + _UI_CONTEXT_WINDOW]
                    if (not _UI_CONTEXT_RE.search(ctx)
                            and text not in protected
                            and text not in dom_texts):
                        continue
                    menus[text] = text
        except Exception as e:
            logger.debug("扫描 JS 文件 %s 失败：%s", js_file, e)

    # 运行时确认的界面文案优先并入（设置面板/分组、命令、菜单、徽章、侧边栏、节点控件，最真实来源）
    runtime_added = 0
    runtime_texts = (
        (runtime_ui.get("settings_texts") or [])
        + (runtime_ui.get("settings_categories") or [])
        + (runtime_ui.get("commands_texts") or [])
        + (runtime_ui.get("menu_texts") or [])
        + (runtime_ui.get("badge_texts") or [])
        + (runtime_ui.get("sidebar_texts") or [])
        + (runtime_ui.get("node_widget_texts") or [])
    )
    for text in runtime_texts:
        t = str(text).strip()
        if t and t not in menus and _is_runtime_ui_text(t):
            menus[t] = t
            runtime_added += 1

    # 字段级文案并入
    field_added = 0
    for text in field_texts:
        if text in menus:
            continue
        if "\n" in text or "\r" in text or "${" in text:
            continue
        if text.lower() in runtime_ext_names:
            continue
        if _is_likely_menu_text(text, max_len=500, min_len=2):
            menus[text] = text
            field_added += 1

    # 控件 label 赋值文案并入（宽松判定：这类是真实显示的控件名，可以是下划线命名）
    for text in label_texts:
        if text in menus or text.lower() in runtime_ext_names:
            continue
        if _is_runtime_ui_text(text):
            menus[text] = text
            field_added += 1

    logger.info(
        "插件 %s 提取到 %d 条菜单文本候选（字段级 %d / 运行时确认 %d）",
        plugin_name, len(menus), field_added, runtime_added,
    )
    return menus
