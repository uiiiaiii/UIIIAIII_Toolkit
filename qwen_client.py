"""
Qwen-Image-Edit-2511 API 客户端封装模块（ModelScope API-Inference 版本）

通过 ModelScope 平台的 API-Inference 接口调用 Qwen-Image-Edit-2511 模型。

API 特点：
- Base URL: https://api-inference.modelscope.cn/
- 认证: ModelScope Access Token
- 模型名称: Qwen/Qwen-Image-Edit-2511（带斜杠）
- 调用方式: 异步任务模式（POST 创建任务 → GET 轮询结果）
- 图片编辑: 通过 image_url 字段传入输入图（支持 URL 或 base64 编码）

文档参考：
- https://www.modelscope.cn/docs/model-service/API-Inference/intro
- https://www.modelscope.cn/models/Qwen/Qwen-Image-Edit-2511
"""

import json
import base64
import logging
import time
from io import BytesIO
from typing import Optional, Dict, Any, List, Union

import requests

# 设置日志记录器
logger = logging.getLogger("ComfyUI-Qwen")

# ============================================================
# 常量定义
# ============================================================

# ModelScope API-Inference 基础地址
MODELSCOPE_API_BASE_URL = "https://api-inference.modelscope.cn/"

# 模型名称（带斜杠，ModelScope 标识）
QWEN_MODEL = "Qwen/Qwen-Image-Edit-2511"

# Qwen-Image-2.1：文生图 + 图像编辑统一模型
QWEN_21_MODEL = "Qwen/Qwen-Image-2.1"

# 创建图像生成任务的端点
IMAGES_GENERATIONS_ENDPOINT = "v1/images/generations"

# 任务查询端点（拼接 task_id）
TASKS_ENDPOINT = "v1/tasks/"

# 默认请求超时时间（秒）
DEFAULT_TIMEOUT = 180

# 任务轮询间隔（秒）
POLL_INTERVAL = 5

# 任务最大轮询时间（秒，10 分钟）
MAX_POLL_TIME = 600

# Qwen-Image-2.1 的任务最大轮询时间（秒，30 分钟）
# 原生 2K 分辨率下单次生成可能耗时 8 分钟以上，多参考图编辑更久，
# 实测 600 秒上限会导致任务尚未完成即超时失败，因此单独放宽。
MAX_POLL_TIME_21 = 1800

# 最大重试次数（仅针对网络异常，不针对业务错误）
MAX_RETRIES = 3

# 重试间隔（秒）
RETRY_INTERVAL = 2

# 支持的宽高比及对应推荐分辨率（宽x高）
# 注意：ModelScope API 的 size 格式为 "1024x1024"（小写 x 分隔）
# 根据 ModelScope API-Inference 官方文档参数说明：
#   - SD 系列: [64x64, 2048x2048]
#   - FLUX: [64x64, 1024x1024]
#   - Qwen-Image: [64x64, 1664x1664]  ← 本模型所属系列，最大边 1664
#   - Z-Image-Turbo: [512x512, 2048x2048]
# 因此 Qwen-Image-Edit-2511 的最大边限制为 1664 像素，不能设置为 2000 或 2048
# 所有尺寸均对齐到 8 的倍数（Qwen-Image 系列要求）
_RATIO_TO_RESOLUTION = {
    "1:1": "1664x1664",     # 正方形
    "2:3": "1104x1664",     # 竖图（2:3 ≈ 0.667）
    "3:2": "1664x1104",     # 横图（3:2 = 1.5）
    "3:4": "1248x1664",     # 竖图（3:4 = 0.75）
    "4:3": "1664x1248",     # 横图（4:3 ≈ 1.333）
    "9:16": "936x1664",     # 竖屏（9:16 = 0.5625）
    "16:9": "1664x936",     # 宽屏横图（16:9 ≈ 1.778）
    "21:9": "1664x712",     # 超宽横图（21:9 ≈ 2.333）
}

# 支持的宽高比选项
IMAGE_RATIO_OPTIONS = list(_RATIO_TO_RESOLUTION.keys())

