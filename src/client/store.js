/**
 * StageStore：舞台状态（纯数据 + 纯函数 + 极简快照 store）。
 *
 * 状态分层（开发文档 §4.1）：
 * - StageState 持久化：candidates（候场 roster）/ railSide / railSize / railCollapsed / previewMode / autoLite / persistStage；
 * - 焦点不存本 store：焦点永远派生自 DSH 主绑定（apply 层与桥注入）；
 * - 瞬时反馈（闪烁/气泡/撤销）在 apply 层的 ephemeral 模块，不在这里。
 *
 * 本模块不依赖 React/DOM；observable 包装是给 React 的 useSyncExternalStore 用的稳定快照。
 */
import { LIMITS, STATE_VERSION, STORAGE_KEY } from './adapter.js'

/** 默认持久状态。候场卡默认「实时缩略画面」（live，官方聊天体等比缩放 + 隐藏输入区）；可切精简卡。 */
export function defaultStageState() {
  return {
    version: STATE_VERSION,
    candidates: [],
    railSide: 'left',
    railSize: LIMITS.railLeft.default,
    railCollapsed: false,
    previewMode: 'live',
    autoLite: true,
    persistStage: true,
    reducedMotion: 'system',
  }
}

/**
 * 规范化状态（持久化读取/外部输入都先过这里）。
 * @param {unknown} raw 任意候选状态
 * @returns {ReturnType<typeof defaultStageState>} 规范化状态
 */
export function normalizeState(raw) {
  const base = defaultStageState()
  if (!raw || typeof raw !== 'object') return base
  if (raw.version !== STATE_VERSION) return base
  const railSide = raw.railSide === 'top' ? 'top' : 'left'
  const bounds = railSide === 'left' ? LIMITS.railLeft : LIMITS.railTop
  const railSize = Math.min(bounds.max, Math.max(bounds.min, Number(raw.railSize) || bounds.default))
  const candidates = []
  const seen = new Set()
  if (Array.isArray(raw.candidates)) {
    for (const item of raw.candidates) {
      const sessionId = typeof item === 'string' ? item : item && item.sessionId
      if (typeof sessionId !== 'string' || !sessionId || seen.has(sessionId)) continue
      if (candidates.length >= LIMITS.maxCandidates) break
      seen.add(sessionId)
      candidates.push({
        sessionId,
        addedAt: item && typeof item.addedAt === 'number' ? item.addedAt : Date.now(),
        lastFocusedAt: item && typeof item.lastFocusedAt === 'number' ? item.lastFocusedAt : Date.now(),
      })
    }
  }
  return {
    version: STATE_VERSION,
    candidates,
    railSide,
    railSize,
    railCollapsed: !!raw.railCollapsed,
    previewMode: raw.previewMode === 'card' ? 'card' : 'live',
    autoLite: raw.autoLite !== false,
    persistStage: raw.persistStage !== false,
    reducedMotion: raw.reducedMotion === 'always' || raw.reducedMotion === 'never' ? raw.reducedMotion : 'system',
  }
}

/** 是否处于舞台模式（候场非空即舞台）。 */
export function isStageActive(state) {
  return !!(state && Array.isArray(state.candidates) && state.candidates.length > 0)
}

/** 候场窗口列表（顺序即渲染顺序）。 */
export function candidateIds(state) {
  return state && Array.isArray(state.candidates) ? state.candidates.map((c) => c.sessionId) : []
}

/**
 * 加入候场；满 3 淘汰最久未用；若已在候场则更新 lastFocusedAt。
 * @returns {{state:object, added:boolean, evicted:string|null, existed:boolean}}
 */
