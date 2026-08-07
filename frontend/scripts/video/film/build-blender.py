#!/usr/bin/env python3
"""Build the SkyBao film as a physical 3D edit in Blender 5.x (Cycles).

The film is a single floating 16:9 glass slab inside a dark, procedural
server-room void. Each shot is a real workspace-framed UI capture mapped onto
an image plane resting slightly above the slab's front or back surface. Every
major-area transition rotates the slab exactly 180 degrees around its vertical
axis so the incoming UI is revealed on the reverse face. Actions inside an area
stay on one face and use one restrained dissolve. The camera remains centered;
rounded glass, cloud cards, a cyan perimeter glint, UI motion, and the four
meaningful navigation flips and data-driven editorial graphics carry the
movement. Everything is procedural and deterministic: UI text still comes only
from React captures; lower-thirds are separate Blender text objects.

Usage (from the orchestrator):
  blender --background --python build-blender.py -- \
      --repo /abs/path/to/anything-llm \
      --out /abs/path/to/artifacts/skybao-film/skybao-film.blend \
      --width 1920 --height 1080 \
      --quality preview   # build + render every PNG frame (50%)
      --quality final     # build + render every PNG frame (100%)
      --device auto       # internal device selector (auto|metal|cpu)
      --probe-device        # print selected Cycles device; does not touch assets
      --samples 30,150,300   # build + render review frames (50%)
      --shots assistant-research,work-board-drag  # render start/mid/end
      --build-only        # compile/check only, never touches Blender

The film window (frames 1..1200) and the front/back face per shot are read
from shotlist.json. Render frames are written with the same names the
orchestrator expects (frame-000001.png ...), so the delivery pipeline is
unchanged.
"""

import hashlib
import json
import math
import os
import random
import subprocess
import sys
import time
import traceback

# Blender 5.2 does not always add a --python script's directory to sys.path.
# Keep the shared helper import normal and deterministic in both Blender and
# plain-Python execution.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cursor_window import event_for_frame

try:
    import bpy  # type: ignore
    from mathutils import Vector
    _HAS_BPY = True
except Exception:  # pragma: no cover - plain python has no bpy
    bpy = None
    Vector = None
    _HAS_BPY = False


class FilmError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Scene constants
# ---------------------------------------------------------------------------
SLAB_W = 3.3
SLAB_H = 1.85625          # 16:9
SLAB_T = 0.005            # ~0.5 cm glass
SLAB_HALF_T = SLAB_T / 2.0
SLAB_RADIUS = 0.065
UI_RADIUS = 0.053
UI_OFFSET = 0.00055       # crisp UI rests just proud of frosted backing
UI_INSET = 0.012
UI_W = SLAB_W - 2.0 * UI_INSET
UI_H = UI_W * 9.0 / 16.0
CORNER_SEGMENTS = 8
CAM_Z = 5.88
FOCAL_MM = 50.0
ROT_FRAMES = 20           # frames for a full 180-degree area flip
DISSOLVE_FRAMES = 6
BREATH_AMP = 0.018
BREATH_PERIOD_S = 12.0
FPS = 30
FILM_TOTAL = 1200
FILM_SHOT_COUNT = 19
MAX_SHOTS = 100
EXPECTED_FLIPS = (
    ("assistant", "knowledge", 231, 251, 241),
    ("knowledge", "communications", 471, 491, 481),
    ("communications", "work", 711, 731, 721),
    ("work", "admin", 951, 971, 961),
)
ENVIRONMENT = {}
RENDER_RUNTIME = {}


def nested(data, keys, default):
    """Read a nested config value while retaining safe build fallbacks."""
    current = data
    for key in keys:
        if not isinstance(current, dict) or key not in current:
            return default
        current = current[key]
    return current


def rgb(value, default=(0.0, 0.0, 0.0)):
    """Accept either #RRGGBB or an RGB array from JSON scene config."""
    if isinstance(value, str) and value.startswith("#") and len(value) == 7:
        return tuple(int(value[i:i + 2], 16) / 255.0 for i in (1, 3, 5))
    if isinstance(value, (list, tuple)) and len(value) >= 3:
        return (float(value[0]), float(value[1]), float(value[2]))
    return tuple(default)


def apply_environment_config(config, shotlist):
    """Load scene constants from the versioned environment manifest."""
    global ENVIRONMENT, SLAB_W, SLAB_H, SLAB_T, SLAB_HALF_T
    global SLAB_RADIUS, UI_RADIUS, UI_OFFSET, UI_INSET, UI_W, UI_H, CORNER_SEGMENTS, CAM_Z, FOCAL_MM
    global ROT_FRAMES, DISSOLVE_FRAMES, BREATH_AMP, BREATH_PERIOD_S, FPS

    ENVIRONMENT = config
    glass = config.get("glass", {})
    camera = config.get("camera", {})
    SLAB_W = float(glass.get("widthM", glass.get("width", SLAB_W)))
    SLAB_H = float(glass.get("heightM", glass.get("height", SLAB_H)))
    SLAB_T = float(glass.get("thicknessM", glass.get("thickness", SLAB_T)))
    SLAB_HALF_T = SLAB_T / 2.0
    SLAB_RADIUS = float(glass.get(
        "cornerRadiusM", glass.get("cornerRadius", SLAB_RADIUS)))
    UI_RADIUS = float(glass.get(
        "uiMaskCornerRadiusM", glass.get("uiCornerRadius",
                                         SLAB_RADIUS * 0.82)))
    UI_INSET = float(glass.get("uiInsetM", UI_INSET))
    # uiInsetM is a horizontal inset only.  The displayed rectangle is the
    # single authoritative 16:9 capture rectangle; its height is derived
    # rather than independently shrinking the physical slab vertically.
    UI_W = SLAB_W - 2.0 * UI_INSET
    UI_H = UI_W * 9.0 / 16.0
    CORNER_SEGMENTS = max(3, int(glass.get("cornerSegments", CORNER_SEGMENTS)))
    UI_OFFSET = float(nested(
        glass, ("layers", "ui", "offsetM"), glass.get("uiOffset", UI_OFFSET)))
    CAM_Z = float(camera.get("distanceM", camera.get("distance", CAM_Z)))
    FOCAL_MM = float(camera.get("lensMM", camera.get("focalLengthMm", FOCAL_MM)))
    BREATH_AMP = float(camera.get(
        "maxBreathM", camera.get("breathAmplitude", BREATH_AMP)))
    BREATH_PERIOD_S = float(camera.get("breathPeriodSeconds", BREATH_PERIOD_S))
    ROT_FRAMES = int(shotlist.get("direction", {}).get(
        "rotationFrames", ROT_FRAMES))
    DISSOLVE_FRAMES = int(shotlist.get("direction", {}).get(
        "sameFaceDissolveFrames", DISSOLVE_FRAMES))
    FPS = int(shotlist.get("format", {}).get("fps", FPS))


# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------
def parse_argv(argv):
    """Parse args that appear after a leading '--' (Blender convention)."""
    args = dict(repo=None, out="skybao-film.blend", width=1920, height=1080,
                quality=None, samples=None, shots=None, device="auto",
                profile=None,
                frames_out=None, manifest_out=None, audio=None,
                audio_canonical=None, receipt=None, device_probe=False, build_only=False)
    raw_toks = list(argv)
    # Blender appends its own arguments before the separator.  Once a
    # separator exists, none of those arguments belong to this strict parser.
    # In direct-script use there is no separator, so retain strict parsing of
    # every supplied token.
    if "--" in raw_toks:
        toks = raw_toks[raw_toks.index("--") + 1:]
    else:
        toks = raw_toks
    i = 0
    while i < len(toks):
        token = toks[i]
        if not token.startswith("--") or token == "--":
            raise FilmError("unknown option: {0}".format(token))
        key = token[2:]
        if not key:
            raise FilmError("unknown option: {0}".format(token))
        val = None
        if i + 1 < len(toks) and not toks[i + 1].startswith("--"):
            val = toks[i + 1]
        if key in ("repo", "out", "width", "height", "quality", "samples",
                   "shots", "device", "cycles-device", "profile", "frames-out",
                   "manifest-out", "audio", "audio-canonical", "receipt"):
            if val is None or val == "":
                raise FilmError("missing value for --{0}".format(key))
            if key == "repo":
                args["repo"] = os.path.abspath(val)
            elif key == "out":
                args["out"] = os.path.abspath(val)
            elif key in ("width", "height"):
                try:
                    parsed = int(val)
                except (TypeError, ValueError):
                    raise FilmError("--{0} must be an integer".format(key))
                if parsed < 1:
                    raise FilmError("--{0} must be positive".format(key))
                args[key] = parsed
            elif key == "samples":
                try:
                    args["samples"] = [int(frame) for frame in val.split(",")]
                except ValueError:
                    raise FilmError("--samples must be comma-separated frame numbers")
                if any(frame < 1 for frame in args["samples"]):
                    raise FilmError("--samples frame numbers must be positive")
            elif key == "shots":
                args["shots"] = [item.strip() for item in val.split(",")
                                  if item.strip()]
            elif key in ("device", "cycles-device"):
                args["device"] = val.lower()
            elif key == "profile":
                args["profile"] = val.lower()
            elif key == "frames-out":
                args["frames_out"] = os.path.abspath(val)
            elif key == "manifest-out":
                args["manifest_out"] = os.path.abspath(val)
            elif key == "audio":
                args["audio"] = os.path.abspath(val)
            elif key == "audio-canonical":
                args["audio_canonical"] = os.path.abspath(val)
            elif key == "receipt":
                args["receipt"] = os.path.abspath(val)
            else:
                args["quality"] = val.lower()
            i += 2
        elif key in ("device-probe", "probe-device", "probe-devices"):
            args["device_probe"] = True
            i += 1
        elif key in ("build-only", "compile", "check"):
            args["build_only"] = True
            i += 1
        else:
            raise FilmError("unknown option: --{0}".format(key))
    if args["quality"] not in (None, "preview", "final"):
        raise FilmError(
            "--quality must be preview or final, got {0!r}".format(args["quality"]))
    if args["profile"] not in (None, "preview", "final"):
        raise FilmError(
            "--profile must be preview or final, got {0!r}".format(
                args["profile"]))
    if args["device"] not in ("auto", "metal", "cpu"):
        raise FilmError("--cycles-device must be auto, metal, or cpu")
    return args


# ---------------------------------------------------------------------------
# Paths / data loading
# ---------------------------------------------------------------------------
def resolve_paths(args):
    film_dir = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.realpath(args["repo"] or os.path.join(
        film_dir, "..", "..", "..", ".."))
    if not os.path.isdir(repo):
        raise FilmError("repository does not exist: {0}".format(repo))
    if args["repo"]:
        film_dir = os.path.join(repo, "frontend", "scripts", "video", "film")
        if not os.path.isdir(film_dir):
            raise FilmError("alternate repository has no frontend/scripts/video/film: {0}".format(repo))
    canonical_audio = (args.get("audio_canonical") or os.path.join(
        repo, "artifacts", "skybao-film", "audio", "skybao-mix.wav"))
    return dict(
        film_dir=film_dir,
        repo=repo,
        shotlist=os.path.join(film_dir, "shotlist.json"),
        environment=os.path.join(film_dir, "environment.json"),
        ui=os.path.join(repo, "artifacts", "skybao-ui"),
        catalog=os.path.join(repo, "artifacts", "skybao-ui", "catalog.json"),
        film=os.path.join(repo, "artifacts", "skybao-film"),
        audio=(args.get("audio") or canonical_audio),
        audio_canonical=canonical_audio,
        blendout=args["out"],
        frames_out=args.get("frames_out"),
        build_manifest=(args.get("manifest_out") or
                        os.path.join(repo, "artifacts", "skybao-film",
                                     "build-manifest.json")),
    )


def load_json(path):
    if not os.path.isfile(path):
        raise FilmError("missing file: {0}".format(path))
    try:
        with open(path, "r", encoding="utf-8") as fh:
            value = json.load(fh)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise FilmError("cannot read JSON file {0}: {1}".format(path, exc))
    if not isinstance(value, dict):
        raise FilmError("JSON root must be an object: {0}".format(path))
    return value


def require_file(path):
    if not os.path.isfile(path):
        raise FilmError("missing asset file: {0}".format(path))


MAX_ASSET_FRAME = 100000
MAX_SOURCE_RANGE = 10000


def safe_catalog_path(root, value, label):
    """Resolve a catalog path without allowing traversal or symlink escapes."""
    if not isinstance(value, str) or not value.strip():
        raise FilmError("{0} must be a nonempty relative catalog path".format(label))
    candidate = value.strip().replace("\\", os.sep)
    if (os.path.isabs(candidate) or candidate.startswith("//") or
            ":" in candidate.split(os.sep)[0] or
            any(part == ".." for part in candidate.split(os.sep))):
        raise FilmError("{0} escapes artifacts/skybao-ui: {1!r}".format(label, value))
    base = os.path.realpath(root)
    resolved = os.path.realpath(os.path.join(base, candidate))
    try:
        inside = os.path.commonpath((base, resolved)) == base
    except ValueError:
        inside = False
    if not inside or resolved == base:
        raise FilmError("{0} escapes artifacts/skybao-ui: {1!r}".format(label, value))
    return resolved


def safe_repo_path(root, value, label):
    """Resolve a data path under --repo, including symlink containment."""
    if not isinstance(value, str) or not value.strip():
        raise FilmError("{0} must be a nonempty relative repository path".format(label))
    candidate = value.strip().replace("\\", os.sep)
    if (os.path.isabs(candidate) or candidate.startswith("//") or
            ":" in candidate.split(os.sep)[0] or
            any(part == ".." for part in candidate.split(os.sep))):
        raise FilmError("{0} escapes repository root: {1!r}".format(label, value))
    base = os.path.realpath(root)
    resolved = os.path.realpath(os.path.join(base, candidate))
    try:
        inside = os.path.commonpath((base, resolved)) == base
    except ValueError:
        inside = False
    if not inside or resolved == base:
        raise FilmError("{0} escapes repository root: {1!r}".format(label, value))
    return resolved


def bounded_frame_range(start, end, label, maximum=MAX_ASSET_FRAME):
    if (isinstance(start, bool) or isinstance(end, bool) or
            not isinstance(start, int) or not isinstance(end, int) or
            start < 1 or end < start or end > maximum or
            end - start + 1 > MAX_SOURCE_RANGE):
        raise FilmError("{0} must be bounded integer frames (1..{1}, max {2} frames)".format(
            label, maximum, MAX_SOURCE_RANGE))


def frame_name(n):
    return "frame-{0:06d}.png".format(int(n))


def safe_clip_frame(directory, frame, label):
    """Realpath an individual PNG immediately before Blender loads it."""
    candidate = os.path.join(directory, frame_name(frame))
    resolved = os.path.realpath(candidate)
    root = os.path.realpath(directory)
    try:
        inside = os.path.commonpath((root, resolved)) == root and resolved != root
    except ValueError:
        inside = False
    if not inside:
        raise FilmError("{0} escapes its catalog clip directory".format(label))
    if not os.path.isfile(resolved):
        raise FilmError("missing asset file: {0}".format(resolved))
    return resolved


