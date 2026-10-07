// GARGANTUA — application bootstrap, UI, persistence, recovery and automation API.
import * as THREE from 'three';
import { Engine } from './engine.js';
import { CameraRig } from './camera-rig.js';
import { Ambient } from './audio.js';
import {
  PARAMS, PARAM_MAP, defaultParams, clampParam, QUALITY, QUALITY_ORDER, VIEW_PRESETS, DEBUG_VIEWS,
} from './params.js';

const VERSION = '1.0.0';
const STORE_KEY = 'gargantua:v1';
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ state ----
const url = new URLSearchParams(location.search);
const automation = url.has('automation') || url.has('shot');
const clean = automation || url.get('clean') === '1';
if (automation) document.documentElement.dataset.automation = '1';
const READY_FRAMES = automation ? Math.max(1, Math.min(256, parseInt(url.get('frames'), 10) || 8)) : 3;
const isMobile = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 700;

const state = {
  params: defaultParams(),
  quality: isMobile ? 'standard' : 'high',
  debug: 0,
  paused: false,
  time: 0,
  hud: true,
  ui: true,
  panel: false,
  music: false,
  cine: true,
  pose: null,
};

function loadStore() {
  if (clean) return;
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!s) return;
    for (const k of Object.keys(s.params || {})) if (PARAM_MAP[k]) state.params[k] = clampParam(k, s.params[k]);
    if (QUALITY[s.quality]) state.quality = s.quality;
    for (const k of ['hud', 'panel', 'cine']) if (typeof s[k] === 'boolean') state[k] = s[k];
    if (Number.isInteger(s.debug) && s.debug >= 0 && s.debug <= 9) state.debug = s.debug;
    if (s.pose && Number.isFinite(s.pose.dist)) state.pose = s.pose;
  } catch (e) { /* storage unavailable or corrupt: defaults */ }
}
let saveT = 0;
function save() {
  if (clean) return;
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try {
      const pose = rig ? rig.pose : state.pose;
      localStorage.setItem(STORE_KEY, JSON.stringify({
        params: state.params, quality: state.quality, hud: state.hud, panel: state.panel,
        cine: state.cine, debug: state.debug, pose,
      }));
    } catch (e) { /* ignore */ }
  }, 250);
}

function applyUrl() {
  if (QUALITY[url.get('quality')]) state.quality = url.get('quality');
  if (url.has('debug')) state.debug = Math.max(0, Math.min(9, parseInt(url.get('debug'), 10) || 0));
  if (url.has('t')) state.time = parseFloat(url.get('t')) || 0;
  if (url.has('paused')) state.paused = url.get('paused') === '1';
  if (url.has('cine')) state.cine = url.get('cine') === '1';
  if (url.has('hud')) state.hud = url.get('hud') !== '0';
  if (url.has('ui')) state.ui = url.get('ui') !== '0';
  if (url.has('panel')) state.panel = url.get('panel') === '1';
  for (const [k, v] of url) {
    if (k.startsWith('p_') && PARAM_MAP[k.slice(2)]) state.params[k.slice(2)] = clampParam(k.slice(2), v);
  }
  const preset = parseInt(url.get('preset'), 10);
  if (preset >= 1 && preset <= 4) { state.pose = { ...VIEW_PRESETS[preset - 1] }; if (!url.has('cine')) state.cine = false; }
  if (url.has('cam')) {
    const [dist, elev, az, fov] = url.get('cam').split(',').map(Number);
    if (Number.isFinite(dist)) {
      state.pose = { dist: Math.max(7.5, dist), elev: elev || 0, az: az || 0, fov: fov || 42 };
      if (!url.has('cine')) state.cine = false;
    }
  }
  if (automation && !url.has('cine') && !url.has('cinet')) state.cine = false;
  if (automation && !url.has('paused')) state.paused = true;
}

// ------------------------------------------------------------- core ----
let engine, rig, ambient;
let canvas = $('gl');
let raf = 0;
let running = false;
let lastNow = 0;
let wallTime = 0;
let lastDt = 1 / 60;
let frameCount = 0;
let readyResolve;
const ready = new Promise((r) => { readyResolve = r; });
const frameWaiters = [];
const stats = { fps: 0, ms: 0, acc: 0, n: 0, lastHud: 0, slow: 0, fast: 0 };

