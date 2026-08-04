# SkyBao video asset library

This capture recipe turns the query-gated SkyBao mock into an editor-neutral library of transparent UI stills and numbered PNG sequences. It does not create a final edit or require the AnythingLLM backend.

## Generate assets

From the repository root:

```bash
yarn video:assets
```

The capture tool requires Node 22.12 or newer; this requirement is isolated from the Node 18-compatible application and CI dependencies. The command installs its pinned tooling package, builds the frontend, serves the production bundle through a private local preview, captures at 1920×1080 and 30 fps, validates the result, and writes it to `artifacts/skybao-ui/`. The current generated library is checked into Git for a self-contained video handoff, so rerunning the capture will produce normal tracked media changes.

Useful targeted runs:

```bash
yarn video:assets --only=assistant-answer-typing,work-board-drag
yarn video:assets --stills-only
yarn video:assets --clips-only --smoke
yarn video:assets --out=/absolute/path/to/skybao-ui
yarn video:assets --skip-build --base-url=http://127.0.0.1:4173
```

`--smoke` advances every interaction through its complete timeline but saves only the start, middle, and end frames. It is for fast selector and alpha validation, not editing. Unless `--out` is supplied, smoke runs write to `artifacts/skybao-ui-smoke/` so they cannot replace the complete library in `artifacts/skybao-ui/`.

The default command builds with `VITE_SKYBAO_CAPTURE=1`. Artifact mode is compiled out of ordinary production builds, so query parameters cannot bypass the normal application shell or authentication flow. Use `--skip-build` only after a capture-enabled build; a custom `--base-url` must likewise have been started with that environment flag.

## Artifact layout

```text
artifacts/skybao-ui/
├── catalog.json
├── checksums.sha256
├── contact-sheet.html
├── cursor/cursor.svg
├── stills/{shell|workspace}/{area}/{asset}.png
└── clips/{area}/{asset}/
    ├── frame-000001.png
    ├── …
    └── timeline.json
```

All imagery is dark-mode, silent, sRGB RGBA PNG at 1920×1080. The transparent pixels use straight alpha. Motion footage is workspace-only; baseline stills are provided with both the full product shell and the isolated rounded workspace.

The browser cursor is never baked into the UI. Each `timeline.json` contains pixel coordinates (`x`, `y`), normalized coordinates (`nx`, `ny`), and `move`, `down`, `up`, or `click` events. Place `cursor/cursor.svg` on a separate editor layer and keyframe it from those events.

## Editing in Blender

1. Create a 1920×1080 project at 30 fps.
2. Put the background, footage, or 3D scene on a lower channel.
3. Add the desired `frame-000001.png` sequence as an Image/Sequence strip.
4. Interpret the strip as **Straight Alpha** and composite it over the background.
5. Add `cursor.svg` above the UI and keyframe it from the matching `timeline.json` when a pointer is useful.
6. Select and prune the modules needed for the story, then add camera moves, titles, music, and sound effects.
7. Export the finished edit to the required delivery codec, such as H.264 for a review or web master.

Blender references: [Image/Sequence Strip](https://docs.blender.org/manual/en/latest/video_editing/edit/montage/strips/image.html) and [ImageStrip alpha modes](https://docs.blender.org/api/current/bpy.types.ImageStrip.html).

## Capture-only interface

The renderer composes normal mock routes with these query parameters:

```text
capture=transparent&artifact=1&framing=shell|workspace&state=<manifest-state>
```

Artifact mode exposes `window.__SKYBAO_CAPTURE__` with `ready`, `setFrame(frame)`, and `getFrame()`. The API and capture styles do not exist during normal product use. Stable `data-capture-id` attributes let Puppeteer drive the existing React controls, including dnd-kit, instead of rendering separate fake interactions.

## Automated 40-second edit

The repository now also contains a reviewed Blender VSE edit, deterministic music/SFX generator, and H.264 delivery runner. Once the complete asset library exists, generate a review or final master with:

```bash
yarn video:film
yarn video:film --final
```

See [`film/README.md`](film/README.md) for the storyboard, output paths, editable files, and Blender handoff details.
