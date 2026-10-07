// Parameter, quality, preset and debug-view definitions.

export const PARAMS = [
  // --- accretion disk ---
  { key: 'diskInner',   label: '内缘半径 r_in',    unit: 'M',  group: '吸积盘', min: 3.0,  max: 12,   step: 0.1,  def: 6.0,  uniform: 'uRin' },
  { key: 'diskOuter',   label: '外缘半径 r_out',   unit: 'M',  group: '吸积盘', min: 12,   max: 60,   step: 0.5,  def: 26,   uniform: 'uRout' },
  { key: 'thickness',   label: '盘厚 H/r',         unit: '',   group: '吸积盘', min: 0.005, max: 0.2, step: 0.005, def: 0.03, uniform: 'uThick' },
  { key: 'density',     label: '体积密度',         unit: '',   group: '吸积盘', min: 0.05, max: 4,    step: 0.05, def: 2.4,  uniform: 'uDensity' },
  { key: 'turbulence',  label: '湍流强度',         unit: '',   group: '吸积盘', min: 0,    max: 1,    step: 0.01, def: 0.85, uniform: 'uTurb' },
  { key: 'noiseScale',  label: '湍流尺度',         unit: '×',  group: '吸积盘', min: 0.4,  max: 2.5,  step: 0.05, def: 1.0,  uniform: 'uNoiseScale' },
  { key: 'diskSpeed',   label: '盘面流速',         unit: '×',  group: '吸积盘', min: 0,    max: 4,    step: 0.05, def: 1.0,  uniform: null },
  { key: 'temperature', label: '内缘温度',         unit: 'K',  group: '吸积盘', min: 2000, max: 20000, step: 100, def: 4700, uniform: 'uTempK' },
  { key: 'diskGain',    label: '盘面亮度',         unit: '',   group: '吸积盘', min: 0.1,  max: 8,    step: 0.05, def: 3.6,  uniform: 'uDiskGain' },
  { key: 'absorption',  label: '吸收/遮蔽',        unit: '',   group: '吸积盘', min: 0,    max: 4,    step: 0.05, def: 2.0,  uniform: 'uAbsorb' },
  // --- relativity ---
  { key: 'doppler',     label: 'Doppler 增亮',     unit: '',   group: '相对论', min: 0,    max: 1,    step: 0.01, def: 1.0,  uniform: 'uDoppler' },
  { key: 'redshift',    label: '引力红移',         unit: '',   group: '相对论', min: 0,    max: 1,    step: 0.01, def: 1.0,  uniform: 'uRedshift' },
  // --- sky ---
  { key: 'starDensity', label: '星点密度',         unit: '×',  group: '星空',   min: 0.4,  max: 2.5,  step: 0.05, def: 1.0,  uniform: 'uStarDensity' },
  { key: 'starGain',    label: '星点亮度',         unit: '',   group: '星空',   min: 0,    max: 4,    step: 0.05, def: 1.0,  uniform: 'uStarGain' },
  { key: 'galaxyGain',  label: '银河亮度',         unit: '',   group: '星空',   min: 0,    max: 4,    step: 0.05, def: 1.0,  uniform: 'uGalaxyGain' },
  // --- lens / post ---
  { key: 'exposure',    label: '曝光',             unit: 'EV', group: '镜头',   min: -3,   max: 3,    step: 0.05, def: 0.0,  uniform: null },
  { key: 'bloom',       label: 'Bloom 强度',       unit: '',   group: '镜头',   min: 0,    max: 2,    step: 0.01, def: 0.55, uniform: null },
  { key: 'bloomThreshold', label: 'Bloom 阈值',    unit: '',   group: '镜头',   min: 0,    max: 4,    step: 0.05, def: 0.9,  uniform: null },
  { key: 'vignette',    label: '暗角',             unit: '',   group: '镜头',   min: 0,    max: 1,    step: 0.01, def: 0.55, uniform: null },
  { key: 'grain',       label: '胶片颗粒',         unit: '',   group: '镜头',   min: 0,    max: 1,    step: 0.01, def: 0.35, uniform: null },
  { key: 'aberration',  label: '色散',             unit: '',   group: '镜头',   min: 0,    max: 1,    step: 0.01, def: 0.3,  uniform: null },
];

export const PARAM_MAP = Object.fromEntries(PARAMS.map((p) => [p.key, p]));

export function defaultParams() {
  return Object.fromEntries(PARAMS.map((p) => [p.key, p.def]));
}

export function clampParam(key, value) {
  const p = PARAM_MAP[key];
  if (!p) return undefined;
  const v = Number(value);
  if (!Number.isFinite(v)) return p.def;
  return Math.min(p.max, Math.max(p.min, v));
}

export const QUALITY = {
  standard:  { label: 'Standard',  maxSteps: 260, octaves: 3, volQ: 0.85, renderScale: 0.5,  dprCap: 1.25, bloomLevels: 5, stepScale: 1.25 },
  high:      { label: 'High',      maxSteps: 420, octaves: 4, volQ: 1.0,  renderScale: 0.72, dprCap: 1.75, bloomLevels: 6, stepScale: 1.0 },
  cinematic: { label: 'Cinematic', maxSteps: 700, octaves: 5, volQ: 1.45, renderScale: 1.0,  dprCap: 2.0,  bloomLevels: 7, stepScale: 0.75 },
};
export const QUALITY_ORDER = ['standard', 'high', 'cinematic'];

// camera presets: distance (M), elevation above disk plane (deg), azimuth (deg), vertical fov (deg)
export const VIEW_PRESETS = [
  { id: 1, name: '掠射 Edge-On',     dist: 32, elev: 5,   az: -12, fov: 36 },
  { id: 2, name: '倾斜 Inclined',    dist: 42, elev: 21,  az: 30,  fov: 40 },
  { id: 3, name: '极向 Polar',       dist: 48, elev: 80,  az: 0,   fov: 40 },
  { id: 4, name: '近距掠过 Close',   dist: 15, elev: 9,   az: 55,  fov: 70 },
];

export const DEBUG_VIEWS = [
  '0 · 最终合成 Beauty',
  '1 · 仅吸积盘发射',
  '2 · 频移因子 g (Doppler × 引力)',
  '3 · 积分步数热图',
  '4 · 出射方向（偏折）',
  '5 · 盘面穿越次数',
  '6 · 观测温度 / 光学深度',
  '7 · 透镜化星空（无盘）',
  '8 · 冲量参数 b / b_crit',
  '9 · Bloom 缓冲',
];
