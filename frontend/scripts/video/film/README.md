# SkyBao 40-second film

This folder turns the editor-neutral SkyBao UI library into a finished, silent-narration product film with deterministic instrumental music and restrained interaction sound effects. The edit is built in Blender's Video Sequence Editor so it remains easy to open, trim, restyle, and re-render.

## Render

Generate the complete UI library first if `artifacts/skybao-ui/catalog.json` is missing:

```bash
yarn video:assets
```

Then run one of the film targets from the repository root:

```bash
# 960x540 review MP4; the default
yarn video:film

# Save the editable Blender project without rendering video
yarn video:film --build-only

# 1920x1080, 30 fps, 40-second H.264 master
yarn video:film --final
```

Add `--keep-frames` to retain the intermediate PNG render sequence. Otherwise the verified frames are removed after encoding to avoid leaving a large redundant cache.

The runner looks for Blender at `/Applications/Blender.app/Contents/MacOS/Blender` and FFmpeg under Homebrew, then falls back to executables on `PATH`. Override any executable explicitly when needed:

```bash
BLENDER_BIN=/path/to/blender \
FFMPEG_BIN=/path/to/ffmpeg \
FFPROBE_BIN=/path/to/ffprobe \
yarn video:film --final
```

## Output

Generated files are intentionally ignored by Git:

```text
artifacts/skybao-film/
├── skybao-film.blend
├── audio/skybao-mix.wav
├── deliverables/
│   ├── skybao-40s-preview.mp4
│   ├── skybao-40s-master.mp4
│   └── render-report-{preview|final}.json
└── frames/{preview|final}/          # only with --keep-frames
```

The render report verifies duration, frame rate, dimensions, audio format, and SHA-256 hashes. The final encode is H.264/yuv420p with BT.709 metadata, fast start, stereo 48 kHz AAC, and an audio target of -16 LUFS / -1.5 dBTP.

## Editorial structure

`shotlist.json` is the source of truth: fourteen contiguous shots, exactly 1,200 frames at 30 fps. It uses only real views and interactions already captured from the SkyBao mock:

1. Assistant establish and global Ask SkyBao
2. Research cascade and live answer typing
3. Knowledge search, source preview, and data analysis
4. Communications selection, draft review, and task conversion
5. Work board drag, approval, and agent-run detail
6. Assistant return and closing control message

Blender adds the editorial layer: cloud staging, straight-alpha compositing, per-shot Z-axis pushes and pans, short crossfades, section typography, sliding panels, dropping dots, moving flow lines, a subtle cinematic frame, and the closing dim-out. The source clips provide the actual UI interactions; the edit does not fabricate unsupported Word or node-canvas product surfaces.

## Files to edit

- `shotlist.json` — timing, clip trims, camera start/end values, transitions, and SFX cues.
- `build-blender.py` — VSE construction, type, branded overlays, and camera animation.
- `generate-audio.mjs` — deterministic score and per-shot sound design.
- `validate.mjs` — source, timing, and audio assertions.
- `render.mjs` — Blender/FFmpeg orchestration and delivery validation.

To review a few frames without rendering the whole film, run the builder directly:

```bash
/Applications/Blender.app/Contents/MacOS/Blender \
  --background --factory-startup \
  --python frontend/scripts/video/film/build-blender.py -- \
  --repo "$PWD" \
  --out "$PWD/artifacts/skybao-film/skybao-film.blend" \
  --samples 30,150,300,540,700,900,1100,1190
```

Sample images are written to `artifacts/skybao-film/review/`.
