"""Shared Playwright launch settings (headless Chromium with a WebGL2-capable GL backend)."""
import os

BASE = os.environ.get('GARGANTUA_URL', 'http://localhost:8080')

ARGS = [
    '--use-angle=swiftshader',          # software GL works on GPU-less CI; real GPUs are much faster
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--autoplay-policy=no-user-gesture-required',
]


def launch(pw, headless=True):
    exe = os.environ.get('CHROMIUM_PATH')
    kw = {'headless': headless, 'args': ARGS}
    if exe:
        kw['executable_path'] = exe
    return pw.chromium.launch(**kw)
