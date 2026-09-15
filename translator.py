"""
翻译客户端模块（OpenAI 兼容 API）

调用 OpenAI 兼容的 Chat Completions 接口，
将 ComfyUI 节点定义（title/inputs/outputs/widgets/category）翻译为中文，
返回保持 JSON 结构不变的翻译结果。

支持任何 OpenAI 兼容 API：
- OpenAI: https://api.openai.com/v1
- DeepSeek: https://api.deepseek.com/v1
- 通义千问: https://dashscope.aliyuncs.com/compatible-mode/v1
- 智谱: https://open.bigmodel.cn/api/paas/v4
- 其他自建/代理 API

要求 API 支持 response_format={"type": "json_object"} 以保证 JSON 输出。
"""

import json
import os
import time
import re
import logging
import urllib.request
import urllib.error
from typing import Optional, Dict, Any, List, Tuple

from . import config

logger = logging.getLogger("UIIIAIII Toolkit")

# 请求超时（秒）：翻译任务通常较快，但大插件可能 token 多
DEFAULT_TIMEOUT = 180


# ============================================================
# 代理检测（自动从环境变量或 Windows 注册表读取代理设置）
# ============================================================

def _get_proxy() -> Optional[str]:
    """
    获取代理地址

    优先级：
    1. 环境变量 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
    2. Windows 注册表中的系统代理设置（ProxyEnable + ProxyServer）

    Returns:
        代理 URL（如 "http://127.0.0.1:7897"），未配置则返回 None
    """
    # 1. 优先从环境变量读取
    proxy = (
        os.environ.get("HTTPS_PROXY")
        or os.environ.get("HTTP_PROXY")
        or os.environ.get("ALL_PROXY")
        or os.environ.get("https_proxy")
        or os.environ.get("http_proxy")
        or os.environ.get("all_proxy")
    )
    if proxy:
        logger.info("使用环境变量代理：%s", proxy)
        return proxy

    # 2. Windows 系统：从注册表读取系统代理设置
    # Python urllib 默认不读取 Windows 注册表代理，需手动读取
    if os.name == "nt":
        try:
            import winreg
            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            ) as key:
                proxy_enable, _ = winreg.QueryValueEx(key, "ProxyEnable")
                if proxy_enable:
                    proxy_server, _ = winreg.QueryValueEx(key, "ProxyServer")
                    if proxy_server:
                        # ProxyServer 可能是 "127.0.0.1:7897" 或 "http=127.0.0.1:7897;https=127.0.0.1:7897"
                        # 简化处理：取第一个代理地址
                        first_proxy = proxy_server.split(";")[0].split("=")[-1].strip()
                        proxy_url = f"http://{first_proxy}"
                        logger.info("使用 Windows 系统代理：%s", proxy_url)
                        return proxy_url
        except Exception as e:
            logger.debug("读取 Windows 注册表代理设置失败：%s", e)

    return None


# ============================================================
# 系统提示词生成（根据目标语言动态生成）
# ============================================================

# 目标语言到语言名称（中文）的映射，用于动态生成翻译系统提示词
TARGET_LANG_NAMES = {
    "zh-CN": "简体中文",
    "zh-TW": "繁體中文",
    "en": "English",
    "ja": "日本語",
    "ko": "한국어",
    "fr": "Français",
    "de": "Deutsch",
    "es": "Español",
    "ru": "Русский",
    "pt": "Português",
    "it": "Italiano",
    "ar": "العربية",
}


