# 发布检查表（dsh-onestep 0.7.0）

> 用途：`dsh-onestep` 首次公开发布（**0.7.0**）的收敛版检查表与签署表。**每一项都必须能复跑，无证据不得勾选**；本表只覆盖 0.7.0，不保留历史版本段落。
> 状态图例：✅ 通过（有归档证据）｜⬜ 待执行（发布前必须清零）｜⚠️ 有条件通过（必须在发布说明中如实披露）｜❌ 阻塞（不得发布）。
> 事实基线：插件 **0.7.0**；DSH Desktop **0.2.2-rc.1**；支持范围 `>=0.2.2-rc.1 <0.3.0-0 || >=0.2.1-rc.5 <0.2.2-0`；构建产物 `client.js` **324696 B / sha256 `CC3D0F1C11A7C790B993677F61DB8117DB741DA345B577D751AC566D6FF76993`**；单测 **151/151**；i18n zh/en 各 **75 键**；归档 tarball **95272 B / sha256 `65F57DA1F075FDB78DE4EA10DA291D77C4EEA89DFC409E5697458BA68214BC1A`**（6 个文件）。
> 证据归档：结构化证据在 `docs/release-evidence/`，索引与口径见 [发布证据索引](evidence.md)。原始日志、截图、浏览器数据等临时产物不入库。

## 1. 发布门禁（G 组）

> 门禁命令均在仓库根执行；Windows PowerShell 语法，其它平台按等价命令替换。所有门禁应在**最终发布树**上重跑一次。

| # | 检查项 | 复跑命令 | 通过判据 | 状态 | 证据 |
|---|---|---|---|---|---|
| G1 | 版本一致性（5 处） | ① `node -e "const fs=require('fs');const v=f=>{const m=fs.readFileSync(f,'utf8').match(/const VERSION = '([^']+)'/);return m&&m[1]};console.log(JSON.parse(fs.readFileSync('package.json','utf8')).version,JSON.parse(fs.readFileSync('package-lock.json','utf8')).version,v('index.js'),v('src/client/index.js'))"` ② `Select-String -Path CHANGELOG.md -Pattern '^## \[0\.7\.0\]'` | ① 输出 4 个值全部为 `0.7.0`；② CHANGELOG 存在 `## [0.7.0]` 段落；版本号变更后必须重建并重跑 G2–G9 | ✅ | `build.json`、`gates.json` |
| G2 | 构建可复现 | `node scripts/build.mjs` → `Get-FileHash client.js -Algorithm SHA256`；再重复一次 | 产物 **324696 B / sha256 `CC3D0F1C…F76993`**；连续两次构建 sha256 相同；构建后工作区无 `client.js` 差异。注意 `build:check` 只证明可构建、不比对磁盘产物，不能单独作为一致性证据 | ✅ | `build.json` |
| G3 | 产物语法 | `node --check client.js` | exit 0 | ✅ | `gates.json` |
| G4 | 单测 | `npm test` | **151/151 pass、0 fail**；13 个测试文件（含 CSS 结构回归 `tests/styles.test.mjs`） | ✅ | `tests.json` |
| G5 | i18n | `npm run i18n:check` | `ok=true`；zh=en=**75** 键；usedKeys=73、unused=0、missing=0、hardcoded=0、errors=0 | ✅ | `gates.json` |
| G6 | 兼容门禁（engines） | `npm run compat:engines` | PASS；`engines.dsh` 与声明范围逐字一致；支持 0.2.2-rc.1 / 0.2.1-rc.5，排除 0.2.0-rc.1 / 0.2.1-alpha.* / 0.2.2-alpha.* / 0.3.0-rc.*；用真实 semver `{includePrerelease:true}` 交叉校验，与宿主判定 0 处不一致 | ✅ | `gates.json` |
| G7 | 包内容 | `npm pack --dry-run --json`（或 `scripts/p2/pack/check-pack.mjs` 的输出作为来源） | 恰好 6 个文件：`LICENSE`/`README.md`/`client.js`/`cordis.patch.yml`/`index.js`/`package.json`；不含 `src/`、`tests/`、`scripts/`、`docs/`；包内 `client.js` sha256 等于仓库文件；最终 tarball 的字节数/sha256 记入 `pack.json` | ✅（归档值，见 §5 重打包规则） | `pack.json` |
| G8 | 安装演练（隔离 profile） | `dsh.cmd` 创建全新隔离 profile → `plugin --profile <p> add <tarball>` → 重启 → 探测 boot 条目与舞台 → 退出 → `remove` → 重启回落 | 演练步骤 **11/11** 通过；boot 条目含 `dsh-onestep`、`window.__ONESTEP__.version=0.7.0`、可进入舞台（1 焦点 + 1 候场）、退出恢复官方界面、卸载后条目回落且无插件全局/DOM/包目录残留；0 pageerror。**最终 tarball**（95272 B / `65F57DA1…BC1A`）另做 CLI 安装/卸载复验：add exit 0、bundles 含插件、remove exit 0、bundles 回落 | ✅ 浏览器演练在同代码产物（client.js 同 sha）+ 最终 tarball CLI 复验 | `install-drill.json` |
| G9 | 修复后定向回归 | 在同一构建的隔离实例上验证三项：唯一候场提升 / 换焦引用 / CSS 生效（演练已含） | F1：提升唯一候场时无 `stage.mount`/`stage.unmount`、舞台根与焦点窗节点身份保持；F2：被降级会话无 `ref.release`、仍正常渲染；CSS：样式表 **181** 条规则，`.onestep-rail-mini` / `.onestep-rail-scroll-btn` 命中且计算样式生效；0 pageerror | ✅ | `regression.json` |
| G10 | 发布自查（包内容/敏感串/忽略规则/文档） | `npm run p3:hygiene` | `ok=true`，**33/33** 检查通过、未忽略命中 **0**；`.gitignore` 覆盖依赖/临时产物/归档/第三方快照/本机浏览器数据；6 文件包白名单与版本一致性通过 | ✅ 最终树重跑 33/33、hits=0 | `gates.json` |
| G11 | 文档链接与脱敏 | `npm run docs:check` | 0 断链、0 违规链接目标（不指向未入库目录）、0 本机绝对路径/凭据形态/真实会话 ID 泄露；六份公开文档齐备；README 引用 5 张宽度 ≥1000 的截图；版本一致性通过 | ✅ 最终树重跑 **16/16**（扫描 10 个 Markdown、5 张截图） | `gates.json` |

