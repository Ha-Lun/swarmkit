---
name: showroom
description: Comprehensive reference for Showroom subagents covering state lifecycle, asset validation, and Google Flow prompt templates.
---

# Showroom Skill Reference

This skill provides utilities for state management and asset validation for the Showroom subagent swarm.

## 1. State Management (`.showroom/state.json`)

The `state.json` file dictates the execution lifecycle. Showroom reads this on invocation to ensure lossless resumption.

**Schema:**
```json
{
  "project": "<string>",
  "stage": "S0_PREFLIGHT | S1_INTAKE | S2_DESIGN_SYSTEM | S3_ASSET_REQUEST | S4_INGEST | S5_SCAFFOLD | S6_SECTIONS | S7_MOTION | S8_3D | S9_QA | S10_DEPLOY",
  "gate": "AWAITING_HUMAN | CLEAR",
  "current_gate_name": "G1 | G2 | G3 | G4 | G5 | NONE",
  "assets": {
    "AR-01": {
      "status": "requested | received | validated | rejected | placeholder",
      "file": "<path>",
      "notes": "<string>"
    }
  },
  "decisions": [],
  "assumptions": [],
  "open_questions": [],
  "placeholders_outstanding": []
}
```

Use `skill/showroom/scripts/state.py` to read and update this state.

## 2. Asset Validation Logic

Assets dropped in `/assets/raw` must be validated.
- **Tolerance**: Aspect ratio tolerance is <= 2%.
- **Images**: Validated for resolution and aspect ratio. Rejected if skewed.
- **Video**: Codec (must be transcodable), duration limits, and resolution checks.

Use `skill/showroom/scripts/validate_asset.py` to perform these checks. It outputs pass or exact rejection messages.

## 3. Google Flow Prompt Templates & Generation

Human-in-the-loop requires precise instructions for Google Flow.

**Veo 3.1 Video:**
> "Cinematic 4k product shot of [Product], [Environment], [Lighting], smooth tracking shot."

**Nano Banana Pro Image:**
> "High-end product photography of [Product], dark studio background, dramatic lighting, 8k resolution, photorealistic."

**Human Instructions:**
1. Open Google Flow UI.
2. Select the respective model.
3. Paste the generated prompt.
4. Download the result and place it in `/assets/raw`.

## 4. 10-Section Structural Pattern

1. **Sticky subnav**: Tracks scroll position.
2. **Hero**: Uses GSAP word-by-word reveal.
3. **Key visual**: 21:9 aspect ratio media.
4. **Value props**: Grid layout.
5. **Feature showcase**: Staggered reveals.
6. **Use cases**: Bento box UI.
7. **Trust block**: Logo farm or testimonials.
8. **Related carousel**: Hover to swap preview images.
9. **3D viewer + AR QR**: Conditional `<model-viewer>`.
10. **Final CTA + footer**: Large typography closure.

All sections built in Astro + Tailwind CSS.