# Qwen-Image-2.1 的推荐分辨率（原生 2K 模型）
# 注意：ModelScope API-Inference 限制宽高必须在 [64, 2048] 内，
# 因此官方推荐的 2752x1536 等超宽 2K 尺寸无法使用，这里按最大边 2048 对齐到 8 的倍数。
_RATIO_TO_RESOLUTION_21 = {
    "1:1": "2048x2048",     # 正方形（原生 2K）
    "2:3": "1368x2048",     # 竖图（2:3 ≈ 0.667）
    "3:2": "2048x1368",     # 横图（3:2 = 1.5）
    "3:4": "1536x2048",     # 竖图（3:4 = 0.75）
    "4:3": "2048x1536",     # 横图（4:3 ≈ 1.333）
    "9:16": "1152x2048",    # 竖屏（9:16 = 0.5625）
    "16:9": "2048x1152",    # 宽屏横图（16:9 ≈ 1.778）
    "21:9": "2048x880",     # 超宽横图（21:9 ≈ 2.333）
}

# Qwen-Image-2.1 支持的宽高比选项
IMAGE_RATIO_OPTIONS_21 = list(_RATIO_TO_RESOLUTION_21.keys())

# Qwen-Image-2.1 的 1K 档位尺寸（最大边 1024，对齐到 8 的倍数）
# 实测：2K + 4 张参考图会因平台算力限制导致生成失败（等待 20 分钟后报 generate task failed），
# 1K 档位则快速稳定（实测 4 图约 19 秒完成），多图编辑建议使用该档位。
_RATIO_TO_RESOLUTION_21_1K = {
    "1:1": "1024x1024",
    "2:3": "680x1024",
    "3:2": "1024x680",
    "3:4": "768x1024",
    "4:3": "1024x768",
    "9:16": "576x1024",
    "16:9": "1024x576",
    "21:9": "1024x440",
}

# Qwen-Image-2.1 的输出尺寸档位
IMAGE_RESOLUTION_OPTIONS_21 = ["1K", "2K"]

# Qwen-Image-2.1 在 ModelScope API-Inference 上单次请求的参考图数量上限
# （模型本身支持 10 张，但该平台实测限制为 4 张）
QWEN_21_MAX_REFERENCE_IMAGES = 4

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


# ============================================================
# API Key 管理
# ============================================================

def get_api_key(api_key: Optional[str] = None) -> str:
    """
    获取 ModelScope API Token

    优先级（从高到低）：
    1. 节点参数传入的 api_key
    2. 配置文件 config.json 中的 modelscope_api_key（通过 ComfyUI 设置页面配置）
    3. 环境变量 MODELSCOPE_API_TOKEN / MODELSCOPE_ACCESS_TOKEN

    Args:
        api_key: 节点参数传入的 API Key

    Returns:
        API Token 字符串

    Raises:
        ValueError: 未找到有效的 API Token
    """
    # 委托给 config 模块统一处理（优先级：节点参数 > 配置文件 > 环境变量）
    from . import config as _config
    return _config.get_modelscope_api_key(api_key)


# ============================================================
# 辅助函数
# ============================================================

def detect_image_ratio(image_tensor) -> str:
    """
    从 ComfyUI IMAGE 张量自动检测最接近的支持宽高比

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


def ratio_to_size(ratio: str) -> str:
    """
    将宽高比转换为 API 接受的 size 格式（宽x高）

    注意：ModelScope API 的 size 格式为 "1024x1024"（小写 x 分隔）

    Args:
        ratio: 宽高比字符串，如 "16:9"

    Returns:
        size 字符串，如 "1365x768"
    """
    return _RATIO_TO_RESOLUTION.get(ratio, "1024x1024")


def ratio_to_size_21(ratio: str, resolution: str = "1K") -> str:
    """
    Qwen-Image-2.1 专用：将宽高比转换为 size

    Args:
        ratio: 宽高比字符串，如 "16:9"
        resolution: 输出尺寸档位，"1K"（最大边 1024）或 "2K"（最大边 2048，原生质量）

    Returns:
        size 字符串，如 "1024x576"
    """
    if resolution == "2K":
        return _RATIO_TO_RESOLUTION_21.get(ratio, "2048x2048")
    return _RATIO_TO_RESOLUTION_21_1K.get(ratio, "1024x1024")


# ============================================================
# 图像编码辅助
# ============================================================

def image_tensor_to_data_uri(image_tensor) -> str:
    """
    将 ComfyUI IMAGE 张量转换为 Data URI（Base64 编码的 PNG，无压缩）

    按照项目约定"文档无明确压缩要求时不压缩"：
    - 使用 PNG 无损格式上传，保留原始画质
    - 不进行尺寸缩放，原图直传
    - 仅统一转 RGB 3 通道（丢弃 alpha 通道，保证 ComfyUI 兼容性）

    ModelScope API-Inference 文档未要求压缩输入图像，
    之前的 JPEG 压缩和 1536px 限制是为应对网络波动而添加的，
    现已通过重试机制和 Connection: close 头解决网络问题，
    因此恢复为无压缩上传。

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

    # 统一转 RGB 3 通道（丢弃 alpha 通道，保证 ComfyUI 兼容性）
    if img_np.shape[-1] == 4:
        pil_image = Image.fromarray(img_np, mode="RGBA").convert("RGB")
    else:
        pil_image = Image.fromarray(img_np[..., :3], mode="RGB")

    # 不压缩：使用 PNG 无损格式，保留原始画质和尺寸
    buffer = BytesIO()
    pil_image.save(buffer, format="PNG")
    buffer.seek(0)

    b64_data = base64.b64encode(buffer.getvalue()).decode("utf-8")
    data_uri = f"data:image/png;base64,{b64_data}"

    logger.info(
        "图像编码完成（PNG 无压缩）：尺寸 %dx%d，大小 %.2f KB，Data URI 总长 %d 字符",
        pil_image.size[0], pil_image.size[1],
        len(buffer.getvalue()) / 1024,
        len(data_uri),
    )

    return data_uri


