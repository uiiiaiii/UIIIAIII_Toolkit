"""
Agnes AI ComfyUI 节点定义模块

Agnes 图像节点：
- AgnesImage：文生图 + 图生图 / 多图合成（同一节点，model 可切换 agnes-image-2.5-flash / 2.1-flash）

Agnes 视频节点：
- AgnesVideo：文生视频 / 首尾帧控制 / 参考图片与音频（agnes-video-2.5-flash，自动判断模式）

所有节点使用传统的 INPUT_TYPES 风格，保证最大兼容性。
"""

import os
import time
import logging
from io import BytesIO
from typing import Optional, List, Tuple

# 导入 ComfyUI 内置工具
import folder_paths
import comfy.utils

# 导入 Agnes API 客户端
from . import agnes_client
# 导入 Qwen API 客户端
from . import qwen_client

# 设置日志
logger = logging.getLogger("UIIIAIII Toolkit")

# 图像处理（用于背景填充等本地节点）
import torch
import torch.nn.functional as F

# 尝试导入视频输出工具（ComfyUI 0.29+ 提供）
try:
    from comfy_api.latest import InputImpl
    _HAS_VIDEO_SUPPORT = True
except ImportError:
    _HAS_VIDEO_SUPPORT = False
    InputImpl = None
    logger.warning("无法导入 comfy_api.latest.InputImpl，视频节点将退化为输出文件路径")

# 尝试导入 PromptServer（用于发送进度文本）
try:
    from server import PromptServer
    _HAS_PROMPT_SERVER = True
except ImportError:
    _HAS_PROMPT_SERVER = False
    PromptServer = None


# ============================================================
# 进度显示辅助
# ============================================================

def _update_progress(
    node_id: Optional[str],
    value: int,
    total: int,
    text: Optional[str] = None,
    pbar=None,
):
    """
    更新 ComfyUI 的进度显示

    Args:
        node_id: 节点 ID
        value: 当前进度值
        total: 总进度值
        text: 可选的进度文本
        pbar: 可选的 ProgressBar 实例（如果传入则使用它，否则创建新的）

    Returns:
        ProgressBar 实例（方便后续更新）
    """
    if not node_id:
        return pbar

    # 创建或复用 ProgressBar
    if pbar is None:
        try:
            pbar = comfy.utils.ProgressBar(total, node_id=node_id)
        except Exception as e:
            logger.debug("创建 ProgressBar 失败：%s", e)
            return pbar

    # 更新进度条
    try:
        pbar.update_absolute(min(value, total), total)
    except Exception as e:
        logger.debug("更新进度条失败：%s", e)

    # 发送进度文本
    if text and _HAS_PROMPT_SERVER:
        try:
            PromptServer.instance.send_progress_text(text, node_id)
        except Exception as e:
            logger.debug("发送进度文本失败：%s", e)

    return pbar


def _make_progress_callback(node_id: Optional[str]):
    """
    创建进度回调函数，用于在 ComfyUI 中显示视频任务进度

    Args:
        node_id: 节点 ID（来自 hidden.unique_id）

    Returns:
        进度回调函数
    """
    # 为视频任务的轮询创建一个 100 步的进度条
    pbar = None
    if node_id:
        try:
            pbar = comfy.utils.ProgressBar(100, node_id=node_id)
        except Exception as e:
            logger.debug("创建 ProgressBar 失败：%s", e)

    def callback(progress: int, status: str):
        if pbar:
            try:
                pbar.update_absolute(progress, 100)
            except Exception as e:
                logger.debug("更新进度条失败：%s", e)

        # 发送状态文本
        if status and node_id and _HAS_PROMPT_SERVER:
            try:
                PromptServer.instance.send_progress_text(
                    f"Agnes 视频任务：{status} ({progress}%)", node_id
                )
            except Exception as e:
                logger.debug("发送进度文本失败：%s", e)

    return callback


# ============================================================
# 图像节点（文生图 / 图生图合并）
# ============================================================

