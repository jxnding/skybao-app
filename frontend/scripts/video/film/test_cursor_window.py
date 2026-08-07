import unittest

from cursor_window import event_for_frame


class CursorWindowTests(unittest.TestCase):
    def test_lead_in_frame_163_uses_first_event(self):
        items = [(164, {"nx": 0.2}), (168, {"nx": 0.8})]
        self.assertEqual(event_for_frame(items, 163)["nx"], 0.2)

    def test_post_navigation_click_holds_latest_position(self):
        items = [(220, {"nx": 0.2}), (224, {"event": "click", "nx": 0.8})]
        self.assertEqual(event_for_frame(items, 228)["nx"], 0.8)


if __name__ == "__main__":
    unittest.main()
