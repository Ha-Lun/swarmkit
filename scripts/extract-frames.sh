#!/bin/bash
set -eo pipefail

# Usage: ./extract-frames.sh <input.mp4> [output_dir] [format] [fps] [quality]
# Example: ./extract-frames.sh input.mp4 public/frames webp 30 90

if [ -z "$1" ]; then
  echo "Usage: $0 <input.mp4> [output_dir] [format] [fps] [quality]"
  echo "  output_dir: destination directory (default: public/frames)"
  echo "  format:     webp | jpg | png (default: webp)"
  echo "  fps:        frame rate extraction (default: 30)"
  echo "  quality:    image quality 1-100 (default: 90)"
  exit 1
fi

INPUT_FILE="$1"
OUTPUT_DIR="${2:-public/frames}"
FORMAT="${3:-webp}"
FPS="${4:-30}"
QUALITY="${5:-90}"
SCALE="$6"

if [ ! -f "$INPUT_FILE" ]; then
  echo "Error: Input file '$INPUT_FILE' does not exist." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

# Clean old frames in target directory
rm -f "$OUTPUT_DIR"/frame_*."$FORMAT" "$OUTPUT_DIR"/manifest.json

# Probe video resolution with fallback
WIDTH=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of default=noprint_wrappers=1:nokey=1 "$INPUT_FILE" 2>/dev/null || echo "1920")
HEIGHT=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of default=noprint_wrappers=1:nokey=1 "$INPUT_FILE" 2>/dev/null || echo "1080")

if [ -n "$SCALE" ] && [ "$SCALE" != "none" ]; then
  WIDTH="${SCALE%x*}"
  HEIGHT="${SCALE#*x}"
  VF="fps=${FPS},scale=${WIDTH}:${HEIGHT}:flags=lanczos,unsharp=5:5:0.8:5:5:0.4"
else
  VF="fps=${FPS}"
fi

echo "Extracting frames at ${FPS} fps as .${FORMAT} into ${OUTPUT_DIR}..."

if [ "$FORMAT" = "webp" ]; then
  ffmpeg -y -i "$INPUT_FILE" -vf "$VF" -c:v libwebp -lossless 0 -q:v "${QUALITY}" "$OUTPUT_DIR/frame_%04d.webp" -loglevel error
elif [ "$FORMAT" = "jpg" ] || [ "$FORMAT" = "jpeg" ]; then
  ffmpeg -y -i "$INPUT_FILE" -vf "$VF" -qscale:v 2 "$OUTPUT_DIR/frame_%04d.jpg" -loglevel error
elif [ "$FORMAT" = "png" ]; then
  ffmpeg -y -i "$INPUT_FILE" -vf "$VF" "$OUTPUT_DIR/frame_%04d.png" -loglevel error
else
  # Default fallback to webp
  FORMAT="webp"
  ffmpeg -y -i "$INPUT_FILE" -vf "$VF" -c:v libwebp -lossless 0 -q:v "${QUALITY}" "$OUTPUT_DIR/frame_%04d.webp" -loglevel error
fi

FRAME_COUNT=$(find "$OUTPUT_DIR" -maxdepth 1 -name "frame_*.${FORMAT}" | wc -l)

if [ "$FRAME_COUNT" -eq 0 ]; then
  echo "Error: No frames extracted from $INPUT_FILE" >&2
  exit 2
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Generate manifest.json for CanvasScrubber
cat << MANIFEST_EOF > "$OUTPUT_DIR/manifest.json"
{
  "frameCount": ${FRAME_COUNT},
  "width": ${WIDTH},
  "height": ${HEIGHT},
  "fps": ${FPS},
  "format": "${FORMAT}",
  "framePattern": "frame_%04d.${FORMAT}",
  "samplePath": "frame_0001.${FORMAT}",
  "generatedAt": "${TIMESTAMP}"
}
MANIFEST_EOF

echo "Successfully extracted ${FRAME_COUNT} frames to ${OUTPUT_DIR}"
echo "Manifest created at ${OUTPUT_DIR}/manifest.json"

# Emit JSON result to stdout for n8n or CLI scripts
cat "$OUTPUT_DIR/manifest.json"