class AgnesImage:
    """
    Agnes Image 节点（文生图 + 图生图 + 多图合成）

    - 不连接参考图片：文生图
    - 连接 1 张或多张参考图片：图生图 / 多图合成（逐级展开，最多 5 张）
    - ratio=auto 时自动沿用第一张参考图的比例
    - model 可在 agnes-image-2.5-flash 与 agnes-image-2.1-flash 之间切换
    """

    DESCRIPTION = "Generate an image from a prompt, or edit a reference image, using Agnes Image models (2.5 Flash / 2.1 Flash)"

    CATEGORY = "UIIIAIII Toolkit/Agnes"

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)

    FUNCTION = "generate"

    OUTPUT_NODE = True

    # 默认模型（旧节点子类可覆盖，保持旧工作流行为）
    DEFAULT_MODEL = agnes_client.AGNES_IMAGE_MODEL

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "Text prompt for generation, or the edit instruction when an image is connected",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "tooltip": "Random seed used to break the ComfyUI execution cache (the Agnes Image API does not support seed, so this value is not sent to the API)",
                    },
                ),
                "size": (
                    ["1K", "2K", "3K", "4K"],
                    {
                        "default": "2K",
                        "tooltip": "Output size preset",
                    },
                ),
                "ratio": (
                    agnes_client.IMAGE_RATIO_OPTIONS_WITH_AUTO,
                    {
                        "default": "auto",
                        "tooltip": "Aspect ratio. 'auto' keeps the reference image ratio when an image is connected, and falls back to 1:1 for text-to-image",
                    },
                ),
                "model": (
                    agnes_client.AGNES_IMAGE_MODELS,
                    {
                        "default": cls.DEFAULT_MODEL,
                        "tooltip": "Agnes image model: 2.5 Flash is the newest generation; 2.1 Flash is the previous generation",
                    },
                ),
            },
            "optional": {
                "reference_images_1": (
                    "IMAGE",
                    {
                        "display_name": "Reference image 1",
                        "tooltip": "Reference image for editing / multi-image composition. Connect to reveal the next slot (up to 5)",
                    },
                ),
                "reference_images_2": (
                    "IMAGE",
                    {
                        "display_name": "Reference image 2",
                        "tooltip": "Reference image for editing / multi-image composition. Connect to reveal the next slot (up to 5)",
                    },
                ),
                "reference_images_3": (
                    "IMAGE",
                    {
                        "display_name": "Reference image 3",
                        "tooltip": "Reference image for editing / multi-image composition. Connect to reveal the next slot (up to 5)",
                    },
                ),
                "reference_images_4": (
                    "IMAGE",
                    {
                        "display_name": "Reference image 4",
                        "tooltip": "Reference image for editing / multi-image composition. Connect to reveal the next slot (up to 5)",
                    },
                ),
                "reference_images_5": (
                    "IMAGE",
                    {
                        "display_name": "Reference image 5",
                        "tooltip": "Reference image for editing / multi-image composition. Up to 5 images are sent",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt_id": "PROMPT_ID",
            },
        }

    def generate(
        self,
        prompt: str,
        seed: int = 0,
        size: str = "2K",
        ratio: str = "auto",
        model: Optional[str] = None,
        unique_id: Optional[str] = None,
        prompt_id: Optional[str] = None,
        **kwargs,
    ):
        """执行文生图 / 图生图 / 多图合成"""
        # 验证提示词
        if not prompt or not prompt.strip():
            raise RuntimeError("Prompt cannot be empty")

        model = model or self.DEFAULT_MODEL
        limit = agnes_client.IMAGE_MAX_REFERENCE_IMAGES

        # 收集参考图：逐级展开的 reference_images_1..5（每个插槽也可接批次）
        slots = [kwargs.get(f"reference_images_{i}") for i in range(1, limit + 1)]

        source_images = []
        for slot in slots:
            if slot is None:
                continue
            count = int(slot.shape[0]) if len(slot.shape) == 4 else 1
            for i in range(count):
                if len(source_images) >= limit:
                    break
                source_images.append(slot[i:i + 1])
            if len(source_images) >= limit:
                break

        has_image = bool(source_images)
        total = 4 if has_image else 3

        pbar = _update_progress(
            unique_id,
            0,
            total,
            "Encoding reference image(s)..." if has_image else "Calling Agnes image API...",
        )

        image_data_uris = None
        if has_image:
            # 参考图 → Data URI（官方文档：图生图放在 extra_body.image）
            try:
                image_data_uris = [
                    agnes_client.image_tensor_to_data_uri(t) for t in source_images
                ]
            except Exception as e:
                raise RuntimeError(f"Reference image encoding failed: {e}")

            # ratio=auto：自动匹配第一张参考图比例，保持构图一致
            if ratio == "auto":
                ratio = agnes_client.detect_image_ratio(source_images[0])

            pbar = _update_progress(unique_id, 1, total, "Calling Agnes image API...", pbar)
        elif ratio == "auto":
            ratio = "1:1"

        logger.info(
            "Agnes 图像请求：model=%s, mode=%s, refs=%d, size=%s, ratio=%s",
            model,
            "图生图/多图合成" if has_image else "文生图",
            len(source_images),
            size,
            ratio,
        )

        # 注意：Agnes Image API 不支持 seed 参数，seed 仅用于打破 ComfyUI 缓存，不发送给 API
        # 根据官方文档，response_format 必须放在 extra_body 中
        # API Key 自动从 ComfyUI 设置面板读取
        try:
            url_result, b64_result = agnes_client.generate_image(
                prompt=prompt.strip(),
                model=model,
                size=size,
                ratio=ratio,
                image_data_uris=image_data_uris,
                return_base64=False,
                extra_params={"response_format": "url"},
                timeout=agnes_client.DEFAULT_TIMEOUT,
            )
        except Exception as e:
            raise RuntimeError(f"Agnes image API call failed: {e}")

        pbar = _update_progress(unique_id, total - 1, total, "Downloading generated image...", pbar)

        # 处理返回结果
        try:
            if url_result:
                image_buffer = agnes_client.download_url_to_bytesio(url_result)
                image_tensor = agnes_client.bytesio_to_image_tensor(image_buffer)
            elif b64_result:
                import base64 as b64mod
                img_data = b64mod.b64decode(b64_result)
                image_buffer = BytesIO(img_data)
                image_tensor = agnes_client.bytesio_to_image_tensor(image_buffer)
            else:
                raise RuntimeError("API did not return an image URL or Base64 data")
        except Exception as e:
            raise RuntimeError(f"Image download/decode failed: {e}")

        # 诊断日志：确认图像解码成功及张量形状
        logger.info(
            "Agnes 图像生成完成：model=%s，返回张量形状 %s，dtype=%s",
            model, tuple(image_tensor.shape), image_tensor.dtype,
        )

        _update_progress(unique_id, total, total, "Image generation complete", pbar)

        return (image_tensor,)


# ============================================================
# 视频节点（文生视频 / 首尾帧 / 参考素材合并）
# ============================================================

class AgnesVideo:
    """
    Agnes Video 2.5 Flash 节点

    根据连接的输入自动选择生成模式：
    - 无媒体输入：文生视频（text）
    - 连接 first_frame / last_frame：首尾帧控制（keyframe）
    - 连接 reference_images 或填入参考音频：参考生成（reference）
    """

    DESCRIPTION = "Generate videos with Agnes Video 2.5 Flash: text-to-video, first/last frame control, or reference images and audio"

    CATEGORY = "UIIIAIII Toolkit/Agnes"

    RETURN_TYPES = ("VIDEO",) if _HAS_VIDEO_SUPPORT else ("STRING",)
    RETURN_NAMES = ("video",) if _HAS_VIDEO_SUPPORT else ("video_path",)

    FUNCTION = "generate"

    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "Video description. In reference mode use <Picture 1>, <Audio 1>, ... to refer to the reference media",
                    },
                ),
                "seconds": (
                    agnes_client.VIDEO_SECONDS,
                    {
                        "default": "5",
                        "tooltip": "Video duration in seconds (4-12)",
                    },
                ),
                "aspect_ratio": (
                    agnes_client.VIDEO_ASPECT_RATIOS,
                    {
                        "default": "16:9",
                        "tooltip": "Output aspect ratio (Agnes Video 2.5 Flash is fixed at 720P)",
                    },
                ),
            },
            "optional": {
                "first_frame": (
                    "IMAGE",
                    {
                        "tooltip": "Keyframe mode: first frame. Connect first_frame and/or last_frame to use keyframe control",
                    },
                ),
                "last_frame": (
                    "IMAGE",
                    {
                        "tooltip": "Keyframe mode: last frame. Provide first_frame and/or last_frame (at least one)",
                    },
                ),
                "reference_images_1": (
                    "IMAGE",
                    {
                        "display_name": "Reference image 1",
                        "tooltip": "Reference mode: reference image(s). Connect this input to reveal the next slot (up to 5)",
                    },
                ),
                "reference_images_2": (
                    "IMAGE",
                    {
                        "display_name": "Reference image 2",
                        "tooltip": "Reference mode: reference image(s). Connect this input to reveal the next slot (up to 5)",
                    },
                ),
                "reference_images_3": (
                    "IMAGE",
                    {
                        "display_name": "Reference image 3",
                        "tooltip": "Reference mode: reference image(s). Connect this input to reveal the next slot (up to 5)",
                    },
                ),
                "reference_images_4": (
                    "IMAGE",
                    {
                        "display_name": "Reference image 4",
                        "tooltip": "Reference mode: reference image(s). Connect this input to reveal the next slot (up to 5)",
                    },
                ),
                "reference_images_5": (
                    "IMAGE",
                    {
                        "display_name": "Reference image 5",
                        "tooltip": "Reference mode: reference image(s). Up to 5 images are sent",
                    },
                ),
                "reference_audio_1": (
                    "AUDIO",
                    {
                        "display_name": "Reference audio 1",
                        "tooltip": "Reference mode: local audio input (e.g. from LoadAudio). Encoded as mono 16 kHz WAV and sent inline; connect to reveal the next slot (up to 3)",
                    },
                ),
                "reference_audio_2": (
                    "AUDIO",
                    {
                        "display_name": "Reference audio 2",
                        "tooltip": "Reference mode: local audio input (e.g. from LoadAudio). Encoded as mono 16 kHz WAV and sent inline; connect to reveal the next slot (up to 3)",
                    },
                ),
                "reference_audio_3": (
                    "AUDIO",
                    {
                        "display_name": "Reference audio 3",
                        "tooltip": "Reference mode: local audio input (e.g. from LoadAudio). Up to 3 clips are sent",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "tooltip": "Random seed (0 means not specified)",
                    },
                ),
                "poll_interval": (
                    "INT",
                    {
                        "default": 5,
                        "min": 1,
                        "max": 60,
                        "tooltip": "Task polling interval (seconds)",
                    },
                ),
                "max_wait_time": (
                    "INT",
                    {
                        "default": 600,
                        "min": 60,
                        "max": 3600,
                        "tooltip": "Maximum wait time (seconds)",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt_id": "PROMPT_ID",
            },
        }

    def generate(
        self,
        prompt: str,
        seconds: str = "5",
        aspect_ratio: str = "16:9",
        first_frame=None,
        last_frame=None,
        seed: int = 0,
        poll_interval: int = 5,
        max_wait_time: int = 600,
        unique_id: Optional[str] = None,
        prompt_id: Optional[str] = None,
        **kwargs,
    ):
        """执行视频生成（自动判断 text / keyframe / reference 模式）"""
        if not prompt or not prompt.strip():
            raise RuntimeError("Prompt cannot be empty")

        try:
            seconds_int = int(seconds)
        except (TypeError, ValueError):
            seconds_int = 5
        if not 4 <= seconds_int <= 12:
            raise RuntimeError("seconds must be between 4 and 12")

        # 参考图片：逐级展开的 reference_images_1..5（每个插槽也可接批次）
        reference_urls = []
        for i in range(1, agnes_client.VIDEO_MAX_REFERENCE_IMAGES + 1):
            slot = kwargs.get(f"reference_images_{i}")
            if slot is None:
                continue
            remaining = agnes_client.VIDEO_MAX_REFERENCE_IMAGES - len(reference_urls)
            if remaining <= 0:
                break
            reference_urls.extend(_image_batch_to_data_uris(slot, remaining))

        # 参考音频：逐级展开的 reference_audio_1..3，编码为 WAV Data URI
        audios = []
        for i in range(1, agnes_client.VIDEO_MAX_REFERENCE_AUDIOS + 1):
            slot = kwargs.get(f"reference_audio_{i}")
            if slot is None:
                continue
            remaining = agnes_client.VIDEO_MAX_REFERENCE_AUDIOS - len(audios)
            if remaining <= 0:
                break
            try:
                audios.extend(
                    agnes_client.audio_batch_to_data_uris(slot, remaining)
                )
            except Exception as e:
                raise RuntimeError(f"Reference audio encoding failed: {e}")

        has_keyframes = first_frame is not None or last_frame is not None
        has_reference = bool(reference_urls) or bool(audios)

        # 官方模式规则：keyframe 与 reference 的媒体字段不能混用
        if has_keyframes and has_reference:
            raise RuntimeError(
                "Keyframe inputs (first_frame/last_frame) and reference inputs "
                "(reference_images_*/reference_audio_*) cannot be used together"
            )

        first_url = None
        last_url = None

        if has_keyframes:
            mode = "keyframe"
            if first_frame is not None:
                first_url = _upload_image_to_temp_url(
                    first_frame, unique_id, text="Encoding first frame...",
                )
            if last_frame is not None:
                last_url = _upload_image_to_temp_url(
                    last_frame, unique_id, text="Encoding last frame...",
                )
        elif has_reference:
            mode = "reference"
        else:
            mode = "text"

        return _generate_video(
            prompt=prompt.strip(),
            mode=mode,
            seconds=str(seconds_int),
            aspect_ratio=aspect_ratio,
            seed=seed,
            first_frame=first_url,
            last_frame=last_url,
            images=reference_urls or None,
            audios=audios or None,
            poll_interval=poll_interval,
            max_wait_time=max_wait_time,
            unique_id=unique_id,
        )


# ============================================================
# 视频生成辅助函数
# ============================================================

def _image_batch_to_data_uris(image_tensor, limit: int) -> List[str]:
    """
    将 IMAGE 批次转换为多个 Data URI（用于 reference 模式的多张参考图）

    Args:
        image_tensor: ComfyUI IMAGE 张量 [B, H, W, C]
        limit: 最多转换的图片数量（官方上限 5 张）

    Returns:
        Data URI 字符串列表
    """
    total = int(image_tensor.shape[0]) if len(image_tensor.shape) == 4 else 1
    count = min(total, limit)
    if total > limit:
        logger.warning("参考图片批次包含 %d 张，仅发送前 %d 张（官方上限）", total, limit)

    uris = []
    for i in range(count):
        uris.append(agnes_client.image_tensor_to_data_uri(image_tensor[i:i + 1]))
    return uris


def _upload_image_to_temp_url(
    image_tensor,
    unique_id: Optional[str] = None,
    text: str = "Encoding input image...",
) -> str:
    """
    将输入图像转换为 Data URI 以供 Agnes 视频 API 使用

    Args:
        image_tensor: ComfyUI IMAGE 张量
        unique_id: 节点 ID
        text: 进度文案

    Returns:
        图像的 Data URI 字符串
    """
    _update_progress(unique_id, 0, 3, text)

    try:
        data_uri = agnes_client.image_tensor_to_data_uri(image_tensor)
        return data_uri
    except Exception as e:
        raise RuntimeError(f"Input image encoding failed: {e}")


def _generate_video(
    prompt: str,
    mode: str,
    seconds: str = "5",
    aspect_ratio: str = "16:9",
    seed: int = 0,
    first_frame: Optional[str] = None,
    last_frame: Optional[str] = None,
    images: Optional[List[str]] = None,
    audios: Optional[List[str]] = None,
    poll_interval: int = 5,
    max_wait_time: int = 600,
    unique_id: Optional[str] = None,
):
    """
    视频生成的通用实现（text / keyframe / reference 共用）

    API Key 自动从 ComfyUI 设置面板读取，无需传入。

    Args:
        prompt: 视频内容的文本描述
        mode: 生成模式（text / keyframe / reference）
        seconds: 视频时长（"4"-"12"）
        aspect_ratio: 视频画幅
        seed: 随机种子（0 表示不指定）
        first_frame: keyframe 模式首帧（URL / Data URI）
        last_frame: keyframe 模式尾帧（URL / Data URI）
        images: reference 模式参考图片列表
        audios: reference 模式参考音频 URL 列表
        poll_interval: 轮询间隔（秒）
        max_wait_time: 最大等待时间（秒）
        unique_id: 节点 ID

    Returns:
        视频输出（VIDEO 类型或文件路径字符串）
    """
    _update_progress(unique_id, 0, 3, f"Creating Agnes video task ({mode})...")

    try:
        task_result = agnes_client.create_video_task(
            prompt=prompt,
            mode=mode,
            seconds=seconds,
            aspect_ratio=aspect_ratio,
            seed=seed if seed > 0 else None,
            first_frame=first_frame,
            last_frame=last_frame,
            images=images,
            audios=audios,
            timeout=agnes_client.DEFAULT_TIMEOUT,
        )
    except Exception as e:
        raise RuntimeError(f"Failed to create Agnes video task: {e}")

    # 提取 video_id（2.5 返回 video_id；兼容 id / task_id）
    video_id = (
        task_result.get("video_id")
        or task_result.get("id")
        or task_result.get("task_id")
    )
    if not video_id:
        raise RuntimeError(f"No video_id found in task creation response: {task_result}")

    logger.info("视频任务已创建：video_id=%s, mode=%s", video_id, mode)

    pbar = _update_progress(
        unique_id, 1, 3,
        f"Waiting for video generation to finish (video_id={video_id})...",
    )

    # 创建进度回调
    progress_callback = _make_progress_callback(unique_id)

    # 轮询任务结果
    try:
        video_url = agnes_client.poll_video_result(
            video_id=video_id,
            poll_interval=poll_interval,
            max_poll_time=max_wait_time,
            timeout=agnes_client.DEFAULT_TIMEOUT,
            progress_callback=progress_callback,
        )
    except Exception as e:
        raise RuntimeError(f"Video generation failed: {e}")

    pbar = _update_progress(unique_id, 2, 3, "Downloading generated video...", pbar)

    # 下载视频
    try:
        video_buffer = agnes_client.download_url_to_bytesio(
            video_url, timeout=300
        )
    except Exception as e:
        raise RuntimeError(f"Video download failed: {e}")

    _update_progress(unique_id, 3, 3, "Video generation complete", pbar)

    # 返回 VIDEO 类型（如果支持）或文件路径
    if _HAS_VIDEO_SUPPORT and InputImpl is not None:
        try:
            video_output = InputImpl.VideoFromFile(video_buffer)
            return (video_output,)
        except Exception as e:
            logger.warning("VideoFromFile 包装失败，退化为文件路径模式：%s", e)
            return _save_video_to_file(video_buffer, video_id)
    else:
        return _save_video_to_file(video_buffer, video_id)


def _save_video_to_file(video_buffer: BytesIO, task_id: str) -> Tuple[str]:
    """
    将视频保存到 ComfyUI 的 output 目录，并返回文件路径

    这是 VIDEO 类型不可用时的退化方案。

    Args:
        video_buffer: 包含视频数据的 BytesIO 对象
        task_id: 任务 ID（用于生成文件名）

    Returns:
        包含文件路径的元组
    """
    # 获取输出目录
    output_dir = folder_paths.get_output_directory()

    # 生成文件名
    safe_task_id = "".join(c if c.isalnum() else "_" for c in str(task_id))
    filename = f"agnes_video_{safe_task_id}_{int(time.time())}.mp4"
    file_path = os.path.join(output_dir, filename)

    # 写入文件
    video_buffer.seek(0)
    with open(file_path, "wb") as f:
        f.write(video_buffer.read())

    logger.info("视频已保存到：%s", file_path)

    return (file_path,)


# ============================================================
# Qwen 图像编辑节点（基于 Qwen-Image-Edit-2511）
# ============================================================


def _expand_image_slots(slots, limit: int):
    """
    将多个 IMAGE 插槽（每个可含批次）展开为单张图像列表，最多 limit 张

    用于把"逐级展开的多个输入"和"批次输入"统一成同一组参考图。
    """
    images = []
    for slot in slots:
        if slot is None:
            continue
        count = int(slot.shape[0]) if len(slot.shape) == 4 else 1
        for i in range(count):
            if len(images) >= limit:
                break
            images.append(slot[i:i + 1])
        if len(images) >= limit:
            break
    return images


class QwenImageEdit:
    """
    千问图像编辑节点（图生图，支持多图像编辑）

    基于 ModelScope API-Inference 调用 Qwen/Qwen-Image-Edit-2511 模型，
    对输入图像按文本指令进行编辑。

    特点：
    - 使用 ModelScope API-Inference（非 DashScope）
    - 异步任务模式（POST 创建任务 → GET 轮询结果）
    - 支持 1~3 张图像输入（单图编辑或多图融合编辑）
    - 自动检测输入图比例，保持输出比例一致
    - 支持随机种子（仅本地使用，打破 ComfyUI 缓存）
    - 轮询过程实时显示进度
    """

    DESCRIPTION = "Edit input images with the Qwen-Image-Edit-2511 model (ModelScope API-Inference), supporting single/multi image editing"
    CATEGORY = "UIIIAIII Toolkit/Modelscope"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "generate"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "tooltip": "Edit instruction/prompt describing the desired change. For multi-image editing, specify each image's role/position",
                    },
                ),
                "image1": (
                    "IMAGE",
                    {
                        "tooltip": "Input image 1 (main, required). First reference image in multi-image editing",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "tooltip": "Random seed. 0 means the API picks a random seed. Used to break the ComfyUI execution cache",
                    },
                ),
                "ratio": (
                    ["auto"] + qwen_client.IMAGE_RATIO_OPTIONS,
                    {
                        "default": "auto",
                        "tooltip": "Output aspect ratio. 'auto' detects the input ratio (based on image1)",
                    },
                ),
            },
            "optional": {
                "image2": (
                    "IMAGE",
                    {
                        "tooltip": "Input image 2 (optional). Second reference image in multi-image editing",
                    },
                ),
                "image3": (
                    "IMAGE",
                    {
                        "tooltip": "Input image 3 (optional). Third reference image in multi-image editing",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt_id": "PROMPT_ID",
                "control_after_generate": True,
            },
        }

    def generate(
        self,
        prompt: str,
        image1,
        seed: int = 0,
        ratio: str = "auto",
        image2=None,
        image3=None,
        unique_id: Optional[str] = None,
        prompt_id: Optional[str] = None,
    ):
        """执行图生图（图像编辑，支持单/多图像）"""
        # 验证提示词
        if not prompt or not prompt.strip():
            raise RuntimeError("Prompt cannot be empty")

        # 收集所有非空的输入图像（每个插槽可接批次，最多 3 张）
        input_images = _expand_image_slots([image1, image2, image3], 3)

        if not input_images:
            raise RuntimeError("At least one input image (image1) is required")

        logging.info(
            "Qwen 图生图：共收到 %d 张输入图像（单图编辑/多图融合编辑）",
            len(input_images),
        )

        # 进度条
        pbar = _update_progress(unique_id, 0, 100, f"Encoding {len(input_images)} input images...")

        # 将所有输入图像转换为 Data URI（自动压缩）
        data_uris = []
        try:
            for idx, img in enumerate(input_images):
                data_uri = qwen_client.image_tensor_to_data_uri(img)
                data_uris.append(data_uri)
                # 更新编码进度（0~5 区间）
                progress = int(5 * (idx + 1) / len(input_images))
                pbar = _update_progress(
                    unique_id, progress, 100,
                    f"Encoded {idx + 1}/{len(input_images)} input images",
                    pbar,
                )
        except Exception as e:
            raise RuntimeError(f"Input image encoding failed: {e}")

        # 自动检测输入图像比例（以第一张图 image1 为准）
        if ratio == "auto":
            ratio = qwen_client.detect_image_ratio(input_images[0])
        size = qwen_client.ratio_to_size(ratio)

        # 处理 seed：0 表示使用 API 随机种子
        api_seed = None if seed == 0 else min(seed, 2147483647)

        pbar = _update_progress(unique_id, 5, 100, "Submitting task to ModelScope...", pbar)

        # 定义进度回调（用于异步任务轮询过程中更新进度条）
        def _poll_progress_callback(elapsed, max_poll_time, attempt):
            # 进度从 10 到 90，根据已用时间占比计算
            progress = min(90, 10 + int(80 * elapsed / max_poll_time))
            _update_progress(
                unique_id, progress, 100,
                f"Generating image... (waited {elapsed:.1f}s, poll attempt {attempt})",
                pbar,
            )

        # 调用 API（异步任务模式：创建任务 + 轮询结果）
        # 单张图像传字符串，多张图像传列表（API 的 image_url 字段支持列表格式）
        # API Key 自动从 ComfyUI 设置面板读取
        try:
            image_data = data_uris[0] if len(data_uris) == 1 else data_uris
            image_url = qwen_client.edit_image(
                prompt=prompt.strip(),
                image_data_uris=image_data,
                size=size,
                seed=api_seed,
                timeout=qwen_client.DEFAULT_TIMEOUT,
                progress_callback=_poll_progress_callback,
            )
        except Exception as e:
            raise RuntimeError(f"ModelScope image editing API call failed: {e}")

        pbar = _update_progress(unique_id, 95, 100, "Downloading generated image...", pbar)

        # 下载并转换图像
        try:
            image_buffer = qwen_client.download_url_to_bytesio(image_url)
            image_tensor = qwen_client.bytesio_to_image_tensor(image_buffer)
        except Exception as e:
            raise RuntimeError(f"Image download/decode failed: {e}")

        # 诊断日志
        logging.info(
            "Qwen 图生图完成：输入图数量=%d，返回张量形状 %s，dtype=%s",
            len(input_images), tuple(image_tensor.shape), image_tensor.dtype,
        )

        _update_progress(unique_id, 100, 100, "Image generation complete", pbar)

        return (image_tensor,)


# ============================================================
# Qwen-Image-2.1 节点（文生图 + 图像编辑统一模型）
# ============================================================


class QwenImage21:
    """
    Qwen-Image-2.1 节点（文生图 + 图像编辑统一模型）

    基于 ModelScope API-Inference 调用 Qwen/Qwen-Image-2.1：
    - 不连接图片：文生图（原生 2K 输出）
    - 连接图片：按指令编辑，支持 1~4 张参考图
      （模型本身支持 10 张，但 ModelScope API-Inference 实测限制为 4 张）

    特点：
    - 异步任务模式（POST 创建任务 → GET 轮询结果）
    - 自动检测首张输入图比例，保持输出比例一致（文生图默认 1:1）
    - 支持随机种子（仅本地使用，打破 ComfyUI 缓存）
    - 轮询过程实时显示进度
    """

    DESCRIPTION = "Unified text-to-image generation and image editing with the Qwen-Image-2.1 model (ModelScope API-Inference), supporting up to 4 reference images"
    CATEGORY = "UIIIAIII Toolkit/Modelscope"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "generate"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "tooltip": "Generation prompt, or edit instruction describing the desired change. With multiple images, specify each image's role/position",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "tooltip": "Random seed. 0 means the API picks a random seed. Used to break the ComfyUI execution cache",
                    },
                ),
                "ratio": (
                    ["auto"] + qwen_client.IMAGE_RATIO_OPTIONS_21,
                    {
                        "default": "auto",
                        "tooltip": "Output aspect ratio. 'auto' detects the ratio of the first connected image, and falls back to 1:1 for text-to-image",
                    },
                ),
                "resolution": (
                    qwen_client.IMAGE_RESOLUTION_OPTIONS_21,
                    {
                        "default": "1K",
                        "tooltip": "Output resolution. 1K (1024px max edge) is fast and stable and recommended for multi-image editing; 2K (2048px max edge) is the native quality but much slower and may fail with 4 reference images",
                    },
                ),
            },
            "optional": {
                "image1": (
                    "IMAGE",
                    {
                        "tooltip": "Reference image 1 (optional). Connect images for editing; leave all empty for text-to-image",
                    },
                ),
                "image2": (
                    "IMAGE",
                    {
                        "tooltip": "Reference image 2 (optional). Up to 4 reference images per run",
                    },
                ),
                "image3": (
                    "IMAGE",
                    {
                        "tooltip": "Reference image 3 (optional). Up to 4 reference images per run",
                    },
                ),
                "image4": (
                    "IMAGE",
                    {
                        "tooltip": "Reference image 4 (optional). Up to 4 reference images per run",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt_id": "PROMPT_ID",
                "control_after_generate": True,
            },
        }

    def generate(
        self,
        prompt: str,
        seed: int = 0,
        ratio: str = "auto",
        resolution: str = "1K",
        image1=None,
        image2=None,
        image3=None,
        image4=None,
        unique_id: Optional[str] = None,
        prompt_id: Optional[str] = None,
    ):
        """执行文生图或图像编辑"""
        # 验证提示词
        if not prompt or not prompt.strip():
            raise RuntimeError("Prompt cannot be empty")

        # 收集所有非空的输入图像（每个插槽可接批次，全部为空 = 文生图）
        max_refs = qwen_client.QWEN_21_MAX_REFERENCE_IMAGES
        input_images = _expand_image_slots([image1, image2, image3, image4], max_refs)

        # 平台参考图数量上限校验（避免 API 端报错）
        max_refs = qwen_client.QWEN_21_MAX_REFERENCE_IMAGES
        if len(input_images) > max_refs:
            raise RuntimeError(
                f"Too many input images: {len(input_images)}. "
                f"ModelScope API-Inference allows at most {max_refs} reference images "
                f"for {qwen_client.QWEN_21_MODEL}"
            )

        logging.info(
            "Qwen-Image-2.1：%s",
            f"图像编辑（%d 张参考图）" % len(input_images) if input_images else "文生图",
        )

        # 进度条
        pbar = _update_progress(
            unique_id, 0, 100,
            f"Encoding {len(input_images)} input images..." if input_images
            else "Preparing text-to-image request...",
        )

        # 将所有输入图像转换为 Data URI（文生图时跳过）
        data_uris = []
        if input_images:
            try:
                for idx, img in enumerate(input_images):
                    data_uri = qwen_client.image_tensor_to_data_uri(img)
                    data_uris.append(data_uri)
                    # 更新编码进度（0~5 区间）
                    progress = int(5 * (idx + 1) / len(input_images))
                    pbar = _update_progress(
                        unique_id, progress, 100,
                        f"Encoded {idx + 1}/{len(input_images)} input images",
                        pbar,
                    )
            except Exception as e:
                raise RuntimeError(f"Input image encoding failed: {e}")

        # 比例：auto → 有输入图按首图检测，文生图固定 1:1
        if ratio == "auto":
            ratio = qwen_client.detect_image_ratio(input_images[0]) if input_images else "1:1"
        size = qwen_client.ratio_to_size_21(ratio, resolution)

        # 处理 seed：0 表示使用 API 随机种子
        api_seed = None if seed == 0 else min(seed, 2147483647)

        pbar = _update_progress(unique_id, 5, 100, "Submitting task to ModelScope...", pbar)

        # 定义进度回调（用于异步任务轮询过程中更新进度条）
        def _poll_progress_callback(elapsed, max_poll_time, attempt):
            # 进度从 10 到 90，根据已用时间占比计算
            progress = min(90, 10 + int(80 * elapsed / max_poll_time))
            _update_progress(
                unique_id, progress, 100,
                f"Generating image... (waited {elapsed:.1f}s, poll attempt {attempt})",
                pbar,
            )

        # 调用 API（异步任务模式：创建任务 + 轮询结果）
        # 单张图像传字符串，多张图像传列表；无图像传空（文生图）
        # API Key 自动从 ComfyUI 设置面板读取
        try:
            image_data = data_uris[0] if len(data_uris) == 1 else data_uris
            image_url = qwen_client.edit_image(
                prompt=prompt.strip(),
                image_data_uris=image_data,
                size=size,
                seed=api_seed,
                timeout=qwen_client.DEFAULT_TIMEOUT,
                progress_callback=_poll_progress_callback,
                model=qwen_client.QWEN_21_MODEL,
                max_poll_time=qwen_client.MAX_POLL_TIME_21,
            )
        except Exception as e:
            raise RuntimeError(f"ModelScope Qwen-Image-2.1 API call failed: {e}")

        pbar = _update_progress(unique_id, 95, 100, "Downloading generated image...", pbar)

        # 下载并转换图像
        try:
            image_buffer = qwen_client.download_url_to_bytesio(image_url)
            image_tensor = qwen_client.bytesio_to_image_tensor(image_buffer)
        except Exception as e:
            raise RuntimeError(f"Image download/decode failed: {e}")

        # 诊断日志
        logging.info(
            "Qwen-Image-2.1 完成：输入图数量=%d，返回张量形状 %s，dtype=%s",
            len(input_images), tuple(image_tensor.shape), image_tensor.dtype,
        )

        _update_progress(unique_id, 100, 100, "Image generation complete", pbar)

        return (image_tensor,)


# ============================================================
# ModelScope 文生图节点（Krea 2 Turbo / Z-Image Turbo）
# ============================================================


class _ModelScopeTextToImage:
    """ModelScope 文生图节点基类（Krea 2 Turbo / Z-Image Turbo 共用）"""

    MODEL = ""
    MODEL_LABEL = ""
    DESCRIPTION = ""
    CATEGORY = "UIIIAIII Toolkit/Modelscope"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "generate"
    OUTPUT_NODE = True
    RESOLUTION_OPTIONS = qwen_client.TURBO_RESOLUTION_OPTIONS

    @staticmethod
    def size_for(ratio: str, resolution: str) -> str:
        return qwen_client.ratio_to_size_turbo(ratio, resolution)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "tooltip": f"Text prompt for {cls.MODEL_LABEL}",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "tooltip": "Random seed. 0 means the API picks a random seed. Used to break the ComfyUI execution cache",
                    },
                ),
                "ratio": (
                    qwen_client.IMAGE_RATIO_OPTIONS_21,
                    {
                        "default": "1:1",
                        "tooltip": f"Output aspect ratio for {cls.MODEL_LABEL}",
                    },
                ),
                "resolution": (
                    cls.RESOLUTION_OPTIONS,
                    {
                        "default": "1K",
                        "tooltip": "Output resolution: 1K (1024px max edge, faster) or 2K (2048px max edge, higher detail)",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt_id": "PROMPT_ID",
                "control_after_generate": True,
            },
        }

    def generate(
        self,
        prompt: str,
        seed: int = 0,
        ratio: str = "1:1",
        resolution: str = "1K",
        unique_id: Optional[str] = None,
        prompt_id: Optional[str] = None,
    ):
        """执行文生图"""
        if not prompt or not prompt.strip():
            raise RuntimeError("Prompt cannot be empty")

        size = self.size_for(ratio, resolution)
        api_seed = None if seed == 0 else min(seed, 2147483647)

        pbar = _update_progress(
            unique_id, 0, 100, f"Submitting {self.MODEL_LABEL} task to ModelScope...",
        )

        def _poll_progress_callback(elapsed, max_poll_time, attempt):
            progress = min(90, 10 + int(80 * elapsed / max_poll_time))
            _update_progress(
                unique_id, progress, 100,
                f"Generating image... (waited {elapsed:.1f}s, poll attempt {attempt})",
                pbar,
            )

        try:
            image_url = qwen_client.edit_image(
                prompt=prompt.strip(),
                image_data_uris=(),
                size=size,
                seed=api_seed,
                timeout=qwen_client.DEFAULT_TIMEOUT,
                progress_callback=_poll_progress_callback,
                model=self.MODEL,
                max_poll_time=qwen_client.MAX_POLL_TIME,
            )
        except Exception as e:
            raise RuntimeError(f"ModelScope {self.MODEL_LABEL} API call failed: {e}")

        pbar = _update_progress(unique_id, 95, 100, "Downloading generated image...", pbar)

        try:
            image_buffer = qwen_client.download_url_to_bytesio(image_url)
            image_tensor = qwen_client.bytesio_to_image_tensor(image_buffer)
        except Exception as e:
            raise RuntimeError(f"Image download/decode failed: {e}")

        logging.info(
            "%s 完成：model=%s, size=%s，返回张量形状 %s，dtype=%s",
            self.MODEL_LABEL, self.MODEL, size,
            tuple(image_tensor.shape), image_tensor.dtype,
        )

        _update_progress(unique_id, 100, 100, "Image generation complete", pbar)

        return (image_tensor,)


