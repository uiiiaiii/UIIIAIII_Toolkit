"""
Agnes AI API 客户端封装模块

封装 Agnes 图像模型（2.5 / 2.1 Flash）和 Agnes Video V2.0 的调用逻辑：
- 图像 API：文生图、图生图（同步返回结果）
- 视频 API：文生视频、图生视频、关键帧动画（异步任务，需轮询）

文档参考：
- https://agnes-ai.com/zh-Hans/docs/agnes-image-25-flash
- https://agnes-ai.com/zh-Hans/docs/agnes-image-21-flash
- https://agnes-ai.cn/zh-Hans/docs/agnes-video-v20
"""

import os
import time
import base64
import logging
from io import BytesIO
from typing import Optional, List, Dict, Any, Tuple

import requests

# 设置日志记录器
logger = logging.getLogger("UIIIAIII Toolkit")

# ============================================================
# 常量定义
# ============================================================

# Agnes AI API 基础地址
AGNES_API_BASE_URL = "https://api.agnes-ai.cn"

# 图像生成端点（兼容 OpenAI 接口格式）
AGNES_IMAGE_ENDPOINT = "/v1/images/generations"

# 视频任务创建端点
AGNES_VIDEO_CREATE_ENDPOINT = "/v1/videos"

# 视频结果查询端点（推荐方式：使用 video_id）
AGNES_VIDEO_RESULT_ENDPOINT = "/agnesapi"

# 模型名称
# 图像模型：2.5 Flash 为最新一代（默认），2.1 Flash 保留用于旧工作流与对比
AGNES_IMAGE_MODELS = ["agnes-image-2.5-flash", "agnes-image-2.1-flash"]
AGNES_IMAGE_MODEL = AGNES_IMAGE_MODELS[0]
AGNES_VIDEO_MODEL = "agnes-video-2.5-flash"

# 默认请求超时时间（秒）
# 文生图通常 30~90 秒，图生图需要上传图像并处理，耗时更长
# 设为 180 秒（3 分钟）以覆盖大图、高负载和网络波动场景
DEFAULT_TIMEOUT = 180

# 视频任务轮询间隔（秒）
DEFAULT_POLL_INTERVAL = 5

# 视频任务最大轮询时间（秒，默认 10 分钟）
DEFAULT_MAX_POLL_TIME = 600

# 支持的图像尺寸档位
IMAGE_SIZE_OPTIONS = ["1K", "2K", "3K", "4K"]

# 支持的图像宽高比
IMAGE_RATIO_OPTIONS = ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"]

# 图生图可用的比例选项（包含 auto 自动检测输入图像比例）
IMAGE_RATIO_OPTIONS_WITH_AUTO = ["auto"] + IMAGE_RATIO_OPTIONS

# 参考图片数量上限（多图合成）
IMAGE_MAX_REFERENCE_IMAGES = 5

# 各比例的浮点数值（宽/高），用于匹配最接近的比例
_RATIO_VALUES = {
    "1:1": 1.0,
    "3:4": 3.0 / 4.0,    # 0.75（竖图）
    "4:3": 4.0 / 3.0,    # 1.333（横图）
    "16:9": 16.0 / 9.0,  # 1.778（宽屏横图）
    "9:16": 9.0 / 16.0,  # 0.5625（竖屏）
    "2:3": 2.0 / 3.0,    # 0.667（竖图）
    "3:2": 3.0 / 2.0,    # 1.5（横图）
    "21:9": 21.0 / 9.0,  # 2.333（超宽横图）
}


def detect_image_ratio(image_tensor) -> str:
    """
    从 ComfyUI IMAGE 张量自动检测最接近的支持宽高比

    取输入图像的宽高比，匹配到 _RATIO_VALUES 中最接近的标准比例。

    Args:
        image_tensor: ComfyUI IMAGE 张量，格式为 [B, H, W, C]

    Returns:
        最接近的标准比例字符串（如 "16:9"）
    """
    # 处理批次：取第一张图
    if len(image_tensor.shape) == 4:
        img = image_tensor[0]
    else:
        img = image_tensor

    # IMAGE 格式为 [H, W, C]，获取宽高
    h = img.shape[0]
    w = img.shape[1]

    # 计算宽高比（宽/高）
    actual_ratio = float(w) / float(h)

    # 找到最接近的标准比例
    closest_ratio = min(
        _RATIO_VALUES.items(),
        key=lambda item: abs(item[1] - actual_ratio),
    )[0]

    logger.info(
        "自动检测图像比例：输入尺寸 %dx%d（宽高比 %.3f），匹配到 %s",
        w, h, actual_ratio, closest_ratio,
    )

    return closest_ratio

