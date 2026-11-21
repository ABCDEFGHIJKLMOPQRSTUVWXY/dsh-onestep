# 变更日志

本文件记录 dsh-onestep 的可见变更。格式参照 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。

> 说明：本文件记录开发期全部可见变更。历史段落中的内部计划/审查文档（`docs/p0`–`docs/p4`、`docs/review/p0`–`p2`、legacy 长文）与本地证据制品（`artifacts/`、`tmp/`）属开发期材料，未随仓库发布，相关链接已移除或保留为纯文本。

## 版本策略

- **当前版本：`1.0.0`**——`0.7.0` 的全部能力（P2 收口 + P3 独立伴生浮窗 + P4 动效优化 + 候场上限解除与滚动（3→12）+ 点击换焦慢速占位动效 + 浮窗 8 向边缘缩放 + 收起标签整堆拖动 + 候场静态快照 + 已打开浮窗点击高亮）加上 2026-11-20 审查修复与工程门禁，是本项目的**首个公开发布版本**。
- **`0.7.0` 从未单独发布**：其段落保留为未发布历史基线，供对照构建与审查记录；P2/P3/P4（含 0.4.1/0.4.2 修复）与 0.5.0/0.6.x 的能力也都在历史段落中可查。`1.0.0` 起按 major/minor/patch 递增；0.x 时期新特性由 minor 承载。
- 本文件只给建议，实际版本以 `package.json` 为准（当前 `1.0.0`）。版本号变更后必须重建 `client.js`（产物内嵌版本常量）并重跑发布检查表 G1–G11。
- 公开发布后跟随后续 DSH rc：每次 rc 适配按 patch/minor 发布，破坏性变更走 minor；支持范围为「最新 rc + 上一个 rc」（见 README §8）。

## [Unreleased]

## [1.0.0] - 2026-11-20

> 状态：**首个公开发布版本，已在仓库内收口**——版本号、构建产物、文档与门禁在同一提交内完成；`npm publish`、GitHub Release 与远端推送属外向动作，需用户授权后另行执行。
> 内容：`0.7.0` 的全部能力（见下方 `[0.7.0]` 段落）+ 2026-11-20 审查修复与工程改进。
> 构建：`client.js` **347283 B / sha256 `5CA24A6E4FD0D00EE9926B10D823CEF9A55EB1D2ADF4290396C88B802CF14E2B`**（`node scripts/build.mjs` 逐字节复现，连续两次同哈希）；单测 **190/190**（18 个文件，自动发现）；i18n zh/en 各 **75** 键；发布自查 **33/33**、脱敏命中 0。
> npm 元数据：2026-11-21 补齐 `repository` / `homepage` / `bugs` / `keywords`，tarball 重打包为 **102496 B / sha256 `A7077DD04960252B1D608F0813BBC3654370A2083D2350630440038EDB501DA8`**（包内 `client.js` 未变）。

### Fixed

- 浮窗缩放中切换会话时，旧手势会读到新的会话 ID：手势固定所属会话与 panel，切会话、关闭舞台、收起或移除浮窗都取消旧手势，不再把旧窗口矩形提交给新会话。
- 官方重渲染移除插件缩放把手后缓存仍认为已初始化、无法再缩放：现在检查八向把手是否仍在，必要时清理旧监听并重建；同时观察浮窗删除，避免保留过期元素。
- 快速重复恢复、重新收起或卸载浮窗时取消了计时器却遗留恢复动画属性：取消计时器时同步移除恢复标记。
- 快照抓取间隔内新增任务、或前一个任务抛错，会绕过抓取间隔：改为间隔结束后再调度，失败任务走同一释放路径，卸载时取消默认回退计时器并保留显式零延迟。
- 已销毁的舞台 store 仍能接收延迟更新并重新安排持久化，覆盖后续实例的设置：销毁后阻止更新、订阅与写盘。
- `build:check` 只在内存编译，磁盘产物缺失或过期也会通过，且把字符数当字节数：改为逐字节比较磁盘产物，缺失或不一致即失败且不写盘，固定构建工作目录并使用 UTF-8 字节数。
- P4 验证器不解析 `p4:verify --only m1,m2` 的空格形式，混合有效/无效 suite 会静默忽略错误：同时支持空格与等号格式，拒绝空值、重复选项、未知 suite 与未知参数。

### Security

- 快速新建把输入前 80 字符写入诊断日志，而日志可随探针快照导出：现在只记录字符数与工作区 ID，正文仅交给官方草稿接口；同时等待宿主返回值，兼容异步失败透传。

### Changed

- `npm test` 自动发现 `tests/*.test.mjs`，避免新增测试被手写文件列表遗漏；新增 `npm run check` 串联全部单测、构建一致性、i18n、版本范围与文档检查。
- 新增 Node 22 / 24 的 GitHub Actions CI（工作流尚未在 GitHub 执行）；`.gitattributes` 固定客户端产物为 LF。
- 安全说明补全只读的官方浮窗存储键；开发文档同步构建检查语义。
- 独立性复验（2026-11-20）：在本机最终树上重跑 190/190 单测、构建逐字节一致、i18n、版本范围、文档检查与发布自查，全部通过；并在隔离 profile 上完成 tarball 安装/卸载演练与 F1/F2/CSS 定向回归（发布检查表 G8/G9 ✅）。详见[审查记录](docs/review/2026-11-20-review.md)与[发布检查表](docs/release/checklist.md)。

### Known limitations

- 与 `0.7.0` 相同（见其段落）；隔离 profile 上的 tarball 安装/卸载演练与 F1/F2/CSS 定向回归已复跑（G8/G9 ✅），桌面 App 内卸载/重装也已由用户确认（B4 ✅）；P3/P4 全量端到端套件仍未复跑，公开发布前建议补齐。

## [0.7.0] - 2026-11-19

> 状态：**未发布**（发布前已完成全量代码审查、版本兼容复核与打包演练，修复项见下 `Fixed`；用户反馈两项交互：收起标签只能拖顶部小把手、浮窗只能从右下角调整大小）。
> 构建：`client.js` sha256 `DD5527B883B543566836ED75A92979CFBDB9D3D526C75C31988EA9E58CFBEB7A`（341535 bytes，可由 `node scripts/build.mjs` 逐字节复现）；此前构建 `CC3D0F1C…F76993`（324696 bytes）的审查/打包证据保留在 `docs/release-evidence/`（0.7.0 发布前追加修复后需按发布检查表重生成）。

### Added

- **浮窗 8 向边缘缩放**（`src/client/float-resize.js`）：舞台浮动形态下给每个官方浮窗注入 8 个透明把手（左右上下边 + 四角，边带 6px / 角 12px）；手势在 float 元素 capture 阶段抢占，实时写内联几何预览，松手经官方 FloatLayer fiber `intents.resizeFloat` 提交一次官方 `resizeFloat`（含 x/y/width/height，可撤销、持久化、重渲染）；取不到 intents 时回退 controller 私有 `actionsFor`/store actions，仍失败则还原预览并日志。几何镜像官方口径：最小 220×140、西/北侧对边固定、东/南侧受视口限制、北侧不低于标题栏下沿；Esc 取消；点一下边缘（无位移）不提交。
- **已打开浮窗再次点击：高亮闪烁两下 + 抬升最上层**（`src/client/float-flash.js`、`service-wrap.js`、`index.js`、`styles.js`）：点击命中的伴生浮窗已展开时不再执行展开/恢复动作；包装层已管理分支先由 policy `onFocusManaged(record)` 触发高亮（`[data-onestep-float-flash]` + 240ms ×2 的 inset 光环动画），随后官方 `focus` 把该浮窗抬到 z 序最上层（官方 `focusTab` 对浮窗即 raise）；只刷新 LRU 聚焦时间，不改槽位/形态；减少动效设置下为一次静态高亮。收起态仍走单窗展开分支（两分支互斥）。
- **收起标签整堆拖动 + 松手吸附**（`src/client/peek-tags.js`、`peek-layer.js`）：在任意标签上按下并上下移动 ≥4px 即拖动整堆（不再只依赖顶部手柄；移动后抑制本次 click，点击仍按原语义恢复浮窗）；拖动只改纵向、标签层始终贴右缘；松手在 10px 阈值内吸附到上/下沿或默认安全位置（`snapPeekTop`），位置照旧持久化 `ui.peekTop`。

