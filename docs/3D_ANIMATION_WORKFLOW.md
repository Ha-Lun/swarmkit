# 3D Animation & Asset Ingestion Workflow

This document provides operational guidance for both the user and swarm agents on the standard human-in-the-loop workflow for 3D animations and interactive turntables.

## Recommended Free Video Generation Tools
- [Kling AI](https://klingai.com/)
- [Luma Dream Machine](https://lumalabs.ai/dream-machine)
- [Runway Gen-3](https://runwayml.com/)
- [Haiper](https://haiper.ai/)
- [Hugging Face](https://huggingface.co/spaces)

## Prompt Formulas for High-Quality Assets
- **Product Turntables**: `Studio lighting, high resolution, 360-degree orbit of a [Product Name], resting on a minimalist pedestal, clean background, photorealistic.`
- **Luxury Assets**: `Cinematic lighting, slow rotation around a [Luxury Item], rich textures, soft reflections, dark background, 8k resolution, macro lens.`
- **Tech Devices**: `Dramatic rim lighting, orbit_360 view of a [Device Name], sleek and modern, glowing accents, floating in a dark environment, highly detailed.`
- **Characters**: `Full-body 360 turnaround of a [Character Description], neutral lighting, standing in an A-pose, simple grey background, detailed textures.`

## Usage
1. Generate the video asset using one of the tools above.
2. Save the output video to `public/frames/raw.mp4`.
3. Run the ingestion script to process the video into web-optimized frames:
   ```bash
   ./scripts/ingest-video.sh
   ```
4. The script will output WebP frames and a `manifest.json` in `public/frames/`.
5. Preview the interactive result at `http://localhost:8081`.
