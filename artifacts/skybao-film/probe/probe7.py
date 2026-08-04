import bpy, sys
sys.stdout.reconfigure(line_buffering=True)
sc = bpy.context.scene
sc.sequence_editor_create()
wm = bpy.data.window_managers[0]; win = wm.windows[0]; scr = win.screen
area = scr.areas[0]; area.type = 'SEQUENCE_EDITOR'
win.scene = sc
region = next((r for r in area.regions if r.type == 'WINDOW'), None)
print('region found:', region, flush=True)
with bpy.context.temp_override(window=win, screen=scr, area=area, region=region):
    print('in override: area=', bpy.context.area, 'type=', bpy.context.area.type if bpy.context.area else None, flush=True)
    print('in override: region=', bpy.context.region, flush=True)
    print('in override: space=', bpy.context.space_data.type if bpy.context.space_data else None, flush=True)
    print('in override: view_layer=', bpy.context.view_layer, flush=True)
    try:
        r = bpy.ops.sequencer.image_strip_add(
            directory='/Users/ding/Projects/anything-llm/artifacts/skybao-ui/clips/assistant/assistant-research/',
            files=[{'name': 'frame-000001.png'}], frame_start=1, channel=2)
        print('OK', r, flush=True)
    except Exception as e:
        print('ERR', e, flush=True)
print('DONE', flush=True)