def build_catalog_index(catalog, ui_root):
    """catalog -> {(type, id, framing) -> entry}, workspace preferred."""
    index = {}
    assets = catalog.get("assets")
    if not isinstance(assets, list):
        raise FilmError("UI catalog assets must be an array")
    ui_root = os.path.realpath(ui_root)
    for asset_index, a in enumerate(assets):
        if not isinstance(a, dict):
            raise FilmError("UI catalog assets[{0}] must be an object".format(asset_index))
        for key in ("file", "directory", "timeline"):
            if key in a:
                safe_catalog_path(ui_root, a[key], "UI catalog assets[{0}].{1}".format(asset_index, key))
        if a.get("type") == "clip":
            count = a.get("frameCount")
            if (isinstance(count, bool) or not isinstance(count, int) or
                    count < 1 or count > MAX_ASSET_FRAME):
                raise FilmError("UI catalog assets[{0}].frameCount must be 1..{1}".format(
                    asset_index, MAX_ASSET_FRAME))
        key = (a.get("type"), a.get("id"), a.get("framing"))
        index[key] = a
        if a.get("framing") == "workspace":
            index[(a.get("type"), a.get("id"), None)] = a
    for asset_index, a in enumerate(assets):
        if a.get("type") != "clip":
            continue
        timeline_path = safe_catalog_path(ui_root, a.get("timeline"),
                                          "UI catalog assets[{0}].timeline".format(asset_index))
        timeline = load_json(timeline_path)
        if timeline.get("frameCount") != a.get("frameCount"):
            raise FilmError("UI catalog assets[{0}] timeline.frameCount must equal catalog frameCount".format(asset_index))
        events = timeline.get("cursor")
        if not isinstance(events, list):
            raise FilmError("UI catalog assets[{0}] timeline.cursor must be an array".format(asset_index))
        for event_index, event in enumerate(events):
            if (not isinstance(event, dict) or isinstance(event.get("frame"), bool) or
                    not isinstance(event.get("frame"), int) or event["frame"] < 0 or
                    event["frame"] >= a["frameCount"] or
                    isinstance(event.get("nx"), bool) or
                    not isinstance(event.get("nx"), (int, float)) or
                    not math.isfinite(event["nx"]) or not 0.0 <= event["nx"] <= 1.0 or
                    isinstance(event.get("ny"), bool) or
                    not isinstance(event.get("ny"), (int, float)) or
                    not math.isfinite(event["ny"]) or not 0.0 <= event["ny"] <= 1.0 or
                    event.get("event") not in ("move", "down", "up", "click")):
                raise FilmError("UI catalog assets[{0}] cursor[{1}] is malformed".format(asset_index, event_index))
    return index


# ---------------------------------------------------------------------------
# Blender context helper (only operators need this)
# ---------------------------------------------------------------------------
class WindowContext:
    def __init__(self, scene):
        self.scene = scene
        self.cm = None

    def __enter__(self):
        wm = bpy.data.window_managers[0]
        win = wm.windows[0]
        scr = win.screen
        area = next((a for a in scr.areas
                     if a.type in ("SEQUENCE_EDITOR", "VIEW_3D", "RENDER",
                                   "FILE")), scr.areas[0])
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
def _set_if_present(target, name, value):
    """Set a Blender-version-dependent property and report whether it exists."""
    if not hasattr(target, name):
        return False
    try:
        setattr(target, name, value)
        return True
    except Exception:
        return False


def _setting_matches(actual, expected):
    if isinstance(expected, float):
        try:
            return abs(float(actual) - expected) <= 1e-6
        except (TypeError, ValueError):
            return False
    return actual == expected


def _set_required(target, name, value, label=None):
    """Set and read back a required Cycles setting; never silently degrade."""
    title = label or name
    if not hasattr(target, name):
        raise FilmError("required Cycles setting is unavailable: {0}".format(title))
    try:
        setattr(target, name, value)
        actual = getattr(target, name)
    except Exception as exc:
        raise FilmError("cannot set required Cycles setting {0}: {1}".format(
            title, exc))
    if not _setting_matches(actual, value):
        raise FilmError("required Cycles setting {0} read back as {1!r}, expected {2!r}".format(
            title, actual, value))
    return actual


def _cycles_preferences():
    """Return Cycles preferences when the add-on is present in this Blender."""
    prefs = bpy.context.preferences
    addon = prefs.addons.get("cycles")
    return addon.preferences if addon else None


def _cycle_devices(preferences):
    """Refresh and normalize the device list without assuming a Blender minor."""
    if preferences is None:
        return []
    for method in ("refresh_devices", "get_devices"):
        callback = getattr(preferences, method, None)
        if callback:
            try:
                callback()
            except Exception:
                pass
    result = []
    for device in list(getattr(preferences, "devices", [])):
        result.append({
            "id": str(getattr(device, "id", "")),
            "name": str(getattr(device, "name", "unknown")),
            "type": str(getattr(device, "type", "unknown")),
            "use": bool(getattr(device, "use", False)),
        })
    return result


def configure_cycles_device(scene, requested):
    """Resolve auto|metal|cpu, preferring Metal and retaining a CPU escape hatch."""
    cli_requested = str(requested or "auto").lower()
    if cli_requested not in ("auto", "metal", "cpu"):
        raise FilmError("--cycles-device must be auto, metal, or cpu")

    render_cfg = ENVIRONMENT.get("render", {})
    requested = (cli_requested if cli_requested != "auto" else
                 str(nested(render_cfg, ("device", "default"), "auto")).lower())
    # CLI auto is deliberately the only policy that may move to CPU. A
    # caller that asked for Metal needs a deterministic failure, not a silent
    # quality/performance change.
    can_fallback = cli_requested == "auto"
    preferences = _cycles_preferences()
    details = {
        "requested": requested,
        "resolved": "cpu",
        "fallback": None,
        "metalRT": None,
        "computeDeviceType": "CPU",
        "activeDeviceIds": [],
        "devices": [],
    }

    def use_cpu(reason=None):
        if preferences is not None:
            for device in getattr(preferences, "devices", []):
                if hasattr(device, "use"):
                    try:
                        device.use = str(getattr(device, "type", "")) == "CPU"
                    except Exception:
                        pass
            details["devices"] = _cycle_devices(preferences)
            details["activeDeviceIds"] = [
                device["id"] for device in details["devices"]
                if device["type"] == "CPU" and device["use"]
            ]
        _set_required(scene.cycles, "device", "CPU", "cycles.device")
        details["resolved"] = "cpu"
        details["fallback"] = reason
        return details

    def unavailable(reason):
        if not can_fallback:
            raise FilmError("Metal was explicitly requested but is unavailable: {0}".format(
                reason))
        return use_cpu(reason)

    if requested == "cpu":
        details["devices"] = _cycle_devices(preferences)
        return use_cpu()
    if preferences is None:
        return unavailable("Cycles preferences unavailable")

    # Blender exposes Metal devices only after compute_device_type is chosen.
    try:
        preferences.compute_device_type = "METAL"
    except Exception as exc:
        return unavailable("Metal selection unavailable: {0}".format(exc))
    details["devices"] = _cycle_devices(preferences)
    metal = [device for device in getattr(preferences, "devices", [])
             if str(getattr(device, "type", "")) == "METAL"]
    if not metal:
        return unavailable("Cycles reported no Metal device")
    for device in getattr(preferences, "devices", []):
        if hasattr(device, "use"):
            try:
                device.use = device in metal
            except Exception:
                pass
    details["devices"] = _cycle_devices(preferences)
    details["activeDeviceIds"] = [
        device["id"] for device in details["devices"]
        if device["type"] == "METAL" and device["use"]
    ]
    if not details["activeDeviceIds"]:
        return unavailable("Cycles has no active Metal device IDs")
    details["computeDeviceType"] = "METAL"
    metal_rt = str(nested(render_cfg, ("device", "metalRT"), "AUTO"))
    metal_rt_actual = None
    for property_name in ("metalrt", "use_metalrt"):
        if hasattr(preferences, property_name):
            metal_rt_actual = _set_required(
                preferences, property_name, metal_rt,
                "Cycles preferences.{0}".format(property_name))
            break
    if metal_rt_actual != "AUTO":
        return unavailable("MetalRT did not read back as AUTO")
    details["metalRT"] = metal_rt_actual
    try:
        _set_required(scene.cycles, "device", "GPU", "cycles.device")
        details["resolved"] = "metal"
    except Exception as exc:
        return unavailable("Cycles GPU selection failed: {0}".format(exc))
    return details


def probe_cycles_device(scene, requested):
    """Resolve one device/profile and return a JSON-safe, no-write probe."""
    _set_required(scene.render, "engine", "CYCLES", "render.engine")
    device = configure_cycles_device(scene, requested)
    apply_cycles_profile(scene, "preview")
    return {
        "blender": bpy.app.version_string,
        "engine": scene.render.engine,
        "cyclesAddon": _cycles_preferences() is not None,
        "requestedDevice": requested,
        "resolvedDevice": device["resolved"],
        "fallback": device["fallback"],
        "computeDeviceType": device["computeDeviceType"],
        "metalRT": device["metalRT"],
        "activeDeviceIds": device["activeDeviceIds"],
        "metalAvailable": any(
            item["type"] == "METAL" for item in device["devices"]),
        "devices": device["devices"],
        "profile": RENDER_RUNTIME.get("profile"),
        "samples": RENDER_RUNTIME.get("samples"),
        "adaptiveThreshold": RENDER_RUNTIME.get("adaptiveThreshold"),
        "resolutionPercentage": RENDER_RUNTIME.get("resolutionPercentage"),
        "seed": RENDER_RUNTIME.get("seed"),
        "persistentData": RENDER_RUNTIME.get("persistentData"),
        "bounces": RENDER_RUNTIME.get("bounces"),
        "denoise": RENDER_RUNTIME.get("denoise"),
    }


def apply_cycles_profile(scene, profile):
    """Apply deterministic quality, bounce, and OIDN settings for one render mode."""
    render_cfg = ENVIRONMENT.get("render", {})
    profile_name = "final" if profile == "final" else "preview"
    profile_cfg = render_cfg.get(profile_name, {})
    seed_cfg = render_cfg.get("seed", ENVIRONMENT.get("seed", 0))
    if isinstance(seed_cfg, dict):
        seed_value = int(seed_cfg.get("value", ENVIRONMENT.get("seed", 0)))
        persistent_data = bool(seed_cfg.get("persistent", True))
        animated_seed = bool(seed_cfg.get("animated", False))
    else:
        seed_value = int(seed_cfg)
        persistent_data = bool(render_cfg.get("persistentData", True))
        animated_seed = bool(render_cfg.get("animatedSeed", False))
    cycles = scene.cycles
    samples = int(profile_cfg.get("samples", 128 if profile_name == "final" else 32))
    threshold = float(profile_cfg.get(
        "adaptiveThreshold", 0.01 if profile_name == "final" else 0.03))
    _set_required(cycles, "samples", samples, "cycles.samples")
    _set_required(cycles, "preview_samples", samples, "cycles.preview_samples")
    _set_required(cycles, "use_adaptive_sampling", True,
                  "cycles.use_adaptive_sampling")
    _set_required(cycles, "adaptive_threshold", threshold,
                  "cycles.adaptive_threshold")
    _set_required(cycles, "seed", seed_value, "cycles.seed")
    _set_required(cycles, "use_animated_seed", animated_seed,
                  "cycles.use_animated_seed")
    _set_required(scene.render, "use_persistent_data", persistent_data,
                  "render.use_persistent_data")

    bounces = render_cfg.get("bounces", {})
    for prop, key, default in (
            ("max_bounces", "max", 8),
            ("transmission_bounces", "transmission", 8),
            ("transparent_max_bounces", "transparent", 8),
            ("glossy_bounces", "glossy", 4),
            ("diffuse_bounces", "diffuse", 2),
            ("sample_clamp_indirect", "indirectClamp", 10.0)):
        _set_required(cycles, prop, bounces.get(key, default),
                      "cycles.{0}".format(prop))
    caustics = bool(bounces.get("caustics", False))
    _set_required(cycles, "caustics_reflective", caustics,
                  "cycles.caustics_reflective")
    _set_required(cycles, "caustics_refractive", caustics,
                  "cycles.caustics_refractive")

    denoise = render_cfg.get("denoise", {})
    denoiser = "OPENIMAGEDENOISE" if str(denoise.get("type", "OIDN")).upper() == "OIDN" else str(denoise.get("type"))
    use_gpu = bool(denoise.get("useGpu", True))
    input_passes = str(denoise.get("inputPasses", "RGB_ALBEDO_NORMAL"))
    prefilter = str(denoise.get("prefilter", "ACCURATE"))
    quality = str(denoise.get("quality", "HIGH"))
    _set_required(cycles, "use_denoising", True, "cycles.use_denoising")
    _set_required(cycles, "use_preview_denoising", True,
                  "cycles.use_preview_denoising")
    _set_required(cycles, "denoiser", denoiser, "cycles.denoiser")
    _set_required(cycles, "preview_denoiser", denoiser,
                  "cycles.preview_denoiser")
    _set_required(cycles, "denoising_use_gpu", use_gpu,
                  "cycles.denoising_use_gpu")
    _set_required(cycles, "preview_denoising_use_gpu", use_gpu,
                  "cycles.preview_denoising_use_gpu")
    _set_required(cycles, "denoising_input_passes", input_passes,
                  "cycles.denoising_input_passes")
    _set_required(cycles, "denoising_prefilter", prefilter,
                  "cycles.denoising_prefilter")
    _set_required(cycles, "preview_denoising_prefilter", prefilter,
                  "cycles.preview_denoising_prefilter")
    _set_required(cycles, "denoising_quality", quality,
                  "cycles.denoising_quality")
    _set_required(cycles, "preview_denoising_quality", quality,
                  "cycles.preview_denoising_quality")

    RENDER_RUNTIME["profile"] = profile_name
    _set_required(scene.render, "resolution_percentage", int(profile_cfg.get(
        "resolutionPercentage", 100 if profile_name == "final" else 50)),
                  "render.resolution_percentage")
    RENDER_RUNTIME["seed"] = int(cycles.seed)
    RENDER_RUNTIME["animatedSeed"] = bool(cycles.use_animated_seed)
    RENDER_RUNTIME["persistentData"] = bool(scene.render.use_persistent_data)
    RENDER_RUNTIME["samples"] = int(cycles.samples)
    RENDER_RUNTIME["adaptiveThreshold"] = float(cycles.adaptive_threshold)
    RENDER_RUNTIME["resolutionPercentage"] = int(scene.render.resolution_percentage)
    RENDER_RUNTIME["bounces"] = {
        "max": int(getattr(cycles, "max_bounces", bounces.get("max", 8))),
        "transmission": int(getattr(
            cycles, "transmission_bounces", bounces.get("transmission", 8))),
        "transparent": int(getattr(
            cycles, "transparent_max_bounces", bounces.get("transparent", 8))),
        "glossy": int(getattr(
            cycles, "glossy_bounces", bounces.get("glossy", 4))),
        "diffuse": int(getattr(
            cycles, "diffuse_bounces", bounces.get("diffuse", 2))),
        "causticsReflective": bool(getattr(
            cycles, "caustics_reflective", caustics)),
        "causticsRefractive": bool(getattr(
            cycles, "caustics_refractive", caustics)),
        "indirectClamp": float(getattr(
            cycles, "sample_clamp_indirect", bounces.get("indirectClamp", 10))),
    }
    RENDER_RUNTIME["denoise"] = {
        "type": str(cycles.denoiser),
        "useGpu": bool(cycles.denoising_use_gpu),
        "inputPasses": str(cycles.denoising_input_passes),
        "prefilter": str(cycles.denoising_prefilter),
        "quality": str(cycles.denoising_quality),
    }


def configure_scene(scene, width, height, total, fps,
                    device_requested="auto", profile="preview"):
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.fps = fps
    scene.render.fps_base = 1.0
    scene.frame_start = 1
    scene.frame_end = total
    scene.frame_current = 1
    scene.render.engine = "CYCLES"
    scene.render.use_motion_blur = True
    scene.render.motion_blur_shutter = 0.12
    scene.render.motion_blur_position = "CENTER"
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.compression = 15

    device = configure_cycles_device(scene, device_requested)
    RENDER_RUNTIME["deviceRequested"] = device_requested
    RENDER_RUNTIME["deviceResolved"] = device["resolved"]
    RENDER_RUNTIME["deviceFallback"] = device["fallback"]
    RENDER_RUNTIME["devices"] = device["devices"]
    RENDER_RUNTIME["metalRT"] = device["metalRT"]
    RENDER_RUNTIME["computeDeviceType"] = device["computeDeviceType"]
    RENDER_RUNTIME["activeDeviceIds"] = device["activeDeviceIds"]
    apply_cycles_profile(scene, profile)

    vset = scene.view_settings
    try:
        prop = vset.bl_rna.properties["view_transform"]
        transforms = [item.identifier for item in prop.enum_items]
    except Exception:
        transforms = []
    for candidate in ("AgX", "Filmic", "Standard"):
        if candidate in transforms:
            try:
                vset.view_transform = candidate
            except Exception:
                pass
            break
    for prop, value in (("exposure", 0.0), ("gamma", 1.0)):
        if hasattr(vset, prop):
            try:
                setattr(vset, prop, value)
            except Exception:
                pass


