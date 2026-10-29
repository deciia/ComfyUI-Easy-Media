from __future__ import annotations

import io as _io
import glob
import json
import logging
import os
import shutil
import subprocess
import tempfile
import time
import urllib.request
from fractions import Fraction
from typing import Optional

import folder_paths
import torch
from comfy_api.latest import Input, InputImpl, Types, io, ui
from comfy.utils import ProgressBar

from ..utils import log_stage_time, flatten_media_inputs, merge_two_audio, save_audio_to_temp_wav, split_list_outputs
from ..utils.video import extract_merge_spec, ffmpeg_concat, ffmpeg_concat_with_fade, ffmpeg_extract_audio, ffmpeg_replace_audio, ffmpeg_supports_xfade, ffprobe_info, normalize_video_images, tensor_crossfade_audio, tensor_crossfade_images, trim_video_with_ffmpeg, validate_merge_compatibility, video_input_to_local_file, get_ffmpeg_path

logger = logging.getLogger(__name__)

CATEGORY_VIDEO = "EasyUse/Video"
TYPE_COMPARE_VIDEO = io.Custom(io_type="EASY_COMPARE_VIDEO")

_OUTPUT_MODE_OPTIONS = ["save", "preview_only", "hide", "hide&save"]

# 用普通下拉 + 固定输入，避免 DynamicCombo 切换子输入导致
# 存档按位置还原时整体串位（重启后 input_mode/output_mode/filename_prefix 错位）。
_INPUT_MODE_OPTIONS = ["images+audio", "video"]

_NOTIFY_MUTE = "🔇 不播放提示音"
_NOTIFY_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "sounds")
_NOTIFY_EXTS = (".wav", ".mp3", ".m4a", ".ogg", ".flac")


def _list_notify_sounds() -> list[str]:
    """可选提示音：插件目录下 sounds/ 里的音频文件；没有就只剩静音项。"""
    items = [_NOTIFY_MUTE]
    try:
        if os.path.isdir(_NOTIFY_DIR):
            for name in sorted(os.listdir(_NOTIFY_DIR)):
                if os.path.splitext(name)[1].lower() in _NOTIFY_EXTS:
                    items.append(name)
    except Exception as exc:  # noqa: BLE001
        logger.warning("[EasySaveVideo] 读取提示音目录失败：%s", exc)
    return items


def _play_notify_sound(file_name: str):
    """后台线程播放提示音；非 Windows 或缺少文件时静默跳过。"""
    if not file_name or file_name == _NOTIFY_MUTE:
        return
    path = file_name if os.path.isabs(file_name) else os.path.join(_NOTIFY_DIR, os.path.basename(file_name))
    if not os.path.isfile(path):
        return

    def _run():
        try:
            import threading  # noqa: F401  (确保依赖）
            if os.name != "nt":
                return
            import ctypes
            # MCI 只认短路径；中文/长路径先转短路径，失败再退回 winsound
            buffer = ctypes.create_unicode_buffer(260)
            ctypes.windll.kernel32.GetShortPathNameW(path, buffer, 260)
            short_path = buffer.value or path
            alias = "easy_save_notify"
            mci = ctypes.windll.winmm.mciSendStringW
            mci(f"close {alias}", None, 0, 0)
            opened = mci(f'open "{short_path}" type mpegvideo alias {alias}', None, 0, 0)
            if opened:
                opened = mci(f'open "{short_path}" alias {alias}', None, 0, 0)
            if opened:
                import winsound
                winsound.PlaySound(path, winsound.SND_FILENAME)
                return
            mci(f"setaudio {alias} volume to 1000", None, 0, 0)
            mci(f"play {alias} wait", None, 0, 0)
            mci(f"close {alias}", None, 0, 0)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[EasySaveVideo] 提示音播放失败：%s", exc)

    import threading
    threading.Thread(target=_run, daemon=True).start()


# 输出格式（参考班长「🎥 视频合并」的格式清单）：第一个是默认值，保持原行为
_SAVE_KIND_OPTIONS = ["video", "images", "audio"]
_IMAGE_FORMAT_OPTIONS = ["PNG", "JPG", "WEBP"]
_AUDIO_FORMAT_OPTIONS = ["WAV", "MP3", "FLAC"]

_VIDEO_FORMAT_OPTIONS = [
    "跟随源 (AUTO)",
    "MP4 (H264)",
    "MP4 (H265)",
    "MOV (H264)",
    "MOV (ProRes)",
    "MKV (H264)",
    "WEBM (AV1)",
    "GIF",
    "WEBP",
]

# label -> (ext, container, codec)
_NATIVE_FORMATS = {
    "跟随源 (AUTO)": ("mp4", Types.VideoContainer.AUTO, Types.VideoCodec.AUTO),
    "MP4 (H264)": ("mp4", Types.VideoContainer.MP4, Types.VideoCodec.H264),
    "MKV (H264)": ("mkv", Types.VideoContainer.MKV, Types.VideoCodec.H264),
    "WEBM (AV1)": ("webm", Types.VideoContainer.WEBM, Types.VideoCodec.AV1),
}

# label -> (ext, ffmpeg 参数, 是否保留音频)
_FFMPEG_FORMATS = {
    "MP4 (H265)": ("mp4", ["-c:v", "libx265", "-crf", "20", "-pix_fmt", "yuv420p",
                           "-c:a", "aac", "-tag:v", "hvc1"], True),
    "MOV (H264)": ("mov", ["-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
                           "-c:a", "aac"], True),
    "MOV (ProRes)": ("mov", ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le",
                             "-c:a", "pcm_s16le"], True),
    "GIF": ("gif", ["-an", "-loop", "0"], False),
    "WEBP": ("webp", ["-an", "-loop", "0", "-q:v", "80"], False),
}


def _format_spec(label: str):
    """返回 (ext, container, codec, ffmpeg_args) —— ffmpeg_args 为 None 表示走原生保存。"""
    label = str(label or "").strip()
    if label in _NATIVE_FORMATS:
        ext, container, codec = _NATIVE_FORMATS[label]
        return ext, container, codec, None
    if label in _FFMPEG_FORMATS:
        ext, args, _keep_audio = _FFMPEG_FORMATS[label]
        return ext, Types.VideoContainer.AUTO, Types.VideoCodec.AUTO, list(args)
    return _NATIVE_FORMATS["跟随源 (AUTO)"][0], *_NATIVE_FORMATS["跟随源 (AUTO)"][1:], None


def _resolve_save_dir(custom_path: str, write_temp: bool):
    """自定义目录：绝对路径直接用；相对路径按 output（或 temp）目录解析。"""
    text = str(custom_path or "").strip()
    base = folder_paths.get_temp_directory() if write_temp else folder_paths.get_output_directory()
    if not text:
        return None
    target = text if os.path.isabs(text) else os.path.join(base, text)
    os.makedirs(target, exist_ok=True)
    return target


def _next_free_path(save_dir: str, filename_prefix: str, ext: str) -> tuple[str, str]:
    """在自定义目录里按 prefix_00001_.ext 递增取一个不冲突的文件名。"""
    # 自定义目录已决定位置，前缀里的目录部分不能再用（否则会写到不存在的子目录）
    safe = os.path.basename(str(filename_prefix or "ComfyUI").replace("\\", "/")).strip() or "ComfyUI"
    for counter in range(1, 100000):
        name = f"{safe}_{counter:05}_.{ext}"
        full = os.path.join(save_dir, name)
        if not os.path.exists(full):
            return name, full
    raise RuntimeError(f"无法在 {save_dir} 里分配文件名")


