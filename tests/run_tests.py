#!/usr/bin/env python3
"""GARGANTUA acceptance tests (headless Chromium via Playwright).

Start the server first:  node serve.mjs 8080
Run:                     python3 tests/run_tests.py [outdir]

Writes screenshots + results.json + RESULTS.md into outdir (default tests/results).
"""
import io
import json
import os
import sys
import time
import traceback

from PIL import Image, ImageStat
from playwright.sync_api import sync_playwright

from harness import launch, BASE

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), 'results')
os.makedirs(OUT, exist_ok=True)
W, H = 800, 450
results = []
console_errors = []


def record(name, ok, detail=''):
    results.append({'name': name, 'ok': bool(ok), 'detail': detail})
    print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''), flush=True)


def check(name, fn):
    try:
        ok, detail = fn()
        record(name, ok, detail)
    except Exception as e:  # noqa
        record(name, False, f'{type(e).__name__}: {e}')
        traceback.print_exc()


def watch(page, tag):
    page.on('console', lambda m: console_errors.append(f'[{tag}] {m.type}: {m.text}') if m.type == 'error' else None)
    page.on('pageerror', lambda e: console_errors.append(f'[{tag}] pageerror: {e}'))


def img_stats(png_bytes):
    im = Image.open(io.BytesIO(png_bytes)).convert('L')
    w, h = im.size
    full = ImageStat.Stat(im)
    centre = im.crop((int(w * 0.47), int(h * 0.40), int(w * 0.53), int(h * 0.47)))
    return {
        'mean': round(full.mean[0], 2), 'std': round(full.stddev[0], 2), 'max': max(im.getextrema()),
        'centre_mean': round(ImageStat.Stat(centre).mean[0], 2),
        'bright_frac': round(sum(1 for p in im.getdata() if p > 200) / (w * h), 4),
    }


def shot(page, name):
    b = page.screenshot(timeout=240000)
    with open(os.path.join(OUT, name), 'wb') as f:
        f.write(b)
    return b


def new_page(browser, tag, query, viewport=None, **ctx):
    context = browser.new_context(viewport=viewport or {'width': W, 'height': H}, accept_downloads=True, **ctx)
    page = context.new_page()
    page.set_default_timeout(240000)
    watch(page, tag)
    page.goto(f'{BASE}/{query}')
    page.wait_for_function('document.documentElement.dataset.ready === "1"', timeout=240000)
    return context, page


