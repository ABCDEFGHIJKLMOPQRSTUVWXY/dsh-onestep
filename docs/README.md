# dsh-onestep 文档索引

> **2026-11-20 本轮更新**：190/190 单测、构建一致性、i18n、版本范围、文档检查及发布自查已通过。当前 `client.js` 为 347283 B / SHA-256 `5CA24A6E4FD0D00EE9926B10D823CEF9A55EB1D2ADF4290396C88B802CF14E2B`。详见 [审查与优化记录](review/2026-11-20-review.md)。隔离 profile 上已完成安装/卸载演练与 F1/F2/CSS 定向回归（G8/G9 ✅）；桌面 App 内安装/卸载（B4）已由用户确认（2026-11-20）。

本目录是 **dsh-onestep 1.0.0** 的公开文档入口。所有文档与当前发布版本（DSH 基线 `0.2.2-rc.1`）同步；安装命令与代码事实以仓库当前状态为准，截图位于 `docs/assets/`。

如果你只想先把它跑起来，直接看仓库根目录的 [README.md](../README.md)；本文按「读者是谁」组织其余文档。

---

## 1. 按读者选阅读路径

### 第一次接触 DSH / 第一次安装

1. [README.md](../README.md)：项目定位、核心体验、安装、快速上手、快捷键、设置与已知限制；
2. [docs/user-guide.md](user-guide.md)：所有操作的完整手册与故障排查；
3. [SECURITY.md](../SECURITY.md)：只需知道隐私边界时读 §3「安全与隐私声明」。

### 部署到团队 / 准备升级 DSH

1. [docs/compatibility.md](compatibility.md)：支持范围、插件依赖的 DSH 契约面、rc 升级 diff 清单与回退方式；
2. [SECURITY.md](../SECURITY.md)：环境安全边界（含本机回环 `/plugins/**` 无鉴权等披露）；
3. [README.md](../README.md) §3：桌面 App / 隔离 profile / npm 三种安装路径与卸载回滚。

### 开发、二次开发与排障

1. [docs/architecture.md](architecture.md)：插件形态与装载、自适应接管、状态层、窗口层、浮窗层、动效层与模块地图；
2. [src/client/](../src/client/)：浏览器半源码（`adapter.js` 是 DSH 契约单一源）；
3. [tests/store.test.mjs](../tests/store.test.mjs)：node:test 单测入口之一（自动发现测试文件）；
4. [scripts/build.mjs](../scripts/build.mjs)：构建脚本（兼容、i18n、验证与发布自查脚本在 `scripts/` 下）；
5. [docs/review/0.7.0-pre-release.md](review/0.7.0-pre-release.md)：发布前代码审查的发现、修复与二次验证。

### 发布负责人 / 审计者

1. [docs/release/checklist.md](release/checklist.md)：1.0.0 发布检查表与签署项；
2. [docs/release/evidence.md](release/evidence.md)：1.0.0 证据索引与可复跑命令；
3. [docs/review/0.7.0-pre-release.md](review/0.7.0-pre-release.md)：0.7.0 发布前审查结论与残项（历史基线）；
4. [docs/review/2026-11-20-review.md](review/2026-11-20-review.md)：1.0.0 收口前的审查、修复与独立复验记录；
5. [CHANGELOG.md](../CHANGELOG.md)：版本策略与逐版本变更。

---

## 2. 文档一览

| 文档 | 读者 | 内容 |
|---|---|---|
| [README.md](../README.md) | 第一次接触的用户 | 定位、核心体验、安装、快速上手、键盘、设置、已知限制、兼容、隐私、许可 |
| [docs/user-guide.md](user-guide.md) | 日常使用者 | 舞台与候场栏、伴生浮窗、收起标签、快捷键、设置项、故障排查 |
| [docs/architecture.md](architecture.md) | 开发者 / 二次开发 | 插件双半结构、插槽接管、窗口/浮窗/动效渲染路径、状态与持久化、模块地图 |
| [docs/compatibility.md](compatibility.md) | 维护者 / 升级 DSH 的人 | 支持范围、契约清单、rc 升级 diff 与兼容回归、失效回退 |
| [docs/release/checklist.md](release/checklist.md) | 发布负责人 | 发布前置、门禁命令、签署项与发布后验证 |
| [docs/release/evidence.md](release/evidence.md) | 发布负责人 / 审计者 | 当前产物的构建、测试、打包、安装演练证据索引 |
| [docs/review/0.7.0-pre-release.md](review/0.7.0-pre-release.md) | 审阅者 | 审查范围与方法、已修复项、未修复残项、版本兼容与打包结论 |
| [CHANGELOG.md](../CHANGELOG.md) | 所有用户 | 变更日志（Keep a Changelog）、版本策略与已知限制 |
| [SECURITY.md](../SECURITY.md) | 安全报告者 / 部署者 | 漏洞报告渠道、支持版本、隐私与安全边界、环境暴露面 |
| [LICENSE](../LICENSE) | 所有人 | MIT 许可证与版权声明 |
| `docs/assets/`（5 张 PNG + `MANIFEST.json`） | 所有人 | 公开发布截图（隔离 DSH_HOME + 合成会话，无真实使用记录），命名为 `NN-语义.png`；README 引用全部 5 张（02 / 03 / 04 / 08 / 11） |
| [src/client/](../src/client/) | 开发者 | 浏览器半源码：`adapter` / `store` / `layout` / `stage-root` / `float-*` / `peek-*` / `motion` 等 |
| [tests/store.test.mjs](../tests/store.test.mjs) | 开发者 | 单测：状态机、布局、内容工厂、浮窗、i18n、样式结构等 |
| [scripts/build.mjs](../scripts/build.mjs) | 开发者 / 发布负责人 | 构建脚本；兼容/i18n/验证与门禁脚本、`p3/verify/release-hygiene.mjs` 发布自查在 `scripts/` 下 |