def _ffmpeg_transcode(src: str, dst: str, args: list[str], fps: float | None = None):
    """用 ffmpeg 把 src 转成 dst（容器/编码由 args 决定）。失败抛 RuntimeError。"""
    ffmpeg = get_ffmpeg_path("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError("需要 FFmpeg 才能输出该格式（未找到 ffmpeg 可执行文件）")
    command = [ffmpeg, "-y", "-nostdin", "-v", "error", "-i", src]
    if fps and dst.lower().endswith((".gif", ".webp")):
        command += ["-vf", f"fps={max(1.0, float(fps)):.3f},scale=iw:-1:flags=lanczos"]
    command += args + [dst]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg 转码失败：{(result.stderr or '').strip()[:300]}")


def _cleanup_gpu(tag: str = "Save Video"):
    """出片后卸载模型 + 清显存；任何异常只记录，不覆盖原始结果。"""
    try:
        import comfy.model_management as mm
        mm.unload_all_models()
        mm.soft_empty_cache()
    except Exception as exc:  # noqa: BLE001
        logger.warning("[EasySaveVideo] %s 显存清理失败：%s", tag, exc)



class MakeVideoList(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="easy makeVideoList",
            display_name="Make Video List",
            category=CATEGORY_VIDEO,
            description="Combine up to 10 optional video inputs into a video list.",
            inputs=[
                io.Boolean.Input("skip_empty", default=True, label_on="Skip", label_off="Fill"),
                io.Video.Input("video1", optional=True),
                io.Video.Input("video2", optional=True),
                io.Video.Input("video3", optional=True),
                io.Video.Input("video4", optional=True),
                io.Video.Input("video5", optional=True),
                io.Video.Input("video6", optional=True),
                io.Video.Input("video7", optional=True),
                io.Video.Input("video8", optional=True),
                io.Video.Input("video9", optional=True),
                io.Video.Input("video10", optional=True),
            ],
            outputs=[
                io.Video.Output("VIDEO", is_output_list=True),
            ],
        )

    @classmethod
    def execute(cls, skip_empty: bool, **kwargs: object) -> io.NodeOutput:
        videos: list[Input.Video] = []
        for i in range(1, 11):
            key = f"video{i}"
            value = kwargs.get(key)
            if value is not None:
                videos.append(value)
            elif not skip_empty:
                videos.append(_empty_video())

        return io.NodeOutput(videos)


class SplitVideos(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="easy splitVideos",
            display_name="Split Videos",
            category=CATEGORY_VIDEO,
            description="Split a video list into 10 single-video outputs.",
            is_input_list=True,
            inputs=[
                io.Video.Input("videos"),
            ],
            outputs=[
                io.Video.Output(f"VIDEO{i}") for i in range(0, 10)
            ],
        )

    @classmethod
    def execute(cls, videos: list[Input.Video]) -> io.NodeOutput:
        if not videos:
            raise ValueError("videos must contain at least one video.")
        if any(video is None for video in videos):
            raise TypeError("videos must contain only video values.")

        return io.NodeOutput(*split_list_outputs(videos))


def _empty_video() -> InputImpl.VideoFromComponents:  # type: ignore[return-value]
    images = torch.zeros(1, 2, 2, 3, dtype=torch.float32, device="cpu")
    return InputImpl.VideoFromComponents(
        Types.VideoComponents(
            images=images,
            audio=None,
            frame_rate=Fraction(24),
        )
    )


def _audio_duration_seconds(audio) -> float:
    """AUDIO（{"waveform": Tensor[B, C, T], "sample_rate": int}）的时长秒数；取不到返回 0。"""
    try:
        if not isinstance(audio, dict):
            return 0.0
        waveform = audio.get("waveform")
        rate = float(audio.get("sample_rate") or 0.0)
        if waveform is None or rate <= 0.0:
            return 0.0
        samples = int(waveform.shape[-1])
        return max(0.0, samples / rate)
    except Exception:  # noqa: BLE001
        return 0.0


def _frames_for_audio(audio, fps: float) -> int:
    """按音频时长换算需要铺满的帧数（至少 1 帧）。"""
    duration = _audio_duration_seconds(audio)
    if duration <= 0.0:
        return 1
    return max(1, int(round(duration * max(1.0, float(fps or 24.0)))))


def _is_image_batch(value) -> bool:
    """判断是否是 IMAGE 批次（torch Tensor，形如 [B, H, W, C]）。"""
    shape = getattr(value, "shape", None)
    return bool(shape is not None and len(shape) == 4 and hasattr(value, "repeat"))


def _is_audio_dict(value) -> bool:
    """判断是否是 ComfyUI 的 AUDIO（含 waveform / sample_rate 的 dict）。"""
    return isinstance(value, dict) and "waveform" in value


def _is_video_object(value) -> bool:
    """判断是否是 ComfyUI 的 VIDEO（带 get_components）。"""
    return hasattr(value, "get_components")


class EasySaveVideo(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="easy saveVideo",
            display_name="Save Video",
            category=CATEGORY_VIDEO,
            description=(
                "Save images and optional audio to a video file. "
                "Returns VIDEO + written file path, and passes IMAGES / AUDIO through for downstream nodes. "
                "可选输出格式（MP4/MKV/WEBM/MOV/ProRes/H265/GIF/WEBP）、自定义保存目录、采用成品流复制、"
                "出片后清理显存、出片提示音。"
            ),
            inputs=[
                io.Combo.Input(
                    "input_mode",
                    options=list(_INPUT_MODE_OPTIONS),
                    default="images+audio",
                    tooltip=(
                        "images+audio：把 IMAGES（可带 AUDIO）按 fps 编码成视频。"
                        "video：直接保存 VIDEO（接了 AUDIO 则替换其音轨）。"
                    ),
                ),
                io.Image.Input(
                    "images",
                    optional=True,
                    tooltip="images+audio 模式使用：待编码的图像序列。",
                ),
                io.Float.Input(
                    "fps",
                    default=24.0,
                    min=1.0,
                    max=120.0,
                    step=1.0,
                    tooltip="images+audio 模式的帧率；video 模式忽略。",
                ),
                io.AnyType.Input(
                    "video",
                    optional=True,
                    tooltip=(
                        "直接保存/透传的媒体。兼容三种类型并自动判断："
                        "VIDEO=按视频保存；IMAGE=当作图像序列（单帧可配音频成片）；AUDIO=并到音轨。"
                    ),
                ),
                io.Audio.Input(
                    "audio",
                    optional=True,
                    tooltip="可选音轨：images+audio 模式作为视频音轨；video 模式替换原音轨。",
                ),
                io.Combo.Input(
                    "output_mode",
                    options=list(_OUTPUT_MODE_OPTIONS),
                    default="save",
                    tooltip=(
                        "save：写入 output；preview_only：只写 temp 并预览；"
                        "hide：只写 temp 不预览；hide&save：写 output 不预览。"
                    ),
                ),
                io.Boolean.Input(
                    "save_metadata",
                    default=False,
                    tooltip="Write ComfyUI prompt/workflow metadata into the saved file.",
                ),
                io.String.Input("filename_prefix", default="ComfyUI"),
                # —— 以下为追加输入（位置必须在末尾，避免旧存档按位置回填时错位）——
                io.Combo.Input(
                    "video_format",
                    options=list(_VIDEO_FORMAT_OPTIONS),
                    default="跟随源 (AUTO)",
                    tooltip=(
                        "输出容器/编码。AUTO/MP4(H264)/MKV/WEBM 走原生保存；"
                        "MP4(H265)/MOV(H264)/MOV(ProRes)/GIF/WEBP 走 FFmpeg 转码。"
                    ),
                ),
                io.String.Input(
                    "custom_save_path",
                    default="",
                    tooltip=(
                        "自定义保存目录（仅 save / hide&save 生效）。绝对路径直接用，"
                        "相对路径按 output 目录解析；留空保持原行为。"
                    ),
                ),
                io.Boolean.Input(
                    "adopt_source_video",
                    default=False,
                    tooltip=(
                        "video 模式：目标容器与源一致、未替换音轨、未写元数据时，"
                        "直接复制文件（流复制，不重新编码）。"
                    ),
                ),
                io.Boolean.Input(
                    "cleanup_after_save",
                    default=False,
                    tooltip="出片后卸载模型并清理显存（出错也会清理）。",
                ),
                io.Combo.Input(
                    "save_kind",
                    options=list(_SAVE_KIND_OPTIONS),
                    default="video",
                    tooltip="输出形态：video=视频；images=图像序列；audio=音频文件。",
                ),
                io.Combo.Input(
                    "image_format",
                    options=list(_IMAGE_FORMAT_OPTIONS),
                    default="PNG",
                    tooltip="save_kind=images 时的图片格式。",
                ),
                io.Combo.Input(
                    "audio_format",
                    options=list(_AUDIO_FORMAT_OPTIONS),
                    default="WAV",
                    tooltip="save_kind=audio 时的音频格式。",
                ),
                io.Combo.Input(
                    "notify_sound",
                    options=_list_notify_sounds(),
                    default=_NOTIFY_MUTE,
                    tooltip=(
                        "出片完成后播放的提示音。把音频放进插件的 sounds/ 目录即可出现在这里；"
                        "默认静音。"
                    ),
                ),
            ],
            hidden=[io.Hidden.prompt, io.Hidden.extra_pnginfo],
            is_output_node=True,
            outputs=[
                io.Video.Output(display_name="VIDEO"),
                io.String.Output(display_name="file_path"),
                # —— 追加透传输出（位置在末尾，旧的 VIDEO/file_path 索引不变）——
                io.Image.Output(display_name="images_out", is_output_list=False),
                io.Audio.Output(display_name="audio_out"),
            ],
        )

    @classmethod
    def execute(
        cls,
        input_mode: str = "images+audio",
        fps: float = 24.0,
        output_mode: str = "save",
        filename_prefix: str = "ComfyUI",
        images=None,
        video=None,
        audio=None,
        save_metadata: bool = False,
        video_format: str = "跟随源 (AUTO)",
        custom_save_path: str = "",
        adopt_source_video: bool = False,
        cleanup_after_save: bool = False,
        notify_sound: str = _NOTIFY_MUTE,
        save_kind: str = "video",
        image_format: str = "PNG",
        audio_format: str = "WAV",
    ) -> io.NodeOutput:
        # 旧存档 / 旧 API 负载兼容：动态输入时代这些值会被装成 dict 传进来。
        if isinstance(input_mode, dict):
            payload = input_mode
            input_mode = str(payload.get("input_mode") or "images+audio")
            if images is None:
                images = payload.get("images")
            if video is None:
                video = payload.get("video")
            if audio is None:
                audio = payload.get("audio")
            if payload.get("fps") is not None:
                fps = payload["fps"]
        if isinstance(output_mode, dict):
            payload_out = output_mode
            output_mode = str(payload_out.get("output_mode") or "save")
            save_metadata = bool(payload_out.get("save_metadata", save_metadata))

        # video 槽是 AnyType：按实际接入的类型自动分流，用户不需要手动改 input_mode。
        incoming = video
        video = None
        if incoming is not None:
            if _is_audio_dict(incoming):
                if audio is None:
                    audio = incoming
            elif _is_image_batch(incoming):
                # IMAGE 批次：并入 images 通道（单帧 + 音频会在下面自动铺满成片）
                images = incoming
            elif _is_video_object(incoming):
                video = incoming
            else:
                raise ValueError(
                    "video 输入槽只接受 VIDEO / IMAGE / AUDIO；当前类型无法识别。"
                )

        input_mode_key: str = str(input_mode or "images+audio")
        if input_mode_key == "video" and video is None:
            # video 槽其实接的是图片/音频：自动退回对应通道
            input_mode_key = "images+audio" if images is not None else "audio"
        output_mode_key: str = str(output_mode or "save")
        hide_preview = output_mode_key in {"hide", "hide&save"}
        write_temp = output_mode_key in {"preview_only", "hide"}

        pass_images = None
        kind = str(save_kind or "video").strip().lower()
        if input_mode_key == "video":
            source_video = video
            if source_video is None:
                raise ValueError(
                    "A VIDEO input is required when input_mode is 'video': "
                    "接上 video 端口，或把 input_mode 改回 'images+audio'。"
                )
            if audio is not None:
                source_video = _replace_video_audio(source_video, audio)
        elif input_mode_key == "audio":
            # 只有音频（本次检查新增）：仅允许导出音频文件
            if audio is None:
                raise ValueError("没有可保存的输入：接上 images / video / audio 任意一个。")
            if kind != "audio":
                raise ValueError(
                    "只有音频输入时只能保存音频：把保存类型切成 🎵 音频，或接上图像/视频。"
                )
            source_video = None
        else:
            if images is None:
                raise ValueError(
                    "An IMAGES input is required when input_mode is 'images+audio': "
                    "接上 images 端口，或把 input_mode 改成 'video'。"
                )
            normalized, changed = normalize_video_images(images)
            # 单张图 + 音频 → 以该图作背景铺满音频时长，生成等长视频（原先只出 1 帧极短视频）
            try:
                frame_total = int(getattr(normalized, "shape", [0])[0] or 0)
            except Exception:  # noqa: BLE001
                frame_total = 0
            if frame_total == 1 and audio is not None and kind == "video":
                repeat_times = _frames_for_audio(audio, fps)
                if repeat_times > 1:
                    normalized = normalized.repeat(repeat_times, 1, 1, 1)
                    logger.info(
                        "[EasySaveVideo] 单张图 + 音频：静帧已铺满 %s 帧（约 %.1f 秒 @ %.1f fps）",
                        repeat_times,
                        repeat_times / max(1.0, float(fps or 24.0)),
                        float(fps or 24.0),
                    )
            elif frame_total == 1 and audio is None and kind == "video":
                # 单张图且无音频：成片只有 1 帧没有意义 → 引导存图片（多帧图像流可存无声视频）
                raise ValueError(
                    "只接了单张图且没有音频，无法生成有意义的视频："
                    "请把保存类型切成 🖼️ 保存图片；"
                    "接上 AUDIO 可生成「图片背景 + 音频」的等长视频；"
                    "多帧图像流（streaming）可直接保存无声视频。"
                )
            pass_images = normalized
            if changed:
                logger.info(
                    "[EasySaveVideo] Image dimensions were cropped to even size for video encoding."
                )
            source_video = InputImpl.VideoFromComponents(
                Types.VideoComponents(
                    images=normalized,
                    audio=audio,
                    frame_rate=Fraction(fps),
                )
            )

        try:
            if kind in {"images", "audio"}:
                relative_path, file, subfolder, folder_type, video_info = _save_media_output(
                    source_video=source_video,
                    write_temp=write_temp,
                    filename_prefix=filename_prefix,
                    save_metadata=bool(save_metadata),
                    kind=kind,
                    image_format=image_format,
                    audio_format=audio_format,
                    audio=audio,
                    frame_rate=float(fps or 24.0),
                    prompt=cls.hidden.prompt,
                    extra_pnginfo=cls.hidden.extra_pnginfo,
                )
            else:
                relative_path, file, subfolder, folder_type, video_info = _save_video_output(
                    source_video=source_video,
                    write_temp=write_temp,
                    filename_prefix=filename_prefix,
                    save_metadata=bool(save_metadata),
                    video_format=video_format,
                    custom_save_path=custom_save_path,
                    adopt_source_video=bool(adopt_source_video),
                    audio_replaced=bool(audio is not None and input_mode_key == "video"),
                    fps=float(fps or 24.0),
                    prompt=cls.hidden.prompt,
                    extra_pnginfo=cls.hidden.extra_pnginfo,
            )
        finally:
            if cleanup_after_save:
                _cleanup_gpu()

        # 透传：图像默认给本次编码用的画面；video 模式下按需从组件里取
        if pass_images is None:
            try:
                pass_images = source_video.get_components().images
            except Exception:
                pass_images = None
        pass_audio = audio
        if pass_audio is None:
            try:
                pass_audio = source_video.get_components().audio
            except Exception:
                pass_audio = None

        if notify_sound and notify_sound != _NOTIFY_MUTE:
            _play_notify_sound(notify_sound)

        # 面板自带播放器：不再返回 ui.PreviewVideo，避免 ComfyUI 在节点上再插一个原生播放器
        # （否则会出现「面板播放器 + 原生播放器」两个，历史上反复被反馈）。
        custom_ui = {"easy_video_info": [video_info]}

        if hide_preview:
            return io.NodeOutput(source_video, relative_path, pass_images, pass_audio, ui={"easy_video_info": [video_info]})

        return io.NodeOutput(
            source_video,
            relative_path,
            pass_images,
            pass_audio,
            ui=custom_ui,
        )

def _save_media_output(
    *,
    source_video,
    write_temp: bool,
    filename_prefix: str,
    save_metadata: bool,
    kind: str,
    image_format: str,
    audio_format: str,
    audio,
    frame_rate: float,
    prompt,
    extra_pnginfo,
):
    """save_kind=images / audio 的落盘，返回与 _save_video_output 同形状的元组。"""
    from PIL import Image
    import numpy as np

    output_dir = folder_paths.get_temp_directory() if write_temp else folder_paths.get_output_directory()
    folder_type = io.FolderType.temp if write_temp else io.FolderType.output
    prefix = "temp" if write_temp else "output"
    metadata = None
    if save_metadata:
        metadata = {}
        if extra_pnginfo is not None:
            metadata.update(extra_pnginfo)
        if prompt is not None:
            metadata["prompt"] = prompt
        if not metadata:
            metadata = None

    if kind == "images":
        fmt = str(image_format or "PNG").upper()
        ext = {"PNG": "png", "JPG": "jpg", "WEBP": "webp"}.get(fmt, "png")
        images = source_video.get_components().images
        height, width = int(images.shape[1]), int(images.shape[2])
        full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, output_dir, width, height
        )
        saved: list[str] = []
        total_bytes = 0
        for i in range(int(images.shape[0])):
            name = f"{filename}_{counter:05}_{i:04}_.{ext}"
            path = os.path.join(full_output_folder, name)
            frame = (images[i].detach().cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)
            img = Image.fromarray(frame)
            save_kwargs = {}
            if fmt == "PNG":
                save_kwargs["compress_level"] = 4
            else:
                save_kwargs["quality"] = 92
            img.save(path, **save_kwargs)
            saved.append(name)
            total_bytes += os.path.getsize(path)
        rel = f"{prefix}/{os.path.relpath(os.path.join(full_output_folder, saved[0]), output_dir).replace(chr(92), '/')}"
        info = {
            "kind": "images",
            "filename": saved[0] if len(saved) == 1 else f"{saved[0]} … {saved[-1]}",
            "first_filename": saved[0],
            "last_filename": saved[-1],
            "subfolder": subfolder or "",
            "type": "temp" if write_temp else "output",
            "path": os.path.join(full_output_folder, saved[0]),
            "dir": full_output_folder,
            "count": len(saved),
            "size_bytes": total_bytes,
            "width": width,
            "height": height,
            "format": ext,
            "image_format": fmt,
        }
        return rel, saved[0], subfolder, folder_type, info

    # ---- audio ----
    fmt = str(audio_format or "WAV").upper()
    ext = {"WAV": "wav", "MP3": "mp3", "FLAC": "flac"}.get(fmt, "wav")
    source_audio = audio
    temp_files: list[str] = []
    try:
        if source_audio is None:
            src_path, temp_files = video_input_to_local_file(source_video)
            source_audio = ffmpeg_extract_audio(src_path)
        if source_audio is None:
            raise ValueError("没有可导出的音频：接上 AUDIO 输入，或让视频带音轨")
        wav_path = save_audio_to_temp_wav(source_audio)
        if wav_path is None:
            raise ValueError("音频序列化失败")
        temp_files.append(str(wav_path))
        full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, output_dir, 1, 1
        )
        name = f"{filename}_{counter:05}_.{ext}"
        out_path = os.path.join(full_output_folder, name)
        if ext == "wav":
            shutil.copy2(wav_path, out_path)
        else:
            ffmpeg = get_ffmpeg_path("ffmpeg")
            if ffmpeg is None:
                raise RuntimeError("导出 MP3/FLAC 需要 FFmpeg")
            args = ["-c:a", "libmp3lame", "-b:a", "192k"] if ext == "mp3" else ["-c:a", "flac"]
            command = [ffmpeg, "-y", "-nostdin", "-v", "error", "-i", str(wav_path), *args, out_path]
            result = subprocess.run(command, capture_output=True, text=True)
            if result.returncode != 0:
                raise RuntimeError(f"FFmpeg 转音频失败：{(result.stderr or '').strip()[:200]}")
        probe = ffprobe_info(out_path) or {}
        info = {
            "kind": "audio",
            "filename": name,
            "subfolder": subfolder or "",
            "type": "temp" if write_temp else "output",
            "path": out_path,
            "size_bytes": os.path.getsize(out_path),
            "duration": probe.get("duration"),
            "format": ext,
            "audio_format": fmt,
        }
        rel = f"{prefix}/{os.path.relpath(out_path, output_dir).replace(chr(92), '/')}"
        return rel, name, subfolder, folder_type, info
    finally:
        for path in temp_files:
            try:
                os.unlink(path)
            except OSError:
                pass


