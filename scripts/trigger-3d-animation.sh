#!/bin/bash
set -eo pipefail

# ==============================================================================
# 3D Animation Pipeline Trigger Script
# Dispatches generation requests to n8n webhook (or directly to Colab worker)
# and monitors frame extraction into target public frames directory.
# ==============================================================================

PROMPT=""
CAMERA_MOTION="orbit_360"
RESOLUTION="832x480"
UPSCALE="2560x1440"
FRAME_COUNT="81"
FPS="30"
SEED="-1"
DRIVE=true
FP8=true
STEPS="30"
HF_TOKEN="${HF_TOKEN:-}"
OUTPUT_DIR="./public/frames"
COLAB_URL="${WAN2_COLAB_URL:-}"
N8N_URL="${N8N_WEBHOOK_URL:-http://localhost:5678/webhook/generate-3d-animation}"
MODE="colab-cli"
MOCK_MODE=false
TIMEOUT_SECONDS=600

show_help() {
  cat << 'HELP_EOF'
Usage: ./scripts/trigger-3d-animation.sh [OPTIONS]

Required:
  -p, --prompt <string>         Prompt describing the subject or scene.

Options:
  -c, --camera <preset>         Camera trajectory preset (default: orbit_360).
                                Choices: orbit_360, orbit_180, pan_left, pan_right,
                                         tilt_up, tilt_down, zoom_in, zoom_out, spiral.
  -o, --output-dir <path>       Target frames directory (default: ./public/frames).
  -r, --resolution <WxH>        Resolution (default: 832x480).
                                Choices: 832x480, 1280x720, 480x832, 720x1280.
  -u, --upscale <res>           Upscale frames (default: 2560x1440, none for native).
  -f, --frames <int>            Number of video frames (default: 81).
  --fps <int>                   Frame rate for extraction (default: 30).
  -s, --seed <int>              RNG seed (-1 for random, default: -1).
  --drive                       Enable Google Drive caching (default: auto).
  --no-drive                    Disable Google Drive caching.
  --fp8                         Enable FP8 quantization (default: auto).
  --no-fp8                      Disable FP8 quantization.
  --steps <int>                 Diffusion steps (default: 30).
  --hf-token <token>            Hugging Face token (default: $HF_TOKEN).
  --colab-url <url>             Gradio / Colab share URL (e.g. https://xxx.gradio.live).
                                (Reads from $WAN2_COLAB_URL if omitted).
  --n8n-url <url>               n8n webhook URL (default: http://localhost:5678/webhook/generate-3d-animation).
  --mode <mode>                 Execution mode: colab-cli (default) or n8n.
  --mock                        Dry-run mock animation mode.
  -h, --help                    Show this help message.

Examples:
  ./scripts/trigger-3d-animation.sh --prompt "cyberpunk hovercar, metallic finish" --camera orbit_360
  ./scripts/trigger-3d-animation.sh --prompt "ancient stone statue" --camera pan_left --resolution 1280x720
  ./scripts/trigger-3d-animation.sh -p "mech warrior" --colab-url "https://xxxx.gradio.live"
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
      CAMERA_MOTION="$2"
      shift 2
      ;;
    -o|--output-dir)
      OUTPUT_DIR="$2"
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
    -f|--frames)
      FRAME_COUNT="$2"
      shift 2
      ;;
    --fps)
      FPS="$2"
      shift 2
      ;;
    -s|--seed)
      SEED="$2"
      shift 2
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
    --colab-url)
      COLAB_URL="$2"
      shift 2
      ;;
    --n8n-url)
      N8N_URL="$2"
      shift 2
      ;;
    --mode)
      MODE="$2"
      shift 2
      ;;
    --mock)
      MOCK_MODE=true
      shift
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

# Ensure output directory is an absolute path
OUTPUT_DIR=$(mkdir -p "$OUTPUT_DIR" && cd "$OUTPUT_DIR" && pwd)

echo "================================================================="
echo "🎬 Wan 2.1 3D Animation Pipeline Trigger"
echo "================================================================="
echo "  Prompt:       $PROMPT"
echo "  Camera:       $CAMERA_MOTION"
echo "  Resolution:   $RESOLUTION"
echo "  Frames:       $FRAME_COUNT"
echo "  Target FPS:   $FPS"
echo "  Seed:         $SEED
  Steps:        $STEPS
  Drive:        $DRIVE
  FP8:          $FP8"
echo "  Output Dir:   $OUTPUT_DIR"
echo "  Mode:         $MODE"
echo "  Mock Mode:    $MOCK_MODE"
echo "================================================================="

mkdir -p "$OUTPUT_DIR"

if [ "$MODE" = "colab-cli" ]; then
  echo "🚀 Delegating to colab_run_wan2.sh..."
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  COLAB_ARGS=(--prompt "$PROMPT" --camera "$CAMERA_MOTION" --frames "$FRAME_COUNT" --fps "$FPS" --output-dir "$OUTPUT_DIR" --steps "$STEPS" --resolution "$RESOLUTION" --upscale "$UPSCALE")
  if [ "$DRIVE" = true ]; then
    COLAB_ARGS+=(--drive)
  else
    COLAB_ARGS+=(--no-drive)
  fi
  if [ "$FP8" = true ]; then
    COLAB_ARGS+=(--fp8)
  else
    COLAB_ARGS+=(--no-fp8)
  fi
  if [ -n "$HF_TOKEN" ]; then
    COLAB_ARGS+=(--hf-token "$HF_TOKEN")
  fi
  if [ "$MOCK_MODE" = true ]; then
    COLAB_ARGS+=(--mock)
  fi
  bash "$SCRIPT_DIR/colab_run_wan2.sh" "${COLAB_ARGS[@]}"
elif [ "$MODE" = "n8n" ]; then
  # Via n8n Webhook
  PAYLOAD=$(jq -n \
    --arg prompt "$PROMPT" \
    --arg camera "$CAMERA_MOTION" \
    --arg res "$RESOLUTION" \
    --argjson frames "$FRAME_COUNT" \
    --argjson fps "$FPS" \
    --argjson seed "$SEED" \
    --arg output "$OUTPUT_DIR" \
    --arg colab "$COLAB_URL" \
    '{
      prompt: $prompt,
      camera_motion: $camera,
      resolution: $res,
      frame_count: $frames,
      fps: $fps,
      seed: $seed,
      output_dir: $output,
      colab_url: (if $colab != "" then $colab else null end)
    }')

  echo "🚀 Submitting generation request to n8n webhook: $N8N_URL ..."
  
  RESPONSE=$(curl -fsSL -X POST "$N8N_URL" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    --max-time "$TIMEOUT_SECONDS")

  echo "✅ n8n Pipeline Response received:"
  echo "$RESPONSE" | jq . || echo "$RESPONSE"
else
  echo "Error: Unknown mode $MODE. Use colab-cli or n8n."
  exit 1
fi

# Verification
if [ -f "$OUTPUT_DIR/manifest.json" ]; then
  FRAME_COUNT_ACTUAL=$(jq -r '.frameCount // 0' "$OUTPUT_DIR/manifest.json")
  echo ""
  echo "🎉 Success! $FRAME_COUNT_ACTUAL frames generated and saved to: $OUTPUT_DIR"
  echo "📄 Manifest: $OUTPUT_DIR/manifest.json"
  echo "🖼️ Sample Frame: $OUTPUT_DIR/frame_0001.webp"
else
  echo ""
  echo "⚠️ Warning: manifest.json was not found at $OUTPUT_DIR/manifest.json. Check pipeline logs."
fi
