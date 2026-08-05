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
- Every navigation bridge shares one zero-based timing contract: click at 16,
  drawer retraction at 18, and flip start at 23. Validation enforces the causal
  order before Blender is allowed to render.

`environment.json` is schema v1 and owns the visual contract consumed by the
Blender builder:

- a real rounded, layered 5 mm glass panel and matching rounded UI mask;
- sharp emissive UI over the frosted glass backing;
- cyan/blue perimeter lighting with one restrained traveling glint;
- three seeded blue-gray cloud/fog cards at separate depths for parallax;
- a centered, enlarged, nearly locked camera and low-key blue lighting.

The environment recipe intentionally contains no alternate accent colors. It
is data, not a one-off render tweak: changing a visual value here and
regenerating is the supported revision path.

## Regenerate after a UI change

From the repository root:

```bash
# 1. Rebuild the capture library from the real React mock and its capture IDs.
yarn video:assets

# A quick retake is also supported by the capture command:
yarn video:assets --only=work-board-drag,area-nav-work-admin

# 2. Refuse a film build if any used capture is stale or a film contract broke.
yarn video:film --check

# 3. Build an editable Blender scene, then make the review render.
yarn video:film --build-only
yarn video:film

# 4. Produce the 1080p delivery master only after the review is approved.
yarn video:film --final
```

Every film command first performs a read-only freshness check of the exact 19
capture owners referenced by the shotlist. The generated `build-manifest.json`
locks each used owner's recipe and content SHA-256 alongside the shotlist,
environment, cloud texture, builder, and UI catalog hashes. If the React UI or
capture recipe changes, the film refuses to render until those owners are
recaptured.

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

Before a full render, inspect stable UI frames and the four flip midpoints. The
supported targeted command rebuilds the editable scene and renders only those
review frames:

```bash
yarn video:film --samples=60,150,241,300,420,481,560,660,721,800,900,961,1030,1120,1180
```

Approve only when these conditions hold:

- UI remains sharp, rounded, and approximately 10–15% larger than the prior
  centered framing.
- The background has slow layered parallax, while the camera does not drift.
- The glass edge stays cyan/blue and never becomes a bright edge-on bar.
- Every area change reads as a real sidebar cursor click followed by the same
  clockwise flip; no hard cut is used between product areas.
- The Admin group lands and holds cleanly without editorial title text.

The preflight checks capture recipe/content freshness, schema, five-group
choreography, all four flips, same-face dissolves, navigation timing,
rounded/environment values, optical UI coverage, every catalog reference,
every source PNG in each trim, and each required cursor timeline. A failure
after changing UI is actionable: recapture the named asset or correct the
recipe rather than hand-editing rendered frames.
