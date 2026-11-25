"""
翻译应用服务模块

承载界面翻译（UI 多语言）的后端能力：
- 读取本插件 locales/<locale>/Nodes|Categories|Menus 下的 JSON 翻译文件
- 提供 /translation_node/* 后端 API 供前端拉取翻译数据与读写翻译应用配置
- 翻译应用配置（开关/语言/按钮样式/禁用插件/COMBO 开关）统一存储在
  本插件 config.json，由 config.py 管理
- 将节点字典同步为 ComfyUI 官方 i18n 语言包（locales/<官方语言>/nodeDefs.json），
  供 Nodes 2.0（Vue 渲染）按官方机制翻译节点标题、端口名与控件名
"""

import json
import logging
import os
from pathlib import Path
from aiohttp import web
from server import PromptServer

from . import config

logger = logging.getLogger("UIIIAIII Toolkit")

# 语言数据根目录（本插件内）
LOCALES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "locales")

# 当前插件名（用于插件翻译管理面板中排除自身）
ADDON_NAME = "UIIIAIII Toolkit"

# 本插件语言代码 → ComfyUI 官方前端语言代码
# 官方前端仅识别 locales/ 下这些目录名（参见 comfyui_frontend 的 i18n 语言列表），
# 我们的字典目录（zh-CN / en-US 等）与之不同，需要映射后才能被官方 i18n 加载
OFFICIAL_LOCALE_MAP = {
    "en": "en",
    "en-US": "en",
    "zh-CN": "zh",
    "zh": "zh",
    "zh-TW": "zh-TW",
    "ru": "ru",
    "ja": "ja",
    "ko": "ko",
    "fr": "fr",
    "es": "es",
    "ar": "ar",
    "tr": "tr",
    "pt": "pt-BR",
    "it": "it",
}


# JSON 字典文件缓存：{路径: (mtime_ns, 解析结果)}
# 页面每次刷新/切换语言都会请求 /translation_node/get_translation，
# 全量字典有几十个文件、数 MB，按 mtime 缓存可避免重复解析；
# 翻译写回文件后 mtime 变化，缓存自动失效。
_JSON_FILE_CACHE = {}


def try_get_json(path: Path):
    """尝试使用不同编码读取 JSON 文件（按 mtime 缓存）"""
    cache_key = str(path)
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        return {}

    cached = _JSON_FILE_CACHE.get(cache_key)
    if cached is not None and cached[0] == mtime:
        return cached[1]

    data = {}
    for coding in ["utf-8", "gbk"]:
        try:
            data = json.loads(path.read_text(encoding=coding))
            break
        except Exception:
            continue
    _JSON_FILE_CACHE[cache_key] = (mtime, data)
    return data


def _iter_locale_json(dir_path: Path, disabled_stems=None):
    """
    按修改时间升序列出语言 JSON 文件（旧的先、新的后）

    多个文件可能包含同一个节点类或同一个词条（如插件目录字典与用户单独
    提取翻译的 selected_nodes.json）。按时间排序保证最近提取/翻译的结果
    最后合并、优先生效，而非依赖文件系统返回顺序。
    """
    disabled = set(disabled_stems or [])
    files = [p for p in dir_path.glob("*.json") if p.stem not in disabled]
    try:
        files.sort(key=lambda p: p.stat().st_mtime)
    except Exception:
        pass
    return files


def get_nodes_translation(locale, disabled_plugins=None):
    path = Path(LOCALES_DIR).joinpath(locale, "Nodes")
    if not path.exists():
        path = Path(LOCALES_DIR).joinpath("en-US", "Nodes")
    if not path.exists():
        return {}
    translations = {}
    for jpath in _iter_locale_json(path, disabled_plugins):
        data = try_get_json(jpath)
        if isinstance(data, dict):
            # 翻译时会复用旧字典，重新提取得到的条目本身是完整的，
            # 因此同名节点按文件修改时间先后整体覆盖即可：最新的字典生效
            translations.update(data)
    return translations


