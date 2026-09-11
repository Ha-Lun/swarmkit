# Google Colab CLI 3D Animation Pipeline

This guide details the headless 3D animation generation pipeline powered by **Wan 2.1** and the official **Google Colab CLI (`google-colab-cli`)**.

## 1. Overview

By default, the `animation-specialist` agent and local scripts use the **Colab CLI Mode** to generate 3D assets. This allows direct allocation of a Colab GPU from your local terminal, remote model execution, and direct MP4 downloading—all without opening a browser or relying on a middleman (like n8n).

### Why Colab CLI?
- **Zero Configuration**: No Gradio tunnels, ngrok, or webhook setup required.
- **Fully Headless**: Entire lifecycle from GPU provisioning to VM teardown happens in the background.
- **Direct Asset Delivery**: The `.mp4` downloads directly to your workspace and is automatically sliced for the web.

## 2. Installation & Authentication

You must install and authenticate the `google-colab-cli` once.

```bash
# Run the SwarmKit installer with the colab flag
./install.sh --colab
```

**What this does:**
1. Installs `google-colab-cli` via `uv` or `pip`.
2. Prompts you to authenticate via Google OAuth (`colab auth login`). A link will appear in your terminal—click it, sign in with your Google account, and paste the code back.

## 3. Usage & CLI Reference

You can trigger the pipeline manually or let an agent run it.

```bash
./scripts/trigger-3d-animation.sh \
  --prompt "cyberpunk hovercar, metallic finish" \
  --camera orbit_360 \
  --frames 81 \
  --mode colab-cli
```

### Pipeline Lifecycle
1. **VM Provisioning**: The script runs `colab new --gpu T4` to grab a fresh instance (or reuses an active one).
2. **Remote Execution**: `scripts/wan2_colab_worker.py` is executed remotely with your parameters.
3. **Download**: `colab download` fetches the MP4 to your machine.
4. **Processing**: `scripts/extract-frames.sh` slices the video into a `public/frames` sequence.
5. **Teardown**: The script runs `colab stop` to conserve compute units.

### Optional Flags
- `--gpu <GPU_TYPE>`: Default is `T4`. For full 832x480 at 81 frames, recommend `--gpu A100` (or `L4`). On `T4`, generation must be scaled down to 640x360 / 49 frames.
- `--keep`: Do not stop the Colab VM after the run. Useful if you plan to generate multiple animations in quick succession.
- `--mock`: Runs the python worker in procedural mock mode. Generates a placeholder spinning cube animation (requires no GPU, useful for testing the pipeline).
- `--drive` / `--no-drive`: Auto-mounts your Google Drive at `/content/drive/MyDrive` to permanently cache the 28.9 GB model. Subsequent runs bypass the 30GB download, yielding 0-second model load times. Default is on.
- `--fp8` / `--no-fp8`: Applies FP8 quantization (`torch.float8_e4m3fn`). **Note:** FP8 requires compute capability >= 8.9 (e.g. Ada Lovelace / Hopper / L4 / A100). Do NOT enable FP8 on T4 GPUs (compute 7.5); T4 must use `torch.float16`.
- `--steps <int>`: Fast diffusion sampling steps. Supports 15-25 for rapid preview, default is 30.
- `--hf-token <token>`: Forward your Hugging Face API token securely to bypass download rate limits, or set `$HF_TOKEN` in your environment. Never commit tokens to git.

## 4. Cost and Quota Optimization Tips

Google Colab provides limited compute units for free tier users.
- **Use `--mock` for UI dev**: When building your website's scrolling logic or `CanvasScrubber.tsx`, use the mock mode. It takes seconds and costs zero compute.
- **Free GPU (T4)**: T4 is free and capable of running the Wan 2.1 1.3B model at reduced resolution (640x360, 49 frames) in FP16.
- **Colab Pro (A100 / L4)**: Google AI Pro subscription provides A100 (40GB/80GB) and L4 (24GB) runtimes that handle full 832x480 81-frame 3D attention natively without OOM.
- **Automatic Teardown**: Always ensure the VM is stopped when not in use. The wrapper scripts handle this automatically unless you pass `--keep`. If a process crashes, you can manually run `colab stop` to halt the active session.

## 5. Operational Constraints & Learned Fixes

Permanent operational rules and architectural constraints established for Wan 2.1 Colab execution (see also `.agents/rules/wan2-colab-pipeline.md`):

### 1. Hardware & Quantization Compatibility
- **FP8 Requirements**: FP8 (`torch.float8_e4m3fn`) requires GPU compute capability >= 8.9 (Ada/Hopper architectures, e.g. H100, RTX 4090, L4).
- **T4 Incompatibility**: Tesla T4 GPUs (Turing architecture, compute capability 7.5) cannot execute FP8 ops and will throw:
  `NotImplementedError: Could not run 'aten::empty_strided' with arguments from the 'Float8_e4m3fnStorage' backend`
- **Rule**: Never enable FP8 on Tesla T4. Tesla T4 runtimes MUST use `torch.float16`.

### 2. Attention Scaling & 48 GiB VRAM Spike
- **Activation Memory**: At 832x480 resolution with 81 frames, Wan 2.1 creates 32,760 tokens. Full un-sliced 3D attention requires ~48 GiB of transient activation memory during diffusion sampling.
- **T4 OOM**: On 16 GB GPUs (T4), this triggers a fatal CUDA OOM inside `scaled_dot_product_attention`.
- **Resolution on Colab**:
  - **Recommended**: Provision `--gpu A100` (Google AI Pro provides A100 40GB/80GB or L4 24GB runtimes which handle full 832x480 81-frame 3D attention natively).
  - **T4 Fallback**: Reduce resolution to `640x360` and frames to `49` frames when running on T4 hardware.

### 3. Colab Host RAM (12.7 GB) & The Swap Freeze
- **Host RAM Bottleneck**: Standard Colab instances provide only ~12.7 GB of host system RAM.
- **Swap Freeze**: Loading `WanPipeline` without an explicit device map loads 14 GB of unquantized weights into system RAM, saturating memory and freezing Colab swap for up to 3600 seconds.
- **Direct GPU Streaming**: Always load the model with `device_map="balanced"` and `low_cpu_mem_usage=True` so weights stream directly into GPU memory without blowing host RAM.

### 4. Idempotent Loading & OOM Kernel Crashes
- **Early-Return Guard**: Worker `load_model()` must always be idempotent:
  ```python
  if self.is_loaded and (self.is_mock or self.pipeline is not None):
      return
  ```
- **Avoid Duplicate Invocations**: Never call `load_model()` twice in `main()` or batch flows. Duplicate weight allocations trigger the Linux OOM Killer, terminating the Python runtime with a silent Jupyter kernel crash (`execution_state: restarting`).

### 5. Zero Mock Policy & Error Transparency
- In non-mock mode (`--mock` not passed), the pipeline MUST NEVER fall back to procedural ffmpeg test patterns or synthetic mock outputs upon failure.
- All CUDA OOMs, model initialization issues, and runtime errors must be re-raised immediately with full tracebacks.

### 6. Credential Privacy
- Never commit `HF_TOKEN`, OAuth tokens, or private endpoint URLs into git.
- Always read credentials from environment variables (`$HF_TOKEN`) or prompt interactively.