function overlay(kind, title, msg, retry) {
  const ov = $('overlay');
  if (kind === 'hide') { ov.classList.add('hidden'); return; }
  ov.classList.remove('hidden', 'error', 'soft');
  if (kind === 'error') ov.classList.add('error');
  if (kind === 'soft') ov.classList.add('soft');
  $('ov-title').textContent = title;
  $('ov-msg').textContent = msg || '';
  const b = $('ov-retry');
  b.hidden = !retry;
  b.onclick = retry || null;
}

function toast(msg, ms = 1800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function compileWithFallback(start) {
  const order = QUALITY_ORDER.slice(0, QUALITY_ORDER.indexOf(start) + 1).reverse();
  let lastErr = '';
  for (const q of order) {
    if (engine.setQuality(q)) {
      if (q !== start) toast(`画质已降级为 ${QUALITY[q].label}（着色器编译失败）`, 3200);
      state.quality = q;
      return true;
    }
    lastErr = engine.shaderError;
    console.warn('[GARGANTUA] shader compile failed for', q);
  }
  overlay('error', '着色器编译失败', (lastErr || '').slice(0, 600), () => location.reload());
  return false;
}

function createEngine() {
  engine = new Engine(canvas);
  engine.init();
  if (url.has('failq')) engine.forceFail = url.get('failq').split(',');
  if (url.has('scale')) engine.renderScaleOverride = Math.min(2, Math.max(0.1, parseFloat(url.get('scale')) || 1));
  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);
  return compileWithFallback(state.quality);
}

function resize() {
  const vv = window.visualViewport;
  const w = Math.round(vv ? vv.width : window.innerWidth) || window.innerWidth;
  const h = Math.round(vv ? vv.height : window.innerHeight) || window.innerHeight;
  engine.resize(w, h, window.devicePixelRatio || 1);
  rig.setAspect(w / h);
}

// ---- temporal accumulation bookkeeping ----
const halton = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
const prevCam = { pos: new THREE.Vector3(1e9, 0, 0), quat: new THREE.Quaternion(), fov: 0, time: -1, sig: '' };
let accum = 0;
function temporal() {
  const cam = rig.camera;
  const sig = PARAMS.map((p) => state.params[p.key]).join(',') + '|' + state.debug + '|' + state.quality + '|' + engine.size.rw + 'x' + engine.size.rh;
  const dAng = prevCam.quat.angleTo(cam.quaternion);
  const dPos = prevCam.pos.distanceTo(cam.position) / cam.position.length();
  const dFov = Math.abs(prevCam.fov - cam.fov);
  let alpha, clamp;
  if (sig !== prevCam.sig || dAng > 0.05 || dPos > 0.05 || dFov > 1.0) { accum = 0; alpha = 1; clamp = true; }
  else if (dAng > 1e-6 || dPos > 1e-6 || dFov > 1e-5 || prevCam.time !== state.time) { accum = 0; alpha = 0.3; clamp = true; }
  else { accum++; alpha = Math.max(1 / (accum + 1), 1 / 48); clamp = false; }
  prevCam.pos.copy(cam.position); prevCam.quat.copy(cam.quaternion); prevCam.fov = cam.fov;
  prevCam.time = state.time; prevCam.sig = sig;
  const k = (accum > 0 ? accum : frameCount) % 64 + 1;
  return { alpha, clamp, jitter: [halton(k, 2) - 0.5, halton(k, 3) - 0.5], seed: k };
}

function renderOnce() {
  rig.camera.updateMatrixWorld();
  const tm = temporal();
  engine.render({
    camPos: rig.camera.position,
    camQuat: rig.camera.quaternion,
    fov: rig.camera.fov,
    time: state.time,
    seed: tm.seed,
    jitter: tm.jitter,
    taaAlpha: tm.alpha,
    taaClamp: tm.clamp,
    debug: state.debug,
    params: state.params,
    wallTime: automation ? 0 : wallTime,
    adaptRate: automation ? 1 : 1 - Math.exp(-lastDt * 1.6),
    autoExposure: url.get('autoexp') === '0' ? 0 : 1,
  });
}