> G10/G11 已在**文档与截图定稿后的最终树**上重跑（2026-11-19）；其结论针对最终 tarball 95272 B / `65F57DA1…BC1A` 与当前 `client.js` 324696 B / `CC3D0F1C…F76993`。

## 2. 发布阻塞项（清零前不得发布）

| # | 阻塞项 | 现状（2026-11-19） | 清零判据 | 归属 |
|---|---|---|---|---|
| B1 | **git 化** | ✅ 已完成 `git init` 与首个提交（154 文件，工作树干净，脱敏扫描 0 命中）；本地已打 tag `v0.7.0`；**尚无远端、未推送** | ① 首次提交前脱敏扫描 0 命中（已完成）；② 完成首个提交（已完成）；③ 配置远端并推送（需用户提供仓库地址并授权）；④ 推送 tag `v0.7.0`。验收：`git remote -v` 有远端、`git status` 干净、tag 指向提交与证据中 `client.sha256` 一致 | 用户提供远端 + 授权推送 |
| B2 | **LICENSE 版权主体** | `LICENSE` 当前为 `Copyright (c) 2026 dsh-onestep contributors`，未定稿；公开发布后不宜再改主体 | 确认最终版权主体（个人/组织/贡献者集合）；如需变更，同步 `LICENSE`、`package.json` 的 `license` 字段与 README 许可段，然后重跑 G1/G7/G8（打包内容变化会改变 tarball 哈希） | 用户决策 |
| B3 | **发布授权** | `npm publish`、GitHub Release、社区市场提交均为不可撤回的外向动作，**尚未取得用户明确授权** | 用户明确授权发布；发布前复查包名 `dsh-onestep` 在目标 registry 未被占用（最近一次复查为未占用，发布前需再查）；发布后用 registry 包在全新隔离 profile 安装复测（不得用本地 tarball 替代） | 用户授权 + Lead 执行 |
| B4 | **桌面 App 人工确认** | 桌面 profile 由 App 独占管理，CLI 只有只读 `list` 可用；App 内 Plugins 页的安装/启用/卸载/回滚**未做人工确认**（本次自动化只在隔离 profile 完成） | 在桌面 App 内完成「Plugins 页安装 → 重启 → 舞台可用 → 卸载 → 重启恢复官方界面」并记录结论；建议同时复验真实键盘快捷键链路（headless web profile 未覆盖） | 人工执行 |