export function addCandidate(state, sessionId, now = Date.now()) {
  if (typeof sessionId !== 'string' || !sessionId) return { state, added: false, evicted: null, existed: false }
  const list = Array.isArray(state.candidates) ? state.candidates.slice() : []
  const found = list.find((c) => c.sessionId === sessionId)
  if (found) {
    const next = list.map((c) => (c.sessionId === sessionId ? { ...c, lastFocusedAt: now } : c))
    return { state: { ...state, candidates: next }, added: false, evicted: null, existed: true }
  }
  let evicted = null
  if (list.length >= LIMITS.maxCandidates) {
    let oldest = 0
    for (let i = 1; i < list.length; i += 1) {
      if ((list[i].lastFocusedAt || 0) < (list[oldest].lastFocusedAt || 0)) oldest = i
    }
    evicted = list[oldest].sessionId
    list.splice(oldest, 1)
  }
  // 产品报告 §7.1：候场顺序即候场栏顺序，新加入者在上（插到头部）。
  list.unshift({ sessionId, addedAt: now, lastFocusedAt: now })
  return { state: { ...state, candidates: list }, added: true, evicted, existed: false }
}

/** 移出候场（不移出即无副作用）。 */
export function removeCandidate(state, sessionId) {
  const list = Array.isArray(state.candidates) ? state.candidates.filter((c) => c.sessionId !== sessionId) : []
  if (list.length === (state.candidates || []).length) return { state, removed: false }
  return { state: { ...state, candidates: list }, removed: true }
}

/**
 * 目录 reconcile：清理不存在/非法的候场；主绑定变化时把旧焦点插入候场头部、把新焦点移出候场。
 * @param {object} state 当前状态
 * @param {{byId?:Record<string,object>, mainId?:string|null, prevMainId?:string|null, now?:number}} input 目录/主绑定
 * @returns {{state:object, changed:boolean, dropped:string[], addedPrevFocus:boolean}}
 */
export function reconcile(state, input) {
  const byId = (input && input.byId) || {}
  const mainId = (input && input.mainId) || null
  const prevMainId = (input && input.prevMainId) || null
  const now = (input && input.now) || Date.now()
  const dropped = []
  let list = (state.candidates || []).filter((c) => {
    const exists = !!byId[c.sessionId]
    const isMain = mainId !== null && c.sessionId === mainId
    if (!exists || isMain) {
      dropped.push(c.sessionId)
      return false
    }
    return true
  })
  let addedPrevFocus = false
  // 主绑定切换：旧焦点自动降为候场头部（且不与被移除/新主重复）
  if (prevMainId && mainId && prevMainId !== mainId && byId[prevMainId]) {
    const already = list.some((c) => c.sessionId === prevMainId)
    if (!already) {
      list = [{ sessionId: prevMainId, addedAt: now, lastFocusedAt: now }, ...list]
      addedPrevFocus = true
      if (list.length > LIMITS.maxCandidates) list = list.slice(0, LIMITS.maxCandidates)
    }
  }
  const changed = dropped.length > 0 || addedPrevFocus
  if (!changed) return { state, changed: false, dropped, addedPrevFocus }
  return { state: { ...state, candidates: list }, changed: true, dropped, addedPrevFocus }
}

/** 设置候场栏排列方向（切换方向时 railSize 归位到该方向默认值）。 */
export function setRailSide(state, side) {
  const railSide = side === 'top' ? 'top' : 'left'
  if (railSide === state.railSide) return state
  const bounds = railSide === 'left' ? LIMITS.railLeft : LIMITS.railTop
  return { ...state, railSide, railSize: bounds.default }
}

/** 设置候场栏尺寸（px，自动夹到范围内）。 */
export function setRailSize(state, px) {
  const bounds = state.railSide === 'top' ? LIMITS.railTop : LIMITS.railLeft
  const railSize = Math.min(bounds.max, Math.max(bounds.min, Math.round(Number(px) || bounds.default)))
  if (railSize === state.railSize) return state
  return { ...state, railSize }
}

/** 收起/展开候场栏。 */
export function setRailCollapsed(state, collapsed) {
  const next = !!collapsed
  if (next === state.railCollapsed) return state
  return { ...state, railCollapsed: next }
}

