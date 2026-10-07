# GARGANTUA — Schwarzschild Black Hole Raytracer

全屏实时黑洞光线追踪网站。画面每个像素都在片元着色器里**数值积分一条 Schwarzschild 零测地线**，沿弯曲光路穿过**体积化、湍流、相对论频移的吸积盘**做发射-吸收积分，最后落到程序化星空上。没有黑球、平面圆环、贴图、视频或截图。

原生 HTML / CSS / JavaScript + ES Modules + 本地 three.js r186，**无需构建**。

## 启动

```bash
cd gargantua
node serve.mjs            # 零依赖静态服务器 → http://localhost:8086/，同时打印局域网地址
node serve.mjs 8086 127.0.0.1   # 仅本机访问
# 或
python3 -m http.server 8086
```

需要支持 WebGL2 的浏览器：Chrome、Edge、Firefox，或 Safari 16 及以上。请勿直接双击 `index.html` 用 `file://` 打开，因为 ES Modules 必须通过 HTTP 加载。

## 目录

```
index.html                 页面骨架、HUD、参数面板、帮助、遮罩层
css/style.css              界面样式（含移动端底部抽屉、安全区）
js/main.js                 启动、帧循环、UI、快捷键、持久化、错误恢复、自动化 API
js/engine.js               渲染管线：光追 → 时间累积 → Bloom → 自动曝光 → 合成
js/camera-rig.js           OrbitControls、预设飞行动画、电影镜头循环（Catmull-Rom）
js/params.js               21 项参数、画质档、视角预设、调试视图定义
js/audio.js                可选氛围音乐（Web Audio 渐入渐出）
js/shaders/blackhole.js    核心：测地线积分 + 体积吸积盘 + 星空
js/shaders/post.js         Bloom（双重滤波）、时间累积、测光、ACES 合成
js/shaders/common.js       哈希/噪声/黑体色/Turbo 色图
vendor/three/              three.module.js + three.core.js + OrbitControls（MIT）
assets/audio/              gargantua-ambient.ogg / .mp3（原创，64 s 无缝循环）
tools/make_audio.py        音乐的 numpy 合成脚本（可复现）
serve.mjs                  零依赖静态服务器（支持 Range，便于音频）
tests/                     Playwright 验收测试、截图工具与结果
```

## 物理模型

单位 G = c = M = 1：事件视界 r = 2M，光子球 r = 3M，ISCO r = 6M。

- **零测地线**：Schwarzschild 中光子空间轨道满足 `u'' + u = 3u²`（u = 1/r）。该方程可由笛卡尔方程 `x'' = −(3/2)·h²·x/|x|⁵` 精确复现，其中 h = |x × x'| 守恒。积分器采用自适应步长的辛蛙跳（kick-drift-kick），步长随 r − 2M 收缩，在光子球附近加密。
- **捕获判据**：r < 2.02M 即落入视界。另有一条精确判据：光子在光子球内（r < 3M）向内运动时必然落入，因此可提前终止，这也省下了光子环附近的步数预算。
- **观测者修正**：把静止观测者看到的局部方向换算成测地线的冲量参数 b = r·sinθ / √(1 − 2/r)，从而让阴影角半径严格等于 `sin α = (3√3/r)·√(1 − 2/r)`。HUD 上会实时显示这个值。
- **体积吸积盘**：标高 H = (H/r)·r。密度由三部分组成：
  - 径向轮廓 ∝ r^−1.5，内缘与外缘平滑过渡；
  - 随噪声起伏的高斯垂直结构，形成"云顶"；
  - 方位向周期（无接缝）fbm、低频域扭曲与脊状噪声，分别形成丝状结构和团块。

  气体按开普勒角速度 Ω = r^−3/2 差动旋转，用两个相位错开的样本交叉淡化，防止剪切无限缠绕。