def build_system_prompt(target_lang: str = "zh-CN") -> str:
    """
    根据目标语言生成系统提示词

    Args:
        target_lang: 目标语言代码（如 zh-CN / en / ja）

    Returns:
        完整的系统提示词字符串
    """
    lang_name = TARGET_LANG_NAMES.get(target_lang, "简体中文")

    return f"""你是 ComfyUI 翻译专家。将给定的 JSON 翻译为{lang_name}。

输入 JSON 可能包含三类数据：nodes（节点定义）、categories（分类）、menus（菜单/UI 文本）。

## 翻译规则

### 通用规则
1. **保持 JSON 结构和 key 完全不变**，只翻译 value（字符串值）
2. **必须翻译输入 JSON 中的所有节点和所有字段**，不得遗漏任何节点或字段
3. 如果某 value 已经是{lang_name}，保持不变
4. 返回纯 JSON，不要包含 markdown 代码块标记或解释文字

### nodes（节点定义）
- title：翻译为简洁的{lang_name}短语
- description：翻译为完整的{lang_name}说明句（鼠标悬停节点标题时显示）
- inputs/outputs/widgets 的字段名：翻译为{lang_name}术语
- 以 tooltip 原文为 key 的条目（通常是一整句英文说明）：
  需翻译为通顺的{lang_name}句子（鼠标悬停输入/输出端口时显示的提示）

### categories（分类）
- 扁平 key-value 结构，value 翻译为{lang_name}分类名
- 如 "Agnes" → "Agnes"（专有名词可保留）

### menus（菜单/UI 文本）
- 扁平 key-value 结构，key 是英文原文，value 需翻译为{lang_name}
- 这些是 UI 界面文本：菜单项、按钮、对话框标签、设置项等
- 翻译为符合 UI 习惯的简洁{lang_name}（如 "Add Node" → "新建节点"）

### 不翻译的内容
- 类型标识：IMAGE、STRING、INT、FLOAT、BOOLEAN、LATENT、MODEL、CLIP、VAE、CONDITIONING、MASK、CONTROL_NET 等
- 英文枚举值（如 "euler"、"karras"、"ddim"）
- 文件路径、模型 ID、API 名称

### 翻译底线（禁止原样返回英文，否则视为漏翻）
- 参数名、控件名、字段名（如 seed、steps、cfg、width、height、strength、denoise、sampler_name、scheduler 等）一律翻译为{lang_name}术语
- 一切英文原文的 value（标题、描述、tooltip 说明、字段名）都必须给出{lang_name}翻译，严禁原样返回英文
- JSON 的 key 永远保持英文原文不变，只翻译 value；翻译后 value 不得与 key 相同

### 术语规范（参考，按目标语言习惯调整）
- prompt → 提示词
- negative_prompt → 反向提示词
- seed → 种子
- steps → 步数
- guidance/cfg → 引导系数
- sampler → 采样器
- scheduler → 调度器
- denoise → 降噪强度
- width → 宽度
- height → 高度
- strength → 强度
- image → 图像
- video → 视频
- mask → 蒙版
- latent → 隐空间
- model → 模型
- Add Node → 新建节点
- Save → 保存
- Load → 加载
- Clone → 克隆
- Queue Prompt → 执行提示词

## 输出格式
返回与输入结构完全相同的 JSON，仅 value 被翻译为{lang_name}。
**输出 JSON 中的节点数和字段数必须与输入完全一致，不得省略任何节点或字段。**
"""


# ============================================================
# 核心翻译函数
# ============================================================

# 翻译 API 输出 token 上限
# 64K：新一代主流模型（deepseek-v4 / gpt 系 / qwen3 等）均支持；
# 旧模型若不支持会返回 HTTP 400（提示 max_tokens 超限），此时自动按阶梯降级重试
MAX_TOKENS = 65536

# max_tokens 降级阶梯（主流 API 兼容：模型不支持大值时逐级回退）
MAX_TOKENS_FALLBACKS = [65536, 32768, 16384, 8192, 4096]


def _make_batches(items: List[tuple], max_tokens: int) -> List[Dict[str, Any]]:
    """
    按预估 token 动态组批（替代固定批大小）

    以字符数估算：单批输入 JSON 字符数上限 = max_tokens * 2
    （约 max_tokens/2 token 输入；中文译文输出 token 少于原文输入 token，
    因此输出不会超过 max_tokens 上限）

    Args:
        items: [(key, value), ...] 待翻译条目
        max_tokens: 输出 token 上限

    Returns:
        [{key: value, ...}, ...] 批次列表
    """
    limit_chars = max_tokens * 2
    batches: List[Dict[str, Any]] = []
    cur: List[tuple] = []
    cur_chars = 0
    for key, value in items:
        item_chars = len(json.dumps({key: value}, ensure_ascii=False))
        if cur and cur_chars + item_chars > limit_chars:
            batches.append(dict(cur))
            cur, cur_chars = [], 0
        cur.append((key, value))
        cur_chars += item_chars
    if cur:
        batches.append(dict(cur))
    return batches


# ============================================================
# 已翻译文件字典（复用已有译文，保证术语一致）
# ============================================================