def _save_video_output(
    *,
    source_video,
    write_temp: bool,
    filename_prefix: str,
    save_metadata: bool,
    video_format: str,
    custom_save_path: str,
    adopt_source_video: bool,
    audio_replaced: bool,
    fps: float,
    prompt,
    extra_pnginfo,
):
    """按 video_format 落盘，返回 (relative_path, file, subfolder, folder_type)。

    - 原生容器（AUTO/MP4/MKV/WEBM）：走 source_video.save_to；
    - 其它容器（H265/MOV/ProRes/GIF/WEBP）：先写原生临时文件，再用 FFmpeg 转码；
    - adopt_source_video：同容器且无需改音轨/元数据时直接复制，不重新编码。
    """
    width, height = source_video.get_dimensions()
    ext, container, codec, ff_args = _format_spec(video_format)

    if write_temp:
        output_dir = folder_paths.get_temp_directory()
        folder_type = io.FolderType.temp
    else:
        output_dir = folder_paths.get_output_directory()
        folder_type = io.FolderType.output

    custom_dir = None if write_temp else _resolve_save_dir(custom_save_path, write_temp)

    if custom_dir:
        file, full_path = _next_free_path(custom_dir, filename_prefix, ext)
        try:
            subfolder = os.path.relpath(custom_dir, output_dir).replace("\\", "/")
            if subfolder.startswith(".."):
                subfolder = ""
        except Exception:
            subfolder = ""
    else:
        full_output_folder, filename, counter, subfolder, filename_prefix = (
            folder_paths.get_save_image_path(filename_prefix, output_dir, width, height)
        )
        file = f"{filename}_{counter:05}_.{ext}"
        full_path = os.path.join(full_output_folder, file)

    prefix = "temp" if write_temp else "output"
    relative_output_path = os.path.relpath(full_path, output_dir).replace("\\", "/")
    relative_path = f"{prefix}/{relative_output_path}"

    metadata: dict | None = None
    if save_metadata:
        metadata = {}
        if extra_pnginfo is not None:
            metadata.update(extra_pnginfo)
        if prompt is not None:
            metadata["prompt"] = prompt
        if not metadata:
            metadata = None

    _started = time.perf_counter()
    with log_stage_time("Save Video", f"{relative_path} / save_video"):
        adopted = False
        if adopt_source_video and ff_args is None and metadata is None and not audio_replaced:
            temp_files: list[str] = []
            try:
                src_path, temp_files = video_input_to_local_file(
                    source_video,
                    suffix=f".{ext}",
                    save_kwargs={"format": container, "codec": codec},
                )
                src_ext = os.path.splitext(src_path)[1].lstrip(".").lower()
                if src_ext == ext:
                    shutil.copy2(src_path, full_path)
                    adopted = True
                    logger.info("[EasySaveVideo] 采用成品视频（流复制）：%s", relative_path)
            except Exception as exc:  # noqa: BLE001
                logger.warning("[EasySaveVideo] 采用成品失败，回退到重新编码：%s", exc)
            finally:
                for path in temp_files:
                    try:
                        os.unlink(path)
                    except OSError:
                        pass

        if not adopted:
            if ff_args is None:
                source_video.save_to(full_path, format=container, codec=codec, metadata=metadata)
            else:
                tmp_dir = folder_paths.get_temp_directory()
                fd, tmp_src = tempfile.mkstemp(suffix=".mp4", dir=tmp_dir)
                os.close(fd)
                try:
                    source_video.save_to(
                        tmp_src,
                        format=Types.VideoContainer.MP4,
                        codec=Types.VideoCodec.H264,
                        metadata=metadata,
                    )
                    _ffmpeg_transcode(tmp_src, full_path, ff_args, fps=fps)
                finally:
                    try:
                        os.unlink(tmp_src)
                    except OSError:
                        pass

    info = {
        "filename": file,
        "subfolder": subfolder or "",
        "type": "temp" if write_temp else "output",
        "path": full_path,
        "size_bytes": os.path.getsize(full_path) if os.path.isfile(full_path) else 0,
        "width": int(width),
        "height": int(height),
        "format": os.path.splitext(file)[1].lstrip(".").lower(),
        "video_format": str(video_format or ""),
        "save_seconds": round(time.perf_counter() - _started, 2),
    }
    try:
        probe = ffprobe_info(full_path) or {}
        if probe.get("width"):
            info["width"] = int(probe["width"])
        if probe.get("height"):
            info["height"] = int(probe["height"])
        if probe.get("fps"):
            info["fps"] = round(float(probe["fps"]), 3)
        if probe.get("frame_count"):
            info["frames"] = int(probe["frame_count"])
        if probe.get("duration"):
            info["duration"] = round(float(probe["duration"]), 3)
        if probe.get("has_audio"):
            info["has_audio"] = True
    except Exception as exc:  # noqa: BLE001
        logger.info("[EasySaveVideo] 读取视频详情失败（不影响出片）：%s", exc)

    return relative_path, file, subfolder, folder_type, info


