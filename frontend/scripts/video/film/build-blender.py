#!/usr/bin/env python3
"""Build the SkyBao film edit in Blender 5.x using ONLY the VSE data API.

The parent orchestrator runs Blender outside this sandbox. This module is
also safe to syntax-check as a bare `python3 build-blender.py --build-only`.

Usage:
  blender --background --python build-blender.py -- \
      --repo /abs/path/to/anything-llm \
      --out /abs/path/to/artifacts/skybao-film/skybao-film.blend \
      --width 1920 --height 1080 \
      --quality preview   # build + render PNG frames (resolution 50%)
      --quality final     # build + render PNG frames (resolution 100%)
      --build-only        # compile/check only, never touches Blender

Verified data API only (no bpy.ops.sequencer anywhere):
  editor.strips.new_image(name, filepath, channel, frame_start, fit_method='ORIGINAL')
  strip.elements.append(filename)          # remaining numbered frames
  editor.strips.new_effect(name, type, channel, frame_start, length=..., ...)
  editor.strips.new_sound(name, filepath, channel, frame_start, stream=0)

Editorial style: dark cloud backdrop + navy/cyan colour layers, per-shot
camera push/pan keyframes (deterministic eased interpolation), short alpha
crossfades, opening/section/final titles, cyan bars/dots/pills, flow-line
motion, focus/vignette overlays and right-to-left / top-to-bottom editorial
accents. Film window is frames 1..1200 read from shotlist.json.
"""

import json
import binascii
import os
import struct
import sys
import traceback
import zlib

try:
    import bpy  # type: ignore
    _HAS_BPY = True
except Exception:  # pragma: no cover - plain python has no bpy
    bpy = None
    _HAS_BPY = False


BRAND_FONT = None


class FilmError(RuntimeError):
    pass


def require_attr(obj, name, where):
    if not hasattr(obj, name):
        raise FilmError(
            "missing API attribute {0} on {1} in {2}".format(name, obj, where)
        )
    return getattr(obj, name)


# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------
def parse_argv(argv):
    """Parse args that appear after a leading '--' (Blender convention)."""
    args = dict(repo=None, out="skybao-film.blend", width=1920, height=1080,
                quality=None, samples=None, build_only=False)
    toks = list(argv)
    if toks and toks[0] == "--":
        toks = toks[1:]
    i = 0
    while i < len(toks):
        key = toks[i].lstrip("-")
        val = None
        if i + 1 < len(toks) and not toks[i + 1].startswith("--"):
            val = toks[i + 1]
        if key in ("repo", "out", "width", "height", "quality", "samples"):
            if val is None or val == "":
                raise FilmError("missing value for --{0}".format(key))
            if key == "repo":
                args["repo"] = os.path.abspath(val)
            elif key == "out":
                args["out"] = os.path.abspath(val)
            elif key == "width":
                args["width"] = int(val)
            elif key == "height":
                args["height"] = int(val)
            elif key == "samples":
                try:
                    args["samples"] = [int(frame) for frame in val.split(",")]
                except ValueError:
                    raise FilmError("--samples must be comma-separated frame numbers")
            else:
                args["quality"] = val.lower()
            i += 2
        elif key in ("build-only", "compile", "check"):
            args["build_only"] = True
            i += 1
        else:
            i += 1
    if args["quality"] not in (None, "preview", "final"):
        raise FilmError(
            "--quality must be preview or final, got {0!r}".format(args["quality"]))
    return args


# ---------------------------------------------------------------------------
# Paths / data loading
# ---------------------------------------------------------------------------
def resolve_paths(args):
    film_dir = os.path.dirname(os.path.abspath(__file__))
    repo = args["repo"] or os.path.abspath(
        os.path.join(film_dir, "..", "..", "..", ".."))
    return dict(
        film_dir=film_dir,
        repo=repo,
        shotlist=os.path.join(film_dir, "shotlist.json"),
        ui=os.path.join(repo, "artifacts", "skybao-ui"),
        catalog=os.path.join(repo, "artifacts", "skybao-ui", "catalog.json"),
        film=os.path.join(repo, "artifacts", "skybao-film"),
        clouds=os.path.join(repo, "frontend", "public", "clouds-dark.webp"),
        font=os.path.join(repo, "frontend", "public", "fonts",
                          "PlusJakartaSans.ttf"),
        cursor=os.path.join(repo, "artifacts", "skybao-film", "cursor",
                            "cursor.png"),
        audio=os.path.join(repo, "artifacts", "skybao-film", "audio",
                            "skybao-mix.wav"),
        blendout=args["out"],
    )


def load_json(path):
    if not os.path.isfile(path):
        raise FilmError("missing file: {0}".format(path))
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def require_file(path):
    if not os.path.isfile(path):
        raise FilmError("missing asset file: {0}".format(path))


def frame_name(n):
    return "frame-{0:06d}.png".format(int(n))


def _png_chunk(kind, payload):
    body = kind + payload
    return (struct.pack(">I", len(payload)) + body +
            struct.pack(">I", binascii.crc32(body) & 0xffffffff))


def _inside_polygon(x, y, points):
    inside = False
    j = len(points) - 1
    for i, (xi, yi) in enumerate(points):
        xj, yj = points[j]
        if ((yi > y) != (yj > y)):
            crossing = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < crossing:
                inside = not inside
        j = i
    return inside