def get_category_translation(locale):
    cats = {}
    for cat_json in _iter_locale_json(Path(LOCALES_DIR).joinpath(locale, "Categories")):
        data = try_get_json(cat_json)
        if isinstance(data, dict):
            cats.update(data)
    path = Path(LOCALES_DIR).joinpath(locale, "NodeCategory.json")
    if not path.exists():
        path = Path(LOCALES_DIR).joinpath("en-US", "NodeCategory.json")
    if path.exists():
        data = try_get_json(path)
        if isinstance(data, dict):
            cats.update(data)
    return cats


def get_menu_translation(locale):
    menus = {}
    for menu_json in _iter_locale_json(Path(LOCALES_DIR).joinpath(locale, "Menus")):
        data = try_get_json(menu_json)
        if isinstance(data, dict):
            menus.update(data)
    path = Path(LOCALES_DIR).joinpath(locale, "Menu.json")
    if not path.exists():
        path = Path(LOCALES_DIR).joinpath("en-US", "Menu.json")
    if path.exists():
        data = try_get_json(path)
        if isinstance(data, dict):
            menus.update(data)
    return menus


def compile_translation(locale, disabled_plugins=None):
    nodes_translation = get_nodes_translation(locale, disabled_plugins)
    node_category_translation = get_category_translation(locale)
    menu_translation = get_menu_translation(locale)

    return json.dumps({
        "Nodes": nodes_translation,
        "NodeCategory": node_category_translation,
        "Menu": menu_translation
    }, ensure_ascii=False)


def compress_json(data, method="gzip"):
    if method == "gzip":
        import gzip
        return gzip.compress(data.encode("utf-8"))
    return data


@PromptServer.instance.routes.get("/translation_node/get_locales")
async def get_locales(request: web.Request):
    """获取支持的语言列表：扫描 locales 下所有含翻译文件的语言目录"""
    locales = []
    locales_root = Path(LOCALES_DIR)
    if locales_root.exists():
        for item in locales_root.iterdir():
            if item.is_dir() and item.name not in [".git", "__pycache__"]:
                if (item.joinpath("Nodes").exists()
                        or item.joinpath("Menu.json").exists()
                        or item.joinpath("NodeCategory.json").exists()):
                    locales.append(item.name)
    if not locales:
        locales = ["en-US", "zh-CN"]
    return web.Response(status=200, body=json.dumps(locales),
                        headers={"Content-Type": "application/json"})


@PromptServer.instance.routes.post("/translation_node/get_translation")
async def get_translation(request: web.Request):
    post = await request.post()
    app_cfg = config.get_translation_app_config()
    locale = post.get("locale", app_cfg.get("locale", "zh-CN"))
    accept_encoding = request.headers.get("Accept-Encoding", "")
    json_data = "{}"
    headers = {}

    # 无论开关状态都返回字典：
    # 关闭翻译时前端不应用译文，但需要用它识别界面上残留的旧译文并还原英文。
    disabled_plugins = app_cfg.get("disabled_plugins", [])
    try:
        json_data = compile_translation(locale, disabled_plugins)
        if "gzip" in accept_encoding:
            json_data = compress_json(json_data, method="gzip")
            headers["Content-Encoding"] = "gzip"
    except Exception:
        pass

    return web.Response(status=200, body=json_data, headers=headers)


@PromptServer.instance.routes.get("/translation_node/get_config")
async def get_config(request: web.Request):
    return web.Response(status=200, body=json.dumps(config.get_translation_app_config()),
                        headers={"Content-Type": "application/json"})


@PromptServer.instance.routes.get("/translation_node/get_plugin_list")
async def get_plugin_list(request):
    """获取当前语言的插件翻译文件列表（JSON 文件名，不含扩展名）"""
    locale = config.get_translation_app_config().get("locale", "zh-CN")
    path = Path(LOCALES_DIR).joinpath(locale, "Nodes")
    plugins = sorted([f.stem for f in path.glob("*.json")]) if path.exists() else []
    return web.Response(status=200, body=json.dumps(plugins, ensure_ascii=False),
                        headers={"Content-Type": "application/json"})