def _save_audio_to_temp_wav(audio: dict) -> str | None:
    """Backward-compatible wrapper for the shared AUDIO serializer."""
    path = save_audio_to_temp_wav(audio)
    return str(path) if path is not None else None


def _replace_video_audio(source_video, audio: dict):
    """Replace the audio track of *source_video* with *audio*.

    Fast path: save video to temp file, write audio to temp WAV, mux with
    FFmpeg (stream-copy video, no re-encode).  Falls back to the tensor-based
    approach when FFmpeg is unavailable or the mux fails.
    """
    # --- Fast path: FFmpeg mux (stream copy for video) ---
    ext = Types.VideoContainer.get_extension(Types.VideoContainer.AUTO)
    tmp_fd_v, tmp_video_path = tempfile.mkstemp(suffix=f".{ext}", dir=folder_paths.get_temp_directory())
    os.close(tmp_fd_v)
    tmp_fd_o, tmp_out_path = tempfile.mkstemp(suffix=f".{ext}", dir=folder_paths.get_temp_directory())
    os.close(tmp_fd_o)
    tmp_audio_path: str | None = None
    try:
        source_video.save_to(tmp_video_path, format=Types.VideoContainer.AUTO, codec=Types.VideoCodec.AUTO)
        tmp_audio_path = _save_audio_to_temp_wav(audio)
        if tmp_audio_path is not None:
            try:
                success = ffmpeg_replace_audio(tmp_video_path, tmp_audio_path, tmp_out_path)
                if success:
                    return InputImpl.VideoFromFile(tmp_out_path)
            except RuntimeError as exc:
                logger.warning(
                    "[EasySaveVideo] FFmpeg audio replace failed: %s — falling back to tensor merge.", exc
                )
    except Exception as exc:
        logger.warning(
            "[EasySaveVideo] FFmpeg fast path error: %s — falling back to tensor merge.", exc
        )
    finally:
        for p in (tmp_video_path, tmp_audio_path):
            if p:
                try:
                    os.unlink(p)
                except OSError:
                    pass
        # tmp_out_path is kept on success (VideoFromFile holds a ref); clean up only on failure
        # (it lives in temp dir and will be cleaned up by ComfyUI)

    # --- Slow fallback: tensor-based ---
    spec = extract_merge_spec(source_video)
    components = source_video.get_components()
    return InputImpl.VideoFromComponents(
        Types.VideoComponents(
            images=components.images,
            audio=audio,
            frame_rate=spec.fps,
        )
    )


