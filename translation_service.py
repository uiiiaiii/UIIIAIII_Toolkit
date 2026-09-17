"""
翻译应用服务模块

承载界面翻译（UI 多语言）的后端能力：
- 读取本插件 locales/<locale>/Nodes|Categories|Menus 下的 JSON 翻译文件
- 提供 /translation_node/* 后端 API 供前端拉取翻译数据与读写翻译应用配置
- 翻译应用配置（开关/语言/按钮样式/禁用插件/COMBO 开关）统一存储在
  本插件 config.json，由 config.py 管理
"""

import json
import os
from pathlib import Path
from aiohttp import web
from server import PromptServer

from . import config

# 语言数据根目录（本插件内）
LOCALES_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "locales")

# 当前插件名（用于插件翻译管理面板中排除自身）
ADDON_NAME = "UIIIAIII Toolkit"


def try_get_json(path: Path):
    """尝试使用不同编码读取 JSON 文件"""
    for coding in ["utf-8", "gbk"]:
        try:
            return json.loads(path.read_text(encoding=coding))
        except Exception:
            continue
    return {}


def get_nodes_translation(locale, disabled_plugins=None):
    path = Path(LOCALES_DIR).joinpath(locale, "Nodes")
    if not path.exists():
        path = Path(LOCALES_DIR).joinpath("en-US", "Nodes")
    if not path.exists():
        return {}
    disabled = set(disabled_plugins or [])
    translations = {}
    for jpath in path.glob("*.json"):
        if jpath.stem in disabled:
            continue
        translations.update(try_get_json(jpath))
    return translations


def get_category_translation(locale):
    cats = {}
    for cat_json in Path(LOCALES_DIR).joinpath(locale, "Categories").glob("*.json"):
        cats.update(try_get_json(cat_json))
    path = Path(LOCALES_DIR).joinpath(locale, "NodeCategory.json")
    if not path.exists():
        path = Path(LOCALES_DIR).joinpath("en-US", "NodeCategory.json")
    if path.exists():
        cats.update(try_get_json(path))
    return cats


def get_menu_translation(locale):
    menus = {}
    for menu_json in Path(LOCALES_DIR).joinpath(locale, "Menus").glob("*.json"):
        menus.update(try_get_json(menu_json))
    path = Path(LOCALES_DIR).joinpath(locale, "Menu.json")
    if not path.exists():
        path = Path(LOCALES_DIR).joinpath("en-US", "Menu.json")
    if path.exists():
        menus.update(try_get_json(path))
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

    current_enabled = app_cfg.get("translation_enabled", True)
    if not current_enabled:
        return web.Response(status=200, body=json_data, headers=headers)

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
        return web.Response(status=200, body=json.dumps({"success": True}),
                            headers={"Content-Type": "application/json"})
    except Exception as e:
        return web.Response(status=500, body=json.dumps({"success": False, "error": str(e)}),
                            headers={"Content-Type": "application/json"})
