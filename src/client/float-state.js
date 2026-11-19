/**
 * P3 伴生窗插件的自有状态（P3-3）：形态（float/split）、managed 浮窗元数据、peek 集合。
 *
 * 权威划分（docs/p3-plan.md §5.2）：
 * - **官方是权威**：浮窗矩形、tab 记录、右栏展开态、布局都归官方持久化（`dsh.sidebar-right.v1.<sid>`）；
 * - 插件只存「形态 + 槽位映射 + peek + managed 元数据」，键 `dsh.onestep.companion.v1`；
 * - peek 默认不持久化（Q11）：刷新后全部浮窗可见，形态保留。
 *
 * 全部是纯函数（load/save 只接受 storage 接口），坏 JSON/版本不符/字段漂移一律回默认，不抛错。
 */
import { COMPANION } from './adapter.js'

export const COMPANION_STATE_VERSION = COMPANION.stateVersion
export const COMPANION_STORAGE_KEY = COMPANION.storageKey
export const MODES = Object.freeze(['float', 'split'])
export const DEFAULT_MODE = 'float'

const MAX_TRACKED = COMPANION.defaults.maxTracked

/**
 * 空状态。
 * @param {number} [now]
 * @returns {{version:number, updatedAt:number, bySession:Record<string,{mode:string,floats:Array<object>}>}}
 */
export function createCompanionState(now = Date.now()) {
  return { version: COMPANION_STATE_VERSION, updatedAt: now, bySession: {} }
}

/**
 * 清洗全局 UI 偏好（目前只有标签层纵向位置 `peekTop`；null = 自动安全位置）。
 * @param {unknown} input
 * @returns {{peekTop: number|null}}
 */
export function sanitizeUi(input) {
  const source = isRecord(input) ? input : {}
  const rawValue = source.peekTop
  const raw = rawValue === null || rawValue === undefined || rawValue === '' ? Number.NaN : Number(rawValue)
  const peekTop = Number.isFinite(raw) && raw >= 0 ? Math.min(Math.round(raw), 10000) : null
  return { peekTop }
}

/**
 * @param {unknown} mode
 * @returns {'float'|'split'}
 */
