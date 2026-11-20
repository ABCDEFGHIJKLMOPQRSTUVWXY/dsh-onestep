# 发布检查表（dsh-onestep 1.0.0）

> **2026-11-20 版本收口**：仓库已收口到 `1.0.0`（首个公开发布版本）。最终树复跑结果：`npm run check` 全绿（**190/190** 单测、`build:check` 逐字节一致、i18n、版本范围、文档 **16/16**）、`npm run p3:hygiene` **33/33** 且脱敏命中 **0**、`npm pack` 6 文件白名单。当前 `client.js` 为 **347283 B / SHA-256 `5CA24A6E4FD0D00EE9926B10D823CEF9A55EB1D2ADF4290396C88B802CF14E2B`**，tarball `dsh-onestep-1.0.0.tgz` **101808 B / SHA-256 `0B9C8D57F37560DEDDCE1ABB298159668E6B97CF107365B04F96BF0EDF5516BF`**。本轮已在隔离 profile `onestep-g8` 上完成 G8 安装/卸载演练与 G9 定向回归（`install-drill.json`、`regression.json` 已按 1.0.0 重生成）；桌面 App 内安装/卸载（B4）已由用户于 2026-11-20 完成确认。详见[审查记录](../review/2026-11-20-review.md)。

> 用途：`dsh-onestep` 首个公开发布版本（**1.0.0**）的收敛版检查表与签署表。**每一项都必须能复跑，无证据不得勾选**；本表只覆盖 1.0.0，不保留历史版本段落。
> 状态图例：✅ 通过（有归档证据）｜⬜ 待执行（发布前必须清零）｜⚠️ 有条件通过（必须在发布说明中如实披露）｜❌ 阻塞（不得发布）。
> 版本基线（2026-11-20）：插件 **1.0.0**；DSH Desktop **0.2.2-rc.1**；支持范围 `>=0.2.2-rc.1 <0.3.0-0 || >=0.2.1-rc.5 <0.2.2-0`；构建产物 `client.js` **347283 B / sha256 `5CA24A6E4FD0D00EE9926B10D823CEF9A55EB1D2ADF4290396C88B802CF14E2B`**；单测 **190/190**（18 个测试文件）；i18n zh/en 各 **75** 键；tarball `dsh-onestep-1.0.0.tgz` **101808 B / sha256 `0B9C8D57F37560DEDDCE1ABB298159668E6B97CF107365B04F96BF0EDF5516BF`**（6 个文件）；版权主体 `Copyright (c) 2026 Huaxingmo`（`LICENSE` / `README.md` §9 / `package.json` 的 `author` 三处一致）。
> 证据归档：结构化证据在 `docs/release-evidence/`，索引与口径见 [发布证据索引](evidence.md)。原始日志、截图、浏览器数据等临时产物不入库。

## 1. 发布门禁（G 组）

> 门禁命令均在仓库根执行；Windows PowerShell 语法，其它平台按等价命令替换。所有门禁应在**最终发布树**上重跑一次。

