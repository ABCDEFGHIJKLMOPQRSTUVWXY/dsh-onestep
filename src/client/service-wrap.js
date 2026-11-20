/**
 * P3-2 compat 包装层：运行时包装官方 `ctx.sidebarRight` 的顶层打开入口。
 *
 * 背景（docs/p3-plan.md D1 / docs/p3/contracts.md §10）：
 * - 官方没有「重定向打开目标」的扩展点：会话文件链接、工具卡、计划、子代理等顶层打开全部
 *   硬编码调用 `ctx.sidebarRight.openResource(...)` / `openTab(...)`；
 * - 官方服务是普通类实例（无 Proxy/tracker），给实例赋 own property 即可对所有即时属性调用生效，
 *   且不能通过 `ctx.set` 改写（跨 fiber 抛错）。
 *
 * 职责边界（P3-2）：
 * - 方法捕获/还原、能力自检、防重复包装；
 * - 同步重定向算法（§5.3）：官方打开 → float 前取 tabId → 已管理则 focus → 否则分配槽位并
 *   `float(tabId, rect)` → 收起本次造成的展开；
 * - 官方错误原样抛给调用方；包装层自身步骤失败只记日志、结果留在官方右栏；
 * - 默认**不启用**（`policy.isEnabled()` 由 P3-3/P3-4 形态状态接线后开启），因此本模块上线时
 *   产品行为与官方完全一致。
 *
 * 本模块的可判定逻辑不依赖运行中的服务，便于单测。
 */

/** 同一服务上的重复包装标记（跨插件实例共享）。 */
export const WRAP_MARK = Symbol.for('dsh-onestep.sidebarRight.wrap')

/** 被包装的顶层入口。 */
export const WRAPPED_METHODS = ['openResource', 'openTab']

/** P3 依赖、必须存在的官方实例成员（contracts.md §1.1）。 */
export const REQUIRED_METHODS = ['openResource', 'openTab', 'active', 'isExpanded', 'toggleExpanded', 'float', 'focus']

/** 调用方自带的显式放置意图：任一存在即直通（尊重调用方）。 */
export const PLACEMENT_FIELDS = ['destination', 'paneId', 'preferNewPane', 'replaceTab']

/**
 * 能力自检：P3 依赖的成员是否都在实例上。
 * @param {object|undefined} service 官方 `sidebarRight` 实例
 * @returns {{ok:boolean, missing:string[], reason?:string}}
 */
export function checkWrapSupport(service) {
  if (!service || (typeof service !== 'object' && typeof service !== 'function')) {
    return { ok: false, missing: REQUIRED_METHODS.slice(), reason: 'no-service' }
  }
  const missing = REQUIRED_METHODS.filter((name) => typeof service[name] !== 'function')
  return missing.length === 0 ? { ok: true, missing: [] } : { ok: false, missing, reason: 'missing-method' }
}

/**
 * 纯函数：本次顶层打开是否应重定向为浮窗（其余直通）。
 * @param {object|undefined} options 调用方 options
 * @returns {{redirect:boolean, reason:string}}
 */
export function decideOpen(options) {
  const source = options && typeof options === 'object' ? options : {}
  for (const field of PLACEMENT_FIELDS) {
    if (source[field] !== undefined) return { redirect: false, reason: 'explicit-' + field }
  }
  return { redirect: true, reason: 'default-placement' }
}

/**
 * 校验并归一化槽位矩形（viewport CSS px；非法则返回 null，调用方留在官方右栏）。
 * @param {unknown} rect
 * @returns {{x:number,y:number,width:number,height:number}|null}
 */
