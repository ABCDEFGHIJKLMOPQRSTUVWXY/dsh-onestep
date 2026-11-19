/**
 * P4 动效基础设施：token 单一源 + View Transitions 控制器。
 *
 * 边界：
 * - 纯模块：不在 import 期读 DOM；不依赖 React；不持久化。
 * - 时长/距离/缩放常量只在本文件定义，styles.js 用 motionTokensCss() 插值；
 *   src/client 其他文件不得再写裸时长/曲线字面量（P4-10 grep 门禁）。
 * - 控制器只做「VT 包装 / 跳过 / 回退 / 清理」；DOM 命名与 :root 变量由调用方/样式层承载。
 * - 探针面只暴露只读快照（window.__ONESTEP__.motion 由 probe.js 接线）。
 */

/** 动效时长/距离/缩放（ms / px / 比例）。 */
export const MOTION = Object.freeze({
  // 时长（ms）
  fast: 120,
  base: 180,
  slow: 240,
  morph: 220,
  /** 点击候场卡换焦的慢速 morph（0.6.1）：320ms，给「官方聊天体重挂载」留出动画期。 */
  morphClick: 320,
  morphOut: 200,
  evict: 160,
  stageIn: 260,
  peek: 180,
  flash: 600,
  /** 完成闪烁的高亮窗口（动画 2×600ms + 200ms 余量）；feedback 用它到点自清，避免依赖 re-render。 */
  flashHold: 1400,
  toastIn: 160,
  toastOut: 1000,
  overlayIn: 120,
  overlayPanel: 160,
  menu: 120,
  bubbleOut: 120,
  hud: 140,
  // VT 内容交叉（ms）
  vtOldFade: 60,
  vtFade: 120,
  vtDelay: 40,
  /** 窗口几何 morph 曲线：快出慢收（easeOutQuint 近似，开始跟手、结尾稳定）。 */
  easeMorph: 'cubic-bezier(0.22,1,0.36,1)',
  // 距离/缩放
  shift: 4,
  shiftMenu: 2,
  hoverLift: 1,
  railShift: 12,
  scaleIdle: 0.96,
  scaleEnter: 0.98,
})

/** 状态点等微反馈候选：状态切换颜色过渡（不是循环动画）。 */
export const MOTION_STATUS_SWAP_MS = MOTION.fast

/** VT kind → 组时长/交叉时长/延迟（ms）。 */
export const MOTION_KINDS = Object.freeze({
  promote: { groupMs: MOTION.morph, oldFadeMs: MOTION.vtOldFade, fadeMs: MOTION.vtFade, delayMs: MOTION.vtDelay },
  /** 点击路径：慢速 morph；VT 回调只做「占位内容」的轻量提交，真实聊天体在动画期间挂载。 */
  promoteClick: { groupMs: MOTION.morphClick, oldFadeMs: MOTION.vtOldFade, fadeMs: MOTION.vtFade, delayMs: MOTION.vtDelay },
  rail: { groupMs: MOTION.morph, oldFadeMs: MOTION.vtOldFade, fadeMs: MOTION.vtFade, delayMs: MOTION.vtDelay },
  close: { groupMs: MOTION.evict, oldFadeMs: MOTION.vtOldFade, fadeMs: MOTION.vtFade, delayMs: 0 },
  evict: { groupMs: MOTION.evict, oldFadeMs: MOTION.vtOldFade, fadeMs: MOTION.vtFade, delayMs: 0 },
  add: { groupMs: MOTION.evict, oldFadeMs: MOTION.vtOldFade, fadeMs: MOTION.vtFade, delayMs: 0 },
})

/** 生效动效模式：'full' | 'reduced'。setting 为 store.reducedMotion（system/always/never）。 */
export function resolveMotionMode(setting, systemReduced) {
  if (setting === 'always') return 'reduced'
  return systemReduced ? 'reduced' : 'full'
}

