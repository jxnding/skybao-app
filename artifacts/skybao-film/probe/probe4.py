import bpy, json, sys
sys.stdout.reconfigure(line_buffering=True)
sc = bpy.data.scenes.new('sh')
sc.render.fps = 30; sc.render.fps_base = 1.0
sc.sequence_editor_create()
se = sc.sequence_editor
wm = bpy.data.window_managers[0]; win = wm.windows[0]; scr = win.screen
area = scr.areas[0]; area.type = 'SEQUENCE_EDITOR'
win.scene = sc
region = next((r for r in area.regions if r.type == 'WINDOW'), None)

print('SpaceSequenceEditor has scene attr:', 'scene' in dir(bpy.types.SpaceSequenceEditor), flush=True)
sp = area.spaces.active
print('sp has scene:', hasattr(sp, 'scene'), flush=True)
if hasattr(sp, 'scene'):
    sp.scene = sc
    print('set space.scene = sc; ed exists:', sp.scene.sequence_editor is not None, flush=True)

with bpy.context.temp_override(window=win, screen=scr, area=area, region=region):
    sp2 = bpy.context.area.spaces.active
    print('in ctx: context.scene==sc:', bpy.context.scene == sc, flush=True)
    print('in ctx: space.scene is sc:', getattr(sp2, 'scene', None) == sc, flush=True)
    try:
        r = bpy.ops.sequencer.image_strip_add(
            directory='/Users/ding/Projects/anything-llm/artifacts/skybao-ui/clips/assistant/assistant-research/',
            files=[{'name': 'frame-000001.png'}], frame_start=1, channel=2)
        print('image_strip_add OK:', r, flush=True)
    except Exception as e:
        print('image_strip_add ERR:', e, flush=True)
print('strips:', [(s.name, s.type, s.channel) for s in se.strips], flush=True)

with bpy.context.temp_override(window=win, screen=scr, area=area, region=region):
    try:
        r = bpy.ops.sequencer.effect_strip_add(frame_start=100, channel=6, type='TEXT')
        print('effect_strip_add TEXT OK:', r, flush=True)
    except Exception as e:
        print('effect TEXT ERR:', e, flush=True)
print('strips2:', [(s.name, s.type, s.channel, getattr(s,'text',None)) for s in se.strips], flush=True)
print('DONE', flush=True)