| # | 检查项 | 复跑命令 | 通过判据 | 状态 | 证据 |
|---|---|---|---|---|---|
| G1 | 版本一致性（5 处） | ① `node -e "const fs=require('fs');const v=f=>{const m=fs.readFileSync(f,'utf8').match(/const VERSION = '([^']+)'/);return m&&m[1]};console.log(JSON.parse(fs.readFileSync('package.json','utf8')).version,JSON.parse(fs.readFileSync('package-lock.json','utf8')).version,v('index.js'),v('src/client/index.js'))"` ② `Select-String -Path CHANGELOG.md -Pattern '^## \[1\.0\.0\]'` | ① 输出 4 个值全部为 `1.0.0`（`package.json`、`package-lock.json`、宿主半 `index.js`、客户端半 `src/client/index.js`）；② CHANGELOG 存在 `## [1.0.0]` 段落；版本号变更后必须重建并重跑 G2–G9 | ✅（2026-11-20） | `build.json`、`gates.json` |
| G2 | 构建可复现 | `npm run build` → `npm run build:check` | 内存重构建与磁盘产物逐字节一致；连续两次构建同哈希；缺失/过期即失败且不写盘；当前产物 347283 B / `5CA24A6E…4E2B` | ✅（2026-11-20） | `build.json` |
| G3 | 产物语法 | `node --check client.js` | exit 0 | ✅ | `gates.json` |
| G4 | 单测 | `npm test` | 190/190 pass、0 fail、0 skip；18 个测试文件，自动发现 | ✅（2026-11-20） | `tests.json` |
| G5 | i18n | `npm run i18n:check` | 通过；zh=en=**75** 键；usedKeys=73、unused=0、missing=0、hardcoded=0、errors=0 | ✅ | `gates.json` |
| G6 | 兼容门禁（engines） | `npm run compat:engines` | PASS；`engines.dsh` 与声明范围逐字一致；支持 0.2.2-rc.1 / 0.2.1-rc.5，排除 0.2.0-rc.1 / 0.2.1-alpha.* / 0.2.2-alpha.* / 0.3.0-rc.*；用真实 semver `{includePrerelease:true}` 交叉校验，与宿主判定 0 处不一致 | ✅ | `gates.json` |
| G7 | 包内容 | `npm pack --dry-run --json`（或 `scripts/p2/pack/check-pack.mjs` 的输出作为来源） | 恰好 6 个文件：`LICENSE`/`README.md`/`client.js`/`cordis.patch.yml`/`index.js`/`package.json`；不含 `src/`、`tests/`、`scripts/`、`docs/`；包内 `client.js` sha256 等于仓库文件；tarball 字节数/sha256 记入 `pack.json` | ✅（2026-11-20 按最终树重打包：101808 B / `0B9C8D57…16BF`，6 文件，包内 client sha 与仓库一致） | `pack.json` |
| G8 | 安装演练（隔离 profile） | `dsh.cmd` 创建全新隔离 profile → `plugin --profile <p> add <tarball>` → 重启 → 探测 boot 条目与舞台 → 退出 → `remove` → 重启回落 | 演练步骤 **11/11** 通过；boot 条目含 `dsh-onestep`、`window.__ONESTEP__.version=1.0.0`、可进入舞台（1 焦点 + 1 候场）、退出恢复官方界面、卸载后条目回落且无插件全局/DOM/包目录残留；0 pageerror | ✅（2026-11-20 隔离 profile `onestep-g8`：安装 → 重启 → boot/舞台探测 → 退出 → 卸载 → 重启回落，**20/20** 步骤通过；pageerror 0） | `install-drill.json` |
| G9 | 修复后定向回归 | 在同一构建的隔离实例上验证三项：唯一候场提升 / 换焦引用 / CSS 生效（演练已含） | F1：提升唯一候场时无 `stage.mount`/`stage.unmount`、舞台根与焦点窗节点身份保持；F2：被降级会话无 `ref.release`、仍正常渲染；CSS：样式表规则数、`.onestep-rail-mini` / `.onestep-rail-scroll-btn` 命中且计算样式生效；0 pageerror | ✅（2026-11-20 同一隔离实例：F1/F2/CSS 全绿，pageerror 0） | `regression.json` |
| G10 | 发布自查（包内容/敏感串/忽略规则/文档） | `npm run p3:hygiene` | `ok=true`，**33/33** 检查通过、未忽略命中 **0**；`.gitignore` 覆盖依赖/临时产物/归档/第三方快照/本机浏览器数据；6 文件包白名单与版本一致性通过 | ✅（2026-11-20 最终树重跑 33/33、hits=0） | `gates.json` |
| G11 | 文档链接与脱敏 | `npm run docs:check` | 0 断链、0 违规链接目标（不指向未入库目录）、0 本机绝对路径/凭据形态/真实会话 ID 泄露；六份公开文档齐备；README 引用 5 张宽度 ≥1000 的截图；版本一致性通过 | ✅（2026-11-20 最终树重跑 **16/16**） | `gates.json` |

> **2026-11-20 收口后**：G1–G7、G10、G11 已在最终树（1.0.0）重跑并有输出记录；G8/G9 已于 2026-11-20 在隔离 profile `onestep-g8` 上复跑通过（安装演练 20/20、F1/F2/CSS 全绿）；桌面 App 内安装/卸载（B4）已由用户于 2026-11-20 完成确认。G2 的产物为 347283 B / `5CA24A6E…4E2B`，任何打包内文件（代码、README、LICENSE、元数据）再变动都必须重新打包并重跑 G7。

## 2. 发布阻塞项（清零前不得发布）

