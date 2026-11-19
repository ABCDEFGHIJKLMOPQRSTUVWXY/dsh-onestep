# P4 验证套件（p4:verify / m1-m6）

P4 动效优化的端到端验证套件。计划与门禁：`docs/p4-plan.md` §2.3（动作时长表）、§4（技术设计）、
§5 G3-G9、§8（证据与命令）。P4-1 探针证据：`artifacts/p4/probe/`、`docs/p4/motion-probe.md`。

## 命令

```bash
# 隔离实例（端口 4650；token 每次重启轮换，套件每次从 artifacts/p3/server-url.txt 重读）
pwsh -NoProfile -File scripts/p3/probe/server.ps1 -Action start

# 全量（m1-m6 顺序执行，汇总 artifacts/p4/verify/run-all.json；任一失败退出码 1）
node scripts/p4/verify/run-all.mjs

# 子集
node scripts/p4/verify/run-all.mjs --only=m1,m6
node scripts/p4/verify/run-all.mjs --list

# 单套件（各自写 artifacts/p4/verify/<suite>.json）
node scripts/p4/verify/m1-morph.mjs
```

前提：`client.js` 已由 `node scripts/build.mjs` 重建并包含当轮 P4 源码；实例新页面即加载新 bundle。
本套件不启动/重启实例、不重建 client.js、不改 `src/**`、`package.json`。

## 套件清单

| 套件 | 门禁 | 覆盖 | 产物 |
|---|---|---|---|
| `m1-morph.mjs` | G3 | 4 窗场景 promote/demote/cycle/close/evict/add 六路径：VT 组时长（220/160ms）与 old/new 交叉（old 60ms 快出、new 120ms+40ms 延迟；被提升窗 old 1ms/new delay 0）、**非线性曲线（伪元素计算样式 = cubic-bezier(0.22,1,0.36,1)）**、**方向性闪修复（被降级卡 new delay 150ms）**、结束几何（DOM vs `actions.layout()` ≤0.5px + 基线槽位）、snapshot 正确、关键帧 0/110/220ms 内容防闪（theme-aware 相对判据）、快速连切 5 次（允许 VT/skip 混合）、VT 命名唯一性、reduced 不启动 VT、**jank 回归：降级候场卡 `data-preview=live` 不得发生在 VT 回调/动画窗口内（6 路径）** | `m1-morph.json` + `shots/m1-*.png`（含 0.4.2 方向性关键帧 `kf-*.png`） |
| `m2-stage.mjs` | G4+G5 | 舞台进场 `onestep-stage-in` 260ms（`data-ready=1`、焦点/栏进场动画）、栏收展 VT `onestep-rail` 220ms、分隔条 hover 120ms、落点高亮 120ms（dragover 派发路径）、flash `onestep-flash` 1200ms×1 + 1400ms 自动清除、气泡进 180ms/出 120ms（产品态 `clearBubble`）、控制点 hover 120ms、idle 插件自有 infinite=0 | `m2-stage.json` |
| `m3-overlays.mjs` | G6 | 快速条 180/120（computed + 运行期 CSSTransition）、菜单 `onestep-menu-in` 120ms + 关闭 ≤50ms、picker mask 120ms / panel 160ms + 关闭 ≤50ms（`actions.openPicker/closePicker`）、toast 160ms+1000ms 淡出 + `role=status`、HUD 140ms（静态规则/token，partial） | `m3-overlays.json` |
| `m4-peek.mjs` | G7 | 伴生浮窗收起 180ms transform 过渡（中间值采样、终态出视口）、标签 hover 无布局动画（宽 38px、标题浮层 opacity）、恢复（`data-onestep-peek-restoring` + 180ms + 清理）、reduced 0s/立即、P3 回归（inert/aria-hidden/pointer-events 注入与还原、标签层、舞台不重排） | `m4-peek.json` |
| `m5-reduced.mjs` | G8 | 设置 always/system 双路径（html 属性、mode、菜单文案）、reduced 下 promote=instant 且 VT 调用 0、插件自有 running/infinite=0、系统 media 路径（`emulateMedia`）、刷新持久（`dsh.onestep.v1`）、reduced context 启动路径 | `m5-reduced.json` |
| `m6-perf.mjs` | G9 | idle rAF 基线、空回调 VT 对照（VT 长任务=0）、3 个真实 morph 测量点（受官方内容挂载长任务污染时自动重试）：VT 快照开销（ready−callbackEnd）P95 ≤20ms、干净帧 P95 ≤ idle P95+4ms（剔除回调分相与官方提交长任务窗口，跨 run 合并）、500ms 后插件自有动画=0、退出舞台后无 `:root --onestep-vt-*`/内联命名/`data-onestep-motion` 残留 | `m6-perf.json` |

`run-all.json` 结构：`{ ok, baseline(client.js sha/版本/环境), suites:[{suite, ok, exitCode, durationMs, summary, failedAssertions[{name,expected,actual}], skips}], failed }`。
每个 suite JSON 沿用 P3 `Results` 风格（`steps/assertions/skips/metrics/screenshots/pageErrors`）。

## 预算与判据（P4-1 标定，Lead 口径）

- VT 组时长：promote/cycle/demote 220ms；close/evict/add 160ms；old/new 交叉 120ms（new delay 60ms）。
  注：old-only（close/evict）/new-only（add）路径 Chrome 可能不生成该元素的 `::view-transition-group` 动画，
  套件改断言「元素以 old/new 快照参与 + 本次 VT 所有 group 动画均为 kind 时长」。
