#!/usr/bin/env bash
set -euo pipefail

VIDEO_PATH="${1:-public/frames/raw.mp4}"
OUTPUT_DIR="${2:-public/frames}"
UPSCALE="${3:-2560x1440}"
FPS="${4:-30}"
QUALITY="${5:-90}"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    echo "Usage: ./scripts/ingest-video.sh [VIDEO_PATH] [OUTPUT_DIR] [UPSCALE] [FPS] [QUALITY]"
    echo "Defaults:"
    echo "  VIDEO_PATH: public/frames/raw.mp4"
    echo "  OUTPUT_DIR: public/frames"
    echo "  UPSCALE:    2560x1440"
    echo "  FPS:        30"
    echo "  QUALITY:    90"
    exit 0
fi

if [[ ! -f "$VIDEO_PATH" ]]; then
    echo "Error: Video file '$VIDEO_PATH' not found."
    echo "Please drop your generated video at: $VIDEO_PATH"
    echo "Recommended free tools for generating videos:"
    echo " - Kling AI"
    echo " - Luma Dream Machine"
    echo " - Runway Gen-3"
    echo " - Haiper"
    exit 1
fi

echo "Ingesting video from $VIDEO_PATH into $OUTPUT_DIR..."
bash ./scripts/extract-frames.sh "$VIDEO_PATH" "$OUTPUT_DIR" webp "$FPS" "$QUALITY" "$UPSCALE"

FRAME_COUNT=$(ls -1 "$OUTPUT_DIR"/*.webp 2>/dev/null | wc -l || echo 0)
echo "Extraction complete! Generated $FRAME_COUNT WebP frames."
echo "Manifest info:"
cat "$OUTPUT_DIR/manifest.json" 2>/dev/null || echo "No manifest found."
echo ""
echo "Preview available at: http://localhost:8081"
