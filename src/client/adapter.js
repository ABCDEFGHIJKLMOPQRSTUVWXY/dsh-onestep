/**
 * DSH 0.2.2-rc.1 契约隔离层（adapter）。
 *
 * 规则（开发文档 §3.2）：插槽名、服务名、数据字段名、Factory 参数只允许出现在这里；
 * 升级 rc 时先改本文件并跑兼容冒烟。其余模块只引用本文件的常量与纯函数。
 */

/** 插槽名（0.2.2-rc.1 实测，见 docs/p0/client-contracts.md）。 */
export const SLOTS = {
  /** 舞台接管点：main keyed 'conversation'（root 作用域）。 */
  main: 'main',
  mainKey: 'conversation',
  /** 自声明子槽：会话窗口（single/session）与主绑定桥（single/session-maybe）。 */
  window: 'onestep.window',
  focus: 'onestep.focus',
  /** 官方扩展点。 */
  headerActions: 'conversation.session.header.actions',
  rowAction: 'sidebar.workspaces.session.row.action',
  overlay: 'shell.overlay',
}

/** 可选服务名（用 ctx.get 惰性获取；不在 inject 里声明）。 */
export const SERVICES = {
  sessions: 'sessions',
  uiWorkspace: 'uiWorkspace',
  sidebarRight: 'sidebarRight',
  /** 官方 tab 类型注册表（能力探测用，ui-sidebar-right 提供）。 */
  sidebarRightTabs: 'sidebarRightTabs',
  layout: 'layout',
  locale: 'locale',
  shortcuts: 'shortcuts',
  theme: 'theme',
}

/**
 * P3 伴生浮窗契约（DSH 0.2.2-rc.1 实测，见 docs/p3/contracts.md §4/§3.3）。
 * 只在这里声明 DOM 选择器/属性/持久化键；其它模块只引用本常量，rc 升级先改这里。
 */
export const COMPANION = {
  /** 插件自有伴生窗状态键（与舞台 dsh.onestep.v1 分开，避免迁移面）。 */
  storageKey: 'dsh.onestep.companion.v1',
  stateVersion: 1,
  /** 官方持久化键前缀（只读观测/对账用，插件不写）。 */
  officialStoragePrefix: 'dsh.sidebar-right.v1',
  selectors: {
    stage: '[data-onestep-stage]',
    /** 右栏 panel（push/fullscreen）；collapsed 时不存在 data-sidebar-right-open。 */
    panel: '[data-sidebar-right-panel]',
    session: '[data-sidebar-right-session]',
    /** 浮窗（产品路径由 TabLayout 渲染）：paneId 在 data-dockkit-float，tabId 在 data-dockkit-content。 */
    float: '[data-dockkit-float]',
    floatTitle: '[data-dockkit-float-title]',
    floatGrip: '[data-dockkit-float-grip]',
    floatDock: '[data-dockkit-float-dock]',
    floatClose: '[data-dockkit-float-close]',
    floatResize: '[data-dockkit-float-resize]',
    tab: '[data-sidebar-right-tab]',
    /** 官方菜单/浮层（点击外部判定要排除）。 */
    menuMaterial: '[data-menu-material]',
    menu: '[role="menu"]',
  },
  attrs: {
    float: 'data-dockkit-float',
    floatActive: 'data-dockkit-float-active',
    content: 'data-dockkit-content',
    panelOpen: 'data-sidebar-right-open',
    panelOpening: 'data-sidebar-right-opening',
    session: 'data-sidebar-right-session',
    /** P3 注入的收起标记与属性。 */
    peek: 'data-onestep-peek',
    peekAriaHidden: 'aria-hidden',
    /** 0.7.0：浮窗边缘缩放把手（值 = 方向 n/s/e/w/ne/nw/se/sw）。 */
    resizeGrip: 'data-onestep-float-resize',
    /** 0.7.0：浮窗缩放进行中标记（仅插件样式/探针使用，不改官方状态）。 */
    resizing: 'data-onestep-resizing',
  },
  /** 层序（P3-1 实测：浮窗层 60、标签层计划 62–66、官方菜单运行时共享 surface ≈1100）。 */
  layers: { float: 60, tag: 63, menuFallback: 1000 },
  defaults: {
    gap: 8,
    slotRatio: 0.3,
    slotMinWidth: 340,
    slotMaxWidth: 480,
    maxSlots: 3,
    inset: 16,
    /** 收起位移附加值：`translateX(calc(100vw + peekOffset))`，保证任意槽位都移出右缘。 */
    peekOffset: 24,
    peekTransition: '180ms',
    /** 收起状态不跨刷新（Q11）。 */
    persistPeek: false,
    /** 单会话最多记录的浮窗元数据条数（防御坏存储）。 */
    maxTracked: 8,
    /** 0.7.0：浮窗最小尺寸（官方 FLOAT_MIN_SIZE）。 */
    floatMinWidth: 220,
    floatMinHeight: 140,
    /** 0.7.0：桌面标题栏下沿留白（官方 floatBounds：caption + 20）。 */
    floatCaptionFloor: 20,
    /** 0.7.0：收起标签拖动松手吸附阈值（px）。 */
    peekSnap: 10,
  },
}

/** Client 引导面（探针/诊断用，见 P2 compat 冒烟）。 */
export const BOOT = {
  entryId: 'dsh-onestep',
}

/** 插件声明 required inject：这三个服务缺失时插件不应激活。 */
export const INJECT = ['slots', 'locale', 'shortcuts']

