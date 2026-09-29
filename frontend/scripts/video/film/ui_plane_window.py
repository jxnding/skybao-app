"""Blender-independent visibility windows for SkyBao film UI planes."""


def ui_plane_render_window(shots, index, total_frames, dissolve_frames):
    """Return the inclusive visibility window for one authored UI plane.

    Same-face edits overlap for their short dissolve. During a physical slab
    flip, ownership instead changes exactly at ``edgeOn``: the outgoing face is
    hidden one frame earlier and the incoming face becomes active at edge-on.
    The slab has zero projected width at that instant, so this avoids both a
    visible reverse-side ghost and a blank emerging face.
    """
    shot = shots[index]
    previous = shots[index - 1] if index > 0 else None
    following = shots[index + 1] if index + 1 < len(shots) else None
    face = shot.get("face", "front")
    flip_in = previous is not None and previous.get("face", "front") != face
    flip_out = following is not None and following.get("face", "front") != face
    dissolve_out = bool(
        following
        and following.get("transitionIn", {}).get("type") == "same-face-dissolve"
    )

    render_start = int(shot["frames"]["start"])
    render_end = int(shot["frames"]["end"])
    if flip_in:
        transition = previous.get("transitionOut", {})
        if transition.get("type") != "area-flip" or "edgeOn" not in transition:
            raise ValueError("incoming face change requires transitionOut.edgeOn")
        render_start = int(transition["edgeOn"])
    if flip_out:
        transition = shot.get("transitionOut", {})
        if transition.get("type") != "area-flip" or "edgeOn" not in transition:
            raise ValueError("outgoing face change requires transitionOut.edgeOn")
        render_end = int(transition["edgeOn"]) - 1
    elif dissolve_out:
        render_end += int(dissolve_frames)

    render_start = max(1, render_start)
    render_end = min(int(total_frames), render_end)
    if render_start > render_end:
        raise ValueError("UI plane visibility window is empty")
    return render_start, render_end