### Changed

- **候场卡缩略改为静态快照（用户要求）**：live 档不再给每张候场卡挂 live 官方内容，而是在隐藏宿主渲染一次官方聊天画面后克隆为静态快照；卡片之后只显示该快照，只有状态签名（blank / awaitingFirstTurn / 标题 / running / 完成未读 / 待处理类型）变化时才重拍。抓取串行 + 空闲调度（一次一张、间隔 140ms），抓取期间显示精简卡；滚动/拖宽/悬停/换焦期间不再挂载官方内容。菜单文案改为「静态快照候场」；内部档位值沿用 `live` 以兼容历史持久化。快照展示按 **contain** 缩放到卡片内容区：整张快照完整可见（比例不一致时居中留白），随卡片尺寸缩放、不裁切。
- **候场栏取消最大尺寸限制（用户要求）**：候场栏与焦点窗之间的分隔条现在可自由拖动——左侧栏只保留下限 200px、顶部栏下限 108px，不再有 320/220px 的上限；拖动或键盘 `End` 可一直放大到「焦点窗仍保持最小尺寸（480×320）」的最大可用值，窄舞台/刷新后由布局求解自动收窄，尺寸持久化不设上限。
- 收起标签拖动手柄文案更新为「调整收起标签位置（拖动标签或方向键）」（zh/en 同步）。
- P3 非公开扩展由「两层」扩为「三层」：新增浮窗矩形提交路径（fiber intents / 私有 store actions）。设计、回退矩阵与 rc diff 项见 `docs/architecture.md` §6.2/§6.4；README 与使用手册同步。

### Fixed

- **收起后再次点击链接不展开浮窗（0.7.0 追加修复，用户反馈）**：伴生窗全部收起（右缘标签）后，在焦点窗里再次点击同一文件/文档链接，官方会「揭示」既有 tab，但插件此前只补一次 focus，`data-onestep-peek` 的移出视口注入仍在，用户看不到任何变化。现在包装层在「已管理浮窗」分支先询问 policy 的新 hook `onRevealManaged(record)`：若该 tab 在插件状态里处于收起态，则走与点击标签相同的单窗恢复（清除 peek/inert/transform、更新状态、聚焦内容），返回 true 后不再重复 focus；未收起或 hook 异常时保持原来的 focus 抬升。只恢复命中这一窗，其余收起标签不动；显式 placement（`destination`/`paneId` 等）的调用按设计仍直通官方。
- **发布前审查修复（0.7.0 收口）**：
  - `styles.js` 13 条 CSS 规则被整行双引号包成字符串 token，浏览器视为无效 selector 前奏并连带吞掉随后的 `.onestep-rail-mini`——换焦占位内容、候场翻页按钮、收起态状态条共 14 条规则实际不生效。已去引号，并新增 `tests/styles.test.mjs`（4 条结构断言）防回归。
  - 收起态 `MutationObserver` 被自身同值 `setAttribute('data-onestep-peek','1')` 反复触发，形成约 54fps 的 rAF 重放循环（每帧多次查询与强制同步布局）。已加幂等注入与自触发过滤。
  - 提升「唯一候场」时 `candidates` 出现空数组中间态，导致同一 tick 内整舞台卸载再重挂载。已把「移出新焦点 + 旧焦点降级」合并为一次 store 提交。
  - 非慢速换焦路径会把被降级会话的 sessions 引用释放到 0（DSH 同步拆除 scope/generation，滚动位置与输入草稿存在丢失风险）。引用释放改为延后一个微任务并重算期望集合。
  - `persistStage=false` 时该设置本身不落盘，重启后按旧快照恢复舞台。改为始终写入设置、但不写入候场 roster。
  - 兼容性：DSH 以 `semver.satisfies(..., { includePrerelease: true })` 判定 `engines.dsh`，原上界 `<0.3.0` / `<0.2.2` 对 `0.3.0-rc.*`、`0.2.2-alpha.*` 实际放行（fail-open）。上界改为 `<0.3.0-0` / `<0.2.2-0`，`compat:engines` 门禁同步对齐宿主语义并用真实 semver 交叉校验。
  - 元数据一致性：`package.json` 描述与 README 表格残留「最多 3 个候场 / 满 3 淘汰」（实际 12）；`package-lock.json` 的 `engines.dsh` 未随 `package.json` 同步；`SECURITY.md` 首个公开发布版本仍写「待定稿 0.3.0」；`docs/p2/release/checklist.md` 一处相对链接断链（`../p3/` → `../../p3/`）。

### Known limitations

- 浮窗矩形提交依赖官方 FloatLayer fiber `intents.resizeFloat`（rc 漂移时回退 controller 私有 store actions；再失败只还原预览并记日志，不改变官方状态）——rc 升级需按契约清单做 diff。
- 缩放无键盘等价路径（与官方右下角缩放一致）；标签拖动只改纵向位置（始终贴右缘，不横向自由停靠）；吸附阈值 10px。
- 候场快照是**静态 DOM 克隆而非位图**：视觉等同截图、无 live 订阅；首次预览与每次状态变化仍需要挂载一次官方内容（约 0.15–0.4s/卡，串行，抓取完成前显示精简卡）。流式输出不会实时更新画面，等状态签名变化后重拍。
- 候场栏取消固定上限，但最大可用尺寸仍受焦点窗最小尺寸约束（左栏需给焦点窗留 480px、顶部栏留 320px）；舞台过窄时会按可用空间自动收窄候场栏（布局标记 `rail-collapsed`），不会挤压焦点窗到不可用。
- 「再次点击链接展开收起浮窗」只覆盖默认放置的打开（聊天里的文件/文档链接、工具卡、计划等）；调用方显式指定 `destination`/`paneId`/`preferNewPane`/`replaceTab` 时包装层按设计直通官方，不触发插件展开。
- 「已打开浮窗再次点击」的高亮闪烁是 CSS 动画（减少动效下退化为一次静态高亮），只提示可见性与层级；不改变浮窗内容/尺寸/布局，层级抬升由官方 `focus` 完成。
- 桌面 App 需重启/刷新载入新 `client.js` 后生效（构建版本 `0.7.0`；桌面实机复核见 README §9 与 docs/user-guide.md 排障段）。

### Evidence