# 删除翻译时禁止操作的名称（自身插件与内部文件，防止误删导致全部翻译失效）
DELETE_PROTECTED = {ADDON_NAME, ADDON_NAME.replace(" ", "_"), "internal"}


@PromptServer.instance.routes.post("/translation_node/delete_plugin")
async def delete_plugin_translation(request):
    """
    删除指定插件在当前语言下的翻译文件（Nodes/Categories/Menus 三处同名 JSON）

    表单参数：
        plugin: 插件名（即翻译文件名，不含 .json 扩展名）
    """
    try:
        post = await request.post()
        plugin = (post.get("plugin") or "").strip()

        # 安全校验：禁止路径分隔符与目录跳转，禁止删除自身/内部翻译
        if (not plugin or "/" in plugin or "\\" in plugin or ".." in plugin
                or plugin in DELETE_PROTECTED):
            return web.Response(status=400,
                                body=json.dumps({"success": False, "error": f"invalid plugin: {plugin}"}),
                                headers={"Content-Type": "application/json"})

        locale = config.get_translation_app_config().get("locale", "zh-CN")
        base = Path(LOCALES_DIR).joinpath(locale).resolve()

        deleted = []
        for sub in ("Nodes", "Categories", "Menus"):
            f = base.joinpath(sub, f"{plugin}.json")
            # 防御性校验：确认目标文件确实位于 locales 目录内
            try:
                f.resolve().relative_to(base)
            except ValueError:
                continue
            if f.is_file():
                f.unlink()
                deleted.append(f"{sub}/{plugin}.json")

        return web.Response(status=200,
                            body=json.dumps({"success": True, "deleted": deleted}, ensure_ascii=False),
                            headers={"Content-Type": "application/json"})
    except Exception as e:
        return web.Response(status=500,
                            body=json.dumps({"success": False, "error": str(e)}),
                            headers={"Content-Type": "application/json"})


@PromptServer.instance.routes.post("/translation_node/set_config")
async def set_config(request: web.Request):
    try:
        post = await request.post()
        enabled = post.get("translation_enabled", "true").lower() == "true"
        locale = post.get("locale", "zh-CN")
        button_style = post.get("button_style", "gradient")

        # 解析禁用插件列表
        disabled_plugins_str = post.get("disabled_plugins", "[]")
        try:
            disabled_plugins = json.loads(disabled_plugins_str)
            if not isinstance(disabled_plugins, list):
                disabled_plugins = []
        except (json.JSONDecodeError, TypeError):
            disabled_plugins = []

        # 解析选项翻译开关
        translate_options = post.get("translate_options", "true").lower() == "true"

        success = config.save_translation_app_config(
            translation_enabled=enabled,
            locale=locale,
            button_style=button_style,
            disabled_plugins=disabled_plugins,
            translate_options=translate_options,
        )
        if not success:
            return web.Response(status=500, body=json.dumps({"success": False, "error": "Failed to save config"}),
                                headers={"Content-Type": "application/json"})
        # 开关/语言/禁用插件变化后同步官方语言包（Nodes 2.0 依赖它翻译端口名）
        sync_official_node_defs(force=True)
        return web.Response(status=200, body=json.dumps({"success": True}),
                            headers={"Content-Type": "application/json"})
    except Exception as e:
        return web.Response(status=500, body=json.dumps({"success": False, "error": str(e)}),
                            headers={"Content-Type": "application/json"})


# ============================================================
# ComfyUI 官方 i18n 语言包（Nodes 2.0 兼容）
# ============================================================