def ensure_scene(name, cfg, device_requested="auto", profile="preview"):
    scenes = bpy.data.scenes
    if name in scenes:
        scenes.remove(scenes[name], do_unlink=True)
    sc = scenes.new(name)
    configure_scene(sc, cfg["width"], cfg["height"], cfg["total"], cfg["fps"],
                    device_requested, profile)
    return sc


# ---------------------------------------------------------------------------
# Material helpers
# ---------------------------------------------------------------------------
def new_material(name):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    for node in list(mat.node_tree.nodes):
        mat.node_tree.nodes.remove(node)
    return mat


def add_node(mat, bl_type, name=None):
    node = mat.node_tree.nodes.new(bl_type)
    if name:
        node.name = name
    return node


def set_input(node, name, value):
    for inp in node.inputs:
        if inp.name == name:
            try:
                inp.default_value = value
                return True
            except Exception:
                return False
    return False


def link(mat, from_socket, to_socket):
    mat.node_tree.links.new(from_socket, to_socket)


def ui_material(name, image):
    """Crisp emission + alpha UI with an animatable dissolve control."""
    mat = new_material(name)
    nt = mat.node_tree
    tex = add_node(mat, "ShaderNodeTexImage", "Tex")
    tex.image = image
    tex.extension = "CLIP"
    em = add_node(mat, "ShaderNodeEmission", "Emit")
    set_input(em, "Strength", float(nested(
        ENVIRONMENT, ("glass", "uiEmission"), 1.12)))
    opacity = add_node(mat, "ShaderNodeValue", "Opacity")
    opacity.outputs[0].default_value = 1.0
    alpha = add_node(mat, "ShaderNodeMath", "Alpha")
    alpha.operation = "MULTIPLY"
    mix = add_node(mat, "ShaderNodeMixShader", "Mix")
    trans = add_node(mat, "ShaderNodeBsdfTransparent", "Transparent")
    out = add_node(mat, "ShaderNodeOutputMaterial", "Out")
    link(mat, tex.outputs["Color"], em.inputs["Color"])
    link(mat, tex.outputs["Alpha"], alpha.inputs[0])
    link(mat, opacity.outputs[0], alpha.inputs[1])
    link(mat, alpha.outputs[0], mix.inputs["Factor"])
    link(mat, trans.outputs["BSDF"], mix.inputs[1])
    link(mat, em.outputs["Emission"], mix.inputs[2])
    link(mat, mix.outputs["Shader"], out.inputs["Surface"])
    mat.blend_method = "BLEND"
    mat.show_transparent_back = True
    return mat


def glass_material(name):
    """Frosted backing; noise distorts only the world behind, never the UI."""
    mat = new_material(name)
    glass_cfg = ENVIRONMENT.get("glass", {})
    cfg = nested(glass_cfg, ("layers", "backing"), glass_cfg)
    bsdf = add_node(mat, "ShaderNodeBsdfPrincipled", "Glass")
    out = add_node(mat, "ShaderNodeOutputMaterial", "Out")
    base = rgb(cfg.get("baseColor"), (0.08, 0.14, 0.22))
    set_input(bsdf, "Base Color", (base[0], base[1], base[2], 1.0))
    set_input(bsdf, "Roughness", float(cfg.get("roughness", 0.22)))
    set_input(bsdf, "IOR", float(cfg.get("ior", 1.45)))
    set_input(bsdf, "Transmission Weight", float(cfg.get("transmission", 0.78)))
    set_input(bsdf, "Coat Weight", float(cfg.get("coatWeight", 0.14)))
    set_input(bsdf, "Coat Roughness", float(cfg.get("coatRoughness", 0.16)))

    coords = add_node(mat, "ShaderNodeTexCoord", "Coordinates")
    noise = add_node(mat, "ShaderNodeTexNoise", "Frost")
    set_input(noise, "Scale", float(cfg.get("frostScale", 7.5)))
    set_input(noise, "Detail", float(cfg.get("frostDetail", 2.0)))
    set_input(noise, "Roughness", 0.58)
    bump = add_node(mat, "ShaderNodeBump", "FrostBump")
    set_input(bump, "Strength", float(cfg.get("frostStrength", 0.11)))
    set_input(bump, "Distance", float(cfg.get("frostDistance", 0.025)))
    link(mat, coords.outputs["Generated"], noise.inputs["Vector"])
    link(mat, noise.outputs["Fac"], bump.inputs["Height"])
    link(mat, bump.outputs["Normal"], bsdf.inputs["Normal"])
    link(mat, bsdf.outputs["BSDF"], out.inputs["Surface"])
    if hasattr(mat, "surface_render_method"):
        try:
            mat.surface_render_method = "DITHERED"
        except Exception:
            pass
    return mat


def clear_cover_material(name):
    """Nearly transparent front shell: specular glass without frosting UI pixels."""
    mat = new_material(name)
    cfg = nested(ENVIRONMENT, ("glass", "layers", "coverRim"), {})
    transparent = add_node(mat, "ShaderNodeBsdfTransparent", "Transparent")
    bsdf = add_node(mat, "ShaderNodeBsdfPrincipled", "ClearCover")
    set_input(bsdf, "Base Color", (0.75, 0.9, 1.0, 1.0))
    set_input(bsdf, "Roughness", float(cfg.get("roughness", 0.035)))
    set_input(bsdf, "IOR", float(cfg.get("ior", 1.45)))
    set_input(bsdf, "Transmission Weight", float(cfg.get("transmission", 0.97)))
    set_input(bsdf, "Coat Weight", float(cfg.get("coatWeight", 0.25)))
    mix = add_node(mat, "ShaderNodeMixShader", "CoverMix")
    mix.inputs[0].default_value = float(cfg.get("opacity", 0.055))
    out = add_node(mat, "ShaderNodeOutputMaterial", "Out")
    link(mat, transparent.outputs["BSDF"], mix.inputs[1])
    link(mat, bsdf.outputs["BSDF"], mix.inputs[2])
    link(mat, mix.outputs["Shader"], out.inputs["Surface"])
    mat.blend_method = "BLEND"
    mat.show_transparent_back = True
    return mat


def edge_accent_material(name, color, strength):
    """Restrained cyan/brand-blue perimeter emission."""
    mat = new_material(name)
    em = add_node(mat, "ShaderNodeEmission", "Emit")
    set_input(em, "Color", (color[0], color[1], color[2], 1.0))
    set_input(em, "Strength", strength)
    out = add_node(mat, "ShaderNodeOutputMaterial", "Out")
    link(mat, em.outputs["Emission"], out.inputs["Surface"])
    return mat


def editorial_text_material(name, color, strength):
    """Camera-facing title material with deterministic keyed opacity."""
    mat = new_material(name)
    emission = add_node(mat, "ShaderNodeEmission", "EditorialEmission")
    set_input(emission, "Color", (*color, 1.0))
    set_input(emission, "Strength", strength)
    opacity = add_node(mat, "ShaderNodeValue", "Opacity")
    opacity.outputs[0].default_value = 0.0
    transparent = add_node(mat, "ShaderNodeBsdfTransparent", "Transparent")
    mix = add_node(mat, "ShaderNodeMixShader", "EditorialMix")
    out = add_node(mat, "ShaderNodeOutputMaterial", "Out")
    link(mat, opacity.outputs[0], mix.inputs[0])
    link(mat, transparent.outputs["BSDF"], mix.inputs[1])
    link(mat, emission.outputs["Emission"], mix.inputs[2])
    link(mat, mix.outputs["Shader"], out.inputs["Surface"])
    mat.blend_method = "BLEND"
    return mat


def cursor_material(name, color):
    return edge_accent_material(name, color, 1.0)


def cloud_card_material(name, config, image=None):
    """Deterministic dark 2.5D atmosphere with texture/procedural alpha."""
    mat = new_material(name)
    coords = add_node(mat, "ShaderNodeTexCoord", "Coordinates")
    mapping = add_node(mat, "ShaderNodeMapping", "Mapping")
    source_socket = None
    if image is not None:
        texture = add_node(mat, "ShaderNodeTexImage", "CloudTexture")
        texture.image = image
        texture.extension = "REPEAT"
        bw = add_node(mat, "ShaderNodeRGBToBW", "CloudLuminance")
        uv_scale = config.get("uvScale", [1.0, 1.0, 1.0])
        uv_offset = config.get("uvOffset", [0.0, 0.0, 0.0])
        set_input(mapping, "Scale", (float(uv_scale[0]), float(uv_scale[1]),
                                     float(uv_scale[2] if len(uv_scale) > 2 else 1.0)))
        set_input(mapping, "Location", (float(uv_offset[0]), float(uv_offset[1]),
                                        float(uv_offset[2] if len(uv_offset) > 2 else 0.0)))
        link(mat, mapping.outputs["Vector"], texture.inputs["Vector"])
        link(mat, texture.outputs["Color"], bw.inputs["Color"])
        source_socket = bw.outputs["Val"]
    else:
        noise = add_node(mat, "ShaderNodeTexNoise", "CloudNoise")
        set_input(noise, "Scale", float(config.get("noiseScale", 2.2)))
        set_input(noise, "Detail", float(config.get("detail", 3.0)))
        set_input(noise, "Roughness", float(config.get("noiseRoughness", 0.62)))
        link(mat, mapping.outputs["Vector"], noise.inputs["Vector"])
        source_socket = noise.outputs["Fac"]
    ramp = add_node(mat, "ShaderNodeValToRGB", "CloudShape")
    ramp.color_ramp.elements[0].position = float(config.get("low", 0.38))
    ramp.color_ramp.elements[0].color = (0.0, 0.0, 0.0, 1.0)
    ramp.color_ramp.elements[1].position = float(config.get("high", 0.68))
    ramp.color_ramp.elements[1].color = (1.0, 1.0, 1.0, 1.0)
    opacity = add_node(mat, "ShaderNodeMath", "Opacity")
    opacity.operation = "MULTIPLY"
    opacity.inputs[1].default_value = float(config.get("opacity", 0.08))
    transparent = add_node(mat, "ShaderNodeBsdfTransparent", "Transparent")
    emission = add_node(mat, "ShaderNodeEmission", "CloudGlow")
    tint = config.get("tint", [0.06, 0.16, 0.25])
    set_input(emission, "Color", (tint[0], tint[1], tint[2], 1.0))
    set_input(emission, "Strength", float(config.get("emission", 0.55)))
    mix = add_node(mat, "ShaderNodeMixShader", "CloudMix")
    out = add_node(mat, "ShaderNodeOutputMaterial", "Out")
    link(mat, coords.outputs["UV" if image is not None else "Generated"],
         mapping.inputs["Vector"])
    link(mat, source_socket, ramp.inputs["Fac"])
    link(mat, ramp.outputs["Color"], opacity.inputs[0])
    link(mat, opacity.outputs[0], mix.inputs["Factor"])
    link(mat, transparent.outputs["BSDF"], mix.inputs[1])
    link(mat, emission.outputs["Emission"], mix.inputs[2])
    link(mat, mix.outputs["Shader"], out.inputs["Surface"])
    mat.blend_method = "BLEND"
    mat.show_transparent_back = True
    return mat


def brushed_metal_material(name, base=(0.038, 0.043, 0.055),
                           roughness=0.42, noise_strength=0.25):
    """Dark brushed metal: metallic base with noise-driven roughness."""
    mat = new_material(name)
    bsdf = add_node(mat, "ShaderNodeBsdfPrincipled", "Metal")
    out = add_node(mat, "ShaderNodeOutputMaterial", "Out")
    set_input(bsdf, "Base Color", (base[0], base[1], base[2], 1.0))
    set_input(bsdf, "Metallic", 1.0)
    noise = add_node(mat, "ShaderNodeTexNoise", "Brush")
    set_input(noise, "Scale", 18.0)
    fma = add_node(mat, "ShaderNodeMath", "BrushMix")
    fma.operation = "MULTIPLY_ADD"
    fma.inputs[1].default_value = noise_strength
    fma.inputs[2].default_value = roughness
    link(mat, noise.outputs["Fac"], fma.inputs[0])
    link(mat, fma.outputs[0], bsdf.inputs["Roughness"])
    link(mat, bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


def led_material(name, color, strength=12.0):
    mat = new_material(name)
    em = add_node(mat, "ShaderNodeEmission", "Emit")
    set_input(em, "Color", (color[0], color[1], color[2], 1.0))
    set_input(em, "Strength", strength)
    out = add_node(mat, "ShaderNodeOutputMaterial", "Out")
    link(mat, em.outputs["Emission"], out.inputs["Surface"])
    return mat


def fog_material(name, density=0.012, tint=(0.30, 0.36, 0.45)):
    mat = new_material(name)
    vol = add_node(mat, "ShaderNodeVolumePrincipled", "Fog")
    out = add_node(mat, "ShaderNodeOutputMaterial", "Out")
    set_input(vol, "Color", (tint[0], tint[1], tint[2], 1.0))
    set_input(vol, "Density", density)
    set_input(vol, "Anisotropy", 0.0)
    link(mat, vol.outputs["Volume"], out.inputs["Volume"])
    return mat


# ---------------------------------------------------------------------------
# Mesh helpers
# ---------------------------------------------------------------------------
def newell(verts, face):
    n = [0.0, 0.0, 0.0]
    pts = [verts[i] for i in face]
    k = len(pts)
    for i in range(k):
        a, b = pts[i], pts[(i + 1) % k]
        n[0] += (a[1] - b[1]) * (a[2] + b[2])
        n[1] += (a[2] - b[2]) * (a[0] + b[0])
        n[2] += (a[0] - b[0]) * (a[1] + b[1])
    return n


def outward_faces(verts, faces):
    cx = sum(v[0] for v in verts) / len(verts)
    cy = sum(v[1] for v in verts) / len(verts)
    cz = sum(v[2] for v in verts) / len(verts)
    center = (cx, cy, cz)
    result = []
    for face in faces:
        n = newell(verts, face)
        centroid = tuple(
            sum(verts[i][k] for i in face) / len(face) for k in range(3))
        if (n[0] * (centroid[0] - center[0]) +
                n[1] * (centroid[1] - center[1]) +
                n[2] * (centroid[2] - center[2])) < 0:
            result.append(tuple(reversed(face)))
        else:
            result.append(tuple(face))
    return result


def make_box_mesh(name, w, d, h):
    """Box centred on the origin with outward-facing normals."""
    x, y, z = w / 2.0, d / 2.0, h / 2.0
    verts = [
        (-x, -y, -z), (x, -y, -z), (x, y, -z), (-x, y, -z),
        (-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z),
    ]
    faces = [
        (0, 1, 2, 3),  # bottom
        (4, 7, 6, 5),  # top
        (0, 4, 5, 1),  # front (-y)
        (2, 6, 7, 3),  # back (+y)
        (1, 5, 6, 2),  # right (+x)
        (3, 7, 4, 0),  # left (-x)
    ]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], outward_faces(verts, faces))
    mesh.update()
    return mesh


def rounded_rect_points(w, h, radius, segments=10):
    """Clockwise rounded-rectangle outline in local X/Z coordinates."""
    r = max(0.0, min(float(radius), min(w, h) / 2.0 - 1e-6))
    corners = [
        (w / 2.0 - r, -h / 2.0 + r, -90.0, 0.0),
        (w / 2.0 - r, h / 2.0 - r, 0.0, 90.0),
        (-w / 2.0 + r, h / 2.0 - r, 90.0, 180.0),
        (-w / 2.0 + r, -h / 2.0 + r, 180.0, 270.0),
    ]
    points = []
    for cx, cz, a0, a1 in corners:
        for step in range(segments + 1):
            angle = math.radians(a0 + (a1 - a0) * step / float(segments))
            points.append((cx + r * math.cos(angle),
                           cz + r * math.sin(angle)))
    return points


def make_rounded_panel_mesh(name, w, d, h, radius, segments=10):
    """Closed 5 mm rounded slab with matching front/back silhouettes."""
    outline = rounded_rect_points(w, h, radius, segments)
    verts = [(x, -d / 2.0, z) for x, z in outline]
    verts += [(x, d / 2.0, z) for x, z in outline]
    count = len(outline)
    faces = [tuple(range(count)), tuple(range(count, count * 2))]
    for i in range(count):
        j = (i + 1) % count
        faces.append((i, j, count + j, count + i))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], outward_faces(verts, faces))
    mesh.update()
    return mesh