# 支持的视频时长（字符串秒数，官方支持 "4" 到 "12"）
VIDEO_SECONDS = [str(i) for i in range(4, 13)]

# 支持的视频画幅（2.5 Flash 固定 720P，通过 aspect_ratio 控制输出尺寸）
VIDEO_ASPECT_RATIOS = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]

# 参考素材数量上限（2.5 Flash）
VIDEO_MAX_REFERENCE_IMAGES = 5
VIDEO_MAX_REFERENCE_AUDIOS = 3


# ============================================================
# API Key 管理
# ============================================================

def get_api_key(api_key: Optional[str] = None) -> str:
    """
    获取 Agnes API Key

    优先级（从高到低）：
    1. 节点参数传入的 api_key
    2. 配置文件 config.json 中的 agnes_api_key（通过 ComfyUI 设置页面配置）
    3. 环境变量 AGNES_API_KEY / AGNES_AI_API_KEY

    Args:
        api_key: 节点参数传入的 API Key

    Returns:
        API Key 字符串

    Raises:
        ValueError: 未找到有效的 API Key
    """
    # 委托给 config 模块统一处理（优先级：节点参数 > 配置文件 > 环境变量）
    from . import config as _config
    return _config.get_agnes_api_key(api_key)


# ============================================================
# 图像 API 调用
# ============================================================

def generate_image(
    api_key: Optional[str] = None,
    prompt: str = "",
    model: Optional[str] = None,
    size: str = "2K",
    ratio: str = "1:1",
    image_data_uris: Optional[List[str]] = None,
    return_base64: bool = False,
    extra_params: Optional[Dict[str, Any]] = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> Tuple[Optional[str], Optional[str]]:
    """
    调用 Agnes Image 模型生成图像（支持文生图和图生图）

    Args:
        api_key: Agnes API Key，留空则自动从配置读取
        prompt: 图像生成或编辑的文本指令
        model: 模型名称（agnes-image-2.5-flash / agnes-image-2.1-flash），
               留空则使用默认模型（2.5 Flash）
        size: 输出尺寸档位（1K/2K/3K/4K）
        ratio: 宽高比（1:1/3:4/4:3/16:9/9:16/2:3/3:2/21:9）
        image_data_uris: 图生图输入图像列表（Data URI 或公共 URL）
        return_base64: 是否以 Base64 形式返回
        extra_params: 附加参数（如 response_format）
        timeout: 请求超时时间（秒）

    Returns:
        (url, b64_json) 元组，根据 return_base64 返回对应值

    Raises:
        RuntimeError: API 调用失败
    """
    # 自动获取 API Key（优先级：参数 > 配置文件 > 环境变量）
    api_key = get_api_key(api_key)

    # 未指定模型时使用默认模型
    model = model or AGNES_IMAGE_MODEL

    # 构建请求 URL
    url = AGNES_API_BASE_URL + AGNES_IMAGE_ENDPOINT

    # 构建请求头
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    # 构建请求体
    # 注意：根据 Agnes Image 2.1 Flash 官方文档
    # - 文生图：model/prompt/size 在顶层，return_base64 在顶层
    # - 图生图：输入图像必须放在 extra_body.image 中（不是顶层 image！）
    # - response_format 必须放在 extra_body 中（不是顶层！）
    # - 图生图不需要传递 tags: ["img2img"]
    payload: Dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "size": size,
        "ratio": ratio,
    }

    # 初始化 extra_body（图生图的 image 和 response_format 都放在这里）
    extra_body: Dict[str, Any] = {}

    # 图生图：输入图像必须放在 extra_body.image 中
    if image_data_uris:
        extra_body["image"] = image_data_uris

    # Base64 返回模式（文生图用 return_base64，图生图用 extra_body.response_format）
    if return_base64:
        payload["return_base64"] = True

    # 附加参数（合并到 extra_body）
    if extra_params:
        extra_body.update(extra_params)

    # 只有 extra_body 有内容时才添加到 payload
    if extra_body:
        payload["extra_body"] = extra_body

    # 计算图生图请求体大小（用于诊断）
    if image_data_uris:
        total_img_size = sum(len(uri) for uri in image_data_uris)
        logger.info(
            "调用 Agnes 图像 API：model=%s, mode=%s, size=%s, ratio=%s, 输入图数量=%d, 图像数据总大小=%.2f KB",
            model,
            "图生图" if image_data_uris else "文生图",
            size,
            ratio,
            len(image_data_uris),
            total_img_size / 1024,
        )
    else:
        logger.info(
            "调用 Agnes 图像 API：model=%s, mode=文生图, size=%s, ratio=%s",
            model,
            size,
            ratio,
        )

    try:
        response = requests.post(url, json=payload, headers=headers, timeout=timeout)
        response.raise_for_status()
    except requests.exceptions.Timeout:
        raise RuntimeError(f"Agnes image API request timed out ({timeout}s)")
    except requests.exceptions.ConnectionError as e:
        raise RuntimeError(f"Cannot connect to Agnes API server: {e}")
    except requests.exceptions.HTTPError as e:
        # 提取错误详情
        error_msg = f"Agnes image API returned an error: {e}"
        try:
            error_detail = response.json()
            error_msg += f", details: {error_detail}"
        except Exception:
            if response.text:
                error_msg += f", response body: {response.text[:500]}"
        raise RuntimeError(error_msg)

    # 解析响应
    try:
        result = response.json()
    except ValueError as e:
        raise RuntimeError(f"Failed to parse Agnes image API response: {e}")

    # 提取结果
    data_list = result.get("data", [])
    if not data_list:
        raise RuntimeError(f"Agnes image API returned empty data: {result}")

    first_item = data_list[0]
    url_result = first_item.get("url")
    b64_result = first_item.get("b64_json")

    return url_result, b64_result


