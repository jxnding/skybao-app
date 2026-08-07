import unittest
import sys
import types
import hashlib
import importlib.util

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


if __name__ == "__main__":
    unittest.main()
