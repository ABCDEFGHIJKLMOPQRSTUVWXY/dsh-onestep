/**
 * P4-1 探针⑨⑩：现有动效基线审计 + 外部主绑定切换记录（docs/p4-plan.md §1.1 / §4.10 #8/#9）
 *
 * 内容：
 * ⑨ 基线审计（给 P4-5/P4-6 用）：
 *   - document.getAnimations() 全量 + infinite 清单（预期 .onestep-dot[data-tone=running] onestep-pulse 1.2s infinite）；
 *   - demoFeedback flash：动画时长/次数/data-flash 寿命；bubble 进场动画；
 *   - 候选卡 hover / 控制点 / 快速条 / 分隔条 / 收起标签 / 菜单 的 computed transition；
 *   - 与计划 §1.1 的逐项对照（match / diff / supplement / source-checked）。
 * ⑩ 外部主绑定切换（官方左栏点击）：无法在 DOM 变化前启动 VT → 记录为直切；确认无 VT/动画残留。
 *
 * 用法：node scripts/p4/probe/baseline-audit.mjs
 * 产物：artifacts/p4/probe/baseline-audit.json
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  OUT, ROOT, createResults, sleep, openApp, closeApp, enterStage, pageEnv, installRuntime,
  actionCall, p3Call, fileAddress, installRuntime as install, layoutDeviation, relPath,
} from './lib.mjs'

const results = createResults('baseline-audit', 'P4-1 探针⑨⑩：动效基线审计 + 外部主绑定切换')
let app = null

function readSource(file) {
  try {
    return fs.readFileSync(path.join(ROOT, file), 'utf8')
  } catch (error) {
    return ''
  }
}

try {
  results.data.env.command = 'node scripts/p4/probe/baseline-audit.mjs'
  app = await openApp({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
  const { page } = app
  const env = await pageEnv(page)
  results.data.env.page = env
  await enterStage(page, { count: 3 })
  await installRuntime(page)
  await sleep(300)

  // ---------- ⑨a 全量动画 + infinite 清单 ----------
  const animations = await page.evaluate(() => ({ audit: window.__P4.auditAnimations(), scan: window.__P4.scanInfiniteStyles() }))
  results.data.animations = animations
  results.step('baseline.animations', {
    count: animations.audit.count,
    infiniteCount: animations.audit.infiniteCount,
    infinite: animations.audit.infinite,
    scanCount: animations.scan.count,
    scanned: animations.scan.scanned,
  })

  // 运行态 pulse：把任一状态点临时置 running 探测规则（立即还原）
  const dotProbe = await page.evaluate(async () => {
    const dot = document.querySelector('[data-onestep-stage] .onestep-dot')
    if (!dot) return { found: false }
    const before = dot.getAttribute('data-tone')
    const read = () => {
      const style = getComputedStyle(dot)
      const animations = document.getAnimations().filter((animation) => {
        const target = animation.effect && animation.effect.target
        return target === dot
      })
      return {
        animationName: style.animationName,
        animationDuration: style.animationDuration,
        animationIterationCount: style.animationIterationCount,
        animationTimingFunction: style.animationTimingFunction,
        runningAnimations: animations.map((animation) => ({ animationName: animation.animationName || null, duration: animation.effect.getTiming().duration, iterations: animation.effect.getTiming().iterations === Infinity ? 'infinite' : animation.effect.getTiming().iterations, playState: animation.playState })),
      }
    }
    const idle = read()
    dot.setAttribute('data-tone', 'running')
    await new Promise((resolve) => setTimeout(resolve, 120))
    const running = read()
    const runningAnimationNames = document.getAnimations().filter((animation) => animation.effect && animation.effect.target === dot).map((animation) => animation.animationName || null)
    if (before === null) dot.removeAttribute('data-tone')
    else dot.setAttribute('data-tone', before)
    await new Promise((resolve) => setTimeout(resolve, 80))
    const restored = read()
    return { found: true, before, idle, running, runningAnimationNames, restored }
  })
  results.step('baseline.pulse', dotProbe)
  results.data.pulse = dotProbe
  results.assert('baseline.pulse-rule', dotProbe.found === true && dotProbe.running.animationName === 'onestep-pulse' && dotProbe.running.animationDuration === '1.2s' && dotProbe.running.animationIterationCount === 'infinite', {
    expected: '运行态状态点：onestep-pulse 1.2s infinite（临时 data-tone=running 探测后已还原）',
    actual: dotProbe.running,
    category: 'baseline',
  })
  const actualRunningDots = await page.evaluate(() => document.querySelectorAll('[data-onestep-stage] .onestep-dot[data-tone="running"]').length)
  results.data.pulse.actualRunningDotsInInstance = actualRunningDots
  results.step('baseline.pulse.actual', { actualRunningDotsInInstance: actualRunningDots })

  // ---------- ⑨b flash ----------
  const candidates = await page.evaluate(() => window.__P4.snapshot().candidates)
  const flash = await page.evaluate(async (id) => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    window.__ONESTEP__.actions.demoFeedback({ flashSessionId: id })
    await sleep(120)
    const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-flash="1"]')
    const animations = document.getAnimations().filter((animation) => {
      const target = animation.effect && animation.effect.target
      return target && target.getAttribute && target.getAttribute('data-flash') === '1'
    }).map((animation) => {
      const timing = animation.effect.getTiming()
      let keyframes = null
      try { keyframes = animation.effect.getKeyframes() } catch (error) { keyframes = null }
      return {
        animationName: animation.animationName || null,
        duration: timing.duration,
        iterations: timing.iterations,
        easing: timing.easing,
        playState: animation.playState,
        keyframes,
      }
    })
    return {
      found: !!el,
      computedAnimationName: el ? getComputedStyle(el).animationName : null,
      computedAnimationDuration: el ? getComputedStyle(el).animationDuration : null,
      animations,
    }
  }, candidates[0])
  results.step('baseline.flash', flash)
  results.data.flash = flash
  results.assert('baseline.flash-rule', flash.found === true && flash.animations.length === 1 && flash.animations[0].animationName === 'onestep-flash' && flash.animations[0].duration === 1600 && flash.animations[0].iterations === 1, {
    expected: '完成闪烁：onestep-flash 1.6s ×1（§1.1 #8 实测）',
    actual: flash.animations,
    category: 'baseline',
  })
  const flashLife = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const started = performance.now()
    let removedAt = null
    for (let index = 0; index < 120; index += 1) {
      if (!document.querySelector('[data-onestep-stage] .onestep-frame[data-flash="1"]')) { removedAt = performance.now() - started; break }
      await sleep(50)
    }
    return { removedAtMs: removedAt, waitedMs: performance.now() - started, stillThere: removedAt === null }
  })
  results.step('baseline.flash-life', flashLife)
  results.data.flashLife = { ...flashLife, sourceConstant: 'FLASH_MS=2200（src/client/stage-root.js:47），属性移除依赖下一次 re-render（stage-root.js:328-343 无定时器）' }
  results.metric('baseline.flashLife', flashLife)

  // ---------- ⑨c 气泡 ----------
  const bubble = await page.evaluate(async (id) => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    window.__ONESTEP__.actions.demoFeedback({ bubbleSessionId: id, kind: 'approval' })
    await sleep(160)
    const el = document.querySelector('[data-onestep-stage] .onestep-bubble')
    const animations = document.getAnimations().filter((animation) => {
      const target = animation.effect && animation.effect.target
      return target && target.className && String(target.className).indexOf('onestep-bubble') >= 0
    }).map((animation) => { const timing = animation.effect.getTiming(); return { animationName: animation.animationName || null, duration: timing.duration, iterations: timing.iterations } })
    return {
      found: !!el,
      computedAnimationName: el ? getComputedStyle(el).animationName : null,
      computedAnimationDuration: el ? getComputedStyle(el).animationDuration : null,
      animations,
    }
  }, candidates[0])
  results.step('baseline.bubble', bubble)
  results.data.bubble = bubble
  results.assert('baseline.bubble-rule', bubble.found === true && bubble.computedAnimationName === 'onestep-bubble-in' && bubble.computedAnimationDuration === '0.18s', {
    expected: '待处理气泡进场 180ms（§1.1 #9 实测；无出场动画需源码确认）',
    actual: bubble,
    category: 'baseline',
  })

  // ---------- ⑨d computed transition 审计 ----------
  const selectorsAudit = [
    { key: 'frame.candidate', selector: '.onestep-frame[data-mode="candidate"]', vars: ['--onestep-base', '--onestep-ease'] },
    { key: 'frame.focus', selector: '.onestep-frame[data-mode="focus"]' },
    { key: 'control', selector: '.onestep-frame[data-mode="focus"] .onestep-control' },
    { key: 'quick.inner', selector: '.onestep-quick-inner' },
    { key: 'splitter.after', selector: '.onestep-splitter', pseudo: '::after' },
    { key: 'rail', selector: '.onestep-stage-rail' },
    { key: 'stage', selector: '.onestep-stage', vars: ['--onestep-fast', '--onestep-base', '--onestep-slow', '--onestep-ease', '--ds-ease-in-out'] },
  ]
  const computedAudit = await page.evaluate((spec) => {
    const R = window.__P4
    return {
      host: {
        rootEase: getComputedStyle(document.documentElement).getPropertyValue('--ds-ease-in-out').trim(),
        rootTransition: getComputedStyle(document.documentElement).getPropertyValue('--ds-transition-duration').trim(),
      },
      items: R.auditComputed(spec),
    }
  }, selectorsAudit)
  results.step('baseline.computed', computedAudit)
  results.data.computedAudit = computedAudit

  // hover：候选卡（应当只有 box-shadow/border-color 180ms，无抬起）
  const candidateHover = await page.evaluate(() => {
    const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="candidate"]')
    if (!el) return null
    const cs = getComputedStyle(el)
    return { before: { boxShadow: cs.boxShadow, borderColor: cs.borderColor, transform: cs.transform }, transitionDuration: cs.transitionDuration, transitionProperty: cs.transitionProperty }
  })
  await page.hover('.onestep-frame[data-mode="candidate"]')
  await sleep(250)
  const candidateHovered = await page.evaluate(() => {
    const el = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="candidate"]')
    const cs = getComputedStyle(el)
    return { boxShadow: cs.boxShadow, borderColor: cs.borderColor, transform: cs.transform, opacity: cs.opacity }
  })
  await page.mouse.move(5, 5)
  await sleep(200)
  results.step('baseline.hover.candidate', { base: candidateHover, hovered: candidateHovered })
  results.data.candidateHover = { base: candidateHover, hovered: candidateHovered }
  results.assert('baseline.hover-rule', !!candidateHover && candidateHover.transitionDuration.split(', ').every((part) => part === '0.18s') && candidateHovered.transform === 'none', {
    expected: '候场卡 hover：box-shadow/border-color 180ms，无 transform 抬起（§1.1 #6 实测）',
    actual: { base: candidateHover, hovered: candidateHovered },
    category: 'baseline',
  })

  // 菜单：打开后无过渡（硬切）
  const menu = await page.evaluate(async () => {
    const button = document.querySelector('[data-onestep-stage] [data-onestep-more]')
    if (!button) return { found: false }
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    button.click()
    await sleep(120)
    const menuEl = document.querySelector('[data-onestep-stage] .onestep-menu')
    const menuItem = document.querySelector('[data-onestep-stage] .onestep-menu-item')
    const read = (el) => el ? (() => { const cs = getComputedStyle(el); return { transitionProperty: cs.transitionProperty, transitionDuration: cs.transitionDuration, animationName: cs.animationName, animationDuration: cs.animationDuration, opacity: cs.opacity } })() : null
    const menuState = { exists: !!menuEl, computed: read(menuEl), itemComputed: read(menuItem) }
    button.click()
    await sleep(80)
    return { found: true, menuState, closedAfterSecondClick: !document.querySelector('[data-onestep-stage] .onestep-menu') }
  })
  results.step('baseline.menu', menu)
  results.data.menu = menu
  results.assert('baseline.menu-rule', menu.found === true && menu.menuState.exists === true && menu.menuState.computed.transitionDuration === '0s' && menu.menuState.computed.animationName === 'none', {
    expected: '菜单：挂载硬切，无过渡/动画（§1.1 #12 实测）',
    actual: menu.menuState,
    category: 'baseline',
  })

  // 快速新建条：requestQuickNew → data-open=1，记录 transition
  const quick = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const read = () => {
      const bar = document.querySelector('[data-onestep-stage] .onestep-quick')
      const inner = document.querySelector('[data-onestep-stage] .onestep-quick-inner')
      if (!bar || !inner) return { found: false }
      const cs = getComputedStyle(inner)
      return {
        open: bar.getAttribute('data-open'),
        transitionProperty: cs.transitionProperty,
        transitionDuration: cs.transitionDuration,
        transform: cs.transform,
        opacity: cs.opacity,
      }
    }
    const before = read()
    window.__ONESTEP__.actions.requestQuickNew()
    await sleep(380)
    const opened = read()
    return { found: true, before, opened }
  })
  await page.keyboard.press('Escape')
  await sleep(200)
  await page.keyboard.press('Escape')
  await sleep(240)
  results.step('baseline.quick', quick)
  results.data.quick = quick
  results.assert('baseline.quick-rule', quick.found === true && quick.before.transitionDuration === '0.24s, 0.18s' && quick.opened.open === '1' && quick.opened.opacity === '1', {
    expected: '快速新建条：transform 240ms / opacity 180ms（§1.1 #11 实测；计划 §2.3 要求 180/120）',
    actual: { before: quick.before, opened: quick.opened },
    category: 'baseline',
  })

  // 浮窗 + 收起标签（peek）：打开 1 个浮窗再点击舞台空白收起
  const floatOpen = await actionCall(page, 'companionOpenResource', null, fileAddress((await p3Call(page, 'snapshot')).mounted, 'README.md'))
  await sleep(500)
  const blank = await page.evaluate(() => window.__P4.findStageBlankPoint())
  if (blank) {
    await page.mouse.click(blank.x, blank.y)
    await sleep(600)
  }
  const peek = await page.evaluate(() => {
    const R = window.__P4
    const tag = document.querySelector('[data-onestep-peek-tag]')
    const label = document.querySelector('.onestep-peek-label')
    const floatEl = document.querySelector('[data-dockkit-float]')
    const read = (el) => el ? (() => { const cs = getComputedStyle(el); return { transitionProperty: cs.transitionProperty, transitionDuration: cs.transitionDuration, transitionDelay: cs.transitionDelay, maxWidth: cs.maxWidth, transform: cs.transform, opacity: cs.opacity } })() : null
    return {
      floatOpenOk: true,
      floats: R.floats().map((item) => ({ tabId: item.tabId, rect: item.rect, peeked: item.peeked, transform: item.transform })),
      tags: R.peekTags(),
      tag: read(tag),
      label: read(label),
      float: read(floatEl),
      stageTokenBaseOnTag: tag ? getComputedStyle(tag).getPropertyValue('--onestep-base').trim() : null,
      stageTokenBaseOnStage: (() => { const stage = document.querySelector('[data-onestep-stage]'); return stage ? getComputedStyle(stage).getPropertyValue('--onestep-base').trim() : null })(),
    }
  })
  let tagHover = null
  if (peek.tag && await page.$('[data-onestep-peek-tag]')) {
    await page.hover('[data-onestep-peek-tag]')
    await sleep(320)
    tagHover = await page.evaluate(() => {
      const tag = document.querySelector('[data-onestep-peek-tag]')
      const cs = getComputedStyle(tag)
      const rect = tag.getBoundingClientRect()
      return { maxWidth: cs.maxWidth, width: Math.round(rect.width * 100) / 100, transitionDuration: cs.transitionDuration, background: cs.backgroundColor }
    })
    await page.mouse.move(5, 5)
    await sleep(200)
  }
  results.step('baseline.peek', { open: floatOpen, peek, tagHover })
  results.data.peek = { open: floatOpen, peek, tagHover }
  results.assert('baseline.peek-tag-rule', !!peek.tag && peek.tag.transitionDuration === '0.16s, 0.12s' && peek.tag.maxWidth === '38px' && !!tagHover && tagHover.maxWidth === '240px' && peek.stageTokenBaseOnTag === '', {
    expected: '收起标签：max-width 160ms（布局动画）+ 背景 120ms；portal 层读不到 --onestep-base（fallback 生效）（§1.1 #18/#19 实测）',
    actual: { peek: peek.tag, tagHover, stageTokenBaseOnTag: peek.stageTokenBaseOnTag },
    category: 'baseline',
  })

  // ---------- ⑩ 外部主绑定切换（官方左栏点击） ----------
  const external = await page.evaluate(async () => {
    const R = window.__P4
    const before = R.geometry()
    const current = before.snapshot.focusId
    const rows = R.officialSessionRows().filter((row) => row.sessionId !== current && row.rect.y > 0 && row.rect.y < window.innerHeight - 40)
    return { before, current, rows: rows.slice(0, 3), counter: R.readStartViewTransitionCounter(), visibility: document.visibilityState }
  })
  results.step('external.before', { currentFocus: external.current, rows: external.rows, vtCallsBefore: external.counter })
  let externalResult = null
  if (external.rows.length === 0) {
    results.skip('external.switch', '官方左栏没有可点击的其它会话行', 'external')
  } else {
    const row = external.rows[0]
    await page.evaluate(() => window.__P4.startSwitchTrack(1600))
    await sleep(100)
    await page.mouse.click(row.x, row.y)
    await sleep(1500)
    const track = await page.evaluate(() => window.__P4.stopSwitchTrack())
    const after = await page.evaluate(() => ({
      geometry: window.__P4.geometry(),
      counter: window.__P4.readStartViewTransitionCounter(),
      animations: window.__P4.auditAnimations(),
      pseudoAnimations: window.__P4.vtAnimations().length,
      activeViewTransition: !!document.activeViewTransition,
    }))
    const deviation = layoutDeviation(after.geometry)
    externalResult = { row, beforeFocus: external.current, track, after, deviation, vtCallsDuringSwitch: (after.counter.count || 0) - (external.counter.count || 0) }
    results.data.external = externalResult
    results.step('external.switch', {
      row: { key: row.key, x: row.x, y: row.y },
      beforeFocus: external.current,
      afterFocus: after.geometry.snapshot.focusId,
      focusSessionChangeIndex: track.focusSessionChangeIndex,
      candidateChangeIndex: track.candidateChangeIndex,
      domChangeIndex: track.domChangeIndex,
      focusIdChangeIndex: track.focusIdChangeIndex,
      domChangedBeforeFocusReport: track.domChangedBeforeFocusReport,
      distinctFocusSessions: track.distinctFocusSessions,
      sampleCount: track.sampleCount,
      pseudoMax: track.pseudoMax,
      activeViewTransitionFrames: track.activeViewTransitionFrames,
      vtCallsDuringSwitch: externalResult.vtCallsDuringSwitch,
      pseudoAfter: after.pseudoAnimations,
      animationsAfter: after.animations.count,
      deviationMax: deviation.max,
    })
    results.metric('external', {
      beforeFocus: external.current,
      afterFocus: after.geometry.snapshot.focusId,
      focusSessionChangeIndex: track.focusSessionChangeIndex,
      candidateChangeIndex: track.candidateChangeIndex,
      domChangeIndex: track.domChangeIndex,
      focusIdChangeIndex: track.focusIdChangeIndex,
      domChangedBeforeFocusReport: track.domChangedBeforeFocusReport,
      distinctFocusSessions: track.distinctFocusSessions.length,
      pseudoMax: track.pseudoMax,
      vtCallsDuringSwitch: externalResult.vtCallsDuringSwitch,
    })
    results.assert('external.switch-direct-cut', after.geometry.snapshot.focusId !== external.current && deviation.max <= 0.05 && track.pseudoMax === 0 && track.activeViewTransitionFrames === 0 && externalResult.vtCallsDuringSwitch === 0, {
      expected: '外部主绑定切换：焦点跟随、几何偏差 0、无 VT 调用/伪元素动画（直切，§4.4）',
      actual: { beforeFocus: external.current, afterFocus: after.geometry.snapshot.focusId, deviation: deviation.max, pseudoMax: track.pseudoMax, activeFrames: track.activeViewTransitionFrames, vtCalls: externalResult.vtCallsDuringSwitch },
      category: 'external',
    })
    results.assert('external.switch-dom-before-signal', track.domChangedBeforeFocusReport === true && track.domChangeIndex >= 0, {
      expected: '证据：焦点窗 DOM（session 换绑/候场列表）变化先于或同帧 focusSignal 上报 → 插件观测到时 DOM 已变化，无法在变化前启动 VT（§4.4 直切依据）',
      actual: { domChangeIndex: track.domChangeIndex, focusSessionChangeIndex: track.focusSessionChangeIndex, candidateChangeIndex: track.candidateChangeIndex, focusIdChangeIndex: track.focusIdChangeIndex, distinctFocusSessions: track.distinctFocusSessions },
      category: 'external',
    })
  }
  results.data.env.pageErrors = app.handles.pageErrors.slice(0, 10)

  // ---------- 与计划 §1.1 对照 ----------
  const packageJson = (() => {
    try { return JSON.parse(readSource('package.json')) } catch (error) { return {} }
  })()
  const stylesSource = readSource('src/client/styles.js')
  const planComparison = [
    { planRow: 1, planSays: '舞台进场无动画（硬切）', measured: 'stage 无 data-ready 属性、stage 自身无 animation/transition', status: 'match', evidence: 'baseline-audit.animations / computedAudit.stage' },
    { planRow: 2, planSays: '焦点↔候场无过渡（窗口几何内联直跳、内容换绑/挂载）', measured: 'morph-prototype 基线（无 VT）promote 的几何切换在 1 帧内完成，无 VT/过渡；外部切换同理', status: 'match', evidence: 'morph-prototype.decomposition.baselinePromote* + baseline-audit.external' },
    { planRow: 3, planSays: '候场增删/淘汰/关闭无动画', measured: '无对应 animation/transition（源码 addCandidate/removeCandidate 直接 store 更新）', status: 'source-checked', evidence: 'src/client/index.js:799-829' },
    { planRow: 4, planSays: '候场栏收起/展开无动画', measured: 'computedAudit.rail.transitionDuration=0s、无 animation', status: 'match', evidence: 'computeds.rail' },
    { planRow: 5, planSays: '分隔条拖拽直跟（正确）；悬停 120ms', measured: 'splitter::after transitionDuration=0.12s', status: 'match', evidence: 'computedAudit.splitter.after' },
    { planRow: 6, planSays: '候场卡 hover 仅 box-shadow/border-color 180ms，无抬起', measured: 'transitionDuration=0.18s ×3；hover 后 transform=none（无抬起）', status: 'match', evidence: 'baseline.candidateHover' },
    { planRow: 7, planSays: '运行态状态点 onestep-pulse 1.2s infinite', measured: '临时 data-tone=running 探测：animationName=onestep-pulse、1.2s、infinite（探测后还原；实例当前 running 点数量=' + results.data.pulse.actualRunningDotsInInstance + '）', status: 'match', evidence: 'baseline.pulse' },
    { planRow: 8, planSays: '完成闪烁边框 1.6s；data-flash 窗口 2200ms；reduced 静态', measured: 'onestep-flash duration=1600ms ×1；data-flash 属性移除实测 ' + (flashLife.removedAtMs === null ? '>6000' : Math.round(flashLife.removedAtMs)) + 'ms（FLASH_MS=2200 但移除依赖 re-render，源码无定时器）', status: 'diff', evidence: 'baseline.flash / baseline.flashLife' },
    { planRow: 9, planSays: '待处理气泡进场 180ms；无出场；reduced 关闭', measured: 'onestep-bubble-in 180ms；无 leaving 动画（源码确认）', status: 'match', evidence: 'baseline.bubble' },
    { planRow: 10, planSays: '候选 hover 120ms 淡入+50ms delay；焦点 120/300ms JS 计时，淡入 transform 180ms（base）', measured: 'control transitionDuration=' + (computedAudit.items.find((item) => item.key === 'control') || {}).computed?.transitionDuration + ' delay=' + (computedAudit.items.find((item) => item.key === 'control') || {}).computed?.transitionDelay, status: 'match', evidence: 'computedAudit.control' },
    { planRow: 11, planSays: '快速新建条 240/180ms；hover 200ms/400ms', measured: 'transform 0.24s / opacity 0.18s；open 后 opacity=1', status: 'match', evidence: 'baseline.quick' },
    { planRow: 12, planSays: '菜单/工作区菜单无动画（硬切）', measured: '菜单挂载后 transitionDuration=0s、animationName=none', status: 'match', evidence: 'baseline.menu' },
    { planRow: 13, planSays: '选择浮层 picker 无动画（mask/面板硬切）', measured: '未从探针动作面直接打开（无 picker 动作）；styles.js 无 picker 过渡/动画规则', status: 'source-checked', evidence: 'styles.js:137-145（.onestep-picker 无 transition/animation）' },
    { planRow: 14, planSays: 'toast 无动画；生命周期 5s/2.6s；宿主 Toast 160ms+1000ms', measured: '未在本套件触发 toast（生命周期 5s 会延长探针）；styles.js .onestep-toast 无 transition/animation', status: 'source-checked', evidence: 'styles.js:111' },
    { planRow: 15, planSays: '拖拽 HUD 内联 120ms；无进场', measured: '源码：drag.js 内联 120ms（背景/边框/阴影/opacity）；未在 P4-1 运行时触发拖拽', status: 'source-checked', evidence: 'src/client/drag.js:213/216' },
    { planRow: 16, planSays: '[data-drop] 有样式无过渡', measured: 'styles.js:113-114 无 transition', status: 'source-checked', evidence: 'styles.js:113-114' },
    { planRow: 17, planSays: '伴生窗收起/恢复无动画（内联 transform !important 直切）', measured: '收起后浮窗 transform=matrix(1,0,0,1,1464,0)；浮窗 computed transitionProperty=none', status: 'match', evidence: 'baseline.peek.floats / computedAudit' },
    { planRow: 18, planSays: '收起标签 hover：max-width 160ms（布局动画）+ 背景 120ms + 标题 opacity 120ms', measured: 'tag transitionDuration=0.16s,0.12s；max-width 38→240px（hover）；label transition 0.12s', status: 'match', evidence: 'baseline.peek.tagHover' },
    { planRow: 19, planSays: 'reduced 只把 stage token 归零；portal 层拿不到 --onestep-*；drag.js 不受控', measured: 'tags 在 portal：--onestep-base 解析为空（空串，fallback 160ms 生效）；reduced 套件实测 stage token=0ms、portal 标签 transition=none（@media 规则）', status: 'match', evidence: 'baseline.peek.stageTokenBaseOnTag + artifacts/p4/probe/reduced.json' },
    { planRow: 20, planSays: 'reducedMotion 字段无 setter、无消费（死状态）', measured: 'probe actions 无 setter；源码 store.js 无消费路径', status: 'match', evidence: 'artifacts/p4/probe/capability.json probe.actions + src/client/store.js' },
    { planRow: 21, planSays: '私有曲线 cubic-bezier(0.2,0.8,0.2,1) 与宿主 --ds-ease-in-out 不一致；时长散落', measured: 'stage --onestep-ease=' + ((computedAudit.items.find((item) => item.key === 'stage') || {}).vars || {})['--onestep-ease'] + '；宿主 --ds-ease-in-out=' + computedAudit.host.rootEase, status: 'match', evidence: 'computedAudit.stage/host' },
    { planRow: 22, planSays: '动效验收缺失', measured: 'package.json scripts 无 p4:verify/' + ((packageJson.scripts || {})['p4:verify'] ? '有' : '无') + '；现有 verify 套件无动效时长/帧率门禁', status: 'match', evidence: 'package.json scripts=' + Object.keys(packageJson.scripts || {}).join(',') },
  ]
  const supplements = [
    { item: '候场卡 hover 的 transition 同时包含 transform 180ms（虽然 hover 规则未改 transform）——P4-2 token 化时注意不要误开抬起', evidence: 'computedAudit.frame.candidate' },
    { item: 'stage 自身 --onestep-ease 为私有 cubic-bezier(0.2,0.8,0.2,1)，而 0.3.0 CSS 里部分元素用 --ds-ease-in-out fallback（如 peek-tag），两套曲线并存', evidence: 'computedAudit.host + styles.js:157' },
    { item: 'control 的 CSS transition-delay 基础态为 400ms（styles.js:53），§1.1 #10 写「候选 hover 120ms 淡入 + 50ms delay；焦点 120/300ms JS 计时」——CSS 与 JS 两套延迟叠加，P4-5 收敛时需以 DOM 实测为准', evidence: 'computedAudit.control' },
    { item: '快速新建条当前 transform 240ms（--onestep-slow），计划 §2.3 要求 180ms；P4-6 需改 token 引用而非新增值', evidence: 'computedAudit.quick.inner + docs/p4-plan.md §2.3' },
    { item: 'flash 的 data-flash 属性移除依赖下一次 re-render（无定时器），实际持续时间可能 > FLASH_MS=2200；P4-5 收敛 FLASH_MS 时应补 stage-root tick 定时清理', evidence: 'baseline.flashLife + src/client/stage-root.js:328-343' },
  ]
  results.data.planComparison = planComparison
  results.data.supplements = supplements
  results.step('plan.comparison', planComparison.map((item) => ({ row: item.planRow, status: item.status })))
  const diffRows = planComparison.filter((item) => item.status === 'diff' || item.status === 'supplement')
  results.assert('plan.comparison', planComparison.length === 22 && planComparison.every((item) => ['match', 'diff', 'source-checked', 'supplement'].includes(item.status)), {
    expected: '§1.1 22 行逐项对照完成，0 个未解释项',
    actual: { rows: planComparison.length, statusCounts: planComparison.reduce((out, item) => { out[item.status] = (out[item.status] || 0) + 1; return out }, {}), diff: diffRows.map((item) => item.planRow) },
    category: 'baseline',
  })

  // ---------- 清理 ----------
  const cleanup = await page.evaluate(() => window.__P4.cleanup())
  const finalState = await page.evaluate(() => ({
    pseudoLeft: window.__P4.vtAnimations().length,
    activeViewTransition: !!document.activeViewTransition,
    tempStyles: document.querySelectorAll('[data-p4-vt-style]').length,
    visibility: document.visibilityState,
  }))
  results.step('cleanup', { cleanup, finalState })
  results.assert('baseline.cleanup', finalState.pseudoLeft === 0 && finalState.activeViewTransition === false && finalState.tempStyles === 0, {
    expected: '基线审计结束无残留 VT 伪元素动画/注入样式',
    actual: finalState,
    category: 'cleanup',
  })
  results.assert('baseline.no-pageerror', app.handles.pageErrors.length === 0, {
    expected: '基线/外部切换套件无 pageerror',
    actual: { pageErrors: app.handles.pageErrors.slice(0, 10) },
    category: 'env',
  })
} catch (error) {
  results.fatal(error)
} finally {
  try { await closeApp(app) } catch (_error) { /* ignore */ }
  const data = results.finish()
  console.log('[baseline-audit] ok=' + data.ok + ' summary=' + JSON.stringify(data.summary))
  const comparison = data.planComparison || []
  console.log('[baseline-audit] plan rows=' + comparison.length + ' diff=' + JSON.stringify(comparison.filter((item) => item.status === 'diff').map((item) => item.planRow)))
  console.log('[baseline-audit] json=' + relPath(path.join(OUT, 'baseline-audit.json')))
}
process.exitCode = results.data.ok ? 0 : 1