- 单测 **172/172**（逐文件 `node <test>`：0.7.0 新增 `tests/float-resize.test.mjs` 8 条、`tests/peek-layer.test.mjs` 的 `peekTopRange`/`snapPeekTop` 2 条；发布前审查再增 `tests/styles.test.mjs` 4 条 CSS 结构回归；追加修复新增 `tests/service-wrap.test.mjs` 3 条 reveal-hook 用例；打开态高亮新增 `tests/float-flash.test.mjs` 5 条、wrapper 3 条、CSS 结构 1 条；候场栏自由尺寸新增 store 持久化用例 1 条并改写 layout 上限/保底断言；候场静态快照新增 `tests/preview-cache.test.mjs` 8 条（状态签名/快照缓存/串行调度器/contain 适配）；其余套件全绿）。
- 隔离实例 e2e **75/75**（`onestep-p0` @4650，真实 CDP 鼠标输入，0 pageerror）：
  - 收起后点链接展开：2 浮窗 → 全部收起（2 标签）→ 打开 README 链接 → README 展开为可见浮窗（非 inert / transform none / 回到槽位 / 记录 peeked=false / 标签 2→1，CHANGELOG 仍收起）→ 打开 CHANGELOG 链接 → 两窗均可见、标签 0 → 已可见时再次打开不改变收起集合（10/10）。证据 `artifacts/p3/verify/float-reveal-e2e.json`。
  - 已打开浮窗再次点击：点击后 120ms 内目标浮窗 `data-onestep-float-flash` 置位、`::after` 动画名 `onestep-float-flash` 且迭代 2 次；官方持久化 `layout.floats` 末位变为该窗（抬到最上层）；可见数/官方记录不变（不展开）；640ms 后标记移除、动画归 none；点击另一个浮窗同样闪烁并升顶；已可见时重复点击重新起播；全部收起后点击仍是展开且不闪烁（18/18）。证据 `artifacts/p3/verify/float-flash-e2e.json`。
  - 候场栏自由宽度：1440 视口下左栏真实鼠标拖到 638px（越过旧上限 320）且焦点窗 ≥480；设为 9999 时布局收窄到当前最大可用 660px、焦点窗 480；下限 200；键盘 End 到最大可用、Home 回下限；左栏 600px 刷新后保持；1259 视口顶部栏拖到 438px（越过旧上限 220），设为 9999 时收窄到 568px、焦点窗 320（26/26）。证据 `artifacts/p3/verify/rail-free-width-e2e.json`。
  - 候场卡静态快照：3 卡时 2/2 快照就绪、隐藏抓取源 0、1.5s 无状态变化时快照 HTML 完全一致；候场栏 232→320→232 重排不重拍；悬停 0 长任务。8 卡时 7/7 快照就绪、滚动 0 长任务（基线 live 2 个长任务/627ms，最大帧间隔 354ms）；换焦 5 个长任务/597ms（基线 live 12 个/1694ms），`focus-switch-content` 493→324ms；0 pageerror。证据 `artifacts/p3/verify/preview-snapshot-e2e.json`。
  - 既有能力回归：3 浮窗各 8 把手 → 收起 3 标签 → 拖标签 +120px / 位置持久化 / 右缘固定 / 不误触 click → 松手吸附 → 点击恢复单窗 → 西/北/右下角缩放与期望一致（其它窗不动）→ 官方 localStorage 矩形一致 → 刷新后尺寸恢复 → split 形态不注入把手（21/21）。证据 `artifacts/p3/verify/float-edge-e2e.json`。
  - 截图：`cdp-01-floats.png` … `cdp-06-after-reload.png`、`reveal-peeked.png` / `reveal-expanded.png`、`rail-wide-620.png`（仓库根，临时产物、未入包，可按需归档）。
- 构建：`scripts/build.mjs` 同构复现（esbuild 0.25.0 / cjs / chrome120 / 11 项 external），连续两次构建 sha256 相同；0.7.0 产物 sha 与仓库 `client.js` 一致。
- 发布前审查（同一构建）：隔离 profile `onestep-rel` 上 tarball 安装 → 启动 → 舞台冒烟 → 退出 → 卸载复核，证据 `artifacts/release-0.7.0/smoke/`；修复后二次验证（含 F1/F2 核心状态机与 CSS 生效回归）见 `artifacts/release-0.7.0/smoke2/` 与 `tmp/review/smoke2.md`。`npm run p3:verify` / `npm run p4:verify` 全套仍未在 0.7.0 构建上复跑（0.6.1 的 101/208 断言基线沿用），重点待补：peek-tags F1–F4、G8 标签样式、p4 m4-peek。

## [0.6.1] - 2026-11-19

> 状态：**未发布**（真实鼠标点击候场卡换焦：动画立即开始、官方聊天体重挂载在动画期间完成）。
> 构建：`client.js` sha256 `C14279E1D30329613E55163498C6539E3C38DEE5436E47E64FDE03A77D3360B6`（298436 bytes）；基线见 `artifacts/p4/verify/run-all.json`。

### Changed

- **点击换焦慢速 + 占位内容**（用户要求「点击后立即动画、动画期间重挂载」）：真实鼠标点击（`event.detail>0`）走新 `promoteClick` 路径，morph 时长 **320ms**（原 220ms）；VT 回调只提交**轻量占位焦点内容**（标题/状态 + 骨架，不挂官方聊天体），官方聊天体与官方主绑定切换都在动画播放期间完成。
- 实现：`MOTION.morphClick`/`MOTION_KINDS.promoteClick`；控制器新增 `onReady` 回调（动画开始时清理占位、挂真实内容）；index 新增 `focusPreviewSignal` + `focusSession` 慢速分支 + `applyFocusReport` 拆分；StageRoot 占位渲染、`freshlyDemoted` 同步按精简卡渲染（避免首次提交再挂一份聊天体）；慢速路径要求目标已 retain、VT 可用且当前无进行中过渡，否则回退原 220ms 路径。
- 键盘激活（`.click()`/Enter/Space）仍走原 220ms VT 路径；P2/P3/P4 门禁场景不受慢速路径影响。

### Known limitations

- VT 快照是静态图像：动画期间焦点窗显示**占位骨架**，真实聊天体虽已在动画期间挂载完成，但视觉上仍在动画结束前后才可见（无法在动效中途替换快照）。
- 动画开始前的旧画面静止约 **75–110ms**（快照抓取 ~35ms + 占位提交 ~40–65ms）；此前为 ~130–160ms，改善约 40–60ms。
- 点击路径总时长变长（320ms morph + VT 开销）；键盘路径仍 220ms。

### Evidence

- `artifacts/p5/click-slow.json` + `click-slow-mid-1260.png` / `click-slow-after-1260.png`：真实鼠标点击（1260×694@DPR1.75）VT 分相、占位/内容时间线、焦点/内容校验、呈现帧；`focus.clickSlow.*` 日志。
- `npm test` 137/137；`npm run p4:verify` m1-m6 全绿（208 pass / 0 fail / 4 skip）；`npm run p3:verify` 9/9、101/101；`npm run p2:verify` 81/82（唯一已知 `perf.drag-fps`）。

## [0.6.0] - 2026-11-18
> 状态：**未发布**（候场 3→12 + 滚动视口；管理员接受滚动，解除 6 个上限）。
> 构建：`client.js` sha256 `754DEA6E391AA02CD71F846CBB9D449CA7C340DFEC8B35A2CBE83C0E0B79E295`（292878 bytes）；基线见 `artifacts/p4/verify/run-all.json`。

### Changed

- **候场上限 6→12 + 滚动**：`LIMITS.maxCandidates` 12；超过候场栏可视容量时**保持可读卡尺寸**（左栏 232×164、顶部 153×108），左栏纵向/顶部横向滚动——滚轮、候场栏底部翻页按钮均可用；布局求解新增 `contentW/contentH`（内容长度）与真实 `scroll` 语义。
- **live 缩略虚拟化**：滚出视口的候场卡自动降为精简卡（不挂官方聊天体），滚入后恢复 live；12 候场实测同时仅 6 路 live（空闲 rAF p50 6.9ms / p95 7.1ms）。
- **快捷键**：`Ctrl+Alt+2…9` 提升第 1…8 个候场（Digit 只到 9；第 9 个起滚动后点击）；`compat:smoke` 期望快捷键数 13→15。
- **测试**：`tests/layout.test.mjs`（8 张左/顶滚动、6 张顶部仍完整）、`store.test.mjs`（12 上限/第 13 个 LRU/持久化截断 12）、`content.test.mjs`（LIMITS=12）；单测 136→137。
- **测试夹具**：P3/P4 的 `enterStage` 场景显式收敛到「1 焦点 + 3 候场」，避免上限提升后场景数量漂移（只改夹具，不改产品行为）。