/** 候场窗渲染档位：live（官方聊天体缩略）/ card（lite 状态卡）。 */
export function setPreviewMode(state, mode) {
  const previewMode = mode === 'card' ? 'card' : 'live'
  if (previewMode === state.previewMode) return state
  return { ...state, previewMode }
}

/** 自动降级开关。 */
export function setAutoLite(state, enabled) {
  const autoLite = enabled !== false
  if (autoLite === state.autoLite) return state
  return { ...state, autoLite }
}

/* ------------------------------------------------------------------ *
 * 自动 lite 降级判定（产品报告 §11.3 降级阶梯；纯函数，单测覆盖边界）
 * ------------------------------------------------------------------ */

/**
 * 自动降级阈值（可配置；默认值与产品报告 §11.1/§11.3 对齐）。
 *
 * 触发前提：窗口数 ≥ windows（1 焦点 + 3 候场 = 4 窗）。
 * - firstFrameMs：舞台进入（stage-enter-start → stage-enter-ready）超过 §11.1 的 4 窗进入预算 900ms；
 * - longTaskTotalMs：进入窗口内 longtask 累计占用超过 4 窗进入预算的一半（主线程被持续阻塞，
 *   帧预算 16ms 属理想值，无法直接当降级阈值，故取进入预算的一半作为「明显卡顿」判定）；
 * - memoryDeltaMB：进入后堆增量超过 §11.1 的空闲内存增量预算 200MB → §11.3 的「极简」档；
 *   极简档（连续 2s 帧率 <30fps / 内存超预算收成状态条）属 v1.1，v1 未接线，
 *   由调用方回退到精简候场（lite）并在 reason 保留原始信号；
 * - minFps/lowFpsWindowMs：§11.3「连续 2s 帧率 <30fps」极简档信号（v1.1 未接线，仅判定）。
 */
export const AUTO_LITE_LIMITS = Object.freeze({
  windows: 4,
  firstFrameMs: 900,
  longTaskTotalMs: 400,
  memoryDeltaMB: 200,
  minFps: 30,
  lowFpsWindowMs: 2000,
  /** 极简档开关（v1.1 才实现；false 时 memory/low-fps 信号回退到 lite）。 */
  minimalEnabled: false,
})

/** 数字输入归一化：非有限数视为「未采样」。 */
function finiteOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/**
 * 自动降级判定（纯函数）。
 * @param {object} [input] 采样输入
 * @param {number} [input.windows] 舞台窗口数（1 焦点 + 候场数）
 * @param {number|null} [input.firstFrameMs] 舞台进入首帧耗时（performance.measure stage-enter）
 * @param {number|null} [input.longTaskTotalMs] 进入窗口内 longtask 累计耗时
 * @param {number|null} [input.memoryDeltaMB] 进入后 JS 堆增量（MB）
 * @param {boolean} [input.sustainedLowFps] 是否连续 2s 帧率 < minFps（v1.1 信号）
 * @param {boolean} [input.enabled] 自动降级开关（store.autoLite，默认 true）
 * @param {boolean} [input.manualOverride] 用户本次舞台会话内是否手动选过档位（优先于自动）
 * @param {object} [config] 阈值覆盖（见 AUTO_LITE_LIMITS）
 * @returns {{
 *   degrade:boolean, target:'none'|'lite'|'minimal', applied:'none'|'lite'|'minimal',
 *   reason:string, fallback:boolean, metrics:object, thresholds:object
 * }}
 */