class Krea2Turbo(_ModelScopeTextToImage):
    """Krea 2 Turbo 文生图节点"""

    MODEL = qwen_client.KREA_2_TURBO_MODEL
    MODEL_LABEL = "Krea 2 Turbo"
    DESCRIPTION = "Generate images with the krea/Krea-2-Turbo model (ModelScope API-Inference)"


class ZImageTurbo(_ModelScopeTextToImage):
    """Z-Image Turbo 文生图节点"""

    MODEL = qwen_client.Z_IMAGE_TURBO_MODEL
    MODEL_LABEL = "Z-Image Turbo"
    DESCRIPTION = "Generate images with the Tongyi-MAI/Z-Image-Turbo model (ModelScope API-Inference)"


class MossImageSFT(_ModelScopeTextToImage):
    """MOSS-Image-SFT 文生图节点"""

    MODEL = qwen_client.MOSS_IMAGE_SFT_MODEL
    MODEL_LABEL = "MOSS Image SFT"
    DESCRIPTION = "Generate images with the openmoss/MOSS-Image-SFT model (ModelScope API-Inference), supporting natural-language, tag and JSON layout prompts"
    RESOLUTION_OPTIONS = ["1K", "2K"]

    @staticmethod
    def size_for(ratio: str, resolution: str) -> str:
        # MOSS-Image 要求宽高必须是 16 的倍数
        return qwen_client.ratio_to_size_moss(ratio, resolution)


