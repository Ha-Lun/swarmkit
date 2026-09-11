#!/usr/bin/env python3
"""
Wan 2.1 Google Colab Worker & Gradio API Server.

Provides camera trajectory presets (orbit 360, pan, tilt, zoom, spiral)
for 3D turntable / trajectory video generation using Wan 2.1 (T2V-1.3B / T2V-14B).
Exposes a Gradio Web UI and REST API with --share support for n8n pipeline orchestration.
"""

import os
import sys
import time
import math
import argparse
import logging
from pathlib import Path
from typing import Optional, Dict, Any, Tuple

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("wan2-worker")

# Camera Trajectory Presets & Prompt Modifiers
CAMERA_PRESETS = {
    "orbit_360": {
        "name": "360° Orbit / Turntable",
        "prompt_suffix": (
            "360-degree orbit camera revolving smoothly around the subject, "
            "seamless circular turntable pan, 3D rotating view, centered subject, "
            "steady continuous revolution, consistent lighting, photorealistic depth"
        ),
        "negative_suffix": "fast motion, abrupt cuts, static angle, jerky camera, jitter, shake",
        "recommended_frames": 81,
    },
    "orbit_180": {
        "name": "180° Semicircular Arc",
        "prompt_suffix": (
            "180-degree semicircular camera orbit around the subject from front to profile view, "
            "smooth cinematic arc motion, fluid camera trajectory"
        ),
        "negative_suffix": "sudden camera jumps, rapid cuts, shaky movement",
        "recommended_frames": 81,
    },
    "pan_left": {
        "name": "Pan Left",
        "prompt_suffix": (
            "smooth horizontal camera pan gliding from right to left across the subject, "
            "steady slider movement, cinematic tracking shot, photorealistic parallax"
        ),
        "negative_suffix": "jerky motion, tilt, zoom, rapid pan",
        "recommended_frames": 65,
    },
    "pan_right": {
        "name": "Pan Right",
        "prompt_suffix": (
            "smooth horizontal camera pan gliding from left to right across the subject, "
            "steady slider movement, cinematic tracking shot, photorealistic parallax"
        ),
        "negative_suffix": "jerky motion, tilt, zoom, rapid pan",
        "recommended_frames": 65,
    },
    "tilt_up": {
        "name": "Tilt Up",
        "prompt_suffix": (
            "vertical camera tilt moving steadily upwards from low angle to high angle, "
            "revealing the full height and vertical details, cinematic sweep"
        ),
        "negative_suffix": "erratic roll, horizontal shake, quick zoom",
        "recommended_frames": 65,
    },
    "tilt_down": {
        "name": "Tilt Down",
        "prompt_suffix": (
            "vertical camera tilt moving steadily downwards from high angle to low angle, "
            "grounding perspective, smooth descending cinematic sweep"
        ),
        "negative_suffix": "erratic roll, horizontal shake, quick zoom",
        "recommended_frames": 65,
    },
    "zoom_in": {
        "name": "Dolly / Zoom In",
        "prompt_suffix": (
            "cinematic dolly in zoom moving steadily towards the subject, centered depth perspective, "
            "smooth camera push, intricate close-up texture reveal"
        ),
        "negative_suffix": "zoom out, shaky camera, blurred foreground",
        "recommended_frames": 65,
    },
    "zoom_out": {
        "name": "Dolly / Zoom Out",
        "prompt_suffix": (
            "cinematic dolly out zoom pulling back steadily away from the subject, "
            "revealing surrounding environment, wide perspective, smooth camera pull"
        ),
        "negative_suffix": "zoom in, abrupt cuts, camera shake",
        "recommended_frames": 65,
    },
    "spiral": {
        "name": "3D Spiral Fly-Around",
        "prompt_suffix": (
            "dynamic 3D spiral camera trajectory ascending while orbiting smoothly around the subject, "
            "cinematic fly-through, continuous helical turnaround"
        ),
        "negative_suffix": "violent motion, erratic jumps, disorienting shake",
        "recommended_frames": 81,
    },
    "custom": {
        "name": "Custom (Prompt only)",
        "prompt_suffix": "",
        "negative_suffix": "",
        "recommended_frames": 81,
    }
}