## 3. 发布说明必须披露的项（非阻塞，⚠️）

| 项 | 现状 | 披露位置 |
|---|---|---|
| 上一 rc 未装机 | `0.2.1-rc.5` 仅在 `engines.dsh` 中声明支持，本机未安装，未做装机冒烟（仅有 semver 推演） | README/兼容性文档、CHANGELOG |
| 全量套件未复跑 | `p3:verify` / `p4:verify` 整套断言未在 0.7.0 构建上复跑（沿用 0.6.1 基线）；0.7.0 的改动由单测 + 定向回归覆盖 | CHANGELOG、[发布前审查报告](../review/0.7.0-pre-release.md) |
| 键盘链路环境限制 | 真实 `Ctrl+Alt+2` 在 headless web profile 中未触发（CDP 输入环境限制），F1/F2 回归改用 `__ONESTEP__.actions.promote` 路径验证；桌面实机键盘建议在 B4 一并复验 | [发布前审查报告](../review/0.7.0-pre-release.md)、B4 签署备注 |
| 桌面特有行为未实机截图 | Electron 全屏/标题栏等行为只做代码对齐与隔离实例验证，未做桌面实机截图 | 发布说明 |
| 非公开扩展点 | 包装 `sidebarRight.openResource/openTab`、官方浮窗 DOM 注入、fiber `intents.resizeFloat`、只读官方 localStorage；DSH rc 升级需契约 diff | [使用手册](../user-guide.md) §1、[兼容性说明](../compatibility.md)、SECURITY |
| 能力边界 | 缩放无键盘等价路径；浏览器 tab 仅桌面 profile；极简档 v1.1 未实现；滚动位置不持久化 | [使用手册](../user-guide.md) §1/§4、CHANGELOG |

## 4. 签署表

| 组 | 范围 | 负责人 | 结论 | 证据 | 日期 |
|---|---|---|---|---|---|
| 版本与构建 | G1–G3 | Lead | ✅ | `build.json` | 2026-11-19 |
| 测试与门禁 | G4–G6、G10 | Lead | ⚠️ G4–G6 ✅；G10 归档值通过，待文档定稿后重跑 | `tests.json`、`gates.json` | 2026-11-19 |
| 打包与安装 | G7–G8 | Lead | ✅（归档 tarball；最终树需重打包复跑） | `pack.json`、`install-drill.json` | 2026-11-19 |
| 修复后回归 | G9 | Lead | ✅ | `regression.json` | 2026-11-19 |
| 文档 | README、文档站六件套、发布材料 | 文档作者（docs-guide 等） | ⬜ 已交付使用手册/发布文档，待 Lead 复核与 G11 重跑 | G11 重跑结果 | 2026-11-19 |
| 发布阻塞项 | B1–B4 | 用户 / Lead | ❌/⬜ 待清零 | §2 | — |
| 发布批准 | 最终发布动作（B3） | 用户 | ⬜ 未授权 | §2 B3 | — |

> 签署规则：任一 `❌` 存在时不得发布；`⚠️` 项必须在 GitHub Release 说明与 README「已知限制」中如实披露；签署日期填写实际执行日。

## 5. 发布执行顺序

1. **文档与素材定稿**：README、文档站、CHANGELOG、发布截图完成公开口径重写；重跑 G10/G11。
2. **清零 B1/B2**：完成首次提交与远端、LICENSE 主体定稿；B4 桌面 App 人工确认。
3. **最终门禁**：在最终树上重跑 G1–G9；重新 `npm pack` 生成最终 tarball，并重跑 G8 安装演练（若打包内容有变化），用新值更新 `build.json`/`pack.json`/`install-drill.json`/`regression.json`。
4. **取得 B3 授权后发布**：`npm publish` → 打 tag `v0.7.0` → GitHub Release（说明只取自 CHANGELOG 0.7.0 段）→ 社区市场提交（如适用）。
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
| [发布前审查报告](../review/0.7.0-pre-release.md) | 0.7.0 代码/兼容/打包审查、修复与未修复项 |
| [变更日志](../../CHANGELOG.md) | 0.7.0 的 Added/Changed/Fixed/Known limitations |
| [安全声明](../../SECURITY.md) · [许可证](../../LICENSE) | 安全渠道、隐私边界、MIT 许可 |