- 结束几何：DOM rect vs `actions.layout()` ≤0.5px；焦点/候场槽位与初始基线一致（≤0.5px）。
- 内容防闪：theme-aware **相对**判据（浅色主题整页白是正常，禁止绝对白像素比例）：
  post 有内容（std≥5、颜色桶≥24）；t110 vs post 亮度相对差 ≤0.10、颜色桶比 ≥0.5、std 比 ≥0.3、meanAbsDiff ≤25；
  动画结束帧 vs post 亮度相对差 ≤0.02、meanAbsDiff ≤5、颜色桶比 ≥0.9。
- 性能：VT 快照开销 = `ready − 回调结束时刻`（P4-1 `readyOverheadMs` 同口径，不含回调前旧快照抓取）P95 ≤20ms；
  ready 全量记录 + 软门禁 readyP95 ≤ 官方提交 P95+40ms；干净帧剔除回调分相与 >50ms 官方提交长任务窗口
  （窗口前后各扩 50ms 恢复期）后跨 run 合并 P95 ≤ idle P95+4ms；真实 morph 的长任务只记录不判失败（归因官方提交/内容挂载）；
  空回调 VT 长任务必须为 0。
  **噪声处理**：官方内容挂载长任务若落在快照抓取窗口 `[callbackEnd, ready]` 内，该次 overhead 已被外部主线程占用污染
  （非 VT 成本），m6 自动重试该测量点（最多 4 次尝试，`m6.perf.attempts` 记录全部尝试与污染长任务）；干净帧断言要求
  合并样本 ≥8；跨 run 合并以降低单次内容挂载噪声。
  **环境污染降级**：若本次 morph 出现 ≥200ms 的官方提交/内容挂载长任务（或测量点被其污染），VT 开销与干净帧断言
  自动降级为 `skip`（指标仍写入 `m6.perf.environment` / `m6.perf.runs` / `m6.perf.frames`），避免把环境噪声判成回归；
  `ready` 全量只记录（`m6.perf.ready-soft` metric），不作硬门禁。降级会在运行输出与 JSON 中明确标注。
- reduced：VT 调用数 0、`controller.last.route` 非 vt、无伪元素动画、插件自有 running/infinite=0。
- 抖动策略：显式等待谓词 + 超时（`waitFor/poll`），关键帧一律「暂停 getAnimations + currentTime seek」确定性截图；
  每个 suite `finally` 关闭浏览器并恢复暂停动画；只写 `artifacts/p4/verify/**`。

## 已知限制（记录为 skip/partial，非失败）

1. **插件 dispose 无法 e2e 触发**（宿主生命周期）：m6 覆盖舞台卸载后的清理；dispose 代码路径（移除
   `data-onestep-motion`/media 监听/peek 层）由代码 review 确认。
2. **拖拽 HUD 运行态**需要真实 pointer 拖拽（headless 不稳定）：m3 用「CSS 规则 + `--onestep-hud=140ms` +
   drag.js 无裸时长字面量」三条静态断言覆盖（partial）。
3. **系统 media 路径**：Playwright `emulateMedia` 已实测会触发插件 `matchMedia` change 监听；个别时序下
   「emulateMedia→立即轮询」可能读不到属性，m5 在切换后先给 150ms+150ms 稳定窗口再轮询（带 3 次重试），
   不属于产品缺陷。
4. **reload 后官方主绑定可能处于「父会话已离线」重连态**（composer disabled）：持久化用例只要求 composer
   挂载（attached）+ 插件探针面就绪，不要求可输入。
5. 环境为 headless Edge（msedge channel），idle rAF 基线约 17.5-18ms（≈57fps）；帧率门禁按同次运行 idle 基线 +4ms，
   CI/负载环境以实际基线为准。
6. **交换动画的点击冻结约 150–260ms**（官方主绑定提交 + VT 快照抓取，架构性；官方 focus 信号 82–97ms，其后为 StageRoot 重挂载提交；插件侧已把 live 缩略挂载移出动效窗口）。诊断与 P5 建议见 [docs/p4/jank-fix.md](../../../docs/p4/jank-fix.md)；m1 的 `deferred-live-not-during-morph`、`vt-group-easing`、`vt-demoted-card-delayed` 防回归。
7. **重负载机器上官方内容挂载长任务可达 300-700ms**：m6 的 VT 开销/干净帧断言会降级为 skip（见上「环境污染降级」），
   此时 G9 的硬证据由 P4-1 探针（`artifacts/p4/probe/`，VT 开销 P95 6.5ms、干净帧 18.1ms）与清理断言共同承担。

## 文件

```text
scripts/p4/verify/
  lib.mjs           共享库：P3 链路复用、Results、页面运行时 window.__V（几何/动画/vt watch/关键帧/命名/peek 采样）、图像区域统计
  m1-morph.mjs      G3
  m2-stage.mjs      G4+G5
  m3-overlays.mjs   G6
  m4-peek.mjs       G7
  m5-reduced.mjs    G8
  m6-perf.mjs       G9
  run-all.mjs       m1-m6 顺序执行 + 汇总
artifacts/p4/verify/
  m*.json          单套件结果
  run-all.json     汇总
  shots/           关键帧截图（m1-*）
```