def _is_field_entry(key, value) -> bool:
    """
    判断字典条目是否为"字段名 → 译文"（而非 tooltip 原文条目）

    节点字典的 inputs/widgets 中混有 tooltip 原文作为 key 的条目
    （值为译文）。ComfyUI 端口/控件名只会以真实字段名查询官方 i18n，
    因此这里按"字段名不含空格且长度有限"过滤，避免把大段 tooltip
    原文写进官方语言包（会显著增大 /api/i18n 响应体积）。

    下拉选项/按钮文案（如 "Just Resize"）由字典的 options 字段单独
    处理，不经过本函数，避免把 tooltip 短句误当作选项。
    """
    if not isinstance(key, str) or not isinstance(value, str):
        return False
    if not key or not value or key == value:
        return False
    if " " in key or len(key) > 64:
        return False
    # 字段名的译文应当是短标签；字典翻译偶尔会把 tooltip 整句译文写成
    # 字段名译文，若写入官方语言包，Nodes 2.0 会按控件名宽度把节点撑得极长
    if len(value) > 60:
        return False
    return True


def _build_official_outputs(class_name, outputs, node_mappings) -> dict:
    """
    将 outputs 字典（输出名 → 译文）转换为官方格式 {"<索引>": {"name": 译文}}

    Nodes 2.0 以输出序号查询 nodeDefs.<class>.outputs.<index>.name，
    因此必须把输出名映射回 RETURN_TYPES 中的位置；节点类未加载时
    退化为按字典写入顺序编号（字典由提取器按 RETURN_TYPES 顺序生成）。
    """
    items = []
    for k, v in (outputs or {}).items():
        if not isinstance(k, str) or not isinstance(v, str):
            continue
        if not k or not v or k == v:
            continue
        # 输出名允许含空格（如 "X or Y"），不能用字段名规则过滤
        if len(k) > 64 or len(v) > 60:
            continue
        items.append((k, v))
    if not items:
        return {}

    names = None
    try:
        cls = (node_mappings or {}).get(class_name)
        if cls is not None:
            ret_types = list(getattr(cls, "RETURN_TYPES", ()) or ())
            ret_names = list(getattr(cls, "RETURN_NAMES", ()) or ())
            if ret_types:
                names = [
                    ret_names[i] if i < len(ret_names) and ret_names[i] else ret_types[i]
                    for i in range(len(ret_types))
                ]
    except Exception:
        names = None

    ordered = {}
    used = set()
    # 语言包原生索引结构（{"0": "图像"}）：直接按索引写入
    numeric_items = [(k, v) for k, v in items if k.isdigit()]
    for key, value in numeric_items:
        idx = int(key)
        ordered[idx] = value
        used.add(idx)
    rest_items = [(k, v) for k, v in items if not k.isdigit()]

    if names:
        # 先按输出名精确匹配
        for key, value in rest_items:
            if key in names:
                idx = names.index(key)
                if idx not in used:
                    ordered[idx] = value
                    used.add(idx)
        # 未匹配的（如字典里用类型名作 key）按顺序填入空闲输出位
        rest = [(k, v) for k, v in rest_items if k not in names]
        free = [i for i in range(len(names)) if i not in used]
        for (_, value), idx in zip(rest, free):
            ordered[idx] = value
    else:
        next_idx = 0
        for _, value in rest_items:
            while next_idx in used:
                next_idx += 1
            ordered[next_idx] = value
            used.add(next_idx)

    return {str(idx): {"name": value} for idx, value in sorted(ordered.items())}


# DynamicCombo 子字段反射结果缓存（按节点类名）：
# 生成多语言语言包时避免对同一节点重复调用 INPUT_TYPES()
_DYNAMIC_COMBO_CACHE = {}
# 节点输入 tooltip 反射结果缓存
_INPUT_TOOLTIP_CACHE = {}


