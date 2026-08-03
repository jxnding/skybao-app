# Tomorrow: make the SkyBao video

Goal: assemble a quick 45–60 second first cut from the transparent SkyBao UI assets, probably in Blender. Prioritize a clear product story over polishing every available clip.

## 1. Generate the full asset library

From the repository root:

```bash
node --version
yarn video:assets
open artifacts/skybao-ui/contact-sheet.html
```

- Use Node 22.12 or newer.
- Do not use `--smoke` for the edit; smoke output contains only three sampled frames per clip.
- Confirm `catalog.json` has `"sampled": false`; if not, regenerate before editing.
- For the current mock, a complete run contains 2,238 PNGs: 2,160 numbered frames across 19 clips plus 78 still/start/end images.
- The current complete library takes about 8½ minutes to render and uses roughly 260 MB.
- Keep the `.blend` file outside `artifacts/skybao-ui/`; the generator replaces that directory on every run.

## 2. Suggested first-cut story

Use this as a starting point, then prune aggressively:

1. Full-shell Assistant still to establish SkyBao.
2. Assistant research, answer typing, and citation preview.
3. Edit the response draft and create the Acme task.
4. Move the task across the Kanban board and approve it.
5. Show Communications context or draft review briefly.
6. Show one Knowledge moment: file search, source preview, or data analysis.
7. Finish on Admin Privacy as the trust message.

The asset IDs and exact file locations are listed in `catalog.json` and shown visually in `contact-sheet.html`.

## 3. Blender setup

1. Create a 1920×1080 project at 30 fps.
2. Set color management to preserve UI colors: **View Transform: Standard**, exposure `0`, gamma `1`.
3. Put the background or 3D scene on a lower video channel.
4. Import each clip by selecting its `frame-000001.png` as an **Image/Sequence** strip—not as separate still images.
5. Set the image strip to **Straight Alpha**.
6. Use full-shell stills for establishing shots and workspace-only sequences for motion shots.
7. Add `cursor/cursor.svg` on a separate layer only where it improves comprehension. Keyframe it from the matching `timeline.json` cursor events.
8. Add restrained camera moves, titles, music, and small interaction sounds after the story works without them.

## 4. Review and export

- Watch once with no audio: the workflow should still be understandable.
- Check that transparent edges are clean and no UI is cropped.
- Hold important end states long enough to read.
- Export a quick review MP4 first: FFmpeg video, MPEG-4 container, H.264, 1920×1080, 30 fps.
- Keep the numbered PNG sequences as the source master; the MP4 is only the review/delivery copy.

If a shot needs changing, retake only that asset:

```bash
yarn video:assets --only=assistant-answer-typing,work-board-drag --out=/absolute/path/to/retakes
```

Full capture and Blender details are in `frontend/scripts/video/README.md`.