def _replace_video_audio_with_ffmpeg(source_video: Input.Video, audio: dict, tag: str) -> Input.Video:
    """Mux ``audio`` onto ``source_video`` without copying file-backed VIDEO inputs first."""
    ext = Types.VideoContainer.get_extension(Types.VideoContainer.AUTO)
    video_path: str | None = None
    video_temp_files: list[str] = []
    audio_path: str | None = None
    output_path: str | None = None
    completed = False
    try:
        video_path, video_temp_files = video_input_to_local_file(
            source_video,
            suffix=f".{ext}",
            save_kwargs={
                "format": Types.VideoContainer.AUTO,
                "codec": Types.VideoCodec.AUTO,
            },
        )
        audio_path = _save_audio_to_temp_wav(audio)
        if audio_path is None:
            raise ValueError(f"{tag} could not serialize the AUDIO input.")

        output_ext = os.path.splitext(video_path)[1] or f".{ext}"
        output_fd, output_path = tempfile.mkstemp(
            suffix=output_ext,
            dir=folder_paths.get_temp_directory(),
        )
        os.close(output_fd)
        if not ffmpeg_replace_audio(video_path, audio_path, output_path):
            raise RuntimeError(f"{tag} requires FFmpeg to attach the AUDIO input.")
        completed = True
        return InputImpl.VideoFromFile(output_path)
    except (ValueError, RuntimeError):
        raise
    except Exception as exc:
        raise RuntimeError(f"{tag} failed to attach the AUDIO input with FFmpeg.") from exc
    finally:
        for path in [*video_temp_files, audio_path]:
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass
        if output_path and not completed:
            try:
                os.unlink(output_path)
            except OSError:
                pass


def _attach_video_audio_with_ffmpeg(
    source_video: Input.Video,
    audio: dict,
    audio_mode: str,
    tag: str,
) -> Input.Video:
    """Merge or override the source audio track with the supplied AUDIO input."""
    if audio_mode not in {"merge", "override"}:
        raise ValueError(f"{tag} unsupported audio mode: {audio_mode!r}.")

    output_audio = audio
    if audio_mode == "merge":
        original_audio = _extract_audio_with_ffmpeg(source_video)
        output_audio = merge_two_audio(original_audio, audio, "add")
        if output_audio is None:
            raise ValueError(f"{tag} could not prepare audio for merging.")

    return _replace_video_audio_with_ffmpeg(source_video, output_audio, tag)


def _video_to_local_file(video: Input.Video) -> "tuple[str | None, list[str]]":
    """Return a local file path for ffmpeg, creating temp files when needed."""
    temp_files: list[str] = []
    try:
        source = video.get_stream_source()
    except (AttributeError, RuntimeError, ValueError, TypeError):
        source = None

    if isinstance(source, str) and os.path.isfile(source):
        return source, temp_files
    if isinstance(source, _io.BytesIO):
        source.seek(0)
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".mp4", dir=folder_paths.get_temp_directory())
        try:
            os.write(tmp_fd, source.read())
        finally:
            os.close(tmp_fd)
        temp_files.append(tmp_path)
        return tmp_path, temp_files

    ext = Types.VideoContainer.get_extension(Types.VideoContainer.AUTO)
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=f".{ext}", dir=folder_paths.get_temp_directory())
    os.close(tmp_fd)
    try:
        video.save_to(tmp_path, format=Types.VideoContainer.AUTO, codec=Types.VideoCodec.AUTO)
    except Exception as exc:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        logger.warning("[EasyGetAudioFromVideo] Failed to serialize VIDEO for FFmpeg: %s", exc)
        return None, temp_files
    temp_files.append(tmp_path)
    return tmp_path, temp_files


def _extract_audio_with_ffmpeg(video: Input.Video) -> "dict | None":
    source_path, temp_files = _video_to_local_file(video)
    if source_path is None:
        return None

    try:
        return ffmpeg_extract_audio(source_path)
    finally:
        for path in temp_files:
            try:
                os.unlink(path)
            except OSError:
                pass


def _fallback_video_audio(video: Input.Video) -> "dict | None":
    try:
        components = video.get_components()
    except Exception as exc:
        raise RuntimeError("Failed to read VIDEO components for audio fallback.") from exc
    audio = getattr(components, "audio", None)
    if isinstance(audio, dict) and audio.get("waveform") is not None and audio.get("sample_rate") is not None:
        return audio
    return None


class EasyGetAudioFromVideo(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="easy getAudioFromVideo",
            display_name="Get Audio From Video",
            category=CATEGORY_VIDEO,
            description="Extract the audio track from a VIDEO. Uses FFmpeg first, then falls back to ComfyUI VIDEO components.",
            inputs=[
                io.Video.Input("video"),
            ],
            outputs=[
                io.Audio.Output("AUDIO"),
            ],
        )

    @classmethod
    def execute(cls, video: Input.Video) -> io.NodeOutput:
        audio = _extract_audio_with_ffmpeg(video)
        if audio is None:
            audio = _fallback_video_audio(video)
        if audio is None:
            raise ValueError("The input VIDEO does not contain an audio track.")
        return io.NodeOutput(audio)


def _compare_video_preview_from_path(path: str, label: str) -> dict:
    ext = os.path.splitext(path)[1] or f".{Types.VideoContainer.get_extension(Types.VideoContainer.AUTO)}"
    tmp_fd, tmp_path = tempfile.mkstemp(
        prefix=f"easy_compare_{label}_",
        suffix=ext,
        dir=folder_paths.get_temp_directory(),
    )
    os.close(tmp_fd)
    try:
        shutil.copy2(path, tmp_path)
    except Exception as exc:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise RuntimeError(f"Failed to save {label} VIDEO preview.") from exc

    return {
        "filename": os.path.basename(tmp_path),
        "subfolder": "",
        "type": "temp",
    }


def _compare_video_settings(value: object) -> dict[str, object]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError, json.JSONDecodeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _compare_video_selected_source(selection: object) -> "Optional[Input.Video]":
    """Resolve a media-selection object from the compare widget to a VIDEO."""
    if isinstance(selection, str) and selection.strip():
        selection = {
            "source_type": "url" if selection.startswith(("http://", "https://")) else "input",
            "file_path": selection,
        }
    if not isinstance(selection, dict):
        return None

    source_type = str(selection.get("source_type") or selection.get("type") or "input")
    file_path = selection.get("file_path") or selection.get("path")
    url = selection.get("url")
    raw_value = str(url or file_path or "").strip()
    if not raw_value:
        return None

    if source_type == "url" or raw_value.startswith(("http://", "https://")):
        try:
            with urllib.request.urlopen(raw_value, timeout=30) as response:  # noqa: S310
                return InputImpl.VideoFromFile(_io.BytesIO(response.read()))
        except Exception as exc:
            raise RuntimeError(f"Failed to load selected VIDEO URL: {raw_value}") from exc

    if os.path.isabs(raw_value):
        resolved_path = raw_value
    elif source_type == "output":
        resolved_path = os.path.join(folder_paths.get_output_directory(), raw_value)
    elif source_type == "temp":
        resolved_path = os.path.join(folder_paths.get_temp_directory(), raw_value)
    else:
        resolved_path = os.path.join(folder_paths.get_input_directory(), raw_value)

    if not os.path.isfile(resolved_path):
        raise FileNotFoundError(f"Selected VIDEO file not found: {resolved_path}")
    return InputImpl.VideoFromFile(resolved_path)


def _normalize_compare_video_inputs(
    source: object,
    output: object,
) -> "tuple[Optional[Input.Video], Optional[Input.Video]]":
    source_videos = flatten_media_inputs(source)
    output_videos = flatten_media_inputs(output)

    if len(source_videos) >= 2:
        return source_videos[0], source_videos[1]
    if source_videos:
        return source_videos[0], output_videos[0] if output_videos else None
    if len(output_videos) >= 2:
        return output_videos[0], output_videos[1]
    return None, output_videos[0] if output_videos else None


