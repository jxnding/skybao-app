"""Small, Blender-independent cursor window primitives."""


def event_for_frame(items, frame):
    """Return the latest event at/before *frame*, or the lead-in event.

    Cursor activity windows intentionally include padding before their first
    captured event.  A valid window therefore always has a position, and the
    position must remain monotonic through sparse samples and clicks.
    """
    ordered = sorted(items, key=lambda item: item[0])
    if not ordered:
        return None
    return next((event for event_frame, event in reversed(ordered)
                 if event_frame <= frame), ordered[0][1])