# ============================================================
# 视频 API 调用（Agnes Video 2.5 Flash）
# ============================================================

def create_video_task(
    api_key: Optional[str] = None,
    prompt: str = "",
    mode: str = "text",
    seconds: str = "5",
    aspect_ratio: str = "16:9",
    seed: Optional[int] = None,
    first_frame: Optional[str] = None,
    last_frame: Optional[str] = None,
    images: Optional[List[str]] = None,
    audios: Optional[List[str]] = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> Dict[str, Any]:
    """
    创建 Agnes Video 2.5 Flash 视频生成任务

    Args:
        api_key: Agnes API Key
        prompt: 视频内容的文本描述
        mode: 生成模式（text / keyframe / reference）
        seconds: 视频时长（字符串 "4"-"12"）
        aspect_ratio: 视频画幅（21:9/16:9/4:3/1:1/3:4/9:16）
        seed: 随机种子（None 表示不指定）
        first_frame: keyframe 模式首帧图片 URL / Data URI
        last_frame: keyframe 模式尾帧图片 URL / Data URI
        images: reference 模式参考图片列表（最多 5 张）
        audios: reference 模式参考音频列表（最多 3 段，公共可访问 URL）
        timeout: 请求超时时间（秒）

    Returns:
        任务创建响应字典，包含 video_id / id / task_id

    Raises:
        RuntimeError: API 调用失败
    """
    # 自动获取 API Key（优先级：参数 > 配置文件 > 环境变量）
    api_key = get_api_key(api_key)

    # 构建请求 URL
    url = AGNES_API_BASE_URL + AGNES_VIDEO_CREATE_ENDPOINT

    # 构建请求头
    # Connection: close 避免连接复用导致的 SSL EOF 问题
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Connection": "close",
    }

    # 构建请求体（2.5 Flash：size 固定 720P）
    payload: Dict[str, Any] = {
        "model": AGNES_VIDEO_MODEL,
        "prompt": prompt,
        "mode": mode,
        "seconds": str(seconds),
        "size": "720P",
        "aspect_ratio": aspect_ratio,
    }

    if seed is not None and seed > 0:
        payload["seed"] = int(seed)

    # 关键帧模式
    if first_frame:
        payload["first_frame"] = first_frame
    if last_frame:
        payload["last_frame"] = last_frame

    # 参考模式
    if images:
        payload["images"] = list(images)
    if audios:
        payload["audios"] = list(audios)

    logger.info(
        "创建 Agnes 视频任务：mode=%s, seconds=%s, aspect_ratio=%s, images=%d, audios=%d",
        mode, seconds, aspect_ratio,
        len(images or []), len(audios or []),
    )

    # 请求重试机制（针对 429 限流和网络异常）
    max_retries = 3
    retry_interval = 65  # 略大于 60 秒的限流窗口
    last_error: Optional[Exception] = None
    response = None

    for attempt in range(1, max_retries + 1):
        try:
            response = requests.post(url, json=payload, headers=headers, timeout=timeout)

            # 429 限流：等待后重试
            if response.status_code == 429:
                last_error = requests.exceptions.HTTPError(
                    f"429 Client Error: Too Many Requests for url: {url}",
                    response=response,
                )
                try:
                    err_detail = response.json()
                    err_msg = err_detail.get("error", {}).get("message", "")
                except Exception:
                    err_msg = response.text[:200] if response.text else ""

                if attempt < max_retries:
                    logger.warning(
                        "第 %d/%d 次创建视频任务被限流：%s，等待 %d 秒后重试...",
                        attempt, max_retries, err_msg, retry_interval,
                    )
                    time.sleep(retry_interval)
                    continue
                else:
                    logger.error(
                        "连续 %d 次创建视频任务均被限流，放弃重试", max_retries,
                    )
                    break

            # 其他状态（含 5xx / 4xx 校验错误）：跳出循环，
            # 由循环后的统一处理提取响应体中的错误详情
            break

        except requests.exceptions.Timeout:
            raise RuntimeError(f"Agnes video API request timed out ({timeout}s)")
        except requests.exceptions.ConnectionError as e:
            last_error = e
            if attempt < max_retries:
                logger.warning(
                    "第 %d/%d 次创建视频任务连接异常：%s，%d 秒后重试...",
                    attempt, max_retries, str(e)[:200], retry_interval,
                )
                time.sleep(retry_interval)
            else:
                raise RuntimeError(f"Cannot connect to Agnes API server (failed {max_retries} times in a row): {e}")
    else:
        # 循环正常结束但未 break（理论上不会到这里，429 已在循环内处理）
        if last_error:
            error_msg = f"Agnes video API returned an error: {last_error}"
            raise RuntimeError(error_msg)

    # 处理最终的 429 错误（重试次数用尽）
    if response is not None and response.status_code == 429:
        error_msg = "Agnes video API returned an error: 429 Too Many Requests (rate limited)"
        try:
            error_detail = response.json()
            error_msg += f", details: {error_detail}"
        except Exception:
            if response.text:
                error_msg += f", response body: {response.text[:500]}"
        error_msg += (
            f"\n\nRetried {max_retries} times (waiting {retry_interval}s each) but still rate limited."
            f"\nTip: the Agnes video API is rate limited, please wait at least 1 minute before retrying."
        )
        raise RuntimeError(error_msg)

    # 处理其他 HTTP 错误
    if response is not None:
        try:
            response.raise_for_status()
        except requests.exceptions.HTTPError as e:
            error_msg = f"Agnes video API returned an error: {e}"
            try:
                error_detail = response.json()
                error_msg += f", details: {error_detail}"
            except Exception:
                if response.text:
                    error_msg += f", response body: {response.text[:500]}"
            raise RuntimeError(error_msg)

    try:
        result = response.json()
    except ValueError as e:
        raise RuntimeError(f"Failed to parse Agnes video API response: {e}")

    return result