def load_translation_dict(target_lang: str) -> Dict[str, Any]:
    """
    加载已翻译文件构建复用字典

    扫描本插件 locales/<target_lang>/ 下 Nodes/Menus/Categories 的所有 JSON：
    - terms: 英文原文 → 已有译文（inputs/outputs/widgets 的 key、menus、categories）
    - by_class: {ClassName: {"title": 译文, "description": 译文}} 节点级缓存
      （title 显示名 / description 的英文原文未持久化，仅当节点结构未变时才可安全复用）

    Returns:
        {"terms": {...}, "by_class": {...}}
    """
    terms: Dict[str, str] = {}
    by_class: Dict[str, Any] = {}
    plugin_dir = os.path.dirname(os.path.abspath(__file__))
    base = os.path.join(plugin_dir, "locales", target_lang)
    for sub in ("Nodes", "Menus", "Categories"):
        sub_dir = os.path.join(base, sub)
        if not os.path.isdir(sub_dir):
            continue
        for fn in sorted(os.listdir(sub_dir)):
            if not fn.endswith(".json"):
                continue
            path = os.path.join(sub_dir, fn)
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except Exception as e:
                logger.debug("读取翻译文件失败，跳过：%s（%s）", path, e)
                continue
            if not isinstance(data, dict):
                continue
            if sub == "Nodes":
                for class_name, node_def in data.items():
                    if not isinstance(node_def, dict):
                        continue
                    # 节点级缓存：title / description 译文
                    title = node_def.get("title")
                    desc = node_def.get("description")
                    cached = {}
                    if isinstance(title, str) and title:
                        cached["title"] = title
                    if isinstance(desc, str) and desc:
                        cached["description"] = desc
                    if cached:
                        by_class[class_name] = cached
                    # inputs/outputs/widgets 的 key（字段名/tooltip 原句）→ 译文
                    for field in ("inputs", "outputs", "widgets"):
                        kv = node_def.get(field)
                        if isinstance(kv, dict):
                            for k, v in kv.items():
                                if isinstance(v, str) and v and v != k:
                                    terms[k] = v
            else:
                # Menus / Categories：扁平 en → zh
                for k, v in data.items():
                    if isinstance(v, str) and v and v != k:
                        terms[k] = v
    logger.info("已加载翻译字典（%s）：%d 条词条，%d 个节点缓存", target_lang, len(terms), len(by_class))
    return {"terms": terms, "by_class": by_class}


def _dict_hit(terms: Dict[str, str], key: str) -> Optional[str]:
    """查询字典：命中且译文不等于原文时返回译文，否则 None"""
    translated = terms.get(key)
    if isinstance(translated, str) and translated and translated != key:
        return translated
    return None


def _apply_dict_to_input(
    input_nodes: Dict[str, Any],
    tdict: Dict[str, Any],
) -> tuple:
    """
    用字典预填充节点定义：命中的条目直接填入已有译文并从 API 输入中剔除

    复用规则：
    - title：按标题原文精确匹配词条
    - description：仅当节点结构未变（inputs/outputs/widgets 全部命中字典）时
      复用同类名节点的旧译文（description 的英文原文未持久化，无法精确匹配）
    - inputs/outputs/widgets：按英文原名/tooltip 原句精确匹配词条

    Returns:
        (api_nodes, filled_nodes, hit_count)
        api_nodes: 仅含未命中条目、需要调用 API 翻译的节点定义
        filled_nodes: 仅含字典命中条目的节点定义
        hit_count: 命中条目总数
    """
    terms = tdict.get("terms") or {}
    by_class = tdict.get("by_class") or {}
    api_nodes: Dict[str, Any] = {}
    filled_nodes: Dict[str, Any] = {}
    hit_count = 0

    for class_name, node_def in input_nodes.items():
        if not isinstance(node_def, dict):
            api_nodes[class_name] = node_def
            continue

        api_def: Dict[str, Any] = {}
        filled_def: Dict[str, Any] = {}
        cached = by_class.get(class_name) or {}

        # inputs/outputs/widgets：按原文 key 精确匹配
        for field in ("inputs", "outputs", "widgets"):
            raw = node_def.get(field)
            if not isinstance(raw, dict) or not raw:
                continue
            api_kv: Dict[str, Any] = {}
            filled_kv: Dict[str, Any] = {}
            for k, v in raw.items():
                translated = _dict_hit(terms, k)
                if translated:
                    filled_kv[k] = translated
                    hit_count += 1
                else:
                    api_kv[k] = v
            if api_kv:
                api_def[field] = api_kv
            if filled_kv:
                filled_def[field] = filled_kv

        # title / description：原文未持久化，仅当节点结构未变
        #（inputs/outputs/widgets 全部命中字典）时复用同类名节点的旧译文
        structure_unchanged = bool(cached) and not any(
            f in api_def for f in ("inputs", "outputs", "widgets")
        )
        if structure_unchanged:
            title = node_def.get("title")
            if isinstance(title, str) and title and cached.get("title") and cached["title"] != title:
                filled_def["title"] = cached["title"]
                hit_count += 1
            else:
                api_def["title"] = title
            desc = node_def.get("description")
            if isinstance(desc, str) and desc:
                if cached.get("description"):
                    filled_def["description"] = cached["description"]
                    hit_count += 1
                else:
                    api_def["description"] = desc
        else:
            title = node_def.get("title")
            if isinstance(title, str) and title:
                # 显示名原文可能在其他节点的词条中出现过（跨插件同名显示名）
                translated = _dict_hit(terms, title)
                if translated:
                    filled_def["title"] = translated
                    hit_count += 1
                else:
                    api_def["title"] = title
            desc = node_def.get("description")
            if isinstance(desc, str) and desc:
                api_def["description"] = desc

        if api_def:
            api_nodes[class_name] = api_def
        if filled_def:
            filled_nodes[class_name] = filled_def

    return api_nodes, filled_nodes, hit_count


