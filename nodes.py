"""
Agnes AI ComfyUI 节点定义模块

提供 4 个节点：
- AgnesTextToImage：文生图（agnes-image-2.1-flash）
- AgnesImageToImage：图生图（agnes-image-2.1-flash）
- AgnesTextToVideo：文生视频（agnes-video-v2.0）
- AgnesImageToVideo：图生视频（agnes-video-v2.0）

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
# 文生图节点
# ============================================================

class AgnesTextToImage:
    """
    Agnes Image 2.1 Flash 文生图节点

    根据文本提示词生成图像。
    """

    DESCRIPTION = "Generate an image from a text prompt using the Agnes Image 2.1 Flash model"

    CATEGORY = "UIIIAIII Toolkit/Agnes"

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
                        "default": "",
                        "multiline": True,
                        "tooltip": "Text prompt for image generation",
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
                    agnes_client.IMAGE_RATIO_OPTIONS,
                    {
                        "default": "1:1",
                        "tooltip": "Aspect ratio",
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
        ratio: str = "1:1",
        unique_id: Optional[str] = None,
        prompt_id: Optional[str] = None,
    ):
        """执行文生图"""
        # 验证提示词
        if not prompt or not prompt.strip():
            raise RuntimeError("Prompt cannot be empty")

        # 显示进度
        pbar = _update_progress(unique_id, 0, 2, "Calling Agnes image API...")

        # 调用 API（使用 URL 返回模式，更高效）
        # 注意：Agnes Image API 不支持 seed 参数，seed 仅用于打破 ComfyUI 缓存，不发送给 API
        # 根据官方文档，response_format 必须放在 extra_body 中
        # API Key 自动从 ComfyUI 设置面板读取
        try:
            url_result, b64_result = agnes_client.generate_image(
                prompt=prompt.strip(),
                size=size,
                ratio=ratio,
                image_data_uris=None,
                return_base64=False,
                extra_params={"response_format": "url"},
                timeout=agnes_client.DEFAULT_TIMEOUT,
            )
        except Exception as e:
            raise RuntimeError(f"Agnes image API call failed: {e}")

        # 处理返回结果
        pbar = _update_progress(unique_id, 1, 3, "Downloading generated image...", pbar)

        try:
            if url_result:
                # URL 模式：下载图像
                image_buffer = agnes_client.download_url_to_bytesio(url_result)
                image_tensor = agnes_client.bytesio_to_image_tensor(image_buffer)
            elif b64_result:
                # Base64 模式：解码
                import base64 as b64mod
                img_data = b64mod.b64decode(b64_result)
                image_buffer = BytesIO(img_data)
                image_tensor = agnes_client.bytesio_to_image_tensor(image_buffer)
            else:
                raise RuntimeError("API did not return an image URL or Base64 data")
        except Exception as e:
            raise RuntimeError(f"Image download/decode failed: {e}")

        # 诊断日志：确认图像解码成功及张量形状
        import logging
        logging.info(
            "Agnes 图生图完成：返回张量形状 %s，dtype=%s",
            tuple(image_tensor.shape), image_tensor.dtype,
        )

        _update_progress(unique_id, 2, 3, "Image generation complete", pbar)

        return (image_tensor,)


# ============================================================
# 图生图节点
# ============================================================

class AgnesImageToImage:
    """
    Agnes Image 2.1 Flash 图生图节点

    基于输入图像进行转换、重绘和风格化编辑。
    """

    DESCRIPTION = "Edit an input image from a text instruction using the Agnes Image 2.1 Flash model"

    CATEGORY = "UIIIAIII Toolkit/Agnes"

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
                        "default": "",
                        "multiline": True,
                        "tooltip": "Text instruction for image editing",
                    },
                ),
                "image": (
                    "IMAGE",
                    {
                        "tooltip": "Input image (converted to a Base64 Data URI for the API)",
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
                        "tooltip": "Aspect ratio. 'auto' detects the input image ratio and keeps it consistent",
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
        image,
        seed: int = 0,
        size: str = "2K",
        ratio: str = "auto",
        unique_id: Optional[str] = None,
        prompt_id: Optional[str] = None,
    ):
        """执行图生图"""
        # 验证提示词
        if not prompt or not prompt.strip():
            raise RuntimeError("Prompt cannot be empty")

        pbar = _update_progress(unique_id, 0, 3, "Encoding input image...")

        # 将输入图像转换为 Data URI
        try:
            data_uri = agnes_client.image_tensor_to_data_uri(image)
        except Exception as e:
            raise RuntimeError(f"Input image encoding failed: {e}")

        # 自动检测输入图像比例，保持输出与原图比例一致
        if ratio == "auto":
            ratio = agnes_client.detect_image_ratio(image)

        pbar = _update_progress(unique_id, 1, 3, "Calling Agnes image API...", pbar)

        # 调用 API
        # 注意：Agnes Image API 不支持 seed 参数，seed 仅用于打破 ComfyUI 缓存，不发送给 API
        # 根据官方文档，图生图的 image 和 response_format 都必须放在 extra_body 中
        # API Key 自动从 ComfyUI 设置面板读取
        try:
            url_result, b64_result = agnes_client.generate_image(
                prompt=prompt.strip(),
                size=size,
                ratio=ratio,
                image_data_uris=[data_uri],
                return_base64=False,
                extra_params={"response_format": "url"},
                timeout=agnes_client.DEFAULT_TIMEOUT,
            )
        except Exception as e:
            raise RuntimeError(f"Agnes image API call failed: {e}")

        pbar = _update_progress(unique_id, 2, 3, "Downloading generated image...", pbar)

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

        _update_progress(unique_id, 3, 3, "Image generation complete", pbar)

        return (image_tensor,)


# ============================================================
# 文生视频节点
# ============================================================

class AgnesTextToVideo:
    """
    Agnes Video V2.0 文生视频节点

    根据文本提示词生成视频。视频生成采用异步任务 API。
    """

    DESCRIPTION = "Generate a video from a text prompt using the Agnes Video V2.0 model"

    CATEGORY = "UIIIAIII Toolkit/Agnes"

    # 根据是否支持 VIDEO 类型动态设置返回类型
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
                        "tooltip": "Text description of the video content",
                    },
                ),
                "ratio": (
                    ["16:9", "9:16", "1:1", "4:3", "3:4"],
                    {
                        "default": "16:9",
                        "tooltip": "Video aspect ratio",
                    },
                ),
                "resolution": (
                    ["480p", "720p", "1080p"],
                    {
                        "default": "720p",
                        "tooltip": "Video resolution preset",
                    },
                ),
                "duration": (
                    ["3s", "5s", "10s", "18s"],
                    {
                        "default": "5s",
                        "tooltip": "Video duration (based on num_frames and frame_rate)",
                    },
                ),
                "frame_rate": (
                    "INT",
                    {
                        "default": 24,
                        "min": 1,
                        "max": 60,
                        "tooltip": "Video frame rate (1-60)",
                    },
                ),
            },
            "optional": {
                "negative_prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "Negative prompt describing what to avoid",
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
                "num_inference_steps": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 200,
                        "tooltip": "Inference steps (0 uses the default value)",
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
        ratio: str = "16:9",
        resolution: str = "720p",
        duration: str = "5s",
        frame_rate: int = 24,
        negative_prompt: str = "",
        seed: int = 0,
        num_inference_steps: int = 0,
        poll_interval: int = 5,
        max_wait_time: int = 600,
        unique_id: Optional[str] = None,
        prompt_id: Optional[str] = None,
    ):
        """执行文生视频"""
        return _generate_video(
            prompt=prompt,
            image=None,
            ratio=ratio,
            resolution=resolution,
            duration=duration,
            frame_rate=frame_rate,
            negative_prompt=negative_prompt,
            seed=seed,
            num_inference_steps=num_inference_steps,
            poll_interval=poll_interval,
            max_wait_time=max_wait_time,
            unique_id=unique_id,
        )


# ============================================================
# 图生视频节点
# ============================================================

class AgnesImageToVideo:
    """
    Agnes Video V2.0 图生视频节点

    将静态图片转化为动态视频。
    """

    DESCRIPTION = "Turn an input image into an animated video using the Agnes Video V2.0 model"

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
                        "tooltip": "Text description of the video content (what should move)",
                    },
                ),
                "image": (
                    "IMAGE",
                    {
                        "tooltip": "Input image (uploaded to the Agnes API)",
                    },
                ),
                "ratio": (
                    ["16:9", "9:16", "1:1", "4:3", "3:4"],
                    {
                        "default": "16:9",
                        "tooltip": "Video aspect ratio",
                    },
                ),
                "resolution": (
                    ["480p", "720p", "1080p"],
                    {
                        "default": "720p",
                        "tooltip": "Video resolution preset",
                    },
                ),
                "duration": (
                    ["3s", "5s", "10s", "18s"],
                    {
                        "default": "5s",
                        "tooltip": "Video duration (based on num_frames and frame_rate)",
                    },
                ),
                "frame_rate": (
                    "INT",
                    {
                        "default": 24,
                        "min": 1,
                        "max": 60,
                        "tooltip": "Video frame rate (1-60)",
                    },
                ),
            },
            "optional": {
                "negative_prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "Negative prompt describing what to avoid",
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
                "num_inference_steps": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 200,
                        "tooltip": "Inference steps (0 uses the default value)",
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
        image,
        ratio: str = "16:9",
        resolution: str = "720p",
        duration: str = "5s",
        frame_rate: int = 24,
        negative_prompt: str = "",
        seed: int = 0,
        num_inference_steps: int = 0,
        poll_interval: int = 5,
        max_wait_time: int = 600,
        unique_id: Optional[str] = None,
        prompt_id: Optional[str] = None,
    ):
        """执行图生视频"""
        # 将输入图像转换为 Data URI
        image_url = _upload_image_to_temp_url(image, unique_id)

        return _generate_video(
            prompt=prompt,
            image=image_url,
            ratio=ratio,
            resolution=resolution,
            duration=duration,
            frame_rate=frame_rate,
            negative_prompt=negative_prompt,
            seed=seed,
            num_inference_steps=num_inference_steps,
            poll_interval=poll_interval,
            max_wait_time=max_wait_time,
            unique_id=unique_id,
        )


# ============================================================
# 关键帧动画节点
# ============================================================

class AgnesKeyframeAnimation:
    """
    Agnes Video V2.0 关键帧动画节点

    在多个关键帧之间生成流畅过渡视频。
    """

    DESCRIPTION = "Generate a smooth transition video between multiple keyframes using the Agnes Video V2.0 model"

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
                        "default": "Generate a smooth cinematic transition between the keyframes, maintaining visual consistency and natural camera movement",
                        "multiline": True,
                        "tooltip": "Describe the transition between keyframes",
                    },
                ),
                "image1": (
                    "IMAGE",
                    {"tooltip": "Keyframe 1 (start frame, required)"},
                ),
                "image2": (
                    "IMAGE",
                    {"tooltip": "Keyframe 2 (end frame, required)"},
                ),
                "ratio": (
                    ["16:9", "9:16", "1:1", "4:3", "3:4"],
                    {"default": "16:9", "tooltip": "Video aspect ratio"},
                ),
                "resolution": (
                    ["480p", "720p", "1080p"],
                    {"default": "720p", "tooltip": "Video resolution preset"},
                ),
                "duration": (
                    ["3s", "5s", "10s", "18s"],
                    {"default": "5s", "tooltip": "Video duration"},
                ),
                "frame_rate": (
                    "INT",
                    {"default": 24, "min": 1, "max": 60, "tooltip": "Video frame rate (1-60)"},
                ),
            },
            "optional": {
                "negative_prompt": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "Negative prompt describing what to avoid",
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
                "num_inference_steps": (
                    "INT",
                    {"default": 0, "min": 0, "max": 200, "tooltip": "Inference steps (0 uses the default value)"},
                ),
                "poll_interval": (
                    "INT",
                    {"default": 5, "min": 1, "max": 60, "tooltip": "Task polling interval (seconds)"},
                ),
                "max_wait_time": (
                    "INT",
                    {"default": 600, "min": 60, "max": 3600, "tooltip": "Maximum wait time (seconds)"},
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
        image1,
        image2,
        ratio: str = "16:9",
        resolution: str = "720p",
        duration: str = "5s",
        frame_rate: int = 24,
        negative_prompt: str = "",
        seed: int = 0,
        num_inference_steps: int = 0,
        poll_interval: int = 5,
        max_wait_time: int = 600,
        unique_id: Optional[str] = None,
        prompt_id: Optional[str] = None,
    ):
        """执行关键帧动画"""
        # 将关键帧图像转换为 Data URI 列表
        pbar = _update_progress(unique_id, 0, 4, "Encoding keyframe images...")

        keyframe_uris = []
        try:
            keyframe_uris.append(agnes_client.image_tensor_to_data_uri(image1))
            pbar = _update_progress(unique_id, 1, 4, "Keyframe 1/2 encoded", pbar)
            keyframe_uris.append(agnes_client.image_tensor_to_data_uri(image2))
            pbar = _update_progress(unique_id, 2, 4, "Keyframe 2/2 encoded", pbar)
        except Exception as e:
            raise RuntimeError(f"Keyframe image encoding failed: {e}")

        return _generate_video(
            prompt=prompt,
            image=None,
            keyframe_images=keyframe_uris,
            ratio=ratio,
            resolution=resolution,
            duration=duration,
            frame_rate=frame_rate,
            negative_prompt=negative_prompt,
            seed=seed,
            num_inference_steps=num_inference_steps,
            poll_interval=poll_interval,
            max_wait_time=max_wait_time,
            unique_id=unique_id,
        )


# ============================================================
# 视频生成辅助函数
# ============================================================

def _upload_image_to_temp_url(image_tensor, unique_id: Optional[str] = None) -> str:
    """
    将输入图像转换为 Data URI 以供 Agnes API 使用

    注意：Agnes Video V2.0 的图生视频需要图像的公共 URL。
    由于 ComfyUI 通常在本地运行，无法提供公共 URL，
    因此这里将图像转换为 Data URI 格式作为兜底方案。
    如果 API 不支持 Data URI，用户需要自行提供公共 URL。

    Args:
        image_tensor: ComfyUI IMAGE 张量
        unique_id: 节点 ID

    Returns:
        图像的 Data URI 字符串
    """
    _update_progress(unique_id, 0, 4, "Encoding input image...")

    try:
        data_uri = agnes_client.image_tensor_to_data_uri(image_tensor)
        return data_uri
    except Exception as e:
        raise RuntimeError(f"Input image encoding failed: {e}")


def _generate_video(
    prompt: str,
    image: Optional[str] = None,
    keyframe_images: Optional[List[str]] = None,
    ratio: str = "16:9",
    resolution: str = "720p",
    duration: str = "5s",
    frame_rate: int = 24,
    negative_prompt: str = "",
    seed: int = 0,
    num_inference_steps: int = 0,
    poll_interval: int = 5,
    max_wait_time: int = 600,
    unique_id: Optional[str] = None,
):
    """
    视频生成的通用实现（文生视频、图生视频、关键帧动画共用）

    API Key 自动从 ComfyUI 设置面板读取，无需传入。

    Args:
        prompt: 视频内容的文本描述
        image: 图生视频的输入图片（Data URI 或公共 URL），None 表示非图生视频
        keyframe_images: 关键帧动画的输入图片列表（Data URI 或公共 URL）
        ratio: 视频宽高比
        resolution: 视频分辨率档位
        duration: 视频时长预设
        frame_rate: 视频帧率
        negative_prompt: 反向提示词
        seed: 随机种子（0 表示不指定）
        num_inference_steps: 推理步数（0 表示使用默认值）
        poll_interval: 轮询间隔（秒）
        max_wait_time: 最大等待时间（秒）
        unique_id: 节点 ID

    Returns:
        视频输出（VIDEO 类型或文件路径字符串）
    """
    # 验证提示词
    if not prompt or not prompt.strip():
        raise RuntimeError("Prompt cannot be empty")

    # 获取视频分辨率
    width, height = agnes_client.get_video_resolution(ratio, resolution)

    # 获取时长预设
    duration_preset = agnes_client.VIDEO_DURATION_PRESETS.get(
        duration, agnes_client.VIDEO_DURATION_PRESETS["5s"]
    )
    num_frames = duration_preset["num_frames"]
    # 用户指定的 frame_rate 会覆盖预设的 frame_rate
    effective_frame_rate = frame_rate if frame_rate > 0 else duration_preset["frame_rate"]

    # 验证 num_frames
    if not agnes_client.validate_num_frames(num_frames):
        raise RuntimeError(
            f"num_frames={num_frames} does not satisfy the 8n+1 rule or exceeds the limit of 441"
        )

    # 准备可选参数
    opt_seed = seed if seed > 0 else None
    opt_steps = num_inference_steps if num_inference_steps > 0 else None
    opt_neg = negative_prompt.strip() if negative_prompt and negative_prompt.strip() else None

    # 判断生成模式
    if keyframe_images:
        mode_label = "Keyframe animation"
    elif image:
        mode_label = "Image-to-video"
    else:
        mode_label = "Text-to-video"

    pbar = _update_progress(unique_id, 0, 3, f"Creating Agnes video task ({mode_label})...")

    # 创建视频任务
    # 根据官方文档：
    # - 图生视频：image 放在顶层（字符串）
    # - 关键帧动画：image 放在 extra_body.image（数组），并设置 extra_body.mode = "keyframes"
    # API Key 自动从 ComfyUI 设置面板读取
    try:
        task_result = agnes_client.create_video_task(
            prompt=prompt.strip(),
            image=image,
            width=width,
            height=height,
            num_frames=num_frames,
            frame_rate=effective_frame_rate,
            num_inference_steps=opt_steps,
            seed=opt_seed,
            negative_prompt=opt_neg,
            keyframe_images=keyframe_images,
            timeout=agnes_client.DEFAULT_TIMEOUT,
        )
    except Exception as e:
        raise RuntimeError(f"Failed to create Agnes video task: {e}")

    # 提取 video_id
    video_id = task_result.get("video_id") or task_result.get("task_id")
    if not video_id:
        raise RuntimeError(f"No video_id found in task creation response: {task_result}")

    logger.info("视频任务已创建：video_id=%s", video_id)

    pbar = _update_progress(
        unique_id, 1, 3,
        f"Waiting for video generation to finish (video_id={video_id})...",
        pbar,
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
            # 使用 ComfyUI 的 VideoFromFile 包装视频
            video_output = InputImpl.VideoFromFile(video_buffer)
            return (video_output,)
        except Exception as e:
            logger.warning("VideoFromFile 包装失败，退化为文件路径模式：%s", e)
            # 退化处理：保存到文件并返回路径
            return _save_video_to_file(video_buffer, video_id)
    else:
        # 不支持 VIDEO 类型，保存到文件并返回路径
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

        # 收集所有非空的输入图像
        input_images = [img for img in [image1, image2, image3] if img is not None]

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

        # 收集所有非空的输入图像（全部为空 = 文生图）
        input_images = [img for img in [image1, image2, image3, image4] if img is not None]

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



class RandomNoiseSeed:
    """
    随机噪种子节点：功能与 ComfyUI 官方 RandomNoise 一致。

    通过 noise_seed 生成采样噪声。前端配合 JS 扩展提供
    「🎲 随机 / ♻️ 上次」按钮（同 Efficient 插件的效率采样随机控制）：

    - seed 为 -1 时表示"随机"：每次提交随机生成一个新种子；
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
                        "tooltip": "Noise seed (-1 means random; used together with the button)",
                    },
                ),
            },
        }

    RETURN_TYPES = ("NOISE",)
    RETURN_NAMES = ("noise",)
    FUNCTION = "get_noise"
    CATEGORY = "UIIIAIII Toolkit/Tools"

    def get_noise(self, noise_seed):
        # 与官方 Noise_RandomNoise 一致
        from comfy_extras.nodes_custom_sampler import Noise_RandomNoise
        return (Noise_RandomNoise(noise_seed),)