def get_video_result(
    api_key: str,
    video_id: str,
    timeout: int = DEFAULT_TIMEOUT,
) -> Dict[str, Any]:
    """
    查询 Agnes Video 2.5 Flash 视频任务结果

    Args:
        api_key: Agnes API Key
        video_id: 视频 ID（创建任务时返回）
        timeout: 请求超时时间（秒）

    Returns:
        任务结果字典，包含 status、progress、url 等字段

    Raises:
        RuntimeError: API 调用失败
    """
    # 构建请求 URL（2.5 推荐方式：video_id + model_name，适用于全部模式）
    url = AGNES_API_BASE_URL + AGNES_VIDEO_RESULT_ENDPOINT
    params = {"video_id": video_id, "model_name": AGNES_VIDEO_MODEL}

    # 构建请求头
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Connection": "close",
    }

    # 重试机制（应对 SSL EOF / 连接重置等网络波动）
    max_retries = 3
    retry_interval = 2
    last_error: Optional[Exception] = None
    response = None

    for attempt in range(1, max_retries + 1):
        try:
            response = requests.get(url, params=params, headers=headers, timeout=timeout)
            response.raise_for_status()
            break
        except (requests.exceptions.ConnectionError,
                requests.exceptions.Timeout) as e:
            # SSL EOF / 连接重置 / 超时：可重试
            last_error = e
            logger.warning(
                "第 %d/%d 次查询视频结果连接异常：%s，%d 秒后重试...",
                attempt, max_retries, str(e)[:200], retry_interval,
            )
            if attempt < max_retries:
                time.sleep(retry_interval)
        except requests.exceptions.HTTPError as e:
            error_msg = f"Agnes video API query failed: {e}"
            try:
                error_detail = response.json()
                error_msg += f", details: {error_detail}"
            except Exception:
                if response.text:
                    error_msg += f", response body: {response.text[:500]}"
            raise RuntimeError(error_msg)
    else:
        raise RuntimeError(
            f"Failed to query the video result {max_retries} times in a row: {last_error}\n"
            "Possible causes: Agnes server SSL fluctuation or unstable network"
        )

    try:
        return response.json()
    except ValueError as e:
        raise RuntimeError(f"Failed to parse Agnes video API response: {e}")


