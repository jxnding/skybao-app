import bpy, sys
sys.stdout.reconfigure(line_buffering=True)
sc = bpy.context.scene          # the default startup scene, already active in window
win = bpy.data.window_managers[0].windows[0]
print('win.scene', win.scene.name, 'ctx.scene', bpy.context.scene.name, flush=True)
win.scene = sc
sc.sequence_editor_create()
se = sc.sequence_editor
scr = win.screen
area = scr.areas[0]; area.type = 'SEQUENCE_EDITOR'
region = next((r for r in area.regions if r.type == 'WINDOW'), None)

with bpy.context.temp_override(window=win, screen=scr, area=area, region=region):
    print('ctx.scene==sc:', bpy.context.scene == sc, 'ed:', sc.sequence_editor is not None, flush=True)
    try:
        r = bpy.ops.sequencer.image_strip_add(
            directory='/Users/ding/Projects/anything-llm/artifacts/skybao-ui/clips/assistant/assistant-research/',
            files=[{'name': 'frame-000001.png'}], frame_start=1, channel=2)
        print('OK', r, flush=True)
    except Exception as e:
        print('ERR', e, flush=True)
print('strips:', [s.type for s in se.strips], flush=True)
try:
    sc.sequence_editor_override and print('override')
except Exception as e:
    print('no override prop', flush=True)
print('DONE', flush=True)