### Known limitations

- 滚动位置不持久化（刷新后回到候场栏顶部）；`Ctrl+Alt+2…9` 只覆盖前 8 个候场，第 9 个起需滚动后点击/标题按钮提升。
- 滚入视口的卡会即时挂载 live 聊天体，快速滚动时可能有短促挂载开销；卡顿可在「…」菜单切「精简卡」或减少候场。
- 极窄/极矮舞台仍会滚动，但可视卡数减少；第 13 个候场仍 LRU 淘汰。

### Evidence

- `artifacts/p5/stage-scroll-probe.json` + `stage-scroll-initial-1260.png` / `stage-scroll-mid-1260.png` / `stage-scroll-promoted-1260.png`：12 候场、980×132 滚动视口、6 live + 6 card、滚轮与翻页按钮均改变偏移、12→13 LRU 验证、滚动后 promote 正常。
- `npm test` 137/137；`npm run p4:verify` m1-m6 全绿（208 pass / 0 fail / 4 skip）；`npm run p3:verify` 9/9、101/101；`npm run p2:verify` 81/82（唯一已知 `perf.drag-fps`）。

## [0.5.0] - 2026-11-18
> 状态：**未发布**（候场数量上限 3→6，管理员要求解除 3 个非焦点窗口限制）。
> 构建：`client.js` sha256 `26BF76B2C342AE6C7659E19044E8A15090E8C9BDF6A18B9006C2DABFEE56F88A`（285455 bytes）；基线见 `artifacts/p4/verify/run-all.json`。

### Changed

- **候场上限 3→6**：`LIMITS.maxCandidates` 6；候场 roster/布局求解/选择浮层/持久化（`normalizeState`）/LRU 淘汰统一按 6；第 7 个仍淘汰最久未用。默认布局与视觉保持不变（1 焦点 + 3 候场是最佳可读性配置；4–6 个时卡片按候场栏空间等比收缩）。
- **快捷键**：`Ctrl+Alt+2…7` 提升第 1…6 个候场；`compat:smoke` 期望快捷键数 10→13。
- **测试**：`tests/store.test.mjs`（上限 6 内不淘汰、第 7 个 LRU、持久化截断 6）、`tests/layout.test.mjs`（左栏/顶部 6 卡不越界不重叠）、`tests/content.test.mjs`（LIMITS=6）；单测 134→136。

### Known limitations

- **6 候场 = 7 路官方聊天体同时挂载**，实时缩略档（live）CPU/内存明显高于 4 窗；本次实测 1260×694@DPR1.75 空闲 rAF p50 6.9ms / p95 41.6ms。若出现卡顿，在焦点窗「…」菜单切「精简卡」，或减少候场数量。
- 极窄/极矮舞台下 6 张卡会低于设计最小尺寸（左栏 149×106、顶部 152×108 @980 宽）；建议收起候场栏或先减少窗口。
- 官方会话主绑定仍是单焦点；6 个候场均为 retain 的非焦点 occurrence，行为与 3 个时一致。

### Evidence

- `artifacts/p5/stage-6-probe.json` + `artifacts/p5/stage-6-candidates-1260.png`：7 会话进舞台（1 焦点 + 6 候场）→ 6 卡 152.7×108 @顶部栏，`withinStage=true`、`noOverlap=true`，焦点 980×550；第 8 个加入后候选数保持 6（LRU 淘汰）；6 候场下 promote 正常。
- `npm test` 136/136；`npm run p4:verify` 208 pass / 0 fail / 4 skip；`npm run p3:verify` 9/9、101/101；`npm run p2:verify` 81/82（唯一已知 `perf.drag-fps`）。

## [0.4.2] - 2026-11-13
> 状态：**未发布**（交换动画闪/重影修复 + 非线性曲线；发布动作待用户决策）。
> 构建：`client.js` sha256 `A0DE67C9234659F5741C750C099CB1EC0F0892CE7D6E910C94C7C0308FE17B10`（285311 bytes）；基线见 `artifacts/p4/verify/run-all.json`。

### Fixed

- **整页重影/闪**：VT 默认 root 交叉淡化会让侧栏等非窗口区域在首 120ms 出现双影 → `::view-transition-old(root)` 立即隐藏、`::view-transition-new(root)` 立即可见；命名窗口仍按快照动画。
- **非焦点窗口短暂放大遮盖窗口**：被降级窗口的新快照（候场卡）在焦点尺寸下淡入，形成「放大的卡片鬼影」→ 方向性快照交叉：被提升窗 old 快照 1ms 隐藏、new 立即淡入；被降级窗 new 延迟 150ms、80ms 淡入（等 group 收拢后再出现）。

### Changed

- morph 曲线改为非线性 `cubic-bezier(0.22,1,0.36,1)`（快出慢收）；old 快照 60ms 快出、new 120ms + 40ms 延迟；新增 `--onestep-ease-morph` / `--onestep-vt-old-fade` token。
- m1 新增断言：6 条 group 曲线（伪元素计算样式，防止退回 linear）、5 条方向性断言（被提升窗 old=1ms/new delay=0、被降级卡 delay=150ms）。

### Known limitations

- 点击 → 动画开始仍有约 **83–260ms 冻结**（0.4.1 实测 150–260ms，0.4.2 同环境复测 83–133ms，随官方提交/内容量波动；分解：官方 `openSession`→focus 信号 84–105ms（reduced 直切对照 69–98ms，n=8）+ StageRoot 重挂载 React 提交 + 新旧快照抓取）。非线性曲线/快照交叉改善的是动画段观感，不改变该冻结；P5「窗口保活重构」待决策。

### Evidence

- 关键帧对照：`artifacts/p4/verify/shots/kf-000/040/080/120/160/200/220.png`（修复前整页重影/放大卡片 vs 修复后仅窗口运动）。
- `npm run p4:verify` m1-m6 全绿（210 pass / 0 fail / 2 skip（skip 随环境 0–4），m1 97）；`npm test` 134/134。

## [0.4.1] - 2026-11-13
> 状态：**未发布**（交换动画卡顿修复；发布动作待用户决策）。
> 构建：`client.js` sha256 `1887F075C7A0E28D69F0CC5546AD4036C00867899A6EAD1740A514F61E8C526E`（282607 bytes）；基线见 `artifacts/p4/verify/run-all.json`。

### Fixed

- **焦点窗↔候场窗交换动画卡顿（用户反馈）**：降级候场卡的 live 缩略（挂载官方聊天体）原先在 VT morph 期间执行，造成 158–173ms 主线程长任务、与动效/收尾竞争 → 改为**动效结束 + 120ms 余量后经 `requestIdleCallback` 挂载**；新增回归断言 `m1.*.deferred-live-not-during-morph`（6 条交换路径）。诊断与实测见 `docs/p4/jank-fix.md`。
- 动画结束后立刻挂载重活可能落在收尾帧 → 同上改为空闲时挂载（无 `requestIdleCallback` 时 250ms 兜底）。

### Known limitations

