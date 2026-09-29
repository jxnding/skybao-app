import unittest
import sys
import types
import hashlib
import importlib.util
import json
from pathlib import Path

# The linkage predicate is deliberately pure, so it can be regression-tested
# without requiring a Blender process.
sys.modules.setdefault("bpy", types.ModuleType("bpy"))
mathutils = types.ModuleType("mathutils")
mathutils.Vector = object
sys.modules.setdefault("mathutils", mathutils)
spec = importlib.util.spec_from_file_location(
    "scene_contract", __file__.replace("test_scene_contract.py", "scene-contract.py"))
scene_contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scene_contract)
_capture_path_is_expected = scene_contract._capture_path_is_expected
_capture_provenance_is_expected = scene_contract._capture_provenance_is_expected
FILM_DIR = Path(__file__).parent
SHOTLIST = json.loads((FILM_DIR / "shotlist.json").read_text())
ENVIRONMENT = json.loads((FILM_DIR / "environment.json").read_text())
sys.path.insert(0, str(FILM_DIR))
from ui_plane_window import ui_plane_render_window


class SceneImageLinkageTests(unittest.TestCase):
    def test_targeted_render_frame_is_a_valid_clip_link(self):
        source = {"type": "clip", "startFrame": 1, "endFrame": 90}
        expected = "/repo/artifacts/skybao-ui/clips/assistant/assistant-research/frame-000001.png"
        actual = "/repo/artifacts/skybao-ui/clips/assistant/assistant-research/frame-000045.png"
        self.assertTrue(_capture_path_is_expected(actual, source, {}, expected))

    def test_swapped_capture_is_rejected_even_when_it_exists(self):
        source = {"type": "clip", "startFrame": 1, "endFrame": 90}
        expected = "/repo/artifacts/skybao-ui/clips/assistant/assistant-research/frame-000001.png"
        swapped = "/repo/artifacts/skybao-ui/clips/knowledge/file-search/frame-000045.png"
        self.assertFalse(_capture_path_is_expected(swapped, source, {}, expected))

    def test_external_and_out_of_trim_capture_are_rejected(self):
        source = {"type": "clip", "startFrame": 1, "endFrame": 90}
        expected = "/repo/artifacts/skybao-ui/clips/assistant/assistant-research/frame-000001.png"
        self.assertFalse(_capture_path_is_expected(
            "/tmp/frame-000045.png", source, {}, expected))
        self.assertFalse(_capture_path_is_expected(
            "/repo/artifacts/skybao-ui/clips/assistant/assistant-research/frame-000091.png",
            source, {}, expected))

    def test_provenance_marker_must_match_connected_bytes(self):
        source = {"type": "clip", "startFrame": 1, "endFrame": 90}
        expected = "/repo/artifacts/skybao-ui/clips/assistant/assistant-research/frame-000001.png"
        actual = "/repo/artifacts/skybao-ui/clips/assistant/assistant-research/frame-000045.png"
        digest = hashlib.sha256(b"capture-a").hexdigest()
        self.assertTrue(_capture_provenance_is_expected(
            actual, actual, digest, digest, source, {}, expected))
        self.assertFalse(_capture_provenance_is_expected(
            actual, actual, digest, hashlib.sha256(b"swapped").hexdigest(),
            source, {}, expected))


