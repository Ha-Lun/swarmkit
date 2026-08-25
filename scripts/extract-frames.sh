#!/bin/bash

# Usage: ./extract-frames.sh <input.mp4>
# Extracts frames at 30fps as JPEG into public/frames/

if [ -z "$1" ]; then
  echo "Usage: $0 <input.mp4>"
  exit 1
fi

INPUT_FILE="$1"
OUTPUT_DIR="public/frames"

mkdir -p "$OUTPUT_DIR"

ffmpeg -i "$INPUT_FILE" -vf "fps=30" -qscale:v 2 "$OUTPUT_DIR/frame_%04d.jpg"

echo "Frames extracted to $OUTPUT_DIR"
