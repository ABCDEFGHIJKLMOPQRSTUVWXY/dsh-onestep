/**
 * 伴生窗（官方右侧栏）适配层（P1-9 / G8）。
 *
 * 设计约束（见 docs/p1-companion.md）：
 * - 官方右侧栏的"当前会话" = 主会话绑定（`ctx.uiSession.adapter.current` → `sidebarRight.mounted`），
 *   舞台焦点窗就是主绑定，所以**跟随焦点由官方天然完成**，插件不伪造 surface；
 * - 只做：能力探测（tab kind）、写操作守卫（候场/非焦点拒绝）、统一错误归一化、跟随审计；
 * - tab 类型/预览器一律复用官方（text/files/browser）；`browser` 是 desktop-only（官方按 profile 名门控）。
 *
 * 本模块的可判定逻辑（evaluate*）不依赖 ctx，便于单测。
 *
 * P3 扩展：`createFloatCompanion` 是伴生浮窗的运行时编排层——读官方服务原语 + 读 DOM 回显
 * （dom 由 index.js 注入，便于单测），计算槽位、分配/满槽淘汰、对账并写回插件状态。
 * 权威划分见 docs/p3-plan.md §5.2（官方持久化浮窗矩形/tab，插件只存形态/槽位/peek/managed）。
 */
import { allocateSlotIndex, computeSlots, normalizeStage, reconcileFloats, selectEvictionCandidate } from './float-layout.js'
import { sessionStateOf, updateFloats } from './float-state.js'

/** 资源地址协议（官方 openResource 只接受该 scheme，见 ui-sidebar-right service.ts:204）。 */
export const RESOURCE_SCHEME = 'dsh-resource://'

/**
 * 纯函数：由官方服务快照计算伴生窗能力与跟随状态。
 * @param {{available:boolean, mounted:string|null, focusId:string|null, tabKinds:string[], expanded:boolean}} input
 * @returns {{available:boolean, mounted:string|null, focusId:string|null, followOk:boolean, expanded:boolean, tabKinds:string[], hasBrowser:boolean}}
 */
export function evaluateCompanion(input) {
  const source = input || {}
  const kinds = Array.isArray(source.tabKinds) ? source.tabKinds.slice() : []
  const mounted = source.mounted || null
  const focusId = source.focusId || null
  return {
    available: !!source.available,
    mounted,
    focusId,
    followOk: !!mounted && !!focusId && mounted === focusId,
    expanded: !!source.expanded,
    tabKinds: kinds,
    hasBrowser: kinds.indexOf('browser') >= 0,
  }
}

/**
 * 纯函数：写操作守卫（焦点/候场/无主绑定）。
 * @param {{focusId:string|null, candidates:string[], sessionId?:string|null}} input
 * @returns {{ok:boolean, sessionId:string|null, reason?:string}}
 */
export function evaluateCompanionGuard(input) {
  const source = input || {}
  const focusId = source.focusId || null
  const candidates = Array.isArray(source.candidates) ? source.candidates : []
  const sessionId = source.sessionId || focusId
  if (!focusId) return { ok: false, sessionId: null, reason: 'no-focus' }
  if (!sessionId) return { ok: false, sessionId: null, reason: 'no-session' }
  if (candidates.indexOf(sessionId) >= 0) return { ok: false, sessionId, reason: 'candidate' }
  if (sessionId !== focusId) return { ok: false, sessionId, reason: 'not-focus' }
  return { ok: true, sessionId }
}

/**
 * 校验资源地址是否可能被官方接受（scheme 校验；具体 canOpen 由官方判断并在 throw 中体现）。
 * @param {unknown} address
 * @returns {boolean}
 */
export function isResourceAddress(address) {
  return typeof address === 'string' && address.indexOf(RESOURCE_SCHEME) === 0
}

/**
 * 创建伴生窗适配器。
 * @param {object} deps { ctx, log, getFocusId, getCandidates, isCandidate }
 */
