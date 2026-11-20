/**
 * 已打开浮窗的「再次点击」高亮（0.7.0 用户反馈）。
 *
 * 场景：点击链接命中的伴生浮窗已经展开可见时，不再执行展开/恢复动作；改为
 * 高亮闪烁两下（CSS 动画，[data-onestep-float-flash]）并把层级提到最上层
 * （后者由包装层随后调用的官方 focus 完成——官方 focusTab 对浮窗会 raise）。
 *
 * 本模块只负责「闪烁标记」的生命周期：设置属性 → 计时移除 → 重复点击重新起播；
 * 不碰官方状态、不触碰布局；CSS 负责动画外观与 reduced-motion 降级（静态高亮一次）。
 */
import { COMPANION } from './adapter.js'

/** 闪烁标记属性。 */
export const FLASH_ATTR = COMPANION.attrs.floatFlash
/** 闪烁次数（「两下」）。 */
export const FLASH_PULSES = COMPANION.defaults.floatFlashPulses
/** 单次闪烁时长（CSS 动画与计时器共用同一节奏）。 */
export const FLASH_PULSE_MS = COMPANION.defaults.floatFlashPulseMs
/** 标记保留时长：动画总长 + 一小段缓冲（动画结束后再移除属性）。 */
export const FLASH_DURATION = FLASH_PULSES * FLASH_PULSE_MS + 160

/**
 * 创建闪烁控制器（每个插件实例一个；计时器按元素隔离）。
 *
 * @param {{setTimeout?:Function, clearTimeout?:Function, duration?:number}} [deps] 测试可注入计时器
 * @returns {{flash:(element:Element)=>boolean, isFlashing:(element:Element)=>boolean, dispose:()=>void}}
 */
export function createFloatFlash(deps = {}) {
  const setTimer = typeof deps.setTimeout === 'function' ? deps.setTimeout : (fn, ms) => setTimeout(fn, ms)
  const clearTimer = typeof deps.clearTimeout === 'function' ? deps.clearTimeout : (timer) => clearTimeout(timer)
  const duration = Number.isFinite(deps.duration) && deps.duration > 0 ? deps.duration : FLASH_DURATION
  const timers = new Map()
  let disposed = false

  const stop = (element) => {
    const timer = timers.get(element)
    if (timer === undefined) return
    clearTimer(timer)
    timers.delete(element)
  }

  const flash = (element) => {
    if (disposed) return false
    if (!element || typeof element.setAttribute !== 'function' || typeof element.removeAttribute !== 'function') return false
    stop(element)
    try {
      // 先移除再强制一次样式计算：重复点击时动画从头起播（而不是被浏览器合并）。
      element.removeAttribute(FLASH_ATTR)
      if (typeof element.getBoundingClientRect === 'function') element.getBoundingClientRect()
      element.setAttribute(FLASH_ATTR, '1')
    } catch (_error) {
      return false
    }
    const timer = setTimer(() => {
      timers.delete(element)
      try {
        element.removeAttribute(FLASH_ATTR)
      } catch (_error) {
        /* 元素可能已被官方卸载 */
      }
    }, duration)
    timers.set(element, timer)
    return true
  }

  const isFlashing = (element) => timers.has(element)

  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const element of Array.from(timers.keys())) {
      stop(element)
      try {
        element.removeAttribute(FLASH_ATTR)
      } catch (_error) {
        /* ignore */
      }
    }
  }

  return { flash, isFlashing, dispose }
}
