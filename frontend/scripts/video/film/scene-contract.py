#!/usr/bin/env python3
"""Exact, recipe-derived validation of the saved SkyBao Blender scene."""
import argparse
import hashlib
import importlib.util
import json
import math
import os
import re
import sys

# Blender 5.2 does not always add a --python script's directory to sys.path.
# Keep the shared helper import normal and deterministic in Blender.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cursor_window import event_for_frame
from ui_plane_window import ui_plane_render_window

import bpy
from mathutils import Vector

ENVIRONMENT = {}
REPO = ""


def die(message):
    print("scene-contract: FAIL: " + message, file=sys.stderr)
    # Blender swallows SystemExit from --python scripts and still returns 0;
    # use the process status so render promotion cannot bless a failed scene.
    os._exit(1)


def read_json(path):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except Exception as exc:
        die("cannot read {0}: {1}".format(path, exc))


def curves_for(datablock):
    animation = getattr(datablock, "animation_data", None)
    action = getattr(animation, "action", None)
    found = list(getattr(action, "fcurves", []) or [])
    for layer in list(getattr(action, "layers", []) or []):
        for strip in list(getattr(layer, "strips", []) or []):
            for bag in list(getattr(strip, "channelbags", []) or []):
                found.extend(list(getattr(bag, "fcurves", []) or []))
    return list({id(item): item for item in found}.values())


def curve(datablock, path, index=None):
    return next((item for item in curves_for(datablock)
                 if item.data_path == path and (index is None or item.array_index == index)), None)


def all_curves(datablock, path):
    return [item for item in curves_for(datablock) if item.data_path == path]


def keys(item):
    return list(item.keyframe_points) if item else []


def keyframes(item):
    return [round(float(key.co.x), 6) for key in keys(item)]


def close(actual, expected, label, tolerance=1e-5):
    if not math.isfinite(float(actual)) or abs(float(actual) - float(expected)) > tolerance:
        die("{0}: got {1}, expected {2}".format(label, actual, expected))


def exact_keys(item, expected, label):
    if item is None:
        die("missing {0} F-curve".format(label))
    if keyframes(item) != list(expected):
        die("{0} keyframes differ (got {1}, expected {2})".format(label, keyframes(item), list(expected)))


def interpolation(item, expected, label):
    if any(key.interpolation != expected for key in keys(item)):
        die("{0} interpolation is not {1}".format(label, expected))


def exact_values(item, expected, label, tolerance=1e-5):
    exact_keys(item, [x[0] for x in expected], label)
    for key, value in expected:
        close(item.evaluate(key), value, label + "@" + str(key), tolerance)


def action_curves(datablock):
    return curves_for(datablock)


def assert_animation_clean(datablock, label, allowed_paths):
    """Reject animation indirection which is not part of the recipe."""
    if getattr(datablock, "animation_data", None) and getattr(datablock.animation_data, "drivers", None):
        die(label + " has unexpected drivers")
    for item in curves_for(datablock):
        if item.data_path not in allowed_paths:
            die(label + " has an unexpected animation curve: " + item.data_path)
        if getattr(item, "modifiers", None):
            die(label + " has an F-curve modifier")


def assert_delta_default(obj, label):
    for name in ("delta_location", "delta_rotation_euler", "delta_scale"):
        value = getattr(obj, name, None)
        wanted = (1.0, 1.0, 1.0) if name == "delta_scale" else (0.0, 0.0, 0.0)
        if value is None or any(abs(float(a) - b) > 1e-7 for a, b in zip(value, wanted)):
            die(label + " has non-default " + name)


def ui_plane_transform(index, face, environment):
    """Use the builder's parent-local UI recipe as the contract source."""
    builder_path = os.path.join(os.path.dirname(__file__), "build-blender.py")
    spec = importlib.util.spec_from_file_location("skybao_build_blender", builder_path)
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    builder.apply_environment_config(environment, {"direction": {}, "format": {}})
    return builder.ui_plane_local_transform(index, face)


def assert_local_transform(obj, expected, label):
    location, rotation, scale = expected
    for actual, wanted in zip(obj.location, location): close(actual, wanted, label + ".location")
    for actual, wanted in zip(obj.rotation_euler, rotation): close(actual, wanted, label + ".rotation")
    for actual, wanted in zip(obj.scale, scale): close(actual, wanted, label + ".scale")
    identity = ((1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1))
    for row, wanted in zip(obj.matrix_parent_inverse, identity):
        for actual, value in zip(row, wanted): close(actual, value, label + ".matrix_parent_inverse")


def collection_layer(layer, collection):
    """Find a collection's active-view-layer entry without relying on names."""
    if layer.collection == collection:
        return layer
    for child in layer.children:
        found = collection_layer(child, collection)
        if found:
            return found
    return None


def collection_layer_chain(layer, collection, chain=None):
    chain = list(chain or []) + [layer]
    if layer.collection == collection:
        return chain
    for child in layer.children:
        found = collection_layer_chain(child, collection, chain)
        if found:
            return found
    return None


def expected_collection():
    """Return the collection used by the generated scene, not a localized name."""
    scene = bpy.context.scene
    root = getattr(scene, "collection", None)
    if root is None:
        die("active scene has no root collection")
    return root


def assert_collection_visible(scene, collection, label):
    """Reject visibility overrides on a collection or any of its parents."""
    chain = collection_layer_chain(scene.view_layers[0].layer_collection, collection)
    if chain is None:
        die(label + " collection is unlinked or excluded")
    # LayerCollection.hide_render was removed in Blender 5.2.  Render
    # visibility belongs to the underlying Collection datablock; viewport
    # visibility and exclusion remain properties of the layer wrapper.
    for layer in chain:
        if layer.exclude:
            die(label + " collection is unlinked or excluded")
        if layer.hide_viewport:
            die(label + " collection is hidden")
        data_collection = layer.collection
        if data_collection.hide_render or data_collection.hide_viewport:
            die(label + " collection is hidden")


def assert_scene_collection(obj, label):
    scene = bpy.context.scene
    expected = expected_collection()
    if len(obj.users_collection) != 1 or obj.users_collection[0] != expected:
        die(label + " has the wrong collection linkage")
    collection = obj.users_collection[0]
    assert_collection_visible(scene, collection, label)


def assert_clean_object(obj, parent, label, scale=None):
    if obj.parent != parent: die(label + " has the wrong parent")
    assert_scene_collection(obj, label)
    if any(not math.isfinite(float(v)) or abs(float(v)) < 1e-9 for v in obj.scale):
        die(label + " has zero or non-finite scale")
    if scale is not None:
        for actual, wanted in zip(obj.scale, scale): close(actual, wanted, label + ".scale")
    if obj.hide_viewport or obj.hide_get():
        die(label + " has a visibility override")
    if obj.constraints: die(label + " has unexpected constraints")
    if obj.modifiers: die(label + " has unexpected modifiers")
    assert_delta_default(obj, label)
    assert_animation_clean(obj, label, {"location", "scale", "hide_render", "rotation_euler"})
    if obj.hide_render and not curve(obj, "hide_render"):
        die(label + " is effectively hidden without a visibility curve")


