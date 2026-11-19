/**
 * 布局求解（纯函数，可单测；开发文档 §5.2）。
 *
 * 输入容器尺寸与舞台参数，输出焦点窗/候场卡/候场栏矩形与降级标记。
 * 该模块不依赖 React / DOM / DSH，只做几何计算。
 */
import { LIMITS } from './adapter.js'

/**
 * @typedef {{x:number,y:number,w:number,h:number}} Rect
 * @typedef {{
 *   width:number,height:number,railSide:'left'|'top',railSize:number,railCollapsed:boolean,
 *   count:number,min?:{focusW:number,focusH:number,cardW:number,cardH:number,gap:number,stageW:number}
 * }} SolveInput
 * @typedef {{
 *   focus:Rect,cards:Rect[],rail:Rect|null,scroll:boolean,
 *   degraded:'none'|'rail-collapsed'|'single',railSize:number,visibleCount:number
 * }} SolveOutput
 */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

/**
 * 求解舞台布局。
 * @param {SolveInput} input 容器与参数
 * @returns {SolveOutput} 布局结果
 */
export function solve(input) {
  const width = Math.max(0, Number(input.width) || 0)
  const height = Math.max(0, Number(input.height) || 0)
  const railSide = input.railSide === 'top' ? 'top' : 'left'
  const count = clamp(Math.floor(Number(input.count) || 0), 0, LIMITS.maxCandidates)
  const gap = (input.min && input.min.gap) || LIMITS.gap
  const focusMinW = (input.min && input.min.focusW) || LIMITS.focusMinWidth
  const focusMinH = (input.min && input.min.focusH) || LIMITS.focusMinHeight
  const cardMinW = (input.min && input.min.cardW) || LIMITS.cardMinWidth
  const cardMinH = (input.min && input.min.cardH) || LIMITS.cardMinHeight
  /**
   * 舞台最小宽度。默认 stageMinWidth；伴生窗展开挤压主区时由调用方下探到 focusMinWidth
   * （几何策略：右栏 push 不强制退出舞台，改为单窗显示 + 隐藏候场栏）。
   */
  const stageMinW = (input.min && input.min.stageW) || LIMITS.stageMinWidth
  const railBounds = railSide === 'left' ? LIMITS.railLeft : LIMITS.railTop
  const railSize = clamp(Number(input.railSize) || railBounds.default, railBounds.min, railBounds.max)

  const empty = () => ({ focus: { x: 0, y: 0, w: width, h: height }, cards: [], rail: null, scroll: false, degraded: 'none', railSize, visibleCount: 0, contentW: width, contentH: height })

  // 容器不足：单窗降级（舞台应退出）
  if (width < stageMinW || height < focusMinH) return empty()

  const collapsed = !!input.railCollapsed || count === 0
  if (collapsed) {
    return {
      focus: { x: 0, y: 0, w: width, h: height },
      cards: [],
      rail: count === 0 ? null : railSide === 'left' ? { x: 0, y: 0, w: 40, h: height } : { x: 0, y: 0, w: width, h: 40 },
      scroll: false,
      degraded: 'rail-collapsed',
      railSize,
      visibleCount: 0,
      contentW: width,
      contentH: height,
    }
  }

  if (railSide === 'left') {
    let railW = railSize
    let degraded = 'none'
    const railInset = LIMITS.railInset
    // 先收窄候场栏，再判单窗（焦点窗宽度要扣除 8px 分隔）
    if (width - railInset - railW - gap < focusMinW) {
      railW = clamp(width - focusMinW - gap - railInset, cardMinW + 8, railSize)
      degraded = railW < railSize ? 'rail-collapsed' : 'none'
    }
    if (width - railInset - railW - gap < focusMinW || railW < cardMinW) return empty()
    const focus = { x: railInset + railW + gap, y: 0, w: width - railInset - railW - gap, h: height }
    // 候场卡固定 √2:1（宽度随候场栏宽，高度 = 宽度/√2）；高度不足时等比缩小，不拉伸变形。
    const aspect = LIMITS.cardAspect
    let cardW = railW
    let cardH = cardW / aspect
    const availableH = height - gap * (count - 1)
    let scroll = false
    if (cardH * count + gap * (count - 1) > height) {
      cardH = Math.max(1, availableH / count)
      cardW = Math.min(railW, cardH * aspect)
      scroll = cardW < cardMinW || cardH < cardMinH
    }
    let cardX = Math.max(0, (railW - cardW) / 2)
    let cards = []
    for (let i = 0; i < count; i += 1) {
      cards.push({ x: cardX, y: i * (cardH + gap), w: cardW, h: cardH })
    }
    let contentW = railW
    let contentH = height
    // 0.6.0：候场 >3 且压缩后低于设计最小尺寸 → 固定可读尺寸 + 纵向滚动（不接受更小的卡）。
    if (count > 3 && scroll) {
      const fixedW = railW
      const fixedH = fixedW / aspect
      const totalH = fixedH * count + gap * (count - 1)
      cardX = 0
      cards = []
      for (let i = 0; i < count; i += 1) cards.push({ x: cardX, y: i * (fixedH + gap), w: fixedW, h: fixedH })
      contentW = railW
      contentH = totalH
      scroll = totalH > height
    }
    return { focus, cards, rail: { x: railInset, y: 0, w: railW, h: height }, scroll, degraded, railSize: railW, visibleCount: count, contentW, contentH }
  }

  // 顶部候场栏：卡高 ≤ railH，宽 = 高×√2，水平居中排布
  let railH = railSize
  if (height - railH - gap < focusMinH) {
    railH = clamp(height - focusMinH - gap, cardMinH + 8, railSize)
  }
  if (height - railH - gap < focusMinH || railH < cardMinH) return empty()
  const aspect = LIMITS.cardAspect
  let cardH = Math.min(railH, LIMITS.cardHeightTop)
  let cardW = cardH * aspect
  const totalCardW = cardW * count + gap * (count - 1)
  if (totalCardW > width) {
    cardW = Math.max(1, (width - gap * (count - 1)) / count)
    cardH = cardW / aspect
  }
  let startX = Math.max(0, (width - (cardW * count + gap * (count - 1))) / 2)
  let scroll = cardW < cardMinW || cardH < cardMinH
  const focus = { x: 0, y: railH + gap, w: width, h: height - railH - gap }
  let cards = []
  for (let i = 0; i < count; i += 1) {
    cards.push({ x: startX + i * (cardW + gap), y: 0, w: cardW, h: cardH })
  }
  let contentW = width
  let contentH = railH
  // 0.6.0：候场 >3 且压缩后低于设计最小尺寸 → 固定可读尺寸 + 横向滚动。
  if (count > 3 && scroll) {
    const fixedH = Math.min(railH, LIMITS.cardHeightTop)
    const fixedW = fixedH * aspect
    const totalW = fixedW * count + gap * (count - 1)
    startX = 0
    cards = []
    for (let i = 0; i < count; i += 1) cards.push({ x: i * (fixedW + gap), y: 0, w: fixedW, h: fixedH })
    contentW = totalW
    contentH = railH
    scroll = totalW > width
  }
  return { focus, cards, rail: { x: 0, y: 0, w: width, h: railH }, scroll, degraded: 'none', railSize: railH, visibleCount: count, contentW, contentH }
}