| # | 阻塞项 | 现状（2026-11-20） | 清零判据 | 归属 |
|---|---|---|---|---|
| B1 | **git 化** | ✅ 已完成 `git init` 与首个提交（154 文件）；本地已打 tag `v0.7.0` 与 `v1.0.0`；**尚无远端、未推送** | ① 提交前脱敏扫描 0 命中（已完成）；② 1.0.0 收口提交（已完成）；③ 配置远端并推送（需用户提供仓库地址并授权）；④ 推送 tag `v1.0.0`。验收：`git remote -v` 有远端、`git status` 干净、tag 指向提交与证据中 `client.sha256` 一致 | 用户提供远端 + 授权推送 |
| B2 | **LICENSE 版权主体** | ✅ 2026-11-20 已定稿为 `Copyright (c) 2026 Huaxingmo`；`LICENSE`、`README.md` §9、`package.json` 的 `author` 三处一致 | 已完成；公开发布后不宜再改主体。如确需变更，同步三处并重建、重跑 G1/G7/G8/G10（打包内容变化会改变 tarball 哈希） | 用户已决策（2026-11-20） |
| B3 | **发布授权** | `npm publish`、GitHub Release、社区市场提交均为不可撤回的外向动作，**尚未取得用户明确授权** | 用户明确授权发布；发布前复查包名 `dsh-onestep` 在目标 registry 未被占用；发布后用 registry 包在全新隔离 profile 安装复测（不得用本地 tarball 替代） | 用户授权 + Lead 执行 |
| B4 | **桌面 App 人工确认** | ✅ 2026-11-20 用户已在 App 内完成卸载与重装并确认插件可用；桌面 profile 中 `dsh-onestep` 以 `link:<仓库目录>` 形式在 bundles 中，链接指向的 `client.js` 为 1.0.0（347283 B / `5CA24A6E…4E2B`） | 已完成；发布前如再改动代码或产物，需在 App 内按同样流程复验一次 | 用户已确认（2026-11-20） |

## 3. 发布说明必须披露的项（非阻塞，⚠️）

| 项 | 现状 | 披露位置 |
|---|---|---|
| 上一 rc 未装机 | `0.2.1-rc.5` 仅在 `engines.dsh` 中声明支持，本机未安装，未做装机冒烟（仅有 semver 推演） | README/兼容性文档、CHANGELOG |
| 全量套件未复跑 | `p3:verify` / `p4:verify` 整套断言未在 1.0.0 构建上复跑（沿用 0.6.1 基线）；1.0.0 的改动由单测 + 定向回归覆盖 | CHANGELOG、[发布前审查报告](../review/0.7.0-pre-release.md)、[本轮审查记录](../review/2026-11-20-review.md) |
| 桌面 App 重启时点 | 用户已在 App 内完成卸载/重装确认；该实例的 host 半仍是 App 启动时加载的版本，插件客户端 bundle 已随仓库为 1.0.0，下次启动后 host 半同步 | 发布说明、B4 签署备注 |
| 键盘链路环境限制 | 真实 `Ctrl+Alt+2` 在 headless web profile 中未触发（CDP 输入环境限制），F1/F2 回归改用 `__ONESTEP__.actions.promote` 路径验证；桌面实机键盘建议在 B4 一并复验 | [发布前审查报告](../review/0.7.0-pre-release.md)、B4 签署备注 |
| 桌面特有行为未实机截图 | Electron 全屏/标题栏等行为只做代码对齐与隔离实例验证，未做桌面实机截图 | 发布说明 |
| 非公开扩展点 | 包装 `sidebarRight.openResource/openTab`、官方浮窗 DOM 注入、fiber `intents.resizeFloat`、只读官方 localStorage；DSH rc 升级需契约 diff | [使用手册](../user-guide.md) §1、[兼容性说明](../compatibility.md)、SECURITY |
| 能力边界 | 缩放无键盘等价路径；浏览器 tab 仅桌面 profile；极简档 v1.1 未实现；滚动位置不持久化 | [使用手册](../user-guide.md) §1/§4、CHANGELOG |

## 4. 签署表