def _save_compare_video_output(
    path: str,
    filename_prefix: str,
    metadata: dict[str, object],
) -> dict[str, str]:
    output_dir = folder_paths.get_output_directory()
    width = int(metadata.get("width") or 0)
    height = int(metadata.get("height") or 0)
    safe_prefix = filename_prefix.strip() or "ComfyUI"
    full_output_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
        safe_prefix,
        output_dir,
        width,
        height,
    )
    extension = os.path.splitext(path)[1] or f".{Types.VideoContainer.get_extension(Types.VideoContainer.AUTO)}"
    output_filename = f"{filename}_{counter:05}_{extension}"
    output_path = os.path.join(full_output_folder, output_filename)
    try:
        shutil.copy2(path, output_path)
    except Exception as exc:
        raise RuntimeError("Failed to save output VIDEO comparison file.") from exc
    return {
        "filename": output_filename,
        "subfolder": subfolder,
        "type": "output",
    }


def _compare_video_local_path(video: Input.Video, label: str) -> "tuple[str, list[str]]":
    try:
        return video_input_to_local_file(
            video,
            suffix=f".{Types.VideoContainer.get_extension(Types.VideoContainer.AUTO)}",
            save_kwargs={
                "format": Types.VideoContainer.AUTO,
                "codec": Types.VideoCodec.AUTO,
            },
        )
    except Exception as exc:
        raise RuntimeError(f"Failed to prepare {label} VIDEO for FFmpeg probing.") from exc


def _compare_video_metadata(path: str, label: str) -> dict[str, object]:
    info = ffprobe_info(path)
    fps_fraction = info.get("fps_fraction")
    fps = float(fps_fraction) if isinstance(fps_fraction, Fraction) else info.get("fps")
    frame_count = info.get("frame_count")
    duration = info.get("duration")

    if not info.get("has_video"):
        raise ValueError(f"{label} VIDEO does not contain a video stream.")
    if not isinstance(duration, (int, float)) or duration <= 0:
        raise ValueError(f"{label} VIDEO duration could not be detected by FFprobe.")
    if not isinstance(frame_count, int) or frame_count <= 0:
        if isinstance(fps, (int, float)) and fps > 0:
            frame_count = max(1, round(float(duration) * float(fps)))
        else:
            frame_count = None

    return {
        "fps": float(fps) if isinstance(fps, (int, float)) and fps > 0 else None,
        "fps_fraction": fps_fraction,
        "frame_count": frame_count,
        "duration": float(duration),
        "width": int(info.get("width") or 0),
        "height": int(info.get("height") or 0),
    }


def _probe_compare_video(video: Input.Video, label: str) -> "tuple[str, list[str], dict[str, object]]":
    path, temp_files = _compare_video_local_path(video, label)
    try:
        metadata = _compare_video_metadata(path, label)
        return path, temp_files, metadata
    except Exception:
        for temp_file in temp_files:
            try:
                os.unlink(temp_file)
            except OSError:
                pass
        raise


def _cleanup_compare_temp_files(temp_files: list[str]) -> None:
    for temp_file in temp_files:
        try:
            os.unlink(temp_file)
        except OSError:
            pass


class EasyCompareVideos(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="easy compareVideos",
            display_name="Compare Videos",
            category=CATEGORY_VIDEO,
            description=(
                "Preview source and output VIDEO inputs with slider and A/B comparison modes. "
                "VIDEO lists use at most the first two items as source and output. "
                "When both inputs are provided, playback duration follows the output VIDEO. "
                "Source and output videos can also be selected directly from the widget when inputs are not connected."
            ),
            is_input_list=True,
            inputs=[
                io.Video.Input("source", optional=True),
                io.Video.Input("output", optional=True),
                TYPE_COMPARE_VIDEO.Input("compare_video"),
            ],
            outputs=[],
            is_output_node=True,
        )

    @classmethod
    def execute(
        cls,
        source: "Optional[Input.Video] | list[Input.Video]" = None,
        output: "Optional[Input.Video] | list[Input.Video]" = None,
        compare_video: "object | list[object]" = "{}",
    ) -> io.NodeOutput:
        source, output = _normalize_compare_video_inputs(source, output)

        settings_values = flatten_media_inputs(compare_video)
        settings = _compare_video_settings(settings_values[0] if settings_values else "{}")
        watch_output_history = settings.get("watch_output_history") is True
        save_output = settings.get("save_output") is True and not watch_output_history
        filename_prefix = str(settings.get("filename_prefix") or "ComfyUI")

        if source is None:
            source = _compare_video_selected_source(settings.get("source"))
        if output is None:
            output = _compare_video_selected_source(settings.get("output"))
        # if source is None and output is None:
        #     raise ValueError("At least one VIDEO input or selected video is required.")

        payload: dict[str, object] = {
            "source": None,
            "output": None,
            "fps": None,
            "frame_count": None,
            "duration": None,
        }

        prepared: dict[str, tuple[str, list[str], dict[str, object]]] = {}
        try:
            if source is not None:
                prepared["source"] = _probe_compare_video(source, "source")
            if output is not None:
                prepared["output"] = _probe_compare_video(output, "output")

            source_metadata = prepared.get("source", (None, None, None))[2]
            output_metadata = prepared.get("output", (None, None, None))[2]

            if source_metadata is not None and output_metadata is not None:
                output_duration = float(output_metadata["duration"])

                payload["fps"] = float(source_metadata["fps"]) if source_metadata["fps"] is not None else None
                payload["frame_count"] = int(source_metadata["frame_count"]) if source_metadata["frame_count"] is not None else None
                payload["duration"] = output_duration
            else:
                metadata = source_metadata if source_metadata is not None else output_metadata
                if metadata is not None:
                    payload["fps"] = float(metadata["fps"]) if metadata["fps"] is not None else None
                    payload["frame_count"] = int(metadata["frame_count"]) if metadata["frame_count"] is not None else None
                    payload["duration"] = float(metadata["duration"])

            source_prepared = prepared.get("source")
            if source_prepared is not None:
                source_path, _source_temp_files, _source_metadata = source_prepared
                payload["source"] = _compare_video_preview_from_path(source_path, "source")

            output_prepared = prepared.get("output")
            if output_prepared is not None:
                output_path, _output_temp_files, output_metadata = output_prepared
                payload["output"] = (
                    _save_compare_video_output(output_path, filename_prefix, output_metadata)
                    if save_output
                    else _compare_video_preview_from_path(output_path, "output")
                )
        finally:
            for _path, temp_files, _metadata in prepared.values():
                _cleanup_compare_temp_files(temp_files)

        standard_preview = payload["output"] or payload["source"]
        preview_ui = (
            ui.PreviewVideo([standard_preview]).as_dict()
            if standard_preview is not None
            else {}
        )
        preview_ui["compare_videos"] = [payload]
        return io.NodeOutput(ui=preview_ui)


class EasyMergeVideos(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="easy mergeVideos",
            display_name="Merge Videos",
            category=CATEGORY_VIDEO,
            description=(
                "Concatenate multiple compatible VIDEO clips in order. "
                "All clips must share the same fps, dimensions, and audio configuration."
            ),
            inputs=[
                io.Video.Input("video_1"),
                io.Video.Input("video_2"),
            ],
            outputs=[
                io.Video.Output(display_name="VIDEO"),
            ],
        )

    @classmethod
    def execute(
        cls,
        video_1: Input.Video,
        video_2: Input.Video,
    ) -> io.NodeOutput:
        videos = [video_1, video_2]

        specs = [extract_merge_spec(v) for v in videos]
        validate_merge_compatibility(specs)

        all_images: list[torch.Tensor] = []
        all_waveforms: list[torch.Tensor] = []
        sample_rate: int | None = None
        has_audio = specs[0].has_audio

        for video in videos:
            components = video.get_components()
            all_images.append(components.images)

            if has_audio and components.audio is not None:
                audio = components.audio
                if isinstance(audio, dict):
                    waveform = audio.get("waveform")
                    if waveform is not None:
                        all_waveforms.append(waveform)
                    if sample_rate is None:
                        sample_rate = audio.get("sample_rate")

        merged_images = torch.cat(all_images, dim=0)

        merged_audio: dict | None = None
        if has_audio and all_waveforms:
            merged_waveform = torch.cat(all_waveforms, dim=2)
            merged_audio = {"waveform": merged_waveform, "sample_rate": sample_rate}

        merged_video = InputImpl.VideoFromComponents(
            Types.VideoComponents(
                images=merged_images,
                audio=merged_audio,
                frame_rate=specs[0].fps,
            )
        )

        return io.NodeOutput(merged_video)