export function normalizeMode(mode) {
  return mode === 'split' ? 'split' : DEFAULT_MODE
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 清洗单条 managed 浮窗记录；非法返回 null。
 * `docked=true` 表示该 tab 已从浮窗收回官方右栏（split 形态），记录保留以便「转回浮窗」。
 * @param {unknown} input
 * @returns {{tabId:string, paneId:string|null, kind:string, title:string, slot:number|null, peeked:boolean, docked:boolean, lastFocusedAt:number}|null}
 */
export function sanitizeFloat(input) {
  if (!isRecord(input)) return null
  const tabId = typeof input.tabId === 'string' ? input.tabId.trim() : ''
  if (!tabId) return null
  const slot = Number.isInteger(input.slot) && input.slot >= 0 && input.slot < 16 ? input.slot : null
  return {
    tabId,
    paneId: typeof input.paneId === 'string' && input.paneId ? input.paneId : null,
    kind: typeof input.kind === 'string' && input.kind ? input.kind : '',
    title: typeof input.title === 'string' ? input.title.slice(0, 120) : '',
    slot,
    peeked: input.peeked === true,
    docked: input.docked === true,
    lastFocusedAt: Number.isFinite(Number(input.lastFocusedAt)) ? Number(input.lastFocusedAt) : 0,
  }
}

/**
 * 清洗单会话状态；浮窗按 tabId 去重（保留最后一条）并限制条数。
 * @param {unknown} input
 * @returns {{mode:'float'|'split', floats:Array<object>}}
 */
export function sanitizeSessionState(input) {
  const source = isRecord(input) ? input : {}
  const mode = normalizeMode(source.mode)
  const byTab = new Map()
  for (const item of Array.isArray(source.floats) ? source.floats : []) {
    const record = sanitizeFloat(item)
    if (record) byTab.set(record.tabId, record)
  }
  const floats = Array.from(byTab.values()).slice(0, MAX_TRACKED)
  return { mode, floats }
}

/**
 * 解析任意来源的状态（对象或 JSON 字符串）。
 * @param {unknown} raw
 * @param {number} [now]
 * @returns {{state:object, ok:boolean, reason?:string}}
 */
export function parseCompanionState(raw, now = Date.now()) {
  if (raw === null || raw === undefined || raw === '') return { state: createCompanionState(now), ok: false, reason: 'empty' }
  let source = raw
  if (typeof raw === 'string') {
    try {
      source = JSON.parse(raw)
    } catch (_error) {
      return { state: createCompanionState(now), ok: false, reason: 'bad-json' }
    }
  }
  if (!isRecord(source)) return { state: createCompanionState(now), ok: false, reason: 'not-object' }
  if (Number(source.version) !== COMPANION_STATE_VERSION) {
    return { state: createCompanionState(now), ok: false, reason: 'version-mismatch' }
  }
  const bySession = {}
  const sessions = isRecord(source.bySession) ? source.bySession : {}
  for (const sessionId of Object.keys(sessions)) {
    if (!sessionId) continue
    bySession[sessionId] = sanitizeSessionState(sessions[sessionId])
  }
  return {
    state: {
      version: COMPANION_STATE_VERSION,
      updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : now,
      bySession,
      ui: sanitizeUi(source.ui),
    },
    ok: true,
  }
}

/**
 * 从 storage 读状态；任何异常/坏数据回默认。
 * @param {{getItem?:Function}|null|undefined} storage
 * @param {number} [now]
 * @returns {{state:object, ok:boolean, reason?:string}}
 */
export function loadCompanionState(storage, now = Date.now()) {
  try {
    if (!storage || typeof storage.getItem !== 'function') return { state: createCompanionState(now), ok: false, reason: 'no-storage' }
    const raw = storage.getItem(COMPANION_STORAGE_KEY)
    return parseCompanionState(raw, now)
  } catch (_error) {
    return { state: createCompanionState(now), ok: false, reason: 'storage-error' }
  }
}

/**
 * 写状态（自动更新 updatedAt）；失败不抛（存储满/不可用时返回 ok:false）。
 * @param {{setItem?:Function}|null|undefined} storage
 * @param {object} state
 * @param {number} [now]
 * @returns {{ok:boolean, reason?:string, saved?:object}}
 */
export function saveCompanionState(storage, state, now = Date.now()) {
  const saved = { ...sanitizeStateShape(state), updatedAt: now }
  try {
    if (!storage || typeof storage.setItem !== 'function') return { ok: false, reason: 'no-storage', saved }
    storage.setItem(COMPANION_STORAGE_KEY, JSON.stringify(saved))
    return { ok: true, saved }
  } catch (_error) {
    return { ok: false, reason: 'storage-error', saved }
  }
}

function sanitizeStateShape(state) {
  const source = isRecord(state) ? state : createCompanionState()
  const bySession = {}
  const sessions = isRecord(source.bySession) ? source.bySession : {}
  for (const sessionId of Object.keys(sessions)) {
    if (!sessionId) continue
    bySession[sessionId] = sanitizeSessionState(sessions[sessionId])
  }
  return { version: COMPANION_STATE_VERSION, bySession, ui: sanitizeUi(source.ui) }
}

/**
 * 标签层纵向位置（UI 偏好，全局）。
 * @param {object} state
 * @returns {number|null} null = 自动安全位置
 */
export function peekTopOf(state) {
  return isRecord(state) ? sanitizeUi(state.ui).peekTop : null
}

/**
 * 设置标签层纵向位置（null 恢复自动安全位置）。
 * @param {object} state
 * @param {number|null} top
 * @param {number} [now]
 */
export function setPeekTop(state, top, now = Date.now()) {
  const base = isRecord(state) ? state : createCompanionState(now)
  const nextTop = top === null || top === undefined || top === '' ? null : sanitizeUi({ peekTop: top }).peekTop
  return { ...base, ui: { ...sanitizeUi(base.ui), peekTop: nextTop }, updatedAt: now }
}

/**
 * 读单会话状态。
 * @param {object} state
 * @param {string|null|undefined} sessionId
 * @returns {{mode:'float'|'split', floats:Array<object>}}
 */
export function sessionStateOf(state, sessionId) {
  if (!sessionId) return { mode: DEFAULT_MODE, floats: [] }
  const sessions = isRecord(state && state.bySession) ? state.bySession : {}
  return sanitizeSessionState(sessions[sessionId])
}

/**
 * 会话形态。
 * @param {object} state
 * @param {string|null|undefined} sessionId
 * @returns {'float'|'split'}
 */
export function modeOf(state, sessionId) {
  return sessionStateOf(state, sessionId).mode
}

/** 以新 bySession 生成状态（保持其余字段）。 */
function withSession(state, sessionId, nextSession, now) {
  const base = isRecord(state) ? state : createCompanionState(now)
  const bySession = { ...(isRecord(base.bySession) ? base.bySession : {}) }
  bySession[sessionId] = sanitizeSessionState(nextSession)
  return { ...base, bySession, updatedAt: now }
}

/**
 * 设置形态。
 * @param {object} state
 * @param {string} sessionId
 * @param {'float'|'split'} mode
 * @param {number} [now]
 */
export function setMode(state, sessionId, mode, now = Date.now()) {
  if (!sessionId) return state
  const current = sessionStateOf(state, sessionId)
  return withSession(state, sessionId, { ...current, mode: normalizeMode(mode) }, now)
}

/**
 * 新增/更新 managed 浮窗记录（同 tabId 覆盖元数据，保留首次 lastFocusedAt 之外的显式值）。
 * @param {object} state
 * @param {string} sessionId
 * @param {object} record
 * @param {number} [now]
 */
export function upsertFloat(state, sessionId, record, now = Date.now()) {
  const sanitized = sanitizeFloat(record)
  if (!sessionId || !sanitized) return state
  const current = sessionStateOf(state, sessionId)
  const index = current.floats.findIndex((item) => item.tabId === sanitized.tabId)
  let floats
  if (index >= 0) {
    floats = current.floats.slice()
    floats[index] = { ...floats[index], ...sanitized }
  } else {
    floats = current.floats.concat([sanitized]).slice(-MAX_TRACKED)
  }
  return withSession(state, sessionId, { ...current, floats }, now)
}

/**
 * 批量更新某会话的浮窗记录（对账结果整体写回）。
 * @param {object} state
 * @param {string} sessionId
 * @param {Array<object>} floats
 * @param {number} [now]
 */
export function updateFloats(state, sessionId, floats, now = Date.now()) {
  if (!sessionId) return state
  const current = sessionStateOf(state, sessionId)
  return withSession(state, sessionId, { ...current, floats: Array.isArray(floats) ? floats : [] }, now)
}

/**
 * 移除某会话的浮窗记录（tab 已关闭/收回）。
 * @param {object} state
 * @param {string} sessionId
 * @param {string} tabId
 * @param {number} [now]
 */
export function removeFloat(state, sessionId, tabId, now = Date.now()) {
  if (!sessionId || !tabId) return state
  const current = sessionStateOf(state, sessionId)
  const floats = current.floats.filter((item) => item.tabId !== tabId)
  if (floats.length === current.floats.length) return state
  return withSession(state, sessionId, { ...current, floats }, now)
}

/**
 * 设置 peek 状态。
 * @param {object} state
 * @param {string} sessionId
 * @param {string} tabId
 * @param {boolean} peeked
 * @param {number} [now]
 */
export function markPeeked(state, sessionId, tabId, peeked, now = Date.now()) {
  if (!sessionId || !tabId) return state
  const current = sessionStateOf(state, sessionId)
  const index = current.floats.findIndex((item) => item.tabId === tabId)
  if (index < 0) return state
  const floats = current.floats.slice()
  floats[index] = { ...floats[index], peeked: !!peeked }
  return withSession(state, sessionId, { ...current, floats }, now)
}

/**
 * 全部收起/展开（点浮窗外 → 全部 peek；切会话/刷新 → 全部恢复）。
 * @param {object} state
 * @param {string} sessionId
 * @param {boolean} peeked
 * @param {number} [now]
 */
export function markAllPeeked(state, sessionId, peeked, now = Date.now()) {
  if (!sessionId) return state
  const current = sessionStateOf(state, sessionId)
  if (current.floats.length === 0) return state
  const floats = current.floats.map((item) => ({ ...item, peeked: !!peeked }))
  return withSession(state, sessionId, { ...current, floats }, now)
}

/**
 * 聚焦抬升：更新 lastFocusedAt（满槽淘汰按它选最久未聚焦）。
 * @param {object} state
 * @param {string} sessionId
 * @param {string} tabId
 * @param {number} [now]
 */
export function touchFloat(state, sessionId, tabId, now = Date.now()) {
  if (!sessionId || !tabId) return state
  const current = sessionStateOf(state, sessionId)
  const index = current.floats.findIndex((item) => item.tabId === tabId)
  if (index < 0) return state
  const floats = current.floats.slice()
  floats[index] = { ...floats[index], lastFocusedAt: now, peeked: false }
  return withSession(state, sessionId, { ...current, floats }, now)
}

/**
 * 满槽淘汰（Q13）：选最久未聚焦的未收起浮窗，标记为 peek 并返回。
 * @param {object} state
 * @param {string} sessionId
 * @param {(floats:Array<object>)=>object|null} selector 默认 `selectEvictionCandidate`（调用方注入以免循环依赖）
 * @param {number} [now]
 * @returns {{state:object, evicted:object|null}}
 */
export function evictOldest(state, sessionId, selector, now = Date.now()) {
  const current = sessionStateOf(state, sessionId)
  const picker = typeof selector === 'function' ? selector : defaultEvictionSelector
  const evicted = picker(current.floats)
  if (!evicted) return { state, evicted: null }
  return { state: markPeeked(state, sessionId, evicted.tabId, true, now), evicted }
}

function defaultEvictionSelector(floats) {
  const list = (Array.isArray(floats) ? floats : []).filter((item) => item && !item.peeked)
  if (list.length === 0) return null
  let candidate = list[0]
  for (const item of list) {
    if ((Number(item.lastFocusedAt) || 0) < (Number(candidate.lastFocusedAt) || 0)) candidate = item
  }
  return candidate
}

/**
 * 设置「已收回右栏（docked）」标记（split 形态下保留记录，供「转回浮窗」）。
 * @param {object} state
 * @param {string} sessionId
 * @param {string} tabId
 * @param {boolean} docked
 * @param {number} [now]
 */
export function setDocked(state, sessionId, tabId, docked, now = Date.now()) {
  if (!sessionId || !tabId) return state
  const current = sessionStateOf(state, sessionId)
  const index = current.floats.findIndex((item) => item.tabId === tabId)
  if (index < 0) return state
  const floats = current.floats.slice()
  floats[index] = { ...floats[index], docked: !!docked, peeked: docked ? false : floats[index].peeked }
  return withSession(state, sessionId, { ...current, floats }, now)
}

/**
 * 批量设置 docked（切 split 时把可见浮窗全部收回右栏）。
 * @param {object} state
 * @param {string} sessionId
 * @param {boolean} docked
 * @param {number} [now]
 */
export function markAllDocked(state, sessionId, docked, now = Date.now()) {
  if (!sessionId) return state
  const current = sessionStateOf(state, sessionId)
  if (current.floats.length === 0) return state
  const floats = current.floats.map((item) => ({ ...item, docked: !!docked, ...(docked ? { peeked: false } : {}) }))
  return withSession(state, sessionId, { ...current, floats }, now)
}

/**
 * 统计：某会话 managed 浮窗数 / 收起数 / 收回右栏数。
 * @param {object} state
 * @param {string} sessionId
 * @returns {{total:number, peeked:number, visible:number, docked:number}}
 */
export function countFloats(state, sessionId) {
  const floats = sessionStateOf(state, sessionId).floats
  const peeked = floats.filter((item) => item.peeked).length
  const docked = floats.filter((item) => item.docked).length
  const visible = floats.filter((item) => !item.peeked && !item.docked).length
  return { total: floats.length, peeked, visible, docked }
}