- 点击 → 动画开始仍有约 **150–260ms 的旧画面冻结**（官方 `openSession` 主绑定提交 + VT 快照抓取；提交耗时与无动画基线相同）。动画本身为合成器动画（呈现帧 p50 16.67ms）；是否做「窗口保活重构」把冻结降到 ~30–80ms 见 `jank-fix §4`，待用户决策。

### Evidence

- `artifacts/p4/verify/jank-screencast-headed-1.75x-1260.json`（呈现帧）、`jank-loaf-headed-1.75x-1260.json`（LoAF 归因）、`jank-1.75x-1260.json`（真实舞台时间线）。
- `npm run p4:verify` m1-m6 全绿（199 pass / 0 fail / 4 skip）；`npm run p3:verify` 9/9、101/101；`npm test` 133/133。

## [0.4.0] - 2026-11-13

> 状态：**未发布**（P4 动效优化实现与验证已完成，发布动作待用户决策）。
> 基线：DSH Desktop `0.2.2-rc.1`（P4-1 复验环境：Windows 10 / Edge HeadlessChrome 156 / Electron 44.7.0 桌面）；收口构建以 `artifacts/p4/verify/run-all.json` 的 baseline 为准。
> 门禁：`npm run p4:verify`（m1-m6）+ `npm test` + P2/P3 全量回归；设计/探针证据见 `P4 计划`、`P4-1 探针报告`。

### Added

- **P4 动效系统（舞台几何变化走 View Transitions）**：焦点↔候场提升/降级、候场新增/淘汰/关闭、候场栏收起/展开都用命名元素的 VT morph（220/200/160/220ms），窗口本身移动而不是硬切；内容 120ms 交叉防闪；4 窗实测结束几何偏差 ≤0.005px、名称配对 4/4、5 连切最终状态正确。
- **舞台进场 260ms**：焦点窗 scale 0.98→1、候场栏侧向滑入；只动 opacity/transform。
- **反馈/覆盖层动效**：完成闪烁改为 2×600ms outline 双脉冲（`data-flash` 1400ms 后自动清除，不再依赖 re-render）；气泡出现 180ms/收起 120ms；快速新建条 180/120ms；菜单 120ms、picker 120/160ms、toast 160ms 进场 + 停留末 1000ms 淡出（对齐宿主）、拖拽 HUD 140ms；控制点淡入收敛到 120ms。
- **伴生窗动效**：收起/恢复 180ms transform 过渡（恢复期临时属性保 transition，结束还原）；收起标签 hover 标题改为绝对定位浮层（不再动 `max-width` 布局）。
- **减少动效设置**：焦点窗「…」菜单「动效：跟随系统 / 减少动效」，持久化 `reducedMotion`；生效时 `<html data-onestep-motion="reduced">`、token 全 0、动画 none、VT 跳过、无循环动画（系统 `prefers-reduced-motion` 同样生效）。
- **验证套件**：`npm run p4:verify`（m1-m6：morph/舞台/覆盖层/peek/reduced/perf + run-all），复用 P3 探针链路与 Playwright。

### Changed

- 动效 token 单一源：`src/client/motion.js`（`MOTION` → `:root` CSS 变量，覆盖 stage 与 portal 层）；曲线对齐宿主 `--ds-ease-in-out`，删除私有 `cubic-bezier(0.2,0.8,0.2,1)`；新增 `ViewTransitions` 控制器（串行/同帧队列/跳过/直切/命名注入与还原）。
- 焦点切换、加/关候场、候场栏收展经 `actions` 包 VT；候场栏收展不再直接写 store；HUD 内联时长改 token。
- 完成闪烁高亮窗口 2200ms → 1400ms（动画 1200 + 200 余量）。

### Fixed

- 运行态状态点 `onestep-pulse 1.2s infinite` 无限循环动画（违反开发文档 §8.5「不自动播放循环动画」）→ 删除，仅保留状态色/形状/文案。
- `data-flash` 属性依赖下一次 re-render 才移除（P4-1 基线审计实测 6.1s 仍在）→ feedback 层定时自清（1400ms）。
- 收起标签 hover 的 `max-width` 布局动画（违反 §11.4）→ 浮层标题，只动 opacity/translate。
- portal 层（picker/HUD/probe/peek 标签）此前不继承 `--onestep-*` token（fallback 生效）→ token 移至 `:root` 全覆盖。

### Known limitations / 披露

- **View Transitions 依赖 Chromium ≥111**：桌面 Electron/现代 Edge/Chrome 支持；不支持时自动直切（无动画，功能不受影响）。
- **外部主绑定切换**（官方左栏点击会话）无法在 DOM 变化前启动 VT → 直切（插件内动作才有动画）。
- 伴生浮窗/收起标签的 morph 保护需要**临时给官方 DOM 元素注入 `view-transition-name`**（结束后还原）——这是 P3 已接受的非公开扩展边界内的追加注入，官方升级可能使其失效；失败时动画退化，不阻塞功能。
- 焦点切换的 VT 更新时间包含官方主绑定提交（实测 P95 ≈152ms，与无动画基线一致）；动效门禁按「VT 快照开销 P95 ≤20ms + 干净帧 P95 ≤ 环境基线+4ms」计。

### Evidence

- P4-1 探针（Go）：`docs/p4/motion-probe.md`、`artifacts/p4/probe/`（8 JSON + 30 截图）；VT 快照开销 P95 6.5ms、干净帧 P95 17.6–18.1ms、几何偏差 ≤0.005px、5 连切终态正确。
- P4 验证：`npm run p4:verify` → `artifacts/p4/verify/run-all.json`（m1-m6 全绿，193 断言 pass / 0 fail / 4 skip：m3 HUD partial + m6 环境污染降级；baseline client.js `5B796E85…226B0C0`）；P3 回归 9 套件 101/101、单测 133/133、i18n 73/73。实现计划/规范/门禁：`docs/p4-plan.md`。

## [0.3.0] - 2026-11-10

> 状态：**未发布**（文档与版本已收口，发布动作待用户决策；P3-7 桌面实机核心链路已通过，3 项人工复核待用户按 `P3 桌面验证清单` 完成）。
> 基线：DSH Desktop `0.2.2-rc.1`（前端 release `c59d10a`）；P3 收口构建 `client.js` 见 `artifacts/p3/verify/run-all.json` 的 `baseline`/`baselineAfter`。
> 门禁：`npm run p3:verify` **9 套件全绿**（8 个行为套件 76 断言：probe G1–G4 + 产品 e2e + G5 回退 + G6 生命周期 + G7 回归 + G8 视觉/无障碍；+ 发布自查 25 项），`npm test` 108/108，compat smoke 15/15，i18n 71/71；**2026-11-12 在收口构建 `42BCAC8F…` 上全量复跑通过**。

### Added