def _tensor_crossfade_video_files(
    sources: list[str],
    fade_duration: float,
    total: int,
    progress: "callable[[int, str], None]",
):
    """Load video files and merge with a tensor-based linear crossfade (no FFmpeg required)."""
    progress(total, "Loading clips for tensor crossfade…")
    videos = []
    for i, source in enumerate(sources, start=1):
        progress(total, f"Loading clip {i}/{total}")
        videos.append(InputImpl.VideoFromFile(source))

    specs = [extract_merge_spec(v) for v in videos]
    validate_merge_compatibility(specs)

    fps = float(specs[0].fps)
    fade_frames = max(1, int(round(fade_duration * fps)))
    progress(total + 1, f"Blending transitions ({fade_frames} frames each)…")

    all_images = [v.get_components().images for v in videos]
    merged_images = tensor_crossfade_images(all_images, fade_frames)

    merged_audio: dict | None = None
    if specs[0].has_audio:
        waveforms: list[torch.Tensor] = []
        sample_rate: int | None = None
        for v in videos:
            wf, sr = _extract_audio_waveform(v.get_components().audio)
            if wf is not None:
                waveforms.append(wf)
            if sample_rate is None and sr is not None:
                sample_rate = sr
        if waveforms and sample_rate:
            fade_samples = max(1, int(round(fade_duration * sample_rate)))
            merged_audio = {
                "waveform": tensor_crossfade_audio(waveforms, fade_samples),
                "sample_rate": sample_rate,
            }

    return InputImpl.VideoFromComponents(
        Types.VideoComponents(
            images=merged_images,
            audio=merged_audio,
            frame_rate=specs[0].fps,
        )
    )


def _extract_audio_waveform(audio: object) -> "tuple[torch.Tensor | None, int | None]":
    """Return (waveform, sample_rate) from a ComfyUI audio dict, or (None, None)."""
    if not isinstance(audio, dict):
        return None, None
    waveform = audio.get("waveform")
    sr = audio.get("sample_rate")
    return waveform, int(sr) if sr is not None else None


def _collect_video_components(
    videos: list,
    has_audio: bool,
) -> "tuple[torch.Tensor, dict | None]":
    """Extract and concatenate image frames (and optionally audio) from video objects."""
    all_images: list[torch.Tensor] = []
    all_waveforms: list[torch.Tensor] = []
    sample_rate: int | None = None

    for video in videos:
        components = video.get_components()
        all_images.append(components.images)
        if has_audio and components.audio is not None:
            waveform, sr = _extract_audio_waveform(components.audio)
            if waveform is not None:
                all_waveforms.append(waveform)
            if sample_rate is None and sr is not None:
                sample_rate = sr

    merged_audio: dict | None = None
    if has_audio and all_waveforms:
        merged_audio = {"waveform": torch.cat(all_waveforms, dim=2), "sample_rate": sample_rate}

    return torch.cat(all_images, dim=0), merged_audio


def _tensor_merge_video_files(
    sources: list[str],
    total: int,
    progress: "callable[[int, str], None]",
):
    """Load video files and merge them frame-by-frame using torch.cat (tensor fallback)."""
    progress(total, "Loading clips for tensor merge…")
    videos = []
    for i, source in enumerate(sources, start=1):
        progress(total, f"Loading clip {i}/{total}")
        videos.append(InputImpl.VideoFromFile(source))

    specs = [extract_merge_spec(v) for v in videos]
    validate_merge_compatibility(specs)

    progress(total + 1, "Merging frames…")
    merged_images, merged_audio = _collect_video_components(videos, specs[0].has_audio)

    return InputImpl.VideoFromComponents(
        Types.VideoComponents(
            images=merged_images,
            audio=merged_audio,
            frame_rate=specs[0].fps,
        )
    )


def _parse_path_list(paths: "str | list[str]") -> list[str]:
    """Parse a newline/comma-separated path string into a list of non-empty paths."""
    lines = paths if isinstance(paths, list) else paths.replace(",", "\n").splitlines()
    return [line.strip() for line in lines if line.strip()]


_FFMPEG_INSTALL_URL = "https://ffmpeg.org/download.html"


def _log_ffmpeg_unavailable_hint(tag: str, need_xfade: bool = False) -> None:
    """Log an actionable install hint when FFmpeg (or xfade) is not available."""
    if not shutil.which("ffmpeg"):
        logger.warning(
            "%s FFmpeg not installed — using tensor fallback (slower). "
            "Install FFmpeg for faster video processing: %s",
            tag, _FFMPEG_INSTALL_URL,
        )
    elif need_xfade and not ffmpeg_supports_xfade():
        logger.warning(
            "%s xfade filter not available in this FFmpeg build (requires FFmpeg 4.3+) — "
            "Upgrade to a full FFmpeg build: %s",
            tag, _FFMPEG_INSTALL_URL,
        )


def _trim_video_to_frame_count(
    source: str,
    frame_count: int,
    tag: str,
    progress: "callable[[str], None] | None" = None,
) -> str:
    """Trim source when requested, raising if the requested trim cannot be performed."""
    if frame_count <= 0:
        return source
    try:
        trimmed = trim_video_with_ffmpeg(source, frame_count, progress_callback=progress)
    except RuntimeError as exc:
        raise RuntimeError(f"{tag} failed to trim merged video to {frame_count} frames.") from exc
    if trimmed is None:
        raise RuntimeError(
            f"{tag} cannot trim to {frame_count} frames. "
            "Install FFmpeg/FFprobe and ensure the merged video has a detectable frame rate."
        )
    return trimmed


def _resolve_video_path(raw: str) -> str | _io.BytesIO:
    """Resolve a raw path string to a local file path or BytesIO buffer.

    Supported formats:
    - HTTP/HTTPS URL
    - ``input/<filename>`` — file in ComfyUI input directory
    - ``temp/<filename>`` — file in ComfyUI temp directory
    - ``output/<filename>`` — file in ComfyUI output directory
    - Absolute file path
    - ComfyUI annotated path (filename[subfolder][type]) via folder_paths
    - Bare filename resolved against output then temp directories
    """
    raw = raw.strip()
    if not raw:
        raise ValueError("Empty path string")

    # URL
    if raw.startswith(("http://", "https://")):
        with urllib.request.urlopen(raw, timeout=30) as resp:  # noqa: S310
            return _io.BytesIO(resp.read())

    # ComfyUI-style prefixed paths: temp/<file> or output/<file>
    _PREFIXED = {
        "input": folder_paths.get_input_directory,
        "temp": folder_paths.get_temp_directory,
        "output": folder_paths.get_output_directory,
    }
    for prefix, get_dir in _PREFIXED.items():
        if raw.startswith(prefix + "/") or raw.startswith(prefix + os.sep):
            rel = raw[len(prefix) + 1:]
            base_dir = os.path.realpath(get_dir())
            candidate = os.path.realpath(os.path.join(base_dir, rel))
            if os.path.commonpath((base_dir, candidate)) != base_dir:
                raise ValueError(f"Path escapes the ComfyUI {prefix!r} directory: {rel!r}")
            if os.path.isfile(candidate):
                return candidate
            raise FileNotFoundError(f"File not found in {prefix!r} directory: {rel!r}")

    # Absolute path
    if os.path.isabs(raw) and os.path.isfile(raw):
        return raw

    # ComfyUI annotated path
    try:
        annotated = folder_paths.get_annotated_filepath(raw)
        if os.path.isfile(annotated):
            return annotated
    except Exception:
        pass

    # Bare filename: check output, temp, then input directories
    for base_dir in (
        folder_paths.get_output_directory(),
        folder_paths.get_temp_directory(),
        folder_paths.get_input_directory(),
    ):
        candidate = os.path.join(base_dir, raw)
        if os.path.isfile(candidate):
            return candidate

    raise FileNotFoundError(f"Cannot resolve video path: {raw!r}")


def _expand_comfy_video_path_patterns(raw_paths: list[str]) -> list[str]:
    """Expand recursive glob patterns under ComfyUI input/output/temp directories."""
    prefix_dirs = {
        "input": folder_paths.get_input_directory,
        "temp": folder_paths.get_temp_directory,
        "output": folder_paths.get_output_directory,
    }
    expanded: list[str] = []
    for raw in raw_paths:
        matched_prefix = next(
            (prefix for prefix in prefix_dirs if raw.startswith(prefix + "/") or raw.startswith(prefix + os.sep)),
            None,
        )
        if matched_prefix is None:
            expanded.append(raw)
            continue

        relative_pattern = raw[len(matched_prefix) + 1:]
        if not glob.has_magic(relative_pattern):
            expanded.append(raw)
            continue

        base_dir = os.path.realpath(prefix_dirs[matched_prefix]())
        absolute_pattern = os.path.abspath(os.path.join(base_dir, relative_pattern))
        if os.path.commonpath((base_dir, absolute_pattern)) != base_dir:
            raise ValueError(
                f"Path pattern escapes the ComfyUI {matched_prefix!r} directory: {relative_pattern!r}"
            )

        matches = []
        for match in sorted(glob.glob(absolute_pattern, recursive=True)):
            resolved_match = os.path.realpath(match)
            if os.path.commonpath((base_dir, resolved_match)) == base_dir and os.path.isfile(resolved_match):
                matches.append(resolved_match)
        if not matches:
            raise FileNotFoundError(f"No video files match path pattern: {raw!r}")
        expanded.extend(matches)
    return expanded