/** 持久化键与版本。 */
export const STORAGE_KEY = 'dsh.onestep.v1'
/**
 * 状态版本：
 * - v2：候场卡默认精简卡（修 composer 覆盖）；
 * - v3：候场卡默认「实时缩略画面」（官方聊天体按比例缩放渲染，隐藏输入区），保持 √2:1 卡片比例。
 * loadPersisted 会把 v1/v2 迁移到 v3（保留 roster/布局）。
 */
export const STATE_VERSION = 3
export const PROBE_FLAG_KEY = 'dsh.onestep.probe'

/** 约束与默认值（开发文档 §5.1 / §5.4）。 */
export const LIMITS = {
  maxCandidates: 12,
  /** 0.5.0：候场上限 3→6（用户要求解除 3 个限制）；实时缩略仅建议 ≤3，4+ 由自动精简/用户档位控制。 */
  railLeft: { default: 232, min: 200, max: 320 },
  railTop: { default: 132, min: 108, max: 220 },
  focusMinWidth: 480,
  focusMinHeight: 320,
  cardMinWidth: 200,
  cardMinHeight: 108,
  /** 左侧候场卡固定高度（设计稿 01-left-rail / 产品报告 §7.4：232×148）。 */
  cardHeight: 148,
  /** 只有 1~2 张候场卡时拉伸到的高度（产品报告 §7.4：2 窗时 232×220）。 */
  cardHeightStretch: 220,
  /** 顶部候场卡高度（产品报告 §7.4：高 108）。 */
  cardHeightTop: 108,
  /** 候场卡固定宽高比：√2:1（用户规格；卡内为实时缩略画面）。 */
  cardAspect: Math.SQRT2,
  /** 左侧/顶部候场栏与焦点窗之间的可拖拽分隔条尺寸（px）。 */
  splitterSize: 8,
  /** 官方左栏与候场栏之间的分隔（产品报告 §7.4：8px）。 */
  railInset: 8,
  /** 焦点窗右下角关闭控制点触发角尺寸（产品报告 §7.7）。 */
  focusCloseCorner: 88,
  gap: 12,
  stageMinWidth: 760,
  railTopBreakpoint: 1080,
  undoWindowMs: 5000,
}

/** 窗口标题/状态的数据字段（来自 useSessions / useSessionStatus）。 */
export const SESSION_FIELDS = {
  title: (row) => (row && (row.displayTitle || row.title)) || '',
  blank: (row) => !!(row && row.blank),
  updatedAt: (row) => (row && row.updatedAt) || 0,
  unread: (status) => !!(status && status.completionUnread),
  running: (status) => !!(status && status.running),
  pendingKind: (status) => (status && status.pendingInteraction ? status.pendingInteraction.kind : null),
}

/** Factory 参数（conversation.content）。 */
export const CONTENT_FACTORY = {
  name: 'conversation.content',
  variant: 'embedded',
}

/**
 * 能力探测：缺关键插槽时返回 {ok:false, missing}，插件应自动退普通模式。
 * 注意：`sessions` / `uiWorkspace` 等可选服务在本插件 apply 时可能尚未激活（Cordis 激活顺序），
 * 因此不在启动时硬性拦截，而是懒获取并在使用点降级；这里只记录快照供探针/诊断。
 * @param {object} ctx client cordis context（apply 参数）。
 * @returns {{ok:boolean, missing:string[], services:Record<string,boolean>}}
 */
export function detectCapabilities(ctx) {
  const missing = []
  const services = {}
  let slots = null
  try {
    slots = ctx.slots
  } catch (_error) {
    slots = null
  }
  if (!slots || typeof slots.register !== 'function' || typeof slots.inject !== 'function') missing.push('slots.register/inject')
  for (const name of ['sessions', 'uiWorkspace', 'sidebarRight']) {
    let service
    try {
      service = ctx.get(name)
    } catch (_error) {
      service = undefined
    }
    services[name] = !!service
  }
  return { ok: missing.length === 0, missing, services }
}

/** 读取 client 侧 sessions 服务的 byId 快照（防御式：服务/字段漂移时返回空对象）。 */
export function sessionsById(sessions) {
  if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') return {}
  const snapshot = sessions.list.getSnapshot()
  return (snapshot && snapshot.byId) || {}
}

/**
 * 读取 useSessionStatus 的会话状态。
 * 0.2.2-rc.1 的 `useSessionStatus` 状态是 **Map<SessionId, SessionStatus>**（不是普通对象），
 * 必须走 `.get(sessionId)`；这里同时兼容 Map 与对象两种形态，防 rc 漂移。
 * @param {Map<string, object>|Record<string, object>|null|undefined} statuses
 * @param {string|null|undefined} sessionId
 * @returns {object|undefined}
 */
export function statusOf(statuses, sessionId) {
  if (!statuses || !sessionId) return undefined
  try {
    if (typeof statuses.get === 'function') return statuses.get(sessionId) || undefined
  } catch (_error) {
    /* ignore */
  }
  return statuses[sessionId] || undefined
}

/**
 * 把 useSessionStatus 状态转成可序列化快照（探针/调试用；Map → 普通对象）。
 * @param {Map<string, object>|Record<string, object>|null|undefined} statuses
 * @returns {Record<string, object>}
 */
export function statusesSnapshot(statuses) {
  if (!statuses) return {}
  try {
    if (typeof statuses.forEach === 'function' && typeof statuses.get === 'function') {
      const out = {}
      statuses.forEach((value, key) => {
        out[key] = value
      })
      return out
    }
  } catch (_error) {
    /* ignore */
  }
  return { ...statuses }
}
