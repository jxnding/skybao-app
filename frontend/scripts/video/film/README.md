# SkyBao durable film recipe

This folder is the durable, editor-neutral recipe for the 40-second SkyBao
product film. It uses real React/Puppeteer UI captures as image sequences and
an editable Blender scene; no UI frame is painted by hand. A UI change should
therefore mean recapturing and rerendering, not rebuilding the video concept.

## Contract

`shotlist.json` is schema v2 and is the source of truth for the edit:

- 1,200 contiguous frames, 40 seconds, 30 fps, 1920×1080.
- Nineteen shots: fourteen UI actions, four primary-area navigation bridges,
  and one final Admin hold.
- Five ordered areas: Assistant, Knowledge, Communications, Work, Admin.
- A group keeps one slab face. Faces alternate only at the four area changes.
- The only rotations are four continuous clockwise flips: 231–251, 471–491,
  711–731, and 951–971. Their beat-centered edge-on frames are 241, 481, 721,
  and 961.
- Same-face edits use a six-frame dissolve. Ordinary action and navigation
  clips remain workspace-framed, so app chrome only appears when the real
  navigation capture deliberately exposes it.
- A dissolve entering at global frame `S` uses exactly `S..S+5` for both
  incoming and outgoing opacity keys. Complementary linear easing prevents a
  one-frame boundary dip.
- Every navigation bridge shares one zero-based timing contract: click at 16,
  drawer retraction at 18, and flip start at 23. Validation enforces the causal
  order before Blender is allowed to render.

`environment.json` is schema v1 and owns the visual contract consumed by the
Blender builder:

- a real rounded, layered 5 mm glass panel and matching rounded UI mask;
- sharp emissive UI over the frosted glass backing;
- cyan/blue perimeter lighting with one restrained traveling glint;
- three seeded blue-gray cloud/fog cards at separate depths for parallax;
- a centered, enlarged, nearly locked camera and low-key blue lighting;
- bounded `camera.focusMoves` push-ins that target key micro-interactions.

`shotlist.json.editorialCallouts` contains one 2–4-word lower-third per area.
The Blender builder creates these as camera-facing Cycles text objects (never
painted into the React PNGs), with keyed eased opacity, safe lower-third
coordinates, and Blender's built-in Bfont (deliberately, for portable glyph
metrics). `positionM` is a screen-space LEFT/CENTER anchor; validation uses
conservative full Bfont title extents rather than only the anchor. Their
complete estimated bounds, frame windows, and copy are
validated before a build. `environment.json` owns the focus moves: each
move specifies a shot, frame window, screen-space target offset, subtle lens
peak, and ease duration. The 10–15% camera enlargement is the resting/baseline
coverage contract; focus peaks are intentionally bounded editorial pushes and
may exceed that resting enlargement. Moves return to neutral lens/offset and
are rejected when they cross flips, dissolves, or one another. `cornerSegments`
and `uiInsetM` are consumed by Blender geometry rather than decorative fields.
`uiInsetM` is a horizontal inset from each slab side for displayed UI only:
`uiWidth = slabWidth - 2*uiInsetM` and `uiHeight = uiWidth * 9/16`. This single
rectangle is used on both faces, in rounded-mask UVs, and for normalized cursor
mapping; physical clear covers remain the full slab width, height, and slab radius.

The environment recipe intentionally contains no alternate accent colors. It
is data, not a one-off render tweak: changing a visual value here and
regenerating is the supported revision path.

## Cycles render profiles

The Blender recipe renders in **Cycles**, not Eevee. Device selection is
explicit and recorded in both `build-manifest.json` and each delivery report:

```bash
# The normal choice on Apple Silicon. It probes Metal first and falls back to CPU.
yarn video:film --cycles-device=auto

# Useful when validating the GPU path or diagnosing a Metal issue.
yarn video:film --check --cycles-device=metal

# Portable but much slower fallback.
yarn video:film --cycles-device=cpu
```

`auto` is the default. `--check` is read-only: after validating the recipes and
captures, it asks Blender to probe the requested Cycles device without building
the `.blend` or rendering media. A requested `metal` run fails clearly when no
Metal Cycles device is available; `auto` resolves to Metal when possible and
otherwise CPU.

Cycles uses GPU OIDN with RGB/albedo/normal guidance, accurate prefiltering,
and high quality. The first Metal render after launch has a shader/device
warm-up cost; run a targeted sample or preview before timing a final delivery.
The 50% review profile uses 32 adaptive samples and is intended for iteration;
the 1080p final uses 128 adaptive samples. On the 32-core M1 Max used for the
checked-in delivery, the complete 1,200-frame preview took about 42 minutes and
the complete final took about 8 hours 46 minutes, including Metal warm-up,
scene build, validation, and encode. Treat those as planning estimates rather
than guarantees; scene changes and thermal load affect them, and CPU fallback
can take several times as long. The generated render report records the
resolved device, profile, samples, denoise settings, Blender/encode/total
elapsed milliseconds, and build-manifest path so the exact observed timing
remains attached to each deliverable.

## Regenerate after a UI change

From the repository root:

```bash
# 1. Rebuild the capture library from the real React mock and its capture IDs.
yarn video:assets

# A quick retake is also supported by the capture command:
yarn video:assets --only=work-board-drag,area-nav-work-admin

# 2. Refuse a film build if any used capture is stale or a film contract broke.
yarn video:film --check

# 3. Current revision review: build/check, then render only the targeted review.
yarn video:film --build-only
yarn video:film --samples=targeted

# The old full deliverables remain deferred/excluded from this review handoff.
yarn video:film:handoff --review-only

```

For a future approved delivery, render the current preview and final, then run
the full handoff without `--review-only`:

```bash
yarn video:film
yarn video:film --final
yarn video:film:handoff
```

Each render is assembled under an ignored staging directory and promoted only
after frame-contiguity, media, duration, color, and audio checks pass. The final
command removes its numbered PNG intermediates only after the master is safely
encoded; add `--keep-frames` when an editor explicitly needs them. Canonical
outputs are written to `artifacts/skybao-film/`, with MP4s, versioned build
manifests, render reports, and the poster under `deliverables/`.
Preview and final reports reference their immutable
`skybao-film-preview.blend` and `skybao-film-final.blend` projects; the shorter
`skybao-film.blend` path remains the most recently generated editable scene.
`video:film:handoff` derives its selections from `shotlist.json`, validates each
generated image/video, and promotes the handoff set atomically. Render commands
do not invoke handoff automatically; run it after both current renders.

When changing `environment.json`, use the same sequence: `--check` to verify
the Cycles contract/device, `--samples=<frame indices>` for a fast visual
checkpoint, then `--build-only`, preview, and finally the approved final. The
`--samples` values are global film frame indices, not seconds or clip-relative
frames.

Every film command and both handoff modes first perform a read-only freshness check of the exact 19
capture owners referenced by the shotlist. The generated `build-manifest.json`
locks each used owner's recipe and content SHA-256 alongside the shotlist,
environment, cloud texture, builder, and UI catalog hashes. If the React UI or
capture recipe changes, the film refuses to render until those owners are
recaptured.

Capture/source-owner freshness always blocks. A stale prior generated manifest
after intentional recipe or builder edits warns in rebuild mode because the
render regenerates it; `--strict-provenance` asserts that existing artifacts
are already current. Intentional targeted rebuilds are not blocked.

## Revision artifact state

The canonical `skybao-film.blend`, targeted review frames, build manifest, and
checksums represent this revision. Profile-specific preview/final blends and
MP4 deliverables remain the previously approved render until a full
preview/final render is explicitly approved. The old master does not contain
these changes; do not run the 1,200-frame preview/final render for revision
validation.

Capture recipe v4 binds freshness to the deterministic frontend source tree,
toolchain identity, and explicit recipe version. The Vite `dist` hash remains
in `catalog.json` for auditing but is intentionally non-binding because this
application's optimized chunk graph can differ byte-for-byte across equivalent
builds. Rebuilding unchanged UI therefore does not invalidate approved PNGs.

The capture manifest defines the real interaction and cursor timeline for each
clip. Navigation bridges are normal capture assets too: open the actual primary
navigation, move the cursor, click the next area, then let the slab flip. Do
not substitute a separately drawn navigation overlay.

When adding or changing a UI action:

1. Add or update the asset in `frontend/scripts/video/skybao-assets.mjs`.
2. Preserve stable `data-capture-id` selectors in the React surface.
3. Give the motion asset deterministic frame actions and a cursor timeline.
4. Reference its exact source range in `shotlist.json`.
5. Regenerate the assets, validate, review samples, then render.

## Targeted review checkpoint

Before a full render, inspect the canonical targeted set: all five callouts,
an in-dissolve frame, navigation click/pulse, source-preview cursor/focus,
board drag, task-approval focus/click, Admin focus, all four flip peaks, and a
resting enlarged UI frame. The supported command rebuilds the editable scene
and renders only those review frames:

```bash
  yarn video:film --samples=targeted
```

The saved Blender scene contract can also be checked without writing the blend. The
explicit `--samples=<frames>` form remains available for noncanonical review, but
only `--samples=targeted` claims canonical coverage:

```bash
BLENDER_BIN=/Applications/Blender.app/Contents/MacOS/Blender \
  yarn video:film:scene-contract --repo . --blend artifacts/skybao-film/skybao-film.blend \
  --manifest artifacts/skybao-film/build-manifest.json
```

Render staging runs this same read-only check before promotion. It verifies the
saved F-curves, cursor activity windows, rig/track provenance, and configured
callout/focus windows; a temporary mutated blend must fail it.

Cursor window resolution is shared by `build-blender.py` and
`scene-contract.py` through the Blender-safe `cursor_window.py` helper, which
is included in the environment tool-input provenance.

Approve only when these conditions hold:

- UI remains sharp, rounded, and approximately 10–15% larger than the prior
  centered framing.
- The background has slow layered parallax, while the camera does not drift.
- The glass edge stays cyan/blue and never becomes a bright edge-on bar.
- Every area change reads as a real sidebar cursor click followed by the same
  clockwise flip; no hard cut is used between product areas.
- `Enterprise Governance` appears and fades before the clean final Admin hold.

The preflight checks capture recipe/content freshness, schema, five-group
choreography, all four flips, same-face dissolves, navigation timing,
rounded/environment values, optical UI coverage, every catalog reference,
every source PNG in each trim, and each required cursor timeline. A failure
after changing UI is actionable: recapture the named asset or correct the
recipe rather than hand-editing rendered frames.