def bytesio_to_image_tensor(image_buffer):
    """
    将 BytesIO 中的图像数据转换为 ComfyUI IMAGE 张量

    输出格式：[B, H, W, 3]，float32，值范围 [0, 1]

    Args:
        image_buffer: 包含图像数据的 BytesIO 对象

    Returns:
        ComfyUI 格式的图像张量
    """
    import torch
    import numpy as np
    from PIL import Image

    image_buffer.seek(0)
    pil_image = Image.open(image_buffer)

    # 统一转换为 RGB 3 通道（丢弃 alpha 通道，保证 ComfyUI 兼容性）
    pil_image = pil_image.convert("RGB")

    # 转换为 numpy 数组并归一化
    img_np = np.array(pil_image).astype(np.float32) / 255.0

    # 转换为 torch 张量，添加 batch 维度
    img_tensor = torch.from_numpy(img_np).unsqueeze(0)

    # 确保内存连续
    img_tensor = img_tensor.contiguous()

    return img_tensor


def download_url_to_bytesio(url: str, timeout: int = 180) -> BytesIO:
    """
    下载 URL 内容到 BytesIO 对象

    Args:
        url: 要下载的 URL
        timeout: 下载超时时间（秒）

    Returns:
        包含下载数据的 BytesIO 对象（指针已重置到开头）
    """
    try:
        response = requests.get(url, timeout=timeout)
        response.raise_for_status()
    except requests.exceptions.Timeout:
        raise RuntimeError(f"Download timed out ({timeout}s): {url}")
    except requests.exceptions.RequestException as e:
        raise RuntimeError(f"Download failed: {url}, error: {e}")

    buffer = BytesIO(response.content)
    buffer.seek(0)
    return buffer


# ============================================================
# ModelScope API 调用（异步任务模式）
# ============================================================

