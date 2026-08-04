import bpy, sys
sys.stdout.reconfigure(line_buffering=True)
print('context area:', bpy.context.area.type if bpy.context.area else None, flush=True)
print('context region:', getattr(bpy.context,'region',None), flush=True)
print('context window:', bpy.context.window, flush=True)
sc = bpy.context.scene
sc.sequence_editor_create()
win = bpy.data.window_managers[0].windows[0]
scr = win.screen
area = scr.areas[0]
area.type = 'SEQUENCE_EDITOR'
win.scene = sc
print('after set, context area:', bpy.context.area.type if bpy.context.area else None, flush=True)
# try without temp_override, directly
try:
    r = bpy.ops.sequencer.image_strip_add(
        directory='/Users/ding/Projects/anything-llm/artifacts/skybao-ui/clips/assistant/assistant-research/',
        files=[{'name': 'frame-000001.png'}], frame_start=1, channel=2)
    print('direct OK', r, flush=True)
except Exception as e:
    print('direct ERR', e, flush=True)
print('strips:', [s.type for s in sc.sequence_editor.strips], flush=True)