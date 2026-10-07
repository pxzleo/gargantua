#!/usr/bin/env python3
"""Render many views in one browser session via the JS automation API.

usage: python3 tests/batch_shots.py outdir [width height] [quality] [extra-query]
Produces preset-1..4.png, debug-1..9.png (preset 1) and a contact sheet.
"""
import os
import sys

from PIL import Image
from playwright.sync_api import sync_playwright

from harness import launch, BASE

FRAMES = int(os.environ.get('FRAMES', '8'))


def main():
    out = sys.argv[1]
    w = int(sys.argv[2]) if len(sys.argv) > 2 else 960
    h = int(sys.argv[3]) if len(sys.argv) > 3 else 540
    q = sys.argv[4] if len(sys.argv) > 4 else 'standard'
    extra = sys.argv[5] if len(sys.argv) > 5 else ''
    only = os.environ.get('ONLY', 'presets,debug').split(',')
    os.makedirs(out, exist_ok=True)
    files = []
    with sync_playwright() as pw:
        b = launch(pw)
        page = b.new_page(viewport={'width': w, 'height': h})
        page.set_default_timeout(240000)
        logs = []
        page.on('console', lambda m: logs.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
        page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
        page.goto(f'{BASE}/?automation=1&ui=0&quality={q}&t=40&{extra}')
        page.wait_for_function('document.documentElement.dataset.ready === "1"', timeout=240000)
        if 'presets' in only:
            for n in [int(x) for x in os.environ.get('PRESETS', '1,2,3,4').split(',')]:
                page.evaluate(f'GARGANTUA.setPreset({n}, true)')
                page.evaluate(f"GARGANTUA.renderFrames({FRAMES})")
                f = os.path.join(out, f'preset-{n}.png')
                page.screenshot(path=f, timeout=240000)
                files.append(f)
        if 'debug' in only:
            page.evaluate('GARGANTUA.setPreset(1, true)')
            for d in range(1, 10):
                page.evaluate(f'GARGANTUA.setDebug({d})')
                page.evaluate(f"GARGANTUA.renderFrames({FRAMES})")
                f = os.path.join(out, f'debug-{d}.png')
                page.screenshot(path=f, timeout=240000)
                files.append(f)
            page.evaluate('GARGANTUA.setDebug(0)')
        for l in logs:
            print(l)
        b.close()
    # contact sheet
    ims = [Image.open(f) for f in files]
    cols = 2
    tw, th = w // 2, h // 2
    rows = (len(ims) + cols - 1) // cols
    sheet = Image.new('RGB', (tw * cols, th * rows))
    for i, im in enumerate(ims):
        sheet.paste(im.resize((tw, th)), ((i % cols) * tw, (i // cols) * th))
    sheet.save(os.path.join(out, 'sheet.png'))
    print('ok', len(files))


if __name__ == '__main__':
    main()