| 组 | 范围 | 负责人 | 结论 | 证据 | 日期 |
|---|---|---|---|---|---|
| 版本与构建 | G1–G3 | Lead | ✅ 1.0.0 五处一致、产物可复现 | `build.json` | 2026-11-20 |
| 测试与门禁 | G4–G6、G10、G11 | Lead | ✅ 190/190、i18n 75/75、engines PASS、自查 33/33、文档 16/16 | `tests.json`、`gates.json` | 2026-11-20 |
| 打包 | G7 | Lead | ✅ 最终树重打包 101808 B / `0B9C8D57…16BF` | `pack.json` | 2026-11-20 |
| 安装演练与回归 | G8–G9 | Lead | ✅ 隔离 profile 安装/卸载 20/20、F1/F2/CSS 全绿 | `install-drill.json`、`regression.json` | 2026-11-20 |
| 文档 | README、文档站六件套、发布材料 | 文档作者 / Lead | ✅ 版本口径与基线已同步到 1.0.0 | G11 结果 | 2026-11-20 |
| 发布阻塞项 | B1–B4 | 用户 / Lead | B2 ✅（2026-11-20 版权主体）、B4 ✅（2026-11-20 桌面 App 卸载/重装确认）；B1（远端与推送）、B3（发布授权）仍待清零 | §2 | 2026-11-20 |
| 发布批准 | 最终发布动作（B3） | 用户 | ⬜ 未授权 | §2 B3 | — |

> 签署规则：任一 `❌` 存在时不得发布；`⚠️` 项必须在 GitHub Release 说明与 README「已知限制」中如实披露；签署日期填写实际执行日。

## 5. 发布执行顺序

1. **文档与素材定稿**：README、文档站、CHANGELOG、发布截图完成公开口径重写；重跑 G10/G11。
2. **清零 B1/B2**：完成 1.0.0 收口提交与远端、LICENSE 主体定稿；B4 桌面 App 人工确认已于 2026-11-20 完成。
3. **最终门禁**：在最终树上重跑 G1–G9；重新 `npm pack` 生成最终 tarball，并重跑 G8 安装演练（若打包内容有变化），用新值更新 `build.json`/`pack.json`/`install-drill.json`/`regression.json`。
4. **取得 B3 授权后发布**：`npm publish` → 打 tag `v1.0.0` → GitHub Release（说明只取自 CHANGELOG 1.0.0 段）→ 社区市场提交（如适用）。
5. **发布后验证**：用 registry 包在全新隔离 profile 安装 + 冒烟，核对 `window.__ONESTEP__.version`；对照 `npm view dsh-onestep version`。
6. **回滚预案**：`npm deprecate` 标记问题版本 / dist-tag 指回旧版；用户侧卸载插件并重启（见[使用手册](../user-guide.md) §7.3/§7.4）。

> **重打包规则（关键）**：tarball 只含 6 个文件，其中 `README.md`、`LICENSE`、`package.json` 是打包内容的一部分——**任何打包内文件的改动（代码、README、LICENSE、元数据）都会改变 tarball 的字节数与 sha256**。因此：最终 tarball 必须在所有打包内文件定稿后重新生成，旧 tarball 不得直接发布；`client.js` 的 sha256 只受代码/构建影响，改文档不会改变它，但会改变 tarball 哈希与安装证据的适用性。

## 6. 证据与归档

- 每个门禁的证据文件、字段口径、复跑方式见[发布证据索引](evidence.md)；归档 JSON 必须晚于最后一次产物变更。
- 归档内容不得包含：本机绝对路径、账号/凭据、含凭据的访问地址、真实会话 ID/标题、内网地址、主机名。
- 原始日志、截图、浏览器 profile 与演练中间产物属于本地工作产物，不入库（由 `.gitignore` 排除）；入库的只有脱敏后的结构化 JSON。
- 证据与产物必须能对上：`build.json.client.sha256` = 仓库 `client.js` = `pack.json.innerClientSha256`；`pack.json.sha256` = 实际用于 G8 的 tarball。

## 7. 相关文档

| 文档 | 内容 |
|---|---|
| [使用手册](../user-guide.md) | 安装、第一次进舞台、日常操作、快捷键、设置、排障 |
| [兼容性说明](../compatibility.md) | DSH rc 支持范围、非公开扩展点与升级契约流程 |
| [发布证据索引](evidence.md) | 本轮 6 个证据文件的内容、判读与复跑方式 |
| [发布前审查报告](../review/0.7.0-pre-release.md) | 0.7.0 代码/兼容/打包审查、修复与未修复项（历史基线） |
| [本轮审查记录](../review/2026-11-20-review.md) | 1.0.0 收口前的审查、修复与独立复验 |
| [变更日志](../../CHANGELOG.md) | 1.0.0 的 Added/Changed/Fixed/Known limitations |
| [安全声明](../../SECURITY.md) · [许可证](../../LICENSE) | 安全渠道、隐私边界、MIT 许可 |