- **P3 独立伴生浮窗（舞台模式默认形态）**：舞台内打开文档/文件/浏览器/终端等官方右栏 tab 时，默认在屏幕右侧独立浮窗打开，**不挤窄焦点窗**（打开到可见逐帧 0px 几何偏差、0 中间展开帧；见 `P3 探针报告`）。
- **多浮窗固定槽位**：`slotW = clamp(340, 舞台宽×30%, 480)`、`gap=8`、3 槽（1440）/2 槽（1280）/1 槽（窄屏 860），已有窗不动态重排；同内容再次打开只聚焦已有窗；满槽收起最久未聚焦窗腾槽（内容不丢）。
- **收起标签可拖动定位（US-3/4 / G3，2026-11-11）**：右缘标签堆顶部新增拖动手柄（`data-onestep-peek-grip`，指针拖动 / ↑↓ 8px / Shift 24px / Home/End，位置按全局 UI 偏好持久化 `ui.peekTop`）；默认位置 = 16 + 桌面标题栏高度（`--dsh-windows-titlebar-height`），**不再被右上角窗口控制按钮遮挡**。
- **点击浮窗外收起 + 右缘标签**：点击舞台区域（浮窗外）全部收起；官方浮窗移出视口（`inert`+`aria-hidden`+视口宽位移），右缘显示堆叠标签（图标+标题、z63、原生按钮/`aria-expanded`/`aria-controls`、Enter/Space 恢复），点标签只恢复该窗。
- **手动左右分屏（D13）**：点官方浮窗「收回到侧边栏」自动切 `split` 形态，其余浮窗一并收回官方右栏并 push 重排；「…」菜单可切回浮动，并在有收回项时提供「转回浮窗」（按收起后几何重新分配槽位）。
- **形态记忆与生命周期**：形态按会话持久化（`dsh.onestep.companion.v1`）；刷新恢复写入时态（浮窗恢复、右栏列按官方持久值）；收起状态不跨刷新；卸载/热重载精确还原被包装的官方方法（探针 wrap cycle restored=2）。
- **P3-6 验证套件**：`npm run p3:verify` 一键门禁（9 套件：8 个行为套件 76 断言 + 发布自查 25 项，含 G5 回退/G6 生命周期/G7 回归/G8 双主题+1280/860 截图+键盘+reduced motion），产物 `artifacts/p3/verify/`。

### Changed

- 焦点窗「⇥」语义从「打开/收起官方右栏」改为**伴生窗开/收**（有可见浮窗 → 全部收起；有收起 → 恢复；无浮窗 → 打开 guide 浮窗）。
- 焦点窗「…」菜单新增「伴生窗：左右分屏/恢复浮动」「转回浮窗」「打开官方右栏」。
- 版本号 `0.1.0-p1.0 → 0.3.0`（P3-8 收口，未发布）。

### Fixed（P3 期间发现的官方语义约束，均按实测修正计划/实现）

- `active()` 必须在 `float()` 前取（展开态 float 的 settle 会补种 guide 抢回 active pane）。
- 刷新恢复的是官方持久化的 `expanded`（不强制展开右栏）。
- `maxSlots` 是插件策略、官方不校验（1280 第 3 窗会落在舞台外）。
- 窄视口下 reconcile 不得丢弃逻辑槽位（改为保留 + 重排）。
- 收起位移用 `100vw + 24px`（原「100% + 24px」在 2/3 号槽位收不干净）。
- **「转回浮窗」收回项多于槽位时会重叠**（桌面实机发现）：恢复循环忽略了 `allocate.evicted` 候选，导致第 N+1 个窗与他人同槽；改为槽位满即停止恢复、其余保持收回右栏并 toast 提示（web 回归 `split.overflow-restore.*`，5 窗→恢复 3/收回 2/0 重叠）。

### Known limitations / 非公开扩展披露

- **两层非公开扩展（D14）**：①运行时包装官方 `ctx.sidebarRight.openResource/openTab` 两个顶层打开入口；②对官方浮窗 DOM 注入 `data-onestep-peek`/`inert`/`aria-hidden` 与样式，并用 `document.body` portal 自绘右缘标签层。官方升级（换 rc）可能使其失效——已实现能力自检 + 失败直通/回退 + 每 rc 契约 diff（`contracts.md` §6），**失败时自动退回官方右栏行为**，不阻塞官方 UI。
- 官方无公开 move/resize：浮窗仅新建时按槽位落位，已有窗不动态重排（用户拖动后官方持久化，插件不覆盖）。
- 窄屏（视口 <900 或主区 <760）仅 1 槽；720 视口舞台本身按设计退出，P3 不生效。
- 浏览器 tab 伴生窗仍为 desktop-only（官方 profile 门控）；web/隔离 profile 按设计降级。
- 不支持操作系统级独立窗口、跨设备/多标签页同步（非目标，见 P3 计划 §1.3）。

### 测试与证据

- `docs/p3/companion-float-probe.md`（P3-1 Go/No-Go + 设计冻结）、`docs/p3/contracts.md`（官方契约事实 + rc diff 清单）、`docs/p3/p3-report.md`（实现报告）、`artifacts/p3/verify/`（一键门禁证据 + 截图）、`docs/assets/p3/`（README 发布截图）、`artifacts/p3/desktop/`（桌面实机探针与截图）。
- 门禁汇总：`npm run p3:verify` **9 套件全绿**（2026-11-11 收口构建 `42BCAC8FB42854611EF9620AC746A6B9903DA6B78A370C600D7454445BFFBA86`）；`npm test` 108/108；P1 review 6/6；P2 81/82（`perf.drag-fps` 环境性，见 `artifacts/p2/verify/p3-regression-note.md`）。
- 发布演练（tarball 形态）通过：pack 6 条目 / 安装后 boot version 0.3.0 / 舞台 8/8 / 卸载 6/6 / 重装回退通过，证据 `artifacts/p3/release/README.md`。

## [Unreleased (P2)]

> 状态：**未发布**。P2-1..P2-8 已全部落地或收口；A/B/C 发布门禁在最终收口构建 `client.js` sha256 `B43EEEC58C40BA6A91C8D787EABC963EC82AE504AB043754E078D06F70CF7A15`（166798 bytes）上全绿：P2 三套件 **82/82 pass（1 skip）**、P1 六套件全过、i18n+热切换 PASS、compat smoke 15/15 + inventory 0 违规 + engines PASS、发布材料自检 129 项 PASS、P2-7 R1–R8 通过。剩余为**发布执行**（§0 前置 + D 组：git 仓库、版本号定稿、npm publish、GitHub Release、市场提交、桌面 App 人工确认、上一 rc 环境），需用户决策。完成并通过发布检查表签署后，本节整体转入 `0.2.0` 段落；**未完成项不得写入发布说明**。

### 已落地（P2 进行中）

