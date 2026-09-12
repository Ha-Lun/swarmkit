#!/bin/bash
set -euo pipefail

# ==============================================================================
# Headless 3D Animation Pipeline via Google Colab CLI
# ==============================================================================

PROMPT=""
CAMERA="orbit_360"
FRAMES=81
FPS=30
OUTPUT_DIR="./public/frames/3d-animation"
GPU="T4"
KEEP_VM=false
MOCK_MODE=false
RESOLUTION="832x480"
UPSCALE="2560x1440"
DRIVE=true
FP8=true
STEPS=30
HF_TOKEN=""

show_help() {
  cat << 'HELP_EOF'
Usage: ./scripts/colab_run_wan2.sh [OPTIONS]

Required:
  -p, --prompt <string>         Prompt describing the subject or scene.

Options:
  -c, --camera <preset>         Camera trajectory preset (default: orbit_360).
  -o, --output-dir <path>       Target frames directory (default: ./public/frames/3d-animation).
  -f, --frames <int>            Number of video frames (default: 81).
  --fps <int>                   Frame rate for extraction (default: 30).
  -u, --upscale <res>           Upscale frames (default: 2560x1440, none for native).
  --gpu <type>                  GPU type to provision (default: T4).
  --keep                        Do not stop the Colab VM after run.
  --mock                        Dry-run mock animation mode.
  --drive                       Enable Google Drive caching (default: auto).
  --no-drive                    Disable Google Drive caching.
  --fp8                         Enable FP8 quantization (default: auto).
  --no-fp8                      Disable FP8 quantization.
  --steps <int>                 Diffusion steps (default: 30).
  --hf-token <token>            HuggingFace Token.
  -h, --help                    Show this help message.
HELP_EOF
}

# Parse command line options
while [[ $# -gt 0 ]]; do
  case $1 in
    -p|--prompt)
      PROMPT="$2"
      shift 2
      ;;
    -c|--camera)
      CAMERA="$2"
      shift 2
      ;;
    -r|--resolution)
      RESOLUTION="$2"
      shift 2
      ;;
    -u|--upscale)
      UPSCALE="$2"
      shift 2
      ;;
    -o|--output-dir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    -f|--frames)
      FRAMES="$2"
      shift 2
      ;;
    --fps)
      FPS="$2"
      shift 2
      ;;
    --gpu)
      GPU="$2"
      shift 2
      ;;
    --keep)
      KEEP_VM=true
      shift
      ;;
    --mock)
      MOCK_MODE=true
      shift
      ;;
    --drive)
      DRIVE=true
      shift
      ;;
    --no-drive)
      DRIVE=false
      shift
      ;;
    --fp8)
      FP8=true
      shift
      ;;
    --no-fp8)
      FP8=false
      shift
      ;;
    --steps)
      STEPS="$2"
      shift 2
      ;;
    --hf-token)
      HF_TOKEN="$2"
      shift 2
      ;;
    -h|--help)
      show_help
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      show_help
      exit 1
      ;;
  esac
done

if [ -z "$PROMPT" ]; then
  echo "Error: --prompt is required." >&2
  show_help
  exit 1
fi

echo "================================================================="
echo "🚀 Wan 2.1 Headless Generation (Colab CLI)"
echo "================================================================="
echo "  Prompt:       $PROMPT"
echo "  Camera:       $CAMERA"
echo "  Frames:       $FRAMES"
echo "  Target FPS:   $FPS"
echo "  GPU:          $GPU"
echo "  Output Dir:   $OUTPUT_DIR"
echo "  Mock Mode:    $MOCK_MODE"
echo "================================================================="

# 1. Verify colab CLI is installed
if ! command -v colab &>/dev/null; then
  echo "Error: 'colab' CLI is not installed."
  echo "Please install it by running: ./install.sh --colab"
  exit 1
fi

# 2. Check active session or provision one
echo "Checking Colab session..."
if ! colab status 2>/dev/null | grep -Eq "(Running|IDLE|BUSY)"; then
  echo "No active session found. Provisioning new session with GPU: $GPU..."
  colab new --gpu "$GPU"