class HeroMotionRecipeTests(unittest.TestCase):
    def test_all_ui_caps_use_the_shared_low_brightness_recipe(self):
        glass = ENVIRONMENT["glass"]
        self.assertEqual(glass["uiEmission"], 1.12)
        self.assertEqual(glass["uiTextureGamma"], 1.0)

    def test_penultimate_framing_uses_full_source_without_blender_crop(self):
        camera = ENVIRONMENT["camera"]
        self.assertEqual(camera["lensMM"], 50)
        self.assertNotIn("uiCropScale", ENVIRONMENT["glass"])
        self.assertNotIn("uiCropCenter", ENVIRONMENT["glass"])
        self.assertNotIn("cropOverrides", SHOTLIST)
        self.assertEqual(ENVIRONMENT["toolInputs"]["uiCatalog"], "artifacts/skybao-ui-zoom-150/catalog.json")

    def test_focus_is_penultimate_optical_push(self):
        moves = ENVIRONMENT["camera"]["focusMoves"]
        self.assertEqual([(move["lensStartMM"], move["lensPeakMM"], move["lensEndMM"]) for move in moves],
                         [(50, 54, 50), (50, 55, 50), (50, 53, 50)])
        self.assertEqual([move["targetOffsetM"] for move in moves], [[0.18, 0.08], [-0.16, 0.06], [0.12, 0.04]])

    def test_all_lower_thirds_have_exact_authored_transition(self):
        self.assertEqual(len(SHOTLIST["editorialCallouts"]), 5)
        for callout in SHOTLIST["editorialCallouts"]:
            self.assertEqual(callout["fadeFrames"], 8)
            transition = callout["transition"]
            self.assertEqual(transition["entranceOffsetM"], [0.0, -0.05])
            self.assertEqual(transition["exitOffsetM"], [0.0, 0.05])
            self.assertEqual(transition["startScale"], 0.94)
            self.assertEqual(transition["exitScale"], 0.98)
        self.assertEqual(
            next(item for item in SHOTLIST["editorialCallouts"]
                 if item["group"] == "knowledge")["text"],
            "Unified Knowledge Search")

    def test_floating_highlights_use_authored_semantic_targets(self):
        beats = SHOTLIST["floatingHighlights"]
        self.assertEqual(len(beats), 7)
        self.assertEqual([beat["globalFrame"] for beat in beats[:4]], [11, 35, 59, 83])
        self.assertEqual([beat["targetId"] for beat in beats], [
            "assistant-research-card-0", "assistant-research-card-1",
            "assistant-research-card-2", "assistant-research-card-3",
            "knowledge-file-preview-0", "work-task-approve", "native-tab-users",
        ])
        self.assertEqual([beat["capturePhase"] for beat in beats],
                         ["after-action"] * 4 + ["before-action", "before-action", "after-action"])
        floating = json.loads((FILM_DIR.parents[2] / "src/skybao-design-language.json").read_text())["floatingElement"]
        self.assertEqual(floating["openingExtrusionM"], 0.01)
        self.assertGreater(floating["openingExtrusionM"], floating["extrusionM"])
        self.assertEqual(floating["openingLiftM"], 0.024)
        self.assertGreater(floating["openingLiftM"], floating["liftM"])
        self.assertEqual(
            ENVIRONMENT["toolInputs"]["uiPlaneWindowHelper"],
            "frontend/scripts/video/film/ui_plane_window.py")

    def test_ui_plane_ownership_switches_exactly_at_edge_on(self):
        shots = SHOTLIST["shots"]
        total = SHOTLIST["format"]["frames"]
        dissolve = SHOTLIST["direction"]["sameFaceDissolveFrames"]
        for index, outgoing in enumerate(shots[:-1]):
            incoming = shots[index + 1]
            if outgoing["face"] == incoming["face"]:
                continue
            edge_on = outgoing["transitionOut"]["edgeOn"]
            _, outgoing_end = ui_plane_render_window(shots, index, total, dissolve)
            incoming_start, _ = ui_plane_render_window(shots, index + 1, total, dissolve)
            self.assertEqual(outgoing_end, edge_on - 1)
            self.assertEqual(incoming_start, edge_on)

    @unittest.skipUnless((FILM_DIR.parents[3] / "artifacts/skybao-ui-zoom-150/catalog.json").exists(),
                         "zoom-150 capture package is supplied by the capture worker")
    def test_every_used_cursor_event_is_inside_its_resolved_crop(self):
        repo = FILM_DIR.parents[3]
        catalog_root = repo / ENVIRONMENT["toolInputs"]["uiCatalog"].rsplit("/", 1)[0]
        catalog = json.loads((repo / ENVIRONMENT["toolInputs"]["uiCatalog"]).read_text())
        assets = {(item["type"], item["id"], item.get("framing")): item
                  for item in catalog["assets"]}
        for shot in SHOTLIST["shots"]:
            source = shot["source"]
            if source["type"] != "clip":
                continue
            entry = assets[(source["type"], source["id"], source.get("framing"))]
            timeline = json.loads((catalog_root / entry["timeline"]).read_text())
            crop = {"scale": [1.0, 1.0], "center": [0.5, 0.5]}
            for event in timeline.get("cursor", []):
                if not source["startFrame"] - 1 <= event["frame"] <= source["endFrame"] - 1:
                    continue
                for axis, key in enumerate(("nx", "ny")):
                    self.assertGreaterEqual(event[key], crop["center"][axis] - crop["scale"][axis] / 2, shot["id"])
                    self.assertLessEqual(event[key], crop["center"][axis] + crop["scale"][axis] / 2, shot["id"])


if __name__ == "__main__":
    unittest.main()
