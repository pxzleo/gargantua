#!/usr/bin/env python3
"""Render a GARGANTUA frame through the URL automation interface.

usage: python3 tests/shoot.py "<query string>" out.png [width height] [--base URL]
example: python3 tests/shoot.py "preset=1&quality=high" shots/edge.png 1280 720
"""
import sys
from playwright.sync_api import sync_playwright

from harness import launch, BASE


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    query, out = args[0], args[1]
    w = int(args[2]) if len(args) > 2 else 1280
    h = int(args[3]) if len(args) > 3 else 720
    with sync_playwright() as pw:
        browser = launch(pw)
        page = browser.new_page(viewport={'width': w, 'height': h})
        logs = []
        page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
        page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
        page.goto(f'{BASE}/?automation=1&{query}')
        page.wait_for_function('document.documentElement.dataset.ready === "1"', timeout=180000)
        page.evaluate('GARGANTUA.renderFrames(2)')
        page.screenshot(path=out, timeout=240000)
        for l in logs:
            print(l)
        browser.close()


if __name__ == '__main__':
    main()