- **P2-1a 键盘/无障碍/视觉规格**：键位按实现定稿为 Ctrl+Alt 系（Ctrl+Alt+S 开/退舞台、Ctrl+Alt+Shift+N 快速新建、Ctrl+Alt+Shift+W 移出焦点、Ctrl+Alt+1 回到焦点输入、Ctrl+Alt+2..4 提升第 2..4 个窗口、Ctrl+Alt+←/→ 焦点循环、Ctrl+Alt+Z 撤销、Esc 两段式；候场窗 Enter 提升/Delete 移出），经官方快捷键系统注册（可在官方快捷键页改键）；ARIA 角色与标签（舞台=group、焦点窗=region、候场窗=group+序号）、焦点转移、状态点 6px 视觉/12px 命中 + 三态形状、焦点窗圆角 16px、chrome 40/32、控制点 12/24、快速新建 Esc 两段式、死代码收口（`content.js` `LiteCard`、`StageRoot.onDrop`）。证据：`a11y-keyboard`（53 条断言全绿；另 1 条改键/冲突检测为人工确认 SKIP）。
- **P2-2 i18n（zh/en）**：硬编码文案扫描、zh/en 键集一致性与键使用完整性检查通过（各 63 键、hardcoded=0）；语言热切换不重挂载窗口。证据：`check-i18n`、`hotswap`、`scripts/p2/check-i18n.mjs`、`scripts/p2/i18n-hotswap.mjs`。
- **P2-3 自动 lite 降级 + 候场栏收起**：自动降级阈值可配置（`windows=4`、`firstFrameMs=900`、`longTaskTotalMs=400`、`memoryDeltaMB=200`；极简信号 `minFps=30`/`lowFpsWindowMs=2000` 已识别但 v1.1 未接线），`evaluateAutoLite` 纯函数 + reason 优先级（disabled → manual-override → below-window-threshold → memory → sustained-low-fps → first-frame → long-task → within-budget）；自动降级只作用于渲染层（`effectivePreviewMode`），**不写 `store.previewMode` / localStorage**；用户手动切档后本次舞台会话内自动判定不再覆盖（`manual-override`），舞台退出重置；候场栏收起手柄（键盘可达、`aria-expanded`）与收起态持久化，并修复「注入 `railCollapsed=true` 被误判窗口过窄而退出舞台」。极简档（状态条收栏）为 v1.1 候选、未实现。收口构建修复「收起态 40px 边条被焦点窗覆盖」的绘制缺陷（`data-collapsed` + 层级/z-index），并复跑 lite-degrade **19/19**。证据：`docs/p2/p2-3-p2-4.md` §2、`artifacts/p2/lite/`（lite-degrade 19/19）、`artifacts/p2/verify/lite-degrade.json`。
- **P2-4 性能打点与预算**：新增 `performance.mark/measure`（`stage-enter-start/ready`、`focus-switch-start/ready`、`focus-switch-content-ready`）与探针 `snapshot.perf`（环形最近 24 条）；预算逐项实测达标——进入 2/4 窗 50.6/91.4ms（预算 400/900）、点击切换 103.6ms（200）、快捷键换绑 50.5ms（100）、拖拽 71.94fps（≥55，基线 48.08fps）、内存增量 54.42MB（≤200）、退出残留 0、mark/measure 齐全。落地两项优化：候场窗官方内容 `React.memo` 隔离 + splitter `pointermove` rAF 合并（拖拽 48.08 → 71.94fps），焦点切换先 card 占位再挂载 live 缩略（点击 117.9 → 103.6ms）；未采用项（CSS contain、焦点乐观切换）已回退并记录。**收口构建（`B43EEEC5…`）复跑**：进入 2/4 窗 46.2/94.3ms、点击 111.0ms、快捷键换绑 54.5ms、拖拽 71.94fps、内存 +64.02MB、退出残留 0，perf-bench 10/10。证据：`docs/p2/p2-3-p2-4.md` §3、`artifacts/p2/perf/`（perf-bench 10/10）、`artifacts/p2/verify/perf-bench.json`。
- **P2-5 契约清单与基线 rc 兼容冒烟**：adapter 契约清单（inventory 0 违规）与 DSH 0.2.2-rc.1 只读冒烟 15/15；上一 rc 验证、支持范围声明与负向降级实测待收口。证据：`docs/p2/compat-matrix.md`、`artifacts/p2/compat/`。
- **P2-6 发布材料定稿**：README 合并「安装、使用与排障」篇（桌面 App Plugins 页 / 隔离 profile 分工、第一次进舞台、日常操作、键盘、设置、故障排查；桌面 CLI 仅只读 list 可用、隔离 profile 会话目录共用 `~/.dsh`）；发布截图 11 张（收口构建重拍：1440×900 双主题 + 1280×800 顶部候场栏 + 交互细节，仅用本项目相关普通会话、账户行隐藏；`docs/assets/p2/`，截图脚本 `scripts/p2/shots/capture.mjs` 校验 served bundle 与仓库构建一致）；市场文案与发布检查表更新。证据：`docs/assets/p2/`、`artifacts/p2/shots/capture.json`、`docs/p2/release/`。
- **P2-7 打包与发布演练**：独立 profile `onestep-p2`（4661）完成 R1–R8：`npm pack` 内容核对（6 条目恰为 files 白名单、tarball 内 sha 与仓库一致、可复现）、全新 profile 安装（73→74 entries、host.apply、舞台 1 焦点+2 候场冒烟 8/8）、卸载干净（回 73、无 `__ONESTEP__`/插件 DOM、无包目录残留、重装恢复）、升级（版本加载正确、localStorage 设置保留且生效 10/10）、回退（一条 remove）、坏 bundle 负向（整页 boot 显式失败、remove+重启恢复）。R9 registry 未发布=⚠️、R10 桌面 App 人工确认=⚠️，均已披露。证据：`docs/p2/release/rehearsal.md`、`artifacts/p2/pack/`。
- **P2-8 维护机制就位**：[SECURITY.md](SECURITY.md)（含桌面 profile 管理边界、engines OR range 支持范围、无网络外发/无遥测/回环 `/plugins/**` 无鉴权披露）、`.github/ISSUE_TEMPLATE/`、`docs/p2/maintenance.md`（发版 runbook / rc 追踪 8 步 / issue 分级且不承诺 SLA / 安全更新 / 回滚与坏 bundle 恢复按 R8 实测回写）。

### Added（计划/未发布）

- **P2-1 余项（降级为已知限制/P3）**：drop 槽位交换矩阵与高亮、拖拽影像跟随指针、焦点窗 chrome 工作区/重命名/归档菜单、S6 真实待处理事件补测——不阻塞公开发布，README 已知限制如实声明。
- **P2-5 余项**：上一 rc（0.2.1-rc.5）装机验证（本机无该版本，官方 CDN 安装包可下载）；契约缺失注入式负向降级实测；GitHub 侧 rc 追踪流程实际启用。
- **P2-7 余项**：R9 registry 形态（发布后 D6 复测）；R10 桌面 App Plugins 页人工安装确认与截图。
- **发布执行**：§0 前置（git 仓库/远端、脱敏扫描、GitHub 地址、版本号、市场通道）与 D 组动作（版本定稿、npm publish、Release、市场、发布后验证）。

### Changed（计划/未发布）

- 光标/焦点行为与官方会话头交互对齐（随 P2-1）。
- 焦点窗 chrome 补齐工作区标识、重命名/归档等菜单项（随 P2-1，来源于 `P1 审查报告 §6.1`；**本次未实现，已降级为已知限制/P3**）。
- 版本号升级为建议的公开发布版本（P2 收口，改 `package.json` 与 `index.js` 版本常量）。

### Fixed（计划/未发布）

- 视觉审计遗留项：#16 控制点默认色 label-tertiary、视觉点外悬 6px；#7 HUD 默认色策略（P2-1）。
- P2 文档勘误（已解决）：P1 报告记录的最终构建 sha `F1800E70…` 已被后续轮次重建覆盖；README 已不再硬编码构建 sha，改为「发布时按版本定稿记录」；P2 开工基线快照与后续构建 sha 的区分见 `docs/p2-plan.md §0`。

## [0.1.0-p1.0] - 2026-11-08

> 内部里程碑（P0 机制验证 + P1 MVP 交付），**未发布到 npm / GitHub Release / 社区市场**。
> 里程碑窗口 2026-11-08 ～ 2026-11-09：P1 出口后的「伴生窗 ②」收尾与桌面运行期复验（2026-11-09）在同一版本常量内完成，未单独升版。
> 技术基线：DSH Desktop `0.2.2-rc.1`（源码 commit `fcc0ad4` / 前端 release `c59d10a`）；已知限制见 README §4。

### Added