def main():
    t0 = time.time()
    with sync_playwright() as pw:
        browser = launch(pw)

        # ---------------------------------------------------------- 1. automation views
        ctx, page = new_page(browser, 'auto', '?automation=1&ui=0&quality=standard&t=40')

        def presets():
            det = []
            ok = True
            for n in range(1, 5):
                page.evaluate(f'GARGANTUA.setPreset({n}, true)')
                page.evaluate('GARGANTUA.renderFrames(6)')
                s = img_stats(shot(page, f'preset-{n}.png'))
                det.append(f'P{n} max={s["max"]} mean={s["mean"]} std={s["std"]} centre={s["centre_mean"]} bright={s["bright_frac"]}')
                # not black, has structure, black-hole centre stays dark, disk is bright
                ok &= s['mean'] > 8 and s['std'] > 12 and s['max'] >= 200 and s['centre_mean'] < 20
            return ok, '; '.join(det)
        check('四个视角预设渲染（非黑屏 / 中心阴影深黑 / 盘面高亮）', presets)

        def debug_views():
            page.evaluate('GARGANTUA.setPreset(1, true)')
            det, ok = [], True
            for d in range(10):
                page.evaluate(f'GARGANTUA.setDebug({d})')
                page.evaluate('GARGANTUA.renderFrames(3)')
                s = img_stats(shot(page, f'debug-{d}.png'))
                det.append(f'{d}:{s["mean"]}/{s["std"]}')
                ok &= s['std'] > 4 and s['max'] > 60
            page.evaluate('GARGANTUA.setDebug(0)')
            return ok, ' '.join(det)
        check('0–9 调试视图均有有效输出', debug_views)

        def time_anim():
            page.evaluate('GARGANTUA.setPreset(3, true)')
            page.evaluate('GARGANTUA.setTime(0)'); page.evaluate('GARGANTUA.renderFrames(4)')
            a = Image.open(io.BytesIO(page.screenshot())).convert('L')
            page.evaluate('GARGANTUA.setTime(60)'); page.evaluate('GARGANTUA.renderFrames(4)')
            b = Image.open(io.BytesIO(page.screenshot())).convert('L')
            diff = sum(abs(x - y) for x, y in zip(a.getdata(), b.getdata())) / (a.size[0] * a.size[1])
            return diff > 1.0, f'mean |Δ| = {diff:.2f}'
        check('盘面湍流随时间演化（t=0 vs t=60 画面不同）', time_anim)

        def params_effect():
            page.evaluate('GARGANTUA.setPreset(2, true)'); page.evaluate('GARGANTUA.renderFrames(3)')
            a = img_stats(page.screenshot())
            page.evaluate('GARGANTUA.setParams({doppler: 0, redshift: 0})'); page.evaluate('GARGANTUA.renderFrames(3)')
            b = img_stats(page.screenshot())
            st = page.evaluate('GARGANTUA.getState().params')
            page.evaluate('GARGANTUA.setParams({doppler: 1, redshift: 1})')
            return st['doppler'] == 0 and abs(a['mean'] - b['mean']) > 0.5, f'mean {a["mean"]} → {b["mean"]}'
        check('参数接口生效（关闭 Doppler/红移改变画面）', params_effect)

        def qualities():
            det, ok = [], True
            for q in ['standard', 'high', 'cinematic']:
                r = page.evaluate(f'GARGANTUA.setQuality("{q}")')
                page.evaluate('GARGANTUA.renderFrames(1)')
                st = page.evaluate('GARGANTUA.getState()')
                det.append(f'{q}:{r} rt={st["size"]["rw"]}x{st["size"]["rh"]}')
                ok &= r is True and st['quality'] == q
            page.evaluate('GARGANTUA.setQuality("standard")')
            return ok, ', '.join(det)
        check('三档画质着色器编译切换 Standard/High/Cinematic', qualities)

        def capture_api():
            d = page.evaluate('GARGANTUA.capture()')
            return d.startswith('data:image/png') and len(d) > 20000, f'{len(d)} chars'
        check('capture() 截图接口返回 PNG', capture_api)

        def context_loss():
            ok = page.evaluate('GARGANTUA.simulateContextLoss(800)')
            time.sleep(0.3)
            lost = page.evaluate('GARGANTUA.getState().contextLost')
            ov = page.evaluate('getComputedStyle(document.getElementById("overlay")).opacity')
            page.wait_for_function('!GARGANTUA.getState().contextLost', timeout=60000)
            page.evaluate('GARGANTUA.setPreset(1, true)')
            page.evaluate('GARGANTUA.renderFrames(4)')
            s = img_stats(shot(page, 'after-context-restore.png'))
            return ok and lost and s['std'] > 12, f'lost={lost} overlay_opacity={ov} after: mean={s["mean"]} std={s["std"]}'
        check('WebGL 上下文丢失 → 自动恢复并继续渲染', context_loss)

        def hard_reset():
            page.evaluate('GARGANTUA.simulateContextLoss(-1)')
            time.sleep(0.3)
            lost = page.evaluate('GARGANTUA.getState().contextLost')
            page.wait_for_function('!GARGANTUA.getState().contextLost', timeout=120000)
            page.evaluate('GARGANTUA.renderFrames(4)')
            s = img_stats(shot(page, 'after-hard-reset.png'))
            n = page.evaluate('document.querySelectorAll("canvas").length')
            return lost and s['std'] > 12 and n == 1, f'lost={lost} → 新画布重建, canvases={n}, mean={s["mean"]} std={s["std"]}'
        check('上下文永久丢失 → 4 秒后替换画布并重建渲染器', hard_reset)
        ctx.close()

        # ---------------------------------------------------------- 2. URL interface
        ctx, page = new_page(browser, 'url', '?automation=1&quality=standard&cam=24,12,40,50&debug=3&p_diskOuter=40&p_temperature=6000&t=12&frames=3')
        def url_iface():
            st = page.evaluate('GARGANTUA.getState()')
            p = st['pose']
            ok = (abs(p['dist'] - 24) < 0.01 and abs(p['elev'] - 12) < 0.01 and st['debug'] == 3
                  and st['params']['diskOuter'] == 40 and st['params']['temperature'] == 6000
                  and abs(st['time'] - 12) < 1e-6 and st['paused'] and not st['cinematic'])
            shot(page, 'url-interface.png')
            return ok, json.dumps({'pose': {k: round(v, 2) for k, v in p.items()}, 'debug': st['debug']})
        check('URL 自动化参数（cam/debug/p_*/t/quality）', url_iface)
        def share_link():
            link = page.evaluate('GARGANTUA.shareLink()')
            return 'p_diskOuter=40' in link and 'cam=' in link, link
        check('分享链接包含当前参数', share_link)
        ctx.close()

        # ---------------------------------------------------------- 3. interactive mode
        ctx, page = new_page(browser, 'live', '?clean=1&quality=standard')
        def cinematic_runs():
            a = page.evaluate('GARGANTUA.getState()')
            page.wait_for_function(f'GARGANTUA.getState().frame > {a["frame"]} + 3', timeout=180000)
            b = page.evaluate('GARGANTUA.getState()')
            moved = abs(a['pose']['az'] - b['pose']['az']) > 0.2 or abs(a['pose']['dist'] - b['pose']['dist']) > 0.05
            shot(page, 'live-ui.png')
            return a['cinematic'] and moved and b['frame'] > a['frame'], f'az {a["pose"]["az"]:.2f}→{b["pose"]["az"]:.2f}, frames {a["frame"]}→{b["frame"]}'
        check('默认电影镜头循环运动 + 实时帧循环', cinematic_runs)

        def drag_orbit():
            before = page.evaluate('GARGANTUA.getState().pose')
            page.mouse.move(W / 2, H / 2); page.mouse.down()
            for i in range(10):
                page.mouse.move(W / 2 + 18 * i, H / 2 + 4 * i)
            page.mouse.up()
            page.wait_for_function(f'Math.abs(GARGANTUA.getState().pose.az - ({before["az"]})) > 2', timeout=180000)
            st = page.evaluate('GARGANTUA.getState()')
            return (not st['cinematic']) and abs(st['pose']['az'] - before['az']) > 2, f'cine={st["cinematic"]} az {before["az"]:.1f}→{st["pose"]["az"]:.1f}'
        check('鼠标拖拽 OrbitControls 环绕并接管电影镜头', drag_orbit)

        def wheel_zoom():
            d0 = page.evaluate('GARGANTUA.getState().pose.dist')
            page.mouse.move(W / 2, H / 2)
            for _ in range(5):
                page.mouse.wheel(0, -300); time.sleep(0.1)
            page.wait_for_function(f'GARGANTUA.getState().pose.dist < {d0} - 0.5', timeout=180000)
            d1 = page.evaluate('GARGANTUA.getState().pose.dist')
            return d1 < d0 - 0.5 and d1 >= 7.49, f'dist {d0:.2f}→{d1:.2f}'
        check('滚轮推近（最小距离受限）', wheel_zoom)

        def keys():
            det, ok = [], True
            page.keyboard.press('Digit5'); ok &= page.evaluate('GARGANTUA.getState().debug') == 5; det.append('5→debug5')
            page.keyboard.press('Digit0'); ok &= page.evaluate('GARGANTUA.getState().debug') == 0
            page.keyboard.press('Shift+Digit3')
            page.wait_for_function('Math.abs(GARGANTUA.getState().pose.elev - 80) < 1', timeout=180000)
            el = page.evaluate('GARGANTUA.getState().pose.elev'); ok &= abs(el - 80) < 1; det.append(f'Shift+3→elev {el:.1f}')
            page.keyboard.press('c'); c1 = page.evaluate('GARGANTUA.getState().cinematic')
            page.keyboard.press('c'); c2 = page.evaluate('GARGANTUA.getState().cinematic'); ok &= c1 and not c2; det.append(f'C {c1}/{c2}')
            p0 = page.evaluate('GARGANTUA.getState().paused'); page.keyboard.press('Space')
            p1 = page.evaluate('GARGANTUA.getState().paused'); ok &= p0 != p1; page.keyboard.press('Space'); det.append('Space ok' if p0 != p1 else 'Space FAIL')
            page.keyboard.press('p'); ok &= page.evaluate('document.getElementById("panel").classList.contains("open")'); det.append('P panel')
            page.keyboard.press('h'); ok &= page.evaluate('document.body.classList.contains("ui-hidden")')
            page.keyboard.press('h'); ok &= not page.evaluate('document.body.classList.contains("ui-hidden")'); det.append('H ui')
            page.keyboard.press('Shift+Slash'); ok &= page.evaluate('!document.getElementById("help").hidden'); det.append('? help')
            shot(page, 'help.png')
            page.keyboard.press('Escape'); ok &= page.evaluate('document.getElementById("help").hidden')
            q0 = page.evaluate('GARGANTUA.getState().quality'); page.keyboard.press('q')
            page.wait_for_function(f'GARGANTUA.getState().quality !== "{q0}"', timeout=180000)
            q1 = page.evaluate('GARGANTUA.getState().quality'); ok &= q0 != q1; det.append(f'Q {q0}→{q1}')
            page.evaluate('GARGANTUA.setQuality("standard")')
            return ok, ', '.join(det)
        check('快捷键 0–9 / Shift+1–4 / C / Space / P / H / ? / Esc / Q', keys)

        def slider_and_persist():
            page.keyboard.press('p') if not page.evaluate('document.getElementById("panel").classList.contains("open")') else None
            page.evaluate("""() => { const i = document.getElementById('p-diskOuter'); i.value = 44; i.dispatchEvent(new Event('input', {bubbles:true})); }""")
            v = page.evaluate('GARGANTUA.getState().params.diskOuter')
            shot(page, 'panel.png')
            # reset key
            page.evaluate("""() => { const i = document.getElementById('p-grain'); i.value = 0.8; i.dispatchEvent(new Event('input', {bubbles:true})); }""")
            page.keyboard.press('r')
            g = page.evaluate('GARGANTUA.getState().params.grain')
            return v == 44 and abs(g - 0.35) < 1e-9, f'diskOuter={v}, grain after R={g}'
        check('参数滑块 + R 重置', slider_and_persist)

        def downloads():
            with page.expect_download(timeout=120000) as dl:
                page.keyboard.press('s')
            d = dl.value
            path = os.path.join(OUT, 'download-' + d.suggested_filename)
            d.save_as(path)
            return os.path.getsize(path) > 20000, f'{d.suggested_filename} {os.path.getsize(path)} bytes'
        check('S 键保存 PNG 截图', downloads)

        def music():
            page.click('#b-music'); time.sleep(1.5)
            st = page.evaluate('document.getElementById("b-music").getAttribute("aria-pressed")')
            return st == 'true', f'aria-pressed={st}'
        check('氛围音乐开关（Web Audio 渐入播放）', music)
        ctx.close()

        # persistence across reloads (non-clean)
        def persistence():
            c = browser.new_context(viewport={'width': W, 'height': H})
            p = c.new_page(); p.set_default_timeout(240000); watch(p, 'persist')
            p.goto(f'{BASE}/?quality=standard'); p.wait_for_function('document.documentElement.dataset.ready === "1"')
            p.evaluate('GARGANTUA.setParams({diskOuter: 38, bloom: 1.1}); GARGANTUA.setDebug(2)')
            time.sleep(0.6)
            p.reload(); p.wait_for_function('document.documentElement.dataset.ready === "1"')
            st = p.evaluate('GARGANTUA.getState()')
            c.close()
            return st['params']['diskOuter'] == 38 and st['params']['bloom'] == 1.1 and st['debug'] == 2, f'restored diskOuter={st["params"]["diskOuter"]} bloom={st["params"]["bloom"]} debug={st["debug"]}'
        check('localStorage 状态持久化（刷新后恢复）', persistence)

        # ---------------------------------------------------------- 4. mobile
        def mobile():
            dev = pw.devices['iPhone 13']
            c, p = new_page(browser, 'mobile', '?clean=1', viewport=dev['viewport'],
                            device_scale_factor=dev['device_scale_factor'], is_mobile=True, has_touch=True,
                            user_agent=dev['user_agent'])
            time.sleep(1)
            st = p.evaluate('GARGANTUA.getState()')
            overflow = p.evaluate('document.documentElement.scrollWidth > window.innerWidth')
            shot(p, 'mobile.png')
            p.tap('#b-panel'); time.sleep(0.6)
            shot(p, 'mobile-panel.png')
            c.close()
            return st['quality'] == 'standard' and not overflow and st['size']['dpr'] <= 1.25, f'quality={st["quality"]} dpr={st["size"]["dpr"]} canvas={st["size"]["w"]}x{st["size"]["h"]} overflow={overflow}'
        check('移动端（iPhone 13 视口 / 触摸 / Retina 上限）', mobile)

        def retina():
            c, p = new_page(browser, 'retina', '?automation=1&quality=high&frames=2', device_scale_factor=2)
            st = p.evaluate('GARGANTUA.getState()')
            c.close()
            return st['size']['dpr'] == 1.75 and st['size']['w'] == int(W * 1.75), f'dpr={st["size"]["dpr"]} canvas={st["size"]["w"]}x{st["size"]["h"]} rt={st["size"]["rw"]}x{st["size"]["rh"]}'
        check('Retina（DPR=2 → High 档上限 1.75）', retina)

        # ---------------------------------------------------------- 5. shader-failure fallback
        def shader_fallback():
            c = browser.new_context(viewport={'width': W, 'height': H})
            p = c.new_page(); p.set_default_timeout(240000)
            expected = []
            p.on('console', lambda m: expected.append(m.text) if m.type == 'error' else None)
            p.goto(f'{BASE}/?automation=1&quality=cinematic&failq=cinematic,high&frames=2')
            p.wait_for_function('document.documentElement.dataset.ready === "1"')
            st = p.evaluate('GARGANTUA.getState()')
            s = img_stats(p.screenshot())
            c.close()
            return st['quality'] == 'standard' and s['std'] > 12, f'cinematic✗ → high✗ → {st["quality"]}✓ (onShaderError 捕获，控制台错误 {len(expected)} 条)'
        check('着色器编译失败 → 自动逐级降级画质', shader_fallback)

        # ---------------------------------------------------------- 6. no-WebGL2 fallback
        def no_webgl():
            c = browser.new_context(viewport={'width': W, 'height': H})
            c.add_init_script("delete window.WebGL2RenderingContext;")
            p = c.new_page(); p.goto(f'{BASE}/?clean=1')
            p.wait_for_selector('#overlay.error', timeout=30000)
            t = p.inner_text('#ov-title')
            shot(p, 'no-webgl2.png')
            c.close()
            return 'WebGL2' in t, t
        check('不支持 WebGL2 时显示说明页（非黑屏）', no_webgl)

        def audio_assets():
            c = browser.new_context(); p = c.new_page()
            r1 = p.request.get(f'{BASE}/assets/audio/gargantua-ambient.ogg')
            r2 = p.request.get(f'{BASE}/assets/audio/gargantua-ambient.mp3')
            n1, n2 = len(r1.body()), len(r2.body())
            c.close()
            return r1.ok and r2.ok and n1 > 500000 and n2 > 500000, f'ogg {n1} B, mp3 {n2} B'
        check('音频资源可访问', audio_assets)

        browser.close()

    # deliberate context-loss produces a browser-level "CONTEXT_LOST_WEBGL" console line in some builds; keep everything
    real_errors = [e for e in console_errors]
    record('全程无控制台错误', len(real_errors) == 0, '; '.join(real_errors[:8]))

    passed = sum(r['ok'] for r in results)
    summary = {'passed': passed, 'total': len(results), 'seconds': round(time.time() - t0, 1), 'results': results,
               'console_errors': console_errors}
    with open(os.path.join(OUT, 'results.json'), 'w') as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    with open(os.path.join(OUT, 'RESULTS.md'), 'w') as f:
        f.write(f'# GARGANTUA 验收结果\n\n通过 {passed}/{len(results)} · 用时 {summary["seconds"]} s · Chromium headless (SwiftShader)\n\n')
        f.write('| 结果 | 用例 | 详情 |\n|---|---|---|\n')
        for r in results:
            f.write(f'| {"✅" if r["ok"] else "❌"} | {r["name"]} | {r["detail"].replace("|", "/")} |\n')
    print(f'\n{passed}/{len(results)} passed in {summary["seconds"]} s')
    sys.exit(0 if passed == len(results) else 1)


if __name__ == '__main__':
    main()
