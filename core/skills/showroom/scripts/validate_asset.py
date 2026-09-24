#!/usr/bin/env python3
import sys
import os
import argparse
import subprocess
import json

def get_media_info(filepath):
    try:
        cmd = [
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_format", "-show_streams", filepath
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return json.loads(result.stdout)
    except Exception as e:
        return None

def validate_asset(filepath, expected_ratio=None, expected_codec=None):
    if not os.path.exists(filepath):
        print(f"REJECTED: File {filepath} does not exist.")
        return False
        
    info = get_media_info(filepath)
    if not info or not info.get("streams"):
        print(f"REJECTED: Could not probe {filepath}. Ensure it is a valid media file.")
        return False

    video_stream = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    if not video_stream:
        print(f"REJECTED: No video stream found in {filepath}.")
        return False

    width = int(video_stream.get("width", 0))
    height = int(video_stream.get("height", 0))
    codec = video_stream.get("codec_name", "")

    if width == 0 or height == 0:
        print(f"REJECTED: Invalid dimensions {width}x{height}.")
        return False

    actual_ratio = width / height
    
    # 2% tolerance
    if expected_ratio:
        if abs(actual_ratio - expected_ratio) / expected_ratio > 0.02:
            print(f"REJECTED: Aspect ratio {actual_ratio:.2f} ({width}x{height}) is out of 2% tolerance for target {expected_ratio:.2f}. Please crop or recreate the asset.")
            return False

    if expected_codec:
        if codec != expected_codec:
            print(f"REJECTED: Codec {codec} does not match expected {expected_codec}.")
            return False
            
    print(f"PASS: Asset {filepath} validated successfully ({width}x{height}, {codec}).")
    return True

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("file", help="Path to asset file")
    parser.add_argument("--ratio", type=float, help="Expected aspect ratio (e.g. 1.77 for 16:9)")
    parser.add_argument("--codec", type=str, help="Expected codec (e.g. h264)")
    
    args = parser.parse_args()
    validate_asset(args.file, args.ratio, args.codec)