export function createCompanion(deps) {
  const { ctx, log } = deps
  const service = () => {
    try {
      return ctx.get('sidebarRight')
    } catch (_error) {
      return undefined
    }
  }
  const registry = () => {
    try {
      return ctx.get('sidebarRightTabs')
    } catch (_error) {
      return undefined
    }
  }
  const focusId = () => (typeof deps.getFocusId === 'function' ? deps.getFocusId() : null)
  const candidates = () => (typeof deps.getCandidates === 'function' ? deps.getCandidates() || [] : [])

  const readKinds = () => {
    const reg = registry()
    if (!reg || typeof reg.entries !== 'function') return []
    try {
      return reg
        .entries()
        .map((definition) => (definition && definition.kind) || null)
        .filter(Boolean)
    } catch (_error) {
      return []
    }
  }

  const readMounted = () => {
    const svc = service()
    if (!svc || !svc.mounted || typeof svc.mounted.getSnapshot !== 'function') return null
    try {
      return svc.mounted.getSnapshot() || null
    } catch (_error) {
      return null
    }
  }

  const isExpanded = () => {
    const svc = service()
    if (!svc || typeof svc.isExpanded !== 'function') return false
    try {
      return !!svc.isExpanded()
    } catch (_error) {
      return false
    }
  }

  /** 能力 + 跟随状态快照（探针/调试/验收用）。 */
  const snapshot = () =>
    evaluateCompanion({
      available: !!service(),
      mounted: readMounted(),
      focusId: focusId(),
      tabKinds: readKinds(),
      expanded: isExpanded(),
    })

  /**
   * 统一调用官方服务：错误归一化为 {ok:false, reason, error}，不向调用方抛。
   * @param {string} method
   * @param {unknown[]} args
   */
  const invoke = (method, args) => {
    const svc = service()
    if (!svc) return { ok: false, reason: 'unavailable' }
    const fn = svc[method]
    if (typeof fn !== 'function') return { ok: false, reason: 'missing-method:' + method }
    try {
      const value = fn.apply(svc, args || [])
      log.log('companion.' + method, null)
      return { ok: true, value: value === undefined ? null : value }
    } catch (error) {
      log.log('companion.' + method + '.error', String(error && error.message ? error.message : error))
      return { ok: false, reason: 'throw', error: String(error && error.message ? error.message : error) }
    }
  }

  /** 守卫：写操作只允许作用在当前焦点会话。 */
  const guard = (sessionId) =>
    evaluateCompanionGuard({ focusId: focusId(), candidates: candidates(), sessionId: sessionId || null })

  return {
    snapshot,
    isExpanded,
    /** 展开/收起右栏（不改变会话）。 */
    toggle() {
      return invoke('toggleExpanded', [])
    },
    /** 确保右栏处于展开状态（已展开则 no-op）。 */
    ensureVisible() {
      if (!service()) return { ok: false, reason: 'unavailable' }
      if (isExpanded()) return { ok: true, reason: 'already-expanded' }
      return invoke('toggleExpanded', [])
    },
    /**
     * 打开官方 tab 类型。
     * @param {string} kind
     * @param {object} [options]
     * @param {string} [sessionId] 目标会话（默认焦点；候场/非焦点会被拒绝）
     */
    openTab(kind, options, sessionId) {
      const allowed = guard(sessionId)
      if (!allowed.ok) return allowed
      const kinds = readKinds()
      if (kinds.length > 0 && kinds.indexOf(kind) < 0) return { ok: false, reason: 'kind-missing:' + kind, tabKinds: kinds }
      return invoke('openTab', [kind, options || {}])
    },
    /**
     * 用官方资源面打开资源（文档/文件等）；浏览器 tab 是否可用由 tab kind 决定。
     * @param {string} address dsh-resource:// 地址
     * @param {object} [options]
     * @param {string} [sessionId]
     */
    openResource(address, options, sessionId) {
      const allowed = guard(sessionId)
      if (!allowed.ok) return allowed
      if (!isResourceAddress(address)) return { ok: false, reason: 'bad-address' }
      return invoke('openResource', [address, options || {}])
    },
    /** 当前激活 tab（无 on-screen surface 时官方返回 undefined）。 */
    activeTab() {
      return invoke('active', [])
    },
    /** 订阅 on-screen 会话变化（跟随审计用）；返回 disposer。 */
    subscribeMounted(listener) {
      const svc = service()
      if (!svc || !svc.mounted || typeof svc.mounted.subscribe !== 'function') return () => {}
      try {
        return svc.mounted.subscribe(listener)
      } catch (_error) {
        return () => {}
      }
    },
  }
}