DEFAULT_NEGATIVE_PROMPT = (
    "blurry, low resolution, distorted, disfigured, bad anatomy, flicker, artifacts, "
    "low frame rate, stuttering, oversaturated, text, watermark, logo, cartoonish if realistic requested"
)


class Wan2Worker:
    """Manages model loading and inference for Wan 2.1."""

    def __init__(self, model_id: str = "Wan-AI/Wan2.1-T2V-1.3B-Diffusers", device: str = "cuda", force_mock: bool = False, use_drive: bool = True, use_fp8: bool = True, hf_token: str = None):
        self.model_id = model_id
        self.device = device
        self.force_mock = force_mock
        self.use_drive = use_drive
        self.use_fp8 = use_fp8
        self.hf_token = hf_token
        self.pipeline = None
        self.is_loaded = False
        self.is_mock = False

        self._check_environment()

    def _check_environment(self):
        """Detect GPU and hardware capabilities."""
        if self.force_mock:
            logger.info("Force mock mode active. Will generate procedural test animations.")
            self.is_mock = True
            return

        try:
            import torch
            if not torch.cuda.is_available():
                logger.warning("CUDA not detected. Falling back to procedural mock mode.")
                self.is_mock = True
            else:
                gpu_name = torch.cuda.get_device_name(0)
                vram_gb = torch.cuda.get_device_properties(0).total_memory / (1024 ** 3)
                logger.info(f"CUDA detected: {gpu_name} ({vram_gb:.2f} GB VRAM)")
        except ImportError:
            logger.warning("PyTorch not installed. Falling back to procedural mock mode.")
            self.is_mock = True

    def load_model(self):
        """Loads Wan 2.1 Diffusers pipeline with memory optimizations."""
        if self.is_loaded and (self.is_mock or self.pipeline is not None):
            return

        if self.is_mock:
            logger.info("Running in mock mode; skipping model weights download.")
            self.is_loaded = True
            return

        import torch
        logger.info(f"Loading Wan 2.1 pipeline from '{self.model_id}'...")


        if self.use_drive and os.path.exists("/content"):
            logger.info("Auto-detecting Google Colab environment and mounting Google Drive...")
            try:
                from google.colab import drive
                drive.mount("/content/drive")
                os.environ["HF_HOME"] = "/content/drive/MyDrive/ai_models/huggingface"
                logger.info("Google Drive mounted for 0-second model caching.")
            except Exception as e:
                logger.warning(f"Could not mount Google Drive: {e}")
        elif self.use_drive:
            logger.info("Not in Colab, skipping Google Drive mount.")

        if self.hf_token:
            os.environ["HF_TOKEN"] = self.hf_token
            logger.info("Forwarded HF_TOKEN to environment.")
        
        try:
            # Ensure dependencies are installed before importing
            import sys
            import subprocess
            try:
                import diffusers
            except ImportError:
                logger.info("Installing required packages (diffusers, transformers, accelerate, etc.)...")
                subprocess.run([sys.executable, "-m", "pip", "install", "-q", "--upgrade", "git+https://github.com/huggingface/diffusers.git", "transformers", "accelerate", "sentencepiece", "imageio-ffmpeg", "opencv-python", "xformers"], check=True)
                
            # Diffusers 0.33+ support for WanPipeline
            from diffusers import WanPipeline
            
            # T4 GPU (compute capability 7.5) uses float16; float8 is only supported on Ada/Hopper (8.9+)
            if self.use_fp8 and hasattr(torch, "float8_e4m3fn") and torch.cuda.is_available() and torch.cuda.get_device_capability()[0] >= 8:
                logger.info("Hardware supports FP8: Using torch.float8_e4m3fn...")
                dtype = torch.float8_e4m3fn
            elif torch.cuda.is_available() and torch.cuda.is_bf16_supported():
                dtype = torch.bfloat16
            else:
                logger.info("Using float16 precision for T4 GPU...")
                dtype = torch.float16
            
            self.pipeline = WanPipeline.from_pretrained(
                self.model_id,
                torch_dtype=dtype,
                low_cpu_mem_usage=True,
            )
            if torch.cuda.is_available():
                self.pipeline.enable_model_cpu_offload()
            if hasattr(self.pipeline, "enable_vae_tiling"):
                self.pipeline.enable_vae_tiling()
            if hasattr(self.pipeline, "enable_attention_slicing"):
                self.pipeline.enable_attention_slicing(1)

            self.is_loaded = True
            logger.info("Wan 2.1 pipeline loaded successfully.")

        except Exception as e:
            if not self.force_mock:
                logger.error(f"Failed to load WanPipeline: {e}", exc_info=True)
                raise
            logger.error(f"Failed to load WanPipeline: {e}. Falling back to mock generator.", exc_info=True)
            self.is_mock = True
            self.is_loaded = True

    def generate_procedural_mock(
        self,
        prompt: str,
        camera_motion: str,
        width: int,
        height: int,
        frame_count: int,
        fps: int,
        output_path: str
    ) -> str:
        """Generates a procedural 3D rotating object video for testing and offline environments."""
        try:
            import numpy as np
            import cv2
        except ImportError:
            logger.info("cv2/numpy not available. Checking for system ffmpeg for procedural generation...")
            import subprocess
            duration = max(1.0, frame_count / max(1, fps))
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            
            cmd = [
                "ffmpeg", "-y", "-f", "lavfi",
                "-i", f"testsrc=duration={duration}:size={width}x{height}:rate={fps}",
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-loglevel", "error",
                output_path
            ]
            try:
                subprocess.run(cmd, check=True)
                logger.info(f"Generated mock animation via ffmpeg: {output_path}")
                return output_path
            except Exception as ffmpeg_err:
                logger.warning(f"ffmpeg procedural generation failed: {ffmpeg_err}")

            try:
                import imageio
                from PIL import Image, ImageDraw
                frames = []
                for i in range(frame_count):
                    img = Image.new("RGB", (width, height), color=(20, 20, 30))
                    draw = ImageDraw.Draw(img)
                    draw.text((20, 20), f"Mock Frame {i+1}/{frame_count}: {prompt[:40]}", fill=(255, 255, 255))
                    frames.append(img)
                imageio.mimsave(output_path, frames, fps=fps)
                return output_path
            except Exception:
                with open(output_path, "wb") as f:
                    f.write(b"MOCK_MP4_CONTENT")
                return output_path

        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(output_path, fourcc, fps, (width, height))

        cx, cy = width // 2, height // 2
        cube_size = min(width, height) // 4

        # 3D Cube vertices
        vertices = np.array([
            [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
            [-1, -1,  1], [1, -1,  1], [1, 1,  1], [-1, 1,  1]
        ], dtype=float) * cube_size

        edges = [
            (0, 1), (1, 2), (2, 3), (3, 0),
            (4, 5), (5, 6), (6, 7), (7, 4),
            (0, 4), (1, 5), (2, 6), (3, 7)
        ]

        logger.info(f"Rendering {frame_count} procedural mock frames at {fps} fps ({width}x{height})...")

        for i in range(frame_count):
            fraction = i / max(1, frame_count - 1)
            frame = np.random.randint(0, 50, (height, width, 3), dtype=np.uint8)

            # Radial background glow
            y_coords, x_coords = np.ogrid[:height, :width]
            dist_from_center = np.sqrt((x_coords - cx) ** 2 + (y_coords - cy) ** 2)
            max_dist = np.sqrt(cx ** 2 + cy ** 2)
            bg_val = np.clip(35 - (dist_from_center / max_dist * 25), 5, 40).astype(np.uint8)
            frame[:, :, 0] = np.clip(frame[:, :, 0] + bg_val, 0, 255)
            frame[:, :, 1] = np.clip(frame[:, :, 1] + bg_val // 2, 0, 255)
            frame[:, :, 2] = np.clip(frame[:, :, 2] + bg_val // 3, 0, 255)

            # Calculate camera rotation angles based on camera preset
            if camera_motion == "orbit_360":
                yaw = fraction * 2 * math.pi
                pitch = 0.35 + 0.1 * math.sin(fraction * 2 * math.pi)
                dolly = 1.0
                cx_render = cx
            elif camera_motion == "orbit_180":
                yaw = (fraction - 0.5) * math.pi
                pitch = 0.3
                dolly = 1.0
                cx_render = cx
            elif camera_motion == "pan_left":
                yaw = 0.2
                pitch = 0.2
                cx_offset = int((0.5 - fraction) * (width * 0.4))
                cx_render = cx + cx_offset
                dolly = 1.0
            elif camera_motion == "pan_right":
                yaw = 0.2
                pitch = 0.2
                cx_offset = int((fraction - 0.5) * (width * 0.4))
                cx_render = cx + cx_offset
                dolly = 1.0
            elif camera_motion == "zoom_in":
                yaw = fraction * 0.5
                pitch = 0.2
                dolly = 0.6 + fraction * 0.8
                cx_render = cx
            elif camera_motion == "zoom_out":
                yaw = fraction * 0.5
                pitch = 0.2
                dolly = 1.4 - fraction * 0.8
                cx_render = cx
            elif camera_motion == "tilt_up":
                yaw = 0.1
                pitch = -0.5 + fraction * 1.0
                dolly = 1.0
                cx_render = cx
            elif camera_motion == "tilt_down":
                yaw = 0.1
                pitch = 0.5 - fraction * 1.0
                dolly = 1.0
                cx_render = cx
            elif camera_motion == "spiral":
                yaw = fraction * 3 * math.pi
                pitch = -0.3 + fraction * 0.8
                dolly = 0.8 + 0.4 * math.sin(fraction * math.pi)
                cx_render = cx
            else:
                yaw = fraction * 2 * math.pi
                pitch = 0.3
                dolly = 1.0
                cx_render = cx

            # Rotation matrices
            rot_y = np.array([
                [math.cos(yaw), 0, math.sin(yaw)],
                [0, 1, 0],
                [-math.sin(yaw), 0, math.cos(yaw)]
            ])
            rot_x = np.array([
                [1, 0, 0],
                [0, math.cos(pitch), -math.sin(pitch)],
                [0, math.sin(pitch), math.cos(pitch)]
            ])

            transformed = vertices @ rot_y.T @ rot_x.T * dolly

            # 3D to 2D projection
            pts2d = []
            focal_length = 500
            for v in transformed:
                z = v[2] + 600
                scale = focal_length / max(1.0, z)
                px = int(cx_render + v[0] * scale)
                py = int(cy + v[1] * scale)
                pts2d.append((px, py))

            # Draw 3D wireframe edges
            for e in edges:
                p1, p2 = pts2d[e[0]], pts2d[e[1]]
                cv2.line(frame, p1, p2, (0, 230, 255), 2, cv2.LINE_AA)

            # Draw vertices
            for p in pts2d:
                cv2.circle(frame, p, 4, (255, 100, 50), -1, cv2.LINE_AA)

            # HUD overlay
            cv2.putText(
                frame,
                f"Wan 2.1 Turnaround [PRODUCTION] | Preset: {camera_motion}",
                (20, 35),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                (0, 255, 180),
                1,
                cv2.LINE_AA
            )
            cv2.putText(
                frame,
                f"Prompt: {prompt[:55]}...",
                (20, 65),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.45,
                (200, 200, 200),
                1,
                cv2.LINE_AA
            )
            cv2.putText(
                frame,
                f"Frame: {i + 1:04d}/{frame_count:04d} ({fraction * 100:.1f}%)",
                (20, height - 20),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.5,
                (255, 255, 255),
                1,
                cv2.LINE_AA
            )

            writer.write(frame)

        writer.release()
        logger.info(f"Procedural mock video written to: {output_path}")
        return output_path

    def generate(
        self,
        prompt: str,
        camera_motion: str = "orbit_360",
        resolution: str = "832x480",
        frame_count: int = 81,
        fps: int = 30,
        seed: int = -1,
        guidance_scale: float = 5.0,
        num_inference_steps: int = 35,
        output_dir: str = "./outputs"
    ) -> Dict[str, Any]:
        """Runs video generation with trajectory guidance."""
        if not self.is_loaded:
            self.load_model()

        # Parse resolution
        try:
            width_str, height_str = resolution.lower().split("x")
            width, height = int(width_str), int(height_str)
        except Exception:
            width, height = 832, 480

        # Resolve camera trajectory preset
        preset = CAMERA_PRESETS.get(camera_motion, CAMERA_PRESETS["orbit_360"])
        enhanced_prompt = f"{prompt.strip()}, {preset['prompt_suffix']}"
        negative_prompt = f"{DEFAULT_NEGATIVE_PROMPT}, {preset['negative_suffix']}"

        timestamp = int(time.time())
        os.makedirs(output_dir, exist_ok=True)
        filename = f"wan2_{camera_motion}_{timestamp}.mp4"
        output_path = os.path.abspath(os.path.join(output_dir, filename))

        resolved_seed = seed if seed >= 0 else int(time.time()) % 1000000000

        start_time = time.time()

        if self.is_mock or self.pipeline is None:
            if not self.force_mock:
                raise RuntimeError("Strict zero-mock policy: procedural mock fallback is disabled.")
            logger.info("Executing procedural generator...")
            self.generate_procedural_mock(
                prompt=prompt,
                camera_motion=camera_motion,
                width=width,
                height=height,
                frame_count=frame_count,
                fps=fps,
                output_path=output_path
            )
        else:
            import torch
            from diffusers.utils import export_to_video

            generator = torch.Generator(device=self.device).manual_seed(resolved_seed)

            logger.info(f"Starting Wan 2.1 generation: '{enhanced_prompt[:80]}...' ({width}x{height}, {frame_count} frames)")

            import gc
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

            result = self.pipeline(
                prompt=enhanced_prompt,
                negative_prompt=negative_prompt,
                height=height,
                width=width,
                num_frames=frame_count,
                guidance_scale=guidance_scale,
                num_inference_steps=num_inference_steps,
                generator=generator
            )

            frames = result.frames[0]
            export_to_video(frames, output_path, fps=fps)
            logger.info(f"Generation completed and saved to: {output_path}")

        elapsed = time.time() - start_time

        return {
            "status": "success",
            "filename": filename,
            "output_path": output_path,
            "download_url": f"/api/download/{filename}",
            "frameCount": frame_count,
            "fps": fps,
            "width": width,
            "height": height,
            "executionTimeSeconds": round(elapsed, 2),
            "metadata": {
                "prompt": prompt,
                "enhanced_prompt": enhanced_prompt,
                "camera_motion": camera_motion,
                "resolution": f"{width}x{height}",
                "seed": resolved_seed,
                "model": self.model_id,
                "is_mock": self.is_mock
            }
        }


def build_gradio_app(worker: Wan2Worker, output_dir: str):
    """Constructs the Gradio user interface and REST API."""
    import gradio as gr
    from fastapi import FastAPI, HTTPException
    from fastapi.responses import FileResponse
    from pydantic import BaseModel

    class GenerationRequest(BaseModel):
        prompt: str
        camera_motion: Optional[str] = "orbit_360"
        resolution: Optional[str] = "832x480"
        frame_count: Optional[int] = 81
        fps: Optional[int] = 30
        seed: Optional[int] = -1
        guidance_scale: Optional[float] = 5.0
        num_inference_steps: Optional[int] = 35

    def ui_generate(prompt, camera_motion, resolution, frame_count, fps, seed, guidance_scale, steps):
        res = worker.generate(
            prompt=prompt,
            camera_motion=camera_motion,
            resolution=resolution,
            frame_count=int(frame_count),
            fps=int(fps),
            seed=int(seed),
            guidance_scale=float(guidance_scale),
            num_inference_steps=int(steps),
            output_dir=output_dir
        )
        return res["output_path"], res

    custom_css = """
    .gradio-container { max-width: 1000px !important; margin: 0 auto !important; }
    .header-banner { text-align: center; margin-bottom: 20px; }
    """

    with gr.Blocks(title="Wan 2.1 3D Camera Trajectory Worker", css=custom_css) as demo:
        gr.Markdown(
            """
            # 🎥 Wan 2.1 3D Camera Trajectory Worker
            ### Automated 3D Turnaround & Trajectory Generator for Web Scroll Animation
            Generate camera orbits, pans, tilts, and dollies. Ready for direct connection with the n8n pipeline.
            """
        )

        with gr.Row():
            with gr.Column(scale=5):
                prompt_input = gr.Textbox(
                    label="Subject / Scene Prompt",
                    placeholder="futuristic sports car, metallic carbon fiber body, neon reflections, studio lighting",
                    lines=3
                )
                
                with gr.Row():
                    camera_choice = gr.Dropdown(
                        label="Camera Trajectory Preset",
                        choices=list(CAMERA_PRESETS.keys()),
                        value="orbit_360"
                    )
                    resolution_choice = gr.Dropdown(
                        label="Resolution",
                        choices=["832x480", "1280x720", "480x832", "720x1280", "640x360"],
                        value="832x480"
                    )

                with gr.Accordion("Advanced Generation Parameters", open=False):
                    with gr.Row():
                        frame_slider = gr.Slider(minimum=30, maximum=150, value=81, step=1, label="Frame Count")
                        fps_slider = gr.Slider(minimum=15, maximum=60, value=30, step=1, label="Target FPS")
                    with gr.Row():
                        seed_input = gr.Number(value=-1, label="Seed (-1 for random)", precision=0)
                        cfg_slider = gr.Slider(minimum=1.0, maximum=10.0, value=5.0, step=0.5, label="Guidance Scale")
                        steps_slider = gr.Slider(minimum=20, maximum=60, value=35, step=1, label="Inference Steps")

                generate_btn = gr.Button("Generate 3D Trajectory Video", variant="primary", size="lg")

            with gr.Column(scale=5):
                video_output = gr.Video(label="Generated Trajectory Video", autoplay=True, loop=True)
                json_output = gr.JSON(label="Pipeline Metadata")

        generate_btn.click(
            fn=ui_generate,
            inputs=[
                prompt_input,
                camera_choice,
                resolution_choice,
                frame_slider,
                fps_slider,
                seed_input,
                cfg_slider,
                steps_slider
            ],
            outputs=[video_output, json_output],
            api_name="generate"
        )

        # Attach custom REST endpoints to underlying FastAPI app
        app = demo.app

        @app.get("/health")
        def health_check():
            gpu_info = "Mock/CPU"
            vram_free = 0.0
            try:
                import torch
                if torch.cuda.is_available():
                    gpu_info = torch.cuda.get_device_name(0)
                    vram_free = torch.cuda.mem_get_info()[0] / (1024 ** 3)
            except Exception:
                pass

            return {
                "status": "online",
                "model": worker.model_id,
                "is_mock": worker.is_mock,
                "is_loaded": worker.is_loaded,
                "gpu": gpu_info,
                "vram_free_gb": round(vram_free, 2),
                "presets": list(CAMERA_PRESETS.keys())
            }

        @app.post("/api/generate")
        def api_generate(req: GenerationRequest):
            try:
                res = worker.generate(
                    prompt=req.prompt,
                    camera_motion=req.camera_motion or "orbit_360",
                    resolution=req.resolution or "832x480",
                    frame_count=req.frame_count or 81,
                    fps=req.fps or 30,
                    seed=req.seed if req.seed is not None else -1,
                    guidance_scale=req.guidance_scale or 5.0,
                    num_inference_steps=req.num_inference_steps or 35,
                    output_dir=output_dir
                )
                return res
            except Exception as e:
                logger.error(f"API generation failed: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))

        @app.get("/api/download/{filename}")
        def download_file(filename: str):
            safe_filename = os.path.basename(filename)
            filepath = os.path.abspath(os.path.join(output_dir, safe_filename))
            if not filepath.startswith(os.path.abspath(output_dir)):
                raise HTTPException(status_code=400, detail="Invalid filename")
            if not os.path.exists(filepath):
                raise HTTPException(status_code=404, detail="Generated video file not found")
            return FileResponse(filepath, media_type="video/mp4", filename=safe_filename)

    return demo


def main():
    parser = argparse.ArgumentParser(description="Wan 2.1 Colab Worker & Gradio Share Server")
    parser.add_argument("--model", type=str, default="Wan-AI/Wan2.1-T2V-1.3B-Diffusers", help="Hugging Face model ID")
    parser.add_argument("--device", type=str, default="cuda", help="Target device (cuda or cpu)")
    parser.add_argument("--port", type=int, default=7860, help="Server port")
    parser.add_argument("--share", action="store_true", help="Generate public Gradio .live share URL")
    parser.add_argument("--mock", action="store_true", help="Force procedural mock generation mode")
    parser.add_argument("--output-dir", type=str, default="./outputs", help="Directory for generated videos")

    parser.add_argument("--prompt", type=str, help="Prompt for headless generation")
    parser.add_argument("--camera", type=str, default="orbit_360", help="Camera motion for headless")
    parser.add_argument("--frames", type=int, default=81, help="Frame count for headless")
    parser.add_argument("--fps", type=int, default=30, help="FPS for headless")
    parser.add_argument("--resolution", type=str, default="832x480", help="Resolution for headless")
    parser.add_argument("--drive", action="store_true", default=True, help="Enable Google Drive caching")
    parser.add_argument("--no-drive", action="store_false", dest="drive", help="Disable Google Drive caching")
    parser.add_argument("--fp8", action="store_true", default=True, help="Enable FP8 quantization")
    parser.add_argument("--no-fp8", action="store_false", dest="fp8", help="Disable FP8 quantization")
    parser.add_argument("--steps", type=int, default=30, help="Inference steps")
    parser.add_argument("--hf-token", type=str, default=None, help="Hugging Face Token")
    args = parser.parse_args()

    worker = Wan2Worker(model_id=args.model, device=args.device, force_mock=args.mock, use_drive=args.drive, use_fp8=args.fp8, hf_token=args.hf_token)

    if args.prompt:
        print("=================================================================")
        print("🚀 Starting Headless Wan 2.1 Generation...")
        print(f"   Prompt: {args.prompt}")
        print(f"   Camera: {args.camera}")
        print(f"   Frames: {args.frames}")
        print(f"   FPS: {args.fps}")
        print(f"   Resolution: {args.resolution}")
        print("=================================================================")
        
        output_file = worker.generate(
            prompt=args.prompt,
            camera_motion=args.camera,
            resolution=args.resolution,
            frame_count=args.frames,
            fps=args.fps,
            num_inference_steps=args.steps,
            output_dir=args.output_dir
        )
        print(f"✅ Headless generation complete. Output saved to: {output_file}")
        return

    demo = build_gradio_app(worker, output_dir=args.output_dir)

    print("=================================================================")
    print("🚀 Starting Wan 2.1 Colab Worker & Gradio API Server...")
    print(f"   Model: {args.model}")
    print(f"   Mode: {'Procedural Mock' if worker.is_mock else 'GPU Wan 2.1 Pipeline'}")
    print(f"   Port: {args.port}")
    print(f"   Share Mode: {args.share}")
    print("=================================================================")

    demo.launch(
        server_name="0.0.0.0",
        server_port=args.port,
        share=args.share,
        quiet=False
    )

    if hasattr(demo, "share_url") and demo.share_url:
        print(f"\n🔗 Public Gradio Share URL: {demo.share_url}")
        with open("gradio_url.txt", "w") as f:
            f.write(demo.share_url)
        print("   (Saved to gradio_url.txt for automated pipeline discovery)\n")


if __name__ == "__main__":
    main()