def poll_video_result(
    api_key: Optional[str] = None,
    video_id: str = "",
    poll_interval: int = DEFAULT_POLL_INTERVAL,
    max_poll_time: int = DEFAULT_MAX_POLL_TIME,
    timeout: int = DEFAULT_TIMEOUT,
    progress_callback=None,
) -> str:
    """
    轮询 Agnes Video 2.5 Flash 视频任务直到完成

    Args:
        api_key: Agnes API Key
        video_id: 视频 ID
        poll_interval: 轮询间隔（秒）
        max_poll_time: 最大轮询时间（秒）
        timeout: 单次请求超时时间（秒）
        progress_callback: 进度回调函数，签名为 callback(progress: int, status: str)

    Returns:
        生成的视频 URL

    Raises:
        RuntimeError: 任务失败或超时
    """
    # 自动获取 API Key（优先级：参数 > 配置文件 > 环境变量）
    api_key = get_api_key(api_key)

    start_time = time.time()
    last_progress = -1

    while True:
        # 检查是否超时
        elapsed = time.time() - start_time
        if elapsed > max_poll_time:
            raise RuntimeError(
                f"视频任务轮询超时（{max_poll_time}秒），video_id={video_id}"
            )

        # 查询任务结果
        # 注意：即使单次查询失败（SSL 波动等），也不终止整个轮询
        try:
            result = get_video_result(api_key, video_id, timeout=timeout)
        except RuntimeError as e:
            logger.warning(
                "视频结果查询失败（已等待 %.1f 秒）：%s，%d 秒后重试...",
                elapsed, str(e)[:200], poll_interval,
            )
            time.sleep(poll_interval)
            continue

        status = result.get("status", "unknown")
        progress = result.get("progress", 0)

        # 进度回调
        if progress_callback and progress != last_progress:
            try:
                progress_callback(progress, status)
            except Exception as callback_err:
                logger.warning("进度回调异常：%s", callback_err)
            last_progress = progress

        # 检查任务状态
        if status == "completed":
            # 任务完成，提取视频 URL（顶层 url 字段）
            video_url = result.get("url")
            if not video_url:
                metadata = result.get("metadata", {})
                video_url = metadata.get("url")
            if not video_url:
                raise RuntimeError(f"Task finished but no video URL returned: {result}")
            logger.info("视频任务完成：%s", video_url)
            return video_url

        elif status == "failed":
            error_info = result.get("error", {})
            error_msg = error_info.get("message") if isinstance(error_info, dict) else str(error_info)
            raise RuntimeError(f"Video task failed: {error_msg or result}")

        elif status in ("queued", "in_progress", "pending", "processing"):
            logger.debug(
                "视频任务进行中：status=%s, progress=%s%%, 已等待%.1f秒",
                status, progress, elapsed,
            )
            time.sleep(poll_interval)

        else:
            logger.warning("未知的视频任务状态：%s", status)
            time.sleep(poll_interval)


