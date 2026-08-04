import bpy, json
sc = bpy.data.scenes.new('sh')
sc.render.fps = 30; sc.render.fps_base = 1.0
sc.sequence_editor_create()
se = sc.sequence_editor
wm = bpy.data.window_managers[0]; win = wm.windows[0]; scr = win.screen
area = scr.areas[0]; area.type = 'SEQUENCE_EDITOR'
win.scene = sc
region = next((r for r in area.regions if r.type == 'WINDOW'), None)

print('channel coll methods:', [m for m in dir(se.channels) if not m.startswith('_')])
print('channel item props:', [p.identifier for p in bpy.types.SequenceTimelineChannel.bl_rna.properties])
print('effect_strip_add type enum:', [e.identifier for e in bpy.ops.sequencer.effect_strip_add.get_rna_type().properties['type'].enum_items])

with bpy.context.temp_override(window=win, screen=scr, area=area, region=region):
    sp = bpy.context.area.spaces.active
    print('space type:', sp.type)
    if hasattr(sp, 'scene'):
        sp.scene = sc
        print('space.scene set to sc; space.scene.ed:', sp.scene.sequence_editor is not None)
    r = bpy.ops.sequencer.image_strip_add(
        directory='/Users/ding/Projects/anything-llm/artifacts/skybao-ui/clips/assistant/assistant-research/',
        files=[{'name': 'frame-000001.png'}], frame_start=1, channel=2)
    print('image_strip_add:', r)
print('strips:', [(s.name, s.type, s.channel) for s in se.strips])

with bpy.context.temp_override(window=win, screen=scr, area=area, region=region):
    try:
        r = bpy.ops.sequencer.effect_strip_add(frame_start=100, channel=6, type='TEXT')
        print('effect_strip_add TEXT:', r)
    except Exception as e:
        print('effect TEXT ERR:', e)
print('strips2:', [(s.name, s.type, s.channel) for s in se.strips])