def assert_material_links(mat, label, expected_color=None, strength=None):
    if not mat or not mat.use_nodes: die(label + " is missing nodes")
    nt = mat.node_tree
    output = nt.nodes.get("Out")
    if not output or not any(link.to_node == output and link.to_socket.name == "Surface" for link in nt.links):
        die(label + " output is disconnected")
    if expected_color is not None:
        emission = nt.nodes.get("EditorialEmission")
        mix = nt.nodes.get("EditorialMix")
        opacity = nt.nodes.get("Opacity")
        transparent = nt.nodes.get("Transparent")
        if not emission or not mix or not opacity or not transparent:
            die(label + " has incomplete opacity/emission nodes")
        def linked(a, b): return any(x.from_socket == a and x.to_socket == b for x in nt.links)
        if not linked(opacity.outputs[0], mix.inputs[0]) or not linked(transparent.outputs[0], mix.inputs[1]) or not linked(emission.outputs[0], mix.inputs[2]):
            die(label + " opacity/emission wiring is disconnected")
        actual = tuple(emission.inputs["Color"].default_value[:3])
        for i, value in enumerate(expected_color): close(actual[i], value, label + " color")
        close(emission.inputs["Strength"].default_value, strength, label + " emission")
    if getattr(mat, "animation_data", None) and getattr(mat.animation_data, "drivers", None):
        die(label + " has unexpected drivers")
    for item in curves_for(nt):
        if getattr(item, "modifiers", None): die(label + " has an F-curve modifier")


def assert_ui_material_graph(mat, label, environment):
    if not mat or not mat.use_nodes:
        die(label + " is missing its UI material nodes")
    nt = mat.node_tree
    names = {"Tex", "UIBrightness", "Emit", "Opacity", "Alpha", "Transparent", "Mix", "Out"}
    if any(nt.nodes.get(name) is None for name in names):
        die(label + " has an incomplete UI graph")
    close(nt.nodes["Emit"].inputs["Strength"].default_value,
          float(environment.get("glass", {}).get("uiEmission", 1.12)),
          label + " emission")
    close(nt.nodes["UIBrightness"].inputs["Gamma"].default_value,
          float(environment.get("glass", {}).get("uiTextureGamma", 1.0)),
          label + " texture gamma")
    def connected(a, b):
        return any(link.from_socket == a and link.to_socket == b for link in nt.links)
    if not connected(nt.nodes["Tex"].outputs.get("Color"), nt.nodes["UIBrightness"].inputs.get("Color")) or \
       not connected(nt.nodes["UIBrightness"].outputs.get("Color"), nt.nodes["Emit"].inputs.get("Color")) or \
       not connected(nt.nodes["Tex"].outputs.get("Alpha"), nt.nodes["Alpha"].inputs[0]) or \
       not connected(nt.nodes["Opacity"].outputs[0], nt.nodes["Alpha"].inputs[1]) or \
       not connected(nt.nodes["Alpha"].outputs[0], nt.nodes["Mix"].inputs[0]) or \
       not connected(nt.nodes["Transparent"].outputs.get("BSDF"), nt.nodes["Mix"].inputs[1]) or \
       not connected(nt.nodes["Emit"].outputs.get("Emission"), nt.nodes["Mix"].inputs[2]) or \
       not connected(nt.nodes["Mix"].outputs.get("Shader"), nt.nodes["Out"].inputs.get("Surface")):
        die(label + " has disconnected required UI sockets")
    assert_animation_clean(
        nt, label,
        {'nodes["Opacity"].outputs[0].default_value',
         'nodes["Opacity"].inputs[0].default_value'})


def source_events(repo, shotlist):
    catalog_file = os.path.join(repo, ENVIRONMENT.get("toolInputs", {}).get("uiCatalog", "artifacts/skybao-ui/catalog.json"))
    catalog_root = os.path.dirname(catalog_file)
    catalog = read_json(catalog_file)
    entries = {(x.get("type"), x.get("id"), x.get("framing")): x
               for x in catalog.get("assets", []) if isinstance(x, dict)}
    tracks = {"front": [], "back": []}
    for shot in shotlist["shots"]:
        source = shot["source"]
        if source["type"] != "clip":
            continue
        entry = entries.get((source["type"], source["id"], source.get("framing")))
        if not entry:
            die("missing catalog entry for {0}".format(shot["id"]))
        timeline_path = os.path.join(catalog_root, entry["timeline"])
        timeline = read_json(timeline_path)
        trim_zero = source["startFrame"] - 1
        events = [e for e in timeline.get("cursor", [])
                  if trim_zero <= int(e["frame"]) <= source["endFrame"] - 1]
        if not events:
            continue
        frame_events = [(shot["frames"]["start"] + int(e["frame"]) - trim_zero, e)
                        for e in events]
        runs, pending = [], []
        for item in frame_events:
            frame, event = item
            if event.get("event") == "move" and (not pending or frame == pending[-1][0] + 1):
                pending.append(item)
            else:
                if pending:
                    runs.append(("move", pending)); pending = []
                if event.get("event") != "move":
                    runs.append(("cluster", [item]))
        if pending:
            runs.append(("move", pending))
        windows = []
        for kind, items in runs:
            if kind == "move" and len(items) >= 2:
                start, end = items[0][0] - 1, items[-1][0] + 1
            else:
                start = min(x[0] for x in items) - 2
                end = max(x[0] for x in items) + 4
            windows.append((max(shot["frames"]["start"], start),
                            min(shot["frames"]["end"], end), items))
        merged = []
        for start, end, items in sorted(windows, key=lambda value: value[0]):
            if merged and start <= merged[-1][1] + 1:
                merged[-1] = (merged[-1][0], max(merged[-1][1], end), merged[-1][2] + items)
            else:
                merged.append((start, end, list(items)))
        tracks[shot["face"]].append((shot, merged))
    return tracks