- **P0 机制验证（结论 Go，2026-11-08）**：在隔离 profile 与桌面 profile 实测「运行期注册/遮蔽/恢复 `main` keyed `'conversation'`」（10/10 次干净通过）、root 作用域桥、第三方 `renderFactorySlot('conversation.content')` 多窗口渲染（Composer 可发送/停止）、切焦点窗口 DOM 不重挂载、4 occurrences 性能可用；安装/卸载链路可复现。详见 `P0 报告`。
- **1 + 3 舞台**：焦点会话居中 + 最多 3 个候场会话（左侧或顶部候场栏）；候场卡固定 √2:1（左 232×164 / 顶 153×108）；候场栏与焦点窗之间可拖拽调比例（键盘可调、持久化）；官方左栏保持不动。
- **自适应接管**：候场窗 ≥1 时注册覆盖 `main` keyed `'conversation'`（root 作用域），候场窗为 0 时 dispose 恢复官方会话；无候场时官方界面与默认体验完全一致。
- **候场卡默认实时缩略**：复用官方聊天体 occurrence + `inert`（不可输入），按约 560px 逻辑宽渲染后等比缩放；可在焦点窗「…」菜单切精简卡（标题/状态/最近提问）；候场窗截图与状态文案实时更新。
- **拖拽编排**：官方左栏会话行拖到焦点区 = 替换焦点，拖到候场栏 = 加入候场（含普通模式落点 HUD）；原焦点自动降为候场；满 3 淘汰最久未用（LRU）。
- **快捷入口**：左栏会话行 hover「加入舞台」、会话头「舞台」多选 picker、普通模式拖入、快捷键切换。
- **窗口级操作**：焦点窗右下 88×88 触发角出关闭控制点；候场卡 hover 整卡出右下控制点；焦点窗底部热区滑出「快速新建条」，输入后回车创建新会话（文本先成为草稿，不自动发送）并顶替焦点。
- **窗口级反馈**：候场会话完成 → 卡片边框闪烁；等待批准/回答/计划确认 → 候场卡右下琥珀色气泡（点击提升为焦点）；配套 `aria-live` 播报与 5 秒撤销 toast。
- **关闭语义**：候场关闭 = 移出舞台（不删会话）；焦点关闭 = 提升最近候场为焦点；关闭最后一个窗口 = 退出舞台。均可撤销。
- **伴生窗跟随（官方右栏）**：每会话独立布局、切焦点自动跟随（`mounted === focusId`）；焦点窗右栏开关；右栏展开挤压主区时进入 compact（隐藏候场栏、单窗保活，主区 <480 才退出）；候场会话的右栏写操作显式 no-op。
- **浏览器伴生窗（desktop-only）**：桌面 profile 实测官方右栏「浏览器」tab 可打开；web/隔离 profile 因官方按 `profileContext.name === 'desktop'` 门控而不可用，按设计降级。
- **持久化 v3**：候场 roster、候场栏方向/尺寸/收起、预览档、`persistStage` 等写入 localStorage（键 `dsh.onestep.v1`，300ms 节流），v1/v2 → v3 迁移保留 roster 与布局；reload 后舞台恢复。
- **双主题**：浅/深主题跟随官方 token（浅色候场标题对比度修复后 18.9:1，深色 13.34:1）；焦点窗/正文底色与官方 composer 渐变终点对齐。
- **i18n 基础（zh/en）**：locale 字典注册 + `t()` 取文案，状态文案键化（P2 继续补齐全量与硬编码扫描）。
- **工程链路**：`src/client/` 模块化（adapter/store/layout/stage-root/content/feedback/locale/styles/drag/companion/probe/status）+ esbuild 构建为 DSH client bundle；宿主半 `index.js` 探针（apply/dispose + 可选 JSONL 日志）；`window.__ONESTEP__` 证据面与可选探针面板；node:test 单测；Playwright 实机验证器与 P1 review 验收套件。
- **测试与验收（本里程碑内）**：单测从 23 条增至 28 条（含 companion 纯函数用例）；P1 review 修复轮 6 组实机探针共 57 条断言全绿（证据 `artifacts/review/verify/`，记录于 `P1 审查报告 §5`）。

### Changed

- 候场卡预览档由「精简卡」改为**默认实时缩略**（第三轮反馈），可手动切回精简卡；持久化状态升 v3 并迁移。
- 舞台定位由 `absolute;inset:0`（覆盖整窗）改为**按 main 列宿主矩形 fixed 定位**，跟随官方左栏折叠/右栏挤入/视口变化（见 Fixed）。
- 焦点会话底部背景改为 `bg-base`，消除与官方 composer 渐变的割裂色带。
- 快捷键默认值由 `Ctrl+Alt+W` 改为 `Ctrl+Alt+Shift+W`，避免与官方保留序列冲突（冲突曾导致 bootstrap 级插件 pending）。
- `dsh-onestep` boot 条目从无到有：隔离 profile `entries` 73 → 74；卸载后回落 73（P1 卸载/重装回归）。
- 焦点窗/候场窗 chrome 高度、候场卡间距（12px/8px 内缩）、顶部栏卡高 108 等按设计稿对齐。

### Fixed

- **舞台覆盖官方左栏**（管理员报告主诉 1）：舞台根越界到整个 AppFrame，官方 280px 左栏不可点；修复为宿主矩形 fixed 定位 + `ResizeObserver` 跟随 + 400ms 窄屏去抖。
- **候场卡与设计稿不符**（主诉 2）：卡片从「拉满整栏的迷你窗口」（229×437）改为 232×148 固定 √2:1 卡片，顶部对齐、新加入在上。
- **关闭控制点位置与显隐**（主诉 3）：从「标题栏右上 ×、整窗 hover 显示」改为「右下 12px 点 / 24px 命中」；焦点窗 88×88 触发角 + 120ms 显示 / 300ms 隐藏时序；`@media (hover:none)` 常显；键盘可关闭。
- 浅色主题 token 穿透：候场卡标题对比度 **1.2:1**（不可读）→ 13 个无效 token 换官方 token 后 **18.9:1**，深色 13.34:1。
- 「Onestep 舞台」header 按钮 / `Alt+S` 选择浮层整条入口崩溃（`props.t is not a function`）。
- 关闭最后一个候场会话必现 `ReferenceError: exitStage is not defined`；退出 toast 迁至全局 `shell.overlay`。
- 提升唯一候场导致舞台整体退出；改为由 `handleFocus` 统一 demote，旧焦点入候场。
- 陈旧 focusSignal 导致重进舞台误加旧焦点；卸载时清理 focusSignal 与定时器。
- 候场卡被官方输入框覆盖：默认缩略档隐藏 `[data-composer-*]`，精简卡不挂载 occurrence。
- 快速新建条：鼠标离开 400ms 隐藏、点击其它区域隐藏、草稿保留、再唤醒原样显示；创建成功或 Esc 才清空。
- 非焦点窗完成提示不出现：`useSessionStatus` 状态实为 `Map<SessionId, SessionStatus>`，按对象取值永远 `undefined`；`adapter.statusOf/statusesSnapshot` 统一 Map/对象两形态后，完成闪烁、气泡与 aria-live 恢复。
- 关闭最后候场/窄屏退出时的 `renderSlot(...) from a disposed registration`：槽位 dispose 延迟到 React 提交后（`pendingDisposers` + `setTimeout(0)`）。
- 窄屏退出与右栏挤入的抖动误判：`<760` 阈值 + compact 策略（右栏展开时下探到 `focusMinWidth=480`），真正 `<480` 才退出并 toast。

### Security

- 披露并记录运行环境约束：本机回环地址上的 `/plugins/**` **无鉴权**，同机任意进程可匿名读取插件 bundle（`/` 与 `/api` 有 token/cookie 准入）；插件本身不读取凭据、不采集会话内容、不发网络请求、无遥测（口径见 README §11 与 [SECURITY.md](SECURITY.md)）。
- 插件不修改 DSH 安装目录、不 patch 官方 bundle、不依赖运行时 import 其他 feature 插件；bundle 加载失败会使整页 boot 失败（boot 图契约），发布前必须冒烟（见 `维护机制`）。