export function evaluateAutoLite(input = {}, config = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const limits = { ...AUTO_LITE_LIMITS, ...(config && typeof config === 'object' ? config : {}) }
  const metrics = {
    windows: Math.max(0, Math.floor(finiteOrNull(source.windows) || 0)),
    firstFrameMs: finiteOrNull(source.firstFrameMs),
    longTaskTotalMs: finiteOrNull(source.longTaskTotalMs),
    memoryDeltaMB: finiteOrNull(source.memoryDeltaMB),
    sustainedLowFps: source.sustainedLowFps === true,
  }
  const thresholds = { ...limits }
  const result = (degrade, target, applied, reason, fallback) => ({
    degrade: !!degrade,
    target,
    applied: degrade ? applied : 'none',
    reason,
    fallback: !!fallback,
    metrics,
    thresholds,
  })
  if (source.enabled === false) return result(false, 'none', 'none', 'disabled', false)
  if (source.manualOverride === true) return result(false, 'none', 'none', 'manual-override', false)
  if (metrics.windows < limits.windows) return result(false, 'none', 'none', 'below-window-threshold', false)
  // §11.3「极简」信号优先（更严重）；v1.1 未实现极简档时回退到精简候场（lite）。
  if (metrics.memoryDeltaMB !== null && metrics.memoryDeltaMB > limits.memoryDeltaMB) {
    return result(true, 'minimal', limits.minimalEnabled ? 'minimal' : 'lite', 'memory', !limits.minimalEnabled)
  }
  if (metrics.sustainedLowFps) {
    return result(true, 'minimal', limits.minimalEnabled ? 'minimal' : 'lite', 'sustained-low-fps', !limits.minimalEnabled)
  }
  if (metrics.firstFrameMs !== null && metrics.firstFrameMs > limits.firstFrameMs) {
    return result(true, 'lite', 'lite', 'first-frame', false)
  }
  if (metrics.longTaskTotalMs !== null && metrics.longTaskTotalMs > limits.longTaskTotalMs) {
    return result(true, 'lite', 'lite', 'long-task', false)
  }
  return result(false, 'none', 'none', 'within-budget', false)
}

/**
 * 生效候场档位：自动降级激活时覆盖用户偏好（只影响渲染，不写持久化；
 * 用户保存的 previewMode 下次启动仍作为初值）。纯函数便于单测/探针复用。
 * @param {{previewMode?:string}|null|undefined} state 持久状态
 * @param {boolean} autoLiteActive 自动降级是否激活
 * @returns {'live'|'card'}
 */
export function effectivePreviewMode(state, autoLiteActive) {
  const preferred = state && state.previewMode === 'card' ? 'card' : 'live'
  return autoLiteActive ? 'card' : preferred
}

/**
 * 设置减少动效模式（P4-8）：'system' 跟随系统 / 'always' 减少（覆盖系统）。
 * 'never'（强制完整）v1 不暴露，读取按 system 处理（docs/p4-plan.md Q3）。
 * @param {object} state 当前状态
 * @param {unknown} value 目标值
 * @returns {object} 新状态或原状态
 */
export function setReducedMotion(state, value) {
  const reducedMotion = value === 'always' ? 'always' : 'system'
  if (reducedMotion === state.reducedMotion) return state
  return { ...state, reducedMotion }
}

/** 是否重启恢复舞台。 */
export function setPersistStage(state, enabled) {
  const persistStage = enabled !== false
  if (persistStage === state.persistStage) return state
  return { ...state, persistStage }
}

/** 序列化为持久化负载（只存 roster id 与设置；不存焦点/瞬时态）。 */
export function serializePersisted(state) {
  return {
    version: STATE_VERSION,
    candidates: (state.candidates || []).map((c) => ({ sessionId: c.sessionId, addedAt: c.addedAt, lastFocusedAt: c.lastFocusedAt })),
    railSide: state.railSide,
    railSize: state.railSize,
    railCollapsed: state.railCollapsed,
    previewMode: state.previewMode,
    autoLite: state.autoLite,
    persistStage: state.persistStage,
    reducedMotion: state.reducedMotion,
  }
}

/**
 * 迁移旧版本持久化状态。
 * v1/v2 → v3：保留 roster/布局设置，previewMode 统一迁移为 live（候场卡实时缩略画面）。
 * （v1 的 live 会把官方 composer 铺满卡片；v3 的 live 改为等比缩略 + 隐藏输入区。）
 * @param {unknown} raw 解析后的 localStorage 负载
 * @returns {object|null} 可交给 normalizeState 的负载；不可迁移返回 null
 */