def _merge_dict_and_api(
    filled_nodes: Dict[str, Any],
    api_translated: Dict[str, Any],
) -> Dict[str, Any]:
    """
    字段级合并字典命中结果与 API 翻译结果

    Args:
        filled_nodes: 字典命中的节点定义（部分字段）
        api_translated: API 翻译返回的节点定义

    Returns:
        合并后的完整节点定义
    """
    merged: Dict[str, Any] = {}
    for class_name in set(filled_nodes) | set(api_translated):
        filled_def = filled_nodes.get(class_name) or {}
        api_def = api_translated.get(class_name)
        if not isinstance(api_def, dict):
            merged[class_name] = dict(filled_def)
            continue
        combined = dict(api_def)
        for key, val in filled_def.items():
            if key in ("title", "description"):
                combined.setdefault(key, val)
            elif isinstance(val, dict):
                cur = combined.get(key)
                if isinstance(cur, dict):
                    for k, v in val.items():
                        cur.setdefault(k, v)
                else:
                    combined[key] = dict(val)
        merged[class_name] = combined
    return merged


def _call_translate_api(
    batch_data: Dict[str, Any],
    cfg: Dict[str, Any],
    system_prompt: str,
    opener: "urllib.request.OpenerDirector",
) -> Dict[str, Any]:
    """
    单次翻译 API 调用（含重试、finish_reason 检查、JSON 解析）

    Args:
        batch_data: 单批待翻译数据 {"nodes": {...}, "categories": {...}}
        cfg: 翻译配置
        system_prompt: 系统提示词
        opener: urllib opener（已配置代理）

    Returns:
        翻译后的字典

    Raises:
        RuntimeError: API 调用失败或响应异常
    """
    api_key = cfg["api_key"]
    base_url = cfg["base_url"].rstrip("/")
    if base_url.endswith("/chat/completions"):
        base_url = base_url[: -len("/chat/completions")]
    model = cfg["model"]

    # 构造用户消息
    node_count = len(batch_data.get("nodes", {}))
    user_content = "请翻译以下 JSON 节点定义（保持结构和 key 不变，只翻译 value）：\n\n" + \
                    json.dumps(batch_data, ensure_ascii=False, indent=2)

    # 构造请求体（设置 max_tokens 避免输出截断）
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        # 翻译是确定性任务：temperature 设为 0，避免每次输出措辞不同
        "temperature": 0,
        "max_tokens": MAX_TOKENS,
        "response_format": {"type": "json_object"},
        # 关闭思考/推理模式（OpenAI 兼容写法）。注意：部分模型（如 agnes-2.5-flash）会忽略此参数
        "thinking": {"type": "disabled"},
    }

    url = f"{base_url}/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        "Connection": "close",
    }

    logger.info("调用翻译 API：%s (model=%s, 本批节点数=%d)", base_url, model, node_count)

    # 重试机制（3 次；429 限流等退避后重试；max_tokens 超限自动降级，不占用重试次数）
    last_error: Optional[Exception] = None
    result = None
    # 429/503 限流退避秒数（第 1 次失败后等 2s，第 2 次失败后等 5s）
    RATE_LIMIT_BACKOFF = (2, 5, 10)
    attempt = 0
    while attempt < 3:
        wait_for_retry = False
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            req = urllib.request.Request(url, data=data, headers=headers, method="POST")
            with opener.open(req, timeout=DEFAULT_TIMEOUT) as resp:
                body = resp.read().decode("utf-8")
            result = json.loads(body)
            break
        except urllib.error.HTTPError as e:
            err_body = ""
            try:
                err_body = e.read().decode("utf-8", errors="ignore")
            except Exception:
                pass
            # max_tokens 超出模型输出上限（旧模型主流上限 8K/16K/32K）：
            # 优先从错误信息解析实际上限（如 OpenAI 风格 "supports at most 16384"）
            # 一步降到位；解析不到则按阶梯逐级降。重试不占用普通重试次数（主流 API 兼容）
            if e.code == 400 and "max_tokens" in err_body.lower():
                lowered = None
                m = re.search(r"at most (\d+)", err_body)
                if m:
                    cap = int(m.group(1))
                    lowered = next((v for v in MAX_TOKENS_FALLBACKS if v <= cap), None)
                if lowered is None:
                    lowered = next((v for v in MAX_TOKENS_FALLBACKS if v < payload["max_tokens"]), None)
                if lowered:
                    logger.info("API 不支持 max_tokens=%d，降级为 %d 后重试", payload["max_tokens"], lowered)
                    payload["max_tokens"] = lowered
                    continue
            last_error = RuntimeError(f"翻译 API 返回 HTTP {e.code}：{err_body[:500]}")
            logger.warning("翻译 API 第 %d 次失败（HTTP %d）：%s", attempt + 1, e.code, err_body[:200])
            # 限流类错误：稍等再试，避免连续打击同一个限流窗口
            wait_for_retry = e.code in (429, 503)
        except Exception as e:
            last_error = RuntimeError(f"翻译 API 请求失败：{e}")
            logger.warning("翻译 API 第 %d 次失败：%s", attempt + 1, e)
        attempt += 1
        if attempt < 3:
            if wait_for_retry:
                backoff = RATE_LIMIT_BACKOFF[attempt - 1]
                logger.info("翻译 API 限流，%d 秒后重试...", backoff)
                time.sleep(backoff)
            else:
                time.sleep(0.5)
    else:
        raise last_error  # type: ignore

    if result is None:
        raise RuntimeError("翻译 API 无响应")

    # 解析响应
    choices = result.get("choices", [])
    if not choices:
        raise RuntimeError(f"翻译 API 响应缺少 choices：{result}")

    choice = choices[0]
    content = choice.get("message", {}).get("content", "")
    if not content:
        raise RuntimeError("翻译 API 响应 content 为空")

    # 检查 finish_reason：若为 "length" 表示输出被 max_tokens 截断
    finish_reason = choice.get("finish_reason", "")
    if finish_reason == "length":
        logger.warning("翻译 API 响应因 max_tokens 截断（finish_reason=length），本批 %d 个节点可能不完整", node_count)

    # 清理可能的 markdown 代码块标记
    content = content.strip()
    if content.startswith("```"):
        lines = content.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].startswith("```"):
            lines = lines[:-1]
        content = "\n".join(lines).strip()

    try:
        translated = json.loads(content)
    except json.JSONDecodeError as e:
        # JSON 解析失败：可能是 max_tokens 截断导致 JSON 不完整
        raise RuntimeError(
            f"翻译 API 返回的 JSON 解析失败（可能是输出被截断，finish_reason={finish_reason}）：{e}\n"
            f"原始内容末尾：...{content[-300:]}"
        )

    if not isinstance(translated, dict):
        raise RuntimeError(f"翻译 API 返回的 JSON 不是字典：{type(translated)}")

    # 兼容平铺返回结构：只有当 nodes/categories/menus 三种包裹键全部缺失时，
    # 才视为平铺结构自动包裹。否则 menus 请求的正确返回 {"menus": {...}}（不含
    # nodes/categories 键）会被误判为平铺而包进 nodes，导致菜单翻译全部丢失。
    if not any(k in translated for k in ("nodes", "categories", "menus")):
        logger.info("翻译 API 返回平铺结构（无 nodes/categories/menus 包裹），自动包裹")
        translated = {"nodes": translated}

    return translated