# ============================================================
# MiniMax H3 Image 节点（文生图 + 图像编辑，多参考图）
# ============================================================


class MiniMaxH3Image:
    """
    MiniMax H3 Image 节点

    - 不连接参考图：文生图
    - 连接参考图：图像编辑 / 多图参考（逐级展开，最多 16 张）
    """

    DESCRIPTION = "Generate or edit images with MiniMax-H3-Image (ModelScope API-Inference); connect reference images for editing (up to 16)"

    CATEGORY = "UIIIAIII Toolkit/Modelscope"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "generate"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        max_refs = qwen_client.MINIMAX_MAX_REFERENCE_IMAGES
        optional = {}
        for i in range(1, max_refs + 1):
            optional[f"reference_images_{i}"] = (
                "IMAGE",
                {
                    "display_name": f"Reference image {i}",
                    "tooltip": (
                        "Reference image for editing. Connect to reveal the next slot "
                        f"(up to {max_refs}); leave all empty for text-to-image"
                    ),
                },
            )

        return {
            "required": {
                "prompt": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "tooltip": "Generation prompt, or the edit instruction when reference images are connected",
                    },
                ),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "tooltip": "Random seed. 0 means the API picks a random seed. Used to break the ComfyUI execution cache",
                    },
                ),
                "ratio": (
                    ["auto"] + qwen_client.IMAGE_RATIO_OPTIONS_21,
                    {
                        "default": "auto",
                        "tooltip": "Output aspect ratio. 'auto' follows the first reference image, and falls back to 1:1 for text-to-image",
                    },
                ),
                "resolution": (
                    qwen_client.MINIMAX_RESOLUTION_OPTIONS,
                    {
                        "default": "1K",
                        "tooltip": "Output resolution: 1K (1024px max edge, fastest) or 2K (2048px max edge; ModelScope's platform limit)",
                    },
                ),
            },
            "optional": optional,
            "hidden": {
                "unique_id": "UNIQUE_ID",
                "prompt_id": "PROMPT_ID",
                "control_after_generate": True,
            },
        }

    def generate(
        self,
        prompt: str,
        seed: int = 0,
        ratio: str = "auto",
        resolution: str = "1K",
        unique_id: Optional[str] = None,
        prompt_id: Optional[str] = None,
        **kwargs,
    ):
        """执行文生图或图像编辑 / 多图参考"""
        if not prompt or not prompt.strip():
            raise RuntimeError("Prompt cannot be empty")

        max_refs = qwen_client.MINIMAX_MAX_REFERENCE_IMAGES
        slots = [kwargs.get(f"reference_images_{i}") for i in range(1, max_refs + 1)]
        input_images = _expand_image_slots(slots, max_refs)

        logging.info(
            "MiniMax H3 Image：%s",
            f"图像编辑（{len(input_images)} 张参考图）" if input_images else "文生图",
        )

        pbar = _update_progress(
            unique_id, 0, 100,
            f"Encoding {len(input_images)} reference images..." if input_images
            else "Preparing text-to-image request...",
        )

        data_uris = []
        if input_images:
            try:
                for idx, img in enumerate(input_images):
                    data_uris.append(qwen_client.image_tensor_to_data_uri(img))
                    progress = int(5 * (idx + 1) / len(input_images))
                    pbar = _update_progress(
                        unique_id, progress, 100,
                        f"Encoded {idx + 1}/{len(input_images)} reference images",
                        pbar,
                    )
            except Exception as e:
                raise RuntimeError(f"Reference image encoding failed: {e}")

        if ratio == "auto":
            ratio = qwen_client.detect_image_ratio(input_images[0]) if input_images else "1:1"
        size = qwen_client.ratio_to_size_minimax(ratio, resolution)

        api_seed = None if seed == 0 else min(seed, 2147483647)

        pbar = _update_progress(unique_id, 5, 100, "Submitting task to ModelScope...", pbar)

        def _poll_progress_callback(elapsed, max_poll_time, attempt):
            progress = min(90, 10 + int(80 * elapsed / max_poll_time))
            _update_progress(
                unique_id, progress, 100,
                f"Generating image... (waited {elapsed:.1f}s, poll attempt {attempt})",
                pbar,
            )

        try:
            image_url = qwen_client.edit_image(
                prompt=prompt.strip(),
                image_data_uris=data_uris if data_uris else (),
                size=size,
                seed=api_seed,
                timeout=qwen_client.DEFAULT_TIMEOUT,
                progress_callback=_poll_progress_callback,
                model=qwen_client.MINIMAX_H3_IMAGE_MODEL,
                max_poll_time=qwen_client.MAX_POLL_TIME_21,
            )
        except Exception as e:
            raise RuntimeError(f"ModelScope MiniMax-H3-Image API call failed: {e}")

        pbar = _update_progress(unique_id, 95, 100, "Downloading generated image...", pbar)

        try:
            image_buffer = qwen_client.download_url_to_bytesio(image_url)
            image_tensor = qwen_client.bytesio_to_image_tensor(image_buffer)
        except Exception as e:
            raise RuntimeError(f"Image download/decode failed: {e}")

        logging.info(
            "MiniMax H3 Image 完成：输入图数量=%d, size=%s，返回张量形状 %s，dtype=%s",
            len(input_images), size, tuple(image_tensor.shape), image_tensor.dtype,
        )

        _update_progress(unique_id, 100, 100, "Image generation complete", pbar)

        return (image_tensor,)