# ============================================================
# 文件下载
# ============================================================

def download_url_to_bytes(url: str, timeout: int = 180) -> bytes:
    """
    下载 URL 内容到字节数据

    带重试机制，应对 SSL EOF / 连接重置等网络波动。
    适用于下载视频文件、图像文件等大体积资源。

    Args:
        url: 要下载的 URL
        timeout: 下载超时时间（秒）

    Returns:
        下载的字节数据

    Raises:
        RuntimeError: 下载失败
    """
    # 重试机制（应对 SSL EOF / 连接重置等网络波动）
    max_retries = 5
    retry_interval = 3
    last_error: Optional[Exception] = None

    headers = {"Connection": "close"}

    for attempt in range(1, max_retries + 1):
        try:
            response = requests.get(url, headers=headers, timeout=timeout)
            response.raise_for_status()
            return response.content
        except (requests.exceptions.ConnectionError,
                requests.exceptions.Timeout) as e:
            # SSL EOF / 连接重置 / 超时：可重试
            last_error = e
            logger.warning(
                "第 %d/%d 次下载连接异常：%s，%d 秒后重试...",
                attempt, max_retries, str(e)[:200], retry_interval,
            )
            if attempt < max_retries:
                time.sleep(retry_interval)
        except requests.exceptions.HTTPError as e:
            # HTTP 业务错误（如 404/403）：不重试
            raise RuntimeError(f"Download failed (HTTP {response.status_code}): {url}, error: {e}")
    else:
        raise RuntimeError(
            f"连续 {max_retries} 次下载失败：{url}，最后错误：{last_error}\n"
            "可能原因：服务器 SSL 波动或网络不稳定"
        )


def download_url_to_bytesio(url: str, timeout: int = 180) -> BytesIO:
    """
    下载 URL 内容到 BytesIO 对象

    Args:
        url: 要下载的 URL
        timeout: 下载超时时间（秒）

    Returns:
        包含下载数据的 BytesIO 对象（指针已重置到开头）

    Raises:
        RuntimeError: 下载失败
    """
    data = download_url_to_bytes(url, timeout=timeout)
    buffer = BytesIO(data)
    buffer.seek(0)
    return buffer


# ============================================================
# 图像编码辅助
# ============================================================

def image_tensor_to_data_uri(image_tensor) -> str:
    """
    将 ComfyUI IMAGE 张量转换为 Data URI（Base64 编码的 PNG）

    根据官方文档，Agnes Image API 的图生图输入图像示例使用 PNG 格式，
    文档没有要求压缩，因此这里不做压缩，保留原始画质以保证生成质量。

    ComfyUI IMAGE 格式：[B, H, W, C]，float32，值范围 [0, 1]

    Args:
        image_tensor: ComfyUI 图像张量

    Returns:
        Data URI 字符串，格式为 "data:image/png;base64,..."
    """
    import numpy as np
    from PIL import Image

    # 处理批次：只取第一张图
    if len(image_tensor.shape) == 4:
        img = image_tensor[0]
    else:
        img = image_tensor

    # 转换为 uint8 numpy 数组
    img_np = (img.cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)

    # 统一转 RGB 3 通道（丢弃 alpha 通道）
    if img_np.shape[-1] == 4:
        pil_image = Image.fromarray(img_np, mode="RGBA").convert("RGB")
    else:
        pil_image = Image.fromarray(img_np[..., :3], mode="RGB")

    # 转换为 PNG 格式的 Base64 编码（不压缩，保留原始画质）
    buffer = BytesIO()
    pil_image.save(buffer, format="PNG")
    buffer.seek(0)

    b64_data = base64.b64encode(buffer.getvalue()).decode("utf-8")
    data_uri = f"data:image/png;base64,{b64_data}"

    logger.info(
        "图像编码完成：PNG 大小 %.2f KB，Data URI 总长 %d 字符",
        len(buffer.getvalue()) / 1024,
        len(data_uri),
    )

    return data_uri