def check_cursor(repo, shotlist, environment):
    tracks = source_events(repo, shotlist)
    expected = {face: [] for face in tracks}
    positions = {face: {} for face in tracks}
    glass = environment["glass"]
    ui_w = float(glass["widthM"]) - 2 * float(glass["uiInsetM"])
    ui_h = ui_w * 9 / 16
    ui_offset = float(glass["layers"]["ui"]["offsetM"])
    catalog_file = os.path.join(repo, environment.get("toolInputs", {}).get("uiCatalog", "artifacts/skybao-ui/catalog.json"))
    catalog_root = os.path.dirname(catalog_file)
    catalog = read_json(catalog_file)
    assets = {(x.get("type"), x.get("id"), x.get("framing")): x for x in catalog.get("assets", [])}
    for face, shot_tracks in tracks.items():
        for shot, windows in shot_tracks:
            expected[face].extend((a, b) for a, b, _ in windows)
            entry = assets[(shot["source"]["type"], shot["source"]["id"], shot["source"].get("framing"))]
            timeline = read_json(os.path.join(catalog_root, entry["timeline"]))
            trim_zero = shot["source"]["startFrame"] - 1
            events = [e for e in timeline["cursor"] if trim_zero <= int(e["frame"]) <= shot["source"]["endFrame"] - 1]
            crop = dict(scale=[1.0, 1.0], center=[0.5, 0.5])
            for event in events:
                if (not crop["center"][0] - crop["scale"][0] / 2 <= float(event["nx"]) <= crop["center"][0] + crop["scale"][0] / 2 or
                        not crop["center"][1] - crop["scale"][1] / 2 <= float(event["ny"]) <= crop["center"][1] + crop["scale"][1] / 2):
                    die("cursor event falls outside crop window for " + shot["id"])
            for a, b, items in windows:
                # Merged activity windows can contain samples from adjacent runs.
                # Keep the event stream chronological so a click never causes the
                # cursor to rewind to an older sample.
                for frame in range(a, b + 1):
                    # Cursor windows include lead-in padding before their first
                    # captured event.  The shared resolver also preserves the
                    # latest position after sparse samples and navigation clicks.
                    event = event_for_frame(items, frame)
                    x = (float(event["nx"]) - crop["center"][0]) * ui_w / crop["scale"][0]
                    if face == "back": x *= -1
                    positions[face][frame] = (x, (crop["center"][1] - float(event["ny"])) * ui_h / crop["scale"][1])
    for face in ("front", "back"):
        root = bpy.data.objects.get("CursorRig." + face)
        children = [root, bpy.data.objects.get("CursorRig.outer." + face), bpy.data.objects.get("CursorRig.inner." + face)]
        if any(x is None for x in children): die("incomplete {0} cursor rig".format(face))
        merged = []
        for a, b in sorted(expected[face]):
            if merged and a <= merged[-1][1] + 1: merged[-1] = (merged[-1][0], max(merged[-1][1], b))
            else: merged.append((a, b))
        visible = {f for a, b in merged for f in range(a, b + 1)}
        hide_keys = [1] + [v for pair in merged for v in (pair[0], pair[1] + 1)]
        for obj in children:
            expected_scale = ((-1.0, 1.0, 1.0) if face == "back" else (1.0, 1.0, 1.0)) if obj is root else (1.0, 1.0, 1.0)
            assert_clean_object(obj, root.parent if obj is root else root, obj.name, expected_scale)
            hide = curve(obj, "hide_render")
            exact_keys(hide, hide_keys, obj.name + ".hide_render")
            interpolation(hide, "CONSTANT", obj.name + ".hide_render")
            for frame in range(1, 1201):
                if bool(round(hide.evaluate(frame))) != (frame not in visible):
                    die("{0}.hide_render visibility mismatch at frame {1}".format(obj.name, frame))
            for fcurve in action_curves(obj):
                if fcurve.data_path not in ("location", "scale", "hide_render"):
                    die(obj.name + " has an unexpected animation curve: " + fcurve.data_path)
            for material in obj.data.materials if getattr(obj, "data", None) else []:
                if material.name not in ("Mat.cursor.outline", "Mat.cursor.fill"):
                    die(obj.name + " has an unexpected material")
                nt = material.node_tree
                emit, out = nt.nodes.get("Emit"), nt.nodes.get("Out")
                if not emit or not out or not any(l.from_socket == emit.outputs.get("Emission") and l.to_socket == out.inputs.get("Surface") for l in nt.links):
                    die(obj.name + " cursor material is not connected Emit -> Out.Surface")
            if obj is root:
                scale_curves = all_curves(root, "scale")
                click_frames = sorted({f for f, event in [(f, e) for shot, windows in tracks[face] for _, _, items in windows for f, e in items] if event.get("event") == "click"})
                expected_scale_keys = sorted({x for f in click_frames for x in (max(1, f-1), f, min(1200, f+3))})
                if scale_curves:
                    if sorted(x.array_index for x in scale_curves) != [0, 1, 2]: die(root.name + ".scale must have X/Y/Z curves")
                    for item in scale_curves:
                        exact_keys(item, expected_scale_keys, root.name + ".scale")
                        interpolation(item, "BEZIER", root.name + ".scale")
                        for frame in expected_scale_keys:
                            pulse = any(frame == f for f in click_frames)
                            wanted = expected_scale[item.array_index] * (0.82 if pulse else 1.0)
                            close(item.evaluate(frame), wanted, root.name + ".scale@" + str(frame))
        loc = all_curves(root, "location")
        if sorted(x.array_index for x in loc) != [0, 1, 2]: die("{0}.location must have X/Y/Z curves".format(root.name))
        wanted_keys = sorted(positions[face])
        if any(keyframes(x) != wanted_keys for x in loc): die("{0}.location has extra or missing keys".format(root.name))
        for item in loc:
            interpolation(item, "LINEAR", root.name + ".location[{0}]".format(item.array_index))
            for frame in wanted_keys:
                rig_y = -(float(glass["thicknessM"]) / 2 + ui_offset + .0008) if face == "front" else (float(glass["thicknessM"]) / 2 + ui_offset + .0008)
                wanted = (positions[face][frame][0], rig_y, positions[face][frame][1])[item.array_index]
                close(item.evaluate(frame), wanted, root.name + ".location[{0}]@{1}".format(item.array_index, frame))
    return sum(len(v) for v in tracks.values())


def check_callouts(shotlist, environment):
    color = environment["editorial"]["textColor"]
    expected_color = tuple(int(color[i:i+2], 16) / 255 for i in (1, 3, 5))
    for callout in shotlist["editorialCallouts"]:
        obj = bpy.data.objects.get("Editorial." + callout["id"])
        mat = bpy.data.materials.get("Editorial.mat." + callout["id"])
        if not obj or not mat: die("missing callout " + callout["id"])
        slab = bpy.data.objects.get("Glass.slab")
        if not slab: die("Glass.slab is missing")
        face = callout["face"]
        transition = callout.get("transition") or {}
        rest_scale = (-1.0, -1.0, 1.0) if face == "back" else (1.0, 1.0, 1.0)
        # The blend is commonly saved after a late review frame.  Do not
        # inspect the evaluated transform here: the authored transition curves
        # below are the source of truth and are checked at every key.
        assert_clean_object(obj, slab, "callout " + callout["id"])
        if len(obj.data.materials) != 1 or obj.data.materials[0] != mat:
            die("callout " + callout["id"] + " material linkage is wrong")
        if obj.data.body != callout["text"]: die("callout text mismatch: " + callout["id"])
        close(obj.data.size, callout["fontSizeM"], callout["id"] + " font size")
        sign = 1 if face == "back" else -1
        glass = environment["glass"]
        expected_loc = (-callout["positionM"][0] if face == "back" else callout["positionM"][0], sign * (float(glass["thicknessM"])/2 + float(glass["layers"]["ui"]["offsetM"]) + .0012), callout["positionM"][1])
        entrance = transition.get("entranceOffsetM", [0.0, 0.0])
        expected_rot = (math.radians(-90 if face == "back" else 90), 0, 0)
        for i, value in enumerate(expected_rot): close(obj.rotation_euler[i], value, callout["id"] + " orientation")
        assert_material_links(mat, "callout " + callout["id"], expected_color, environment["editorial"]["emissionStrength"])
        assert_animation_clean(obj, "callout " + callout["id"], {"hide_render", "location", "scale"})
        assert_animation_clean(mat.node_tree, "callout " + callout["id"] + " material", {'nodes["Opacity"].outputs[0].default_value', 'nodes["Opacity"].inputs[0].default_value'})
        start, end, fade = callout["frames"]["start"], callout["frames"]["end"], callout["fadeFrames"]
        hide = curve(obj, "hide_render"); exact_keys(hide, [max(1, start-fade-1), max(1, start-fade), min(1200, end+fade+1)], callout["id"] + ".hide_render"); interpolation(hide, "CONSTANT", callout["id"] + ".hide_render")
        expected_hide = [(max(1, start-fade-1), 1.0), (max(1, start-fade), 0.0), (min(1200, end+fade+1), 1.0)]
        exact_values(hide, expected_hide, callout["id"] + ".hide_render")
        opacity = curve(mat.node_tree, 'nodes["Opacity"].outputs[0].default_value') or curve(mat.node_tree, 'nodes["Opacity"].inputs[0].default_value')
        exact_keys(opacity, [max(1, start-fade), start, end, min(1200, end+fade)], callout["id"] + ".opacity"); interpolation(opacity, "BEZIER", callout["id"] + ".opacity")
        exact_values(opacity, [(max(1, start-fade), 0.0), (start, 1.0), (end, 1.0), (min(1200, end+fade), 0.0)], callout["id"] + ".opacity")
        transition = callout.get("transition")
        if not isinstance(transition, dict): die(callout["id"] + " transition is missing")
        keys_for_transition = [max(1, start-fade), start, end, min(1200, end+fade)]
        base_location = tuple(expected_loc)
        entrance = transition["entranceOffsetM"]
        exit_offset = transition["exitOffsetM"]
        if face == "back":
            entrance = [-float(entrance[0]), float(entrance[1])]
            exit_offset = [-float(exit_offset[0]), float(exit_offset[1])]
        locations = [
            (base_location[0] + entrance[0], base_location[1], base_location[2] + entrance[1]),
            base_location,
            base_location,
            (base_location[0] + exit_offset[0], base_location[1], base_location[2] + exit_offset[1]),
        ]
        for axis in range(3):
            track = curve(obj, "location", axis)
            exact_values(track, [(keys_for_transition[i], locations[i][axis]) for i in range(4)], callout["id"] + ".location[" + str(axis) + "]")
            interpolation(track, "BEZIER", callout["id"] + ".location[" + str(axis) + "]")
        base_scale = rest_scale
        factors = [float(transition["startScale"]), 1.0, 1.0, float(transition["exitScale"])]
        for axis in range(3):
            track = curve(obj, "scale", axis)
            exact_values(track, [(keys_for_transition[i], base_scale[axis] * factors[i]) for i in range(4)], callout["id"] + ".scale[" + str(axis) + "]")
            interpolation(track, "BEZIER", callout["id"] + ".scale[" + str(axis) + "]")