def _segment_distance(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    if length_sq == 0:
        return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
    qx, qy = ax + t * dx, ay + t * dy
    return ((px - qx) ** 2 + (py - qy) ** 2) ** 0.5


def ensure_cursor_png(path):
    """Rasterize the tracked cursor SVG shape without external dependencies."""
    width, height, supersample = 48, 56, 4
    points = [(6.0, 4.5), (6.0, 41.75), (16.2, 32.35),
              (23.3, 49.5), (31.95, 45.85), (24.9, 28.95),
              (40.0, 28.95)]
    rows = []
    for py in range(height):
        row = bytearray([0])
        for px in range(width):
            accum = [0.0, 0.0, 0.0, 0.0]
            for sy in range(supersample):
                for sx in range(supersample):
                    x = px + (sx + 0.5) / supersample
                    y = py + (sy + 0.5) / supersample
                    distances = [
                        _segment_distance(x, y, *points[i],
                                          *points[(i + 1) % len(points)])
                        for i in range(len(points))
                    ]
                    inside = _inside_polygon(x, y, points)
                    stroke = min(distances) <= 1.5
                    if stroke:
                        rgba = (15, 23, 42, 255)
                    elif inside:
                        rgba = (248, 250, 252, 255)
                    else:
                        rgba = (0, 0, 0, 0)
                    for channel in range(4):
                        accum[channel] += rgba[channel]
            samples = supersample * supersample
            row.extend(int(round(value / samples)) for value in accum)
        rows.append(bytes(row))
    raw = b"".join(rows)
    png = (b"\x89PNG\r\n\x1a\n" +
           _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height,
                                             8, 6, 0, 0, 0)) +
           _png_chunk(b"IDAT", zlib.compress(raw, 9)) +
           _png_chunk(b"IEND", b""))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(png)
    return path


def build_catalog_index(catalog):
    """catalog -> {(type, id, framing) -> entry}, workspace preferred."""
    index = {}
    for a in catalog.get("assets", []):
        key = (a.get("type"), a.get("id"), a.get("framing"))
        index[key] = a
        if a.get("framing") == "workspace":
            index[(a.get("type"), a.get("id"), None)] = a
    return index


# ---------------------------------------------------------------------------
# Blender context helper (only save + render operators need this)
# ---------------------------------------------------------------------------
class WindowContext:
    def __init__(self, scene):
        self.scene = scene
        self.cm = None

    def __enter__(self):
        wm = bpy.data.window_managers[0]
        win = wm.windows[0]
        scr = win.screen
        area = None
        for a in scr.areas:
            if a.type in ("SEQUENCE_EDITOR", "VIEW_3D", "RENDER", "FILE"):
                area = a
                break
        if area is None:
            area = scr.areas[0]
        region = next((r for r in area.regions if r.type == "WINDOW"), None)
        ctx = dict(window=win, screen=scr, area=area, region=region,
                   scene=self.scene, view_layer=self.scene.view_layers[0])
        win.scene = self.scene
        self.cm = bpy.context.temp_override(**ctx)
        self.cm.__enter__()
        return self

    def __exit__(self, *exc):
        self.cm.__exit__(*exc)


# ---------------------------------------------------------------------------
# Scene setup
# ---------------------------------------------------------------------------
def configure_scene(scene, width, height, total, fps):
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.fps = fps
    scene.render.fps_base = 1.0
    scene.frame_start = 1
    scene.frame_end = total
    scene.frame_current = 1
    vset = scene.view_settings
    for prop, value in (("view_transform", "Standard"), ("exposure", 0.0),
                        ("gamma", 1.0)):
        if hasattr(vset, prop):
            try:
                setattr(vset, prop, value)
            except Exception:
                pass


def ensure_scene(name, cfg):
    scenes = bpy.data.scenes
    if name in scenes:
        scenes.remove(scenes[name], do_unlink=True)
    sc = scenes.new(name)
    configure_scene(sc, cfg["width"], cfg["height"], cfg["total"], cfg["fps"])
    sc.sequence_editor_create()
    return sc


# ---------------------------------------------------------------------------
# Generic strip helpers (pure data API)
# ---------------------------------------------------------------------------
def set_range(strip, start, end):
    """Set an inclusive editorial frame range on Blender's end-exclusive strip."""
    require_attr(strip, "frame_final_end", "set_range")
    strip.frame_start = start
    strip.frame_final_end = end + 1


def set_image_compositing(strip):
    for prop, val in (("blend_type", "ALPHA_OVER"), ("blend_alpha", 1.0),
                      ("color_multiply", 1.0)):
        if hasattr(strip, prop):
            try:
                setattr(strip, prop, val)
            except Exception:
                pass


def key_linear(target, path, keyframes, where):
    """Insert deterministic keyframes on a strip or nested transform object.

    Blender 5.2 stores animation curves in layered scene actions, so there is
    no stable ``action.fcurves`` collection to rewrite here. The default
    Bezier interpolation provides the requested smooth ease-in/out motion.
    """
    for frame, value in keyframes:
        require_attr(target, "keyframe_insert", "key_linear:" + path)
        try:
            setattr(target, path, value)
            target.keyframe_insert(data_path=path, frame=frame)
        except (AttributeError, TypeError, ValueError) as exc:
            raise FilmError("cannot keyframe {0} on {1}: {2}".format(
                path, where, exc))