---

## 3. 术语与约定

本文档与 DSH 术语保持一致，避免同一概念多种叫法：

| 术语 | 含义 |
|---|---|
| 插槽 / slot | DSH 客户端 UI 的扩展点（如会话主区 `main`、overlay 覆盖层）；插件通过注册/覆盖插槽参与界面 |
| cordis | DSH 的插件运行时与依赖注入框架；插件声明 `inject` 的服务，用 `ctx.effect` 管理生命周期 |
| profile | DSH 的运行配置（插件集合 + 会话目录）。`desktop` 由桌面 App 独占管理；隔离 profile 供开发/验证 |
| bundle | 一组插件的装载清单；`cordis.patch.yml` 负责把包挂进 profile 的 loader 树 |
| composer | 会话底部的输入区（发送、停止、草稿都在这）；候场窗隐藏 composer 且 `inert` |
| 焦点会话 | 舞台中央、完整可交互的会话 |
| 候场会话 | 舞台候场栏里「可看不可输入」的会话；提升后与焦点互换 |
| 舞台 / stage | 插件接管会话主区后的 1 焦点 + N 候场布局 |
| 候场栏 | 左侧或顶部的候场卡容器；可拖比例、可收起、可滚动 |
| 静态快照 / 精简卡 | 候场卡两种预览档：官方聊天画面渲染一次后的静态快照（状态变化时重拍），或标题/状态/最近提问 |
| 伴生浮窗 | 舞台内文件/文档/终端/浏览器 tab 在右侧的独立浮窗 |
| 收起标签 | 浮窗全部收起后右缘的堆叠标签；可逐个恢复、整堆上下拖动 |
| 适配层 / adapter | `src/client/adapter.js`：插槽名、服务方法、DOM 选择器、存储键与限额的单一来源 |

---

## 4. 文档与代码的对应关系

改代码时同步更新对应文档，避免文档与实现漂移：

| 变更类型 | 需要同步的文档 |
|---|---|
| 用户可见行为（入口、快捷键、设置、限制） | [README.md](../README.md) + [docs/user-guide.md](user-guide.md) |
| 结构与实现方式（模块、渲染路径、状态机） | [docs/architecture.md](architecture.md) |
| 对 DSH 的依赖或兼容范围 | [docs/compatibility.md](compatibility.md) + `engines.dsh` |
| 版本、发布与产物哈希 | [CHANGELOG.md](../CHANGELOG.md) + [docs/release/checklist.md](release/checklist.md) + [docs/release/evidence.md](release/evidence.md) |
| 安全口径 / 隐私边界 | [SECURITY.md](../SECURITY.md)（与 README §8 保持一致） |
| 截图 | `docs/assets/`（文件名 `NN-语义.png`；README 与 user-guide 引用同名文件） |

---

## 5. 文档维护约定

1. **只链接仓库内真实存在的文件**：公开文档不引用未入库的本地材料，避免发布后出现 404。
2. **命令可直接复制**：涉及本机路径时使用占位符 `<DSH 安装目录>`、`<本仓库目录>`、`<profile>`，不写个人绝对路径。
3. **事实以当前构建为准**：不写未实测的能力、不写交付时间承诺；已知限制与未实现项如实标注（如「极简档为 v1.1 候选、未实现」）。
4. **版本号单一来源**：`package.json` 的 `1.0.0` 与宿主半 `index.js` 的版本常量一致；文档中引用版本时以两者为准。
5. **截图来自隔离 profile**：发布截图在隔离 profile 中用合成会话截取，不含真实会话标题、token、cookie 或本机路径。
6. **发布前复查**：按 [docs/release/checklist.md](release/checklist.md) 逐项签署；证据索引见 [docs/release/evidence.md](release/evidence.md)。

---

## 6. 版本与状态

- **插件版本**：`dsh-onestep` 1.0.0（首个公开发布版本）；
- **DSH 基线**：Desktop `0.2.2-rc.1`；支持范围 `>=0.2.2-rc.1 <0.3.0-0 || >=0.2.1-rc.5 <0.2.2-0`；
- **许可**：MIT，见 [LICENSE](../LICENSE)；
- **当前构建产物（2026-11-20）**：`client.js` 347283 B / sha256 `5CA24A6E4FD0D00EE9926B10D823CEF9A55EB1D2ADF4290396C88B802CF14E2B`；`build:check` 已验证源码与磁盘产物一致；本轮单测 190/190；隔离 profile 上已完成安装/卸载演练与 F1/F2/CSS 定向回归，桌面 App 内卸载/重装已由用户确认（B4 ✅），见 [本轮审查记录](review/2026-11-20-review.md)。
- **tarball（2026-11-20 重打包）**：`dsh-onestep-1.0.0.tgz` 101808 B / sha256 `0B9C8D57F37560DEDDCE1ABB298159668E6B97CF107365B04F96BF0EDF5516BF`，6 个文件（白名单一致，包内 `client.js` 与仓库同哈希）；隔离 profile 安装/卸载演练已复跑（G8 ✅），P3/P4 全量端到端与桌面 App 内确认仍待补齐。