export function migratePersisted(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.version === STATE_VERSION) return raw
  if (raw.version === 1 || raw.version === 2) return { ...raw, version: STATE_VERSION, previewMode: 'live' }
  return null
}

/**
 * 从 storage 读取持久状态；损坏/版本不符时返回 null（调用方回 off）。
 * @param {Storage|null|undefined} storage localStorage-like
 * @param {string} [key] 存储键
 */
export function loadPersisted(storage, key = STORAGE_KEY) {
  if (!storage) return null
  let text
  try {
    text = storage.getItem(key)
  } catch (_error) {
    return null
  }
  if (!text) return null
  try {
    const parsed = JSON.parse(text)
    const migrated = migratePersisted(parsed)
    if (!migrated) return null
    return normalizeState(migrated)
  } catch (_error) {
    return null
  }
}

/** 写入持久状态（调用方负责节流；失败静默）。 */
export function savePersisted(storage, state, key = STORAGE_KEY) {
  if (!storage) return false
  try {
    storage.setItem(key, JSON.stringify(serializePersisted(state)))
    return true
  } catch (_error) {
    return false
  }
}

/**
 * 创建可订阅 store（稳定快照，供 React useSyncExternalStore）。
 * @param {object} options
 * @param {object} [options.initial] 初始状态
 * @param {{getItem:Function,setItem:Function}|null} [options.storage] 持久化后端
 * @param {number} [options.persistDelayMs] 写入节流
 */
export function createStageStore(options = {}) {
  let state = normalizeState(options.initial || loadPersisted(options.storage) || defaultStageState())
  const listeners = new Set()
  let persistTimer = null
  const persistDelayMs = options.persistDelayMs === undefined ? 300 : options.persistDelayMs

  const flushPersist = () => {
    persistTimer = null
    // persistStage=false 表示「重启不恢复舞台」：仍写入设置本身（否则该选择在重启后失效），
    // 但清空候场 roster，避免下次启动按旧快照恢复舞台。
    savePersisted(options.storage, state.persistStage ? state : { ...state, candidates: [] })
  }
  const schedulePersist = () => {
    if (!options.storage) return
    if (persistTimer !== null) return
    persistTimer = setTimeout(flushPersist, persistDelayMs)
  }
  const commit = (next) => {
    if (!next || next === state) return false
    state = next
    for (const listener of Array.from(listeners)) {
      try {
        listener(state)
      } catch (_error) {
        /* 订阅者异常隔离 */
      }
    }
    schedulePersist()
    return true
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** 用纯函数更新：传入当前状态，返回新状态（null/相同引用不提交）。 */
    update: (fn) => commit(fn(state)),
    addCandidate: (sessionId, now) => {
      const result = addCandidate(state, sessionId, now)
      commit(result.state)
      return result
    },
    removeCandidate: (sessionId) => {
      const result = removeCandidate(state, sessionId)
      commit(result.state)
      return result
    },
    reconcile: (input) => {
      const result = reconcile(state, input)
      commit(result.state)
      return result
    },
    setRailSide: (side) => commit(setRailSide(state, side)),
    setRailSize: (px) => commit(setRailSize(state, px)),
    setRailCollapsed: (collapsed) => commit(setRailCollapsed(state, collapsed)),
    setPreviewMode: (mode) => commit(setPreviewMode(state, mode)),
    setReducedMotion: (value) => commit(setReducedMotion(state, value)),
    setAutoLite: (enabled) => commit(setAutoLite(state, enabled)),
    setPersistStage: (enabled) => commit(setPersistStage(state, enabled)),
    flush: () => {
      if (persistTimer !== null) clearTimeout(persistTimer)
      flushPersist()
    },
    dispose: () => {
      if (persistTimer !== null) clearTimeout(persistTimer)
      persistTimer = null
      listeners.clear()
    },
  }
}
