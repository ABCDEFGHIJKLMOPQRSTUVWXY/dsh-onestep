#!/usr/bin/env node
/**
 * dsh-onestep P2-5 静态契约集中度检查（inventory）。
 *
 * 目的：把「DSH 外部契约只在 src/client/adapter.js 出现」这条模块纪律变成可复跑的门禁。
 * 扫描 src/client 下全部 .js 的代码（注释已剥离，行号保留），提取外部契约字面量：
 *   - slot     插槽名（main / conversation.content / shell.overlay / onestep.window …）
 *   - service  Cordis 服务名（sessions / uiWorkspace / sidebarRight / shortcuts …，含 ctx.get/inject 实参）
 *   - factory  Component Factory 名与 variant（conversation.content / embedded）
 *   - dom      官方 DOM/拖拽弱契约（data-row-key / text/plain / data-slot="…" …）
 *   - 其它：boot 全局、资源 scheme、官方 storage 键、pendingInteraction.kind 枚举、官方 tab kind、
 *     快捷键服务契约值（code/modifiers/profile/region）等，见 CATEGORY 注释。
 *
 * 判定：
 *   centralized  = 字面量出现在 adapter.js（单一事实源）
 *   exemptions   = 出现在其它模块，但已在下方 EXEMPTIONS 逐条登记理由（含 debt:true = 待收口债务）
 *   violations   = 其余未集中、未登记的字面量 → 退出码 1
 *
 * 退出码：0 无违规（豁免均已有书面理由）；1 存在违规；2 用法/内部错误。--strict 时豁免也判失败，
 * 用于 adapter 收口完成后把门禁收紧（当前 baseline 会因 debt 豁免失败，属已知技术债）。
 *
 * 用法（仓库根目录）：
 *   node scripts/p2/compat/inventory.mjs
 *   node scripts/p2/compat/inventory.mjs --json artifacts/p2/compat/inventory.json
 *   node scripts/p2/compat/inventory.mjs --strict
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const CLIENT_DIR = path.join(ROOT, 'src', 'client')
const ADAPTER_REL = 'src/client/adapter.js'
const ADAPTER_ABS = path.join(ROOT, ADAPTER_REL)
const OUT_DEFAULT = path.join(ROOT, 'artifacts', 'p2', 'compat', 'inventory.json')
const SCANNER_VERSION = '1.0.0'
const BASELINE_DSH = '0.2.2-rc.1'

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const cfg = { json: OUT_DEFAULT, strict: false, quiet: false, help: false, listAll: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json' || arg === '-o') cfg.json = path.resolve(ROOT, argv[++i])
    else if (arg === '--strict') cfg.strict = true
    else if (arg === '--quiet') cfg.quiet = true
    else if (arg === '--all') cfg.listAll = true
    else if (arg === '--help' || arg === '-h') cfg.help = true
    else throw new Error('unknown argument: ' + arg)
  }
  return cfg
}

// ---------------------------------------------------------------------------
// 字面量提取：先剥注释（保留行号），再逐字符读引号字面量
// ---------------------------------------------------------------------------

/** 把注释替换为空格（换行保留），避免注释里的契约名制造假阳性。 */
export function stripComments(src) {
  let out = ''
  let i = 0
  let state = 'code'
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; out += '  '; i += 2; continue }
      if (c === '/' && n === '*') { state = 'block'; out += '  '; i += 2; continue }
      if (c === "'" || c === '"' || c === '`') { state = c; out += c; i += 1; continue }
      out += c
      i += 1
      continue
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c } else out += ' '
      i += 1
      continue
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; out += '  '; i += 2 } else { out += c === '\n' ? '\n' : ' '; i += 1 }
      continue
    }
    // 字符串/模板字面量内部：原样保留，遇到闭合引号回到 code
    if (c === '\\') { out += c + (n === undefined ? '' : n); i += 2; continue }
    if (c === state) { state = 'code'; out += c; i += 1; continue }
    out += c
    i += 1
  }
  return out
}