def media_channel_rotate(index):
    """Media strips rotate over channels 10..12 so adjacent shots never fight
    and the outgoing strip always has a channel to crossfade into."""
    return 10 + (index % 3)


# ---------------------------------------------------------------------------
# Colour / geometry helpers
# ---------------------------------------------------------------------------
def color_rect(editor, name, channel, start, end, color, alpha=1.0):
    """Full-frame COLOR effect strip; shape it via transform afterwards."""
    s = editor.strips.new_effect(name, "COLOR", channel, start,
                                 length=max(1, end - start + 1))
    try:
        s.color = tuple(float(c) for c in color[:3])
    except Exception:
        pass
    try:
        s.blend_type = "ALPHA_OVER"
    except Exception:
        pass
    try:
        s.blend_alpha = alpha
    except Exception:
        pass
    set_range(s, start, end)
    return s


def place_rect(strip, cx, cy, w, h, width, height):
    """Set size (w x h px) and centre (cx, cy px) via transform scale/offset."""
    tr = require_attr(strip, "transform", "place_rect")
    tr.scale_x = max(0.001, w / float(width))
    tr.scale_y = max(0.001, h / float(height))
    tr.offset_x = cx - width / 2.0
    tr.offset_y = cy - height / 2.0


# ---------------------------------------------------------------------------
# Build: background
# ---------------------------------------------------------------------------
def build_background(editor, cfg, paths):
    """Dark branded cloud backdrop + navy/cyan colour layers (channels 1-4)."""
    total = cfg["total"]
    w, h = cfg["width"], cfg["height"]

    require_file(paths["clouds"])
    bg = editor.strips.new_image("BG.clouds", paths["clouds"], 1, 1,
                                 fit_method="ORIGINAL")
    set_image_compositing(bg)
    set_range(bg, 1, total)
    try:
        bg.fit_method = "FILL"  # 1920x1200 source covers the 1920x1080 frame
    except Exception:
        pass

    # Deep navy brand wash over the clouds.
    navy = color_rect(editor, "BG.navy-wash", 2, 1, total,
                      (0.015, 0.025, 0.055), alpha=0.5)

    # Soft cyan top glow band for brand identity.
    glow = color_rect(editor, "BG.cyan-glow", 3, 1, total,
                      (0.02, 0.22, 0.30), alpha=0.20)
    place_rect(glow, w / 2.0, h - 150.0, w, 300.0, w, h)

    # Fine navy separator toward the bottom adds depth behind the UI.
    base = color_rect(editor, "BG.navy-base", 4, 1, total,
                      (0.01, 0.02, 0.045), alpha=0.35)
    place_rect(base, w / 2.0, h * 0.08, w, h * 0.18, w, h)

    return [bg, navy, glow, base]