def check_floating_highlights(shotlist, environment):
    beats = shotlist.get("floatingHighlights")
    if not isinstance(beats, list) or len(beats) != 7:
        die("floatingHighlights must contain exactly seven authored beats")
    if len({beat.get("id") for beat in beats}) != 7:
        die("floating highlight IDs must be unique")
    for index, beat in enumerate(beats):
        shot = next((item for item in shotlist["shots"] if item.get("id") == beat.get("shotId")), None)
        if not shot: die("floating highlight references unknown shot: " + str(beat.get("shotId")))
        frame = int(beat.get("globalFrame", 0))
        if not shot["frames"]["start"] <= frame <= shot["frames"]["end"]:
            die("floating highlight is outside its shot: " + str(beat.get("id")))
        for key in ("targetId", "capturePhase"):
            if not isinstance(beat.get(key), str) or not beat[key]:
                die("floating highlight {0} is missing {1}".format(beat.get("id"), key))
        names = {
            "panel": "FloatingHighlight.{0}.{1}".format(beat["id"], index),
            "front": "FloatingFront.{0}.{1}".format(beat["id"], index),
            "back": "FloatingBack.{0}.{1}".format(beat["id"], index),
        }
        panel = bpy.data.objects.get(names["panel"])
        front = bpy.data.objects.get(names["front"])
        back = bpy.data.objects.get(names["back"])
        if not all((panel, front, back)): die("missing floating highlight objects for " + beat["id"])
        for obj in (panel, front, back):
            if obj.parent != bpy.data.objects.get("Glass.slab"):
                die(obj.name + " must be parented to Glass.slab")
            assert_animation_clean(obj, obj.name, {"location", "scale", "hide_render"})
            if len(obj.data.materials) != 1: die(obj.name + " material linkage is wrong")
        if len(panel.modifiers) != 1 or panel.modifiers[0].type != "BEVEL":
            die(panel.name + " must have one rounded bevel")
        design_path = os.path.join(REPO, environment["toolInputs"]["designLanguage"])
        design = read_json(design_path)
        floating = design["floatingElement"]
        extrusion = float(
            floating["openingExtrusionM"]
            if beat["shotId"] == "assistant-research"
            else floating["extrusionM"])
        peak_lift = float(
            floating["openingLiftM"]
            if beat["shotId"] == "assistant-research"
            else floating["liftM"])
        close(panel.dimensions.y, extrusion, panel.name + ".extrusion", 2e-5)
        surface_frame = max(1, frame - 6)
        panel_y = curve(panel, "location", 1)
        close(abs(panel_y.evaluate(frame) - panel_y.evaluate(surface_frame)),
              peak_lift, panel.name + ".peakLift", 2e-5)
        front_y = curve(front, "location", 1).evaluate(surface_frame)
        back_y = curve(back, "location", 1).evaluate(surface_frame)
        if abs(front_y - back_y) < extrusion:
            die("floating highlight caps overlap or are not separated by extrusion: " + beat["id"])
        expected_scale_x = -1.0 if shot.get("face") == "back" else 1.0
        for obj in (front, back):
            scale_x = curve(obj, "scale", 0).evaluate(surface_frame)
            if scale_x * expected_scale_x <= 0:
                die(obj.name + " has incorrect back-face orientation")
        front_mat = front.data.materials[0]
        if back.data.materials[0] != front_mat:
            die(beat["id"] + " front/back caps must share one UI material")
        assert_ui_material_graph(
            front_mat, "floating highlight " + beat["id"], environment)
        front_nodes = front_mat.node_tree.nodes
        front_image = next((node.image for node in front_nodes.values()
                            if getattr(node, "type", None) == "TEX_IMAGE" and node.image), None)
        back_image = next((node.image for node in back.data.materials[0].node_tree.nodes.values()
                           if getattr(node, "type", None) == "TEX_IMAGE" and node.image), None)
        if not front_image or front_image != back_image:
            die(beat["id"] + " front/back caps do not share the transparent cutout")
        catalog_path = os.path.join(REPO, environment["toolInputs"]["uiCatalog"])
        catalog = read_json(catalog_path)
        source = shot["source"]
        entry = next((item for item in catalog.get("assets", [])
                      if item.get("type") == source.get("type") and
                      item.get("id") == source.get("id") and
                      item.get("framing") == source.get("framing")), None)
        descriptors = [entry.get("targets"), entry.get("captureTargets"), entry.get("elementTargets"),
                       catalog.get("targets"), catalog.get("captureTargets"),
                       catalog.get("elementTargets"), catalog.get("highlights")]
        descriptor = None
        for collection in descriptors:
            values = collection.items() if isinstance(collection, dict) else enumerate(collection) if isinstance(collection, list) else []
            for key, candidate in values:
                if isinstance(candidate, dict) and beat["targetId"] in (key, candidate.get("targetId"), candidate.get("id"), candidate.get("target")):
                    candidate_frame = candidate.get("frame", candidate.get("sourceFrame"))
                    if candidate_frame is None or candidate_frame == beat["sourceFrame"]:
                        descriptor = dict(candidate, targetId=key) if isinstance(collection, dict) else candidate
                        break
            if descriptor:
                break
        cutout = descriptor.get("cutout") if descriptor else None
        if not descriptor or descriptor.get("capturePhase", descriptor.get("phase")) != beat.get("capturePhase"):
            die(beat["id"] + " capture phase does not match its descriptor")
        expected_path = os.path.realpath(os.path.join(os.path.dirname(catalog_path), cutout.get("path"))) if isinstance(cutout, dict) else None
        actual_path = os.path.realpath(str(front_image.get("anything_llm_capture_source", "")))
        if not expected_path or actual_path != expected_path or front_image.get("anything_llm_capture_sha256") != cutout.get("sha256", cutout.get("contentSha256")):
            die(beat["id"] + " cap texture is not the descriptor-owned transparent cutout")
        edge_mat = panel.data.materials[0]
        edge_nodes = edge_mat.node_tree.nodes
        if any(edge_nodes.get(name) is None for name in ("LayerWeight", "FresnelPower", "RimRamp", "HighlightGlowMask", "Transparent", "RimEmission", "EdgeMix", "HighlightGlow")):
            die(panel.name + " edge material is missing the Layer Weight/Fresnel AOV graph")
        glow_mask = edge_nodes.get("HighlightGlowMask")
        glow_aov = edge_nodes.get("HighlightGlow")
        if not any(link.from_node == glow_mask and link.to_node == glow_aov
                   for link in edge_mat.node_tree.links):
            die(panel.name + " HighlightGlow AOV must be fed by the masked rim color")
        for obj in (panel, front, back):
            curves = all_curves(obj, "location") + all_curves(obj, "scale")
            if not curves: die(obj.name + " has no eased lift animation")
            if any(key.co.x < max(1, frame - 6) or key.co.x > min(1200, frame + 18)
                   for curve_item in curves for key in curve_item.keyframe_points):
                die(obj.name + " animation exceeds its 18-frame treatment window")
    if not any(getattr(aov, "name", None) == "HighlightGlow" for aov in bpy.context.scene.view_layers[0].aovs):
        die("HighlightGlow AOV is missing")
    compositor_tree = getattr(bpy.context.scene, "compositing_node_group", None)
    if compositor_tree is None:
        compositor_tree = getattr(bpy.context.scene, "node_tree", None)
    nodes = compositor_tree.nodes if bpy.context.scene.use_nodes and compositor_tree else []
    if any(nodes.get(name) is None for name in ("Render Layers", "AOV Fog Glow", "Highlight Glow Add", "Group Output")):
        die("isolated HighlightGlow compositor is incomplete")
    add_node = nodes.get("Highlight Glow Add")
    group_output = nodes.get("Group Output")
    if not any(link.from_node == add_node and link.to_node == group_output
               for link in compositor_tree.links):
        die("HighlightGlow compositor must terminate at Group Output")