def _get_dynamic_combo_subfields(node_class, class_name=None) -> dict:
    """
    反射节点的 DynamicCombo 输入，返回 {主字段: [子字段, ...]}

    Nodes 2.0 给 DynamicCombo 内嵌控件生成的名称是 "<主字段>.<子字段>"，
    官方 i18n 键会把点转下划线（<主字段>_<子字段>）。字典里通常只存
    子字段名，需要在生成语言包时映射到真实键，否则控件名无法翻译。
    """
    if node_class is None:
        return {}
    cache_key = class_name or id(node_class)
    if cache_key in _DYNAMIC_COMBO_CACHE:
        return _DYNAMIC_COMBO_CACHE[cache_key]
    try:
        input_types = node_class.INPUT_TYPES()
    except Exception:
        _DYNAMIC_COMBO_CACHE[cache_key] = {}
        return {}
    if not isinstance(input_types, dict):
        _DYNAMIC_COMBO_CACHE[cache_key] = {}
        return {}

    result = {}
    for section in ("required", "optional"):
        section_data = input_types.get(section)
        if not isinstance(section_data, dict):
            continue
        for combo_name, spec in section_data.items():
            if not (isinstance(spec, (tuple, list)) and len(spec) >= 2
                    and spec[0] == "COMFY_DYNAMICCOMBO_V3"
                    and isinstance(spec[1], dict)):
                continue
            subfields = []
            for opt in (spec[1].get("options") or []):
                if not isinstance(opt, dict):
                    continue
                opt_inputs = opt.get("inputs")
                if not isinstance(opt_inputs, dict):
                    continue
                for sec in ("required", "optional"):
                    sub_data = opt_inputs.get(sec)
                    if not isinstance(sub_data, dict):
                        continue
                    for sub_name in sub_data:
                        if isinstance(sub_name, str) and sub_name and sub_name not in subfields:
                            subfields.append(sub_name)
            if subfields:
                result[combo_name] = subfields
    _DYNAMIC_COMBO_CACHE[cache_key] = result
    return result


def _get_input_tooltips(node_class, class_name=None) -> dict:
    """
    反射节点输入的 tooltip，返回 {字段名: tooltip 原文}

    DynamicCombo 内嵌字段使用真实键 "<主字段>_<子字段>"，
    与前端 i18n 的 inputs 键保持一致。
    """
    if node_class is None:
        return {}
    cache_key = class_name or id(node_class)
    if cache_key in _INPUT_TOOLTIP_CACHE:
        return _INPUT_TOOLTIP_CACHE[cache_key]
    try:
        input_types = node_class.INPUT_TYPES()
    except Exception:
        _INPUT_TOOLTIP_CACHE[cache_key] = {}
        return {}
    if not isinstance(input_types, dict):
        _INPUT_TOOLTIP_CACHE[cache_key] = {}
        return {}

    result = {}
    for section in ("required", "optional"):
        section_data = input_types.get(section)
        if not isinstance(section_data, dict):
            continue
        for field, spec in section_data.items():
            if not (isinstance(spec, (tuple, list)) and len(spec) >= 2
                    and isinstance(spec[1], dict)):
                continue
            tip = spec[1].get("tooltip")
            if isinstance(tip, str) and tip.strip():
                result[field] = tip.strip()
            if spec[0] == "COMFY_DYNAMICCOMBO_V3":
                for opt in (spec[1].get("options") or []):
                    if not isinstance(opt, dict):
                        continue
                    for sec in ("required", "optional"):
                        for sub, sub_spec in ((opt.get("inputs") or {}).get(sec) or {}).items():
                            if (isinstance(sub_spec, (tuple, list)) and len(sub_spec) >= 2
                                    and isinstance(sub_spec[1], dict)):
                                sub_tip = sub_spec[1].get("tooltip")
                                if isinstance(sub_tip, str) and sub_tip.strip():
                                    result[f"{field}_{sub}"] = sub_tip.strip()
    _INPUT_TOOLTIP_CACHE[cache_key] = result
    return result


