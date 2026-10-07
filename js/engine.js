// Rendering engine: HDR raytrace pass -> dual-filter bloom -> cinematic composite.
import * as THREE from 'three';
import { FULLSCREEN_VERT } from './shaders/common.js';
import { blackholeFrag } from './shaders/blackhole.js';
import { BLOOM_DOWN_FRAG, BLOOM_UP_FRAG, COMPOSITE_FRAG, LUM_FRAG, ADAPT_FRAG, RESOLVE_FRAG } from './shaders/post.js';
import { PARAMS, QUALITY } from './params.js';

export class Engine extends EventTarget {
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.quality = 'high';
    this.renderScaleOverride = null;
    this.dynamicScale = 1;
    this.shaderError = null;
    this.contextLost = false;
    this.hdrScale = 1;
  }

  init() {
    const gl = this.canvas.getContext('webgl2', {
      antialias: false, alpha: false, depth: false, stencil: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WEBGL2_UNAVAILABLE');
    this.gl = gl;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, context: gl, antialias: false });
    this.renderer.autoClear = false;
    this.renderer.debug.checkShaderErrors = true;
    this.renderer.debug.onShaderError = (glc, program, vs, fs) => {
      const log = glc.getProgramInfoLog(program) + '\n' + glc.getShaderInfoLog(fs) + '\n' + glc.getShaderInfoLog(vs);
      this.shaderError = log.trim() || 'shader link failed';
    };
    const ext = this.renderer.extensions;
    this.floatOK = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
    // without float render targets we store HDR compressed in 8-bit (x 1/8)
    this.hdrScale = this.floatOK ? 1 : 0.125;

    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this._buildMaterials();
    this.targets = null;
    this.size = { w: 1, h: 1, rw: 1, rh: 1, dpr: 1 };
  }

  _uniformsBH() {
    const u = {
      uRes: { value: new THREE.Vector2(1, 1) },
      uCamPos: { value: new THREE.Vector3(0, 2, 30) },
      uCamBasis: { value: new THREE.Matrix3() },
      uTanHalfFov: { value: Math.tan(THREE.MathUtils.degToRad(20)) },
      uAspect: { value: 1 },
      uPixAngle: { value: 0.001 },
      uTime: { value: 0 },
      uSeed: { value: 0 },
      uJitter: { value: new THREE.Vector2() },
      uDebug: { value: 0 },
      uStepScale: { value: 1 },
      uOutScale: { value: this.hdrScale },
    };
    for (const p of PARAMS) if (p.uniform) u[p.uniform] = { value: p.def };
    return u;
  }

  _buildMaterials() {
    const q = QUALITY[this.quality];
    const mk = (frag, uniforms) => new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: FULLSCREEN_VERT, fragmentShader: frag, uniforms,
      depthTest: false, depthWrite: false,
    });
    const prevU = this.bhMat ? this.bhMat.uniforms : null;
    if (this.bhMat) this.bhMat.dispose();
    let frag = blackholeFrag(q);
    // test hook (?failq=<quality>): inject a genuine GLSL compile error to exercise the fallback path
    if (this.forceFail && this.forceFail.includes(this.quality)) frag = frag.replace('void main() {', 'void main() { FORCED_COMPILE_ERROR;');
    this.bhMat = mk(frag, prevU || this._uniformsBH());
    this.bhMat.uniforms.uStepScale.value = q.stepScale;
    if (!this.downMat) {
      this.downMat = mk(BLOOM_DOWN_FRAG, {
        tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uPrefilter: { value: 0 },
        uThreshold: { value: 1 }, uKnee: { value: 0.5 }, uInScale: { value: 1 },
      });
      this.upMat = mk(BLOOM_UP_FRAG, {
        tLow: { value: null }, tCur: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 },
      });
      this.compMat = mk(COMPOSITE_FRAG, {
        tHdr: { value: null }, tBloom: { value: null }, uRes: { value: new THREE.Vector2() },
        uExposure: { value: 1 }, uBloom: { value: 0.5 }, uVignette: { value: 0.5 }, uGrain: { value: 0.3 },
        uAberr: { value: 0.3 }, uTime: { value: 0 }, uInScale: { value: 1 }, uBloomNorm: { value: 1 }, uMode: { value: 0 },
        tLum: { value: null }, uAutoKey: { value: 0.12 }, uAutoAmt: { value: 1 },
      });
      this.resolveMat = mk(RESOLVE_FRAG, {
        tCur: { value: null }, tPrev: { value: null }, uTexel: { value: new THREE.Vector2() },
        uAlpha: { value: 1 }, uClamp: { value: 1 },
      });
      this.lumMat = mk(LUM_FRAG, { tSrc: { value: null }, uInScale: { value: 1 } });
      this.adaptMat = mk(ADAPT_FRAG, { tPrev: { value: null }, tCur: { value: null }, uRate: { value: 1 } });
    }
  }

  /** Compile the raytracer for the current quality; returns true on success. */
  compile() {
    this.shaderError = null;
    this.quad.material = this.bhMat;
    this.renderer.compile(this.scene, this.cam);
    // force a tiny draw so lazy drivers link now
    const t = new THREE.WebGLRenderTarget(4, 4, { type: this.floatOK ? THREE.HalfFloatType : THREE.UnsignedByteType });
    this.renderer.setRenderTarget(t);
    this.renderer.render(this.scene, this.cam);
    this.renderer.setRenderTarget(null);
    t.dispose();
    return !this.shaderError;
  }

  setQuality(name) {
    if (!QUALITY[name]) return false;
    this.quality = name;
    this._buildMaterials();
    this.targets && this._disposeTargets();
    this.targets = null;
    return this.compile();
  }

  get qualityDef() { return QUALITY[this.quality]; }

  _disposeTargets() {
    const t = this.targets;
    t.raw.dispose();
    t.hist.forEach((r) => r.dispose());
    t.down.forEach((r) => r.dispose());
    t.up.forEach((r) => r.dispose());
    t.lum.forEach((r) => r.dispose());
  }

  resize(cssW, cssH, dprIn) {
    const q = this.qualityDef;
    const dpr = Math.min(dprIn || 1, q.dprCap);
    const w = Math.max(2, Math.round(cssW * dpr));
    const h = Math.max(2, Math.round(cssH * dpr));
    const scale = (this.renderScaleOverride ?? q.renderScale) * this.dynamicScale;
    const rw = Math.max(2, Math.round(w * scale));
    const rh = Math.max(2, Math.round(h * scale));
    const s = this.size;
    if (this.targets && s.w === w && s.h === h && s.rw === rw && s.rh === rh) return;
    this.size = { w, h, rw, rh, dpr };
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
    if (this.targets) this._disposeTargets();
    const type = this.floatOK ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const opts = { type, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };
    const raw = new THREE.WebGLRenderTarget(rw, rh, opts);
    const hist = [0, 1].map(() => new THREE.WebGLRenderTarget(rw, rh, opts));
    const down = [], up = [];
    let bw = rw, bh = rh;
    for (let i = 0; i < q.bloomLevels; i++) {
      bw = Math.max(1, Math.floor(bw / 2)); bh = Math.max(1, Math.floor(bh / 2));
      down.push(new THREE.WebGLRenderTarget(bw, bh, opts));
      up.push(new THREE.WebGLRenderTarget(bw, bh, opts));
    }
    const lopts = { ...opts, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
    const lum = [0, 1, 2].map(() => new THREE.WebGLRenderTarget(1, 1, lopts));
    this.targets = { raw, hist, histIdx: 0, histValid: false, down, up, lum, lumIdx: 0, lumFresh: true };
  }

  _draw(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.cam);
  }

  /**
   * Render one frame.
   * f = { camPos:Vector3, camQuat:Quaternion, fov, time, seed, debug, params, wallTime }
   */
  render(f) {
    if (this.contextLost || !this.targets) return;
    const T0 = this.targets;
    const { raw, down, up } = T0;
    const hdr = raw;
    const u = this.bhMat.uniforms;
    const p = f.params;
    u.uRes.value.set(hdr.width, hdr.height);
    u.uCamPos.value.copy(f.camPos);
    const m4 = new THREE.Matrix4().makeRotationFromQuaternion(f.camQuat);
    const e = m4.elements; // columns: right (0..2), up (4..6), back (8..10)
    u.uCamBasis.value.set(e[0], e[4], -e[8], e[1], e[5], -e[9], e[2], e[6], -e[10]);
    const tanH = Math.tan(THREE.MathUtils.degToRad(f.fov) / 2);
    u.uTanHalfFov.value = tanH;
    u.uAspect.value = hdr.width / hdr.height;
    u.uPixAngle.value = (2 * tanH) / hdr.height;
    u.uTime.value = f.time;
    u.uSeed.value = f.seed;
    u.uDebug.value = f.debug;
    u.uOutScale.value = this.hdrScale;
    for (const d of PARAMS) if (d.uniform) u[d.uniform].value = p[d.key];
    u.uJitter.value.set(f.jitter ? f.jitter[0] : 0, f.jitter ? f.jitter[1] : 0);
    this._draw(this.bhMat, raw);

    // temporal resolve (alpha = 1 means no history)
    const alpha = T0.histValid ? (f.taaAlpha ?? 1) : 1;
    const rm = this.resolveMat.uniforms;
    const prevH = T0.hist[T0.histIdx], nextH = T0.hist[1 - T0.histIdx];
    rm.tCur.value = raw.texture;
    rm.tPrev.value = prevH.texture;
    rm.uTexel.value.set(1 / raw.width, 1 / raw.height);
    rm.uAlpha.value = alpha;
    rm.uClamp.value = f.taaClamp ? 1 : 0;
    this._draw(this.resolveMat, nextH);
    T0.histIdx = 1 - T0.histIdx;
    T0.histValid = true;
    const resolved = nextH;

    const inScale = 1 / this.hdrScale;
    const passthrough = f.debug >= 2 && f.debug <= 8;
    // bloom chain (skipped for analytic debug views)
    if (!passthrough) {
      const dm = this.downMat.uniforms;
      let src = resolved;
      for (let i = 0; i < down.length; i++) {
        dm.tSrc.value = src.texture;
        dm.uTexel.value.set(1 / src.width, 1 / src.height);
        dm.uPrefilter.value = i === 0 ? 1 : 0;
        dm.uThreshold.value = p.bloomThreshold;
        dm.uKnee.value = Math.max(0.05, p.bloomThreshold * 0.5);
        dm.uInScale.value = i === 0 ? inScale : 1;
        this._draw(this.downMat, down[i]);
        src = down[i];
      }
      const um = this.upMat.uniforms;
      let low = down[down.length - 1];
      for (let i = down.length - 2; i >= 0; i--) {
        um.tLow.value = low.texture;
        um.tCur.value = down[i].texture;
        um.uTexel.value.set(1 / low.width, 1 / low.height);
        um.uRadius.value = 1.0;
        this._draw(this.upMat, up[i]);
        low = up[i];
      }
      this._bloomTex = low.texture;
    }

    // auto-exposure metering + temporal adaptation
    const T = this.targets;
    this.lumMat.uniforms.tSrc.value = resolved.texture;
    this.lumMat.uniforms.uInScale.value = inScale;
    this._draw(this.lumMat, T.lum[2]);
    const prev = T.lum[T.lumIdx], next = T.lum[1 - T.lumIdx];
    this.adaptMat.uniforms.tPrev.value = prev.texture;
    this.adaptMat.uniforms.tCur.value = T.lum[2].texture;
    this.adaptMat.uniforms.uRate.value = T.lumFresh ? 1 : (f.adaptRate ?? 0.05);
    this._draw(this.adaptMat, next);
    T.lumIdx = 1 - T.lumIdx;
    T.lumFresh = false;

    const cm = this.compMat.uniforms;
    cm.tLum.value = next.texture;
    cm.uAutoAmt.value = passthrough ? 0 : (f.autoExposure ?? 1);
    cm.tHdr.value = resolved.texture;
    cm.tBloom.value = passthrough ? resolved.texture : this._bloomTex;
    cm.uRes.value.set(this.size.w, this.size.h);
    cm.uExposure.value = Math.pow(2, p.exposure);
    cm.uBloom.value = p.bloom;
    cm.uVignette.value = p.vignette;
    cm.uGrain.value = p.grain;
    cm.uAberr.value = p.aberration;
    cm.uTime.value = f.wallTime;
    cm.uInScale.value = inScale;
    cm.uBloomNorm.value = 1 / down.length;
    cm.uMode.value = passthrough ? 1 : f.debug === 9 ? 2 : 0;
    this.renderer.setViewport(0, 0, this.size.w, this.size.h);
    this._draw(this.compMat, null);
  }

  /** Re-create all GPU resources (after a context restore). */
  rebuild() {
    if (this.targets) this._disposeTargets();
    this.targets = null;
    this.bhMat.needsUpdate = true;
    this.downMat.needsUpdate = true;
    this.upMat.needsUpdate = true;
    this.compMat.needsUpdate = true;
    const s = this.size;
    this.size = { w: 0, h: 0, rw: 0, rh: 0, dpr: s.dpr };
  }
}

/** Read the adapted metered luminance (debug/testing). */
Engine.prototype.readLuminance = function () {
  const t = this.targets.lum[this.targets.lumIdx];
  if (this.floatOK) {
    const buf = new Uint16Array(4);
    this.renderer.readRenderTargetPixels(t, 0, 0, 1, 1, buf);
    return THREE.DataUtils.fromHalfFloat(buf[0]);
  }
  const b8 = new Uint8Array(4);
  this.renderer.readRenderTargetPixels(t, 0, 0, 1, 1, b8);
  return b8[0] / 255 / this.hdrScale;
};
