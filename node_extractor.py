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
    列出 custom_nodes 目录下所有插件

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
            if not os.path.isdir(entry_path):
                continue
            # 跳过隐藏目录和已知非插件目录
            if entry.startswith(".") or entry.startswith("__"):
                continue
            # 检查是否包含 __init__.py
            init_file = os.path.join(entry_path, "__init__.py")
            if not os.path.isfile(init_file):
                continue

            plugins.append({
                "name": entry,
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
    运行时按插件目录统计/归类所有已加载节点（最可靠的归属方式）

    原理：遍历 sys.modules，用每个模块 __file__ 的真实路径判断其所属的
    custom_nodes 插件目录，再将 NODE_CLASS_MAPPINGS 中节点类的 __module__
    归属到对应插件。

    优势：不依赖模块名与插件目录名的字符串匹配，对以下情况均有效：
    - 插件把子包目录加入 sys.path 后导入（如 ComfyUI-Easy-Use 的 py/ 模块）
    - NODE_CLASS_MAPPINGS 在子模块中拼装（如 ComfyUI-KJNodes）
    - 顶层模块名与目录名不一致

    Returns:
        {插件目录名: [已加载的节点类名, ...]}
    """
    import nodes as comfy_nodes

    # 比较时才做 normcase（Windows 会转小写），relpath 用原始路径以保留目录名的真实大小写
    bases = []
    for b in folder_paths.get_folder_paths("custom_nodes"):
        if os.path.isdir(b):
            bases.append((os.path.normcase(b) + os.sep, os.path.abspath(b)))

    # module_name -> 插件目录名
    mod2plugin: Dict[str, str] = {}
    for mod_name, mod in list(sys.modules.items()):
        try:
            f = getattr(mod, "__file__", None)
            if not f:
                continue
            f_abs = os.path.abspath(f)
            f_nc = os.path.normcase(f_abs)
            for b_nc, b_orig in bases:
                if f_nc.startswith(b_nc):
                    rel = os.path.relpath(f_abs, b_orig)
                    mod2plugin[mod_name] = rel.split(os.sep)[0]
                    break
        except Exception:
            continue

    by_plugin: Dict[str, List[str]] = {}
    for class_name, node_class in comfy_nodes.NODE_CLASS_MAPPINGS.items():
        try:
            mod = getattr(node_class, "__module__", "") or ""
            rel_module = getattr(node_class, "RELATIVE_PYTHON_MODULE", "") or ""
            plugin = mod2plugin.get(mod)
            if not plugin and rel_module:
                plugin = mod2plugin.get(rel_module)
            if plugin:
                by_plugin.setdefault(plugin, []).append(class_name)
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

    if not plugin_path:
        raise FileNotFoundError(f"Plugin directory not found: {plugin_name}")

    init_file = os.path.join(plugin_path, "__init__.py")
    if not os.path.isfile(init_file):
        raise FileNotFoundError(f"Plugin __init__.py not found: {init_file}")

    # AST 解析提取类名
    ast_class_names = _parse_node_class_mappings_from_ast(init_file)

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
    r"https?://|"           # URL
    r"file://|"              # 文件路径
    r"[.#/]"                 # CSS 选择器、路径
    r")",
    re.IGNORECASE,
)


def _is_likely_menu_text(text: str) -> bool:
    """
    判断字符串是否可能是菜单/UI 文本

    规则：
    1. 长度 >= 3 且 <= 100
    2. 必须包含至少一个空格（菜单文本通常是短语，如 "Add Node"）
       或是单个有意义的英文单词（如 "Clone"、"Save"）
    3. 不以 . # / http 开头（排除 CSS 选择器、路径、URL）
    4. 不全是数字或特殊字符
    5. 至少包含一个英文字母
    6. 不全是小写单词（排除变量名，如 "clickHandler"）
       例外：单个常见动词（如 "save"、"load"）保留

    Args:
        text: 待判断的字符串

    Returns:
        True 表示可能是菜单文本
    """
    if not text or len(text) < 3 or len(text) > 100:
        return False

    # 排除 CSS 选择器、路径、URL
    if _EXCLUDE_PATTERNS.match(text):
        return False

    # 必须包含至少一个英文字母
    if not re.search(r"[a-zA-Z]", text):
        return False

    # 不全是数字和特殊字符
    if not re.search(r"[a-zA-Z]{2,}", text):
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


def extract_plugin_menus(plugin_name: str) -> Dict[str, str]:
    """
    扫描插件 web/ 目录下的 JS 文件，提取可能的菜单/UI 文本

    菜单文本散落在前端 JS 代码中（如 "Add Node"、"Save"、"Clone" 等），
    无法通过 Python 反射获取，因此用正则扫描 JS 文件中的字符串字面量。

    Args:
        plugin_name: 插件目录名

    Returns:
        {english_text: english_text}  待翻译的菜单文本字典
    """
    custom_nodes_paths = folder_paths.get_folder_paths("custom_nodes")
    plugin_path: Optional[str] = None

    for base_path in custom_nodes_paths:
        candidate = os.path.join(base_path, plugin_name)
        if os.path.isdir(candidate):
            plugin_path = candidate
            break

    if not plugin_path:
        return {}

    menus: Dict[str, str] = {}
    web_dir = os.path.join(plugin_path, "web")

    # 扫描 web/ 目录下所有 JS 文件
    js_files: List[str] = []
    if os.path.isdir(web_dir):
        for root, dirs, files in os.walk(web_dir):
            for f in files:
                if f.endswith(".js") or f.endswith(".mjs"):
                    js_files.append(os.path.join(root, f))

    if not js_files:
        logger.info("插件 %s 无 web/ 目录或 JS 文件，跳过菜单提取", plugin_name)
        return {}

    logger.info("扫描插件 %s 的 %d 个 JS 文件提取菜单文本", plugin_name, len(js_files))

    for js_file in js_files:
        try:
            with open(js_file, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()

            # 提取所有字符串字面量
            for pattern in _JS_STRING_PATTERNS:
                for match in pattern.finditer(content):
                    text = match.group(1).strip()
                    if not _is_likely_menu_text(text) or text in menus:
                        continue
                    # 跳过 console.* 调试输出的消息参数（非 UI 文本）
                    prefix = content[max(0, match.start() - 50):match.start()]
                    if re.search(r"console\.(error|warn|log|info)\s*\(\s*[`'\"\s]*$", prefix):
                        continue
                    # 跳过含模板插值 ${...} 的字符串（运行时消息，非界面常量文本）
                    if "${" in text:
                        continue
                    menus[text] = text
        except Exception as e:
            logger.debug("扫描 JS 文件 %s 失败：%s", js_file, e)

    logger.info("插件 %s 提取到 %d 条菜单文本候选", plugin_name, len(menus))
    return menus