# ---------------------------------------------------------------------------
# Build: shots (media + camera + alpha crossfades)
# ---------------------------------------------------------------------------
def build_media(editor, cfg, shotlist, catalog_index, paths, manifest):
    """Import each shot's still/clip trim with camera + crossfade keyframes."""
    w, h = cfg["width"], cfg["height"]
    shots = shotlist["shots"]
    n_shots = len(shots)
    strips = []

    for i, shot in enumerate(shots):
        frames = shot["frames"]
        start = frames["start"]
        end = frames["end"]
        src = shot["source"]
        transition = shot.get("transition", {})
        duration = int(transition.get("duration", 10))
        d_in = duration if i > 0 or transition.get("in") == "fade-from-black" else 0
        d_out = 0 if i == n_shots - 1 else duration
        fade_out = (int(transition.get("outDuration", duration))
                    if str(transition.get("out", "")).startswith("fade-")
                    else 0)

        # Keep the incoming source aligned to its authored first frame. The
        # outgoing strip extends over the following shot and holds its final
        # image while both alphas cross, avoiding skipped interaction frames.
        strip_start = start
        strip_end = min(cfg["total"], end + d_out)
        channel = media_channel_rotate(i)

        if src["type"] == "still":
            a = catalog_index.get(
                (src["type"], src["id"], src.get("framing")),
                catalog_index.get((src["type"], src["id"], None)))
            if not a:
                raise FilmError("shot {0}: still {1} ({2}) not in catalog".format(
                    shot["number"], src["id"], src.get("framing")))
            path = os.path.join(paths["ui"], a["file"])
            require_file(path)
            strip = editor.strips.new_image(
                "S{0:02d}.{1}".format(shot["number"], src["id"]),
                path, channel, strip_start, fit_method="ORIGINAL")
        elif src["type"] == "clip":
            a = catalog_index.get(
                (src["type"], src["id"], src.get("framing")),
                catalog_index.get((src["type"], src["id"], None)))
            if not a:
                raise FilmError("shot {0}: clip {1} ({2}) not in catalog".format(
                    shot["number"], src["id"], src.get("framing")))
            directory = os.path.join(paths["ui"], a["directory"])
            trim_start = int(src.get("startFrame", 1))
            trim_end = int(src.get("endFrame", 1))
            first_path = os.path.join(directory, frame_name(trim_start))
            require_file(first_path)
            strip = editor.strips.new_image(
                "S{0:02d}.{1}".format(shot["number"], src["id"]),
                first_path, channel, strip_start, fit_method="ORIGINAL")
            elements = strip.elements
            for n in range(trim_start + 1, trim_end + 1):
                require_file(os.path.join(directory, frame_name(n)))
                elements.append(frame_name(n))
        else:
            raise FilmError("shot {0}: unknown source type {1!r}".format(
                shot["number"], src["type"]))

        set_image_compositing(strip)
        set_range(strip, strip_start, strip_end)

        # Straight alpha interpretation of the source image datablock.
        img = getattr(bpy, "data", None) and bpy.data.images.get(first_path
            if src["type"] == "clip" else path)
        if img is not None and hasattr(img, "alpha_mode"):
            try:
                img.alpha_mode = "STRAIGHT"
            except Exception:
                pass

        # --- alpha crossfade keyframes (deterministic, linear) ---
        alpha_keys = []
        if d_in > 0:
            alpha_keys.append((strip_start, 0.0))
            alpha_keys.append((min(end, strip_start + d_in), 1.0))
        else:
            alpha_keys.append((start, 1.0))
        if end < strip_end:
            alpha_keys.append((end, 1.0))
            alpha_keys.append((strip_end, 0.0))
        elif fade_out > 0:
            alpha_keys.append((max(start, end - fade_out), 1.0))
            alpha_keys.append((end, 0.0))
        else:
            alpha_keys.append((end, 1.0))
        key_linear(strip, "blend_alpha", alpha_keys,
                   "shot {0} alpha".format(shot["number"]))

        # --- camera push / pan from shotlist values ---
        cam = shot.get("camera", {})
        cs = cam.get("start", {"scale": 1.0, "x": 0, "y": 0})
        ce = cam.get("end", {"scale": 1.0, "x": 0, "y": 0})
        s_scale = float(cs.get("scale", 1.0))
        e_scale = float(ce.get("scale", 1.0))

        def clamp_off(v, scale, dim):
            if scale <= 1.0:
                return 0.0
            slack = (scale - 1.0) * dim * 0.5 * 0.96
            px = v / 100.0 * (dim / 2.0)
            return max(-slack, min(slack, px))

        sx_off = clamp_off(float(cs.get("x", 0)), s_scale, w)
        sy_off = clamp_off(float(cs.get("y", 0)), s_scale, h)
        ex_off = clamp_off(float(ce.get("x", 0)), e_scale, w)
        ey_off = clamp_off(float(ce.get("y", 0)), e_scale, h)

        tr = require_attr(strip, "transform", "camera")
        for axis, (a, b) in (("x", (s_scale, e_scale)),
                             ("y", (s_scale, e_scale))):
            key_linear(tr, "scale_{0}".format(axis),
                       [(start, a), (end, b)], "shot {0} scale".format(shot["number"]))
        key_linear(tr, "offset_x",
                   [(start, sx_off), (end, ex_off)],
                   "shot {0} pan x".format(shot["number"]))
        key_linear(tr, "offset_y",
                   [(start, sy_off), (end, ey_off)],
                   "shot {0} pan y".format(shot["number"]))

        manifest["shots"].append({
            "number": shot["number"],
            "title": shot["title"],
            "frames": [strip_start, strip_end],
            "channel": channel,
            "source": "{0}:{1}".format(src["type"], src["id"]),
            "trim": [src.get("startFrame", None), src.get("endFrame", None)],
        })
        strips.append(strip)

    return strips


