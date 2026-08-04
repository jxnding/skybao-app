import bpy, os, json

SCENE = 'sh'
A = '/Users/ding/Projects/anything-llm/artifacts/skybao-ui'
IMG = A + '/clips/assistant/assistant-research/frame-000001.png'
OUT = '/Users/ding/Projects/anything-llm/artifacts/skybao-film/probe/out.blend'

sc = bpy.data.scenes.new(SCENE)
sc.render.fps = 30
sc.render.fps_base = 1.0
sc.render.resolution_x = 1920
sc.render.resolution_y = 1080
sc.sequence_editor_create()
se = sc.sequence_editor

result = {}

# Helper: build a temp_override context pointing at a real window/area
def seq_ctx():
    wm = bpy.data.window_managers[0]
    win = wm.windows[0]
    scr = win.screen
    area = None
    for a in scr.areas:
        if a.type == 'SEQUENCE_EDITOR':
            area = a; break
    if area is None:
        area = scr.areas[0]
        area.type = 'SEQUENCE_EDITOR'   # note the 5.x rename
    region = None
    for r in area.regions:
        if r.type == 'WINDOW':
            region = r; break
    return (win, scr, area, region), {"window": win, "screen": scr, "area": area, "region": region, "scene": sc}

cproc, ctx = seq_ctx()

def ctx_ok():
    return bpy.context.temp_override(**ctx)

with ctx_ok():
    try:
        res = bpy.ops.sequencer.image_strip_add(directory=os.path.dirname(IMG)+'/',
                                                files=[{'name':'frame-000001.png'}],
                                                frame_start=1, channel=2)
        result['image_strip_add'] = 'OK: %s' % (res,)
    except Exception as e:
        result['image_strip_add'] = 'ERR: %s' % (e,)
    img = se.strips[0] if len(se.strips) else None
    result['strips_after_img'] = [s.name + ':' + s.type for s in se.strips]

# text strip
with ctx_ok():
    try:
        res = bpy.ops.sequencer.text_strip_add(frame_start=120, channel=5)
        result['text_strip_add'] = 'OK' if not res.get(chic) else None
    except Exception:
        with ctx_ok():
            try:
                res = bpy.ops.sequencer.text_strip_add(frame_start=120, channel=5)
                result['text_strip_add'] = 'OK'
            except Exception as e:
                result['text_strip_add'] = 'ERR %s' % e
print('strips now:', [(s.name, s.type, s.channel, s.frame_start) for s in se.strips])
# find text strip
print('text strip?', [s for s in se.strips if s.type in ('TEXT_PLACEHOLDER','TEXT') or s.type=='Text'])
result['strip_types'] = [s.type for s in se.strips]

# channel count
try:
    result['channels'] = sorted(ch_channel for ch_channel in [c.channel for c in se.channels])
except Exception as e:
    result['channels_err'] = str(e)

# keyframing
try:
    if img:
        img.blend_alpha = 0.0
        img.keyframe_insert(data_path='blend_alpha', frame=1)
        img.blend_alpha = 1.0
        img.keyframe_insert(data_path='blend_alpha', frame=10)
        img.transform.offset_x = 0
        img.keyframe_insert(data_path='transform.offset_x', frame=1)
        img.transform.offset_x = 300
        img.keyframe_insert(data_path='transform.offset_x', frame=10)
        act = img.animation_data.action
        result['fcurves'] = [f.data_path for f in act.fcurves] if act else []
        fcu = act.fcurves.find('transform.offset_x')
        kp = fcu.keyframe_points[1]
        kp.interpolation = 'BEZIER'
        kp.easing = 'EASE_IN_OUT'
        result['easing'] = (kp.interpolation, kp.easing)
except Exception as e:
    result['keyframe_err'] = str(e)

# sound strip (dummy wav)
wav = '/Users/ding/Projects/anything-llm/artifacts/skybao-film/probe/tone.wav'
try:
    with ctx_ok():
        res = bpy.ops.sequencer.sound_strip_add(filepath='/Users/ding/Projects/anything-llm/artifacts/skybao-ui/cursor/cursor.svg', frame_start=1, channel=1)
        result['sound_strip_add'] = 'OK'
except Exception as e:
    result['sound_strip_add'] = 'ERR: %s' % e

# save as mainfile
bpy.context.window.scene = sc
try:
    bpy.ops.wm.save_as_mainfile(filepath=OUT)
    result['save'] = 'OK'
except Exception as e:
    result['save'] = 'ERR %s' % e

print(json.dumps(result, indent=2))