def build_official_node_defs(locale, disabled_plugins=None) -> dict:
    """
    将本插件节点字典转换为 ComfyUI 官方 nodeDefs 语言包结构

    官方结构（对应前端 key）：
    {
        "ClassName": {
            "display_name": "...",                       # nodeDefs.<class>.display_name
            "description": "...",                        # nodeDefs.<class>.description
            "inputs": {"field": {"name": "..."}},        # nodeDefs.<class>.inputs.<field>.name
            "outputs": {"0": {"name": "..."}}            # nodeDefs.<class>.outputs.<index>.name
        }
    }
    官方 i18n 同时用 inputs.<field>.name 渲染端口名与控件显示名。

    Args:
        locale: 本插件语言代码（如 zh-CN），读取 locales/<locale>/Nodes
        disabled_plugins: 被禁用的翻译插件文件名列表（不含 .json）

    Returns:
        官方 nodeDefs 字典（无内容时返回空字典）
    """
    nodes_dict = get_nodes_translation(locale, disabled_plugins)
    if not nodes_dict:
        return {}
    # 全局菜单词条（含 tooltip 原文 → 译文），供 tooltip 查找
    menu_lookup = get_menu_translation(locale)

    try:
        import nodes as comfy_nodes
        node_mappings = getattr(comfy_nodes, "NODE_CLASS_MAPPINGS", {})
    except Exception:
        node_mappings = {}

    result = {}
    for class_name, node_def in nodes_dict.items():
        if not isinstance(node_def, dict):
            continue
        # 只保留当前已加载的节点类：字典里通常积累了大量已卸载节点的条目，
        # 全部写入会显著增大 /api/i18n 响应（前端首屏需要下载并合并）
        if node_mappings and class_name not in node_mappings:
            continue

        entry = {}
        title = node_def.get("title")
        if isinstance(title, str) and title.strip() and title != class_name:
            entry["display_name"] = title
        description = node_def.get("description")
        if isinstance(description, str) and description.strip():
            entry["description"] = description

        fields = {}
        for section in ("inputs", "widgets"):
            raw = node_def.get(section)
            if not isinstance(raw, dict):
                continue
            for key, value in raw.items():
                if _is_field_entry(key, value):
                    # inputs 与 widgets 共用同一命名空间；input 优先
                    fields.setdefault(key, {})["name"] = value
        # 下拉选项/按钮文案（如 "Just Resize"、"Select to add LoRA"）：
        # 与 easy-use 官方语言包结构一致，写入 inputs 供 Nodes 2.0 按文本匹配；
        # 这些键不是真实字段名，只影响显示，不参与字段名查询。
        options = node_def.get("options")
        if isinstance(options, dict):
            for key, value in options.items():
                if not isinstance(key, str) or not isinstance(value, str):
                    continue
                if not key or not value or key == value:
                    continue
                if len(key) > 64 or len(value) > 60:
                    continue
                fields.setdefault(key, {})["name"] = value
        # DynamicCombo 内嵌控件：把字典中的子字段译文映射到真实键
        # （<主字段>_<子字段>，如 resize_type_multiple）
        node_class = node_mappings.get(class_name) if node_mappings else None
        for combo_name, subfields in _get_dynamic_combo_subfields(node_class, class_name).items():
            for sub_name in subfields:
                prefixed = f"{combo_name}_{sub_name}"
                if prefixed in fields:
                    continue
                source = fields.get(sub_name)
                if source:
                    fields[prefixed] = dict(source)

        # tooltip：从节点字典（字段/tooltip 原文）或全局 Menus 词条取译文。
        # 只写 tooltip 字段，不参与 name，避免把长句当控件名。
        text_lookup = {}
        for section in ("inputs", "widgets"):
            raw = node_def.get(section)
            if not isinstance(raw, dict):
                continue
            for key, value in raw.items():
                if isinstance(key, str) and isinstance(value, str) and key != value:
                    text_lookup[key] = value
        for field_name, tip in _get_input_tooltips(node_class, class_name).items():
            translated_tip = text_lookup.get(tip) or menu_lookup.get(tip)
            if isinstance(translated_tip, str) and translated_tip and translated_tip != tip:
                fields.setdefault(field_name, {})["tooltip"] = translated_tip

        if fields:
            entry["inputs"] = fields

        outputs = _build_official_outputs(class_name, node_def.get("outputs"), node_mappings)
        if outputs:
            entry["outputs"] = outputs

        if entry:
            result[class_name] = entry

    return result


