#!/usr/bin/env python3
"""Build the SkyBao film as a physical 3D edit in Blender 5.x (Cycles).

The film is a single floating 16:9 glass slab inside a dark, procedural
server-room void. Each shot is a real workspace-framed UI capture mapped onto
an image plane resting slightly above the slab's front or back surface. Every
major-area transition rotates the slab exactly 180 degrees around its vertical
axis so the incoming UI is revealed on the reverse face. Actions inside an area
stay on one face and use one restrained dissolve. The camera remains centered;
rounded glass, cloud cards, a cyan perimeter glint, UI motion, and the four
meaningful navigation flips carry the movement. Everything is procedural and
deterministic: no downloaded assets, no editorial text overlays.

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
import sys
import time
import traceback

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
CAM_Z = 5.88
FOCAL_MM = 50.0
ROT_FRAMES = 20           # frames for a full 180-degree area flip
DISSOLVE_FRAMES = 6
BREATH_AMP = 0.018
BREATH_PERIOD_S = 12.0
FPS = 30
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
    global SLAB_RADIUS, UI_RADIUS, UI_OFFSET, CAM_Z, FOCAL_MM
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
                audio_canonical=None, device_probe=False, build_only=False)
    toks = list(argv)
    if toks and toks[0] == "--":
        toks = toks[1:]
    i = 0
    while i < len(toks):
        key = toks[i].lstrip("-")
        val = None
        if i + 1 < len(toks) and not toks[i + 1].startswith("--"):
            val = toks[i + 1]
        if key in ("repo", "out", "width", "height", "quality", "samples",
                   "shots", "device", "cycles-device", "profile", "frames-out",
                   "manifest-out", "audio", "audio-canonical"):
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
            i += 1
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
    repo = args["repo"] or os.path.abspath(
        os.path.join(film_dir, "..", "..", "..", ".."))
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
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def require_file(path):
    if not os.path.isfile(path):
        raise FilmError("missing asset file: {0}".format(path))


def frame_name(n):
    return "frame-{0:06d}.png".format(int(n))


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
            image = _load_image(os.path.join(paths["repo"], source))
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
            "slab.glass.mesh", SLAB_W, SLAB_T, SLAB_H, SLAB_RADIUS, 14),
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
                SLAB_W, SLAB_H, SLAB_RADIUS, 14),
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
    return img


def _set_opacity(material, frame, value):
    node = material.node_tree.nodes.get("Opacity")
    if node is None:
        return
    node.outputs[0].default_value = float(value)
    node.outputs[0].keyframe_insert(data_path="default_value", frame=frame)


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

        shot_start = int(shot["frames"]["start"])
        shot_end = int(shot["frames"]["end"])
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
            first = os.path.join(paths["ui"], entry["directory"],
                                 frame_name(int(src["startFrame"])))
            image = _load_image(first)
            clip_info = {
                "directory": os.path.join(paths["ui"], entry["directory"]),
                "trim_start": int(src["startFrame"]),
                "trim_end": int(src["endFrame"]),
                "shot_start": shot_start,
                "shot_end": shot_end,
                "render_start": render_start,
                "render_end": render_end,
                "timeline": (os.path.join(paths["ui"], entry["timeline"])
                             if entry.get("timeline") else None),
                "shot": shot,
                "face": face,
            }
        else:
            image = _load_image(os.path.join(paths["ui"], entry["file"]))

        mat = ui_material("UI.mat.S{0:02d}".format(shot["number"]), image)
        plane = add_mesh_object(
            scene,
            make_rounded_plane_mesh(
                "ui.{0}.mesh".format(shot["number"]),
                SLAB_W, SLAB_H, UI_RADIUS, 14),
            "UI.S{0:02d}.{1}".format(shot["number"], face), mat, parent=slab)

        # Later shots sit microns closer during a dissolve, avoiding z-fight.
        face_sign = 1.0 if is_back else -1.0
        layer = index * 0.000012
        plane.location.y = face_sign * (SLAB_HALF_T + UI_OFFSET + layer)
        plane.scale.x = -1.0 if is_back else 1.0
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
            _set_opacity(mat, min(render_end, shot_start + DISSOLVE_FRAMES), 1.0)
        if dissolve_out:
            _set_opacity(mat, shot_end, 1.0)
            _set_opacity(mat, render_end, 0.0)
        planes.append(plane)

    manifest["ui_planes"] = len(planes)
    return planes


def build_cursor_tracks(scene, slab, paths, materials, manifest):
    """Render cursor motion from navigation timeline JSON, separate from UI pixels."""
    count = 0
    for info in FILM_CLIP_INFO:
        shot = info["shot"]
        if shot.get("kind") != "navigation" or not info.get("timeline"):
            continue
        timeline = load_json(info["timeline"])
        events = timeline.get("cursor", [])
        trim_zero = info["trim_start"] - 1
        events = [event for event in events
                  if trim_zero <= int(event["frame"]) <= info["trim_end"] - 1]
        if not events:
            raise FilmError("navigation shot {0} has no cursor timeline".format(
                shot["id"]))

        face_sign = 1.0 if info["face"] == "back" else -1.0
        root = bpy.data.objects.new("Cursor.{0}".format(shot["id"]), None)
        scene.collection.objects.link(root)
        root.parent = slab
        root.scale.x = -1.0 if info["face"] == "back" else 1.0
        root.location.y = face_sign * (
            SLAB_HALF_T + UI_OFFSET + info.get("layer", 0.0) + 0.0008)

        outer = add_mesh_object(
            scene, make_cursor_mesh("cursor.outer.mesh", 0.069),
            "Cursor.outer.{0}".format(shot["number"]),
            materials["cursor_outline"], parent=root)
        inner = add_mesh_object(
            scene, make_cursor_mesh("cursor.inner.mesh", 0.053),
            "Cursor.inner.{0}".format(shot["number"]),
            materials["cursor_fill"], parent=root)
        inner.location = (0.004, face_sign * 0.00018, -0.004)

        first_global = None
        last_click = None
        for event in events:
            global_frame = info["shot_start"] + (int(event["frame"]) - trim_zero)
            if global_frame < info["render_start"] or global_frame > info["render_end"]:
                continue
            nx = float(event.get("nx", 0.5))
            ny = float(event.get("ny", 0.5))
            x = (nx - 0.5) * SLAB_W
            if info["face"] == "back":
                x *= -1.0
            z = (0.5 - ny) * SLAB_H
            root.location.x = x
            root.location.z = z
            root.keyframe_insert(data_path="location", frame=global_frame)
            first_global = global_frame if first_global is None else first_global
            if event.get("event") == "click":
                last_click = global_frame
                base_x = -1.0 if info["face"] == "back" else 1.0
                root.scale = (base_x, 1.0, 1.0)
                root.keyframe_insert(data_path="scale", frame=max(1, global_frame - 1))
                root.scale = (base_x * 0.82, 0.82, 0.82)
                root.keyframe_insert(data_path="scale", frame=global_frame)
                root.scale = (base_x, 1.0, 1.0)
                root.keyframe_insert(data_path="scale", frame=global_frame + 3)

        if first_global is None:
            continue
        hide_frame = min(info["render_end"] + 1,
                         (last_click + 7) if last_click else info["shot_end"] + 1)
        # Object visibility is not inherited reliably from an Empty in Eevee,
        # so keyframe the root and both rendered cursor layers explicitly.
        for cursor_object in (root, outer, inner):
            cursor_object.hide_render = True
            cursor_object.keyframe_insert(
                data_path="hide_render", frame=max(1, first_global - 1))
            cursor_object.hide_render = False
            cursor_object.keyframe_insert(
                data_path="hide_render", frame=first_global)
            cursor_object.hide_render = True
            cursor_object.keyframe_insert(
                data_path="hide_render", frame=hide_frame)
        count += 1
    manifest["cursor_tracks"] = count
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

    # Slow Z breathing only — the camera never wanders in X/Y.
    for frame in range(1, total + 1, 15):
        t = frame / FPS
        z = CAM_Z + BREATH_AMP * math.sin(2.0 * math.pi * t / BREATH_PERIOD_S)
        cam.location.y = -z
        cam.keyframe_insert(data_path="location", frame=frame)
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
        path = os.path.join(info["directory"], frame_name(cf))
        if not os.path.isfile(path):
            continue
        tex = next(n for n in
                   info["plane"].data.materials[0].node_tree.nodes
                   if n.type == "TEX_IMAGE")
        if tex.image.filepath == path:
            continue
        try:
            tex.image.filepath = path
            tex.image.reload()
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
        resolved = os.path.normpath(os.path.join(
            paths["film"], image.filepath[2:]))
        if not os.path.isfile(resolved):
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
        if input_id in ("uiCatalog", "shotlist"):
            continue
        absolute_path = os.path.join(paths["repo"], relative_path)
        if os.path.isfile(absolute_path):
            input_assets[input_id] = {
                "path": relative_path,
                "sha256": sha256_file(absolute_path),
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
        }
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


# ---------------------------------------------------------------------------
# Main build
# ---------------------------------------------------------------------------
def build(args):
    paths = resolve_paths(args)
    shotlist = load_json(paths["shotlist"])
    environment = load_json(paths["environment"])
    catalog = load_json(paths["catalog"])
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

    catalog_index = build_catalog_index(catalog)
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

    # Motivated rack focus only at the four meaningful area flips.
    dof = camera.data.dof
    for flip in shotlist.get("direction", {}).get("flips", []):
        a = int(flip["start"])
        mid = int(flip["edgeOn"])
        b = int(flip["end"])
        for frame, dist in ((a, CAM_Z), (mid, CAM_Z - 0.35), (b, CAM_Z)):
            dof.focus_distance = dist
            dof.keyframe_insert(data_path="focus_distance", frame=frame)

    manifest = dict(shotlist_path=paths["shotlist"], shots=[], ui_planes=0,
                    cursor_tracks=0, sound="none",
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
    build_cursor_tracks(sc, slab, paths, materials, manifest)
    build_flips(slab, shotlist, cfg["total"])
    sound_strip = build_sound(sc, paths, manifest)

    write_manifest(cfg, paths, manifest)
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
    args = parse_argv(argv)
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
            print("error: {0}".format(exc))
            return 1
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