else
  echo "Active session found."
fi

# 3. Upload and execute scripts/wan2_colab_worker.py remotely
REMOTE_OUTPUT_DIR="/content/outputs"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_SCRIPT="$SCRIPT_DIR/wan2_colab_worker.py"

echo "Executing worker script remotely..."
CMD_ARGS=(
  "--prompt" "$PROMPT"
  "--camera" "$CAMERA"
  "--frames" "$FRAMES"
  "--fps" "$FPS"
  "--output-dir" "$REMOTE_OUTPUT_DIR"
  "--resolution" "$RESOLUTION"
  "--steps" "$STEPS"
)

if [ "$DRIVE" = true ]; then
  CMD_ARGS+=("--drive")
else
  CMD_ARGS+=("--no-drive")
fi

if [ "$FP8" = true ]; then
  CMD_ARGS+=("--fp8")
else
  CMD_ARGS+=("--no-fp8")
fi

if [ -n "$HF_TOKEN" ]; then
  CMD_ARGS+=("--hf-token" "$HF_TOKEN")
fi

if [ "$MOCK_MODE" = true ]; then
  CMD_ARGS+=("--mock")
fi

TEMP_WORKER=$(mktemp /tmp/worker_XXXXXX.py)
trap 'rm -f "$TEMP_WORKER"' EXIT INT TERM
cat <<EOF > "$TEMP_WORKER"
import sys
import shlex
sys.argv = ["wan2_colab_worker.py"] + shlex.split('$(printf "%q " "${CMD_ARGS[@]}")')
EOF
cat "$WORKER_SCRIPT" >> "$TEMP_WORKER"

colab exec --timeout 900 -f "$TEMP_WORKER"
rm -f "$TEMP_WORKER"

# 4. Download the resulting .mp4 video
echo "Finding resulting video on Colab..."
TEMP_FIND_WORKER=$(mktemp /tmp/worker_find_XXXXXX.py)
cat <<EOF > "$TEMP_FIND_WORKER"
import os
try:
    files = [f for f in os.listdir('$REMOTE_OUTPUT_DIR') if f.endswith('.mp4')]
    if files:
        print(files[0])
except Exception:
    pass
EOF

REMOTE_FILE=$(colab exec -f "$TEMP_FIND_WORKER" | tail -n 1 | tr -d '\r')
rm -f "$TEMP_FIND_WORKER"

if [ -z "$REMOTE_FILE" ]; then
  echo "Error: No .mp4 file found remotely."
  if [ "$KEEP_VM" = false ]; then
    colab stop
  fi
  exit 1
fi

echo "Downloading resulting video $REMOTE_FILE..."
TEMP_DOWNLOAD_DIR=$(mktemp -d /tmp/colab_outputs_XXXXXX)
trap 'rm -rf "$TEMP_DOWNLOAD_DIR"' EXIT

colab download "$REMOTE_OUTPUT_DIR/$REMOTE_FILE" "$TEMP_DOWNLOAD_DIR/$REMOTE_FILE"
VIDEO_FILE="$TEMP_DOWNLOAD_DIR/$REMOTE_FILE"
if [ ! -f "$VIDEO_FILE" ]; then
  echo "Error: No .mp4 file downloaded."
  if [ "$KEEP_VM" = false ]; then
    colab stop
  fi
  exit 1
fi

# 5. Extract frames
echo "Slicing video into frames..."
mkdir -p "$OUTPUT_DIR"
bash "$SCRIPT_DIR/extract-frames.sh" "$VIDEO_FILE" "$OUTPUT_DIR" webp "$FPS" 90 "$UPSCALE"

# 6. Stop the VM unless --keep
if [ "$KEEP_VM" = false ]; then
  echo "Stopping Colab VM..."
  colab stop
else
  echo "Keeping Colab VM running as requested."
fi

echo "✅ Pipeline complete! Frames saved to $OUTPUT_DIR"