# ============================================================
# 文本节点（二合一：可编辑输入 + 接收上游同步）
# ============================================================

class TextPreview:
    """
    二合一文本节点（输入 + 预览）

    - text：可编辑多行文本框，用户可直接编辑，作为输出传递给下游
    - source：可选输入端口，连接上游文本节点
      连接后，上游文本会自动同步到 text 编辑框，用户可在此基础上修改
      上游文本变化时才同步，未变化时不覆盖用户的修改

    工作流示例：
        TextInput → TextPreview(source) → 下游节点
        上游文本自动填入 TextPreview 的编辑框，用户可修改后输出
    """

    DESCRIPTION = "Two-in-one text node: edit text directly, or sync upstream text into the edit box and modify the output"

    CATEGORY = "UIIIAIII Toolkit/Text"

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)

    FUNCTION = "execute"

    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": (
                    "STRING",
                    {
                        "multiline": True,
                        "default": "",
                        "tooltip": "Text content (editable). When source is connected, the upstream text is synced into this box automatically",
                    },
                ),
            },
            "optional": {
                "source": (
                    "STRING",
                    {
                        "forceInput": True,
                        "tooltip": "Optional: connect an upstream text node; its text is synced into the edit box for editing",
                    },
                ),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    def execute(self, text="", source=None, unique_id: Optional[str] = None):
        """
        执行文本输出

        - 输出始终是 text（用户编辑框的值）
        - 如果 source 有值（连接了上游），通过 ui.source_text 返回给前端
          前端检测到 source_text 后同步到 text 编辑框
        """
        # 统一 text 为字符串
        if not isinstance(text, str):
            text = str(text) if text is not None else ""

        # 构建 ui 反馈
        ui = {"text": [text]}
        # 如果 source 有值，反馈给前端用于同步到编辑框
        if source is not None and isinstance(source, str) and source:
            ui["source_text"] = [source]

        return {"ui": ui, "result": (text,)}


class BackgroundFill:
    """
    背景填充节点：使用图片或纯色作为背景进行填充。

    - 连接 background 图片时，背景图等比缩放到指定画布尺寸，前景居中放置；
    - 不连接背景图时，使用 background_color 纯色填充画布。

    两者都保持前景等比缩放（比例固定不变形）。

    参数：
        image               : 前景图（待填充的图）
        background          : 背景图（可选，作为填充的图片，不连则用纯色）
        background_width    : 背景画布宽度（像素）
        background_height   : 背景画布高度（像素）
        foreground_width    : 前景宽度（像素，等比缩放）
        foreground_height   : 前景高度（像素，等比缩放）
        background_color    : 背景纯色（#RRGGBB，默认黑色 0,0,0）
        feathering          : 前景边缘羽化过渡（像素，0 为不羽化）
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "background_width": ("INT", {"default": 1024, "min": 16, "max": 16384, "step": 8}),
                "background_height": ("INT", {"default": 1024, "min": 16, "max": 16384, "step": 8}),
                "foreground_width": ("INT", {"default": 512, "min": 16, "max": 16384, "step": 8}),
                "foreground_height": ("INT", {"default": 512, "min": 16, "max": 16384, "step": 8}),
                "background_color": ("STRING", {"default": "#000000", "color": True, "tooltip": "Solid fill color when no background image is connected (#RRGGBB)"}),
                "feathering": ("INT", {"default": 0, "min": 0, "max": 4096, "step": 1}),
            },
            "optional": {
                "background": ("IMAGE",),
                "mask": ("MASK",),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "bg_fill"

    CATEGORY = "UIIIAIII Toolkit/Tools"

    @staticmethod
    def _scale_to(img_tensor, out_h, out_w):
        """把 [h, w, C] 图像等比缩放到指定像素尺寸（保持比例）"""
        h, w = img_tensor.shape[0], img_tensor.shape[1]
        if (h, w) == (out_h, out_w):
            return img_tensor
        return F.interpolate(
            img_tensor.permute(2, 0, 1).unsqueeze(0),
            size=(out_h, out_w),
            mode="bilinear",
            align_corners=False,
        ).permute(0, 2, 3, 1).squeeze(0)

    @staticmethod
    def _to_rgb(img_tensor):
        """统一为 3 通道 RGB：丢弃 alpha / 复制单通道，避免与背景画布通道数不匹配"""
        if img_tensor.shape[-1] == 4:
            return img_tensor[..., :3]
        if img_tensor.shape[-1] == 1:
            return img_tensor.repeat(1, 1, 3)
        return img_tensor

    @staticmethod
    def _parse_hex_color(hex_str, fallback=(0.0, 0.0, 0.0)):
        """解析 #RRGGBB 颜色为 0-1 RGB 元组，格式非法时返回 fallback"""
        try:
            s = hex_str.strip().lstrip("#")
            if len(s) == 6:
                r = int(s[0:2], 16) / 255.0
                g = int(s[2:4], 16) / 255.0
                b = int(s[4:6], 16) / 255.0
                return (r, g, b)
            if len(s) == 3:  # 简写 #RGB
                r = int(s[0] * 2, 16) / 255.0
                g = int(s[1] * 2, 16) / 255.0
                b = int(s[2] * 2, 16) / 255.0
                return (r, g, b)
        except Exception:
            pass
        return fallback

    def bg_fill(self, image, background_width, background_height,
                foreground_width, foreground_height, background_color="#000000",
                feathering=0, background=None, mask=None):
        # 记录运行时状态，便于排查背景图是否传入
        logger.info(
            "背景填充：background=%s 尺寸图=%sx%s 前景=%sx%s 颜色=%s 羽化=%s",
            "已连接" if background is not None else "未连接(None)",
            background_width, background_height,
            foreground_width, foreground_height,
            background_color, feathering,
        )

        # 前景：统一为 RGB 后等比缩放到指定尺寸
        fg = self._scale_to(self._to_rgb(image[0]), foreground_height, foreground_width)
        FG_H, FG_W = fg.shape[0], fg.shape[1]

        # 背景画布：有背景图则等比缩放，否则用纯色
        if background is not None:
            bg = self._scale_to(self._to_rgb(background[0]), background_height, background_width)
        else:
            r, g, b = self._parse_hex_color(background_color)
            bg = torch.zeros((background_height, background_width, 3),
                             dtype=image.dtype, device=image.device)
            bg[..., 0] = r
            bg[..., 1] = g
            bg[..., 2] = b
        BG_H, BG_W = bg.shape[0], bg.shape[1]

        # 画布大小校验：前景不能超出背景
        if FG_H > BG_H or FG_W > BG_W:
            raise ValueError(
                f"前景({FG_W}x{FG_H})大于背景画布({BG_W}x{BG_H})，请增大背景尺寸或缩小前景尺寸"
            )

        # 前景居中放置
        offset_y = (BG_H - FG_H) // 2
        offset_x = (BG_W - FG_W) // 2
        B = image.shape[0]

        new_image = bg.clone().unsqueeze(0).repeat(B, 1, 1, 1)
        new_image[:, offset_y : offset_y + FG_H, offset_x : offset_x + FG_W, :] = fg

        # 前景遮罩（羽化时为渐变权重）
        if feathering > 0:
            k = min(feathering, FG_H // 2, FG_W // 2)
            alpha = torch.zeros((B, BG_H, BG_W, 1), dtype=image.dtype, device=image.device)
            alpha[:, offset_y : offset_y + FG_H, offset_x : offset_x + FG_W, 0] = 1.0
            kw = k * 2 + 1
            kernel = torch.ones((1, 1, kw, kw), dtype=image.dtype, device=image.device) / (kw * kw)
            alpha_blur = F.conv2d(alpha.permute(0, 3, 1, 2), kernel, padding=k)
            alpha = alpha_blur.permute(0, 2, 3, 1).clamp(0, 1)
            new_image = new_image * alpha + bg.unsqueeze(0).repeat(B, 1, 1, 1) * (1 - alpha)
            out_mask = alpha.squeeze(-1)
        else:
            out_mask = torch.zeros((B, BG_H, BG_W), dtype=image.dtype, device=image.device)
            out_mask[:, offset_y : offset_y + FG_H, offset_x : offset_x + FG_W] = 1.0

        if mask is not None:
            m = mask[0] if mask.shape[0] == 1 else mask
            m = self._scale_to(m.unsqueeze(-1), FG_H, FG_W).squeeze(-1)  # [FG_H, FG_W]
            out_mask[:, offset_y : offset_y + FG_H, offset_x : offset_x + FG_W] = m.to(out_mask.dtype)

        out = new_image.clamp(0.0, 1.0)
        return (out, out_mask)



class _SeededNoise(int):
    """
    种子 / 噪声二合一对象（单个输出端口即可适配两类输入）。

    同时具备两种身份：
    - 种子值：本身是 int（python 侧 isinstance(x, int) 成立，可直接用于
      torch.manual_seed、算术运算、JSON 序列化等），供 K 采样器 seed、
      SamplerCustom noise_seed 等 INT 输入端使用；
    - 噪声源：带 seed 属性与 generate_noise() 方法，行为与内置「随机噪波」
      (RandomNoise) 完全一致（同种子生成同噪声），供「自定义采样器（高级）」
      等 NOISE 输入端使用。ComfyUI 0.42 起 SamplerCustomAdvanced 会读取
      noise.seed（guider.sample(..., seed=noise.seed)），因此必须提供该属性。

    因此输出类型声明为 "*"（Any），一个端口就能直连两类输入。
    """

    def __new__(cls, seed):
        value = int(seed)
        obj = super().__new__(cls, value)
        # 新版采样器接口需要 noise.seed；int 子类实例可携带自定义属性
        obj.seed = value
        return obj

    def generate_noise(self, input_latent):
        import comfy.sample
        latent_image = input_latent["samples"]
        batch_inds = input_latent["batch_index"] if "batch_index" in input_latent else None
        return comfy.sample.prepare_noise(latent_image, int(self), batch_inds)


class RandomNoiseSeed:
    """
    随机种子节点：单个输出端口，可直连两类输入（无需额外中转节点）。

    - 接到 K 采样器「种子」、SamplerCustom「noise_seed」等 INT 输入：输出种子值；
    - 接到「自定义采样器（高级）」的「噪波」等 NOISE 输入：输出由同一种子生成的
      噪声对象（与内置「随机噪波」节点等价）。

    实现方式：输出类型为 "*"（Any），返回值是 int 的子类且带 generate_noise()，
    故两类消费者都能正确使用同一个值。

    前端配合 JS 扩展提供「🎲 随机 / ♻️ 上次」按钮（同 Efficient 插件的效率采样随机控制）：
    - seed 为 -1 时表示"随机"：提交时由前端随机生成一个新种子；
    - 点击按钮可切换为"使用上次"（恢复上次使用的种子）。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "noise_seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "tooltip": "Seed value passed to the connected node's seed input (e.g. KSampler). -1 means random; used together with the Random/Last button",
                    },
                ),
            },
        }

    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("SEED / NOISE",)
    OUTPUT_TOOLTIPS = ("Connects to both sampler seed inputs (INT, e.g. KSampler) and custom sampler noise inputs (NOISE, e.g. SamplerCustomAdvanced) - both come from the same seed",)
    FUNCTION = "get_seed"
    CATEGORY = "UIIIAIII Toolkit/Tools"

    def get_seed(self, noise_seed):
        # 与 rgthree 的 Seed (rgthree) 一致：原样输出种子值，
        # 随机化由前端按钮在提交时完成（serializeValue）；
        # 返回值同时可作为 NOISE 使用（int 子类 + generate_noise）。
        return (_SeededNoise(noise_seed),)


# ============================================================
# 节点注册
# ============================================================

# 节点类映射
NODE_CLASS_MAPPINGS = {
    "AgnesImage": AgnesImage,
    "AgnesVideo": AgnesVideo,
    "QwenImageEdit": QwenImageEdit,
    "QwenImage21": QwenImage21,
    "Krea2Turbo": Krea2Turbo,
    "ZImageTurbo": ZImageTurbo,
    "MossImageSFT": MossImageSFT,
    "MiniMaxH3Image": MiniMaxH3Image,
    "TextPreview": TextPreview,
    "BackgroundFill": BackgroundFill,
    "RandomNoiseSeed": RandomNoiseSeed,
}

# 节点显示名称映射
NODE_DISPLAY_NAME_MAPPINGS = {
    "AgnesImage": "Agnes Image (2.5 / 2.1 Flash)",
    "AgnesVideo": "Agnes Video (2.5 Flash)",
    "QwenImageEdit": "Qwen Image Edit (qwen-image-edit-2511)",
    "QwenImage21": "Qwen Image 2.1 (qwen-image-2.1)",
    "Krea2Turbo": "Krea 2 Turbo (krea/Krea-2-Turbo)",
    "ZImageTurbo": "Z-Image Turbo (Tongyi-MAI/Z-Image-Turbo)",
    "MossImageSFT": "MOSS Image SFT (openmoss/MOSS-Image-SFT)",
    "MiniMaxH3Image": "MiniMax H3 Image (MiniMax/MiniMax-H3-Image)",
    "TextPreview": "Text Input/Preview",
    "BackgroundFill": "Background Fill",
    "RandomNoiseSeed": "Random Noise Seed",
}