def build_cursors(editor, cfg, shotlist, catalog_index, paths, manifest):
    """Place an editorial cursor from each source clip's real timeline.

    The capture library deliberately keeps pointers out of UI pixels. Here the
    original frame-numbered coordinates are mapped through the same camera
    move as the source strip, making clicks and the Kanban drag legible while
    leaving the reusable capture assets clean.
    """
    cursor_path = ensure_cursor_png(paths["cursor"])
    w, h = cfg["width"], cfg["height"]
    built = []

    def clamp_off(value, scale, dim):
        if scale <= 1.0:
            return 0.0
        slack = (scale - 1.0) * dim * 0.5 * 0.96
        pixels = value / 100.0 * (dim / 2.0)
        return max(-slack, min(slack, pixels))

    for index, shot in enumerate(shotlist["shots"]):
        src = shot["source"]
        if src.get("type") != "clip":
            continue
        asset = catalog_index.get(
            ("clip", src["id"], src.get("framing")),
            catalog_index.get(("clip", src["id"], None)))
        if not asset or not asset.get("timeline"):
            continue
        timeline = load_json(os.path.join(paths["ui"], asset["timeline"]))
        raw_events = timeline.get("cursor", [])
        trim_start = int(src.get("startFrame", 1))
        trim_end = int(src.get("endFrame", 1))

        # Collapse duplicate down+move records at one source frame while
        # retaining whether that frame should receive a tactile scale pulse.
        by_frame = {}
        for event in raw_events:
            source_frame = int(event.get("frame", 0)) + 1
            if source_frame < trim_start or source_frame > trim_end:
                continue
            record = by_frame.setdefault(source_frame, {
                "x": float(event["x"]), "y": float(event["y"]),
                "pulse": False,
            })
            record["x"] = float(event["x"])
            record["y"] = float(event["y"])
            if event.get("event") in ("down", "click"):
                record["pulse"] = True
        if not by_frame:
            continue

        authored = []
        shot_start = int(shot["frames"]["start"])
        shot_end = int(shot["frames"]["end"])
        cam = shot.get("camera", {})
        cs = cam.get("start", {"scale": 1.0, "x": 0, "y": 0})
        ce = cam.get("end", {"scale": 1.0, "x": 0, "y": 0})
        duration = max(1, shot_end - shot_start)

        for source_frame in sorted(by_frame):
            record = by_frame[source_frame]
            editorial_frame = shot_start + source_frame - trim_start
            t = max(0.0, min(1.0,
                             (editorial_frame - shot_start) / float(duration)))
            eased = t * t * (3.0 - 2.0 * t)
            scale = (float(cs.get("scale", 1.0)) * (1.0 - eased) +
                     float(ce.get("scale", 1.0)) * eased)
            pan_x = clamp_off(
                float(cs.get("x", 0)) * (1.0 - eased) +
                float(ce.get("x", 0)) * eased, scale, w)
            pan_y = clamp_off(
                float(cs.get("y", 0)) * (1.0 - eased) +
                float(ce.get("y", 0)) * eased, scale, h)

            # Capture coordinates are top-left based. Blender offsets use a
            # centre origin with positive Y upward. The final constants place
            # the pointer's SVG hotspot, not its image centre, on the target.
            pointer_x = (record["x"] - w / 2.0) * scale + pan_x
            pointer_y = (h / 2.0 - record["y"]) * scale + pan_y
            authored.append({
                "frame": editorial_frame,
                "x": pointer_x + 18.0,
                "y": pointer_y - 23.5,
                "pulse": record["pulse"],
            })

        first, last = authored[0], authored[-1]
        cursor_start = max(shot_start, first["frame"] - 6)
        cursor_end = min(shot_end, last["frame"] + 7)
        strip = editor.strips.new_image(
            "C{0:02d}.{1}".format(shot["number"], src["id"]),
            cursor_path, 46 + (index % 2), cursor_start,
            fit_method="ORIGINAL")
        set_image_compositing(strip)
        set_range(strip, cursor_start, cursor_end)
        image = bpy.data.images.get(os.path.basename(cursor_path))
        if image is not None and hasattr(image, "alpha_mode"):
            image.alpha_mode = "STRAIGHT"

        position_keys = ([{"frame": cursor_start, "x": first["x"],
                           "y": first["y"], "pulse": False}] + authored +
                         [{"frame": cursor_end, "x": last["x"],
                           "y": last["y"], "pulse": False}])
        key_linear(strip.transform, "offset_x",
                   [(item["frame"], item["x"]) for item in position_keys],
                   "cursor x")
        key_linear(strip.transform, "offset_y",
                   [(item["frame"], item["y"]) for item in position_keys],
                   "cursor y")
        key_linear(strip, "blend_alpha",
                   [(cursor_start, 0.0),
                    (min(cursor_start + 3, cursor_end), 1.0),
                    (max(cursor_start + 3, cursor_end - 3), 1.0),
                    (cursor_end, 0.0)], "cursor alpha")

        pulse_keys = [(cursor_start, 1.0)]
        for item in authored:
            if item["pulse"]:
                pulse_keys.extend([
                    (max(cursor_start, item["frame"] - 1), 1.0),
                    (item["frame"], 0.82),
                    (min(cursor_end, item["frame"] + 3), 1.0),
                ])
        pulse_keys.append((cursor_end, 1.0))
        pulse_keys.sort(key=lambda pair: pair[0])
        key_linear(strip.transform, "scale_x", pulse_keys, "cursor click x")
        key_linear(strip.transform, "scale_y", pulse_keys, "cursor click y")
        built.append(strip)

    manifest["cursors"] = len(built)
    return built


# ---------------------------------------------------------------------------
# Build: titles, section labels, editorial overlays
# ---------------------------------------------------------------------------
PALETTE = {
    "cyan": (0.10, 0.78, 0.95),
    "teal": (0.0, 0.72, 0.65),
    "soft-blue": (0.45, 0.70, 0.95),
    "blue": (0.20, 0.50, 0.90),
    "ice": (0.70, 0.90, 1.00),
    "slate": (0.55, 0.62, 0.70),
    "amber": (1.00, 0.72, 0.25),
    "gold": (1.00, 0.80, 0.30),
    "violet": (0.55, 0.45, 0.95),
}


def tone_color(tone):
    return PALETTE.get(tone, PALETTE["cyan"])


