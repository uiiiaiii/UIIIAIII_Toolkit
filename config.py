"""
API Key 配置管理模块

统一管理 Agnes 和 ModelScope 的 API Key，
支持从配置文件读取，避免每次在节点中手动输入。

配置文件位置：<插件目录>/config.json
配置格式：
{
    "agnes_api_key": "",
    "modelscope_api_key": "",
    "translator_base_url": "https://api.openai.com/v1",
    "translator_api_key": "",
    "translator_model": "gpt-4o-mini",
    "translator_output_mode": "auto"
}

优先级（从高到低）：
1. 节点参数显式传入的 api_key
2. 配置文件 config.json 中的 key
3. 环境变量
"""

import os
import json
import logging
from typing import Optional

logger = logging.getLogger("UIIIAIII Toolkit")

# 配置文件路径（插件目录下）
CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")


def load_config() -> dict:
    """
    读取配置文件

    Returns:
        配置字典，如果文件不存在或解析失败则返回空字典
    """
    if not os.path.exists(CONFIG_FILE):
        return {}

    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        logger.warning("读取配置文件失败：%s", e)
        return {}


def save_config(config: dict) -> bool:
    """
    保存配置到文件

    Args:
        config: 配置字典

    Returns:
        是否保存成功
    """
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(config, f, ensure_ascii=False, indent=2)
        logger.info("配置文件已保存：%s", CONFIG_FILE)
        return True
    except IOError as e:
        logger.error("保存配置文件失败：%s", e)
        return False


def get_agnes_api_key(node_api_key: Optional[str] = None) -> str:
    """
    获取 Agnes API Key

    优先级：
    1. 节点参数显式传入的 api_key
    2. 配置文件 config.json 中的 agnes_api_key
    3. 环境变量 AGNES_API_KEY / AGNES_AI_API_KEY

    Args:
        node_api_key: 节点参数传入的 API Key

    Returns:
        API Key 字符串

    Raises:
        ValueError: 未找到有效的 API Key
    """
    # 1. 节点参数优先
    if node_api_key and node_api_key.strip():
        return node_api_key.strip()

    # 2. 从配置文件读取
    config = load_config()
    config_key = config.get("agnes_api_key", "")
    if config_key and config_key.strip():
        return config_key.strip()

    # 3. 从环境变量读取
    env_key = os.environ.get("AGNES_API_KEY") or os.environ.get("AGNES_AI_API_KEY")
    if env_key and env_key.strip():
        return env_key.strip()

    raise ValueError(
        "未找到 Agnes API Key。请通过以下方式之一配置：\n"
        "1. 在 ComfyUI 设置 → UIIIAIII Toolkit → 节点API 中填写\n"
        "2. 在节点的 api_key 参数中填入\n"
        "3. 设置环境变量 AGNES_API_KEY"
    )


def get_modelscope_api_key(node_api_key: Optional[str] = None) -> str:
    """
    获取 ModelScope API Token

    优先级：
    1. 节点参数显式传入的 api_key
    2. 配置文件 config.json 中的 modelscope_api_key
    3. 环境变量 MODELSCOPE_API_TOKEN / MODELSCOPE_ACCESS_TOKEN

    Args:
        node_api_key: 节点参数传入的 API Key

    Returns:
        API Token 字符串

    Raises:
        ValueError: 未找到有效的 API Token
    """
    # 1. 节点参数优先
    if node_api_key and node_api_key.strip():
        return node_api_key.strip()

    # 2. 从配置文件读取
    config = load_config()
    config_key = config.get("modelscope_api_key", "")
    if config_key and config_key.strip():
        return config_key.strip()

    # 3. 从环境变量读取
    for env_name in ("MODELSCOPE_API_TOKEN", "MODELSCOPE_ACCESS_TOKEN"):
        env_key = os.environ.get(env_name)
        if env_key and env_key.strip():
            return env_key.strip()

    raise ValueError(
        "未找到 ModelScope API Token。请通过以下方式之一配置：\n"
        "1. 在 ComfyUI 设置 → UIIIAIII Toolkit → 节点API 中填写\n"
        "2. 在节点的 api_key 参数中填入\n"
        "3. 设置环境变量 MODELSCOPE_API_TOKEN\n"
        "获取 Token：https://modelscope.cn/my/myaccesstoken"
    )


# ============================================================
# 翻译 API 配置（OpenAI 兼容）
# ============================================================