def _create_image_task(
    api_key: str,
    prompt: str,
    model: str,
    image_data_uris: Optional[Union[str, List[str]]] = None,
    size: Optional[str] = None,
    seed: Optional[int] = None,
    negative_prompt: Optional[str] = None,
    timeout: int = DEFAULT_TIMEOUT,
) -> str:
    """
    创建图像生成/编辑任务

    Args:
        api_key: ModelScope API Token
        prompt: 提示词
        model: 模型名称
        image_data_uris: 输入图像的 Data URI（用于图生图模式）
                        支持单张（字符串）或多张（列表，多图像编辑）
        size: 输出分辨率，格式 "宽x高"
        seed: 随机种子
        negative_prompt: 负向提示词
        timeout: 请求超时时间（秒）

    Returns:
        任务 ID（task_id）

    Raises:
        RuntimeError: 创建任务失败
    """
    url = MODELSCOPE_API_BASE_URL + IMAGES_GENERATIONS_ENDPOINT

    # 构建请求头
    # X-ModelScope-Async-Mode: true 表示使用异步任务模式
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-ModelScope-Async-Mode": "true",
        "Connection": "close",
    }

    # 构建请求体
    payload: Dict[str, Any] = {
        "model": model,
        "prompt": prompt,
    }

    # 添加可选参数
    # 注意：根据 ModelScope 官方文档，image_url 字段支持列表格式以进行多图像编辑：
    #   "image_url": [data_uri_1, data_uri_2, ...]
    # 单张图像时，也可传列表（仅一个元素），API 兼容
    if image_data_uris:
        if isinstance(image_data_uris, str):
            # 单张图像：转为单元素列表
            payload["image_url"] = [image_data_uris]
        elif isinstance(image_data_uris, list):
            # 多张图像：直接传列表
            payload["image_url"] = image_data_uris
    if size:
        payload["size"] = size
    if seed is not None and seed >= 0:
        payload["seed"] = seed
    if negative_prompt:
        payload["negative_prompt"] = negative_prompt

    # 显式序列化 JSON，便于诊断请求体大小
    json_str = json.dumps(payload, ensure_ascii=False)
    # 统计输入图像数量（用于日志显示）
    img_count = 0
    if image_data_uris:
        img_count = 1 if isinstance(image_data_uris, str) else len(image_data_uris)
    logger.info(
        "创建 ModelScope 图像任务：model=%s, mode=%s, 输入图数量=%d, size=%s, seed=%s, 请求体大小 %.2f KB",
        model, "图生图" if image_data_uris else "文生图",
        img_count, size, seed, len(json_str) / 1024,
    )

    # 发送请求（带重试机制，仅针对网络异常）
    last_error: Optional[Exception] = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            logger.info("第 %d/%d 次尝试创建任务...", attempt, MAX_RETRIES)
            response = requests.post(
                url,
                data=json_str.encode("utf-8"),
                headers=headers,
                timeout=timeout,
            )
            break
        except (requests.exceptions.ConnectionError,
                ConnectionResetError) as e:
            last_error = e
            logger.warning(
                "第 %d 次创建任务连接异常：%s，%d 秒后重试...",
                attempt, str(e)[:200], RETRY_INTERVAL,
            )
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_INTERVAL)
        except requests.exceptions.Timeout:
            raise RuntimeError(f"Create task request timed out ({timeout}s)")
        except requests.exceptions.RequestException as e:
            raise RuntimeError(f"Create task request failed: {e}")
    else:
        raise RuntimeError(
            f"Failed to create the task {MAX_RETRIES} times in a row: {last_error}\n"
            "Possible causes: invalid API Token, network issues, or ModelScope service fluctuation"
        )

    # 解析响应
    if response.status_code != 200:
        try:
            err_data = response.json()
            err_code = err_data.get("code", "unknown")
            err_msg = err_data.get("message", response.text)
        except Exception:
            err_code = f"HTTP_{response.status_code}"
            err_msg = response.text

        raise RuntimeError(
            f"Create task failed: {err_code} - {err_msg}"
        )

    try:
        data = response.json()
    except ValueError as e:
        raise RuntimeError(f"Failed to parse the create task response: {e}")

    # 提取 task_id
    task_id = data.get("task_id")
    if not task_id:
        raise RuntimeError(f"No task_id found in the create task response, raw data: {data}")

    logger.info("任务创建成功，task_id=%s", task_id)
    return task_id