def _clear_official_i18n_cache():
    """
    清空 ComfyUI 的 /api/i18n 构建缓存

    CustomNodeManager.build_translations 带 @lru_cache，进程内只读取一次
    locales 目录；重新生成语言包后必须清缓存，浏览器刷新页面才能拿到新数据。
    """
    try:
        from app.custom_node_manager import CustomNodeManager
        CustomNodeManager.build_translations.cache_clear()
    except Exception:
        pass


def sync_official_node_defs(force: bool = False) -> bool:
    """
    同步官方 nodeDefs 语言包（供 Nodes 2.0 使用）

    - 翻译开启：按当前语言生成官方语言包
      除目标语言目录外，同时写入 locales/en，使插件翻译不依赖
      ComfyUI 界面语言（英文界面下同样显示插件译文）
    - 翻译关闭 / 目标语言为英文：删除本插件生成的语言包
    - 配置或字典未变化时跳过（force=True 时强制重建）

    Returns:
        是否写入或删除了文件
    """
    try:
        app_cfg = config.get_translation_app_config()
        enabled = bool(app_cfg.get("translation_enabled", True))
        locale = app_cfg.get("locale", "zh-CN")
        disabled = app_cfg.get("disabled_plugins", [])
        official = OFFICIAL_LOCALE_MAP.get(locale)

        locales_root = Path(LOCALES_DIR)
        if not locales_root.exists():
            return False

        # 目标目录集合：翻译关闭或目标语言为英文时不生成
        targets = set()
        if enabled and official != "en":
            if official:
                targets.add(official)
            # 插件翻译独立于 ComfyUI 界面语言：英文界面也应用插件译文
            targets.add("en")

        target_files = {locales_root.joinpath(t, "nodeDefs.json") for t in targets}
        changed = False

        # 清理非目标语言的旧语言包（切换语言或关闭翻译时）
        for item in locales_root.iterdir():
            if not item.is_dir():
                continue
            stale = item.joinpath("nodeDefs.json")
            if not stale.is_file() or stale.resolve() in {p.resolve() for p in target_files}:
                continue
            try:
                stale.unlink()
                changed = True
            except Exception:
                pass

        if not target_files:
            if changed:
                _clear_official_i18n_cache()
                logger.info("翻译已关闭或目标语言为英文，已移除官方语言包")
            return changed

        # 增量判断：所有语言包均比源字典与配置新时无需重建
        if not force and all(p.is_file() for p in target_files):
            try:
                src_files = list(locales_root.joinpath(locale, "Nodes").glob("*.json"))
                src_files.append(locales_root.parent.joinpath("config.json"))
                newest = max(p.stat().st_mtime for p in src_files if p.exists())
                if min(p.stat().st_mtime for p in target_files) >= newest:
                    return False
            except Exception:
                pass

        data = build_official_node_defs(locale, disabled)
        if not data:
            # 无可用译文（如全部插件被禁用）：清掉可能残留的旧语言包
            for target in target_files:
                if target.is_file():
                    try:
                        target.unlink()
                        changed = True
                    except Exception:
                        pass
            if changed:
                _clear_official_i18n_cache()
            return changed

        text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        written = []
        for target in target_files:
            if target.is_file():
                try:
                    if target.read_text(encoding="utf-8") == text:
                        continue
                except Exception:
                    pass
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
            written.append(target)

        if written:
            _clear_official_i18n_cache()
            logger.info("官方语言包已同步：%s（%d 个节点，%d 字节）",
                        ", ".join(str(p) for p in written), len(data), len(text.encode("utf-8")))
        return changed or bool(written)
    except Exception as e:
        logger.warning("同步官方语言包失败：%s", e)
        return False

