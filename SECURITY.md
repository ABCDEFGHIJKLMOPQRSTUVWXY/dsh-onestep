# 安全政策（Security Policy）

本项目是 DSH（DeepSeek Harness）的第三方客户端插件 **dsh-onestep**（会话舞台）。本文件说明漏洞报告渠道、支持版本范围，以及插件当前的安全与隐私边界。

> 仓库地址：`<your-org>/dsh-onestep`（首次公开发布时替换为实际地址）。

## 1. 报告漏洞

**请不要在公开 issue / 讨论区里报告安全漏洞，也不要贴出可复现的攻击细节。**

- **首选渠道：GitHub Private Vulnerability Reporting（PVR）** —— 在仓库的 **Security → Advisories → Report a vulnerability** 中私密提交。
- **渠道尚未就绪时**：在仓库开一个 issue，内容只写「需要安全报告渠道」，**不要包含任何漏洞细节**；维护者会提供私下渠道。
- 报告时请提供（可脱敏）：受影响版本、DSH 版本与 profile 类型（desktop/web）、复现步骤、影响评估、修复建议（可选）。
- **报告与截图中不得包含**：token、cookie、凭据、会话内容、内网地址、主机名等敏感信息。若已泄露，请先撤销/更换并在报告中说明。
- 本项目**不提供漏洞赏金**。

**响应口径（不承诺 SLA）**：会尽力确认、评估并修复已报告的问题，但不承诺响应时间、修复时间或披露时间表。修复以 patch/minor 版本发布，并在 [CHANGELOG](CHANGELOG.md) 的 `Security` 分类中说明；细节在修复可用后再公开。

## 2. 支持版本范围

版本策略跟随 DSH 的 rc 发布线（见 [兼容性文档](docs/compatibility.md)）：**每次 DSH 新 rc 适配后，支持「当前最新 rc + 上一个 rc」**；插件自身发布版本随适配递增。

| 版本 | 支持状态 |
|---|---|
| 最新发布版本（首个公开发布版本 **`1.0.0`**） | ✅ 接收并修复安全报告 |
| 上一 rc 适配版本 | ✅ 接收；仅在最近一次适配内修复 |
| 更早的插件版本 | ❌ 请先升级到最新版本再报告 |
| 超出 DSH 支持范围的版本（`engines.dsh` = `>=0.2.2-rc.1 <0.3.0-0 || >=0.2.1-rc.5 <0.2.2-0`） | ❌ 不承诺支持 |

**不在本项目范围内**：DSH 本体（DeepSeek Harness）的安全问题请报告给 DSH 官方渠道；第三方市场/分发渠道的问题请报告给对应渠道。

## 3. 安全与隐私声明（当前实现事实）

以下描述插件在基线上的实际行为（来自源码与实测，不是承诺性营销）：

- **无网络外发、无遥测**：插件不发起任何网络请求，不采集、不上报使用数据（构建产物静态审计：fetch/XMLHttpRequest/WebSocket/sendBeacon 均为 0）。
- **仅本地 localStorage**：使用 `dsh.onestep.v1`（舞台状态：候场 roster、候场栏方向/尺寸、预览档、动效偏好等，300ms 节流写入）与 `dsh.onestep.companion.v1`（浮窗元数据）；不含会话内容、不写凭据。
- **只读官方存储**：为在舞台未挂载时推断主绑定会话，读取 `dsh.sessions.current`；浮窗对账读取 `dsh.sidebar-right.v1.*`。解析失败即忽略，不写回官方存储。
- **不读凭据、不采集会话内容**：不访问凭据文件，不把会话正文写入日志或存储；宿主半（Node 侧）默认只在控制台记录 apply/dispose 探针事件（JSONL 仅在显式配置 `probeLog` 或环境变量 `ONESTEP_P0_LOG` 时写文件）。
- **无第三方运行时依赖**：运行时只有仓库内的 `index.js` / `client.js`；`esbuild` 仅是构建期 devDependency，不做远程代码加载。
- **不改 DSH 本体**：不修改 DSH 安装目录、不 patch 官方 bundle、不依赖运行时 import 其他 feature 插件；卸载后不再加载。
- **诊断面**：`window.__ONESTEP__` 在本页内暴露版本、只读快照（含会话标题采样与会话 ID）与动作接口（`actions` 可驱动舞台行为）、事件日志。它只在页面同源上下文可见，但**始终存在**（探针面板才由 localStorage 开关控制）。提交 issue 前请自行脱敏。
- **非公开扩展点**：为得到官方没有的能力，插件会①包装官方 `sidebarRight.openResource/openTab`；②向官方浮窗 DOM 注入属性/样式与自绘标签层；③沿 React fiber 读取官方 FloatLayer 的 `intents.resizeFloat`；④读取上述官方 localStorage 键。**能力自检失败时自动退回官方行为**；升级 DSH 时需按[兼容性文档](docs/compatibility.md)做契约核对。

## 4. 已知环境安全边界（如实披露）

1. **本机回环地址上的 `/plugins/**` 无鉴权**：同机任意进程可匿名读取插件 bundle（`/` 与 `/api` 有 token/cookie 准入）。这是 DSH 插件分发机制本身的暴露面，不是本插件引入；**不要把 DSH 实例暴露到不可信网络**。
2. **插件与页面同权限**：客户端半运行在 DSH 页面上下文中，具备页面上下文的客户端能力（可读 DOM、localStorage 等）。威胁模型**不覆盖**已被入侵的本机、恶意 DSH 插件或其他同权限扩展。
3. **桌面 profile 由 Electron 应用管理**：桌面侧安装/启用/卸载/回滚只经 App 的 Plugins 页；CLI 对 desktop profile **仅只读 `list` 可用**，`add`/启动会被拒绝。桌面侧权限以 DSH 官方行为为准。
4. **bundle 加载失败会阻塞整页 boot**：这是 DSH 的 boot 图契约。发布前必须冒烟；回滚方式是一条卸载命令（见[使用手册](docs/user-guide.md)的排障一节）。

## 5. 安全相关变更流程

- 修复走正常发版：改代码 → 构建一致性 + 单测 + 兼容门禁 → 版本号与 `CHANGELOG` 的 `Security` 条目 → 发布（见[发布检查表](docs/release/checklist.md)）。
- 紧急情况可先发 patch 并在发布说明注明影响范围；必要时在 README/市场页面标注最低安全版本。
- 本文件与 README 的隐私口径必须保持一致，任一方更新时同时改另一方。