def audio_batch_to_data_uris(
    audio,
    limit: int = 3,
    max_seconds: float = 30.0,
) -> List[str]:
    """
    将 ComfyUI AUDIO 输入转换为 WAV Data URI 列表（参考音频上传）

    ComfyUI AUDIO 格式：{"waveform": [B, C, T] float32, "sample_rate": int}
    批次中的每一段音频会转换为一个 Data URI（最多 limit 段）。
    过长的音频会截断到 max_seconds，并下混为单声道 / 16kHz，
    避免请求体过大。

    Args:
        audio: ComfyUI AUDIO 字典
        limit: 最多转换的音频段数（官方上限 3 段）
        max_seconds: 单段音频最长保留秒数

    Returns:
        Data URI 字符串列表，格式为 "data:audio/wav;base64,..."
    """
    if not isinstance(audio, dict):
        raise RuntimeError("Invalid AUDIO input")

    waveform = audio.get("waveform")
    sample_rate = int(audio.get("sample_rate") or 0)
    if waveform is None or sample_rate <= 0:
        raise RuntimeError("AUDIO input is missing waveform or sample_rate")

    import numpy as np
    import wave

    if waveform.dim() == 2:
        waveform = waveform.unsqueeze(0)
    elif waveform.dim() != 3:
        raise RuntimeError(f"Unsupported audio waveform shape: {tuple(waveform.shape)}")

    total = int(waveform.shape[0])
    count = min(total, limit)
    if total > limit:
        logger.warning("参考音频批次包含 %d 段，仅发送前 %d 段（官方上限）", total, limit)

    max_samples = max(1, int(sample_rate * max_seconds))
    uris: List[str] = []
    target_rate = 16000
    for i in range(count):
        data = waveform[i].detach().cpu().float().numpy()
        if data.ndim == 1:
            data = data[None, :]

        # 参考音频只需传达节奏/音色：下混为单声道并降到 16kHz，
        # 显著减小内联 Data URI 的体积
        if data.shape[0] > 1:
            data = data.mean(axis=0, keepdims=True)
        if sample_rate > target_rate and data.shape[-1] > 1:
            old_len = data.shape[-1]
            new_len = max(1, int(round(old_len * target_rate / float(sample_rate))))
            x_old = np.arange(old_len, dtype=np.float64)
            x_new = np.linspace(0, old_len - 1, new_len, dtype=np.float64)
            data = np.stack([np.interp(x_new, x_old, ch) for ch in data])
            sample_rate = target_rate
            max_samples = max(1, int(sample_rate * max_seconds))

        if data.shape[-1] > max_samples:
            data = data[:, :max_samples]
            logger.warning("参考音频超过 %.0f 秒，已截断", max_seconds)

        # [C, T] → [T, C]，转换为 16-bit PCM
        pcm = np.clip(data.T, -1.0, 1.0)
        pcm = (pcm * 32767.0).astype(np.int16)

        buffer = BytesIO()
        with wave.open(buffer, "wb") as wav:
            wav.setnchannels(int(pcm.shape[1]))
            wav.setsampwidth(2)
            wav.setframerate(sample_rate)
            wav.writeframes(pcm.tobytes())

        raw = buffer.getvalue()
        b64 = base64.b64encode(raw).decode("utf-8")
        uris.append(f"data:audio/wav;base64,{b64}")
        logger.info(
            "参考音频编码完成：%.2f 秒，WAV 大小 %.2f KB",
            data.shape[-1] / float(sample_rate),
            len(raw) / 1024,
        )

    return uris


def bytesio_to_image_tensor(buffer: BytesIO):
    """
    将 BytesIO（包含图像数据）转换为 ComfyUI IMAGE 张量

    始终转换为 RGB 3 通道格式，确保与 ComfyUI 所有节点（包括
    PreviewImage）完全兼容。

    Args:
        buffer: 包含图像数据的 BytesIO 对象

    Returns:
        ComfyUI IMAGE 张量，格式为 [B, H, W, 3]，float32，值范围 [0, 1]
    """
    import numpy as np
    import torch
    from PIL import Image

    buffer.seek(0)
    pil_image = Image.open(buffer)

    # 始终转换为 RGB 3 通道，丢弃 alpha 通道
    # ComfyUI 标准 IMAGE 格式为 [B, H, W, 3]，4 通道可能导致
    # PreviewImage 等节点的前端显示异常
    if pil_image.mode != "RGB":
        pil_image = pil_image.convert("RGB")

    img_np = np.array(pil_image).astype(np.float32) / 255.0

    # 添加批次维度 [B, H, W, C]，并确保内存连续
    tensor = torch.from_numpy(img_np).unsqueeze(0).contiguous()
    return tensor