/** 提取 '…' / "…" / `…`（单行）字面量，带 1-based 行号与整行上下文。 */
export function extractLiterals(code) {
  const out = []
  let i = 0
  let currentLine = 1
  while (i < code.length) {
    const c = code[i]
    if (c === '\n') { currentLine += 1; i += 1; continue }
    if (c !== "'" && c !== '"' && c !== '`') { i += 1; continue }
    const quote = c
    const start = i
    let value = ''
    i += 1
    let closed = false
    while (i < code.length) {
      const ch = code[i]
      if (ch === '\\') { value += ch + (code[i + 1] === undefined ? '' : code[i + 1]); i += 2; continue }
      if (ch === quote) { closed = true; i += 1; break }
      if (ch === '\n') break
      value += ch
      i += 1
    }
    if (closed && value.length <= 80) {
      const lineStart = code.lastIndexOf('\n', start) + 1
      const lineEnd = code.indexOf('\n', start)
      const ctx = code.slice(lineStart, lineEnd === -1 ? code.length : lineEnd).trim()
      const before = code.slice(lineStart, start)
      out.push({ value, line: currentLine, context: ctx, before })
    }
    if (!closed) { i = start + 1; if (code[i] === '\n') currentLine += 0 }
  }
  return out
}

// ---------------------------------------------------------------------------
// adapter.js 白名单（单一事实源）
// ---------------------------------------------------------------------------

function blockAfter(src, header) {
  const at = src.indexOf(header)
  if (at === -1) return ''
  const start = src.indexOf('{', at)
  const listStart = src.indexOf('[', at)
  const isArray = listStart !== -1 && (start === -1 || listStart < start)
  if (isArray) {
    let depth = 0
    for (let i = listStart; i < src.length; i += 1) {
      if (src[i] === '[') depth += 1
      else if (src[i] === ']') { depth -= 1; if (depth === 0) return src.slice(listStart + 1, i) }
    }
    return ''
  }
  if (start === -1) return ''
  let depth = 0
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') { depth -= 1; if (depth === 0) return src.slice(start + 1, i) }
  }
  return ''
}

export function readAdapterWhitelist(adapterSrc) {
  const strings = (text) => [...text.matchAll(/['"]([^'"\n]+)['"]/g)].map((m) => m[1])
  const slots = strings(blockAfter(adapterSrc, 'export const SLOTS'))
  const services = strings(blockAfter(adapterSrc, 'export const SERVICES'))
  const inject = strings(blockAfter(adapterSrc, 'export const INJECT'))
  const factory = strings(blockAfter(adapterSrc, 'export const CONTENT_FACTORY'))
  const single = (name) => {
    const m = new RegExp('export const ' + name + " = '([^']+)'").exec(adapterSrc)
    return m ? [m[1]] : []
  }
  return {
    slots,
    services,
    inject,
    factory,
    storage: single('STORAGE_KEY'),
    probe: single('PROBE_FLAG_KEY'),
  }
}

// ---------------------------------------------------------------------------
// 契约字面量分类
// ---------------------------------------------------------------------------

const SERVICE_NAMES = new Set(['slots', 'sessions', 'uiWorkspace', 'uiSession', 'sidebarRight', 'sidebarRightTabs', 'layout', 'locale', 'shortcuts', 'theme'])
const SLOT_NAME_RE = /^(main|conversation|conversation\.[a-z0-9][a-z0-9.-]*|sidebar\.[a-z0-9][a-z0-9.-]*|shell\.[a-z0-9][a-z0-9.-]*|onestep\.(window|focus))$/
const DOM_LITERALS = new Set(['[data-row-key]', '[data-conversation-content]', '[class*="AppFrame"]', 'text/plain', 'session:', 'workspace:'])
const DRAG_DOM_RE = /^\[data-[a-z-]+\]$/
const SHORTCUT_VALUE_RE = /^(primary|alt|shift|meta|control|page|editable|terminal|handled|blocked|pass|web:windows|desktop:windows|web:macos|desktop:macos|web:linux|desktop:linux|Key[A-Z]|Digit[0-9])$/
const SHORTCUT_CONTEXT_RE = /shortcut|register|defaults|modifiers|code:|regions|resolve|aliases/i
const STATUS_ENUM = new Set(['question', 'plan', 'approval'])