def add_text(editor, name, channel, start, end, text, color, font_size,
             cx, cy, align_x="CENTER", align_y="CENTER", alpha=1.0):
    s = editor.strips.new_effect(name, "TEXT", channel, start,
                                 length=max(1, end - start + 1))
    try:
        s.text = text
    except Exception:
        pass
    try:
        s.color = tuple(float(c) for c in color[:3]) + (1.0,)
    except Exception:
        pass
    try:
        s.font_size = font_size
    except Exception:
        pass
    if BRAND_FONT is not None and hasattr(s, "font"):
        try:
            s.font = BRAND_FONT
        except Exception:
            pass
    try:
        s.alignment_x = align_x
        s.anchor_x = align_x
        s.anchor_y = align_y
    except Exception:
        pass
    try:
        s.location = (cx / 1920.0, cy / 1080.0)
    except Exception:
        pass
    try:
        s.blend_type = "ALPHA_OVER"
        s.blend_alpha = alpha
        s.use_shadow = True
        if hasattr(s, "shadow_color"):
            s.shadow_color = (0.0, 0.0, 0.0, 0.72)
    except Exception:
        pass
    set_range(s, start, end)
    return s


def add_bar(editor, name, channel, start, end, color, cx, cy, w, h, alpha=1.0):
    s = color_rect(editor, name, channel, start, end, color, alpha)
    place_rect(s, cx, cy, w, h, 1920.0, 1080.0)
    return s


def animate_text_fade(strip, fade, frames, where):
    if fade <= 0:
        return
    key_linear(strip, "blend_alpha",
               [(frames[0], 0.0), (frames[0] + fade, 1.0),
                (frames[1] - fade, 1.0), (frames[1], 0.0)], where)


def build_titles_and_overlays(editor, cfg, shotlist, manifest):
    """Opening/section/final titles + cyan accent bars, pills, flow lines,
    right-to-left panel emphasis, top-to-bottom popover and focus overlays."""
    total = cfg["total"]
    w, h = cfg["width"], cfg["height"]
    cyan = PALETTE["cyan"]
    white = (0.98, 0.99, 1.0)
    soft = PALETTE["soft-blue"]
    gold = PALETTE["gold"]
    slate = PALETTE["slate"]

    # ---------- opening title (over shot 1) ----------
    t_open = add_text(editor, "T.title-open", 50, 12, 60, "SkyBao",
                      white, 150, w / 2.0, h * 0.60)
    s_sub = add_text(editor, "T.title-sub", 51, 18, 66,
                     "Work in flow. Stay in control.", soft, 46,
                     w / 2.0, h * 0.42)
    animate_text_fade(t_open, 10, (12, 60), "opening title")
    animate_text_fade(s_sub, 10, (18, 66), "opening subtitle")
    rule = add_bar(editor, "A.title-rule", 40, 12, 60, cyan,
                   w / 2.0, h * 0.50, 260, 4, 1.0)
    key_linear(rule.transform, "offset_x",
               [(12, w * 0.10), (22, 0.0), (50, 0.0)], "title rule")

    # ---------- section micro-labels ----------
    sections = [
        ("KNOWLEDGE, GROUNDED", "Ask · trace · cite", 376, 435, "teal"),
        ("ONE INBOX, ONE THREAD", "Filter · open · analyse", 586, 655, "blue"),
        ("WORK TURNS INTO DOING", "Board · approve · act", 856, 935, "gold"),
    ]
    for i, (head, sub, s_start, s_end, tone) in enumerate(sections):
        col = tone_color(tone)
        label = add_text(editor, "T.sect-{0}".format(i), 50, s_start, s_end,
                         head, col, 40, 320, h * 0.14, align_x="LEFT",
                         align_y="CENTER")
        sublab = add_text(editor, "T.sect-sub-{0}".format(i), 51,
                          s_start + 6, s_end, sub, slate, 30, 320, h * 0.10,
                          align_x="LEFT", align_y="CENTER")
        animate_text_fade(label, 8, (s_start, s_end), "section label")
        animate_text_fade(sublab, 8, (s_start + 6, s_end), "section sub")

        # Right-to-left panel emphasis behind the label.
        panel = color_rect(editor, "A.panel-{0}".format(i), 40, s_start, s_end,
                           (0.02, 0.04, 0.09), alpha=0.55)
        place_rect(panel, 320, h * 0.14, 480, 96, w, h)
        key_linear(panel, "blend_alpha",
                   [(s_start, 0.0), (s_start + 8, 0.6), (s_end, 0.6)],
                   "panel fade")
        panel_x = panel.transform.offset_x
        key_linear(panel.transform, "offset_x",
                   [(s_start, w * 0.5), (s_start + 12, panel_x),
                    (s_end - 8, panel_x)],
                   "panel slide")

        # Cyan tick on the left edge of the panel.
        tick = add_bar(editor, "A.tick-{0}".format(i), 41, s_start + 8, s_end,
                       col, 8, h * 0.14, 6, 64, 1.0)
        key_linear(tick, "blend_alpha",
                   [(s_start + 8, 0.0), (s_start + 16, 1.0)], "tick")

        # Top-to-bottom popover emphasis: a small dot drops in above label.
        dot = add_bar(editor, "A.dot-{0}".format(i), 42, s_start, s_end,
                      col, 320, h * 0.14, 10, 10, 1.0)
        dot_y = dot.transform.offset_y
        key_linear(dot.transform, "offset_y",
                   [(s_start, dot_y + h * 0.18), (s_start + 14, dot_y)],
                   "dot drop")
        key_linear(dot, "blend_alpha",
                   [(s_start, 0.0), (s_start + 8, 1.0)], "dot fade")

    # ---------- flow-line motion on data-heavy shots ----------
    flow_windows = [
        (136, 240, "teal", "LTR"),
        (511, 585, "violet", "RTL"),
        (856, 975, "slate", "LTR"),
    ]
    for idx, (fs, fe, tone, direction) in enumerate(flow_windows):
        col = tone_color(tone)
        line = color_rect(editor, "A.flow-{0}".format(idx), 43, fs, fe,
                          col, alpha=0.55)
        place_rect(line, w / 2.0, h * 0.20, 26, 4, w, h)
        fstart = fs + 6
        fend = fe - 6
        if direction == "LTR":
            key_linear(line.transform, "offset_x",
                       [(fstart, -w * 0.55), (fend, w * 0.55)], "flow x")
        else:
            key_linear(line.transform, "offset_x",
                       [(fstart, w * 0.55), (fend, -w * 0.55)], "flow x")
        key_linear(line, "blend_alpha",
                   [(fstart, 0.0), (fstart + 8, 0.6),
                    (fend - 8, 0.6), (fend, 0.0)], "flow fade")

    # ---------- focus / vignette overlays (channels 90+) ----------
    grade = color_rect(editor, "G.grade", 90, 1, total,
                       (0.005, 0.012, 0.03), alpha=0.10)
    # Letterbox bars: cinematic focus frame, pulse at section changes.
    topbar = color_rect(editor, "G.topbar", 91, 1, total, (0.0, 0.0, 0.0),
                        alpha=0.22)
    place_rect(topbar, w / 2.0, h - 27.0, w, 54, w, h)
    botbar = color_rect(editor, "G.botbar", 92, 1, total, (0.0, 0.0, 0.0),
                        alpha=0.22)
    place_rect(botbar, w / 2.0, 27.0, w, 54, w, h)
    # Edge dims complete a soft vignette silhouette.
    for edge_index, (name, xc) in enumerate((("L", 24.0), ("R", w - 24.0))):
        edge = color_rect(editor, "G.edge{0}".format(name), 93 + edge_index,
                          1, total,
                          (0.0, 0.0, 0.0), alpha=0.18)
        place_rect(edge, xc, h / 2.0, 48, h, w, h)
    for pulse_at in (376, 586, 856, 1141):
        key_linear(topbar, "blend_alpha",
                   [(pulse_at - 4, 0.22), (pulse_at + 4, 0.42),
                    (pulse_at + 14, 0.22)], "letterbox pulse")
        key_linear(botbar, "blend_alpha",
                   [(pulse_at - 4, 0.22), (pulse_at + 4, 0.42),
                    (pulse_at + 14, 0.22)], "letterbox pulse")

    # ---------- final title ----------
    # The final authored UI strip fades back to the cloud stage underneath,
    # leaving this closing promise clean without fabricating another screen.
    t_end = add_text(editor, "T.title-end", 55, 1148, 1200, "You stay in control.",
                     cyan, 88, w / 2.0, h * 0.58)
    s_end = add_text(editor, "T.title-end-sub", 56, 1156, 1200,
                     "SkyBao keeps the loop yours — every source, every step,"
                     " every approval.", white, 34, w / 2.0, h * 0.46)
    animate_text_fade(t_end, 9, (1148, 1200), "final title")
    animate_text_fade(s_end, 9, (1156, 1200), "final sub")
    end_rule = add_bar(editor, "A.end-rule", 54, 1152, 1200, cyan,
                       w / 2.0, h * 0.52, 180, 4, 1.0)
    key_linear(end_rule.transform, "offset_x",
               [(1152, w * 0.5), (1164, 0.0)], "end rule")


