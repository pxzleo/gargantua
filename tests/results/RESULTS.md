# GARGANTUA 验收结果

通过 24/24 · 用时 273.3 s · Chromium headless (SwiftShader)

| 结果 | 用例 | 详情 |
|---|---|---|
| ✅ | 四个视角预设渲染（非黑屏 / 中心阴影深黑 / 盘面高亮） | P1 max=250 mean=27.47 std=38.82 centre=1.13 bright=0.0132; P2 max=254 mean=23.64 std=45.69 centre=6.92 bright=0.0199; P3 max=223 mean=31.74 std=45.08 centre=1.64 bright=0.0031; P4 max=246 mean=33.22 std=47.55 centre=0.64 bright=0.0174 |
| ✅ | 0–9 调试视图均有有效输出 | 0:27.31/38.8 1:19.28/41.25 2:102.0/73.79 3:107.03/15.62 4:110.49/25.73 5:80.49/64.05 6:70.78/58.63 7:5.55/9.53 8:85.34/56.44 9:5.85/22.54 |
| ✅ | 盘面湍流随时间演化（t=0 vs t=60 画面不同） | mean /Δ/ = 9.55 |
| ✅ | 参数接口生效（关闭 Doppler/红移改变画面） | mean 22.04 → 25.91 |
| ✅ | 三档画质着色器编译切换 Standard/High/Cinematic | standard:True rt=400x225, high:True rt=576x324, cinematic:True rt=800x450 |
| ✅ | capture() 截图接口返回 PNG | 809442 chars |
| ✅ | WebGL 上下文丢失 → 自动恢复并继续渲染 | lost=True overlay_opacity=1 after: mean=31.01 std=40.5 |
| ✅ | 上下文永久丢失 → 4 秒后替换画布并重建渲染器 | lost=True → 新画布重建, canvases=1, mean=31.57 std=40.82 |
| ✅ | URL 自动化参数（cam/debug/p_*/t/quality） | {"pose": {"dist": 24, "elev": 12.0, "az": 40.0, "fov": 50, "roll": 0}, "debug": 3} |
| ✅ | 分享链接包含当前参数 | http://localhost:8080/?quality=standard&cam=24%2C12%2C40%2C50&debug=3&p_diskOuter=40&p_temperature=6000 |
| ✅ | 默认电影镜头循环运动 + 实时帧循环 | az -12.05→-12.38, frames 4→8 |
| ✅ | 鼠标拖拽 OrbitControls 环绕并接管电影镜头 | cine=False az -14.4→-51.3 |
| ✅ | 滚轮推近（最小距离受限） | dist 34.14→18.45 |
| ✅ | 快捷键 0–9 / Shift+1–4 / C / Space / P / H / ? / Esc / Q | 5→debug5, Shift+3→elev 79.5, C True/False, Space ok, P panel, H ui, ? help, Q standard→high |
| ✅ | 参数滑块 + R 重置 | diskOuter=44, grain after R=0.35 |
| ✅ | S 键保存 PNG 截图 | gargantua-2026-10-07T09-02-01-436Z.png 686982 bytes |
| ✅ | 氛围音乐开关（Web Audio 渐入播放） | aria-pressed=true |
| ✅ | localStorage 状态持久化（刷新后恢复） | restored diskOuter=38 bloom=1.1 debug=2 |
| ✅ | 移动端（iPhone 13 视口 / 触摸 / Retina 上限） | quality=standard dpr=1.25 canvas=488x830 overflow=False |
| ✅ | Retina（DPR=2 → High 档上限 1.75） | dpr=1.75 canvas=1400x788 rt=1008x567 |
| ✅ | 着色器编译失败 → 自动逐级降级画质 | cinematic✗ → high✗ → standard✓ (onShaderError 捕获，控制台错误 0 条) |
| ✅ | 不支持 WebGL2 时显示说明页（非黑屏） | 此浏览器不支持 WebGL2 |
| ✅ | 音频资源可访问 | ogg 1173788 B, mp3 1281089 B |
| ✅ | 全程无控制台错误 |  |