class EasyMergeVideosFromPaths(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="easy mergeVideosFromPaths",
            display_name="Merge Videos From Paths",
            category=CATEGORY_VIDEO,
            description=(
                "Load and concatenate videos from a list of file paths or URLs. "
                "Supports ComfyUI input/temp/output paths and subdirectory globs, absolute local paths, and HTTP(S) URLs. "
                "All clips must share the same fps, dimensions, and audio configuration."
            ),
            inputs=[
                io.String.Input(
                    "paths",
                    force_input=True,
                    default="",
                    tooltip=(
                        "One path per line (or comma-separated). "
                        "Accepts ComfyUI input/output/temp paths (including subdirectories and ** globs), "
                        "absolute paths, or URLs."
                    ),
                ),
                io.Int.Input(
                    "frame_count",
                    default=-1,
                    min=-1,
                    step=1,
                    tooltip="Maximum frames to keep after merging. Use -1 to keep all frames.",
                ),
                io.Combo.Input(
                    "audio_mode",
                    options=["merge", "override"],
                    default="merge",
                    tooltip="Merge the AUDIO input with the video's existing audio, or override it.",
                ),
                io.Audio.Input(
                    "audio",
                    optional=True,
                    tooltip="Optional audio to replace or add to the final merged VIDEO using FFmpeg.",
                ),
                # io.Combo.Input("transition", default="None", options=['None', 'Fade'], tooltip="Transition type to apply between clips."),
                # io.Float.Input(
                #     "transition_duration",
                #     default=0.5,
                #     min=0.1,
                #     max=10.0,
                #     step=0.1,
                #     tooltip="Duration of the cross-fade transition in seconds.",
                # ),
            ],
            hidden=[io.Hidden.unique_id],
            outputs=[
                io.Video.Output(display_name="VIDEO"),
            ],
        )

    @classmethod
    def execute(
        cls,
        paths: str,
        frame_count: int = -1,
        audio_mode: str = "merge",
        audio: Optional[dict] = None,
    ) -> io.NodeOutput:
        raw_paths = _expand_comfy_video_path_patterns(_parse_path_list(paths))
        if len(raw_paths) == 0:
            raise ValueError("At least 1 video path is required.")

        use_transition = False
        fade_duration = 0.5

        total = len(raw_paths)
        pbar = ProgressBar(total + 2)

        def _progress(step: int, _msg: str) -> None:
            pbar.update_absolute(step, total + 2)

        def _cleanup_owned(paths_to_clean: set[str], keep: str | None = None) -> None:
            for path in paths_to_clean:
                if path == keep:
                    continue
                try:
                    os.unlink(path)
                except OSError:
                    pass

        def _finalize_video(
            video: Input.Video,
            message: str,
            owned_paths: set[str] | None = None,
            final_path: str | None = None,
        ) -> io.NodeOutput:
            paths_to_clean = owned_paths or set()
            if audio is not None:
                try:
                    video = _attach_video_audio_with_ffmpeg(
                        video,
                        audio,
                        audio_mode,
                        "[EasyMergeVideosFromPaths]",
                    )
                finally:
                    _cleanup_owned(paths_to_clean)
                    paths_to_clean.clear()
            else:
                _cleanup_owned(paths_to_clean, keep=final_path)
                paths_to_clean.clear()
            _progress(total + 2, message)
            return io.NodeOutput(video)

        if len(raw_paths) == 1:
            _progress(1, f"Loading single video: {raw_paths[0]}")
            owned_paths: set[str] = set()
            try:
                source = _resolve_video_path(raw_paths[0])
                if isinstance(source, _io.BytesIO):
                    source.seek(0)
                    ext = os.path.splitext(raw_paths[0])[1] or ".mp4"
                    tmp_fd, tmp_path = tempfile.mkstemp(suffix=ext, dir=folder_paths.get_temp_directory())
                    os.write(tmp_fd, source.read())
                    os.close(tmp_fd)
                    source = tmp_path
                    owned_paths.add(tmp_path)
                final_path = _trim_video_to_frame_count(
                    source,
                    frame_count,
                    "[EasyMergeVideosFromPaths]",
                    progress=lambda msg: _progress(1, msg),
                )
                if final_path != source:
                    owned_paths.add(final_path)
                merged_video = InputImpl.VideoFromFile(final_path)
                return _finalize_video(
                    merged_video,
                    "Done — loaded single video",
                    owned_paths=owned_paths,
                    final_path=final_path,
                )
            except Exception:
                _cleanup_owned(owned_paths)
                raise

        _progress(0, f"Resolving {total} paths…")
        resolved: list[str | _io.BytesIO] = []
        temp_files: list[str] = []  # Track temp files to clean up
        for i, raw in enumerate(raw_paths, start=1):
            _progress(i - 1, f"Resolving {i}/{total}: {raw}")
            try:
                source = _resolve_video_path(raw)
            except (FileNotFoundError, ValueError) as exc:
                raise ValueError(f"Clip {i}: {exc}") from exc

            # Convert BytesIO to temp file for FFmpeg compatibility
            if isinstance(source, _io.BytesIO):
                source.seek(0)
                ext = os.path.splitext(raw)[1] or ".mp4"
                tmp_fd, tmp_path = tempfile.mkstemp(suffix=ext, dir=folder_paths.get_temp_directory())
                os.write(tmp_fd, source.read())
                os.close(tmp_fd)
                source = tmp_path
                temp_files.append(tmp_path)

            resolved.append(source)

        # Get output extension from first resolved path
        string_paths = [p for p in resolved if isinstance(p, str)]
        ext = os.path.splitext(string_paths[0])[1] if string_paths else ".mp4"
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=ext, dir=folder_paths.get_temp_directory())
        os.close(tmp_fd)
        generated_outputs = {tmp_path}

        tag = "[EasyMergeVideosFromPaths]"
        # logger.info("%s transition=%s, clips=%d", tag, transition, total)

        try:
            if use_transition:
                # --- Fade transition: FFmpeg xfade filter (re-encode) ---
                try:
                    _progress(total, f"Merging {total} clips with fade transition…")
                    success = ffmpeg_concat_with_fade(
                        resolved,
                        tmp_path,
                        fade_duration=fade_duration,
                        progress_callback=lambda msg: _progress(total, msg),
                    )
                    if success:
                        logger.info(
                            "%s backend=ffmpeg-xfade, transition=fade(%.2fs) ✓", tag, fade_duration
                        )
                        trimmed_path = _trim_video_to_frame_count(
                            tmp_path,
                            frame_count,
                            tag,
                            progress=lambda msg: _progress(total + 1, msg),
                        )
                        if trimmed_path != tmp_path:
                            generated_outputs.add(trimmed_path)
                        tmp_path = trimmed_path
                        merged_video = InputImpl.VideoFromFile(tmp_path)
                        return _finalize_video(
                            merged_video,
                            f"Done — merged {total} clips with fade",
                            owned_paths=generated_outputs,
                            final_path=tmp_path,
                        )
                    _log_ffmpeg_unavailable_hint(tag, need_xfade=True)
                except RuntimeError as exc:
                    logger.warning(
                        "%s ffmpeg xfade failed: %s — falling back to no transition.", tag, exc
                    )

            # --- No transition: FFmpeg concat (stream copy preferred, fastest) ---
            try:
                _progress(total, f"Merging {total} clips via FFmpeg…")
                success = ffmpeg_concat(
                    resolved,
                    tmp_path,
                    progress_callback=lambda msg: _progress(total, msg),
                )
                if success:
                    logger.info("%s backend=ffmpeg-concat (stream copy), transition=none ✓", tag)
                    trimmed_path = _trim_video_to_frame_count(
                        tmp_path,
                        frame_count,
                        tag,
                        progress=lambda msg: _progress(total + 1, msg),
                    )
                    if trimmed_path != tmp_path:
                        generated_outputs.add(trimmed_path)
                    tmp_path = trimmed_path
                    merged_video = InputImpl.VideoFromFile(tmp_path)
                    return _finalize_video(
                        merged_video,
                        f"Done — merged {total} clips",
                        owned_paths=generated_outputs,
                        final_path=tmp_path,
                    )
                _log_ffmpeg_unavailable_hint(tag)
            except RuntimeError as exc:
                logger.warning(
                    "%s ffmpeg concat failed: %s — falling back to tensor merge.", tag, exc
                )

            # --- Slow fallback: tensor-based merge (no transition) ---
            logger.info("%s backend=tensor-merge, transition=none (ffmpeg unavailable)", tag)
            merged_video = _tensor_merge_video_files(resolved, total, _progress)
            return _finalize_video(
                merged_video,
                f"Done — merged {total} clips",
                owned_paths=generated_outputs,
            )
        finally:
            _cleanup_owned(generated_outputs)
            # Clean up downloaded URL inputs. Final returned files have already had ownership transferred.
            for f in temp_files:
                try:
                    os.unlink(f)
                except OSError:
                    pass