function frame(now) {
  raf = requestAnimationFrame(frame);
  if (engine.contextLost) return;
  // automation: once ready and paused, render only on demand (renderFrames / capture)
  if (automation && state.paused && frameCount >= READY_FRAMES && !frameWaiters.length && !rig.cinematic && !rig.anim) { lastNow = 0; return; }
  const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 1 / 60;
  lastNow = now;
  wallTime += dt;
  lastDt = dt;
  if (!state.paused) state.time += dt * state.params.diskSpeed * 6.0;
  rig.update(state.paused && automation ? 0 : dt);
  try {
    resize();
    renderOnce();
  } catch (e) {
    console.error('[GARGANTUA] render failed', e);
    stats.errors = (stats.errors || 0) + 1;
    if (stats.errors > 5) { stop(); overlay('error', '渲染失败', String(e.message || e), () => location.reload()); }
    return;
  }
  frameCount++;
  if (frameCount === READY_FRAMES) {
    overlay('hide');
    updateHud();
    document.documentElement.dataset.ready = '1';
    readyResolve();
    if (url.has('shot')) { document.documentElement.dataset.shot = 'ready'; document.title = 'READY'; }
  }
  while (frameWaiters.length && frameWaiters[0].until <= frameCount) frameWaiters.shift().resolve();
  trackPerf(dt);
}

function trackPerf(dt) {
  stats.acc += dt; stats.n++;
  if (stats.acc >= 0.5) {
    stats.fps = stats.n / stats.acc;
    stats.ms = (stats.acc / stats.n) * 1000;
    stats.acc = 0; stats.n = 0;
    // dynamic resolution (interactive tiers only)
    if (!automation && state.quality !== 'cinematic' && engine.renderScaleOverride == null && !document.hidden) {
      if (stats.fps < 26) stats.slow++; else stats.slow = 0;
      if (stats.fps > 55) stats.fast++; else stats.fast = 0;
      if (stats.slow >= 2 && engine.dynamicScale > 0.5) { engine.dynamicScale = Math.max(0.5, engine.dynamicScale * 0.85); stats.slow = 0; }
      if (stats.fast >= 6 && engine.dynamicScale < 1) { engine.dynamicScale = Math.min(1, engine.dynamicScale * 1.12); stats.fast = 0; }
    }
    updateHud();
  }
}

function start() { if (!running) { running = true; lastNow = 0; raf = requestAnimationFrame(frame); } }
function stop() { running = false; cancelAnimationFrame(raf); }

// ------------------------------------------------- context recovery ----
let restoreTimer = 0;
function onContextLost(e) {
  e.preventDefault();
  engine.contextLost = true;
  overlay('soft', 'GPU 上下文丢失，正在恢复…', '浏览器回收了 WebGL 上下文，正在重建渲染资源。');
  clearTimeout(restoreTimer);
  restoreTimer = setTimeout(hardReset, 4000);
}
function onContextRestored() {
  clearTimeout(restoreTimer);
  try {
    engine.contextLost = false;
    engine.rebuild();
    if (!compileWithFallback(state.quality)) return;
    overlay('hide');
    toast('WebGL 上下文已恢复');
  } catch (err) {
    console.warn('[GARGANTUA] soft restore failed, doing hard reset', err);
    hardReset();
  }
}
function hardReset() {
  // replace the canvas and rebuild the whole renderer
  try { engine.renderer.dispose(); } catch (e) { /* ignore */ }
  const fresh = document.createElement('canvas');
  fresh.id = 'gl';
  fresh.setAttribute('aria-label', canvas.getAttribute('aria-label'));
  canvas.replaceWith(fresh);
  canvas = fresh;
  rig.controls.disconnect();
  rig.controls.connect(canvas);
  try {
    if (createEngine()) { overlay('hide'); toast('渲染器已重建'); }
  } catch (err) {
    overlay('error', '无法重建 WebGL', String(err.message || err), () => location.reload());
  }
}

// --------------------------------------------------------------- UI ----
function fmt(p, v) {
  const d = p.step >= 1 ? 0 : Math.min(3, Math.max(0, Math.ceil(-Math.log10(p.step))));
  return v.toFixed(d) + (p.unit && p.unit !== '×' ? ' ' + p.unit : p.unit === '×' ? '×' : '');
}