- **辐射转移**：沿光路做发射-吸收积分。热中层主要负责发射；较冷的云顶和外盘主要负责吸收，由此产生遮蔽和暗带。光线可以多次穿越盘面，所以主像、盘下方的二次像和更高阶像都会自然出现（调试视图 5 可直接查看穿越次数）。
- **频移**：g = δ_Doppler · g_grav。
  - Doppler 因子 δ = 1/(γ(1 + β·d̂))，轨道速度 β = 1/√(r − 2)；
  - 引力红移 g_grav = √(1 − 2/r) / √(1 − 2/r_cam)；
  - 观测温度 T_obs = g·T，按黑体色着色；强度 ∝ g^3.6（接近 g⁴ 的 Doppler 增亮）。
- **温度轮廓**：T ∝ (r/r_in)^−3/4，并叠加湍流热斑。
- **星空**：三层哈希星点（黑体色温，按分辨率做能量守恒的角尺寸）、银河带、核球、尘埃带和星云。星空用光线最终的出射方向采样，因此引力透镜是自然产生的。

## 渲染管线

1. **光追**：输出到 HalfFloat HDR 目标，渲染分辨率 = 画质比例 × 动态分辨率。
2. **时间累积**：带 Halton 子像素抖动。
   - 画面静止时渐进收敛，最多累积 48 帧；
   - 运动时用 TAA 式混合，并对邻域做钳制以防拖影；
   - 跳变时立即重置。
3. **双重滤波 HDR Bloom**：第一级做 Karis 平均以抑制萤火虫，并带软阈值；5–7 级下采样，再用帐篷滤波上采样。
4. **自动曝光**：1×1 中心加权测光，再经时间平滑，"曝光"参数作为 EV 补偿叠加其上。
5. **合成**：径向色散 → Bloom → ACES Fitted（Hill）→ 暗角 → sRGB → 随亮度变化的胶片颗粒 → 8-bit 抖动。

## 交互

| 操作 | 功能 |
|---|---|
| 拖拽 / 双指 | 环绕黑洞（立即接管电影镜头） |
| 滚轮 / 捏合 | 推近 / 拉远（7.5M – 160M） |
| Shift + 1–4 | 视角预设：掠射 Edge-On · 倾斜 Inclined · 极向 Polar · 近距 Close |
| 0 – 9 | 调试视图 |
| C | 电影镜头循环（76 s，7 个关键帧，带 roll） |
| Space | 暂停 / 继续盘面时间 |
| Q | 循环切换画质 |
| H | 隐藏 / 显示全部界面 |
| P | 参数面板 |
| M | 氛围音乐 |
| S | 保存 PNG 截图 |
| R | 重置参数 |
| F | 全屏 |
| ? / Esc | 帮助 / 关闭 |

滑块双击可恢复该项默认值；面板中的"复制链接"会生成带当前参数的 URL。

### 21 项参数

- **吸积盘**：内缘半径、外缘半径、盘厚 H/r、体积密度、湍流强度、湍流尺度、盘面流速、内缘温度、盘面亮度、吸收/遮蔽
- **相对论**：Doppler 增亮、引力红移（0 = 关，1 = 完整物理）
- **星空**：星点密度、星点亮度、银河亮度
- **镜头**：曝光（EV）、Bloom 强度、Bloom 阈值、暗角、胶片颗粒、色散

### 0–9 调试视图

0 最终合成 · 1 仅吸积盘发射 · 2 频移因子 g（红 = 红移 / 蓝 = 蓝移）· 3 积分步数热图 · 4 出射方向（偏折）· 5 盘面穿越次数 · 6 观测温度 / 光学深度 · 7 透镜化星空（无盘）· 8 冲量参数 b / b_crit（黑线为 3√3M 临界曲线）· 9 Bloom 缓冲

### 画质档

| 档位 | 最大步数 | 噪声倍频 | 渲染比例 | DPR 上限 | Bloom 级数 |
|---|---|---|---|---|---|
| Standard | 260 | 3 | 0.50 | 1.25 | 5 |
| High | 420 | 4 | 0.72 | 1.75 | 6 |
| Cinematic | 700 | 5 | 1.00 | 2.00 | 7 |

- 默认画质：桌面为 High，触屏和小屏设备为 Standard。
- 动态分辨率：Standard 和 High 在帧率低于 26 fps 时自动降分辨率，最低 50%；Cinematic 不自动降。

### 持久化