/**
 * P3 伴生浮窗编排层（不直接依赖 DOM/React；DOM 回显由 index.js 注入）。
 *
 * @param {object} deps
 * @param {()=>object|undefined} deps.getService 官方 sidebarRight 实例
 * @param {()=>string|null} deps.getFocusId 舞台焦点会话 id
 * @param {(event:string, data?:object|null)=>void} [deps.log]
 * @param {object} [deps.dom] DOM 回显适配器（缺省时相关能力返回不可用）：
 *   - `stageRect(): {x,y,width,height}|null` 舞台内容区矩形
 *   - `viewport(): {width,height}` 视口尺寸
 *   - `panel(sessionId): {found:boolean, open:boolean, opening:boolean, mode:string|null, rect?:object}` 右栏 panel 状态
 *   - `floats(sessionId): Array<{paneId,tabId,title,rect,peeked?}>` 当前会话官方浮窗（含正被 peek 的）
 * @returns {object} 浮窗运行时 API
 */
export function createFloatCompanion(deps) {
  const { log } = deps
  const dom = deps.dom || {}
  const service = () => {
    try {
      return typeof deps.getService === 'function' ? deps.getService() : undefined
    } catch (_error) {
      return undefined
    }
  }
  const focusId = () => {
    try {
      return (typeof deps.getFocusId === 'function' && deps.getFocusId()) || null
    } catch (_error) {
      return null
    }
  }
  const errorText = (error) => String((error && error.message) || error).slice(0, 200)

  /** 统一调用官方方法：错误归一化，不抛。 */
  const invoke = (method, args) => {
    const svc = service()
    if (!svc) return { ok: false, reason: 'unavailable' }
    const fn = svc[method]
    if (typeof fn !== 'function') return { ok: false, reason: 'missing-method:' + method }
    try {
      const value = fn.apply(svc, Array.isArray(args) ? args : [])
      return { ok: true, value: value === undefined ? null : value }
    } catch (error) {
      if (log) log('float.invoke.error', { method, error: errorText(error) })
      return { ok: false, reason: 'throw', error: errorText(error) }
    }
  }

  const stageRect = () => {
    try {
      return typeof dom.stageRect === 'function' ? normalizeStage(dom.stageRect()) : null
    } catch (_error) {
      return null
    }
  }
  const viewport = () => {
    try {
      const size = typeof dom.viewport === 'function' ? dom.viewport() : null
      return size && Number.isFinite(Number(size.width)) ? { width: Number(size.width), height: Number(size.height) } : null
    } catch (_error) {
      return null
    }
  }
  const readPanel = (sessionId) => {
    try {
      const panel = typeof dom.panel === 'function' ? dom.panel(sessionId || focusId()) : null
      return panel && typeof panel === 'object' ? panel : null
    } catch (_error) {
      return null
    }
  }
  const readFloats = (sessionId) => {
    try {
      const list = typeof dom.floats === 'function' ? dom.floats(sessionId || focusId()) : null
      return Array.isArray(list) ? list : []
    } catch (_error) {
      return []
    }
  }

  /** 当前槽位表（舞台不可用时 null）。 */
  const slots = () => {
    const stage = stageRect()
    if (!stage || stage.width <= 0) return null
    const size = viewport()
    return computeSlots(stage, size ? { viewportWidth: size.width } : {})
  }

  /** 读官方 openTabs 清单（当前会话）。 */
  const openTabs = () => {
    const svc = service()
    if (!svc || !svc.openTabs || typeof svc.openTabs.getSnapshot !== 'function') return { ok: false, reason: 'no-openTabs', value: [] }
    try {
      const all = svc.openTabs.getSnapshot() || []
      const sessionId = focusId()
      const value = all.filter((item) => !sessionId || item.sessionId === sessionId)
      return { ok: true, value }
    } catch (error) {
      return { ok: false, reason: 'throw', error: errorText(error), value: [] }
    }
  }

  /** 当前会话官方 tab 记录（controller.tabsIn；不在 ISidebarRight 接口）。 */
  const tabsIn = (sessionId) => {
    const svc = service()
    const target = sessionId || focusId()
    if (!svc || typeof svc.tabsIn !== 'function' || !target) return { ok: false, reason: 'unavailable', value: [] }
    try {
      return { ok: true, value: svc.tabsIn(target) || [] }
    } catch (error) {
      return { ok: false, reason: 'throw', error: errorText(error), value: [] }
    }
  }

  /**
   * 槽位分配（满槽按 Q13 先淘汰最久未聚焦的未收起浮窗）。
   * @param {Array<object>} managedFloats 当前会话 managed 浮窗记录
   * @returns {{ok:boolean, reason?:string, slot?:number, rect?:object, evicted?:object|null, table?:object}}
   */
  const allocate = (managedFloats) => {
    const table = slots()
    if (!table) return { ok: false, reason: 'no-stage' }
    const floats = Array.isArray(managedFloats) ? managedFloats : []
    const occupied = floats
      .filter((item) => item && !item.peeked && !item.docked && Number.isInteger(item.slot))
      .map((item) => item.slot)
    const free = allocateSlotIndex(table.maxSlots, occupied)
    if (free !== null) return { ok: true, slot: free, rect: table.slots[free], evicted: null, table }
    const candidates = floats.filter((item) => !item.docked)
    const evicted = selectEvictionCandidate(candidates)
    if (!evicted) return { ok: false, reason: 'no-slot', table }
    const slot = Number.isInteger(evicted.slot) && evicted.slot >= 0 ? evicted.slot : 0
    return { ok: true, slot, rect: table.slots[Math.min(slot, table.slots.length - 1)], evicted, table }
  }

  /** 快照（探针/调试）：焦点、右栏态、槽位、官方浮窗回显、openTabs。 */
  const snapshot = () => {
    const sessionId = focusId()
    const panel = readPanel(sessionId)
    const table = slots()
    return {
      available: !!service(),
      sessionId,
      expanded: !!invoke('isExpanded', []).value,
      panel,
      slots: table,
      floatCount: readFloats(sessionId).length,
      floats: readFloats(sessionId),
      openTabs: openTabs().value,
    }
  }

  /**
   * 对账：把 DOM 回显合并进插件状态（P3-3 自愈：关闭/收回/重挂载后记录跟着收敛）。
   * @param {object} state 插件伴生窗状态（float-state.js）
   * @param {string} [sessionId]
   * @param {number} [now]
   * @returns {{state:object, changed:boolean, removed:Array<string>, unmanaged:Array<object>, counts:{total:number,peeked:number,visible:number}}}
   */
  const reconcile = (state, sessionId, now = Date.now()) => {
    const target = sessionId || focusId()
    const current = sessionStateOf(state, target)
    const table = slots()
    // docked 记录只在官方 tab 仍打开时保留（关掉的 docked tab 不应无限累积）。
    const openTabIds = new Set(openTabs().value.map((item) => String(item.tabId)))
    const records = current.floats.filter((item) => !item.docked || openTabIds.has(String(item.tabId)))
    const dropped = current.floats.length - records.length
    const result = reconcileFloats(records, readFloats(target), table ? table.slots : [])
    const changed = result.changed || dropped > 0
    const nextState = changed ? updateFloats(state, target, result.records, now) : state
    const peeked = result.records.filter((item) => item.peeked).length
    return {
      state: nextState,
      changed,
      removed: dropped > 0 ? result.removed.concat(current.floats.filter((item) => item.docked && !openTabIds.has(String(item.tabId))).map((item) => item.tabId)) : result.removed,
      unmanaged: result.unmanaged,
      counts: { total: result.records.length, peeked, visible: result.records.length - peeked },
    }
  }

  return {
    snapshot,
    slots,
    allocate,
    reconcile,
    readFloats,
    readPanel,
    /** 舞台矩形（normalizeStage 形状；无舞台时 null）。 */
    stageRect: () => {
      const stage = stageRect()
      return stage && stage.width > 0 ? stage : null
    },
    openTabs,
    tabsIn,
    activeRecord() {
      return invoke('active', [])
    },
    isExpanded() {
      const result = invoke('isExpanded', [])
      return !!(result.ok && result.value)
    },
    toggleExpanded() {
      return invoke('toggleExpanded', [])
    },
    /** 把 docked tab 浮出到指定 rect（官方对 floating/missing 静默 no-op）。 */
    floatTab(tabId, rect) {
      if (!tabId) return { ok: false, reason: 'no-tab' }
      return invoke('float', [tabId, rect || undefined])
    },
    focusTab(tabId) {
      if (!tabId) return { ok: false, reason: 'no-tab' }
      return invoke('focus', [tabId])
    },
    dockPane(paneId) {
      if (!paneId) return { ok: false, reason: 'no-pane' }
      return invoke('dock', [paneId])
    },
    closeTab(tabId) {
      if (!tabId) return { ok: false, reason: 'no-tab' }
      return invoke('close', [tabId])
    },
    hideTab(tabId) {
      if (!tabId) return { ok: false, reason: 'no-tab' }
      return invoke('hide', [tabId])
    },
  }
}