def _merge_translated_node(orig_def: Dict[str, Any], ret_def: Dict[str, Any]) -> int:
    """
    字段级补全：对单个节点，检查 description / widgets / inputs / outputs 的 key
    是否与原始一致。翻译 API 可能省略部分字段，此处用原始值补全。

    Args:
        orig_def: 原始节点定义
        ret_def: 翻译后的节点定义

    Returns:
        补全的字段数
    """
    field_missing_count = 0

    # description 字段补全
    if "description" in orig_def and "description" not in ret_def:
        ret_def["description"] = orig_def["description"]
        field_missing_count += 1
        logger.debug("description 字段被 API 省略，已用原文补全")

    # widgets / inputs / outputs 字典的 key 补全
    for field in ("widgets", "inputs", "outputs"):
        orig_dict = orig_def.get(field)
        ret_dict = ret_def.get(field)
        if isinstance(orig_dict, dict) and isinstance(ret_dict, dict):
            for k, v in orig_dict.items():
                if k not in ret_dict:
                    ret_dict[k] = v
                    field_missing_count += 1
        elif isinstance(orig_dict, dict) and field not in ret_def:
            # 翻译结果完全缺少该字段，用原始值填充
            ret_def[field] = orig_dict
            field_missing_count += len(orig_dict)

    return field_missing_count


