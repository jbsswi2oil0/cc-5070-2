# 共同取景发行证据 · 共同取景发行 · 镜头演示发布

- 发行编号：`shared-framing-2026-11-15`
- 生成时间：2026-11-15T09:14:45.473Z
- 运行地址：http://127.0.0.1:4173/
- 执行目录：净目录（临时副本） · 源码 `36cfadb18f1bb009d4a18dbb1779e265fe9a875d`
- 结论：**PASS（可采纳产物）**
- 通过：33/33
- 产物策略：共同取景失败禁止采用产物；只有原始记录核验通过后才允许采纳构建。

| 检查 | 项 | 结果 | 细节 |
| --- | --- | --- | --- |
| `build` | 生产构建 | 通过 | ok |
| `serve` | 启动运行配置指向的服务 | 通过 | http://127.0.0.1:4173/ |
| `boot.controller` | 控制器实际执行（非预设机位） | 通过 | solves=3 scenario=deployment status=fitted |
| `initial.actors_present` | 角色数据齐全 | 通过 | 4 名必需角色齐全 |
| `initial.body_size_spread` | 不同体型部署 | 通过 | 身高差 0.62m≥0.45 · 半径差 0.24m≥0.15 |
| `initial.fov_limits` | 视场限制读取 | 通过 | fov=38.06°∈[6,44] h=63.03°≤74 d=4.42 |
| `initial.safe_range` | 目标屏幕安全区范围 | 通过 | left=0.080 right=0.920 top=0.080 bottom=0.920 |
| `initial.target_bounds` | 目标边界与安全区对应 | 通过 | tall:in short:in broad:in slim:in |
| `initial.body_boxes` | 包围框为真实身体投影（非点） | 通过 | 高个 180×427px/1490 · 矮个 100×272px/1490 · 宽体 201×374px/1490 · 瘦高 93×368px/1490 |
| `initial.fitted` | 聚合状态完整入画 | 通过 | status=fitted in=4/4 |
| `gui.reframe` | 界面按钮调用共同取景实现 | 通过 | solve 3→4 status=fitted bounds=4 actors |
| `gui.margins` | 界面滑杆改边距参与求解 | 通过 | leftPx 88.3→132.5 topPx 49.7→74.5 margin=0.120 |
| `gui.drag_multi` | 画布内移动多名角色并重解 | 通过 | 移动 tall,slim · solves 12→37 |
| `dragged.safe_range` | 目标屏幕安全区范围 | 通过 | left=0.080 right=0.920 top=0.080 bottom=0.920 |
| `dragged.target_bounds` | 目标边界与安全区对应 | 通过 | tall:in short:in broad:in slim:in |
| `dragged.body_boxes` | 包围框为真实身体投影（非点） | 通过 | 高个 70×162px/1490 · 矮个 31×85px/1490 · 宽体 57×108px/1490 · 瘦高 50×194px/1490 |
| `realtime.playback` | 实时相机运行器逐帧重解 | 通过 | 11/16 帧相机移动 · 角色位移=有 · 状态 fitted/tradeoff |
| `dispersed.tradeoff` | 目标分散触发显式取舍 | 通过 | status=tradeoff fov=44.0 clipped=short |
| `dispersed.fov_limits` | 视场限制读取 | 通过 | fov=44.00°∈[6,44] h=71.38°≤74 d=16.00 |
| `dispersed.safe_range` | 目标屏幕安全区范围 | 通过 | left=0.080 right=0.920 top=0.080 bottom=0.920 |
| `dispersed.target_bounds` | 目标边界与安全区对应 | 通过 | tall:in short:out broad:in slim:in |
| `dispersed.body_boxes` | 包围框为真实身体投影（非点） | 通过 | 高个 38×83px/1490 · 矮个 40×88px/1490 · 宽体 29×56px/1490 · 瘦高 43×176px/1490 |
| `dispersed.outside_safe` | 取舍时确有目标越过安全区（真实边界） | 通过 | tall:in short:out broad:in slim:in |
| `gui.reframe_dispersed` | 界面按钮在分散态复算仍为取舍 | 通过 | status=tradeoff solves 108→109 |
| `recluster.fitted` | 重新聚合恢复完整入画 | 通过 | status=fitted in=4/4 |
| `recluster.safe_range` | 目标屏幕安全区范围 | 通过 | left=0.080 right=0.920 top=0.080 bottom=0.920 |
| `recluster.target_bounds` | 目标边界与安全区对应 | 通过 | tall:in short:in broad:in slim:in |
| `recluster.body_boxes` | 包围框为真实身体投影（非点） | 通过 | 高个 74×181px/1490 · 矮个 45×120px/1490 · 宽体 81×154px/1490 · 瘦高 38×161px/1490 |
| `legacy.plaza` | 旧样例 plaza 运行到底 | 通过 | b1:fitted b2:fitted b3:fitted b4:fitted |
| `legacy.stagger` | 旧样例 stagger 运行到底 | 通过 | b1:fitted b2:fitted b3:fitted b4:fitted |
| `legacy.wide-spread` | 旧样例 wide-spread 运行到底 | 通过 | b1:tradeoff b2:tradeoff b3:tradeoff b4:tradeoff |
| `legacy.two-shot` | 旧样例 two-shot 运行到底 | 通过 | b1:fitted b2:fitted b3:fitted b4:fitted |
| `runtime.errors` | 运行期无页面错误 | 通过 | none |
