/**
 * P3-1 探针桥：从插件内部直接读写官方 `ctx.sidebarRight`（P3 探针用，非生产路径）。
 *
 * 目的（docs/p3-plan.md §7 P3-1）：在实现包装层之前，先把「官方原语在隔离实例里的真实行为」
 * 变成可复现证据——逐帧无重排、多浮窗槽位、DOM 注入、`dock` 分屏、点击外部。
 *
 * 边界：
 * - 只做「读取 + 原样调用」，**不实现** P3-2 的生产重定向策略（`openFloat*` 只是按 §5.3 算法
 *   手工串一遍原语，用于 Go/No-Go；生产实现落在 service-wrap.js）。
 * - 所有官方异常归一化为 `{ ok:false, error }`，不向页面抛；日志只记方法名，不记资源地址内容。
 * - 返回值必须可 JSON 序列化（TabId/PaneId 是 branded string，原样返回）。
 * - P3-2 包装层上线后，本桥一律走**原型原始方法**（rawMethod），绕过插件包装：探针要量的是
 *   官方原语与 P3 显式重定向模拟，不是生产包装（生产路径由 P3-6 e2e 覆盖）。
 */
import { WRAP_MARK } from './service-wrap.js'

/** 官方 `ISidebarRight` 中 P3 依赖的成员（缺失即视为不满足 P3 契约）。 */
export const REQUIRED_METHODS = ['openResource', 'openTab', 'active', 'isExpanded', 'toggleExpanded', 'focus', 'float', 'dock', 'close']
export const REQUIRED_PROPS = ['mounted', 'openTabs']
/** 官方 controller 上存在、但不属于 ISidebarRight 的公开方法（探针用来读真实布局记录）。 */
export const OPTIONAL_METHODS = ['tabsIn', 'openResourceIn', 'openTabIn', 'hide', 'split']

const MAX_DEPTH = 6

/**
 * 把返回值裁剪成可序列化结构（只保留标量与浅层对象/数组）。
 * @param {unknown} value
 * @param {number} [depth]
 */
function sanitize(value, depth = 0) {
  if (value === undefined || value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return value
  if (type === 'function') return '[function]'
  if (type === 'symbol' || type === 'bigint') return String(value)
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? '[array]' : '[object]'
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => sanitize(item, depth + 1))
  try {
    const out = {}
    for (const key of Object.keys(value).slice(0, 64)) out[key] = sanitize(value[key], depth + 1)
    return out
  } catch (_error) {
    return String(value)
  }
}

/**
 * 取官方**原始**方法：P3-2 包装层安装后，`svc[method]` 可能是插件的 own-property 包装，
 * 探针必须绕行（否则 G1 对照会失真、openFloat 会二次重定向）。
 * @param {object} svc 官方服务实例
 * @param {string} name 方法名
 */
function rawMethod(svc, name) {
  const own = svc[name]
  if (typeof own === 'function' && !own[WRAP_MARK]) return own
  let proto = Object.getPrototypeOf(svc)
  while (proto && proto !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name)
    if (descriptor && typeof descriptor.value === 'function') return descriptor.value
    proto = Object.getPrototypeOf(proto)
  }
  return own
}

/**
 * 创建 P3 探针桥。
 * @param {{log:object, getService:()=>object|undefined, getFocusId:()=>string|null, getWrap?:()=>object}} deps
 * @returns {object} 挂到 `window.__ONESTEP__.actions.p3`
 */