参数、画质、相机位姿、调试视图、HUD/面板状态和电影镜头开关都保存在 `localStorage`。加上 `?clean=1` 可忽略已保存的状态。

### 错误恢复

- **WebGL 上下文丢失**：显示恢复遮罩，在 `webglcontextrestored` 事件后重建资源。如果 4 秒内没有恢复，就替换画布并整体重建渲染器。
- **着色器编译失败**：按 Cinematic → High → Standard 逐级降级，并给出提示。
- **不支持 WebGL2 / 无法创建上下文**：显示说明页，保证不会出现黑屏。

## 截图自动化接口

### URL 参数

| 参数 | 说明 |
|---|---|
| `automation=1` | 确定性模式：忽略 localStorage，默认暂停，不播放电影镜头，按需渲染 |
| `frames=N` | 就绪前先累积 N 帧（默认 8） |
| `shot=1` | 同 automation；就绪后 `<html data-shot="ready">`，`document.title = "READY"` |
| `quality=standard\|high\|cinematic` | 画质 |
| `preset=1..4` | 视角预设 |
| `cam=dist,elev,az,fov` | 自定义相机（单位：M、度） |
| `debug=0..9` | 调试视图 |
| `t=秒` | 盘面时间（M） |
| `paused=0\|1` | 暂停 |
| `cine=0\|1`、`cinet=秒` | 电影镜头开关及起始时刻 |
| `ui=0`、`hud=0`、`panel=1` | 界面显示 |
| `p_<参数名>=值` | 任意参数，例如 `p_diskOuter=40`、`p_temperature=6000` |
| `scale=0.1..2` | 覆盖渲染比例 |
| `autoexp=0` | 关闭自动曝光 |
| `clean=1` | 不读取已保存状态 |

就绪信号：`document.documentElement.dataset.ready === "1"`。

示例：`http://localhost:8086/?automation=1&ui=0&quality=high&preset=1&t=40&frames=16`

### JS 接口 `window.GARGANTUA`

```js
await GARGANTUA.ready;
GARGANTUA.setPreset(2, /*instant*/ true);
GARGANTUA.setCamera({ dist: 20, elev: 8, az: 45, fov: 55 });
GARGANTUA.setParams({ diskOuter: 40, doppler: 0.5 });
GARGANTUA.setDebug(5); GARGANTUA.setTime(120); GARGANTUA.pause(true);
await GARGANTUA.setQuality('cinematic');
await GARGANTUA.renderFrames(16);           // 静止时渐进收敛
const png = await GARGANTUA.capture();       // data:image/png;base64,...
GARGANTUA.getState(); GARGANTUA.shareLink(); GARGANTUA.simulateContextLoss(600);
```

### 命令行截图

```bash
python3 tests/shoot.py "preset=1&quality=high&ui=0" out.png 1920 1080
```

## 测试

```bash
pip install playwright pillow      # Chromium 需可用（或设 CHROMIUM_PATH）
node serve.mjs 8080 &   # 测试脚本默认连 8080（可用 GARGANTUA_URL 覆盖）
python3 tests/run_tests.py         # 结果写入 tests/results/（截图 + RESULTS.md + results.json）
python3 tests/batch_shots.py out/ 1280 720 high   # 预设 + 调试视图联系表
```

在 Headless Chromium + SwiftShader（纯 CPU 软件渲染）下，**24/24 项全部通过**，全程无控制台错误。详见 `tests/results/RESULTS.md`，主视觉截图为 `tests/results/hero-high-*.png`。

## 说明与取舍

- 物理上做了以下简化：
  - 只模拟非旋转（Schwarzschild）黑洞，不含 Kerr 自旋；
  - 盘内缘以内按近似圆轨道速度处理；
  - 星空光不做蓝移；
  - 盘被当作发射-吸收介质，没有散射。
- 只要有任何可用 GPU，实际帧率都会远高于 SwiftShader 软件渲染。在中端独显上，High 档一般可流畅运行；手机默认使用 Standard 档，并启用动态分辨率。
- 第三方组件只有 three.js（MIT，见 `vendor/three/LICENSE`）。音乐为原创，由 `tools/make_audio.py` 合成，可自由使用。