def check_camera(environment, shotlist):
    cam = bpy.data.objects.get("FilmCamera")
    if not cam: die("FilmCamera is missing")
    if cam.parent is not None: die("FilmCamera linkage is wrong")
    assert_scene_collection(cam, "FilmCamera")
    if bpy.context.scene.camera != cam: die("FilmCamera is not the scene camera")
    if cam.constraints: die("FilmCamera has unexpected constraints")
    if cam.hide_viewport or cam.hide_get() or cam.hide_render: die("FilmCamera has a visibility override")
    if cam.data.dof.focus_object is not None: die("camera DOF target linkage is unexpected")
    assert_delta_default(cam, "FilmCamera")
    # Blender may expose camera-data channels through the owning object action
    # (notably in 5.x channel bags), so accept only the two configured data
    # paths in addition to the camera transform channels.
    assert_animation_clean(cam, "FilmCamera", {"location", "rotation_euler", "lens", "dof.focus_distance"})
    assert_animation_clean(cam.data, "FilmCamera data", {"lens", "dof.focus_distance", "rotation_euler", "location"})
    cfg = environment["camera"]; base = float(cfg["lensMM"]); distance = float(cfg["distanceM"])
    lens = curve(cam.data, "lens"); focus = curve(cam.data, "dof.focus_distance")
    if not lens or not focus: die("camera lens/focus curve is missing")
    moves = cfg["focusMoves"]; points = {1, 1200}
    for move in moves:
        start, end, ease = move["start"], move["end"], move["easeFrames"]; mid = (start + end)//2
        points.update((max(1,start-1), min(1200,end+1), start, min(mid,start+ease), max(mid,end-ease), end))
    expected_lens = {1: base, 1200: base}
    expected_focus = {1: distance, 1200: distance}
    for flip in [item for item in shotlist.get("direction", {}).get("flips", []) if isinstance(item, dict)]:
        for frame, value in ((flip["start"], distance), (flip["edgeOn"], distance - .35), (flip["end"], distance)):
            expected_focus[frame] = value
    for move in moves:
        start, end, ease = move["start"], move["end"], move["easeFrames"]; mid=(start+end)//2
        for frame, value in ((max(1,start-1),base),(min(1200,end+1),base),(start,move["lensStartMM"]),(min(mid,start+ease),move["lensPeakMM"]),(max(mid,end-ease),move["lensPeakMM"]),(end,move["lensEndMM"])):
            expected_lens[frame]=value
        for frame, x, z in ((max(1,start-1),0,0),(min(1200,end+1),0,0),(start,0,0),(min(mid,start+ease),*move["targetOffsetM"]),(max(mid,end-ease),*move["targetOffsetM"]),(end,0,0)):
            expected_focus[frame]=math.sqrt(distance*distance+x*x+z*z)
    for item, values, label in ((lens,expected_lens,"camera lens"),(focus,expected_focus,"camera focus")):
        exact_keys(item, sorted(values), label); interpolation(item, "BEZIER", label)
        for frame, value in values.items(): close(item.evaluate(frame), value, label + "@" + str(frame))
    loc = all_curves(cam, "location")
    if sorted(x.array_index for x in loc) != [0, 1, 2]: die("camera location must have X/Y/Z curves")
    location_keys = set(range(1, 1201, 15))
    for item in loc:
        exact_keys(item, sorted(location_keys), "camera location[{0}]".format(item.array_index))
        interpolation(item, "BEZIER", "camera location[{0}]".format(item.array_index))
        for frame in location_keys:
            wanted = 0.0 if item.array_index != 1 else -distance
            # The builder's deterministic breathing is the only location motion.
            if item.array_index == 1:
                wanted = -distance - float(environment["camera"].get("maxBreathM", 0.018)) * math.sin(2.0 * math.pi * (frame / 30.0) / 12.0)
            close(item.evaluate(frame), wanted, "camera location[{0}]@{1}".format(item.array_index, frame))
    rotation = all_curves(cam, "rotation_euler")
    if sorted(x.array_index for x in rotation) != [0, 1, 2]: die("camera rotation must have X/Y/Z curves")
    rotation_keys = {1, 1200}
    rotation_values = {1: (math.radians(90), 0.0, 0.0), 1200: (math.radians(90), 0.0, 0.0)}
    for move in moves:
        guard = (max(1, move["start"]-1), min(1200, move["end"]+1)); rotation_keys.update(guard)
        for frame in guard: rotation_values[frame] = (math.radians(90), 0.0, 0.0)
        mid = (move["start"] + move["end"]) // 2
        for frame, offset in ((move["start"], (0, 0)), (min(mid, move["start"]+move["easeFrames"]), move["targetOffsetM"]), (max(mid, move["end"]-move["easeFrames"]), move["targetOffsetM"]), (move["end"], (0, 0))):
            direction = Vector((offset[0], 0.0, offset[1])) - Vector((0.0, -distance, 0.0))
            rotation_values[frame] = tuple(direction.to_track_quat("-Z", "Y").to_euler()); rotation_keys.add(frame)
    for item in rotation:
        exact_keys(item, sorted(rotation_keys), "camera rotation[{0}]".format(item.array_index)); interpolation(item, "BEZIER", "camera rotation")
        for frame, values in rotation_values.items(): close(item.evaluate(frame), values[item.array_index], "camera rotation[{0}]@{1}".format(item.array_index, frame))
    for move in moves:
        mid = (move["start"] + move["end"]) // 2
        frame = min(mid, move["start"] + move["easeFrames"])
        offset = move["targetOffsetM"]
        direction = Vector((offset[0], 0.0, offset[1])) - Vector((0.0, -distance, 0.0))
        expected = direction.to_track_quat("-Z", "Y").to_euler()
        for index, value in enumerate(expected):
            item = curve(cam, "rotation_euler", index)
            close(item.evaluate(frame), value, "camera target offset")