# ---------------------------------------------------------------------------
# Build: sound
# ---------------------------------------------------------------------------
def build_sound(editor, cfg, paths, manifest):
    """Attach the generated mix WAV if present; otherwise note + continue."""
    total = cfg["total"]
    wav = paths["audio"]
    if not os.path.isfile(wav):
        manifest["sound"] = "SKIPPED (missing: {0})".format(wav)
        return None
    try:
        s = editor.strips.new_sound("Audio.skybao-mix", wav, 120, 1, stream=0)
        set_range(s, 1, total)
        manifest["sound"] = os.path.basename(wav)
        return s
    except Exception as exc:
        raise FilmError("cannot add sound strip {0}: {1}".format(wav, exc))


# ---------------------------------------------------------------------------
# Manifest / save / render
# ---------------------------------------------------------------------------
def write_manifest(cfg, paths, manifest):
    shotlist = manifest["shotlist_path"]
    print("=" * 64)
    print("SkyBao film · Blender build manifest")
    print("  format  : {0}x{1} @ {2}fps, frames 1..{3}".format(
        cfg["width"], cfg["height"], cfg["fps"], cfg["total"]))
    print("  shotlist: {0}".format(shotlist))
    print("  shots   : {0}".format(len(manifest["shots"])))
    for shot in manifest["shots"]:
        print("    S{0:02d} {1:<22} frames {2}-{3}  ch {4}  {5} {6}".format(
            shot["number"], shot["title"], shot["frames"][0], shot["frames"][1],
            shot["channel"], shot["source"], shot["trim"]))
    print("  cursors : {0} interaction overlays".format(
        manifest.get("cursors", 0)))
    print("  sound   : {0}".format(manifest.get("sound", "none")))
    print("  out     : {0}".format(paths["blendout"]))


