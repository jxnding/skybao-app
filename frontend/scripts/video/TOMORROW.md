# Tomorrow: open and refine the SkyBao film

The 40-second first cut is automated now. You do not need to assemble thousands of PNGs by hand.

## Open the current edit

```bash
open artifacts/skybao-film/skybao-film.blend
open artifacts/skybao-film/deliverables/skybao-40s-master.mp4
```

In Blender, switch to the **Video Editing** workspace. The timeline already contains the fourteen-shot story, transparent UI sequences, cloud stage, camera pushes and pans, crossfades, branded titles, motion accents, and the 40-second music/SFX mix.

## Make a fresh render

```bash
# Fast 960x540 review
yarn video:film

# Delivery-quality 1920x1080 master
yarn video:film --final
```

The final master is exactly 1,200 frames at 30 fps. Generated media stays under `artifacts/skybao-film/` and is versioned alongside the tracked recipe in `frontend/scripts/video/film/`.

## Best places to personalize

- Change shot timing, clip trims, or camera endpoints in `film/shotlist.json`.
- Adjust titles, colors, and editorial overlays in `film/build-blender.py`.
- Change the deterministic instrumental mix or SFX in `film/generate-audio.mjs`.
- In Blender, add your own logo lockup, replace the generated music, or trim beats directly in the VSE.

Keep the existing 1920×1080 / 30 fps / Standard color-management setup. Render a review before changing the final master. Full technical notes are in `frontend/scripts/video/film/README.md`.