# ============================================================
# 节点注册
# ============================================================

# 节点类映射
NODE_CLASS_MAPPINGS = {
    "AgnesTextToImage": AgnesTextToImage,
    "AgnesImageToImage": AgnesImageToImage,
    "AgnesTextToVideo": AgnesTextToVideo,
    "AgnesImageToVideo": AgnesImageToVideo,
    "AgnesKeyframeAnimation": AgnesKeyframeAnimation,
    "QwenImageEdit": QwenImageEdit,
    "QwenImage21": QwenImage21,
    "TextPreview": TextPreview,
    "BackgroundFill": BackgroundFill,
    "RandomNoiseSeed": RandomNoiseSeed,
}

# 节点显示名称映射
NODE_DISPLAY_NAME_MAPPINGS = {
    "AgnesTextToImage": "Agnes Text to Image (agnes-image-2.1-flash)",
    "AgnesImageToImage": "Agnes Image to Image (agnes-image-2.1-flash)",
    "AgnesTextToVideo": "Agnes Text to Video (agnes-video-v2.0)",
    "AgnesImageToVideo": "Agnes Image to Video (agnes-video-v2.0)",
    "AgnesKeyframeAnimation": "Agnes Keyframe Animation (agnes-video-v2.0)",
    "QwenImageEdit": "Qwen Image Edit (qwen-image-edit-2511)",
    "QwenImage21": "Qwen Image 2.1 (qwen-image-2.1)",
    "TextPreview": "Text Input/Preview",
    "BackgroundFill": "Background Fill",
    "RandomNoiseSeed": "Random Noise Seed",
}
