// Camera handling: OrbitControls, animated preset transitions, cinematic loop.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VIEW_PRESETS } from './params.js';

const D2R = Math.PI / 180;

// cinematic keyframes: t (s), dist (M), elevation (deg), azimuth (deg), fov (deg), roll (deg)
const CINE_KEYS = [
  [0, 36, 5, -20, 42, 0],
  [11, 27, 2.5, 22, 48, -2.5],
  [22, 17, 11, 78, 62, 3],
  [32, 13.5, 4, 135, 70, 0.5],
  [42, 24, 30, 200, 50, -3],
  [54, 46, 66, 255, 40, 0],
  [65, 40, 15, 300, 42, 2],
];
export const CINE_DURATION = 76;

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

export function cinePose(time) {
  const T = ((time % CINE_DURATION) + CINE_DURATION) % CINE_DURATION;
  const n = CINE_KEYS.length;
  const key = (i) => {
    const k = CINE_KEYS[((i % n) + n) % n].slice();
    const wraps = Math.floor(i / n);
    k[0] += wraps * CINE_DURATION;
    k[3] += wraps * 360;
    return k;
  };
  let i = 0;
  while (i < n - 1 && CINE_KEYS[i + 1][0] <= T) i++;
  const k0 = key(i - 1), k1 = key(i), k2 = key(i + 1), k3 = key(i + 2);
  let u = (T - k1[0]) / (k2[0] - k1[0]);
  u = u * u * (3 - 2 * u) * 0.35 + u * 0.65; // gentle ease
  const v = (j) => catmull(k0[j], k1[j], k2[j], k3[j], u);
  return { dist: v(1), elev: v(2), az: v(3), fov: v(4), roll: v(5) };
}

export function poseToPosition(pose, out = new THREE.Vector3()) {
  const e = pose.elev * D2R, a = pose.az * D2R;
  return out.set(pose.dist * Math.cos(e) * Math.sin(a), pose.dist * Math.sin(e), pose.dist * Math.cos(e) * Math.cos(a));
}

export function positionToPose(pos, fov) {
  const dist = pos.length();
  return {
    dist,
    elev: Math.asin(THREE.MathUtils.clamp(pos.y / dist, -1, 1)) / D2R,
    az: Math.atan2(pos.x, pos.z) / D2R,
    fov, roll: 0,
  };
}

export class CameraRig extends EventTarget {
  constructor(domElement) {
    super();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1000);
    this.controls = new OrbitControls(this.camera, domElement);
    Object.assign(this.controls, {
      enableDamping: true, dampingFactor: 0.07, enablePan: false,
      minDistance: 7.5, maxDistance: 160, rotateSpeed: 0.55, zoomSpeed: 0.8,
    });
    this.controls.target.set(0, 0, 0);
    this.cinematic = false;
    this.cineTime = 0;
    this.cineBlend = 1;
    this.anim = null;
    this.roll = 0;
    this.setPose(VIEW_PRESETS[0]);
    this.controls.addEventListener('start', () => {
      this.anim = null;
      if (this.cinematic) { this.setCinematic(false); this.dispatchEvent(new Event('cine-interrupted')); }
    });
    this.controls.addEventListener('change', () => this.dispatchEvent(new Event('change')));
  }

  get pose() { return positionToPose(this.camera.position, this.camera.fov); }

  setPose(p) {
    poseToPosition(p, this.camera.position);
    this.camera.fov = p.fov ?? this.camera.fov;
    this.roll = p.roll || 0;
    this._applyLook();
  }

  _applyLook() {
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);
    if (this.roll) this.camera.rotateZ(this.roll * D2R);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  flyTo(target, duration = 1.8) {
    this.setCinematic(false);
    const from = this.pose;
    // shortest azimuth path
    let daz = ((target.az - from.az + 540) % 360) - 180;
    this.anim = { from, to: { ...target, az: from.az + daz }, t: 0, duration };
  }

  setCinematic(on, startTime) {
    if (on === this.cinematic) return;
    this.cinematic = on;
    this.anim = null;
    if (on) {
      this.cineFrom = this.pose;
      this.cineBlend = 0;
      if (startTime !== undefined) { this.cineTime = startTime; this.cineBlend = 1; }
      // controls stay enabled: any drag / wheel fires 'start' and hands control back to the user
    } else {
      this.roll = 0;
      this._applyLook();
    }
    this.dispatchEvent(new Event('cine'));
  }

  update(dt) {
    if (this.cinematic) {
      this.cineTime = (this.cineTime + dt) % CINE_DURATION;
      const p = cinePose(this.cineTime);
      if (this.cineBlend < 1) {
        this.cineBlend = Math.min(1, this.cineBlend + dt / 2.5);
        const s = this.cineBlend * this.cineBlend * (3 - 2 * this.cineBlend);
        const f = this.cineFrom;
        const daz = ((p.az - f.az + 540) % 360) - 180;
        this.setPose({
          dist: f.dist + (p.dist - f.dist) * s, elev: f.elev + (p.elev - f.elev) * s,
          az: f.az + daz * s, fov: f.fov + (p.fov - f.fov) * s, roll: p.roll * s,
        });
      } else this.setPose(p);
      return;
    }
    if (this.anim) {
      const a = this.anim;
      a.t += dt / a.duration;
      const e = a.t >= 1 ? 1 : (a.t < 0.5 ? 4 * a.t ** 3 : 1 - Math.pow(-2 * a.t + 2, 3) / 2);
      const L = (k) => a.from[k] + (a.to[k] - a.from[k]) * e;
      this.setPose({ dist: L('dist'), elev: L('elev'), az: L('az'), fov: L('fov') });
      if (a.t >= 1) this.anim = null;
      this.controls.update();
      return;
    }
    this.controls.update();
  }

  setAspect(a) {
    this.camera.aspect = a;
    this.camera.updateProjectionMatrix();
  }
}