def check_dissolves(shotlist):
    expected = {}
    for index, shot in enumerate(shotlist["shots"]):
        number = shot["number"]
        values = expected.setdefault(number, {})
        incoming = shot.get("transitionIn", {}).get("type") == "same-face-dissolve"
        if incoming:
            start = shot["frames"]["start"]
            values.update({start: 0.0, start + 5: 1.0})
        previous = shotlist["shots"][index - 1] if index else None
        following = shotlist["shots"][index + 1] if index + 1 < len(shotlist["shots"]) else None
        if following and following.get("transitionIn", {}).get("type") == "same-face-dissolve":
            start = following["frames"]["start"]
            initial, _ = ui_plane_render_window(
                shotlist["shots"], index,
                int(shotlist["format"]["frames"]),
                int(shotlist["direction"]["sameFaceDissolveFrames"]))
            values.setdefault(initial, 1.0)
            values.update({start: 1.0, start + 5: 0.0})
    count = 0
    for number, values in expected.items():
        if not values: continue
        mat = bpy.data.materials.get("UI.mat.S%02d" % number)
        item = curve(mat.node_tree, 'nodes["Opacity"].outputs[0].default_value') if mat else None
        if item is None: die("missing dissolve opacity curve")
        nt = mat.node_tree; opacity = nt.nodes.get("Opacity"); mix = nt.nodes.get("Mix"); alpha = nt.nodes.get("Alpha")
        if not opacity or not mix or not alpha: die("UI.mat.S%02d dissolve wiring is incomplete" % number)
        if not any(x.from_socket == opacity.outputs[0] and x.to_socket == alpha.inputs[1] for x in nt.links): die("UI.mat.S%02d opacity is disconnected" % number)
        if not any(x.from_socket == alpha.outputs[0] and x.to_socket == mix.inputs[0] for x in nt.links): die("UI.mat.S%02d alpha is disconnected" % number)
        exact_values(item, sorted(values.items()), "UI.mat.S%02d dissolve" % number)
        interpolation(item, "LINEAR", "dissolve")
        count += 1
    return count // 2


def check_audio(repo, manifest_path, allow_staged=False, audio_path=None):
    if not manifest_path: die("--manifest is required for exact saved-scene audio validation")
    manifest = read_json(manifest_path)
    audio = manifest.get("audio")
    if not isinstance(audio, dict) or not isinstance(audio.get("sha256"), str): die("manifest audio provenance is missing")
    profile = (manifest.get("render") or manifest.get("cycles") or {}).get("profile", manifest.get("profile"))
    targeted = profile == "targeted"
    canonical = os.path.realpath(os.path.join(repo, "artifacts/skybao-film/audio",
                                               "targeted-review-mix.wav" if targeted else "skybao-mix.wav"))
    selected = os.path.realpath(audio_path) if allow_staged and audio_path else canonical
    if allow_staged and not audio_path: die("--allow-staged requires --audio")
    if not os.path.isfile(selected): die("manifest audio file is missing")
    import hashlib
    with open(selected, "rb") as handle: digest = hashlib.sha256(handle.read()).hexdigest()
    if digest != audio["sha256"]: die("saved-scene audio hash differs from manifest")
    editor = bpy.context.scene.sequence_editor
    all_strips = list(
        getattr(editor, "strips_all", None) or
        getattr(editor, "sequences_all", None) or
        getattr(editor, "sequences", []) if editor else [])
    if len(all_strips) != 1: die("saved scene must contain exactly one sequence strip")
    strip = all_strips[0]
    if "targeted-review-mix.wav" in str(getattr(getattr(strip, "sound", None), "filepath", "")):
        targeted = True
        canonical = os.path.realpath(os.path.join(repo, "artifacts/skybao-film/audio/targeted-review-mix.wav"))
    if (getattr(strip, "type", None) != "SOUND" or
            strip.name != "Audio.skybao-mix" or strip.channel != 120):
        die("audio strip identity is not canonical")
    if not getattr(strip, "sound", None): die("audio strip has no sound datablock")
    sounds = list(bpy.data.sounds)
    if len(sounds) != 1 or sounds[0] is not strip.sound:
        die("saved scene must contain exactly one sound datablock linked by identity")
    # The datablock identity remains the builder's stable mix name even when
    # the dedicated review package binds the bytes to its own canonical path.
    expected_sound_name = "skybao-mix.wav"
    expected_sound_path = "//audio/" + os.path.basename(canonical)
    if (strip.sound.name != expected_sound_name or
            strip.sound.filepath != expected_sound_path or
            strip.sound.get("anything_llm_audio_identity") != "builder:skybao-mix"):
        die("sound filepath or name semantics are not canonical: name=%s path=%s expected=%s identity=%s" %
            (strip.sound.name, strip.sound.filepath, expected_sound_path,
             strip.sound.get("anything_llm_audio_identity")))
    actual = os.path.realpath(os.path.join(repo, "artifacts/skybao-film",
                                            strip.sound.filepath[2:]))
    repo_root = os.path.realpath(repo)
    try: under_repo = os.path.commonpath((repo_root, actual)) == repo_root
    except ValueError: under_repo = False
    actual_digest = hashlib.sha256(open(selected, "rb").read()).hexdigest() if os.path.isfile(selected) else None
    if actual != canonical or actual_digest != audio["sha256"]:
        die("audio strip is external or not the canonical manifest audio")
    expected_audio_path = "artifacts/skybao-film/audio/targeted-review-mix.wav" if targeted else "artifacts/skybao-film/audio/skybao-mix.wav"
    if audio.get("path") != expected_audio_path:
        die("manifest audio path is not canonical")
    if (strip.frame_start != 1 or strip.frame_final_start != 1 or
            strip.frame_final_end != 1201):
        die("audio strip frame range must be 1..1200")
    if (abs(float(strip.volume) - 1.0) > 1e-7 or strip.mute or
            (hasattr(strip, "pitch") and abs(float(strip.pitch) - 1.0) > 1e-7) or
            (hasattr(strip, "pitch_correction") and not strip.pitch_correction)):
        die("audio strip volume, pitch, and mute must be canonical")