def _poll_task_result(
    api_key: str,
    task_id: str,
    timeout: int = DEFAULT_TIMEOUT,
    poll_interval: int = POLL_INTERVAL,
    max_poll_time: int = MAX_POLL_TIME,
    progress_callback=None,
) -> str:
    """
    轮询任务结果，直到完成或超时

    Args:
        api_key: ModelScope API Token
        task_id: 任务 ID
        timeout: 单次请求超时时间（秒）
        poll_interval: 轮询间隔（秒）
        max_poll_time: 最大轮询总时间（秒）
        progress_callback: 进度回调函数，接收 (elapsed, status) 参数

    Returns:
        生成图像的 URL

    Raises:
        RuntimeError: 任务失败或超时
    """
    url = MODELSCOPE_API_BASE_URL + TASKS_ENDPOINT + task_id

    # 构建请求头
    # X-ModelScope-Task-Type: image_generation 表示图像生成任务类型
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-ModelScope-Task-Type": "image_generation",
        "Connection": "close",
    }

    start_time = time.time()
    attempt = 0

    while True:
        attempt += 1
        elapsed = time.time() - start_time

        # 检查是否超时
        if elapsed > max_poll_time:
            raise RuntimeError(
                f"Task polling timed out ({max_poll_time}s), task_id={task_id}"
            )

        # 调用进度回调
        if progress_callback:
            try:
                progress_callback(elapsed, max_poll_time, attempt)
            except Exception:
                pass

        # 发送轮询请求
        try:
            response = requests.get(url, headers=headers, timeout=timeout)
        except (requests.exceptions.ConnectionError,
                ConnectionResetError) as e:
            logger.warning(
                "第 %d 次轮询连接异常：%s，%d 秒后重试...",
                attempt, str(e)[:200], poll_interval,
            )
            time.sleep(poll_interval)
            continue
        except requests.exceptions.Timeout:
            logger.warning("第 %d 次轮询超时，重试...", attempt)
            time.sleep(poll_interval)
            continue
        except requests.exceptions.RequestException as e:
            raise RuntimeError(f"Polling task failed: {e}")

        # 解析响应
        if response.status_code != 200:
            try:
                err_data = response.json()
                err_msg = err_data.get("message", response.text)
            except Exception:
                err_msg = response.text
            raise RuntimeError(
                f"Polling task failed: HTTP_{response.status_code} - {err_msg}"
            )

        try:
            data = response.json()
        except ValueError as e:
            raise RuntimeError(f"Failed to parse the poll response: {e}")

        task_status = data.get("task_status", "UNKNOWN")
        logger.info(
            "轮询第 %d 次（已等待 %.1fs）：task_status=%s",
            attempt, elapsed, task_status,
        )

        # 检查任务状态
        if task_status == "SUCCEED":
            # 任务成功，提取图像 URL
            output_images = data.get("output_images", [])
            if not output_images:
                raise RuntimeError(f"Task succeeded but no image returned, raw data: {data}")

            image_url = output_images[0]
            logger.info("任务成功完成，返回图像 URL：%s", image_url[:100])
            return image_url

        elif task_status == "FAILED":
            # 任务失败
            err_msg = data.get("errors", "未知错误")
            raise RuntimeError(f"Image generation task failed: {err_msg}")

        else:
            # 任务仍在进行中（PENDING / RUNNING），等待后继续轮询
            time.sleep(poll_interval)


def edit_image(
    api_key: Optional[str] = None,
    prompt: str = "",
    image_data_uris: Union[str, List[str]] = (),
    size: Optional[str] = None,
    seed: Optional[int] = None,
    negative_prompt: Optional[str] = None,
    timeout: int = DEFAULT_TIMEOUT,
    progress_callback=None,
    model: str = QWEN_MODEL,
    max_poll_time: int = MAX_POLL_TIME,
) -> str:
    """
    调用 ModelScope API-Inference 生成/编辑图像

    默认使用 Qwen-Image-Edit-2511 模型对输入图像按指令进行编辑；
    传入 model=QWEN_21_MODEL 时使用 Qwen-Image-2.1（文生图 + 图像编辑统一模型，
    image_data_uris 为空即文生图）。
    支持单图像编辑（传入单个 Data URI 字符串）或多图像编辑（传入 Data URI 列表）。
    采用异步任务模式：先创建任务，再轮询结果。

    Args:
        api_key: ModelScope API Token
        prompt: 编辑指令或生成提示词
        image_data_uris: 输入图像的 Data URI（Base64 编码）
                       单张：字符串；多张：字符串列表；为空：文生图
        size: 输出分辨率，格式 "宽x高"，如 "1024x1024"。None 表示使用默认
        seed: 随机种子（0-2147483647），None 表示随机
        negative_prompt: 负向提示词
        timeout: 单次请求超时时间（秒）
        progress_callback: 进度回调函数，接收 (elapsed, max_poll_time, attempt) 参数
        model: 模型名称（ModelScope 标识）
        max_poll_time: 任务最大轮询时间（秒），超时抛错

    Returns:
        生成图像的 URL

    Raises:
        RuntimeError: API 调用失败
    """
    # 自动获取 API Key（优先级：参数 > 配置文件 > 环境变量）
    api_key = get_api_key(api_key)

    # 步骤 1：创建任务
    task_id = _create_image_task(
        api_key=api_key,
        prompt=prompt,
        model=model,
        image_data_uris=image_data_uris,
        size=size,
        seed=seed,
        negative_prompt=negative_prompt,
        timeout=timeout,
    )

    # 步骤 2：轮询任务结果
    image_url = _poll_task_result(
        api_key=api_key,
        task_id=task_id,
        timeout=timeout,
        max_poll_time=max_poll_time,
        progress_callback=progress_callback,
    )

    return image_url