function buildPanel() {
  const host = $('params');
  host.innerHTML = '';
  let group = '';
  for (const p of PARAMS) {
    if (p.group !== group) {
      group = p.group;
      const h = document.createElement('h3');
      h.textContent = group;
      host.appendChild(h);
    }
    const row = document.createElement('div');
    row.className = 'prm';
    const id = 'p-' + p.key;
    row.innerHTML = `<label for="${id}">${p.label}</label><output id="o-${p.key}"></output>
      <input type="range" id="${id}" min="${p.min}" max="${p.max}" step="${p.step}">`;
    host.appendChild(row);
    const input = row.querySelector('input');
    input.addEventListener('input', () => {
      state.params[p.key] = clampParam(p.key, input.value);
      row.querySelector('output').textContent = fmt(p, state.params[p.key]);
      save();
    });
    input.addEventListener('dblclick', () => { setParams({ [p.key]: p.def }); });
  }
  const sel = $('s-debug');
  sel.innerHTML = DEBUG_VIEWS.map((n, i) => `<option value="${i}">${n}</option>`).join('');
  sel.addEventListener('change', () => setDebug(parseInt(sel.value, 10)));
  syncPanel();
}

function syncPanel() {
  for (const p of PARAMS) {
    const input = $('p-' + p.key);
    if (!input) continue;
    input.value = state.params[p.key];
    $('o-' + p.key).textContent = fmt(p, state.params[p.key]);
  }
  $('s-debug').value = String(state.debug);
}

function syncUi() {
  document.body.classList.toggle('ui-hidden', !state.ui);
  document.body.classList.toggle('hud-off', !state.hud);
  $('panel').classList.toggle('open', state.panel);
  document.body.classList.toggle('panel-open', state.panel);
  $('b-panel').setAttribute('aria-pressed', state.panel);
  $('b-cine').setAttribute('aria-pressed', rig.cinematic);
  $('b-pause').setAttribute('aria-pressed', state.paused);
  $('b-pause').textContent = state.paused ? '▶ 时间' : '❚❚ 时间';
  $('b-music').setAttribute('aria-pressed', state.music);
  document.querySelectorAll('[data-quality]').forEach((b) => b.classList.toggle('active', b.dataset.quality === state.quality));
  $('cine-tag').hidden = !rig.cinematic;
  const dt = $('debug-tag');
  dt.hidden = state.debug === 0;
  dt.textContent = 'DEBUG · ' + DEBUG_VIEWS[state.debug];
  $('s-debug').value = String(state.debug);
}

function updateHud() {
  if (!state.hud || !state.ui) return;
  const pos = rig.camera.position;
  const r = pos.length();
  const inc = Math.acos(Math.abs(pos.y) / r) * 180 / Math.PI;
  const lapse = Math.sqrt(1 - 2 / r);
  const sinA = Math.min(1, (3 * Math.sqrt(3) / r) * lapse);
  $('h-fps').textContent = stats.fps.toFixed(0);
  $('h-ms').textContent = stats.ms.toFixed(1) + ' ms';
  $('h-q').textContent = QUALITY[state.quality].label + ` · ${engine.qualityDef.maxSteps} 步`;
  $('h-res').textContent = `${engine.size.rw}×${engine.size.rh}` + (engine.dynamicScale < 1 ? ` (${Math.round(engine.dynamicScale * 100)}%)` : '');
  $('h-r').textContent = `${r.toFixed(2)} M · ${(r / 2).toFixed(2)} rₛ`;
  $('h-inc').textContent = inc.toFixed(1) + '°';
  $('h-dil').textContent = lapse.toFixed(4);
  $('h-shadow').textContent = (Math.asin(sinA) * 180 / Math.PI).toFixed(2) + '°';
  $('h-t').textContent = state.time.toFixed(0) + ' M' + (state.paused ? ' ❚❚' : '');
  $('h-view').textContent = state.debug === 0 ? (rig.cinematic ? '电影镜头' : '自由环绕') : `调试 ${state.debug}`;
}