# 翻译 API 默认值
DEFAULT_TRANSLATOR_BASE_URL = "https://api.openai.com/v1"
DEFAULT_TRANSLATOR_MODEL = "gpt-4o-mini"
# 输出模式固定为 auto（写入本插件 locales，立即生效）；manual 模式已移除
DEFAULT_TRANSLATOR_OUTPUT_MODE = "auto"
DEFAULT_TRANSLATOR_TARGET_LANG = "zh-CN"  # 默认目标语言：简体中文
# 翻译时复用已翻译文件作为字典（相同词条直接使用已有译文，保证一致性）
DEFAULT_USE_TRANSLATED_DICT = True

# 支持的目标语言代码（与前端 settings.js 中的 options 保持一致）
SUPPORTED_TARGET_LANGS = {
    "zh-CN", "zh-TW", "en", "ja", "ko",
    "fr", "de", "es", "ru", "pt", "it", "ar",
}

# ============================================================
# 翻译应用配置（界面翻译：开关/语言/按钮样式/禁用插件/COMBO 开关）
# ============================================================

TRANSLATION_APP_DEFAULTS = {
    "translation_enabled": True,
    "locale": "zh-CN",
    "button_style": "plain",
    "disabled_plugins": [],
    "translate_options": True,
}


def get_translation_app_config() -> dict:
    """
    获取界面翻译应用配置（合并默认值）

    Returns:
        含 translation_enabled / locale / button_style /
        disabled_plugins / translate_options 的字典
    """
    cfg = load_config()
    result = dict(TRANSLATION_APP_DEFAULTS)
    for key in TRANSLATION_APP_DEFAULTS:
        if key in cfg:
            result[key] = cfg[key]
    return result


def save_translation_app_config(
    translation_enabled: bool,
    locale: str,
    button_style: str,
    disabled_plugins: list,
    translate_options: bool,
) -> bool:
    """
    保存界面翻译应用配置到 config.json

    Args:
        translation_enabled: 翻译总开关
        locale: 界面翻译语言（如 zh-CN）
        button_style: 顶栏按钮样式（gradient / plain）
        disabled_plugins: 被禁用的翻译插件名列表
        translate_options: COMBO 下拉选项翻译开关

    Returns:
        是否保存成功
    """
    cfg = load_config()
    cfg["translation_enabled"] = bool(translation_enabled)
    cfg["locale"] = locale or TRANSLATION_APP_DEFAULTS["locale"]
    cfg["button_style"] = button_style or TRANSLATION_APP_DEFAULTS["button_style"]
    cfg["disabled_plugins"] = list(disabled_plugins or [])
    cfg["translate_options"] = bool(translate_options)
    return save_config(cfg)



def get_translator_config() -> dict:
    """
    获取翻译 API 配置

    Returns:
        包含 base_url / api_key / model / output_mode / target_lang /
        use_translated_dict 的字典（output_mode 固定 auto）
    """
    config = load_config()
    return {
        "base_url": config.get("translator_base_url", DEFAULT_TRANSLATOR_BASE_URL),
        "api_key": config.get("translator_api_key", ""),
        "model": config.get("translator_model", DEFAULT_TRANSLATOR_MODEL),
        "output_mode": DEFAULT_TRANSLATOR_OUTPUT_MODE,
        "target_lang": config.get("translator_target_lang", DEFAULT_TRANSLATOR_TARGET_LANG),
        "use_translated_dict": bool(config.get("translator_use_dict", DEFAULT_USE_TRANSLATED_DICT)),
    }


def save_translator_config(base_url: str, api_key: str, model: str, output_mode: str, target_lang: str = "", use_translated_dict: Optional[bool] = None) -> bool:
    """
    保存翻译 API 配置到 config.json

    Args:
        base_url: OpenAI 兼容 API 基础 URL
        api_key: API Key
        model: 模型名（如 gpt-4o-mini / deepseek-chat / qwen-plus）
        output_mode: 兼容参数，已废弃（固定写入 auto）
        target_lang: 目标语言代码（如 zh-CN / en / ja）
        use_translated_dict: 是否复用已翻译文件作为字典（None 表示不修改）

    Returns:
        是否保存成功
    """
    cfg = load_config()
    cfg["translator_base_url"] = base_url or DEFAULT_TRANSLATOR_BASE_URL
    cfg["translator_api_key"] = api_key or ""
    cfg["translator_model"] = model or DEFAULT_TRANSLATOR_MODEL
    cfg["translator_output_mode"] = DEFAULT_TRANSLATOR_OUTPUT_MODE
    cfg["translator_target_lang"] = target_lang if target_lang in SUPPORTED_TARGET_LANGS else DEFAULT_TRANSLATOR_TARGET_LANG
    if use_translated_dict is not None:
        cfg["translator_use_dict"] = bool(use_translated_dict)
    return save_config(cfg)