export function normalizeRect(rect) {
  if (!rect || typeof rect !== 'object') return null
  const x = Number(rect.x)
  const y = Number(rect.y)
  const width = Number(rect.width)
  const height = Number(rect.height)
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return null
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

/** 服务实例上是否已有本插件（或其它插件）的包装。 */
export function isWrapped(service) {
  if (!service) return false
  return WRAPPED_METHODS.some((name) => typeof service[name] === 'function' && !!service[name][WRAP_MARK])
}

/**
 * 安装包装层。
 *
 * @param {object} options
 * @param {() => object|undefined} options.getService 惰性取官方 `sidebarRight` 实例
 * @param {{isEnabled:()=>boolean, isManaged?:(tabId:string)=>boolean, onRevealManaged?:(record:object)=>boolean, onFocusManaged?:(record:object)=>boolean, planOpen?:(record:object)=>({rect?:object}|null), onManaged?:(record:object, rect:object)=>void}} options.policy
 *   `onRevealManaged`：本次打开命中的是已管理浮窗且该窗处于收起态时调用；返回 true 表示已展开（消费方应跳过额外 focus）。
 *   `onFocusManaged`：命中的已管理浮窗已展开（无需展开动作）时调用；用于高亮闪烁提示（层级抬升仍由随后的官方 focus 完成）。
 * @param {(event:string, data?:object|null)=>void} [options.log]
 * @returns {{ok:boolean, reason?:string, missing?:string[], status:()=>object, restore:()=>object}}
 */
export function installServiceWrap(options) {
  const { getService, policy } = options
  const log = typeof options.log === 'function' ? options.log : () => {}
  const safeService = () => {
    try {
      return typeof getService === 'function' ? getService() : undefined
    } catch (_error) {
      return undefined
    }
  }
  const support = checkWrapSupport(safeService())
  const emptyResult = (reason, extra) => ({
    ok: false,
    reason,
    ...(extra || {}),
    status: () => ({ installed: false, enabled: false, reason, ...(extra || {}) }),
    restore: () => ({ ok: true, restored: 0 }),
  })
  if (!support.ok) return emptyResult(support.reason || 'unsupported', { missing: support.missing })

  const service = safeService()
  if (isWrapped(service)) return emptyResult('already-wrapped')
  for (const method of WRAPPED_METHODS) {
    if (Object.prototype.hasOwnProperty.call(service, method)) {
      // 别的插件已改写该实例方法：不争抢，交给它。
      return emptyResult('instance-patched:' + method)
    }
  }

  const originals = {}
  const installed = {}
  let restored = false
  let redirectCount = 0
  let followUpErrorCount = 0

  const policyEnabled = () => {
    try {
      return !!(policy && typeof policy.isEnabled === 'function' && policy.isEnabled())
    } catch (error) {
      log('wrap.policy.error', { error: errorText(error) })
      return false
    }
  }

  const executeFollowUp = (svc, beforeExpanded, method) => {
    // 打开已完成：以下任一失败都不向调用方抛，结果留在官方右栏。
    const record = svc.active()
    if (!record || !record.id) {
      log('wrap.no-active', { method })
      return
    }
    let managed = false
    try {
      managed = !!(policy && typeof policy.isManaged === 'function' && policy.isManaged(record.id))
    } catch (error) {
      log('wrap.policy.error', { error: errorText(error) })
    }
    if (managed) {
      // 已在浮窗：收起态先由 policy 展开（恢复可见）；已展开时不再执行展开动作，
      // 由 policy 高亮闪烁两下，随后官方 focus 负责聚焦并把层级提到最上层（focusTab 对浮窗会 raise）。
      let revealed = false
      try {
        revealed = !!(policy && typeof policy.onRevealManaged === 'function' && policy.onRevealManaged(record))
      } catch (error) {
        followUpErrorCount += 1
        log('wrap.reveal.error', { error: errorText(error) })
      }
      if (!revealed) {
        let highlighted = false
        try {
          highlighted = !!(policy && typeof policy.onFocusManaged === 'function' && policy.onFocusManaged(record))
        } catch (error) {
          followUpErrorCount += 1
          log('wrap.focus.highlight.error', { error: errorText(error) })
        }
        svc.focus(record.id)
        log('wrap.focus-managed', { method, kind: record.kind || null, highlighted })
        return
      }
      log('wrap.reveal-managed', { method, kind: record.kind || null })
      return
    }
    let plan = null
    try {
      plan = policy && typeof policy.planOpen === 'function' ? policy.planOpen(record) : null
    } catch (error) {
      log('wrap.plan.error', { error: errorText(error) })
      return
    }
    const rect = normalizeRect(plan && plan.rect)
    if (!rect) {
      log('wrap.no-slot', { method, kind: record.kind || null })
      return
    }
    svc.float(record.id, rect)
    if (!beforeExpanded && svc.isExpanded()) svc.toggleExpanded()
    redirectCount += 1
    log('wrap.float', { method, kind: record.kind || null })
    try {
      if (policy && typeof policy.onManaged === 'function') policy.onManaged(record, rect, plan)
    } catch (error) {
      followUpErrorCount += 1
      log('wrap.track.error', { error: errorText(error) })
    }
  }

  const dispatch = (method, original, args) => {
    const svc = safeService()
    if (!svc) return original.apply(service, args)
    if (!policyEnabled()) return original.apply(svc, args)
    const decision = decideOpen(args[1])
    if (!decision.redirect) return original.apply(svc, args)
    let beforeExpanded = false
    try {
      beforeExpanded = !!svc.isExpanded()
    } catch (_error) {
      beforeExpanded = false
    }
    if (beforeExpanded) {
      // Q2 冻结：用户手动展开右栏时直通（尊重右栏）。
      log('wrap.passthrough.expanded', { method })
      return original.apply(svc, args)
    }
    const value = original.apply(svc, args) // 官方错误原样抛出（保持官方语义）
    try {
      executeFollowUp(svc, beforeExpanded, method)
    } catch (error) {
      followUpErrorCount += 1
      log('wrap.followup.error', { method, error: errorText(error) })
    }
    return value
  }

  for (const method of WRAPPED_METHODS) {
    originals[method] = service[method]
    const wrapper = function wrappedOpen(...args) {
      return dispatch(method, originals[method], args)
    }
    wrapper[WRAP_MARK] = true
    installed[method] = wrapper
    service[method] = wrapper
  }
  log('wrap.installed', { methods: WRAPPED_METHODS })

  const status = () => ({
    installed: !restored,
    enabled: policyEnabled(),
    redirectCount,
    followUpErrorCount,
    wrapped: WRAPPED_METHODS.filter((name) => !!(service[name] && service[name][WRAP_MARK])),
    supported: true,
  })

  const restore = () => {
    if (restored) return { ok: true, restored: 0 }
    let restoredCount = 0
    for (const method of WRAPPED_METHODS) {
      if (service[method] !== installed[method]) {
        log('wrap.restore.skip', { method })
        continue
      }
      delete service[method]
      restoredCount += 1
    }
    restored = true
    log('wrap.restored', { restored: restoredCount })
    return { ok: true, restored: restoredCount }
  }

  return { ok: true, status, restore }
}

/** 错误文本（不记录资源地址等敏感内容）。 */
function errorText(error) {
  return String((error && error.message) || error).slice(0, 200)
}
