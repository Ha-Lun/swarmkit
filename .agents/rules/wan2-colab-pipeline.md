---
trigger: model_decision
description: Operational constraints, hardware compatibility, and stability rules for the Wan 2.1 Colab 3D animation pipeline
---

# Wan 2.1 Colab Pipeline Operational Rules & Constraints

When developing, configuring, or executing the Wan 2.1 3D animation pipeline on Google Colab (via `google-colab-cli` or remote workers), adhere strictly to these constraints:

## 1. Hardware & Quantization Compatibility
- **FP8 Requirements**: FP8 quantization (`torch.float8_e4m3fn`) strictly requires GPU compute capability >= 8.9 (Ada Lovelace / Hopper architectures, e.g., RTX 4090, L4, H100).
- **Tesla T4 Incompatibility**: Tesla T4 GPUs possess compute capability 7.5 (Turing architecture). Enabling FP8 on a T4 will throw a fatal `Float8_e4m3fnStorage` backend error (`NotImplementedError: Could not run 'aten::empty_strided' with arguments from the 'Float8_e4m3fnStorage' backend`).
- **T4 Rule**: Tesla T4 runtimes MUST use `torch.float16`. Never enable `--fp8` on T4 instances.

## 2. Attention Scaling & 48 GiB VRAM Spike
- **Token Math**: At 832x480 resolution with 81 frames, Wan 2.1 generates 32,760 spatio-temporal tokens.
- **Transient Memory**: Un-sliced 3D spatio-temporal attention across 32,760 tokens requires ~48 GiB of transient activation memory during diffusion denoising.
- **OOM on 16 GB GPUs**: On 16 GB GPUs (such as Tesla T4), full 832x480 at 81 frames triggers a fatal CUDA OOM inside `scaled_dot_product_attention`.
- **Mitigation & Recommendations**:
  - **Colab Pro / Enterprise**: Recommend provisioning `--gpu A100` (Google AI Pro provides A100 40GB/80GB or L4 24GB runtimes), which handle 832x480 81-frame 3D attention natively.
  - **T4 Fallback**: When constrained to a T4 GPU, reduce resolution to 640x360 and frame count to 49 frames, or enable memory-efficient attention slicing.

## 3. Colab Host RAM (12.7 GB) & The Swap Freeze
- **Host RAM Limit**: Standard Colab instances provide only ~12.7 GB of system RAM.
- **Swap Lockup**: Instantiating `WanPipeline` without an explicit device map loads the uncompressed 14 GB model into host RAM first. This exhausts system memory and sends the Linux kernel into heavy disk swapping, freezing the VM for up to 3,600 seconds (1 hour).
- **Direct Streaming**: Always load pipelines using `device_map="balanced"` (or direct CUDA placement) and `low_cpu_mem_usage=True` so model tensors stream directly into VRAM without exhausting host system memory.

## 4. Idempotent Loading & OOM Kernel Crashes
- **Idempotency Guard**: `load_model()` in worker scripts must always be guarded by an early-return check:
  ```python
  if self.is_loaded and (self.is_mock or self.pipeline is not None):
      return
  ```
- **No Duplicate Loads**: Never invoke `load_model()` more than once within `main()` or batch generation loops. Repeated initialization creates duplicate weight allocations in PyTorch memory, which triggers the Linux OOM Killer and silently crashes the Jupyter kernel (`execution_state: restarting`).

## 5. Zero Mock Policy & Error Transparency
- **No Procedural Fallback in Production**: In non-mock mode (when `--mock` is not explicitly requested), worker scripts and wrapper pipelines MUST NEVER silently fall back to procedural ffmpeg test patterns or mock videos.
- **Fail Fast & Loud**: Any CUDA OOM, Hugging Face download failure, or runtime exception must be re-raised immediately with full traceback and diagnostic logging so orchestrators and users detect failures accurately.

## 6. Credential Privacy
- **No Committed Secrets**: Never hardcode or commit `HF_TOKEN`, Google OAuth tokens, or private tunnel endpoints into git.
- **Environment Ingestion**: Always retrieve authentication tokens via environment variables (`os.getenv("HF_TOKEN")` / `$HF_TOKEN`) or prompt interactively outside version control.
