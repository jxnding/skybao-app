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
- a centered hero camera with the penultimate 50 mm baseline and low-key blue
  lighting; the complete UI comes from the real 150% capture package, with no
  Blender-side UV crop or camera-wide zoom;
- bounded `camera.focusMoves` push-ins that target key micro-interactions.

The full UI screenshot is a zero-thickness rounded image plane held 0.55 mm
above the real 5 mm glass slab. Semantic interaction highlights are separate
rounded solids: the four opening Assistant cards use 10 mm of extrusion and a
24 mm peak lift for a clearer hero-scale completion beat, while later highlights
retain the restrained 4 mm depth and 12 mm lift. During each area flip, the outgoing and incoming image planes
exchange render ownership exactly at the authored 90-degree `edgeOn` frame, so
the old screenshot cannot ghost onto the emerging reverse face.

`shotlist.json.editorialCallouts` contains one 2–4-word lower-third per area.
The Blender builder creates these as camera-facing Cycles text objects (never
painted into the React PNGs), with keyed eased opacity, safe lower-third
coordinates, and Blender's built-in Bfont (deliberately, for portable glyph
metrics). `positionM` is a screen-space LEFT/CENTER anchor; validation uses
conservative full Bfont title extents rather than only the anchor. Their
complete estimated bounds, frame windows, copy, and authored slide/scale
entrance and exit keys are validated before a build. `shotlist.json`
`floatingHighlights` owns seven semantic target beats. Capture descriptors resolve
the target bounds, four-corner radius, source frame, and transparent cutout;
Blender adds a rounded front/back cap, shallow sidewall, subtle lift, and a
hero-color Layer Weight rim into an isolated `HighlightGlow` AOV. No circular
halo, hard-coded coordinates, or neon green ring remains.
`environment.json` owns the focus moves: each
move specifies a shot, frame window, screen-space target offset, subtle lens
peak, and ease duration. The 50 mm hero lens is the resting/baseline coverage
contract. Focus peaks are
intentionally bounded editorial pushes and
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

Use `yarn video:film --preview-zoom150` for a separate silent candidate. It
writes `skybao-40s-preview-zoom150.mp4`, its versioned blend/manifest/report,
and never promotes the current preview/master or shared audio artifact.

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

# 3. Current revision review: render the immutable targeted package.
yarn video:film --samples=targeted

# Full preview/final builds may be deferred; they cannot replace this package.
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
The targeted approval is separate and immutable: `skybao-film-review.blend`,
`provenance/targeted-review-build-manifest.json`,
`provenance/targeted-review-receipt.json`, `audio/targeted-review-mix.wav`, and
`review/targeted/frame-*.png`. Preview, final, and build-only never replace these paths.
The dedicated review manifest is self-contained: its audio is always
`audio/targeted-review-mix.wav`. `yarn video:film --check` is source/capture/
recipe/device preflight and may warn that review artifacts need regeneration.
Use `yarn video:film --check-artifacts` for strict approval; handoff always
runs that approval check.
`video:film:handoff` derives its selections from `shotlist.json`, validates each
generated image/video, and promotes the handoff set atomically. Render commands
do not invoke handoff automatically; run it after both current renders.
`video:film:handoff --review-only` is the bootstrap path when the package receipt
is absent (or stale): it validates the targeted receipt, creates the deterministic current
`targetedReviewFrames` set (currently 38 frames), a vertically centered 8x5
contact sheet, and a
9.5-second/285-frame 30fps H.264 reel, then writes and
validates `provenance/review-package-receipt.json`. Full handoff additionally
requires that completed package. The package receipt binds the exact source
frame order and media/grid metadata. `checksums-review.sha256` owns the
targeted package, reel, contact sheet, and current review artifacts;
`checksums-full.sha256` owns validated preview/final/profile/full-review
artifacts and is authenticated by the exact-set
`provenance/full-package-receipt.json`. Schema v2 binds the current input
fingerprint and the exact SHA-256 values of both the targeted-review receipt and
the completed review-package receipt. `checksums.sha256` is only the union of
independently validated review and full ledgers. A targeted refresh preserves
the rest of `review/`, but invalidates the review-package/checksum approval and
the paired full receipt/ledger that depends on it. Half-present full state is
cleared as one rollback-safe pair during review-only handoff; preserved entries
are retained only after their old digest and file are revalidated.

When changing `environment.json`, use the same sequence: `--check` to verify
the Cycles contract/device, `--samples=<frame indices>` for a fast visual
checkpoint, then `--samples=targeted`, preview, and finally the approved final. The
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

The dedicated targeted review blend, manifest, receipt, and frames
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

The film input catalog is selected by `environment.toolInputs.uiCatalog` and is
currently `artifacts/skybao-ui-zoom-150/catalog.json`. It must contain complete
motion sequences at zoom 150, not the five-still review strips. Its digest and
the app-owned `frontend/src/skybao-design-language.json` digest are bound in
every build manifest so theme or capture changes invalidate the film.
Each authored floating target resolves a descriptor with `normalizedBounds`
(`left`, `top`, `width`, `height`, normalized to the 150% PNG), `cornerRadii`
or a CSS `borderRadius` value, `capturePhase`, and a `cutout` object containing
relative `path`, `sha256`, and `paddingPx`. Padding is cropped from the cutout
UVs; it never expands the physical sidewall silhouette. The builder accepts
descriptor maps or arrays under an asset/catalog `targets`, `captureTargets`,
or `elementTargets` collection.

The film input catalog is selected by `environment.toolInputs.uiCatalog` and is
currently `artifacts/skybao-ui-zoom-150/catalog.json`. It must contain complete
motion sequences at zoom 150, not the five-still review strips. Its digest and
the app-owned `frontend/src/skybao-design-language.json` digest are bound in
every build manifest so theme or capture changes invalidate the film.

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

Canonical targeted frames are rendered at 1920×1080 using the dedicated
`targetedReview` profile (economical samples with denoising); normal preview
remains 960×540. Review-only handoff creates
`review/skybao-targeted-review-reel.mp4`, a checkpoint reel—not the full
40-second master or motion/final delivery.

The saved Blender scene contract can also be checked without writing the blend. The
explicit `--samples=<frames>` form remains available for noncanonical review, but
only `--samples=targeted` claims canonical coverage:

```bash
BLENDER_BIN=/Applications/Blender.app/Contents/MacOS/Blender \
  yarn video:film:scene-contract --repo . --blend artifacts/skybao-film/skybao-film-review.blend \
  --manifest artifacts/skybao-film/provenance/targeted-review-build-manifest.json \
  --audio artifacts/skybao-film/audio/targeted-review-mix.wav
```

Render staging runs this same read-only check before promotion. It verifies the
saved F-curves, cursor activity windows, rig/track provenance, and configured
callout/focus windows; a temporary mutated blend must fail it.

Cursor window resolution is shared by `build-blender.py` and
`scene-contract.py` through the Blender-safe `cursor_window.py` helper, which
is included in the environment tool-input provenance.

Approve only when these conditions hold:

- UI remains sharp, rounded, and substantially enlarged for hero readability.
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