export function createFloatProbe(deps) {
  const { log } = deps
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
  const errorText = (error) => String((error && error.message) || error)

  const attempt = (label, fn, fallback) => {
    try {
      return { ok: true, value: fn() }
    } catch (error) {
      log.log('floatprobe.error', { label, error: errorText(error).slice(0, 200) })
      return { ok: false, value: fallback, error: errorText(error) }
    }
  }

  /** 原样调用官方方法（绕过 P3 包装）；`{ok, value?, error?}`。 */
  const invoke = (method, args) => {    const svc = service()
    if (!svc) return { ok: false, error: 'no-service' }
    const fn = rawMethod(svc, method)
    if (typeof fn !== 'function') return { ok: false, error: 'missing-method:' + method }
    try {
      const value = fn.apply(svc, Array.isArray(args) ? args : [])
      log.log('floatprobe.call', { method })
      return { ok: true, value: sanitize(value) }
    } catch (error) {
      log.log('floatprobe.throw', { method, error: errorText(error).slice(0, 200) })
      return { ok: false, error: errorText(error) }
    }
  }

  const snapshot = () => {
    const svc = service()
    if (!svc) return { available: false }
    const active = attempt('active', () => svc.active())
    const expanded = attempt('isExpanded', () => svc.isExpanded())
    const mounted = attempt('mounted', () => svc.mounted && typeof svc.mounted.getSnapshot === 'function' ? svc.mounted.getSnapshot() : null)
    const openTabs = attempt('openTabs', () => svc.openTabs && typeof svc.openTabs.getSnapshot === 'function' ? svc.openTabs.getSnapshot() : null)
    return {
      available: true,
      mounted: sanitize(mounted.ok ? mounted.value : null),
      focusId: focusId(),
      expanded: !!(expanded.ok && expanded.value),
      activeTab: sanitize(active.ok ? active.value : null),
      openTabs: sanitize(openTabs.ok ? openTabs.value : null),
    }
  }

  /** 官方契约自检：P3 依赖方法/属性的存在性。 */
  const contract = () => {
    const svc = service()
    if (!svc) return { available: false, required: {}, optional: {}, props: {} }
    const required = {}
    for (const name of REQUIRED_METHODS) required[name] = typeof svc[name]
    const optional = {}
    for (const name of OPTIONAL_METHODS) optional[name] = typeof svc[name]
    const props = {}
    for (const name of REQUIRED_PROPS) props[name] = svc[name] === undefined || svc[name] === null ? 'missing' : typeof svc[name]
    return {
      available: true,
      required,
      optional,
      props,
      ok: REQUIRED_METHODS.every((name) => typeof svc[name] === 'function')
        && REQUIRED_PROPS.every((name) => svc[name] !== undefined && svc[name] !== null),
      kinds: (() => {
        try {
          const registry = deps.getRegistry ? deps.getRegistry() : null
          if (!registry || typeof registry.entries !== 'function') return []
          return registry.entries().map((definition) => (definition && definition.kind) || null).filter(Boolean)
        } catch (_error) {
          return []
        }
      })(),
    }
  }

  /**
   * P3-1 §5.3 重定向算法的探针版（仅供 Go/No-Go 证据，生产实现是 service-wrap.js）。
   * 同步执行：官方打开 → 取 active() → float(rect) → 收起本次造成的展开。
   * @param {()=>void} openFn 官方打开调用
   * @param {{x:number,y:number,width:number,height:number}} [rect]
   */
  const redirect = (openFn, rect) => {
    const svc = service()
    if (!svc) return { ok: false, error: 'no-service' }
    const steps = []
    const expandedBefore = !!(attempt('isExpanded', () => svc.isExpanded()).value || false)
    const activeBefore = sanitize(attempt('active', () => svc.active()).value || null)
    try {
      openFn(svc)
    } catch (error) {
      log.log('floatprobe.open.throw', { error: errorText(error).slice(0, 200) })
      return { ok: false, phase: 'open', error: errorText(error), expandedBefore, steps }
    }
    steps.push('open')
    const record = sanitize(attempt('active', () => svc.active()).value || null)
    steps.push('active')
    if (!record || !record.id) {
      return { ok: true, tabId: null, note: 'active-tab-undefined', expandedBefore, steps, record }
    }
    const floatCall = attempt('float', () => svc.float(record.id, rect || undefined))
    if (!floatCall.ok) return { ok: false, phase: 'float', error: floatCall.error, tabId: record.id, expandedBefore, steps, record }
    steps.push('float')
    const expandedAfterFloat = !!(attempt('isExpanded', () => svc.isExpanded()).value || false)
    let collapsed = false
    if (!expandedBefore && expandedAfterFloat) {
      const collapse = attempt('toggleExpanded', () => svc.toggleExpanded())
      collapsed = collapse.ok
      if (collapsed) steps.push('collapse')
    }
    const after = snapshot()
    const tabs = sanitize(attempt('tabsIn', () => svc.tabsIn(after.mounted)).value || [])
    return {
      ok: true,
      tabId: record.id,
      kind: record.kind || null,
      title: record.title || null,
      expandedBefore,
      expandedAfterFloat,
      collapsed,
      steps,
      after,
      tabs: tabs.filter((tab) => tab && (tab.id === record.id || tab.kind === record.kind)),
    }
  }

  /** 读注入的 P3 运行时依赖（index.js 提供）；缺失返回 ok:false。 */
  const fromDep = (name, args) => {
    try {
      const fn = deps[name]
      if (typeof fn !== 'function') return { ok: false, error: 'missing-dep:' + name }
      const value = fn.apply(null, Array.isArray(args) ? args : [])
      return { ok: true, value: sanitize(value) }
    } catch (error) {
      return { ok: false, error: errorText(error) }
    }
  }

  return {
    contract,
    snapshot,
    invoke,
    openResource(address, options) {
      return invoke('openResource', [address, options || {}])
    },
    openTab(kind, options) {
      return invoke('openTab', [kind, options || {}])
    },
    openFloat(address, rect, options) {
      return redirect((svc) => rawMethod(svc, 'openResource').apply(svc, [address, options || {}]), rect)
    },
    openTabFloat(kind, rect, options) {
      return redirect((svc) => rawMethod(svc, 'openTab').apply(svc, [kind, options || {}]), rect)
    },
    float(tabId, rect) {
      return invoke('float', [tabId, rect || undefined])
    },
    dock(paneId) {
      return invoke('dock', [paneId])
    },
    focus(tabId) {
      return invoke('focus', [tabId])
    },
    close(tabId) {
      return invoke('close', [tabId])
    },
    toggleExpanded() {
      return invoke('toggleExpanded', [])
    },
    active() {
      return invoke('active', [])
    },
    isExpanded() {
      return invoke('isExpanded', [])
    },
    /** 当前 on-screen 会话的官方 tab 记录（controller.tabsIn，非 ISidebarRight）。 */
    tabs() {
      const current = snapshot().mounted
      return invoke('tabsIn', [current])
    },
    /** 官方 openTabs 清单（读取；供会话切换对账用）。 */
    openTabs() {
      const svc = service()
      if (!svc || !svc.openTabs || typeof svc.openTabs.getSnapshot !== 'function') return { ok: false, error: 'no-openTabs' }
      return { ok: true, value: sanitize(svc.openTabs.getSnapshot()) }
    },
    /** P3-2 包装层状态（installed/enabled/计数）；未接线时返回 pending。 */
    wrap() {
      try {
        return { ok: true, value: typeof deps.getWrap === 'function' ? sanitize(deps.getWrap()) : null }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    },
    /** P3-3 伴生窗自有状态（形态/槽位/managed/peek；已按 Q11 清 peek）。 */
    floatState() {
      return fromDep('getFloatState', [])
    },
    /** P3-3 浮窗运行时快照（焦点/右栏态/槽位/官方浮窗回显/openTabs）。 */
    floatSnapshot() {
      return fromDep('getFloatSnapshot', [])
    },
    /** P3-3 槽位表（1440/1280/860 等视口下的公式结果）。 */
    floatSlots() {
      return fromDep('getFloatSlots', [])
    },
    /** P3-3/P3-10 槽位分配（满槽返回 evicted）。 */
    floatAllocate(sessionId) {
      return fromDep('getFloatAllocate', [sessionId])
    },
    /** P3-3 对账（DOM 回显 → 插件状态自愈）。 */
    floatReconcile(sessionId) {
      return fromDep('getFloatReconcile', [sessionId])
    },
    /** P3-4 形态与计数（float/split + total/peeked/visible）。 */
    floatMode() {
      return fromDep('getCompanionMode', [])
    },
    /** P3-4 伴生窗开/收（有可见浮窗→全部收起；有收起→恢复；无浮窗→打开 guide 浮窗）。 */
    floatToggle() {
      return fromDep('getCompanionToggle', [])
    },
    /** P3-4 切换形态（float/split）。 */
    floatSetMode(mode) {
      return fromDep('getCompanionSetMode', [mode])
    },
    /** P3-4/P3-11 手动注入/还原单个浮窗的收起态（为 P3-6/P3-11 用例预留）。 */
    floatPeek(tabId, peeked) {
      return fromDep('getCompanionPeek', [tabId, peeked])
    },
    /** P3-6 G6：卸载-还原-重装包装层（验证方法还原/无残留/可重装）。 */
    wrapCycle() {
      return fromDep('getWrapCycle', [])
    },
    /** P3-11 收起全部浮窗（等价点击浮窗外）。 */
    floatPeekAll() {
      return fromDep('getCompanionPeekAll', [])
    },
    /** P3-11 恢复单个收起浮窗（等价点击右缘标签）。 */
    floatRestore(tabId) {
      return fromDep('getCompanionRestore', [tabId])
    },
    /** P3-12 「转回浮窗」：把已收回官方右栏的伴生 tab 重新浮出。 */
    floatRestoreDocked() {
      return fromDep('getCompanionRestoreDocked', [])
    },
    /** P3-11 标签层状态（收起项数 / 标签 DOM 数 / 层是否存在 / 点击外部监听）。 */
    floatTags() {
      return fromDep('getPeekLayer', [])
    },
    /** P3-11 标签层纵向位置（US-3/4：拖动/键盘后持久化）。 */
    floatTagTop() {
      return fromDep('getTagTop', [])
    },
    /** P3-11 设置标签层纵向位置（null = 恢复自动安全位置）。 */
    floatTagSetTop(top) {
      return fromDep('setTagTop', [top])
    },
    /** 0.7.0 浮窗边缘缩放状态（把手数/拖动中方向与矩形/最近一次提交）。 */
    floatResize() {
      return fromDep('getFloatResize', [])
    },
    /** 0.7.0 手动同步缩放把手（官方 DOM 变化后的对账；探针/诊断用）。 */
    floatResizeSync() {
      return fromDep('getFloatResizeSync', [])
    },
  }
}