def save_blend(paths):
    out = paths["blendout"]
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with WindowContext(bpy.context.scene):
        bpy.ops.wm.save_as_mainfile(filepath=out)
    return out


def render_frames(sc, cfg, quality, paths):
    """Render PNG frames into frames/<quality>/ using per-frame writes."""
    out_dir = os.path.join(paths["film"], "frames", quality)
    os.makedirs(out_dir, exist_ok=True)
    scene_render = sc.render
    scene_render.resolution_percentage = 50 if quality == "preview" else 100
    scene_render.image_settings.file_format = "PNG"
    scene_render.image_settings.color_mode = "RGBA"
    scene_render.image_settings.compression = 15
    scene_render.filepath = os.path.join(out_dir, "frame_")

    print("  rendering {0} frames into {1} ...".format(
        cfg["total"], out_dir))
    for frame in range(cfg["start_frame"], cfg["total"] + 1):
        sc.frame_set(frame)
        scene_render.filepath = os.path.join(
            out_dir, "frame-{0:06d}.png".format(frame))
        with WindowContext(sc):
            bpy.ops.render.render(write_still=True, scene=sc.name)
        if frame % 240 == 0:
            print("    ... frame {0}".format(frame))
    return out_dir


def render_samples(sc, cfg, frames, paths):
    """Render selected half-resolution review frames without a full export."""
    out_dir = os.path.join(paths["film"], "review")
    os.makedirs(out_dir, exist_ok=True)
    scene_render = sc.render
    scene_render.resolution_percentage = 50
    scene_render.image_settings.file_format = "PNG"
    scene_render.image_settings.color_mode = "RGBA"
    scene_render.image_settings.compression = 15
    for frame in frames:
        if frame < 1 or frame > cfg["total"]:
            raise FilmError("sample frame {0} outside 1..{1}".format(
                frame, cfg["total"]))
        sc.frame_set(frame)
        scene_render.filepath = os.path.join(
            out_dir, "frame-{0:04d}.png".format(frame))
        with WindowContext(sc):
            bpy.ops.render.render(write_still=True, scene=sc.name)
        print("  review frame: {0}".format(scene_render.filepath))
    return out_dir


# ---------------------------------------------------------------------------
# Main build
# ---------------------------------------------------------------------------
def build(args):
    global BRAND_FONT
    paths = resolve_paths(args)
    shotlist = load_json(paths["shotlist"])
    catalog = load_json(paths["catalog"])
    cfg = dict(
        width=int(args["width"]),
        height=int(args["height"]),
        fps=int(shotlist.get("format", {}).get("fps", 30)),
        total=int(shotlist.get("format", {}).get("frames", 1200)),
        start_frame=1,
    )

    # Cross-check the shotlist coverage.
    expected = cfg["total"]
    shots = shotlist.get("shots", [])
    if not shots:
        raise FilmError("shotlist has no shots")
    if shots[0]["frames"]["start"] != 1:
        raise FilmError("shotlist does not start at frame 1")
    if shots[-1]["frames"]["end"] != expected:
        raise FilmError("shotlist does not end at frame {0}".format(expected))

    catalog_index = build_catalog_index(catalog)
    sc = ensure_scene("skybao-film", cfg)
    require_file(paths["font"])
    try:
        BRAND_FONT = bpy.data.fonts.load(paths["font"], check_existing=True)
    except TypeError:
        BRAND_FONT = bpy.data.fonts.load(paths["font"])
    editor = sc.sequence_editor
    if editor is None:
        raise FilmError("sequence_editor_create() did not produce an editor")

    manifest = dict(shotlist_path=paths["shotlist"], shots=[], cursors=0,
                    sound="none")

    build_background(editor, cfg, paths)
    build_media(editor, cfg, shotlist, catalog_index, paths, manifest)
    build_cursors(editor, cfg, shotlist, catalog_index, paths, manifest)
    build_titles_and_overlays(editor, cfg, shotlist, manifest)
    build_sound(editor, cfg, paths, manifest)

    # Mark all loaded UI images straight-alpha (catalog guarantees it).
    for img in bpy.data.images:
        if hasattr(img, "alpha_mode") and img.pixels is not None:
            try:
                img.alpha_mode = "STRAIGHT"
            except Exception:
                pass

    write_manifest(cfg, paths, manifest)
    saved = save_blend(paths)
    print("  saved blend: {0}".format(saved))
    print("  strips total: {0}".format(len(editor.strips)))
    print("=" * 64)

    if args["quality"]:
        render_frames(sc, cfg, args["quality"], paths)
    if args["samples"]:
        render_samples(sc, cfg, args["samples"], paths)
    return saved


def main(argv):
    args = parse_argv(argv)
    if args["build_only"]:
        print("build-only: python syntax OK, no Blender touched")
        return 0
    if not _HAS_BPY:
        print("error: bpy not importable — run inside Blender, or use "
              "--build-only for a syntax check")
        return 2
    try:
        build(args)
        return 0
    except FilmError as exc:
        print("error: {0}".format(exc))
        traceback.print_exc()
        return 1
    except Exception as exc:  # pragma: no cover
        print("unexpected error: {0}".format(exc))
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