def _backfill_untranslated(
    all_translated_nodes: Dict[str, Any],
    input_nodes: Dict[str, Any],
    cfg: Dict[str, Any],
    system_prompt: str,
    opener: "urllib.request.OpenerDirector",
) -> None:
    """补译保持英文原文的条目。

    主插件界面翻译用"英文原文"作 key 查找翻译，若某 tooltip/字段名
    的翻译结果仍是原文（或其缺失），UI 上就会一直显示英文。此处收集所有
    value==key 的条目与缺失条目，打包成单个伪节点再次调用翻译 API 补译。
    补译成功的写回；仍失败的保持原文（后续写出时被 value==key 过滤丢弃）。
    """
    # 收集待补译条目：node -> {field -> {original -> original}}
    backfill: Dict[str, Any] = {"nodes": {}}
    for class_name, orig_def in input_nodes.items():
        if not isinstance(orig_def, dict):
            continue
        ret_def = all_translated_nodes.get(class_name)
        for field in ("inputs", "outputs", "widgets"):
            od = orig_def.get(field)
            if not isinstance(od, dict) or not od:
                continue
            rd = ret_def.get(field) if isinstance(ret_def, dict) else None
            rd = rd if isinstance(rd, dict) else {}
            missing = {}
            # 1) 翻译结果中仍是原文的条目（value==key）
            # 2) 原定义存在但翻译结果缺失的条目
            for k in od:
                if k in rd and rd[k] != k:
                    continue  # 已翻译成功
                missing[k] = k
            if missing:
                backfill["nodes"].setdefault(class_name, {})
                backfill["nodes"][class_name][field] = missing
    if not backfill["nodes"]:
        return

    logger.info("补译 %d 个节点的未翻译条目", len(backfill["nodes"]))
    try:
        result = _call_translate_api(backfill, cfg, system_prompt, opener)
        bid = result.get("nodes", {})
        if isinstance(bid, dict):
            for class_name, fields in bid.items():
                if class_name not in all_translated_nodes or not isinstance(fields, dict):
                    continue
                ret_def = all_translated_nodes[class_name]
                for field, kv in fields.items():
                    if not isinstance(kv, dict) or field not in ("inputs", "outputs", "widgets"):
                        continue
                    cur = ret_def.get(field)
                    if not isinstance(cur, dict):
                        cur = {}
                        ret_def[field] = cur
                    for src_key, trans_val in kv.items():
                        if isinstance(trans_val, str) and trans_val and src_key != trans_val:
                            cur[src_key] = trans_val
    except Exception as e:
        logger.warning("未翻译条目补译失败，保持原文：%s", e)