def make_rounded_plane_mesh(name, w, h, radius, segments=10):
    """Rounded XZ image plane whose UVs geometrically clip capture corners."""
    outline = rounded_rect_points(w, h, radius, segments)
    verts = [(x, 0.0, z) for x, z in outline]
    faces = [tuple(range(len(verts)))]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    uv = mesh.uv_layers.new(name="UVMap")
    if w <= 0.0 or h <= 0.0:
        raise FilmError("rounded plane dimensions must be positive")
    for poly in mesh.polygons:
        for loop_index in poly.loop_indices:
            vertex_index = mesh.loops[loop_index].vertex_index
            vertex = verts[vertex_index]
            uv.data[loop_index].uv = (
                vertex[0] / w + 0.5, vertex[2] / h + 0.5)
    mesh.update()
    return mesh


def make_cursor_mesh(name, scale=0.06):
    """A simple pointer silhouette in XZ, anchored at its top-left tip."""
    pts = [(0.0, 0.0), (0.0, -1.0), (0.27, -0.73), (0.47, -1.12),
           (0.64, -1.03), (0.43, -0.64), (0.82, -0.62)]
    verts = [(x * scale, 0.0, z * scale) for x, z in pts]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], [tuple(range(len(verts)))])
    mesh.update()
    return mesh


def add_mesh_object(scene, mesh, name, material, parent=None):
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    if material:
        obj.data.materials.append(material)
    if parent is not None:
        obj.parent = parent
    return obj


def ui_plane_local_transform(index, face):
    """Return the parent-local transform emitted for a UI plane."""
    is_back = face == "back"
    sign = 1.0 if is_back else -1.0
    layer = index * 0.000012
    return ((0.0, sign * (SLAB_HALF_T + UI_OFFSET + layer), 0.0),
            (0.0, 0.0, 0.0),
            (-1.0 if is_back else 1.0, 1.0, 1.0))


# ---------------------------------------------------------------------------
# Environment: world, lights, procedural server geometry, fog
# ---------------------------------------------------------------------------
def build_world(scene):
    world = scene.world
    if world is None:
        world = bpy.data.worlds.new("SkyBaoWorld")
        scene.world = world
    world.use_nodes = True
    for node in list(world.node_tree.nodes):
        world.node_tree.nodes.remove(node)
    bg = world.node_tree.nodes.new("ShaderNodeBackground")
    out = world.node_tree.nodes.new("ShaderNodeOutputWorld")
    world_cfg = ENVIRONMENT.get("world", {})
    color = rgb(world_cfg.get(
        "color", ENVIRONMENT.get("lighting", {}).get("world")),
        (0.004, 0.008, 0.015))
    bg.inputs["Color"].default_value = (
        color[0], color[1], color[2], 1.0)
    bg.inputs["Strength"].default_value = float(
        world_cfg.get("strength", 0.85))
    world.node_tree.links.new(bg.outputs["Background"], out.inputs["Surface"])


def add_light(scene, name, kind, location, target, energy, color, size=None):
    data = bpy.data.lights.new(name, kind)
    data.energy = energy
    data.color = (color[0], color[1], color[2])
    if kind == "AREA" and size is not None:
        data.size = size
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj.location = Vector(location)
    direction = Vector(target) - Vector(location)
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    return obj


def build_lights(scene):
    """Low-key neutral/cyan/brand-blue rig; no red, magenta, or green."""
    lights = ENVIRONMENT.get("lights", [])
    if not lights:
        palette = ENVIRONMENT.get("lighting", {})
        lights = [
            {"name": "Key.light", "location": [0.0, 1.8, 3.3],
             "energy": 105.0, "color": rgb(
                 palette.get("key"), (0.82, 0.90, 1.0)), "size": 1.6},
            {"name": "Rim.cyan", "location": [3.6, 0.2, 1.5],
             "energy": 46.0, "color": rgb(
                 palette.get("rim"), (0.0, 0.72, 1.0)), "size": 1.0},
            {"name": "Rim.blue", "location": [-3.6, 0.2, 0.3],
             "energy": 34.0, "color": [0.08, 0.35, 1.0], "size": 1.0},
            {"name": "Fill.camera", "location": [0.0, -4.2, 1.2],
             "energy": 12.0, "color": rgb(
                 palette.get("fill"), (0.72, 0.82, 0.96)), "size": 1.8},
        ]
    for item in lights:
        add_light(scene, item["name"], item.get("kind", "AREA"),
                  item["location"], item.get("target", [0.0, 0.0, 0.0]),
                  energy=float(item["energy"]), color=item["color"],
                  size=float(item.get("size", 1.0)))


def build_server_room(scene, materials):
    """Dark brushed-metal floor and flanking server racks with blue LEDs."""
    floor = add_mesh_object(
        scene, make_box_mesh("floor.mesh", 40.0, 40.0, 0.12),
        "Env.floor", materials["metal"])
    floor.location.z = -1.35

    rack_mat = materials["metal"]
    led_cyan = materials["led_cyan"]
    led_blue = materials["led_blue"]

    def rack(x, z, led_color, led_side):
        body = add_mesh_object(
            scene, make_box_mesh("rack.{0}.mesh".format(x), 0.5, 0.62, 2.7),
            "Env.rack.{0}".format(x), rack_mat)
        body.location = (x, z, 0.0)
        for k in (-0.9, 0.0, 0.9):
            slit = add_mesh_object(
                scene, make_box_mesh("slit.mesh", 0.06, 0.02, 0.62),
                "Env.slit.{0}.{1}".format(x, k), led_color, parent=body)
            slit.location = (led_side * 0.28, 0.0, k)
            slit.scale.x = led_side
        return body

    rack(-3.7, -1.4, led_cyan, 1)
    rack(3.7, -1.4, led_blue, -1)
    rack(-1.7, -3.2, led_cyan, 1)
    rack(1.7, -3.2, led_blue, -1)

    # Two thin horizontal server rails behind the slab for depth.
    # Camera is on negative Y, so positive Y keeps these rails behind the UI.
    for y in (1.0, 2.0):
        rail = add_mesh_object(
            scene, make_box_mesh("rail.mesh", 7.2, 0.03, 0.03),
            "Env.rail.{0}".format(y), rack_mat)
        rail.location = (0.0, y, -0.55)

    # Depth now comes from deterministic cloud cards. A uniform fog box hid
    # the refraction and made the set look flat, so it is intentionally gone.