def _catalog_entry(catalog, source):
    """Select a capture using the same key/fallback as build_ui_planes."""
    assets = catalog.get("assets", [])
    wanted = (source.get("type"), source.get("id"), source.get("framing"))
    fallback = (source.get("type"), source.get("id"), None)
    return (next((item for item in assets
                  if (item.get("type"), item.get("id"), item.get("framing")) == wanted), None)
            or next((item for item in assets
                     if (item.get("type"), item.get("id"), item.get("framing")) == fallback), None))


def _expected_capture_path(source, entry):
    """Return the canonical first image loaded by build_ui_planes.

    Clips are deliberately loaded as still images.  Their initial image is the
    first frame of the source trim (not necessarily frame 1 of the sequence),
    using the builder's six-digit frame naming convention.
    """
    catalog_relative = ENVIRONMENT.get("toolInputs", {}).get(
        "uiCatalog", "artifacts/skybao-ui/catalog.json")
    ui_root = os.path.realpath(os.path.join(REPO, os.path.dirname(catalog_relative)))
    if source.get("type") == "still":
        relative = entry.get("file")
    elif source.get("type") == "clip":
        relative = os.path.join(entry.get("directory"),
                                "frame-%06d.png" % source.get("startFrame"))
    else:
        return None
    if not isinstance(relative, str) or not relative:
        return None
    return os.path.realpath(os.path.join(ui_root, relative))


def _capture_path_is_expected(actual, source, entry, expected):
    """Check the delivery image, including the post-render clip state.

    A build-only blend points a clip at its trim's first frame.  Rendering a
    targeted sample deliberately leaves that same image datablock pointing at
    the last frame prepared for the plane.  Both are valid builder output; the
    latter must still be from this shot's exact catalog directory and trim,
    rather than merely being an existing PNG with a plausible name.
    """
    if not actual or not expected:
        return False
    if source.get("type") == "still":
        return actual == expected
    if source.get("type") != "clip":
        return False
    directory = os.path.realpath(os.path.dirname(expected))
    if os.path.dirname(actual) != directory:
        return False
    match = re.fullmatch(r"frame-(\d{6})\.png", os.path.basename(actual))
    if not match:
        return False
    frame = int(match.group(1))
    return int(source.get("startFrame", -1)) <= frame <= int(source.get("endFrame", -2))


def _capture_provenance_is_expected(actual, marker_source, marker_hash,
                                    actual_hash, source, entry, expected):
    """Bind capture identity to the bytes connected to the Tex node.

    A custom property alone is not evidence: a mutation can copy a plausible
    path and digest onto a different image.  The marker must describe the
    same source selected by the path contract and its digest must equal bytes
    read from the file (or packed payload) actually connected to the node.
    """
    marker = os.path.realpath(marker_source) if marker_source else None
    selected = actual or marker
    if not _capture_path_is_expected(selected, source, entry, expected):
        return False
    if marker and actual and marker != actual:
        return False
    return bool(marker_hash and actual_hash and marker_hash == actual_hash)


def _image_digest(image):
    packed = getattr(image, "packed_file", None)
    if packed is not None:
        data = getattr(packed, "data", None)
        if data is not None:
            return hashlib.sha256(bytes(data)).hexdigest()
    actual = _resolved_image_path(getattr(image, "filepath", None))
    if actual and os.path.isfile(actual):
        with open(actual, "rb") as handle:
            return hashlib.sha256(handle.read()).hexdigest()
    return None


def _resolved_image_path(filepath):
    """Resolve Blender paths against the promoted blend destination.

    build-blender.py writes delivery paths as ``//...`` relative to the
    canonical artifacts/skybao-film directory.  A staged blend is opened from
    a temporary directory, so bpy.path.abspath() alone would resolve a valid
    delivery path against the wrong directory.
    """
    if not isinstance(filepath, str) or not filepath:
        return None
    if filepath.startswith("//"):
        base = os.path.join(REPO, "artifacts/skybao-film")
        return os.path.realpath(os.path.join(base, filepath[2:]))
    return os.path.realpath(bpy.path.abspath(filepath))


def check_ui_materials(shotlist):
    if len(shotlist["shots"]) != 19:
        die("expected 19 UI plane recipes")
    wanted = {"UI.S%02d.%s" % (shot["number"], shot["face"]) for shot in shotlist["shots"]}
    actual = {obj.name for obj in bpy.data.objects if obj.name.startswith("UI.S")}
    if actual != wanted:
        die("UI face object set differs (missing or extra faces)")
    glass = bpy.data.objects.get("Glass.slab")
    if not glass: die("Glass.slab is missing")
    total_frames = int(shotlist["format"]["frames"])
    dissolve_frames = int(shotlist["direction"]["sameFaceDissolveFrames"])
    for index, shot in enumerate(shotlist["shots"]):
        obj = bpy.data.objects.get("UI.S%02d.%s" % (shot["number"], shot["face"]))
        expected_location, expected_rotation, expected_scale = ui_plane_transform(index, shot["face"], ENVIRONMENT)
        assert_clean_object(obj, glass, obj.name, expected_scale)
        assert_local_transform(obj, (expected_location, expected_rotation, expected_scale), obj.name)
        close(obj.dimensions.x, float(glass.dimensions.x) - 2 * float(ENVIRONMENT["glass"]["uiInsetM"]), obj.name + ".width", 2e-4)
        close(obj.dimensions.z, obj.dimensions.x * 9 / 16, obj.name + ".aspect", 2e-4)
        try:
            render_start, render_end = ui_plane_render_window(
                shotlist["shots"], index, total_frames, dissolve_frames)
        except ValueError as exc:
            die(obj.name + " visibility recipe is invalid: " + str(exc))
        hide = curve(obj, "hide_render")
        hide_values = []
        if render_start > 1:
            hide_values.append((render_start - 1, 1.0))
        hide_values.extend(((render_start, 0.0), (render_end + 1, 1.0)))
        exact_values(hide, hide_values, obj.name + ".hide_render")
        interpolation(hide, "CONSTANT", obj.name + ".hide_render")
        for frame in range(1, total_frames + 1):
            expected_hidden = not (render_start <= frame <= render_end)
            if bool(round(hide.evaluate(frame))) != expected_hidden:
                die("{0}.hide_render visibility mismatch at frame {1}".format(
                    obj.name, frame))
        if len(obj.data.materials) != 1 or obj.data.materials[0].name != "UI.mat.S%02d" % shot["number"]:
            die(obj.name + " material linkage is wrong")
        mat = obj.data.materials[0]
        tex = mat.node_tree.nodes.get("Tex")
        source = shot["source"]
        catalog_file = os.path.join(REPO, ENVIRONMENT.get("toolInputs", {}).get("uiCatalog", "artifacts/skybao-ui/catalog.json"))
        entry = _catalog_entry(read_json(catalog_file), source)
        expected = _expected_capture_path(source, entry) if entry else None
        image = tex.image if tex else None
        image_user = getattr(tex, "image_user", None) if tex else None
        if (not image or image.source != "FILE" or
                 (image_user is not None and (
                     getattr(image_user, "use_auto_refresh", False) or
                     getattr(image_user, "frame_offset", 0) != 0 or
                     getattr(image_user, "frame_start", 1) != 1)) or
                 not entry or not expected or not os.path.isfile(expected)):
            die(obj.name + " image linkage is missing")
        actual = _resolved_image_path(image.filepath)
        marker_source = image.get("anything_llm_capture_source")
        marker_hash = image.get("anything_llm_capture_sha256")
        actual_hash = _image_digest(image)
        if not _capture_provenance_is_expected(
                actual, marker_source, marker_hash, actual_hash,
                source, entry, expected):
            die(obj.name + " image linkage is not the expected capture")

    for shot in shotlist["shots"]:
        mat = bpy.data.materials.get("UI.mat.S%02d" % shot["number"])
        if not mat: die("missing UI material S%02d" % shot["number"])
        assert_ui_material_graph(mat, mat.name, ENVIRONMENT)


