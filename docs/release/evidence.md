# 发布证据索引（dsh-onestep 0.7.0）

> 用途：索引 0.7.0 公开发布的门禁证据。证据由 Lead 在发布收口时用固定脚本从可复跑门禁输出汇总生成，归档为**脱敏后的结构化 JSON**；本文件只负责「有哪些证据、怎么读、怎么复跑」，不替代 JSON 本身。
> 归档位置：`docs/release-evidence/`（随仓库入库）。原始日志、截图、浏览器数据、安装演练中间产物属于本地工作产物，**不入库**。
> 对应检查表：[发布检查表](checklist.md)（门禁编号 G1–G11、阻塞项 B1–B4）。
> 采集基线：插件 **0.7.0** / DSH Desktop **0.2.2-rc.1**；构建产物 `client.js` **324696 B / sha256 `CC3D0F1C11A7C790B993677F61DB8117DB741DA345B577D751AC566D6FF76993`**。每条证据文件内均带 `generatedAt`，以该时间判断是否晚于最后一次产物变更。

## 1. 证据文件索引

| 证据文件 | 覆盖门禁 | 内容口径（字段） | 本轮基线判读 | 复跑入口 |
|---|---|---|---|---|
| `build.json` | G1、G2、G3 | `pluginVersion`、`dshBaseline`、`client.{bytes,sha256}`、`reproducible`、`builder.{esbuild,format,platform,target,externals}`、`generatedAt` | `0.7.0` / `0.2.2-rc.1`；`client` = 324696 B / `CC3D0F1C…F76993`；可复现（连续两次构建同哈希）；构建器 esbuild 0.25.0 / cjs / browser / chrome120 / 11 项 external | [scripts/build.mjs](../../scripts/build.mjs) + `Get-FileHash client.js -Algorithm SHA256` |
| `tests.json` | G4 | `command`、`total`、`pass`、`fail`、`testFiles`、`note`、`generatedAt` | `npm test` = **151/151** pass、0 fail、13 个测试文件（含新增 `tests/styles.test.mjs` 的 4 条 CSS 结构回归） | `npm test` |
| `gates.json` | G5、G6、G10、G11 | `engines.{pass,range,satisfies}`、`i18n.{pass,details}`、`releaseHygiene.{pass,checks,hits}`、`releaseLinks.{pass,checks}`、`syntax.{pass,command}`、`generatedAt` | engines PASS（范围见检查表 G6，矩阵样本全部符合预期）；i18n PASS（zh/en=75、hardcoded=0）；发布自查 25/25、未忽略命中 0；语法检查 exit 0。**`releaseLinks` 与 `releaseHygiene` 的文档项须在文档定稿后重跑回填** | `npm run compat:engines`、`npm run i18n:check`、`npm run p3:hygiene`、`node scripts/p2/shots/check-release.mjs`、`node --check client.js` |
| `pack.json` | G7 | `bytes`、`sha256`、`entries`、`whitelist`、`innerClientSha256`、`matchesRepo`、`generatedAt`（如由打包核对脚本直接生成，可能附带 `filename`/`npmShasum` 等来源字段） | 6 个文件恰为白名单；包内 `client.js` 哈希 = 仓库文件；归档 tarball **95272 B / sha256 `65F57DA1…BC1A`**。**打包内文件（README/LICENSE/元数据）定稿后须重新 pack 并更新本文件** | `npm pack --dry-run --json`；带哈希的核对脚本 [scripts/p2/pack/check-pack.mjs](../../scripts/p2/pack/check-pack.mjs) |
| `install-drill.json` | G8 | `environment.{dshVersion,profileKind,browser}`、`steps[]`（每步 `id`/`pass`）、`passed`、`total`、`assertions.{bootEntriesContainsPlugin,onestepGlobalReady,pageErrors,uninstallRevertsEntries,noResidue}`、`generatedAt` | 隔离 profile + headless Edge；步骤 **11/11** 通过；boot 条目含插件、`__ONESTEP__` 就绪、pageerror 0、卸载回落、无残留 | 按[检查表](checklist.md) G8 的安装/启动/探测/卸载步骤在全新隔离 profile 复跑 |
| `regression.json` | G9 | `ok`、`css.{pass,ruleCount,checks}`、`f1.{pass,assertions}`、`f2.{pass,assertions}`、`pageErrors`、`consoleErrors`、`generatedAt` | `ok=true`；CSS 样式表 **181** 条规则、关键选择器命中；F1 断言全 true；F2 的核心断言（焦点移到新会话、被降级会话有 demote 记录、无 `ref.release`/`ref.retain`、仍正常渲染）全 true（`conversationAWrapperDomSameNode=false` 属架构预期：焦点/候场是不同 slot 实例，内容包装节点会重建，但会话引用未释放）；pageErrors/consoleErrors = 0 | 同一隔离实例上复跑定向回归（随 G8 演练执行） |