def build_cloud_cards(scene, total, paths):
    """Three inexpensive textured atmosphere layers with slow parallax."""
    cards = ENVIRONMENT.get("cloudCards", [])
    objects = []
    for index, config in enumerate(cards):
        card_cfg = dict(config)
        card_cfg.setdefault("noiseScale", 1.7 + index * 0.55)
        card_cfg.setdefault("detail", 3.2)
        card_cfg.setdefault("tint", [0.055 + index * 0.012,
                                     0.14 + index * 0.018,
                                     0.24 + index * 0.025])
        image = None
        source = config.get("source")
        if source:
            image = _load_image(safe_repo_path(
                paths["repo"], source, "environment cloudCards[{0}].source".format(index)))
        material = cloud_card_material(
            "Mat.cloud.{0}".format(config.get("id", index)), card_cfg, image)
        width = float(config.get("width", 9.5 + index * 2.0))
        height = float(config.get("height", 5.2 + index * 1.0))
        plane = add_mesh_object(
            scene,
            make_rounded_plane_mesh(
                "cloud.{0}.mesh".format(index), width, height,
                float(config.get("cornerRadius", 0.8)), 16),
            "Env.cloud.{0}".format(config.get("id", index)), material)
        phase = float(config.get("phase", 0.0))
        start = config.get("start", [
            (phase - 0.5) * 0.55,
            float(config.get("depthM", 1.5 + index)),
            (0.5 - phase) * 0.18,
        ])
        drift = config.get("drift", [
            float(config.get("driftWidthRatio", 0.03)) * SLAB_W,
            0.0,
            float(config.get("driftHeightRatio", 0.01)) * SLAB_H,
        ])
        period = max(1.0, float(config.get("periodSeconds", 18.0)))
        sample_frames = set(range(1, total + 1, max(1, FPS // 2)))
        sample_frames.add(total)
        for frame in sorted(sample_frames):
            angle = 2.0 * math.pi * (
                (frame - 1) / float(FPS) / period + phase)
            amount = math.sin(angle)
            plane.location = (
                float(start[0]) + float(drift[0]) * amount,
                float(start[1]) + float(drift[1]) * amount,
                float(start[2]) + float(drift[2]) * amount,
            )
            plane.keyframe_insert(data_path="location", frame=frame)
        objects.append(plane)
    return objects


# ---------------------------------------------------------------------------
# The glass slab + UI image planes
# ---------------------------------------------------------------------------
def rounded_rect_perimeter_point(progress, w, h, radius):
    """Point on the rounded perimeter, parameterized by approximate arc length."""
    points = rounded_rect_points(w, h, radius, 24)
    lengths = []
    total = 0.0
    for index, point in enumerate(points):
        nxt = points[(index + 1) % len(points)]
        length = math.hypot(nxt[0] - point[0], nxt[1] - point[1])
        lengths.append(length)
        total += length
    target = (progress % 1.0) * total
    walked = 0.0
    for index, length in enumerate(lengths):
        if walked + length >= target:
            amount = 0.0 if length <= 1e-9 else (target - walked) / length
            a = points[index]
            b = points[(index + 1) % len(points)]
            return (a[0] + (b[0] - a[0]) * amount,
                    a[1] + (b[1] - a[1]) * amount)
        walked += length
    return points[0]


def add_perimeter_curve(scene, slab, material):
    points = rounded_rect_points(SLAB_W, SLAB_H, SLAB_RADIUS, 16)
    curve_data = bpy.data.curves.new("glass.perimeter.curve", "CURVE")
    curve_data.dimensions = "3D"
    curve_data.resolution_u = 2
    curve_data.bevel_depth = float(nested(
        ENVIRONMENT, ("edge", "curveBevelM"), nested(
            ENVIRONMENT, ("edge", "bevelDepth"), 0.0009)))
    curve_data.bevel_resolution = 3
    spline = curve_data.splines.new("POLY")
    spline.points.add(len(points) - 1)
    for point, (x, z) in zip(spline.points, points):
        point.co = (x, 0.0, z, 1.0)
    spline.use_cyclic_u = True
    obj = bpy.data.objects.new("Glass.perimeter", curve_data)
    scene.collection.objects.link(obj)
    curve_data.materials.append(material)
    obj.parent = slab
    return obj


def add_feathered_glint(scene, slab, material, length, bevel):
    """Short tapered curve that reads as a specular edge sweep, not an LED dot."""
    curve_data = bpy.data.curves.new("glass.glint.curve", "CURVE")
    curve_data.dimensions = "3D"
    curve_data.resolution_u = 2
    curve_data.bevel_depth = bevel
    curve_data.bevel_resolution = 3
    spline = curve_data.splines.new("NURBS")
    taper = (0.04, 0.2, 0.55, 0.86, 1.0, 0.86, 0.55, 0.2, 0.04)
    spline.points.add(len(taper) - 1)
    for index, (point, radius) in enumerate(zip(spline.points, taper)):
        position = (index / float(len(taper) - 1) - 0.5) * length
        point.co = (position, 0.0, 0.0, 1.0)
        point.radius = radius
    spline.order_u = min(4, len(taper))
    spline.use_endpoint_u = True
    obj = bpy.data.objects.new("Glass.traveling-glint", curve_data)
    scene.collection.objects.link(obj)
    curve_data.materials.append(material)
    obj.parent = slab
    return obj


def build_slab(scene, materials, total):
    """Rounded layered glass with a quiet cyan perimeter and traveling glint."""
    slab = add_mesh_object(
        scene, make_rounded_panel_mesh(
            "slab.glass.mesh", SLAB_W, SLAB_T, SLAB_H, SLAB_RADIUS,
            CORNER_SEGMENTS),
        "Glass.slab", materials["glass"])
    bevel = slab.modifiers.new("Bevel", "BEVEL")
    bevel.width = float(nested(
        ENVIRONMENT, ("glass", "layers", "coverRim", "bevelM"), nested(
            ENVIRONMENT, ("glass", "edgeBevel"), 0.0010)))
    bevel.segments = 4
    bevel.limit_method = "NONE"
    bevel.use_clamp_overlap = True

    add_perimeter_curve(scene, slab, materials["edge_cyan"])

    # A tapered, low-emission segment makes one slow perimeter lap. Its soft
    # ends and tiny bevel keep it from reading as a floating LED dot or bar.
    glint = add_feathered_glint(
        scene, slab, materials["edge_glint"],
        float(nested(ENVIRONMENT, ("edge", "glintLengthM"), 0.075)),
        float(nested(ENVIRONMENT, ("edge", "glintBevelM"), 0.00055)))
    circuit_seconds = float(nested(
        ENVIRONMENT, ("edge", "highlightCircuitSeconds"), 14.0))
    circuits = float(nested(
        ENVIRONMENT, ("edge", "circuitsOverFilm"),
        (total / float(FPS)) / max(1.0, circuit_seconds)))
    for frame in range(1, total + 1, 10):
        progress = circuits * (frame - 1) / max(1.0, total - 1.0)
        x, z = rounded_rect_perimeter_point(
            progress, SLAB_W, SLAB_H, SLAB_RADIUS)
        glint.location = (x, 0.0, z)
        glint.keyframe_insert(data_path="location", frame=frame)
        before = rounded_rect_perimeter_point(
            progress - 0.0005, SLAB_W, SLAB_H, SLAB_RADIUS)
        after = rounded_rect_perimeter_point(
            progress + 0.0005, SLAB_W, SLAB_H, SLAB_RADIUS)
        tangent = math.atan2(after[1] - before[1], after[0] - before[0])
        glint.rotation_euler.y = -tangent
        glint.keyframe_insert(data_path="rotation_euler", frame=frame)
        breath_amount = float(nested(
            ENVIRONMENT, ("edge", "highlightBreath"), 0.08))
        breath = 1.0 + breath_amount * math.sin(
            2.0 * math.pi * frame / (FPS * 5.0))
        glint.scale = (breath, breath, breath)
        glint.keyframe_insert(data_path="scale", frame=frame)

    slab.rotation_euler.x = math.radians(float(nested(
        ENVIRONMENT, ("glass", "tiltDegrees"), 3.0)))
    return slab


def build_clear_covers(scene, slab, material):
    """Add crisp, unfrosted front/back shells above the UI layer."""
    offset = SLAB_HALF_T + UI_OFFSET + 0.00035
    covers = []
    for face, sign in (("front", -1.0), ("back", 1.0)):
        cover = add_mesh_object(
            scene,
            make_rounded_plane_mesh(
                "glass.cover.{0}.mesh".format(face),
                SLAB_W, SLAB_H, SLAB_RADIUS, CORNER_SEGMENTS),
            "Glass.cover.{0}".format(face), material, parent=slab)
        cover.location.y = sign * offset
        covers.append(cover)
    return covers


def _load_image(path):
    require_file(path)
    img = bpy.data.images.load(path, check_existing=True)
    if hasattr(img, "alpha_mode"):
        try:
            img.alpha_mode = "STRAIGHT"
        except Exception:
            pass
    try:
        img.reload()
    except Exception:
        pass
    # Keep provenance on the datablock as well as in filepath.  Packing an
    # image (or Blender's staged-save path remap) can remove the latter; the
    # digest is only useful when consumers bind it back to these exact bytes.
    img["anything_llm_capture_source"] = os.path.realpath(path)
    img["anything_llm_capture_sha256"] = sha256_file(path)
    return img


def _set_opacity(material, frame, value):
    node = material.node_tree.nodes.get("Opacity")
    if node is None:
        return
    node.outputs[0].default_value = float(value)
    node.outputs[0].keyframe_insert(data_path="default_value", frame=frame)


def _iter_action_fcurves(animation_data):
    """Yield F-curves on both legacy and slotted Blender Actions.

    Blender 5.2 removed ``Action.fcurves`` in favour of channel bags.  Do
    not rely on the version number: files can be opened by a newer minor
    release, and the legacy collection is still present in older releases.
    """
    action = getattr(animation_data, "action", None) if animation_data else None
    if action is None:
        return
    seen = set()

    def emit(collection):
        for curve in collection or []:
            marker = id(curve)
            if marker not in seen:
                seen.add(marker)
                yield curve

    yield from emit(getattr(action, "fcurves", None))
    slots = list(getattr(action, "slots", []) or [])
    for layer in list(getattr(action, "layers", []) or []):
        for strip in list(getattr(layer, "strips", []) or []):
            yield from emit(getattr(strip, "fcurves", None))
            for bag in list(getattr(strip, "channelbags", []) or []):
                yield from emit(getattr(bag, "fcurves", None))
            channelbag = getattr(strip, "channelbag", None)
            if callable(channelbag):
                for slot in slots:
                    try:
                        yield from emit(getattr(channelbag(slot), "fcurves", None))
                    except (TypeError, RuntimeError):
                        continue


def _set_deterministic_easing(animation_data):
    """Make all generated keys use the same bounded, reproducible easing."""
    for fcurve in _iter_action_fcurves(animation_data):
        for key in fcurve.keyframe_points:
            key.interpolation = "BEZIER"
            key.handle_left_type = "AUTO_CLAMPED"
            key.handle_right_type = "AUTO_CLAMPED"


def build_ui_planes(scene, slab, shotlist, catalog_index, paths, manifest):
    """Layer rounded UI planes; dissolve within areas and overlap at flips."""
    shots = shotlist["shots"]
    planes = []
    for index, shot in enumerate(shots):
        src = shot["source"]
        entry = catalog_index.get(
            (src["type"], src["id"], src.get("framing")),
            catalog_index.get((src["type"], src["id"], None)))
        if not entry:
            raise FilmError("shot {0}: {1} {2} ({3}) not in catalog".format(
                shot["number"], src["type"], src["id"], src.get("framing")))

        bounded_frame_range(shot["frames"]["start"], shot["frames"]["end"],
                            "shot {0} frame range".format(shot["number"]),
                            int(shotlist["format"]["frames"]))
        shot_start = shot["frames"]["start"]
        shot_end = shot["frames"]["end"]
        face = shot.get("face", "front")
        is_back = face == "back"
        previous = shots[index - 1] if index > 0 else None
        following = shots[index + 1] if index + 1 < len(shots) else None
        flip_in = previous is not None and previous.get("face") != face
        flip_out = following is not None and following.get("face") != face
        dissolve_in = bool(shot.get("transitionIn", {}).get("type") ==
                           "same-face-dissolve")
        dissolve_out = bool(following and following.get(
            "transitionIn", {}).get("type") == "same-face-dissolve")

        render_start = shot_start - (ROT_FRAMES // 2 if flip_in else 0)
        render_end = shot_end + (ROT_FRAMES // 2 if flip_out else
                                 DISSOLVE_FRAMES if dissolve_out else 0)
        render_start = max(1, render_start)
        render_end = min(int(shotlist["format"]["frames"]), render_end)

        clip_info = None
        if src["type"] == "clip":
            bounded_frame_range(src["startFrame"], src["endFrame"],
                                "shot {0} source frame range".format(shot["number"]))
            if src["endFrame"] > entry.get("frameCount", 0):
                raise FilmError("shot {0}: source trim exceeds catalog frameCount".format(shot["number"]))
            directory = safe_catalog_path(paths["ui"], entry.get("directory"),
                                          "shot {0} catalog directory".format(shot["number"]))
            timeline = (safe_catalog_path(paths["ui"], entry.get("timeline"),
                                          "shot {0} catalog timeline".format(shot["number"]))
                        if entry.get("timeline") is not None else None)
            first = safe_clip_frame(directory, src["startFrame"],
                                    "shot {0} source PNG".format(shot["number"]))
            image = _load_image(first)
            clip_info = {
                "directory": directory,
                "trim_start": src["startFrame"],
                "trim_end": src["endFrame"],
                "shot_start": shot_start,
                "shot_end": shot_end,
                "render_start": render_start,
                "render_end": render_end,
                "timeline": timeline,
                "shot": shot,
                "face": face,
            }
        else:
            image = _load_image(safe_catalog_path(
                paths["ui"], entry.get("file"),
                "shot {0} catalog file".format(shot["number"])))

        mat = ui_material("UI.mat.S{0:02d}".format(shot["number"]), image)
        plane = add_mesh_object(
            scene,
            make_rounded_plane_mesh(
                 "ui.{0}.mesh".format(shot["number"]),
                  UI_W, UI_H,
                  UI_RADIUS, CORNER_SEGMENTS),
            "UI.S{0:02d}.{1}".format(shot["number"], face), mat, parent=slab)

        # Later shots sit microns closer during a dissolve, avoiding z-fight.
        # These are parent-local transforms; the slab owns the world flip.
        local_location, local_rotation, local_scale = ui_plane_local_transform(index, face)
        plane.location = local_location
        plane.rotation_euler = local_rotation
        plane.scale = local_scale
        layer = index * 0.000012
        if clip_info:
            clip_info["plane"] = plane
            clip_info["layer"] = layer
            FILM_CLIP_INFO.append(clip_info)

        plane.hide_render = True
        if render_start > 1:
            plane.keyframe_insert(data_path="hide_render",
                                  frame=render_start - 1)
        plane.hide_render = False
        plane.keyframe_insert(data_path="hide_render", frame=render_start)
        plane.hide_render = True
        plane.keyframe_insert(data_path="hide_render", frame=render_end + 1)

        _set_opacity(mat, render_start, 1.0 if flip_in else
                     0.0 if dissolve_in else 1.0)
        if dissolve_in:
            # Six displayed frames are S..S+5.  Keeping both keys on that
            # exact window makes the two alpha curves complementary at every
            # rendered boundary frame (there is no S-1/S+6 boundary dip).
            _set_opacity(mat, min(render_end, shot_start + DISSOLVE_FRAMES - 1), 1.0)
        if dissolve_out:
            dissolve_start = following["frames"]["start"]
            _set_opacity(mat, dissolve_start, 1.0)
            _set_opacity(mat, render_end, 0.0)
        planes.append(plane)

    manifest["ui_planes"] = len(planes)
    return planes


def _load_editorial_font():
    # Deliberately use Blender's built-in Bfont.  Platform font paths change
    # glyph metrics and can move a lower-third outside the safe area.
    return None


def _set_editorial_opacity(material, frame, value):
    node = material.node_tree.nodes.get("Opacity")
    node.outputs[0].default_value = float(value)
    node.outputs[0].keyframe_insert(data_path="default_value", frame=frame)


def build_editorial_callouts(scene, slab, shotlist, manifest):
    """Create true Blender lower-thirds, independent of the captured UI pixels."""
    callouts = shotlist.get("editorialCallouts", [])
    color = rgb(nested(ENVIRONMENT, ("editorial", "textColor"), "#E8F6FF"))
    strength = float(nested(ENVIRONMENT, ("editorial", "emissionStrength"), 1.4))
    font = _load_editorial_font()
    for callout in callouts:
        start = int(callout["frames"]["start"])
        end = int(callout["frames"]["end"])
        fade = int(callout.get("fadeFrames", 8))
        face = callout["face"]
        sign = 1.0 if face == "back" else -1.0
        mat = editorial_text_material(
            "Editorial.mat." + callout["id"], color, strength)
        data = bpy.data.curves.new("Editorial.text." + callout["id"], "FONT")
        data.body = callout["text"]
        data.align_x = "LEFT"
        data.align_y = "CENTER"
        data.size = float(callout.get("fontSizeM", 0.115))
        data.extrude = 0.00035
        data.space_character = 1.05
        if font is not None:
            data.font = font
        text = bpy.data.objects.new("Editorial." + callout["id"], data)
        scene.collection.objects.link(text)
        text.parent = slab
        # positionM is a screen-space LEFT/CENTER anchor.  The back face needs
        # both local axes mirrored: X restores reading order and Y counters the
        # panel's 180-degree screen rotation so glyphs remain upright.
        screen_x = float(callout["positionM"][0])
        local_x = -screen_x if face == "back" else screen_x
        text.location = (local_x,
                         sign * (SLAB_HALF_T + UI_OFFSET + 0.0012),
                         float(callout["positionM"][1]))
        text.rotation_euler = (math.radians(-90.0 if face == "back" else 90.0), 0.0, 0.0)
        text.scale = (-1.0, -1.0, 1.0) if face == "back" else (1.0, 1.0, 1.0)
        text.data.materials.append(mat)
        text.hide_render = True
        text.keyframe_insert(data_path="hide_render", frame=max(1, start - fade - 1))
        text.hide_render = False
        text.keyframe_insert(data_path="hide_render", frame=max(1, start - fade))
        text.hide_render = True
        text.keyframe_insert(data_path="hide_render", frame=min(shotlist["format"]["frames"], end + fade + 1))
        _set_editorial_opacity(mat, max(1, start - fade), 0.0)
        _set_editorial_opacity(mat, start, 1.0)
        _set_editorial_opacity(mat, end, 1.0)
        _set_editorial_opacity(mat, min(shotlist["format"]["frames"], end + fade), 0.0)
    manifest["editorial_callouts"] = len(callouts)


def build_cursor_tracks(scene, slab, catalog_index, paths, materials, manifest):
    """Render sparse timelines using two shared face rigs.

    A consecutive explicit move run is a real drag/path and is keyed at its
    captured coordinates with LINEAR interpolation. Other event clusters are
    static, short-lived registrations around their event. ``provenance`` still
    records every logical shot track; the geometry is deliberately shared.
    """
    count = 0
    provenance = []
    skipped = []
    rigs = {}
    shared_outer_mesh = make_cursor_mesh("cursor.shared.outer.mesh", 0.069)
    shared_inner_mesh = make_cursor_mesh("cursor.shared.inner.mesh", 0.053)
    for face, face_sign in (("front", -1.0), ("back", 1.0)):
        root = bpy.data.objects.new("CursorRig.{0}".format(face), None)
        scene.collection.objects.link(root)
        root.parent = slab
        root.scale.x = -1.0 if face == "back" else 1.0
        root.location.y = face_sign * (SLAB_HALF_T + UI_OFFSET + 0.0008)
        outer = add_mesh_object(scene, shared_outer_mesh, "CursorRig.outer.{0}".format(face),
                                materials["cursor_outline"], parent=root)
        inner = add_mesh_object(scene, shared_inner_mesh, "CursorRig.inner.{0}".format(face),
                                materials["cursor_fill"], parent=root)
        inner.location = (0.004, face_sign * 0.00018, -0.004)
        for obj in (root, outer, inner):
            obj.hide_render = True
            obj.keyframe_insert(data_path="hide_render", frame=1)
        rigs[face] = {"root": root, "outer": outer, "inner": inner,
                      "sign": face_sign, "windows": []}

    def set_linear(obj):
        for curve in _iter_action_fcurves(obj.animation_data):
            for key in curve.keyframe_points:
                key.interpolation = "LINEAR"

    def point(info, event):
        nx, ny = float(event["nx"]), float(event["ny"])
        x = (nx - 0.5) * UI_W
        if info["face"] == "back": x *= -1.0
        return (x, (0.5 - ny) * UI_H)

    for info in FILM_CLIP_INFO:
        shot = info["shot"]
        if not info.get("timeline"):
            continue
        timeline = load_json(info["timeline"])
        events = timeline.get("cursor", [])
        if not isinstance(events, list):
            raise FilmError("shot {0} cursor timeline must contain an array".format(shot["id"]))
        timeline_count = timeline.get("frameCount")
        entry = catalog_index.get((shot["source"]["type"], shot["source"]["id"],
                                   shot["source"].get("framing")),
                                  catalog_index.get((shot["source"]["type"], shot["source"]["id"], None)))
        expected_count = entry.get("frameCount") if entry else None
        if (isinstance(timeline_count, bool) or not isinstance(timeline_count, int) or
                timeline_count < 1 or timeline_count > MAX_ASSET_FRAME or
                timeline_count != expected_count):
            raise FilmError("shot {0} cursor timeline has an invalid frameCount".format(shot["id"]))
        for event_index, event in enumerate(events):
            if (not isinstance(event, dict) or
                    isinstance(event.get("frame"), bool) or not isinstance(event.get("frame"), int) or
                    event["frame"] < 0 or event["frame"] >= timeline_count or
                    not isinstance(event.get("nx"), (int, float)) or isinstance(event.get("nx"), bool) or
                    not math.isfinite(event["nx"]) or not 0.0 <= event["nx"] <= 1.0 or
                    not isinstance(event.get("ny"), (int, float)) or isinstance(event.get("ny"), bool) or
                    not math.isfinite(event["ny"]) or not 0.0 <= event["ny"] <= 1.0 or
                    event.get("event") not in ("move", "down", "up", "click")):
                raise FilmError("shot {0} cursor[{1}] is malformed".format(
                    shot["id"], event_index))
        trim_zero = info["trim_start"] - 1
        events = [event for event in events
                  if trim_zero <= int(event["frame"]) <= info["trim_end"] - 1]
        if not events:
            # A valid capture may simply not use a pointer.  Do not invent one,
            # and do not turn an empty timeline into a build failure.
            skipped.append({"shot": shot["id"], "reason": "timeline has no cursor events"})
            continue

        rig = rigs[info["face"]]
        root, outer, inner = rig["root"], rig["outer"], rig["inner"]
        frame_events = []
        for event in events:
            # Timeline frames are zero-based; source PNG names are one-based.
            global_frame = info["shot_start"] + (int(event["frame"]) - trim_zero)
            if global_frame < info["shot_start"] or global_frame > info["shot_end"]:
                continue
            frame_events.append((global_frame, event))
        if not frame_events:
            continue
        # Partition consecutive move samples into path runs. A down event at
        # the first move sample is part of that same activity, not a separate
        # click registration. The windows are merged below before visibility
        # keys are written; otherwise the old click hide key could land in the
        # middle of a drag and briefly produce a second/vanishing cursor.
        runs = []
        pending = []
        for item in frame_events:
            frame, event = item
            if event.get("event") == "move" and (not pending or frame == pending[-1][0] + 1):
                pending.append(item)
            else:
                if pending: runs.append(("move", pending)); pending = []
                if event.get("event") != "move": runs.append(("cluster", [item]))
        if pending: runs.append(("move", pending))
        windows = []
        for kind, items in runs:
            if kind == "move" and len(items) >= 2:
                start, end = items[0][0], items[-1][0]
                windows.append((max(info["shot_start"], start - 1), min(info["shot_end"], end + 1), items))
            else:
                start = min(item[0] for item in items)
                end = max(item[0] for item in items)
                windows.append((max(info["shot_start"], start - 2), min(info["shot_end"], end + 4), items))
        merged_windows = []
        for start, end, items in sorted(windows, key=lambda value: value[0]):
            if merged_windows and start <= merged_windows[-1][1] + 1:
                old_start, old_end, old_items = merged_windows[-1]
                merged_windows[-1] = (old_start, max(old_end, end), old_items + items)
            else:
                merged_windows.append((start, end, list(items)))
        windows = merged_windows
        for start, end, items in windows:
            # Merging neighboring runs must not change event order.  In
            # particular, navigation clicks are followed by a hold, never a
            # snap back to an earlier cursor position.
            items = sorted(items, key=lambda item: item[0])
            rig["windows"].append((start, end, shot["number"]))
            # A shared rig is hidden outside each owning shot; this also makes
            # dissolve boundaries single-registration rather than duplicated.
            for frame in range(start, end + 1):
                # Holds use the latest event in this merged activity window;
                # never reset to the first event when a frame has no sample.
                source = event_for_frame(items, frame)
                x, z = point(info, source)
                root.location.x, root.location.z = x, z
                root.keyframe_insert(data_path="location", frame=frame)
            for item_frame, event in items:
                if event.get("event") == "click":
                    base_x = -1.0 if info["face"] == "back" else 1.0
                    root.scale = (base_x, 1.0, 1.0)
                    root.keyframe_insert(data_path="scale", frame=max(1, item_frame - 1))
                    root.scale = (base_x * 0.82, 0.82, 0.82)
                    root.keyframe_insert(data_path="scale", frame=item_frame)
                    root.scale = (base_x, 1.0, 1.0)
                    root.keyframe_insert(data_path="scale", frame=min(info["shot_end"], item_frame + 3))
        set_linear(root)
        # Visibility is keyed once below for the complete physical rig. Do not
        # seed a per-track hide key at shot_start-1: on adjacent shots that
        # key can land inside the previous track's final drag frame.
        set_linear(root)
        count += 1
        provenance.append({
            "shot": shot["id"],
            "number": shot["number"],
            "source": "{0}:{1}".format(shot["source"]["type"], shot["source"]["id"]),
            "timeline": os.path.relpath(info["timeline"], paths["repo"]),
            "sourceFrames": [info["trim_start"], info["trim_end"]],
            "globalFrames": [info["shot_start"], info["shot_end"]],
            "eventCount": len(events),
            "face": info["face"],
            "activityWindows": [[start, end] for start, end, _ in windows],
        })
    for face, rig in rigs.items():
        merged = []
        for start, end, number in sorted(rig["windows"], key=lambda value: value[0]):
            if merged and start <= merged[-1][1] + 1:
                merged[-1] = (merged[-1][0], max(merged[-1][1], end), number)
            else:
                merged.append((start, end, number))
        for cursor_object in (rig["root"], rig["outer"], rig["inner"]):
            cursor_object.hide_render = True
            for start, end, _ in merged:
                cursor_object.hide_render = False
                cursor_object.keyframe_insert(data_path="hide_render", frame=start)
                cursor_object.hide_render = True
                cursor_object.keyframe_insert(data_path="hide_render", frame=end + 1)
    manifest["cursor_tracks"] = count
    manifest["cursor_logical_tracks"] = count
    manifest["cursor_physical_rigs"] = len(rigs)
    manifest["cursor_physical_objects"] = len(rigs) * 3
    manifest["cursor_mesh_datablocks"] = 2
    manifest["cursor_track_provenance"] = provenance
    manifest["cursor_track_skips"] = skipped
    return count


# ---------------------------------------------------------------------------
# Camera
# ---------------------------------------------------------------------------
def build_camera(scene, total):
    cam_data = bpy.data.cameras.new("FilmCamera")
    cam_data.lens = FOCAL_MM
    cam_data.sensor_width = float(nested(
        ENVIRONMENT, ("camera", "sensorWidthMM"), 36.0))
    dof = cam_data.dof
    dof.use_dof = True
    dof.aperture_fstop = 4.0
    dof.focus_distance = CAM_Z
    cam = bpy.data.objects.new("FilmCamera", cam_data)
    scene.collection.objects.link(cam)
    # Explicit orientation avoids the ambiguous roll produced when a tracking
    # quaternion's up axis is parallel to the view direction. From -Y the
    # camera looks toward +Y, with world +Z as screen-up and +X as screen-right.
    cam.location = (0.0, -CAM_Z, 0.0)
    cam.rotation_euler = (math.radians(90.0), 0.0, 0.0)
    scene.camera = cam

    # Explicit neutral keys make a partial edit unable to leak a lens, aim, or
    # DOF state into the next recipe.  Focus moves add their own guard keys.
    cam.data.lens = FOCAL_MM
    cam.keyframe_insert(data_path="rotation_euler", frame=1)
    cam.keyframe_insert(data_path="rotation_euler", frame=total)
    cam.data.keyframe_insert(data_path="lens", frame=1)
    cam.data.keyframe_insert(data_path="lens", frame=total)
    dof.focus_distance = CAM_Z
    dof.keyframe_insert(data_path="focus_distance", frame=1)
    dof.keyframe_insert(data_path="focus_distance", frame=total)

    # Slow Z breathing only — the camera never wanders in X/Y.
    for frame in range(1, total + 1, 15):
        t = frame / FPS
        z = CAM_Z + BREATH_AMP * math.sin(2.0 * math.pi * t / BREATH_PERIOD_S)
        cam.location.y = -z
        cam.keyframe_insert(data_path="location", frame=frame)

    # Data-driven, bounded push-ins for the micro-interactions. The target is
    # moved in screen space while the camera stays on its stable axis; lens
    # changes are intentionally small enough to preserve the glass silhouette.
    moves = nested(ENVIRONMENT, ("camera", "focusMoves"), [])
    for move in moves:
        start = int(move["start"])
        end = int(move["end"])
        ease = max(1, int(move.get("easeFrames", 8)))
        mid = (start + end) // 2
        points = [start, min(mid, start + ease), max(mid, end - ease), end]
        target = move.get("targetOffsetM", [0.0, 0.0])
        lenses = [float(move.get("lensStartMM", FOCAL_MM)),
                  float(move.get("lensPeakMM", FOCAL_MM)),
                  float(move.get("lensPeakMM", FOCAL_MM)),
                  float(move.get("lensEndMM", FOCAL_MM))]
        offsets = [(0.0, 0.0), (float(target[0]), float(target[1])),
                   (float(target[0]), float(target[1])), (0.0, 0.0)]
        guard_frames = [max(1, start - 1), min(total, end + 1)]
        for frame in guard_frames:
            cam.location.y = -CAM_Z
            cam.rotation_euler = (math.radians(90.0), 0.0, 0.0)
            cam.data.lens = FOCAL_MM
            cam.data.dof.focus_distance = CAM_Z
            cam.keyframe_insert(data_path="rotation_euler", frame=frame)
            cam.data.keyframe_insert(data_path="lens", frame=frame)
            cam.data.dof.keyframe_insert(data_path="focus_distance", frame=frame)
        for frame, (x_offset, z_offset), lens in zip(points, offsets, lenses):
            cam.location.y = -CAM_Z
            direction = Vector((x_offset, 0.0, z_offset)) - cam.location
            cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
            cam.data.lens = lens
            cam.data.dof.focus_distance = math.sqrt(
                CAM_Z * CAM_Z + x_offset * x_offset + z_offset * z_offset)
            cam.keyframe_insert(data_path="rotation_euler", frame=frame)
            cam.data.keyframe_insert(data_path="lens", frame=frame)
            cam.data.dof.keyframe_insert(data_path="focus_distance", frame=frame)
    return cam


# ---------------------------------------------------------------------------
# Slab flip animation
# ---------------------------------------------------------------------------
def smootherstep(t):
    t = max(0.0, min(1.0, t))
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0)


def build_flips(slab, shotlist, total):
    """Continuous clockwise 180-degree flips only at major-area boundaries."""
    flips = shotlist.get("direction", {}).get("flips", [])
    tilt = math.radians(float(nested(
        ENVIRONMENT, ("glass", "tiltDegrees"), 3.0)))
    slab.rotation_euler = (tilt, 0.0, 0.0)
    slab.keyframe_insert(data_path="rotation_euler", frame=1)

    for index, flip in enumerate(flips):
        a = int(flip["start"])
        b = int(flip["end"])
        start_angle = index * math.pi
        end_angle = (index + 1) * math.pi
        slab.rotation_euler.z = start_angle
        slab.keyframe_insert(data_path="rotation_euler", frame=max(1, a))
        step = 2
        for frame in range(a + step, b, step):
            t = (frame - a) / float(b - a)
            angle = start_angle + smootherstep(t) * (end_angle - start_angle)
            slab.rotation_euler.z = angle
            slab.keyframe_insert(data_path="rotation_euler", frame=frame)
        slab.rotation_euler.z = end_angle
        slab.keyframe_insert(data_path="rotation_euler", frame=min(total, b))

    slab.rotation_euler.z = len(flips) * math.pi
    slab.keyframe_insert(data_path="rotation_euler", frame=total)


def set_scene_animation_easing(scene, shotlist):
    """Normalize every object/data/material animation after all keys exist.

    The global pass is intentionally followed by the small set of animation
    contracts that are part of the film format.  Keeping those repairs here,
    after the global pass, prevents a later normalization from silently
    changing a dissolve or cursor path.
    """
    datablocks = list(scene.objects)
    datablocks += [obj.data for obj in scene.objects if getattr(obj, "data", None)]
    datablocks += list(bpy.data.materials)
    for datablock in datablocks:
        _set_deterministic_easing(getattr(datablock, "animation_data", None))
        node_tree = getattr(datablock, "node_tree", None)
        _set_deterministic_easing(getattr(node_tree, "animation_data", None))

    # Specialized interpolation is a post-normalization contract.  Do not
    # replace this with another broad easing pass: click pulses and editorial
    # fades must remain BEZIER while only captured movement and dissolves are
    # linear.
    for obj in scene.objects:
        if obj.name.startswith("CursorRig."):
            curves = list(_iter_action_fcurves(obj.animation_data))
            # Blender 5.2 can expose a newly-created vector channel through
            # the channel bag but not through the owner's convenience view;
            # include the action's bags explicitly so scale Y cannot retain
            # the pre-contract move easing.
            action = getattr(getattr(obj, "animation_data", None), "action", None)
            for layer in list(getattr(action, "layers", []) or []):
                for strip in list(getattr(layer, "strips", []) or []):
                    for bag in list(getattr(strip, "channelbags", []) or []):
                        curves.extend(list(getattr(bag, "fcurves", []) or []))
            for fcurve in {id(curve): curve for curve in curves}.values():
                if fcurve.data_path == "location":
                    for key in fcurve.keyframe_points:
                        key.interpolation = "LINEAR"
                elif fcurve.data_path == "scale":
                    for key in fcurve.keyframe_points:
                        key.interpolation = "BEZIER"
                elif fcurve.data_path == "hide_render":
                    for key in fcurve.keyframe_points:
                        key.interpolation = "CONSTANT"

    dissolve_materials = set()
    shots = shotlist.get("shots", [])
    for index, shot in enumerate(shots):
        incoming = shot.get("transitionIn", {}).get("type") == "same-face-dissolve"
        following = shots[index + 1] if index + 1 < len(shots) else None
        outgoing = bool(following and following.get("transitionIn", {}).get(
            "type") == "same-face-dissolve")
        if incoming or outgoing:
            dissolve_materials.add("UI.mat.S{0:02d}".format(shot["number"]))

    for material in bpy.data.materials:
        if material.name not in dissolve_materials:
            continue
        for fcurve in _iter_action_fcurves(
                getattr(material.node_tree, "animation_data", None)):
            if 'nodes["Opacity"]' in fcurve.data_path:
                for key in fcurve.keyframe_points:
                    key.interpolation = "LINEAR"

    # hide_render is a visibility state, never a smoothly interpolated value.
    # This final pass deliberately runs last and covers UI planes, cursor
    # rigs, and any future generated object/data animation.
    all_datablocks = list(scene.objects)
    all_datablocks += [obj.data for obj in scene.objects if getattr(obj, "data", None)]
    all_datablocks += list(bpy.data.materials)
    for datablock in all_datablocks:
        curves = list(_iter_action_fcurves(getattr(datablock, "animation_data", None)))
        action = getattr(getattr(datablock, "animation_data", None), "action", None)
        for layer in list(getattr(action, "layers", []) or []):
            for strip in list(getattr(layer, "strips", []) or []):
                for bag in list(getattr(strip, "channelbags", []) or []):
                    curves.extend(list(getattr(bag, "fcurves", []) or []))
        for fcurve in {id(curve): curve for curve in curves}.values():
            if fcurve.data_path == "hide_render":
                for key in fcurve.keyframe_points:
                    key.interpolation = "CONSTANT"


# ---------------------------------------------------------------------------
# Sound
# ---------------------------------------------------------------------------
FILM_CLIP_INFO = []  # populated by build_ui_planes for per-frame UI updates


def prepare_ui_frame(sc, frame):
    """Point the active shot's UI texture at the correct capture frame.

    Clip frames are loaded as plain images (no sequences: those lose their
    buffer in background Eevee). Before each render, the plane for the shot
    covering ``frame`` is pointed at its exact source frame via filepath +
    reload, which always decodes in background mode.
    """
    for info in FILM_CLIP_INFO:
        if not (info["render_start"] <= frame <= info["render_end"]):
            continue
        offset = max(0, min(frame - info["shot_start"],
                            info["trim_end"] - info["trim_start"]))
        cf = info["trim_start"] + offset
        path = safe_clip_frame(info["directory"], cf,
                               "clip frame {0}".format(frame_name(cf)))
        tex = next(n for n in
                   info["plane"].data.materials[0].node_tree.nodes
                   if n.type == "TEX_IMAGE")
        if tex.image.filepath == path:
            continue
        try:
            tex.image.filepath = path
            tex.image.reload()
            tex.image["anything_llm_capture_source"] = os.path.realpath(path)
            tex.image["anything_llm_capture_sha256"] = sha256_file(path)
        except Exception as exc:
            raise FilmError("cannot load clip frame {0}: {1}".format(path, exc))


def build_sound(scene, paths, manifest):
    """Attach the generated mix WAV if present; otherwise note + continue."""
    total = scene.frame_end
    wav = paths["audio"]
    if not os.path.isfile(wav):
        manifest["sound"] = "SKIPPED (missing: {0})".format(wav)
        return None
    scene.sequence_editor_create()
    editor = scene.sequence_editor
    try:
        s = editor.strips.new_sound("Audio.skybao-mix", wav, 120, 1, stream=0)
        # Keep a small, non-name-based identity on the datablock.  Blender
        # derives the sound name from the filepath, so a replacement datablock
        # can otherwise look canonical after its bytes and path are copied.
        s.sound["anything_llm_audio_identity"] = "builder:skybao-mix"
        s.frame_start = 1
        s.frame_final_end = total + 1
        manifest["sound"] = os.path.basename(wav)
        return s
    except Exception as exc:
        raise FilmError("cannot add sound strip {0}: {1}".format(wav, exc))


def _delivery_relative_path(absolute_path, paths):
    """Return a Blender path relative to the promoted blend directory."""
    relative = os.path.relpath(
        os.path.abspath(absolute_path), paths["film"])
    return "//" + relative.replace(os.sep, "/")


def relink_assets_for_delivery(strip, paths):
    """Make staged blend dependencies portable after atomic promotion.

    Blender normally remaps file paths relative to the temporary staging blend
    on save. The blend is later moved to ``artifacts/skybao-film``, so those
    paths become one directory too deep. Resolve the loaded sources while they
    are still absolute, then write paths relative to the promoted directory.
    """
    for image in bpy.data.images:
        if image.source != "FILE" or not image.filepath:
            continue
        absolute = bpy.path.abspath(image.filepath)
        if not os.path.isabs(absolute):
            absolute = os.path.abspath(absolute)
        image.filepath = _delivery_relative_path(absolute, paths)
    if strip is not None and getattr(strip, "sound", None):
        strip.sound.filepath = _delivery_relative_path(
            paths["audio_canonical"], paths)


def validate_delivery_dependencies(strip, paths):
    """Validate relative paths against the blend's promoted destination."""
    missing = []
    image_count = 0
    for image in bpy.data.images:
        if image.source != "FILE" or not image.filepath:
            continue
        image_count += 1
        if not image.filepath.startswith("//"):
            missing.append("{0}: non-relative {1}".format(
                image.name, image.filepath))
            continue
        resolved = os.path.realpath(os.path.normpath(os.path.join(
            paths["film"], image.filepath[2:])))
        allowed = [os.path.realpath(paths["film"]), os.path.realpath(paths["ui"]),
                   os.path.realpath(paths["repo"])]
        try:
            inside = any(os.path.commonpath((root, resolved)) == root for root in allowed)
        except ValueError:
            inside = False
        if not inside or not os.path.isfile(resolved):
            missing.append("{0}: missing {1}".format(image.name, resolved))
    sound_count = 0
    if strip is not None and getattr(strip, "sound", None):
        sound_count = 1
        expected = _delivery_relative_path(paths["audio_canonical"], paths)
        if strip.sound.filepath != expected:
            missing.append("sound: expected {0}, got {1}".format(
                expected, strip.sound.filepath))
        if not os.path.isfile(paths["audio"]):
            missing.append("sound source: missing {0}".format(paths["audio"]))
    if missing:
        raise FilmError("non-portable delivery dependencies:\n  - {0}".format(
            "\n  - ".join(missing)))
    return {"images": image_count, "sounds": sound_count, "missing": 0}


# ---------------------------------------------------------------------------
# Manifest / save / render
# ---------------------------------------------------------------------------
def write_manifest(cfg, paths, manifest):
    print("=" * 64)
    print("SkyBao film · Blender 3D build manifest")
    print("  format  : {0}x{1} @ {2}fps, frames 1..{3}".format(
        cfg["width"], cfg["height"], cfg["fps"], cfg["total"]))
    print("  engine  : Cycles ({0}, {1} samples, adaptive {2})".format(
        RENDER_RUNTIME.get("deviceResolved", "cpu"),
        RENDER_RUNTIME.get("samples", "?"),
        RENDER_RUNTIME.get("adaptiveThreshold", "?")))
    print("  slab    : {0}m x {1}m x {2}m glass, bevelled".format(
        SLAB_W, SLAB_H, SLAB_T))
    print("  shots   : {0}".format(len(manifest["shots"])))
    for shot in manifest["shots"]:
        print("    S{0:02d} {1:<6} {2:<30} frames {3}-{4}  {5}".format(
            shot["number"], shot["face"], shot["id"],
            shot["frames"][0], shot["frames"][1], shot["source"]))
    print("  ui planes: {0}".format(manifest.get("ui_planes", 0)))
    print("  cursor tracks: {0}".format(manifest.get("cursor_tracks", 0)))
    print("  area flips: {0}".format(manifest.get("area_flips", 0)))
    print("  sound   : {0}".format(manifest.get("sound", "none")))
    print("  out     : {0}".format(paths["blendout"]))


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_build_manifest(sc, cfg, paths, catalog, manifest):
    """Record exact inputs/settings so a UI change has an auditable rebuild."""
    input_assets = {}
    for input_id, relative_path in ENVIRONMENT.get("toolInputs", {}).items():
        absolute_path = safe_repo_path(
            paths["repo"], relative_path,
            "environment tool input {0}".format(input_id))
        if not os.path.isfile(absolute_path):
            raise FilmError("missing declared environment tool input {0}: {1}".format(
                input_id, relative_path))
        input_assets[input_id] = {
            "path": relative_path,
            "sha256": sha256_file(absolute_path),
        }
    # Keep the descriptive builder name stable even for older recipes that
    # called this consumer input simply "consumer".
    if "consumer" in input_assets:
        input_assets["builder"] = dict(input_assets["consumer"])
    scene_contract = os.path.join(paths["film_dir"], "scene-contract.py")
    if os.path.isfile(scene_contract):
        input_assets["sceneContract"] = {
            "path": os.path.relpath(scene_contract, paths["repo"]),
            "sha256": sha256_file(scene_contract),
        }
    for card in ENVIRONMENT.get("cloudCards", []):
        if isinstance(card, dict) and card.get("source"):
            card_path = safe_repo_path(paths["repo"], card["source"], "cloud card source")
            input_assets["cloudCard-{0}".format(card.get("id"))] = {
                "path": card["source"], "sha256": sha256_file(card_path),
            }
    catalog_assets = catalog.get("assets", [])
    used_ui_assets = {}
    for shot in load_json(paths["shotlist"]).get("shots", []):
        source = shot.get("source", {})
        key = "{0}:{1}:{2}".format(
            source.get("type"), source.get("id"), source.get("framing"))
        if key in used_ui_assets:
            continue
        entry = next((item for item in catalog_assets
                      if item.get("type") == source.get("type")
                      and item.get("id") == source.get("id")
                      and item.get("framing") == source.get("framing")), None)
        if not entry:
            raise FilmError("cannot lock missing UI asset {0}".format(key))
        recipe_sha = entry.get("recipeSha256")
        content_sha = entry.get("contentSha256")
        if not recipe_sha or not content_sha:
            raise FilmError("cannot lock legacy UI asset {0}".format(key))
        used_ui_assets[key] = {
            "type": source.get("type"),
            "id": source.get("id"),
            "framing": source.get("framing"),
            "ownerId": entry.get("ownerId"),
            "recipeVersion": entry.get("recipeVersion"),
            "recipeSha256": recipe_sha,
            "contentSha256": content_sha,
            "trimRanges": [],
        }
        if source.get("type") == "clip":
            timeline_path = safe_catalog_path(paths["ui"], entry.get("timeline"), "UI timeline")
            used_ui_assets[key]["timeline"] = entry.get("timeline")
            used_ui_assets[key]["timelineSha256"] = sha256_file(timeline_path)

    for shot in load_json(paths["shotlist"]).get("shots", []):
        source = shot.get("source", {})
        key = "{0}:{1}:{2}".format(source.get("type"), source.get("id"), source.get("framing"))
        if source.get("type") == "clip" and key in used_ui_assets:
            used_ui_assets[key]["trimRanges"].append([source.get("startFrame"), source.get("endFrame")])
    payload = {
        "schemaVersion": 2,
        "shotlist": {
            "path": os.path.relpath(paths["shotlist"], paths["repo"]),
            "sha256": sha256_file(paths["shotlist"]),
        },
        "environment": {
            "path": os.path.relpath(paths["environment"], paths["repo"]),
            "sha256": sha256_file(paths["environment"]),
            "id": ENVIRONMENT.get("id"),
            "seed": ENVIRONMENT.get("seed"),
        },
        "uiCatalog": {
            "path": os.path.relpath(paths["catalog"], paths["repo"]),
            "sha256": sha256_file(paths["catalog"]),
            "aggregateSha256": catalog.get("aggregateSha256"),
        },
        "audio": ({
            "path": os.path.relpath(paths["audio_canonical"], paths["repo"]),
            "sha256": sha256_file(paths["audio"]),
        } if os.path.isfile(paths["audio"]) else None),
        "inputAssets": input_assets,
        "usedUiAssets": [used_ui_assets[key]
                         for key in sorted(used_ui_assets)],
        "blender": {
            "version": bpy.app.version_string,
            "engine": sc.render.engine,
            "objects": len(sc.collection.objects),
        },
        "render": {
            "engine": sc.render.engine,
            "deviceRequested": RENDER_RUNTIME.get("deviceRequested"),
            "deviceResolved": RENDER_RUNTIME.get("deviceResolved"),
            "deviceFallback": RENDER_RUNTIME.get("deviceFallback"),
            "metalRT": RENDER_RUNTIME.get("metalRT"),
            "computeDeviceType": RENDER_RUNTIME.get("computeDeviceType"),
            "activeDeviceIds": RENDER_RUNTIME.get("activeDeviceIds", []),
            "profile": RENDER_RUNTIME.get("profile"),
            "samples": RENDER_RUNTIME.get("samples"),
            "adaptiveThreshold": RENDER_RUNTIME.get("adaptiveThreshold"),
            "resolutionPercentage": RENDER_RUNTIME.get(
                "resolutionPercentage"),
            "seed": RENDER_RUNTIME.get("seed"),
            "animatedSeed": RENDER_RUNTIME.get("animatedSeed"),
            "persistentData": RENDER_RUNTIME.get("persistentData"),
            "denoise": RENDER_RUNTIME.get("denoise"),
            "bounces": RENDER_RUNTIME.get("bounces"),
            "devices": RENDER_RUNTIME.get("devices", []),
            "elapsedRenderSeconds": RENDER_RUNTIME.get(
                "elapsedRenderSeconds", 0.0),
        },
        "format": {
            "width": cfg["width"], "height": cfg["height"],
            "fps": cfg["fps"], "frames": cfg["total"],
        },
        "scene": manifest,
    }
    os.makedirs(os.path.dirname(paths["build_manifest"]), exist_ok=True)
    with open(paths["build_manifest"], "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
    return paths["build_manifest"]


def save_blend(sc, paths):
    out = paths["blendout"]
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with WindowContext(sc):
        bpy.ops.wm.save_as_mainfile(filepath=out, relative_remap=False)
    return out


def _prepare_render(scene, quality, out_dir):
    scene_render = scene.render
    profile = "final" if quality == "final" else "preview"
    apply_cycles_profile(scene, profile)
    scene_render.image_settings.file_format = "PNG"
    scene_render.image_settings.color_mode = "RGBA"
    scene_render.image_settings.compression = 15


def render_frames(sc, cfg, quality, paths):
    """Render every film frame into frames/<quality>/ (delivery pipeline)."""
    out_dir = paths.get("frames_out") or os.path.join(
        paths["film"], "frames", quality)
    os.makedirs(out_dir, exist_ok=True)
    _prepare_render(sc, quality, out_dir)
    scene_render = sc.render
    print("  rendering {0} frames into {1} ...".format(cfg["total"], out_dir))
    for frame in range(cfg["start_frame"], cfg["total"] + 1):
        sc.frame_set(frame)
        prepare_ui_frame(sc, frame)
        scene_render.filepath = os.path.join(
            out_dir, "frame-{0:06d}.png".format(frame))
        with WindowContext(sc):
            bpy.ops.render.render(write_still=True, scene=sc.name)
        if frame % 240 == 0:
            print("    ... frame {0}".format(frame))
    return out_dir


def render_samples(sc, cfg, frames, paths):
    """Render selected half-resolution review frames without a full export."""
    out_dir = paths.get("frames_out") or os.path.join(paths["film"], "review")
    os.makedirs(out_dir, exist_ok=True)
    _prepare_render(sc, "sample", out_dir)
    scene_render = sc.render
    for frame in frames:
        if frame < 1 or frame > cfg["total"]:
            raise FilmError("sample frame {0} outside 1..{1}".format(
                frame, cfg["total"]))
        sc.frame_set(frame)
        prepare_ui_frame(sc, frame)
        scene_render.filepath = os.path.join(
            out_dir, "frame-{0:04d}.png".format(frame))
        with WindowContext(sc):
            bpy.ops.render.render(write_still=True, scene=sc.name)
        print("  review frame: {0}".format(scene_render.filepath))
    return out_dir


def sample_frames_for_shots(shotlist, requested):
    """Resolve shot IDs/numbers to compact start/mid/end visual reviews."""
    wanted = set(requested or [])
    frames = set()
    found = set()
    for shot in shotlist.get("shots", []):
        keys = {str(shot.get("number")), str(shot.get("id", ""))}
        if not wanted.intersection(keys):
            continue
        found.update(wanted.intersection(keys))
        start = int(shot["frames"]["start"])
        end = int(shot["frames"]["end"])
        frames.update((start, (start + end) // 2, end))
        transition = shot.get("transitionOut", {})
        if transition.get("type") == "area-flip":
            frames.update((int(transition["start"]),
                           int(transition["edgeOn"]),
                           int(transition["end"])))
    missing = wanted - found
    if missing:
        raise FilmError("unknown --shots values: {0}".format(
            ", ".join(sorted(missing))))
    return sorted(frames)


def _finite_number(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool) and
            math.isfinite(value))


def _integer(value):
    return isinstance(value, int) and not isinstance(value, bool)


def validate_editorial_and_focus(shotlist, environment):
    """Validate the two data-driven Blender consumers without touching bpy."""
    shots = shotlist.get("shots")
    by_id = {shot.get("id"): shot for shot in shots if isinstance(shot, dict)}
    flips = shotlist.get("direction", {}).get("flips", [])
    total = shotlist.get("format", {}).get("frames")

    callouts = shotlist.get("editorialCallouts")
    if not isinstance(callouts, list) or len(callouts) != 5:
        raise FilmError("editorialCallouts must be an array of exactly five objects")
    callout_ids = set()
    expected_text = {
        "assistant": "Grounded Answers with Citations",
        "knowledge": "Unified Knowledge Search",
        "communications": "Connected Team Context",
        "work": "Automated Agent Workflows",
        "admin": "Enterprise Governance",
    }
    if shotlist.get("groupOrder") != list(expected_text):
        raise FilmError("shotlist.groupOrder must contain each expected editorial area exactly once")
    glass = environment.get("glass") if isinstance(environment, dict) else None
    if not isinstance(glass, dict):
        raise FilmError("environment.glass must be an object for editorial validation")
    width = glass.get("widthM")
    height = glass.get("heightM")
    inset = glass.get("uiInsetM")
    if not all(_finite_number(value) for value in (width, height, inset)):
        raise FilmError("editorial validation requires finite glass dimensions and uiInsetM")
    editorial = environment.get("editorial") if isinstance(environment, dict) else None
    color = editorial.get("textColor") if isinstance(editorial, dict) else None
    color_ok = ((isinstance(color, str) and len(color) == 7 and color[0] == "#" and
                 all(char in "0123456789abcdefABCDEF" for char in color[1:])) or
                (isinstance(color, list) and len(color) == 3 and
                 all(_finite_number(component) and 0 <= component <= 1 for component in color)))
    if not color_ok:
        raise FilmError("environment.editorial.textColor must be #RRGGBB or RGB values in 0..1")
    if (not isinstance(editorial, dict) or not _finite_number(editorial.get("emissionStrength")) or
            not 0 <= editorial["emissionStrength"] <= 100):
        raise FilmError("environment.editorial.emissionStrength must be finite and 0..100")
    callout_transitions = []
    for item in shots:
        transition = item.get("transitionIn") if isinstance(item, dict) else None
        frames = item.get("frames") if isinstance(item, dict) else None
        if (isinstance(transition, dict) and transition.get("type") == "same-face-dissolve" and
                isinstance(frames, dict) and _integer(transition.get("frames"))):
            callout_transitions.append((frames.get("start"), frames.get("start", 0) + transition["frames"] - 1))
    group_counts = {group: 0 for group in expected_text}
    safe_x = max(0.0, width / 2.0 - inset - 0.14)
    safe_z = max(0.0, height / 2.0 - inset - 0.14)
    for index, callout in enumerate(callouts):
        label = "editorialCallouts[{0}]".format(index)
        if not isinstance(callout, dict):
            raise FilmError("{0} must be an object".format(label))
        ident = callout.get("id")
        if not isinstance(ident, str) or not ident.strip() or ident in callout_ids:
            raise FilmError("{0}.id must be a unique nonempty string".format(label))
        callout_ids.add(ident)
        group = callout.get("group")
        text = callout.get("text")
        if group not in expected_text or text != expected_text[group]:
            raise FilmError("{0} has invalid group or approved text".format(label))
        group_counts[group] += 1
        if not isinstance(text, str) or not 2 <= len(text.split()) <= 4:
            raise FilmError("{0}.text must contain 2–4 words".format(label))
        shot = by_id.get(callout.get("shotId"))
        if not isinstance(shot, dict):
            raise FilmError("{0}.shotId must reference an existing shot".format(label))
        if callout.get("face") != shot.get("face"):
            raise FilmError("{0}.face must match its shot".format(label))
        frames = callout.get("frames")
        position = callout.get("positionM")
        if (not isinstance(frames, dict) or not _integer(frames.get("start")) or
                not _integer(frames.get("end")) or frames["start"] > frames["end"] or
                frames["start"] < 1 or frames["end"] > total or
                not isinstance(position, list) or len(position) != 2 or
                not all(_finite_number(value) for value in position) or
                not _finite_number(callout.get("fontSizeM")) or
                not 0.06 <= callout["fontSizeM"] <= 0.18 or
                not _integer(callout.get("fadeFrames")) or
                not 4 <= callout["fadeFrames"] <= 12):
            raise FilmError("{0} has malformed position, font, timing, or fade".format(label))
        shot_frames = shot.get("frames")
        if (not isinstance(shot_frames, dict) or frames["start"] < shot_frames.get("start", 0) or
                frames["end"] > shot_frames.get("end", 0) or
                frames["start"] - callout["fadeFrames"] < 1 or
                frames["end"] + callout["fadeFrames"] > total):
            raise FilmError("{0} frame window is outside its shot or film".format(label))
        estimated_width = len(text) * callout["fontSizeM"] * 0.62 * 1.05 * 1.12
        estimated_height = callout["fontSizeM"] * 1.35
        x, z = position
        if (x < -safe_x or x + estimated_width > safe_x or
                z - estimated_height / 2.0 < -safe_z or z + estimated_height / 2.0 > safe_z):
            raise FilmError("{0} text bounds exceed the panel safe area".format(label))
        padded = (frames["start"] - callout["fadeFrames"],
                  frames["end"] + callout["fadeFrames"])
        if any(padded[0] <= flip.get("end", 0) and padded[1] >= flip.get("start", 0)
               for flip in flips if isinstance(flip, dict)):
            raise FilmError("{0} overlaps a face flip".format(label))
        if any(padded[0] <= end and padded[1] >= start for start, end in callout_transitions):
            raise FilmError("{0} overlaps a same-face dissolve".format(label))
    if any(count != 1 for count in group_counts.values()):
        raise FilmError("editorialCallouts must contain exactly one callout per expected group")

    camera = environment.get("camera")
    moves = camera.get("focusMoves") if isinstance(camera, dict) else None
    if not isinstance(camera, dict) or not isinstance(moves, list) or len(moves) < 2:
        raise FilmError("camera.focusMoves must contain at least two objects")
    baseline = camera.get("lensMM")
    sensor = camera.get("sensorWidthMM")
    distance = camera.get("distanceM")
    panel_width = width
    panel_height = height
    if not all(_finite_number(value) for value in (baseline, sensor, distance)):
        raise FilmError("camera baseline, sensor, and distance must be finite")
    previous_start = 0
    windows = []
    ids = set()
    transitions = []
    for shot in shots:
        transition = shot.get("transitionIn") if isinstance(shot, dict) else None
        shot_frames = shot.get("frames") if isinstance(shot, dict) else None
        if (isinstance(transition, dict) and transition.get("type") == "same-face-dissolve" and
                isinstance(shot_frames, dict)):
            if not _integer(transition.get("frames")):
                raise FilmError("shot transition dissolve frames must be an integer")
            transitions.append((shot_frames.get("start"),
                                shot_frames.get("start", 0) + transition.get("frames", 0) - 1))
    for index, move in enumerate(moves):
        label = "camera.focusMoves[{0}]".format(index)
        if not isinstance(move, dict):
            raise FilmError("{0} must be an object".format(label))
        ident = move.get("id")
        if not isinstance(ident, str) or not ident.strip() or ident in ids:
            raise FilmError("{0}.id must be a unique nonempty string".format(label))
        ids.add(ident)
        shot = by_id.get(move.get("shotId"))
        start, end, ease = move.get("start"), move.get("end"), move.get("easeFrames")
        if not isinstance(shot, dict) or not _integer(start) or not _integer(end) or not _integer(ease):
            raise FilmError("{0} has malformed shot or frame window".format(label))
        if (start < shot.get("frames", {}).get("start", 0) or
                end > shot.get("frames", {}).get("end", 0) or start < 1 or end > total or
                end <= start or ease < 4 or ease > 12 or ease * 2 > end - start or
                start < previous_start):
            raise FilmError("{0} has unordered or bounded frames/ease".format(label))
        previous_start = start
        target = move.get("targetOffsetM")
        if not isinstance(target, list) or len(target) != 2 or not all(_finite_number(v) for v in target):
            raise FilmError("{0}.targetOffsetM must contain finite x/z offsets".format(label))
        lenses = [move.get("lensStartMM"), move.get("lensPeakMM"), move.get("lensEndMM")]
        if (not all(_finite_number(v) and 48 <= v <= 58 for v in lenses) or
                move["lensPeakMM"] < max(move["lensStartMM"], move["lensEndMM"]) or
                move["lensStartMM"] != baseline or move["lensEndMM"] != baseline):
            raise FilmError("{0} has invalid lens baseline or peak".format(label))
        window = (start, end)
        if any(window[0] <= other[1] and window[1] >= other[0]
               for other in windows + [(f.get("start"), f.get("end")) for f in flips if isinstance(f, dict)] + transitions):
            raise FilmError("{0} overlaps a flip, transition, or another move".format(label))
        max_lens = max(lenses)
        view_w = distance * math.tan(2.0 * math.atan(sensor / (2.0 * max_lens)) / 2.0)
        view_h = view_w / (16.0 / 9.0)
        if (panel_width / 2.0 + 0.06 + abs(target[0]) > view_w or
                panel_height / 2.0 + 0.06 + abs(target[1]) > view_h):
            raise FilmError("{0} lens/offset leaves the panel frustum".format(label))
        windows.append(window)


def validate_film_contract(shotlist):
    """Validate hostile direct-builder input before any data-driven loops."""
    fmt = shotlist.get("format")
    if (not isinstance(fmt, dict) or fmt.get("fps") != FPS or
            fmt.get("frames") != FILM_TOTAL or fmt.get("durationSeconds") != 40 or
            fmt.get("width") != 1920 or fmt.get("height") != 1080):
        raise FilmError("film format must be exactly 1200 frames at 30fps")
    total = fmt["frames"]
    targeted = shotlist.get("targetedReviewFrames")
    if (not isinstance(targeted, list) or not targeted or
            len(set(targeted)) != len(targeted) or
            any(not _integer(frame) or frame < 1 or frame > total for frame in targeted)):
        raise FilmError("shotlist.targetedReviewFrames must be unique bounded integer frames")
    shots = shotlist.get("shots")
    if not isinstance(shots, list) or len(shots) != FILM_SHOT_COUNT or len(shots) > MAX_SHOTS:
        raise FilmError("film must contain exactly 19 shots")
    if not isinstance(shotlist.get("shotCount"), int) or shotlist["shotCount"] != FILM_SHOT_COUNT:
        raise FilmError("shotlist.shotCount must be exactly 19")
    expected_start = 1
    for index, shot in enumerate(shots):
        if not isinstance(shot, dict):
            raise FilmError("shot {0} must be an object".format(index + 1))
        frames = shot.get("frames") if isinstance(shot, dict) else None
        if not isinstance(frames, dict):
            raise FilmError("shot {0} frames must be an object".format(index + 1))
        bounded_frame_range(frames.get("start"), frames.get("end"),
                            "shot {0} frame range".format(index + 1), total)
        if shot.get("number") != index + 1 or frames.get("start") != expected_start:
            raise FilmError("shots must be numbered and contiguous from frame 1")
        if frames.get("count") != frames["end"] - frames["start"] + 1:
            raise FilmError("shot {0} frame count does not match its range".format(index + 1))
        source = shot.get("source")
        if not isinstance(source, dict):
            raise FilmError("shot {0} source must be an object".format(index + 1))
        source_type = source.get("type")
        source_id = source.get("id")
        if source_type not in ("clip", "still"):
            raise FilmError("shot {0} source.type must be clip or still".format(index + 1))
        if not isinstance(source_id, str) or not source_id.strip():
            raise FilmError("shot {0} source.id must be a nonempty string".format(index + 1))
        if source_type == "clip":
            if ("startFrame" not in source or "endFrame" not in source):
                raise FilmError("shot {0} source trim must include startFrame and endFrame".format(index + 1))
            bounded_frame_range(source.get("startFrame"), source.get("endFrame"),
                                "shot {0} source frame range".format(index + 1))
            trim_length = source["endFrame"] - source["startFrame"] + 1
            if trim_length != frames["count"]:
                raise FilmError("shot {0}: source trim length {1} != shot duration {2}".format(
                    index + 1, trim_length, frames["count"]))
        expected_start = frames["end"] + 1
    if expected_start != total + 1:
        raise FilmError("shotlist must cover frames 1..1200")
    flips = shotlist.get("direction", {}).get("flips") if isinstance(
        shotlist.get("direction"), dict) else None
    expected = EXPECTED_FLIPS
    if (shotlist.get("direction", {}).get("rotationDirection") !=
            "continuous clockwise"):
        raise FilmError("direction.rotationDirection must be continuous clockwise")
    if (shotlist.get("direction", {}).get("rotationFrames") != ROT_FRAMES or
            not isinstance(flips, list) or len(flips) != len(expected)):
        raise FilmError("film must contain exactly four flips")
    if shotlist.get("direction", {}).get("sameFaceDissolveFrames") != DISSOLVE_FRAMES:
        raise FilmError("same-face dissolves must be six frames")
    if shotlist.get("direction", {}).get("sameFaceDissolveWindow") != (
            "incoming and outgoing opacity keys share S..S+5; complementary linear easing"):
        raise FilmError("same-face dissolve window must be documented as S..S+5 linear")
    for index, flip in enumerate(flips):
        if not isinstance(flip, dict):
            raise FilmError("flip {0} must be an object".format(index + 1))
        start, end, edge = (flip.get("start"), flip.get("end"), flip.get("edgeOn"))
        if any(isinstance(value, bool) or not isinstance(value, int)
               for value in (start, end, edge)):
            raise FilmError("flip {0} range must use integer frames".format(index + 1))
        if ((flip.get("from"), flip.get("to"), start, end, edge) != expected[index] or
                not (start < edge < end)):
            raise FilmError("flip {0} must be {1}..{2} with edgeOn {3}".format(
                index + 1, expected[index][2], expected[index][3], expected[index][4]))


def validate_data_paths(environment, paths):
    """Resolve every environment-controlled path immediately before consumers."""
    inputs = environment.get("toolInputs", {})
    if not isinstance(inputs, dict):
        raise FilmError("environment.toolInputs must be an object")
    for name, value in inputs.items():
        safe_repo_path(paths["repo"], value, "environment tool input {0}".format(name))
    cards = environment.get("cloudCards", [])
    if not isinstance(cards, list):
        raise FilmError("environment.cloudCards must be an array")
    for index, card in enumerate(cards):
        if not isinstance(card, dict):
            raise FilmError("environment cloudCards[{0}] must be an object".format(index))
        if "source" in card:
            safe_repo_path(paths["repo"], card["source"],
                           "environment cloudCards[{0}].source".format(index))


# ---------------------------------------------------------------------------
# Main build
# ---------------------------------------------------------------------------
def build(args):
    paths = resolve_paths(args)
    shotlist = load_json(paths["shotlist"])
    environment = load_json(paths["environment"])
    catalog = load_json(paths["catalog"])
    validate_film_contract(shotlist)
    validate_editorial_and_focus(shotlist, environment)
    validate_data_paths(environment, paths)
    apply_environment_config(environment, shotlist)
    FILM_CLIP_INFO.clear()
    random.seed(int(environment.get("seed", 0)))
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

    catalog_index = build_catalog_index(catalog, paths["ui"])
    profile = (args.get("profile") or
               ("final" if args.get("quality") == "final" else "preview"))
    sc = ensure_scene("skybao-film", cfg, args.get("device", "auto"), profile)

    # --- materials ---
    materials = {
        "glass": glass_material("Mat.glass"),
        "edge_cyan": edge_accent_material(
            "Mat.edge.cyan", rgb(
                nested(environment, ("edge", "palette"), ["#38BDF8"])[0],
                (0.22, 0.72, 1.0)),
            float(nested(environment, ("edge", "baseEmission"), 0.12))),
        "edge_glint": edge_accent_material(
            "Mat.edge.glint", rgb(
                nested(environment, ("edge", "palette"),
                       ["#38BDF8", "#2563EB"])[-1],
                (0.12, 0.55, 1.0)),
            float(nested(environment, ("edge", "highlightEmission"), 0.45))),
        "cover": clear_cover_material("Mat.glass.cover"),
        "metal": brushed_metal_material("Mat.metal"),
        "led_cyan": led_material("Mat.led.cyan", (0.0, 0.85, 1.0)),
        "led_blue": led_material("Mat.led.blue", (0.08, 0.35, 1.0)),
        "cursor_outline": cursor_material(
            "Mat.cursor.outline", (0.005, 0.01, 0.02)),
        "cursor_fill": cursor_material(
            "Mat.cursor.fill", (0.92, 0.97, 1.0)),
    }

    build_world(sc)
    build_lights(sc)
    build_server_room(sc, materials)
    build_cloud_cards(sc, cfg["total"], paths)
    slab = build_slab(sc, materials, cfg["total"])
    build_clear_covers(sc, slab, materials["cover"])
    camera = build_camera(sc, cfg["total"])

    # Motivated rack focus only at the four meaningful area flips, when the
    # recipe explicitly enables it.
    dof = camera.data.dof
    if bool(nested(environment, ("camera", "rackFocusAtAreaFlips"), False)):
      for flip in shotlist.get("direction", {}).get("flips", []):
        a = int(flip["start"])
        mid = int(flip["edgeOn"])
        b = int(flip["end"])
        for frame, dist in ((a, CAM_Z), (mid, CAM_Z - 0.35), (b, CAM_Z)):
            dof.focus_distance = dist
            dof.keyframe_insert(data_path="focus_distance", frame=frame)

    manifest = dict(shotlist_path=os.path.relpath(paths["shotlist"], paths["repo"]), shots=[], ui_planes=0,
                    editorial_callouts=0, cursor_tracks=0, sound="none",
                    area_flips=len(shotlist.get("direction", {}).get(
                        "flips", [])), environment=environment.get("id"))
    for shot in shots:
        src = shot["source"]
        manifest["shots"].append({
            "number": shot["number"],
            "id": shot.get("id", "shot-{0}".format(shot["number"])),
            "kind": shot.get("kind", "action"),
            "group": shot.get("group"),
            "face": shot.get("face", "front"),
            "frames": [shot["frames"]["start"], shot["frames"]["end"]],
            "source": "{0}:{1}".format(src["type"], src["id"]),
        })

    build_ui_planes(sc, slab, shotlist, catalog_index, paths, manifest)
    build_editorial_callouts(sc, slab, shotlist, manifest)
    build_cursor_tracks(sc, slab, catalog_index, paths, materials, manifest)
    build_flips(slab, shotlist, cfg["total"])
    set_scene_animation_easing(sc, shotlist)
    sound_strip = build_sound(sc, paths, manifest)

    write_manifest(cfg, paths, manifest)
    if args.get("receipt") and args.get("quality"):
        subprocess.run([os.environ.get("NODE_BIN", "node"), os.path.join(paths["film_dir"], "receipt-gate.mjs"),
                        "--repo", paths["repo"], "--manifest", paths["build_manifest"],
                        "--receipt", args["receipt"], "--audio", paths["audio"]], check=True)
    render_started = time.perf_counter()
    rendered = False
    if args["quality"]:
        render_frames(sc, cfg, args["quality"], paths)
        rendered = True
    sample_frames = set(args["samples"] or [])
    if args["shots"]:
        sample_frames.update(sample_frames_for_shots(shotlist, args["shots"]))
    if sample_frames:
        render_samples(sc, cfg, sorted(sample_frames), paths)
        rendered = True
    RENDER_RUNTIME["elapsedRenderSeconds"] = (
        time.perf_counter() - render_started if rendered else 0.0)
    relink_assets_for_delivery(sound_strip, paths)
    manifest["portable_dependencies"] = validate_delivery_dependencies(
        sound_strip, paths)
    saved = save_blend(sc, paths)
    validate_delivery_dependencies(sound_strip, paths)
    built_manifest = write_build_manifest(sc, cfg, paths, catalog, manifest)
    print("  saved blend: {0}".format(saved))
    print("  build manifest: {0}".format(built_manifest))
    print("  objects: {0}".format(len(sc.collection.objects)))
    print("=" * 64)
    return saved


def main(argv):
    try:
        args = parse_argv(argv)
    except FilmError as exc:
        print("error: {0}".format(exc), file=sys.stderr)
        return 2
    if args["device_probe"]:
        if not _HAS_BPY:
            print("error: bpy not importable — --probe-device must run inside Blender")
            return 2
        try:
            paths = resolve_paths(args)
            shotlist = load_json(paths["shotlist"])
            environment = load_json(paths["environment"])
            apply_environment_config(environment, shotlist)
            print(json.dumps(probe_cycles_device(
                bpy.context.scene, args["device"]), indent=2, sort_keys=True))
            return 0
        except FilmError as exc:
            print("error: {0}".format(exc), file=sys.stderr)
            return 1
    if args["build_only"]:
        try:
            paths = resolve_paths(args)
            shotlist = load_json(paths["shotlist"])
            environment = load_json(paths["environment"])
            catalog = load_json(paths["catalog"])
            validate_film_contract(shotlist)
            validate_editorial_and_focus(shotlist, environment)
            validate_data_paths(environment, paths)
            build_catalog_index(catalog, paths["ui"])
            print("build-only: input contract and python syntax OK, no Blender touched")
            return 0
        except FilmError as exc:
            print("error: {0}".format(exc), file=sys.stderr)
            return 1
    if not _HAS_BPY:
        print("error: bpy not importable — run inside Blender, or use "
              "--build-only for a syntax check", file=sys.stderr)
        return 2
    try:
        build(args)
        return 0
    except FilmError as exc:
        print("error: {0}".format(exc), file=sys.stderr)
        return 1
    except Exception as exc:  # pragma: no cover
        print("unexpected error: {0}".format(exc))
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