/** 左/顶部断点建议（开发文档 §5.3）：宽屏左侧、中宽顶部、过窄退出。 */
export function preferredRailSide(width) {
  if (width >= LIMITS.railTopBreakpoint) return 'left'
  if (width >= LIMITS.stageMinWidth) return 'top'
  return null
}

/**
 * 布局是否可接受（StageRoot 的「窗口过窄 → 退出舞台」判定；纯函数，单测覆盖折叠态）。
 *
 * 关键：用户手动收起候场栏（railCollapsed=true）时 solve() 返回 degraded='rail-collapsed'
 * 且 visibleCount=0（候场卡不渲染），这不是 `single` 降级，不能触发 onNarrow。
 * 折叠态只要求候场栏边条仍存在（容器宽度足以保留焦点窗）；其余档位要求候场卡全部可见。
 * @param {SolveOutput|null|undefined} layout solve() 结果
 * @param {{count?:number, collapsed?:boolean}} [options] 舞台参数（折叠态来自 store.railCollapsed）
 * @returns {boolean} 布局可用（false → 舞台应退出单会话）
 */
export function layoutUsable(layout, options = {}) {
  if (!layout) return false
  const count = clamp(Math.floor(Number(options.count) || 0), 0, LIMITS.maxCandidates)
  if (count === 0) return true
  if (options.collapsed) return layout.degraded === 'rail-collapsed' && !!layout.rail
  return layout.visibleCount === count
}