> 「本轮基线判读」是撰写本索引时（2026-11-19）的归档值，用于核对生成结果是否漂移；**发布签署以最终重跑生成的 JSON 为准**。
>
> 时序提醒：本批 JSON 生成于 2026-11-19T09:51Z；此后 README 等**打包内文件**已按公开发布口径重写，故 `pack.json` 的 tarball 字节数/哈希与 `install-drill.json` 所对应的安装包需要在文档定稿后重新生成/重跑并回填（见 §5）。`build.json`、`tests.json`、`regression.json` 的代码结论不受文档改动影响。

## 2. 怎么读这些证据

1. **先对时间**：每个文件都有 `generatedAt`；证据必须晚于最后一次影响产物的变更（代码、`client.js`、打包内文件、版本号、文档）。时间早于变更的证据一律视为过期。
2. **再对哈希**：`build.json.client.sha256` = 仓库 `client.js` 的 sha256 = `pack.json.innerClientSha256`；`pack.json.sha256` = 实际用于安装演练的 tarball 哈希。三者对不上就不能签署。
3. **门禁判据**：`gates.json` 中 `engines.pass`、`i18n.pass`、`releaseHygiene.pass`、`releaseLinks.pass`、`syntax.pass` 必须全部为 `true`；`i18n.details` 应显示 zh/en 各 75 键、`hardcoded=0`。
4. **安装演练**：`install-drill.json` 的 `passed` 必须等于 `total`，`assertions` 五项全为 `true`（其中 `pageErrors` 为 0）。
5. **回归**：`regression.json` 的 `ok` 为 `true`，且 `f1.pass`、`f2.pass`、`css.pass` 均为 `true`。
6. **一致性**：任何一项与检查表的「通过判据」不一致时，按门禁失败处理——重跑，而不是修改本索引。

## 3. 复跑方式（发布前必须执行）

在仓库根按[发布检查表](checklist.md) §1 执行对应命令；要点：

- **构建与产物**：`node scripts/build.mjs` 两次，比对 `Get-FileHash client.js -Algorithm SHA256` 与字节数；`node --check client.js`。
- **测试**：`npm test`。
- **门禁**：`npm run compat:engines`、`npm run i18n:check`、`npm run p3:hygiene`、`node scripts/p2/shots/check-release.mjs`。
- **打包**：`npm pack --dry-run --json` 核对 6 个白名单文件；正式核对脚本见 [scripts/p2/pack/check-pack.mjs](../../scripts/p2/pack/check-pack.mjs)。
- **安装演练与回归**：在全新隔离 profile 上按 G8 步骤执行（安装 → 重启 → boot/舞台探测 → 退出 → 卸载 → 重启回落），并在同一实例上跑 G9 的三项回归。

所有可复跑脚本都在 `scripts/` 下；建议按「构建 → 单测 → 门禁 → 打包 → 安装演练」顺序执行，避免旧证据覆盖新产物。

## 4. 归档边界（什么入库、什么不入库）

| 类别 | 是否入库 | 说明 |
|---|---|---|
| 上述 6 个结构化 JSON | ✅ | 只含版本号、哈希、计数、布尔断言等可公开信息 |
| 原始日志 / 截图 / 浏览器 profile / 演练中间产物 | ❌ | 属本地工作产物，已被 `.gitignore` 排除（含访问凭据、本机路径或会话痕迹） |
| 含访问凭据的地址、账号信息、本机绝对路径、真实会话 ID/标题、内网地址/主机名 | ❌ | 生成证据前必须剔除；发布自查（G10）与脱敏扫描（G11）负责兜底 |

生成证据时的脱敏要求：会话 ID 只保留数量/布尔结论，不保留原文；路径只写相对路径或占位符；不写访问凭据；不写主机名与内网地址。

## 5. 证据失效与重生成触发条件

出现以下任一变更后，对应证据必须重生成，否则不得签署发布：

| 变更 | 需要重生成的证据 |
|---|---|
| `client.js`（代码、构建脚本、依赖、构建目标/external 表） | `build.json`、`pack.json`、`install-drill.json`、`regression.json` |
| 版本号、`engines.dsh`、`package.json` 元数据 | `build.json`、`pack.json`、`gates.json` |
| 打包内文件（`client.js`/`index.js`/`cordis.patch.yml`/`README.md`/`LICENSE`/`package.json`） | `pack.json`、`install-drill.json`（tarball 字节数与哈希会变化） |
| i18n 字典、发布自查脚本、文档链接结构 | `gates.json` |
| 测试文件 | `tests.json` |

> 特别说明：`README.md` 是打包内容的一部分。文档重写会改变 tarball 的字节数与 sha256（不改变 `client.js` 哈希），因此**最终 tarball 必须在所有打包内文件定稿后重新生成**，并重跑安装演练与 `pack.json`。

## 6. 相关文档

| 文档 | 内容 |
|---|---|
| [发布检查表](checklist.md) | 0.7.0 门禁判据、阻塞项、签署表与发布顺序 |
| [使用手册](../user-guide.md) | 安装、首次进舞台、日常操作、排障与卸载 |
| [发布前审查报告](../review/0.7.0-pre-release.md) | 0.7.0 审查范围、修复项、未修复项与证据索引 |
| [变更日志](../../CHANGELOG.md) | 版本变更与已知限制 |
| [兼容性说明](../compatibility.md) | DSH rc 支持范围与升级契约流程 |