/** 系统是否要求减少动效（无 matchMedia 的环境按否）。 */
export function systemPrefersReducedMotion(win) {
  const target = win || (typeof window !== 'undefined' ? window : null)
  if (!target || typeof target.matchMedia !== 'function') return false
  try {
    return !!target.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch (_error) {
    return false
  }
}

/** 当前环境是否应减少动效。 */
export function isReduced(getSetting, win) {
  const setting = typeof getSetting === 'function' ? getSetting() : getSetting
  return resolveMotionMode(setting, systemPrefersReducedMotion(win)) === 'reduced'
}

/** 任意 id → 合法且稳定的 view-transition-name（custom-ident）。 */
export function transitionName(prefix, rawId) {
  const raw = rawId === undefined || rawId === null ? '' : String(rawId)
  if (!raw) return null
  return prefix + raw.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** sessionId → 窗口命名的 view-transition-name。 */
export function windowName(sessionId) {
  return transitionName('onestep-w-', sessionId)
}

const DURATION_TOKENS = [
  ['--onestep-fast', 'fast'],
  ['--onestep-base', 'base'],
  ['--onestep-slow', 'slow'],
  ['--onestep-morph', 'morph'],
  ['--onestep-morph-out', 'morphOut'],
  ['--onestep-evict', 'evict'],
  ['--onestep-stage-in', 'stageIn'],
  ['--onestep-peek', 'peek'],
  ['--onestep-flash', 'flash'],
  ['--onestep-toast-in', 'toastIn'],
  ['--onestep-toast-out', 'toastOut'],
  ['--onestep-overlay-in', 'overlayIn'],
  ['--onestep-overlay-panel', 'overlayPanel'],
  ['--onestep-menu', 'menu'],
  ['--onestep-bubble-out', 'bubbleOut'],
  ['--onestep-hud', 'hud'],
]

const DISTANCE_TOKENS = [
  ['--onestep-shift', MOTION.shift + 'px'],
  ['--onestep-shift-menu', MOTION.shiftMenu + 'px'],
  ['--onestep-hover-lift', MOTION.hoverLift + 'px'],
  ['--onestep-rail-shift', MOTION.railShift + 'px'],
  ['--onestep-scale-idle', String(MOTION.scaleIdle)],
  ['--onestep-scale-enter', String(MOTION.scaleEnter)],
]

/**
 * 方向性 VT 覆盖（P4.2 卡顿/闪修复）：按「被提升」与「被降级」窗口分别调整快照交叉时间。
 * - 被提升窗口的旧快照是候场缩略图，若随 group 放大到焦点尺寸会盖住邻窗 → 立即隐藏，新内容尽早淡入；
 * - 被降级窗口的新快照是候场卡，若在 focus 尺寸下淡入会形成「放大的卡片鬼影」→ 延迟到 group 收拢后再淡入。
 *
 * @param {{from?:string|null, to?:string|null}} direction from=被降级（旧焦点），to=被提升（新焦点）
 * @returns {string} 只含 ::view-transition-* 规则的 CSS；无方向时返回空串
 */
export function viewTransitionDirectionCss(direction) {
  if (!direction) return ''
  const fromName = windowName(direction.from)
  const toName = windowName(direction.to)
  const rules = []
  if (toName) {
    rules.push('::view-transition-old(' + toName + '){animation-duration:1ms !important}')
    rules.push('::view-transition-new(' + toName + '){animation-delay:0ms !important}')
  }
  if (fromName) {
    rules.push('::view-transition-new(' + fromName + '){animation-delay:150ms !important;animation-duration:80ms !important}')
  }
  return rules.join('\n')
}

/**
 * 默认 token（`:root`）：覆盖 stage 与所有 portal 层（picker/HUD/probe/peek 标签）。
 * 曲线对齐宿主 --ds-ease-in-out；方向性进出场使用关键字 ease-out/ease-in，不新增自定义曲线。
 */
export function motionTokensCss() {
  const list = [
    '--onestep-ease:var(--ds-ease-in-out,cubic-bezier(0.4,0,0.2,1))',
    '--onestep-ease-morph:' + MOTION.easeMorph,
  ]
  for (const [token, key] of DURATION_TOKENS) list.push(token + ':' + MOTION[key] + 'ms')
  for (const [token, value] of DISTANCE_TOKENS) list.push(token + ':' + value)
  return ':root{' + list.join(';') + '}'
}

/** reduced 覆盖：时长 0、距离 0、缩放 1（属性路径；系统 media 路径见 styles.js）。 */
export function motionReducedCss() {
  const list = []
  for (const [token] of DURATION_TOKENS) list.push(token + ':0ms')
  for (const [token] of DISTANCE_TOKENS) list.push(token + ':' + (token.includes('scale') ? '1' : '0px'))
  return list.join(';')
}

/** View Transitions 伪元素规则；每次过渡前控制器在 :root 写 --onestep-vt-*。 */
export function motionViewTransitionCss() {
  return [
    // 窗口几何：非线性「快出慢收」曲线
    '::view-transition-group(*){animation-duration:var(--onestep-vt-ms,220ms);animation-timing-function:var(--onestep-ease-morph,cubic-bezier(0.22,1,0.36,1))}',
    // 旧快照快速淡出（避免被 group 拉伸的旧缩略图长时间盖住相邻窗口 → 闪/重影）
    '::view-transition-old(*){animation-duration:var(--onestep-vt-old-fade,60ms);animation-timing-function:ease-out}',
    // 新快照稍晚淡入
    '::view-transition-new(*){animation-duration:var(--onestep-vt-fade,120ms);animation-delay:var(--onestep-vt-delay,40ms);animation-timing-function:ease-out}',
    // 整页不做交叉淡化：旧 root 立即隐藏、新 root 立即可见（非命名区域直接切换，避免全页重影）
    '::view-transition-old(root){animation:none;opacity:0}',
    '::view-transition-new(root){animation:none;opacity:1}',
    '@media (prefers-reduced-motion:reduce){::view-transition-group(*),::view-transition-old(*),::view-transition-new(*){animation-duration:.001ms !important}}',
  ].join('\n')
}

/** 一个宏任务（VT 更新回调内渲染被暂停，禁止在那里等 rAF）。 */
export function nextTask(win) {
  const target = win || (typeof window !== 'undefined' ? window : null)
  return new Promise((resolve) => {
    if (target && typeof target.setTimeout === 'function') target.setTimeout(resolve, 0)
    else setTimeout(resolve, 0)
  })
}

/**
 * 用宏任务轮询等待谓词成立（上限 timeoutMs；返回是否成立，不抛错）。
 * 用于等待官方 openSession / React 提交完成后再让 VT 捕获新画面。
 */
export async function waitForApplied(predicate, options = {}) {
  const timeoutMs = options.timeoutMs === undefined ? 150 : options.timeoutMs
  const intervalMs = options.intervalMs === undefined ? 0 : options.intervalMs
  const win = options.win
  const started = Date.now()
  for (;;) {
    let value = false
    try {
      value = await predicate()
    } catch (_error) {
      value = false
    }
    if (value) return true
    if (Date.now() - started > timeoutMs) return false
    if (intervalMs > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs))
    else await nextTask(win)
  }
}

/**
 * 创建动效控制器。
 *
 * @param {object} [options]
 * @param {object} [options.doc] document 注入（测试用）
 * @param {object} [options.win] window 注入（测试用）
 * @param {() => string} [options.getSetting] 返回 store.reducedMotion（system/always/never）
 * @param {(event:string, data?:object|null) => void} [options.log]
 * @returns {object} 控制器
 */
export function createMotionController(options = {}) {
  const doc = options.doc || (typeof document !== 'undefined' ? document : null)
  const win = options.win || (typeof window !== 'undefined' ? window : null)
  const getSetting = typeof options.getSetting === 'function' ? options.getSetting : () => 'system'
  const log = typeof options.log === 'function' ? options.log : () => {}
  let active = null
  // activeState：pending = VT 已启动、更新回调尚未执行；running = 回调执行中；done = 回调已完成、动画仍在播。
  let activeState = 'idle'
  // 同帧连续动作的更新队列：在 VT 回调内按调用顺序执行，避免「跳过并立即应用」导致的状态顺序颠倒。
  const pending = []
  let last = { kind: null, route: null, status: null, durationMs: null, at: null }

  const reduced = () => isReduced(getSetting, win)
  const supported = () => !!(doc && typeof doc.startViewTransition === 'function')

  const setRootVars = (kind) => {
    const spec = MOTION_KINDS[kind] || MOTION_KINDS.promote
    const root = doc && doc.documentElement
    const style = root && root.style
    if (!style || typeof style.setProperty !== 'function') return () => {}
    style.setProperty('--onestep-vt-ms', spec.groupMs + 'ms')
    style.setProperty('--onestep-vt-old-fade', spec.oldFadeMs + 'ms')
    style.setProperty('--onestep-vt-fade', spec.fadeMs + 'ms')
    style.setProperty('--onestep-vt-delay', spec.delayMs + 'ms')
    return () => {
      try {
        style.removeProperty('--onestep-vt-ms')
        style.removeProperty('--onestep-vt-old-fade')
        style.removeProperty('--onestep-vt-fade')
        style.removeProperty('--onestep-vt-delay')
      } catch (_error) {
        /* 清理失败不阻塞 */
      }
    }
  }

  const record = (kind, route, status, durationMs) => {
    last = { kind, route, status, durationMs: durationMs === undefined ? null : durationMs, at: Date.now() }
    log('motion.' + kind + '.' + route, { status, durationMs: last.durationMs })
  }

  const drainPending = async () => {
    while (pending.length > 0) {
      const next = pending.shift()
      try {
        await next()
      } catch (error) {
        log('motion.pending.error', { error: String((error && error.message) || error).slice(0, 160) })
      }
    }
  }

  /**
   * 包裹一次舞台几何更新。返回 'vt' | 'queued' | 'instant' | 'skipped' | 'fallback'。
   *
   * 关键约束（2026-11-13 探针实测）：
   * - startViewTransition 之后同步改 DOM 会被并入「旧快照」（旧=新 → 看起来没动画），
   *   所以真实 DOM 更新必须在更新回调里执行；
   * - 同帧连续动作（如连续 addCandidate）在回调内按调用顺序排队执行（'queued'），
   *   不能「跳过并立即应用」，否则状态顺序颠倒；
   * - 回调已执行完但动画仍在播时，新动作 skipTransition + 立即应用（'skipped'）。
   *
   * @param {() => (void|Promise<void>)} update 状态更新（含等待提交）
   * @param {{kind?: string}} [opts]
   */
  async function run(update, opts = {}) {
    const kind = opts.kind || 'promote'
    if (reduced() || !supported()) {
      const started = Date.now()
      await update()
      record(kind, 'instant', reduced() ? 'reduced' : 'unsupported', Date.now() - started)
      return 'instant'
    }
    if (active && (activeState === 'pending' || activeState === 'running')) {
      pending.push(update)
      record(kind, 'queued', 'busy-pending', null)
      return 'queued'
    }
    if (active) {
      try {
        active.skipTransition()
      } catch (_error) {
        /* 跳过失败不阻塞 */
      }
      const started = Date.now()
      await update()
      record(kind, 'skipped', 'busy', Date.now() - started)
      return 'skipped'
    }
    const clearVars = setRootVars(kind)
    const started = Date.now()
    let vt = null
    let callbackRan = false
    // P4.2：方向性快照交叉覆盖（提升/降级窗口分别调时），避免拉伸的候场缩略图盖住邻窗。
    let cleanupDirection = null
    if (opts.direction) {
      try {
        const style = doc.createElement('style')
        style.setAttribute('data-onestep-vt-direction', '1')
        style.textContent = viewTransitionDirectionCss(opts.direction)
        doc.head.appendChild(style)
        cleanupDirection = () => {
          try {
            style.remove()
          } catch (_error) {
            /* ignore */
          }
        }
      } catch (error) {
        cleanupDirection = null
        log('motion.direction.error', { error: String((error && error.message) || error) })
      }
    }
    // Q2 决议（P4-1 实测）：morph 前给可见官方浮窗/收起标签临时命名，避免被窗口快照覆盖；结束还原。
    let cleanupDecor = null
    if (typeof opts.decorate === 'function') {
      try {
        cleanupDecor = opts.decorate()
      } catch (error) {
        cleanupDecor = null
        log('motion.decorate.error', { error: String((error && error.message) || error) })
      }
    }
    try {
      vt = doc.startViewTransition(async () => {
        callbackRan = true
        activeState = 'running'
        try {
          await update()
          await drainPending()
        } finally {
          activeState = 'done'
        }
      })
    } catch (error) {
      clearVars()
      if (cleanupDirection) {
        cleanupDirection()
        cleanupDirection = null
      }
      if (cleanupDecor) {
        try {
          cleanupDecor()
        } catch (_error) {
          /* ignore */
        }
        cleanupDecor = null
      }
      await update()
      await drainPending()
      record(kind, 'fallback', 'start-threw', Date.now() - started)
      return 'fallback'
    }
    active = vt
    activeState = 'pending'
    const finish = () => {
      if (active === vt) {
        active = null
        activeState = 'idle'
      }
      clearVars()
      if (cleanupDirection) {
        cleanupDirection()
        cleanupDirection = null
      }
      if (cleanupDecor) {
        try {
          cleanupDecor()
        } catch (error) {
          log('motion.decorate.cleanup.error', { error: String((error && error.message) || error) })
        }
        cleanupDecor = null
      }
      // 异常中止时兜底：基础更新与队列里的更新都不能丢，按序补齐。
      if (!callbackRan) {
        void (async () => {
          try {
            await update()
          } catch (error) {
            log('motion.base.error', { error: String((error && error.message) || error).slice(0, 160) })
          }
          await drainPending()
        })()
      } else if (pending.length > 0) {
        void drainPending()
      }
      if (last.route === 'vt' && last.kind === kind) last.durationMs = Date.now() - started
    }
    if (vt && vt.ready) {
      Promise.resolve(vt.ready)
        .then(() => {
          if (typeof opts.onReady !== 'function') return
          try {
            opts.onReady()
          } catch (error) {
            log('motion.onready.error', { error: String((error && error.message) || error).slice(0, 160) })
          }
        })
        .catch(() => {})
    }
    Promise.resolve(vt.finished)
      .then(() => record(kind, 'vt', 'finished', Date.now() - started))
      .catch((error) => record(kind, 'fallback', 'aborted:' + String((error && error.message) || error).slice(0, 120), Date.now() - started))
      .finally(finish)
    record(kind, 'vt', 'started', null)
    return 'vt'
  }

  return {
    run,
    isReduced: reduced,
    supported,
    snapshot: () => ({ supported: supported(), reduced: reduced(), active: !!active, activeState, pending: pending.length, last: { ...last } }),
    /** 跳过当前过渡（测试/紧急清理用）。 */
    skip() {
      if (!active) return false
      try {
        active.skipTransition()
      } catch (_error) {
        return false
      }
      return true
    },
    /** 等待当前过渡结束（无过渡时立即 resolve）。 */
    settled() {
      if (!active) return Promise.resolve()
      return Promise.resolve(active.finished).catch(() => {})
    },
  }
}