def check_color_management(environment):
    settings = bpy.context.scene.view_settings
    config = environment.get("colorManagement", {})
    expected_transform = str(config.get("viewTransform", "AgX"))
    if settings.view_transform != expected_transform:
        die("color management view transform differs")
    curve_config = config.get("contrastCurve", {})
    enabled = bool(curve_config.get("enabled", False))
    if bool(settings.use_curve_mapping) != enabled:
        die("color management contrast curve enabled state differs")
    if not enabled:
        return
    mapping = settings.curve_mapping
    if mapping is None or len(mapping.curves) < 4:
        die("color management contrast curve is missing")
    expected = [(float(point[0]), float(point[1]))
                for point in curve_config.get("points", [])]
    actual = [(float(point.location[0]), float(point.location[1]))
              for point in mapping.curves[3].points]
    if len(actual) != len(expected):
        die("color management contrast curve point count differs")
    for index, (actual_point, expected_point) in enumerate(zip(actual, expected)):
        close(actual_point[0], expected_point[0],
              "color management curve point %d x" % index)
        close(actual_point[1], expected_point[1],
              "color management curve point %d y" % index)


def check_slab(shotlist, environment):
    slab = bpy.data.objects.get("Glass.slab")
    if not slab: die("Glass.slab is missing")
    if slab.parent is not None: die("Glass.slab must be an unparented scene root")
    for actual, wanted in zip(slab.location, (0.0, 0.0, 0.0)): close(actual, wanted, "Glass.slab.location")
    for actual, wanted in zip(slab.scale, (1.0, 1.0, 1.0)): close(actual, wanted, "Glass.slab.scale")
    assert_scene_collection(slab, "Glass.slab")
    close(slab.dimensions.x, float(environment["glass"]["widthM"]), "Glass.slab.width", 2e-4)
    close(slab.dimensions.y, float(environment["glass"]["thicknessM"]), "Glass.slab.thickness", 2e-5)
    close(slab.dimensions.z, float(environment["glass"]["heightM"]), "Glass.slab.height", 2e-4)
    if len(slab.data.materials) != 1 or slab.data.materials[0].name != "Mat.glass":
        die("Glass.slab backing material linkage is wrong")
    for name in ("Glass.cover.front", "Glass.cover.back", "Glass.perimeter", "Glass.traveling-glint"):
        obj = bpy.data.objects.get(name)
        if not obj: die("missing expected glass object " + name)
        if obj.parent != slab: die(name + " must be parented to Glass.slab")
        assert_scene_collection(obj, name)
        if obj.hide_render or obj.hide_viewport or obj.hide_get(): die(name + " is hidden")
    assert_delta_default(slab, "Glass.slab")
    if slab.hide_viewport or slab.hide_get() or slab.hide_render: die("Glass.slab has a visibility override")
    if slab.constraints: die("Glass.slab has unexpected constraints")
    if len(slab.modifiers) != 1 or slab.modifiers[0].name != "Bevel" or slab.modifiers[0].type != "BEVEL":
        die("Glass.slab modifiers must contain exactly the generated Bevel")
    assert_animation_clean(slab, "Glass.slab", {"rotation_euler"})
    curves = all_curves(slab, "rotation_euler")
    if sorted(c.array_index for c in curves) != [0, 1, 2]: die("Glass.slab rotation must have X/Y/Z curves")
    flips = [f for f in shotlist.get("direction", {}).get("flips", []) if isinstance(f, dict)]
    expected_frames = {1, 1200}
    for flip in flips:
        expected_frames.update(range(int(flip["start"]), int(flip["end"]) + 1, 2))
        expected_frames.update((int(flip["start"]), int(flip["end"])))
    expected_frames = sorted(expected_frames)
    tilt = math.radians(float(environment["glass"].get("tiltDegrees", 3.0)))
    for item in curves:
        exact_keys(item, expected_frames, "Glass.slab.rotation_euler[%d]" % item.array_index)
        interpolation(item, "BEZIER", "Glass.slab.rotation_euler")
    values = {1: (tilt, 0.0, 0.0), 1200: (tilt, 0.0, len(flips) * math.pi)}
    for index, flip in enumerate(flips):
        a, b = int(flip["start"]), int(flip["end"])
        for frame in range(a, b + 1, 2):
            t = (frame-a)/float(b-a); s = t*t*t*(t*(t*6-15)+10)
            values[frame] = (tilt, 0.0, index*math.pi + s*math.pi)
        values[a] = (tilt, 0.0, index*math.pi); values[b] = (tilt, 0.0, (index+1)*math.pi)
    for item in curves:
        for frame, value in values.items(): close(item.evaluate(frame), value[item.array_index], "Glass.slab rotation@%d" % frame)


def main():
    parser=argparse.ArgumentParser(); parser.add_argument("--repo",default=None); parser.add_argument("--manifest",default=None); parser.add_argument("--audio",default=None); parser.add_argument("--allow-staged",action="store_true")
    args,_=parser.parse_known_args(sys.argv[sys.argv.index("--")+1:] if "--" in sys.argv else [])
    global ENVIRONMENT, REPO
    repo=os.path.abspath(args.repo or os.path.join(os.path.dirname(__file__),"../../../..")); REPO=repo
    shotlist=read_json(os.path.join(repo,"frontend/scripts/video/film/shotlist.json")); environment=read_json(os.path.join(repo,"frontend/scripts/video/film/environment.json"))
    ENVIRONMENT=environment
    # Validate authored animation against a late saved-frame state as well as
    # its direct F-curves. This prevents a blend's last rendered frame from
    # changing the contract result.
    bpy.context.scene.frame_set(min(1180, int(shotlist.get("format", {}).get("frames", 1200))))
    tracks=check_cursor(repo,shotlist,environment); check_callouts(shotlist,environment); check_floating_highlights(shotlist,environment); check_ui_materials(shotlist); check_color_management(environment); check_slab(shotlist,environment); check_camera(environment, shotlist); dissolves=check_dissolves(shotlist); check_audio(repo, args.manifest, args.allow_staged, args.audio)
    print("scene-contract: PASS (cursorWindows=%d, dissolves=%d, callouts=%d, floatingHighlights=%d, focusWindows=%d)"%(tracks,dissolves,len(shotlist["editorialCallouts"]),len(shotlist.get("floatingHighlights", [])),len(environment["camera"]["focusMoves"])))


if __name__ == "__main__": main()