// ------------------------------------------------------------ actions ----
function setParams(obj) {
  for (const [k, v] of Object.entries(obj || {})) if (PARAM_MAP[k]) state.params[k] = clampParam(k, v);
  syncPanel(); save();
}
function setDebug(n) {
  state.debug = Math.max(0, Math.min(9, n | 0));
  syncUi(); save();
  if (!automation) toast(DEBUG_VIEWS[state.debug]);
}
function setPreset(n, instant = false) {
  const p = VIEW_PRESETS[n - 1];
  if (!p) return;
  if (instant) { rig.setCinematic(false); rig.setPose(p); rig.controls.update(); }
  else rig.flyTo(p);
  if (!automation) toast(`视角 · ${p.name}`);
  syncUi(); save();
}
function setQuality(q) {
  if (!QUALITY[q]) return false;
  overlay('soft', `切换至 ${QUALITY[q].label}…`, '正在重新编译着色器');
  return new Promise((resolve) => {
    setTimeout(() => {
      engine.dynamicScale = 1;
      const ok = compileWithFallback(q);
      overlay('hide');
      syncUi(); save(); updateHud();
      resolve(ok && state.quality === q);
    }, 30);
  });
}
function cycleQuality() {
  const i = QUALITY_ORDER.indexOf(state.quality);
  setQuality(QUALITY_ORDER[(i + 1) % QUALITY_ORDER.length]).then(() => toast(`画质 · ${QUALITY[state.quality].label}`));
}
function setCinematic(on, t) {
  rig.setCinematic(on, t);
  state.cine = rig.cinematic;
  syncUi(); save();
}
function togglePause() { state.paused = !state.paused; syncUi(); toast(state.paused ? '盘面时间已暂停' : '盘面时间继续'); }
async function toggleMusic() {
  const want = !state.music;
  const ok = await ambient.setEnabled(want);
  state.music = want && ok;
  if (want && !ok) toast('浏览器阻止了音频播放，请再点一次');
  else toast(state.music ? '氛围音乐 · 开' : '氛围音乐 · 关');
  syncUi();
}
function togglePanel(v) { state.panel = v ?? !state.panel; syncUi(); save(); }
function toggleHelp(v) { const h = $('help'); h.hidden = !(v ?? h.hidden); }
function toggleUi() { state.ui = !state.ui; syncUi(); }
function resetParams() { state.params = defaultParams(); syncPanel(); save(); toast('参数已重置'); }