def translate_nodes(nodes_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    翻译节点定义 JSON（支持分批翻译 + 菜单翻译）

    批次按预估 token 动态划分（单批输入字符数上限 = MAX_TOKENS * 2），
    避免输出被 max_tokens 截断的同时尽量减少 API 调用次数。
    每批翻译后合并结果，并对丢失的节点/字段用原始值补全。
    菜单文本同样动态分批翻译，避免单次请求过大。

    Args:
        nodes_data: {
            "nodes": {ClassName: {...}},
            "categories": {...},
            "menus": {...}
        }

    Returns:
        翻译后的字典（结构相同）
    """
    cfg = config.get_translator_config()
    api_key = cfg["api_key"]
    if not api_key:
        raise ValueError(
            "未配置翻译 API Key。请在 ComfyUI 设置 → UIIIAIII Toolkit → 翻译API 中填写 OpenAI 兼容 API 的 key。"
        )

    target_lang = cfg.get("target_lang", "zh-CN")
    system_prompt = build_system_prompt(target_lang)

    # 构建代理 opener
    proxy_url = _get_proxy()
    if proxy_url:
        proxy_handler = urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url})
        opener = urllib.request.build_opener(proxy_handler)
        logger.info("翻译请求通过代理发送：%s", proxy_url)
    else:
        opener = urllib.request.build_opener()

    input_nodes = nodes_data.get("nodes", {})
    input_categories = nodes_data.get("categories", {})
    input_menus = nodes_data.get("menus", {})
    total_node_count = len(input_nodes) if isinstance(input_nodes, dict) else 0
    total_menu_count = len(input_menus) if isinstance(input_menus, dict) else 0

    # 已翻译文件字典：开启时加载并对输入做预填充（命中条目直接复用，不再调用 API）
    tdict: Optional[Dict[str, Any]] = None
    if cfg.get("use_translated_dict"):
        try:
            tdict = load_translation_dict(target_lang)
        except Exception as e:
            logger.warning("加载翻译字典失败，忽略字典复用：%s", e)
            tdict = None

    dict_hits = 0
    node_dict_hits = 0
    if tdict and isinstance(input_nodes, dict) and input_nodes:
        api_nodes, filled_nodes, node_dict_hits = _apply_dict_to_input(input_nodes, tdict)
        dict_hits += node_dict_hits
    else:
        api_nodes, filled_nodes = input_nodes, {}

    # 分类字典预填
    dict_hit_categories: Dict[str, str] = {}
    api_categories = input_categories
    if tdict and isinstance(input_categories, dict) and input_categories:
        terms = tdict.get("terms") or {}
        api_categories = {}
        for k in input_categories:
            translated = _dict_hit(terms, k)
            if translated:
                dict_hit_categories[k] = translated
                dict_hits += 1
            else:
                api_categories[k] = input_categories[k]

    # 菜单字典预填
    dict_hit_menus: Dict[str, str] = {}
    api_menus = input_menus
    if tdict and isinstance(input_menus, dict) and input_menus:
        terms = tdict.get("terms") or {}
        api_menus = {}
        for k in input_menus:
            translated = _dict_hit(terms, k)
            if translated:
                dict_hit_menus[k] = translated
                dict_hits += 1
            else:
                api_menus[k] = input_menus[k]

    if dict_hits:
        logger.info(
            "字典预填充：%d 条命中复用（节点 %d / 分类 %d / 菜单 %d），API 输入节点 %d 个",
            dict_hits, node_dict_hits, len(dict_hit_categories), len(dict_hit_menus),
            len(api_nodes) if isinstance(api_nodes, dict) else 0,
        )

    logger.info("开始翻译：共 %d 个节点，%d 条菜单文本", total_node_count, total_menu_count)

    all_translated_nodes: Dict[str, Any] = {}
    translated_categories: Dict[str, Any] = {}

    # 分批串行翻译节点（本 API 端点对并发请求会排队串行化，并发反而更慢）
    # 注意：api_nodes 仅含字典未命中的条目，命中部分在 filled_nodes 中待合并
    # 批次按预估 token 动态划分（MAX_TOKENS=64K 时单批可容纳远多于固定 16 个节点）
    if isinstance(api_nodes, dict) and api_nodes:
        node_batches = _make_batches(list(api_nodes.items()), MAX_TOKENS)
        total_batches = len(node_batches)

        for batch_idx in range(total_batches):
            batch_nodes = node_batches[batch_idx]

            batch_data = {"nodes": batch_nodes}
            # 分类只在第一批带上（提供上下文，不重复翻译；结果取自独立的分类请求）
            if batch_idx == 0 and api_categories:
                batch_data["categories"] = api_categories

            batch_num = batch_idx + 1
            logger.info("翻译第 %d/%d 批（%d 个节点）", batch_num, total_batches, len(batch_nodes))

            try:
                batch_result = _call_translate_api(batch_data, cfg, system_prompt, opener)
                batch_translated_nodes = batch_result.get("nodes", {})
                if isinstance(batch_translated_nodes, dict):
                    all_translated_nodes.update(batch_translated_nodes)
                    logger.info("第 %d 批翻译完成，返回 %d 个节点",
                                batch_num, len(batch_translated_nodes))
                else:
                    logger.warning("第 %d 批返回的 nodes 不是字典，跳过", batch_num)
            except Exception as e:
                # 单批失败：用原始值补全本批节点，不中断整体流程
                logger.error("第 %d 批翻译失败，用原始值补全：%s", batch_num, e)
                for class_name, orig_def in batch_nodes.items():
                    if isinstance(orig_def, dict):
                        all_translated_nodes[class_name] = orig_def

    # 分类翻译结果（单独请求，避免与节点批混淆；字典命中的分类直接复用）
    if api_categories:
        try:
            cat_batch_data = {"nodes": {}, "categories": api_categories}
            cat_result = _call_translate_api(cat_batch_data, cfg, system_prompt, opener)
            api_cat_result = cat_result.get("categories", {})
            if not isinstance(api_cat_result, dict) or not api_cat_result:
                # 兼容平铺返回：请求同时含空 nodes + categories 时，模型可能直接返回 {"segment": "译文"}
                inner = cat_result.get("nodes", {})
                if isinstance(inner, dict) and inner and all(isinstance(v, str) for v in inner.values()):
                    api_cat_result = inner
                else:
                    api_cat_result = {}
            translated_categories = {**dict_hit_categories, **api_cat_result}
        except Exception as e:
            logger.error("分类翻译失败，用原始值补全：%s", e)
            translated_categories = {**dict_hit_categories, **api_categories}
    else:
        translated_categories = dict(dict_hit_categories)

    logger.info("节点/分类翻译完成：节点 %d 个，分类 %d 个",
                len(all_translated_nodes), len(translated_categories))

    # 菜单翻译（批次按预估 token 动态划分，菜单文本较短单批可容纳更多；字典命中的直接复用）
    translated_menus: Dict[str, str] = dict(dict_hit_menus)
    if isinstance(api_menus, dict) and api_menus:
        menu_batches = _make_batches(list(api_menus.items()), MAX_TOKENS)
        menu_total_batches = len(menu_batches)

        for batch_idx in range(menu_total_batches):
            batch_menus = menu_batches[batch_idx]

            batch_data = {"menus": batch_menus}
            batch_num = batch_idx + 1
            logger.info("翻译菜单第 %d/%d 批（%d 条）", batch_num, menu_total_batches, len(batch_menus))

            try:
                batch_result = _call_translate_api(batch_data, cfg, system_prompt, opener)
                batch_translated_menus = batch_result.get("menus", {})
                if not isinstance(batch_translated_menus, dict) or not batch_translated_menus:
                    # 兼容平铺返回：本批请求只有 menus，模型可能整体平铺返回 {"english": "译文"}
                    inner = batch_result.get("nodes", {})
                    if isinstance(inner, dict) and inner and all(isinstance(v, str) for v in inner.values()):
                        batch_translated_menus = inner
                    else:
                        batch_translated_menus = {}
                if isinstance(batch_translated_menus, dict):
                    translated_menus.update(batch_translated_menus)
                    logger.info("菜单第 %d 批翻译完成，返回 %d 条",
                                batch_num, len(batch_translated_menus))
            except Exception as e:
                logger.error("菜单第 %d 批翻译失败，用原始值补全：%s", batch_num, e)
                translated_menus.update(batch_menus)

        # 补全丢失的菜单项（字典命中的已在 translated_menus 中，只需对照 api_menus）
        if isinstance(api_menus, dict):
            missing_menus = set(api_menus.keys()) - set(translated_menus.keys())
            for key in missing_menus:
                translated_menus[key] = api_menus[key]
            if missing_menus:
                logger.warning("菜单翻译丢失 %d 条，已用原始值补全", len(missing_menus))

    # 节点级补全：检查丢失的节点（仅对照 API 输入；字典命中部分在合并时补入）
    if isinstance(api_nodes, dict):
        input_keys = set(api_nodes.keys())
        returned_keys = set(all_translated_nodes.keys())
        missing_keys = input_keys - returned_keys
        if missing_keys:
            logger.warning(
                "翻译完成但丢失 %d 个节点，用原始值补全：%s",
                len(missing_keys),
                ", ".join(sorted(missing_keys)[:10]) + ("..." if len(missing_keys) > 10 else "")
            )
            for key in missing_keys:
                original = api_nodes[key]
                if isinstance(original, dict):
                    all_translated_nodes[key] = original

    # 合并字典命中与 API 翻译结果（字段级），得到完整节点定义
    all_translated_nodes = _merge_dict_and_api(filled_nodes, all_translated_nodes)

    # 未翻译条目补译：收集翻译结果中保持英文原文的条目（API 省略或未翻译的
    # tooltip/字段名），用单独请求补译真正翻出中文，避免直接丢弃导致悬停永远英文
    _backfill_untranslated(all_translated_nodes, input_nodes, cfg, system_prompt, opener)

    # 字段级补全
    field_missing_total = 0
    if isinstance(input_nodes, dict):
        for class_name, orig_def in input_nodes.items():
            if not isinstance(orig_def, dict):
                continue
            ret_def = all_translated_nodes.get(class_name)
            if not isinstance(ret_def, dict):
                continue
            field_missing_total += _merge_translated_node(orig_def, ret_def)

    if field_missing_total > 0:
        logger.warning("翻译 API 共省略了 %d 个字段，已用原始值补全", field_missing_total)

    logger.info(
        "翻译完成：节点 %d/%d，菜单 %d/%d",
        len(all_translated_nodes), total_node_count,
        len(translated_menus), total_menu_count
    )

    return {
        "nodes": all_translated_nodes,
        "categories": translated_categories,
        "menus": translated_menus,
        "dict_hits": dict_hits,
    }


# ============================================================
# 配置检查
# ============================================================

def check_config() -> Dict[str, Any]:
    """
    检查翻译 API 配置是否完整

    Returns:
        包含 is_configured / base_url / model 的字典
    """
    cfg = config.get_translator_config()
    return {
        "is_configured": bool(cfg["api_key"]),
        "base_url": cfg["base_url"],
        "model": cfg["model"],
        "output_mode": cfg["output_mode"],
        "target_lang": cfg.get("target_lang", "zh-CN"),
    }