/**
 * @param {string} relFile 相对仓库根路径
 * @param {{value:string,line:number,context:string}} literal
 * @returns {{category:string}|null}
 */
export function classifyLiteral(relFile, literal) {
  const { value, context, before } = literal
  // 诊断开关（#onestep=no-...）：只有 enabled(...) / FLAGS[...] 实参位置的旗标名属插件内部命名
  if (relFile === 'src/client/index.js' && (/\benabled\(\s*$/.test(before) || value === 'no-')) return { category: 'internal-flag' }
  // 自身标识与内部 DOM 标记不属 DSH 契约
  if (value === 'dsh-onestep') return { category: 'plugin-id' }
  if (value === 'onestepStage' || value === 'onestepQuickNew') return { category: 'retain-source' }
  if (/onestep/.test(value) && /^\[|^\.|^[a-z-]+$/.test(value) && !/^onestep\.(window|focus)$/.test(value)) return null
  if (value === 'conversation.content') return { category: 'factory' }
  if (value === 'embedded' && relFile === ADAPTER_REL) return { category: 'factory' }
  // conversation.session 的官方 view id（renderSlot('conversation.session', { view: 'chat' })）
  if (value === 'chat' && /\bview\b/.test(context)) return { category: 'factory-view' }
  if (/^dsh-resource:\/\//.test(value)) return { category: 'resource-scheme' }
  if (/^dsh\./.test(value)) return { category: 'storage-key' }
  // drag.js:164 的 'main' 是 DOM 选择器候选（mainAreaRect），不是 main 槽名
  if (value === 'main' && /selector|querySelector|candidates|closest/.test(context)) return { category: 'dom' }
  if (SLOT_NAME_RE.test(value)) return { category: 'slot' }
  if (SERVICE_NAMES.has(value)) return { category: 'service' }
  if (DOM_LITERALS.has(value) || DRAG_DOM_RE.test(value)) return { category: 'dom' }
  if (STATUS_ENUM.has(value) && /kind|pendingInteraction/.test(context)) return { category: 'status-enum' }
  if (value === 'browser' && /kind|Kinds/i.test(context)) return { category: 'sidebar-tab-kind' }
  if (relFile === 'src/client/index.js' && SHORTCUT_VALUE_RE.test(value) && SHORTCUT_CONTEXT_RE.test(context)) return { category: 'shortcut' }
  return null
}

// ---------------------------------------------------------------------------
// 豁免登记（每条必须有理由；debt:true 表示应在 adapter 收口，属已知技术债）
// ---------------------------------------------------------------------------

/**
 * 匹配规则：{ file?: 相对路径后缀, token: 字面量, category?: 分类, reason: 理由, debt?: boolean }
 * file 省略时匹配任意文件；token 支持 '*' 通配（用于成组的快捷键字面量）。
 */
export const EXEMPTIONS = [
  {
    file: 'src/client/index.js',
    token: '*',
    category: 'service',
    reason: 'ctx.inject([...])/scope.get(...) 直接写服务名字面量；adapter.SERVICES.sessions 已存在但此处未引用（Cordis 注入数组可读性取舍）。待收口：改用 SERVICES.sessions。',
    debt: true,
  },
  {
    file: 'src/client/companion.js',
    token: 'sidebarRight',
    category: 'service',
    reason: '伴生窗适配模块的独立 capability 探测（ctx.get）；adapter.SERVICES.sidebarRight 已存在但 companion.js 未引用。待收口：companion 复用 adapter 常量。',
    debt: true,
  },
  {
    file: 'src/client/companion.js',
    token: 'sidebarRightTabs',
    category: 'service',
    reason: 'adapter.SERVICES 未收录 sidebarRightTabs（官方 tab registry 服务）；伴生窗能力探测直接 ctx.get。待收口：补 SERVICES.sidebarRightTabs 后引用。',
    debt: true,
  },
  {
    file: 'src/client/companion.js',
    token: 'dsh-resource://',
    category: 'resource-scheme',
    reason: '官方 openResource 唯一接受的 scheme（ui-sidebar-right service.ts），在 companion.js 定义为 RESOURCE_SCHEME 常量；adapter 未收录。待收口：移入 adapter。',
    debt: true,
  },
  {
    file: 'src/client/companion.js',
    token: 'browser',
    category: 'sidebar-tab-kind',
    reason: '官方 sidebar tab kind（desktop-only，ui-sidebar-browser 提供）；伴生窗能力快照读取 tabKinds 判定。adapter 未收录 kind 枚举。',
    debt: true,
  },
  {
    file: 'src/client/content.js',
    token: 'conversation.session',
    category: 'slot',
    reason: 'conversation.content Factory 的局部 views 组件内 renderSlot("conversation.session")({view:"chat"})；P0 S4 已验证该 Factory 内层槽可渲染，是焦点窗聊天体的唯一入口。adapter 未收录（SLOTS 只有外层接管点）。待收口：新增 SLOTS.contentView。',
    debt: true,
  },
  {
    file: 'src/client/content.js',
    token: 'chat',
    category: 'factory-view',
    reason: 'conversation.session 的官方 view id（固定 Chat 视图，P0 S4 官方先例）；随 conversation.session 一并纳入 adapter。',
    debt: true,
  },
  {
    file: 'src/client/content.js',
    token: 'question',
    category: 'status-enum',
    reason: 'pendingInteraction.kind 官方枚举（P0 契约 §9.2：内置仅 approval/question，plan-review 也经 question 承载）；adapter SESSION_FIELDS.pendingKind 只透传 kind、未定义枚举。待收口。',
    debt: true,
  },
  {
    file: 'src/client/content.js',
    token: 'plan',
    category: 'status-enum',
    reason: '同上：plan 为历史/展示归类，非官方独立 kind；集中登记避免误判。',
    debt: true,
  },
  {
    file: 'src/client/drag.js',
    token: '*',
    category: 'dom',
    reason: '官方拖拽弱契约（P0 S7 实测）：data-row-key 行键、dataTransfer text/plain 纯 sessionId、[data-conversation-content] 会话区、AppFrame/main 选择器。开发文档 §11 允许 DOM 弱契约但必须有回退（drag.js 每个候选都有兜底 rect）。adapter 不收录 DOM 细节，登记为弱契约豁免（非债务）。',
    debt: false,
  },
  {
    file: 'src/client/stage-root.js',
    token: '*',
    category: 'dom',
    reason: '舞台内 drop 读取同一官方拖拽协议（dataTransfer text/plain，stage-root.js:428）；与 drag.js 共用弱契约。',
    debt: false,
  },
  {
    file: 'src/client/probe.js',
    token: '*',
    category: 'dom',
    reason: '探针只读断言官方 DOM 标记（[data-conversation-content] 统计舞台内外官方会话数量）；验证面，不参与产品路径。',
    debt: false,
  },
  {
    file: 'src/client/probe.js',
    token: '__DSH_BOOT__',
    category: 'boot-global',
    reason: '官方 boot 全局（release/entries/selfEntry），探针只读读取用于兼容冒烟证据面；产品逻辑不依赖。adapter 未收录 boot 契约。',
    debt: false,
  },
  {
    file: '*',
    token: '*',
    category: 'dom-slot-marker',
    reason: '官方聊天体内部 DOM 槽标记（data-slot="conversation.composer.bar" / data-chain-overlay-fallback="conversation.composer"），仅用于候场缩略图隐藏 composer（styles.js:77-78）。弱契约 + display 兜底，官方 DOM 变更时最坏表现为缩略图多出输入区，不影响主链路。',
    debt: false,
  },
  {
    file: '*',
    token: '*',
    category: 'status-enum',
    reason: 'pendingInteraction.kind 官方枚举（P0 契约 §9.2：内置仅 approval/question，plan-review 经 question 承载；plan 为展示归类）。adapter SESSION_FIELDS.pendingKind 只透传 kind、未定义枚举；status.js/stage-root.js/probe.js 各自比较字面量。待收口：adapter 增加 PENDING_KINDS。',
    debt: true,
  },
  {
    file: '*',
    token: '*',
    category: 'internal-flag',
    reason: 'URL hash 诊断开关（#onestep=no-locale,no-shortcuts,…）的旗标名，与槽名/服务名同名属插件内部命名；不构成 DSH 契约使用。',
    debt: false,
  },
  {
    file: 'src/client/index.js',
    token: 'dsh.sessions.current',
    category: 'storage-key',
    reason: '官方 localStorage 主会话键，仅用于无桥时的只读回退（currentMainSessionId），不写。adapter 未收录。待收口：补 STORAGE_KEYS.currentSession。',
    debt: true,
  },
  {
    file: 'src/client/index.js',
    token: '*',
    category: 'shortcut',
    reason: '官方 shortcuts 服务契约值（primary/alt/shift、web:windows/desktop:windows profile、page region、KeyS/KeyN/KeyW/KeyZ/DigitN）。P0 审计要求「在 adapter 落地官方保留快捷键列表」，当前仍在 index.js 硬编码。已按 compat-matrix §官方保留快捷键核对无重叠；待收口：adapter 增加 SHORTCUTS + RESERVED 表。',
    debt: true,
  },
  {
    file: 'src/client/probe.js',
    token: 'dsh-onestep',
    category: 'plugin-id',
    reason: '自身包 id（与 __DSH_BOOT__.entries 比对）；不是 DSH 契约，登记以纳入审计视野。',
    debt: false,
  },
  {
    file: 'src/client/index.js',
    token: 'onestepStage',
    category: 'retain-source',
    reason: '自声明的 SessionReference.source（插件私有 source，官方无枚举校验）；非 DSH 契约。',
    debt: false,
  },
]

const CATEGORY_LABEL = {
  'slot': '插槽名',
  'service': '服务名',
  'factory': 'Factory 名/variant',
  'dom': '官方 DOM/拖拽弱契约',
  'storage-key': '官方 storage 键',
  'resource-scheme': '资源 scheme',
  'status-enum': '状态枚举值',
  'sidebar-tab-kind': '官方 tab kind',
  'shortcut': '快捷键服务契约值',
  'boot-global': '官方 boot 全局',
  'dom-slot-marker': '官方 DOM 槽标记',
  'plugin-id': '自身包 id',
  'retain-source': '自身 retain source',
}

function findExemption(relFile, token, category) {
  for (const rule of EXEMPTIONS) {
    if (rule.category && rule.category !== category) continue
    if (rule.file && rule.file !== '*' && relFile !== rule.file && !relFile.endsWith('/' + rule.file.replace(/^src\//, ''))) continue
    if (rule.token !== '*' && rule.token !== token) continue
    return rule
  }
  return null
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

function sha256File(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase()
  } catch (_error) {
    return null
  }
}

/** 额外扫描：官方 DOM 槽标记（CSS 模板字符串内，例如 data-slot="conversation.composer.bar"）。 */
function findDomSlotMarkers(code) {
  const out = []
  const re = /data-(slot|chain-overlay-fallback)\\?\s*=\\?\s*["']([^"']+)["']/g
  let m
  while ((m = re.exec(code)) !== null) {
    const line = code.slice(0, m.index).split('\n').length
    out.push({ value: m[2], kind: m[1], line, context: 'data-' + m[1] + '="' + m[2] + '"' })
  }
  return out
}

/** 额外扫描：官方 boot 全局标识符。 */
function findBootGlobals(code) {
  const out = []
  const re = /\b__DSH_BOOT__\b/g
  let m
  while ((m = re.exec(code)) !== null) {
    const line = code.slice(0, m.index).split('\n').length
    out.push({ value: '__DSH_BOOT__', line, context: '__DSH_BOOT__' })
  }
  return out
}

export function scan() {
  const files = walk(CLIENT_DIR).sort()
  const adapterSrc = fs.readFileSync(ADAPTER_ABS, 'utf8')
  const whitelist = readAdapterWhitelist(adapterSrc)
  const adapterTokenSet = new Set([
    ...whitelist.slots, ...whitelist.services, ...whitelist.inject, ...whitelist.factory,
    ...whitelist.storage, ...whitelist.probe,
  ])

  const found = []
  const centralized = []
  const exemptions = []
  const violations = []
  const filesScanned = []

  for (const abs of files) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/')
    filesScanned.push(rel)
    const raw = fs.readFileSync(abs, 'utf8')
    const code = stripComments(raw)
    const isAdapter = rel === ADAPTER_REL

    const hits = []
    // styles.js 整体是 CSS 模板字符串：只走 DOM 槽标记专项扫描，避免把 CSS 内部引号误当 JS 字面量
    if (rel !== 'src/client/styles.js') {
      for (const literal of extractLiterals(code)) {
        const cls = classifyLiteral(rel, literal)
        if (!cls) continue
        hits.push({ ...literal, category: cls.category })
      }
    }
    if (rel === 'src/client/styles.js' || rel === 'src/client/index.js') {
      for (const marker of findDomSlotMarkers(code)) hits.push({ ...marker, category: 'dom-slot-marker' })
    }
    if (rel === 'src/client/probe.js') {
      for (const boot of findBootGlobals(code)) hits.push({ ...boot, category: 'boot-global' })
    }
    for (const hit of hits) {
      const record = {
        file: rel,
        line: hit.line,
        token: hit.value,
        category: hit.category,
        centralized: isAdapter,
        inAdapterWhitelist: adapterTokenSet.has(hit.value),
        context: hit.context.slice(0, 200),
      }
      if (isAdapter) { centralized.push(record); continue }
      const exemption = findExemption(rel, hit.value, hit.category)
      if (exemption) {
        exemptions.push({ ...record, reason: exemption.reason, debt: !!exemption.debt })
      } else {
        violations.push(record)
      }
      found.push(record)
    }
  }

  // adapter 覆盖率/使用情况（信息项，不影响门禁）
  const codeByFile = new Map()
  for (const abs of files) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/')
    codeByFile.set(rel, stripComments(fs.readFileSync(abs, 'utf8')))
    }
  const usage = (constant, key) => {
    let count = 0
    for (const [rel, text] of codeByFile) {
      if (rel === ADAPTER_REL) continue
      const re = new RegExp('\\b' + constant + '\\.' + key + '\\b', 'g')
      count += (text.match(re) || []).length
    }
    return count
  }
  const adapterKeys = readAdapterKeys(adapterSrc)
  const constantsUsage = {}
  for (const [constName, keys] of Object.entries(adapterKeys)) {
    constantsUsage[constName] = Object.fromEntries(keys.map((key) => [key, usage(constName, key)]))
  }

  return { filesScanned, whitelist, found, centralized, exemptions, violations, constantsUsage, sourceHashes: { adapter: sha256File(ADAPTER_ABS), files: Object.fromEntries(filesScanned.map((rel) => [rel, sha256File(path.join(ROOT, rel))])) } }
}

/** 从 adapter.js 读取每个导出的对象常量的键（用于使用率统计）。 */
function readAdapterKeys(adapterSrc) {
  const out = {}
  for (const name of ['SLOTS', 'SERVICES', 'CONTENT_FACTORY']) {
    const block = blockAfter(adapterSrc, 'export const ' + name)
    const keys = [...block.matchAll(/^\s*([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1])
    out[name] = keys
  }
  return out
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main() {
  let cfg
  try {
    cfg = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write('[inventory] ' + String(error && error.message ? error.message : error) + '\n')
    process.exitCode = 2
    return
  }
  if (cfg.help) {
    process.stdout.write('用法: node scripts/p2/compat/inventory.mjs [--json <path>] [--strict] [--quiet] [--all]\n')
    return
  }

  const result = scan()
  const { filesScanned, whitelist, found, centralized, exemptions, violations, constantsUsage, sourceHashes } = result
  const debtExemptions = exemptions.filter((item) => item.debt)
  const ok = violations.length === 0 && (!cfg.strict || exemptions.length === 0)

  const report = {
    ok,
    scanner: {
      name: 'dsh-onestep-contract-inventory',
      version: SCANNER_VERSION,
      generatedAt: new Date().toISOString(),
      baselineDsh: BASELINE_DSH,
      root: ROOT,
      directory: 'src/client',
      adapter: ADAPTER_REL,
      policy: '外部契约名只允许出现在 adapter.js；其它模块引用 adapter 常量。违规见 violations；已登记豁免见 exemptions。',
    },
    adapterWhitelist: whitelist,
    adapterUsage: constantsUsage,
    sourceHashes,
    summary: {
      filesScanned: filesScanned.length,
      contractOccurrences: found.length + centralized.length,
      centralized: centralized.length,
      foundOutsideAdapter: found.length,
      exemptions: exemptions.length,
      debtExemptions: debtExemptions.length,
      violations: violations.length,
      strictMode: cfg.strict,
    },
    files: filesScanned,
    found,
    centralized,
    exemptions,
    violations,
  }

  fs.mkdirSync(path.dirname(cfg.json), { recursive: true })
  fs.writeFileSync(cfg.json, JSON.stringify(report, null, 2) + '\n', 'utf8')

  if (!cfg.quiet) {
    const lines = []
    lines.push('[inventory] baseline DSH ' + BASELINE_DSH + ' | adapter ' + ADAPTER_REL)
    lines.push('[inventory] files=' + filesScanned.length + ' contractOccurrences=' + (found.length + centralized.length) +
      ' centralized(in adapter)=' + centralized.length + ' outsideAdapter=' + found.length)
    lines.push('[inventory] exemptions=' + exemptions.length + '（其中待收口债务 ' + debtExemptions.length + '） violations=' + violations.length)
    const byCategory = {}
    for (const item of [...found, ...centralized]) byCategory[item.category] = (byCategory[item.category] || 0) + 1
    lines.push('[inventory] byCategory ' + JSON.stringify(byCategory))
    if (violations.length > 0) {
      lines.push('[inventory] VIOLATIONS:')
      for (const v of violations.slice(0, cfg.listAll ? violations.length : 30)) {
        lines.push('  - ' + v.file + ':' + v.line + ' ' + JSON.stringify(v.token) + ' [' + (CATEGORY_LABEL[v.category] || v.category) + ']')
      }
      if (!cfg.listAll && violations.length > 30) lines.push('  … 其余 ' + (violations.length - 30) + ' 条见 JSON')
    }
    if (cfg.listAll) {
      lines.push('[inventory] EXEMPTIONS:')
      for (const e of exemptions) lines.push('  - ' + e.file + ':' + e.line + ' ' + JSON.stringify(e.token) + (e.debt ? ' [debt]' : ''))
    }
    lines.push('[inventory] ' + (ok ? 'OK' : 'FAIL') + (cfg.strict ? ' (strict)' : '') + ' → ' + path.relative(ROOT, cfg.json))
    process.stdout.write(lines.join('\n') + '\n')
  }

  process.exitCode = ok ? 0 : 1
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isEntry) main()