function capture(type = 'image/png', q) {
  // draw synchronously and read the backbuffer in the same task
  resize();
  renderOnce();
  return canvas.toDataURL(type, q);
}
function screenshot() {
  const a = document.createElement('a');
  a.href = capture();
  a.download = `gargantua-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  document.body.appendChild(a); a.click(); a.remove();
  toast('截图已保存');
}

function shareLink() {
  const u = new URL(location.href.split('?')[0]);
  const pose = rig.pose;
  u.searchParams.set('quality', state.quality);
  u.searchParams.set('cam', [pose.dist, pose.elev, pose.az, pose.fov].map((x) => +x.toFixed(2)).join(','));
  if (state.debug) u.searchParams.set('debug', state.debug);
  for (const p of PARAMS) if (state.params[p.key] !== p.def) u.searchParams.set('p_' + p.key, state.params[p.key]);
  return u.toString();
}

function bindUi() {
  document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => setPreset(+b.dataset.preset)));
  document.querySelectorAll('[data-quality]').forEach((b) => b.addEventListener('click', () => setQuality(b.dataset.quality).then(() => toast(`画质 · ${QUALITY[state.quality].label}`))));
  $('b-cine').onclick = () => setCinematic(!rig.cinematic);
  $('b-pause').onclick = togglePause;
  $('b-music').onclick = toggleMusic;
  $('b-shot').onclick = screenshot;
  $('b-panel').onclick = () => togglePanel();
  $('b-close').onclick = () => togglePanel(false);
  $('b-help').onclick = () => toggleHelp();
  $('help').onclick = (e) => { if (e.target.id === 'help') toggleHelp(false); };
  $('b-reset').onclick = resetParams;
  $('b-link').onclick = async () => {
    const link = shareLink();
    try { await navigator.clipboard.writeText(link); toast('链接已复制'); } catch (e) { prompt('复制链接', link); }
  };
  rig.addEventListener('cine-interrupted', () => { state.cine = false; syncUi(); save(); toast('已切换到手动环绕'); });
  rig.addEventListener('change', () => save());

  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if ((tag === 'input' || tag === 'select' || tag === 'textarea') && e.key !== 'Escape') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const m = /^(Digit|Numpad)(\d)$/.exec(e.code);
    if (m) {
      const n = +m[2];
      if (e.shiftKey && n >= 1 && n <= 4) setPreset(n); else if (!e.shiftKey) setDebug(n);
      e.preventDefault();
      return;
    }
    switch (e.key.toLowerCase()) {
      case 'c': setCinematic(!rig.cinematic); toast(rig.cinematic ? '电影镜头 · 开' : '电影镜头 · 关'); break;
      case ' ': togglePause(); e.preventDefault(); break;
      case 'q': cycleQuality(); break;
      case 'h': toggleUi(); break;
      case 'p': togglePanel(); break;
      case 'm': toggleMusic(); break;
      case 's': screenshot(); break;
      case 'r': resetParams(); break;
      case 'f':
        if (document.fullscreenElement) document.exitFullscreen?.();
        else document.documentElement.requestFullscreen?.().catch(() => toast('此浏览器不支持全屏'));
        break;
      case '?': case '/': toggleHelp(); break;
      case 'escape': toggleHelp(false); togglePanel(false); break;
      default: return;
    }
  });
  window.addEventListener('resize', () => resize());
  window.visualViewport?.addEventListener('resize', () => resize());
  document.addEventListener('visibilitychange', () => { lastNow = 0; });
}

// ------------------------------------------------------ automation API ----
function installApi() {
  window.GARGANTUA = {
    version: VERSION,
    ready,
    params: PARAMS.map(({ key, label, min, max, step, def, group }) => ({ key, label, min, max, step, def, group })),
    presets: VIEW_PRESETS,
    debugViews: DEBUG_VIEWS,
    getState: () => ({
      quality: state.quality, debug: state.debug, paused: state.paused, time: state.time,
      cinematic: rig.cinematic, pose: rig.pose, params: { ...state.params },
      size: { ...engine.size }, fps: stats.fps, frame: frameCount, contextLost: engine.contextLost,
    }),
    setParams: (o) => { setParams(o); return { ...state.params }; },
    setQuality: (q) => setQuality(q),
    setPreset: (n, instant = true) => setPreset(n, instant),
    setCamera: (p) => { rig.setCinematic(false); rig.setPose({ ...rig.pose, ...p }); rig.controls.update(); syncUi(); },
    setDebug: (n) => setDebug(n),
    setTime: (t) => { state.time = +t || 0; },
    pause: (b = true) => { state.paused = !!b; syncUi(); },
    setCinematic: (b, t) => setCinematic(!!b, t),
    setUI: (b) => { state.ui = !!b; syncUi(); },
    renderFrames: (n = 1) => new Promise((resolve) => frameWaiters.push({ until: frameCount + n, resolve })),
    capture: async (type, q) => { await ready; return capture(type, q); },
    simulateContextLoss: (restoreAfterMs = 600) => {
      const ext = engine.gl.getExtension('WEBGL_lose_context');
      if (!ext) return false;
      ext.loseContext();
      // restoreAfterMs < 0 simulates a context that never comes back -> hard reset path
      if (restoreAfterMs >= 0) setTimeout(() => ext.restoreContext(), restoreAfterMs);
      return true;
    },
    shareLink,
    readLuminance: () => engine.readLuminance(),
  };
}

// ------------------------------------------------------------- boot ----
function boot() {
  loadStore();
  applyUrl();
  if (!window.WebGL2RenderingContext) {
    overlay('error', '此浏览器不支持 WebGL2', '请使用最新版 Chrome / Edge / Firefox / Safari 16+。');
    return;
  }
  rig = new CameraRig(canvas);
  if (state.pose) rig.setPose(state.pose);
  try {
    if (!createEngine()) return;
  } catch (err) {
    const msg = err.message === 'WEBGL2_UNAVAILABLE'
      ? '无法创建 WebGL2 上下文（可能被禁用或 GPU 被列入黑名单）。'
      : String(err.message || err);
    overlay('error', '无法初始化 WebGL', msg, () => location.reload());
    return;
  }
  ambient = new Ambient();
  buildPanel();
  bindUi();
  installApi();
  if (state.cine) rig.setCinematic(true, url.has('cinet') ? parseFloat(url.get('cinet')) || 0 : undefined);
  if (url.has('cinet') && !url.has('cine')) rig.setCinematic(true, parseFloat(url.get('cinet')) || 0);
  syncUi();
  resize();
  start();
}

overlay('show', '正在编译测地线着色器…', '首次编译可能需要数秒。');
// let the overlay paint before the (blocking) shader compile
requestAnimationFrame(() => setTimeout(boot, 0));

export { THREE };
