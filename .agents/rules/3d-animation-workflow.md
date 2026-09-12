---
trigger: model_decision
description: Standard procedure for human-in-the-loop 3D animation generation, video asset ingestion, and interactive scroll scrubbing
---
# 3D Animation & Asset Ingestion Workflow

This rule defines the human-in-the-loop process for generating and ingesting 3D animation/turntable assets.

## Protocol
1. **Specify Requirements**: Swarm specifies the prompt, camera trajectory (e.g., `orbit_360`), recommended duration (3-5s), and the drop path (`public/frames/raw.mp4`).
2. **User Generation**: The user generates the clip online using free tools (Kling AI, Luma Dream Machine, Runway Gen-3, Haiper, etc.) and saves it to `public/frames/raw.mp4`.
3. **Ingestion**: Swarm executes `./scripts/ingest-video.sh`.
4. **Integration**: Swarm connects the resulting `manifest.json` with `CanvasScrubber.tsx` or equivalent canvas scrubber.

## Rules
- **No Headless Cloud GPU**: STRICTLY avoid flaky headless cloud GPU spin-ups unless explicitly requested by the user.
- **Frame Quality**: Ensure 2560x1440 Lanczos upscaling with unsharp masking during ingestion.
