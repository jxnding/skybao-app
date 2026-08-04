import bpy, os, json
sc = bpy.data.scenes.new('sh')
sc.render.fps = 30; sc.render.fps_base = 1.0
sc.sequence_editor_create()
se = sc.sequence_editor
wm = bpy.data.window_managers[0]; win = wm.windows[0]; scr = win.screen
area = scr.areas[0]; area.type = 'SEQUENCE_EDITOR'
win.scene = sc
region = next((r for r in area.regions if r.type == 'WINDOW'), None)

def log(tag, fn):
    try:
        return tag + ': ' + str(fn())
    except Exception as e:
        return tag + ': ERR ' + str(e)

print('ops:', [o for o in dir(bpy.ops.sequencer) if 'strip' in o or 'channel' in o])

with bpy.context.temp_override(window=win, screen=scr, area=area, region=region):
    print('scene is sc:', bpy.context.scene == sc)
    print('scene.ed exists:', bpy.context.scene.sequence_editor is not None)
    print('space:', bpy.context.area.spaces.active.type)
    print('win.scene is sc:', bpy.context.window.scene == sc)
    r = bpy.ops.sequencer.image_strip_add(
        directory='/Users/ding/Projects/anything-llm/artifacts/skybao-ui/clips/assistant/assistant-research/',
        files=[{'name': 'frame-000001.png'}], frame_start=1, channel=2)
    print('image_strip_add:', r)
print('strips:', [(s.name, s.type, s.channel) for s in se.strips])

print('channel collection:', [ (c.name, c.type) for c in se.channels ])
print('SequenceTimelineChannel props:', [p.identifier for p in bpy.types.SequenceTimelineChannel.bl_rna.properties])

# text strip op name?
import inspect
print('text ops:', [o for o in dir(bpy.ops.sequencer) if 'text' in o or 'Text' in o])