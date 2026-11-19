/**
 * P4-9 m1：舞台几何动效（morph）验证 —— 计划 §5 G3。
 *
 * 覆盖：4 窗场景 promote / demote / cycle / close / evict / add 六条路径的
 * ① VT 组动画时长（promote/cycle=220ms；close/evict/add=160ms）与 old/new 交叉时长（old 60ms 快出、new 120ms/延迟 40ms）；
 * ② 结束几何（DOM rect vs actions.layout() ≤0.5px、与基线槽位一致）与 snapshot 状态；
 * ③ 关键帧内容防闪（暂停+seek 0/110/220，theme-aware 相对判据，禁止绝对白像素比例）；
 * ④ 快速连切 5 次（允许 VT/skip 混合）：最终状态正确、无 pageerror、无残留 VT 伪元素动画；
 * ⑤ VT 命名唯一性；⑥ reduced context 下不启动 VT。
 *
 * 运行：node scripts/p4/verify/m1-morph.mjs
 * 产物：artifacts/p4/verify/m1-morph.json + shots/m1-*.png
 */
import fs from 'node:fs'

import {
  openVerifyApp,
  closeApp,
  setupFourWindows,
  waitMotionIdle,
  geometry,
  snapshot,
  motionState,
  triggerWithWatch,
  captureKeyframes,
  resumePseudo,
  shot,
  createResults,
  finishSuite,
  assertNoPageErrors,
  geometryCheck,
  snapshotCheck,
  windowName,
  waitPseudoAnimations,
  decodePng,
  contentFlashCheck,
  waitFor,
  sleep,
  listSessions,
  ensureDirs,
} from './lib.mjs'

const results = createResults('m1-morph', 'P4-9 m1：舞台几何动效 morph（G3）')
let app = null
let reducedApp = null

const MOTION_GROUP_MS = { promote: 220, cycle: 220, demote: 220, close: 160, evict: 160, add: 160 }
const MOTION_OLD_FADE_MS = 60 // P4.2：旧快照快速淡出，避免拉伸的旧缩略图盖住邻窗（闪/重影）
const MOTION_NEW_FADE_MS = 120
const MOTION_NEW_DELAY_MS = 40

function pseudoItemsOf(handle, watch) {
  if (handle.pseudo && handle.pseudo.current && handle.pseudo.current.length > 0) return handle.pseudo.current
  if (handle.pseudo && handle.pseudo.first && handle.pseudo.first.items) return handle.pseudo.first.items
  if (watch && watch.pseudoFirst && watch.pseudoFirst.items) return watch.pseudoFirst.items
  return []
}

function findGroup(items, name) {
  const expected = '::view-transition-group(' + name + ')'
  return (items || []).find((item) => item.pseudoElement === expected) || null
}

function findKind(items, name, kind) {
  const expected = '::view-transition-' + kind + '(' + name + ')'
  return (items || []).find((item) => item.pseudoElement === expected) || null
}

async function waitFocus(page, focusId, timeout = 12000) {
  await waitFor(async () => {
    const snap = await snapshot(page)
    return snap.focusId === focusId
  }, { timeout, label: 'focus=' + focusId })
}

/**
 * 跑一条路径：触发 → 观察 VT → （可选）关键帧 → 等静默 → 断言。
 */
async function runPath(page, spec) {
  await waitMotionIdle(page)
  const before = await snapshot(page)
  const beforeGeo = await geometry(page)
  const handle = await triggerWithWatch(page, spec.trigger, { label: 'm1.' + spec.name })

  // P4.2：group 的非线性曲线以「伪元素计算样式」为准（effect.getTiming().easing 对 UA VT 动画恒为 linear）。
  let groupComputed = null
  if (handle.pseudo.current.length > 0) {
    try {
      const expectedGroupName = spec.groupName(before, spec.expect)
      groupComputed = await page.evaluate((name) => window.__V.computed('html', '::view-transition-group(' + name + ')'), expectedGroupName)
    } catch (_error) {
      groupComputed = null
    }
  }
  let keyframeResult = null
  if (spec.keyframes && handle.pseudo.current.length > 0) {
    keyframeResult = await captureKeyframes(page, results, 'm1-' + spec.name, spec.times || [0, 110, 220])
    if (spec.collectNaming) {
      const naming = await page.evaluate(() => window.__V.naming())
      results.metric('m1.' + spec.name + '.naming', naming)
      results.assert('m1.' + spec.name + '.unique-vt-names', naming.duplicates.length === 0 && naming.count >= 4, {
        category: 'morph',
        expected: '4 个窗口命名，无重复',
        actual: { count: naming.count, duplicates: naming.duplicates, names: naming.names.map((item) => item.name) },
      })
      const windowNames = beforeGeo.frames.map((frame) => windowName(frame.sessionId))
      const missing = windowNames.filter((name) => !naming.names.some((item) => item.name === name))
      results.assert('m1.' + spec.name + '.window-names-present', missing.length === 0, {
        category: 'morph',
        expected: windowNames,
        actual: { missing, names: naming.names.map((item) => item.name) },
      })
    }
    await resumePseudo(page)
  }

  // 等状态落地与动画静默（route=vt/skipped 都要求最终状态一致）。
  await waitFocus(page, spec.expect.focusId)
  await waitMotionIdle(page)
  const watch = await handle.stop()
  const after = await geometry(page)
  const motion = await motionState(page)
  const route = motion && motion.controller && motion.controller.last ? motion.controller.last.route : null
  const kind = motion && motion.controller && motion.controller.last ? motion.controller.last.kind : null
  const call = watch && watch.calls && watch.calls[0] ? watch.calls[0] : null
  // P4 卡顿回归：降级候场卡的 live 缩略必须在 morph 结束之后挂载（否则官方聊天体挂载会阻塞动画 → 掉帧）。
  if (call && watch) {
    const windowStart = call.callbackStartMs
    const windowEnd = call.finishedMs || call.callbackEndMs
    const offending = (watch.previewFlips || []).filter((flip) => flip.value === 'live' && flip.atMs >= windowStart && flip.atMs <= windowEnd)
    const liveFlipsAfter = (watch.previewFlips || []).filter((flip) => flip.value === 'live' && flip.atMs > windowEnd)
    results.assert('m1.' + spec.name + '.deferred-live-not-during-morph', offending.length === 0, {
      category: 'jank',
      expected: 'data-preview=live 不得发生在 VT 回调/动画窗口内（应延后到动效结束）',
      actual: { offending, liveFlipsAfter: liveFlipsAfter.slice(0, 4), window: { start: windowStart, end: windowEnd } },
    })
  }
  const items = pseudoItemsOf(handle, watch)
  const groups = {}
  for (const item of items) {
    const match = /^::view-transition-(group|old|new|image-pair)\((.+)\)$/.exec(item.pseudoElement || '')
    if (!match) continue
    groups[match[2]] = groups[match[2]] || {}
    groups[match[2]][match[1]] = item
  }

  results.metric('m1.' + spec.name, {
    route,
    kind,
    call,
    vtCalls: watch ? watch.calls.length : 0,
    pseudoCount: items.length,
    groups: Object.keys(groups),
    focus: { before: before.focusId, after: after.snapshot.focusId },
    candidates: after.snapshot.candidates,
    layoutMax: geometryCheck(after, { focus: beforeGeo.layout && beforeGeo.layout.focus, candidateRects: [] }).layoutMax,
    watchTimeout: handle.watchTimeout,
  })

  // 1) VT 组动画时长（route=skipped 时按 Lead 口径允许无组动画）。
  if (route === 'vt') {
    results.assert('m1.' + spec.name + '.route-vt', true, { category: 'morph', expected: 'vt', actual: route })
    const expectedName = spec.groupName(before, spec.expect)
    const expectedMs = MOTION_GROUP_MS[spec.durationKind]
    const group = findGroup(items, expectedName)
    const old = findKind(items, expectedName, 'old')
    const fresh = findKind(items, expectedName, 'new')
    // 元素参与证据：角色互换路径有 group；old-only（close/evict）/new-only（add）路径 Chrome 只生成 old/new 快照动画。
    results.assert('m1.' + spec.name + '.vt-element-participates', !!(group || old || fresh), {
      category: 'duration',
      expected: '::view-transition-{group|old|new}(' + expectedName + ') 之一',
      actual: items.map((item) => item.pseudoElement),
    })
    const groupAnimations = items.filter((item) => String(item.pseudoElement || '').indexOf('::view-transition-group(') === 0)
    results.assert('m1.' + spec.name + '.vt-group-duration', groupAnimations.length > 0 && groupAnimations.every((item) => Number(item.duration) === expectedMs), {
      category: 'duration',
      expected: '所有 ::view-transition-group 动画 duration=' + expectedMs + 'ms（kind=' + spec.durationKind + '）',
      actual: groupAnimations.map((item) => ({ pseudoElement: item.pseudoElement, duration: item.duration, delay: item.delay })),
    })
    // P4.2 方向性覆盖：被提升窗口 old 立即隐藏（1ms）、new 立即淡入（delay 0）；
    // 其余窗口保持 old 60ms 快出 / new 120ms + 40ms 延迟。
    if (old) {
      const promoted = windowName(spec.expect.focusId) === expectedName
      const allowed = promoted ? [1] : [MOTION_OLD_FADE_MS]
      results.assert('m1.' + spec.name + '.vt-old-duration', allowed.includes(Number(old.duration)), {
        category: 'duration', expected: promoted ? '1ms（被提升窗旧快照立即隐藏）' : MOTION_OLD_FADE_MS + 'ms', actual: { pseudo: old.pseudoElement, duration: old.duration, delay: old.delay, allowed },
      })
    }
    if (fresh) {
      const promoted = windowName(spec.expect.focusId) === expectedName
      const allowed = promoted || spec.durationKind === 'add' || spec.durationKind === 'close' || spec.durationKind === 'evict'
        ? [[MOTION_NEW_FADE_MS, 0]]
        : [[MOTION_NEW_FADE_MS, MOTION_NEW_DELAY_MS]]
      const okNew = allowed.some(([duration, delay]) => Number(fresh.duration) === duration && Number(fresh.delay) === delay)
      results.assert('m1.' + spec.name + '.vt-new-duration', okNew, {
        category: 'duration', expected: promoted ? '120ms + delay 0ms（被提升窗新内容立即淡入）' : { duration: MOTION_NEW_FADE_MS + 'ms', delay: MOTION_NEW_DELAY_MS + 'ms' }, actual: { pseudo: fresh.pseudoElement, duration: fresh.duration, delay: fresh.delay, allowed },
      })
    }
    // P4.2 非线性曲线：group 使用 easeOutQuint 近似（快出慢收），不得退回线性/关键字。
    if (groupComputed && groupComputed.found) {
      const computedEasing = String(groupComputed.animationTimingFunction || '').replace(/\s+/g, '')
      results.assert('m1.' + spec.name + '.vt-group-easing', computedEasing === 'cubic-bezier(0.22,1,0.36,1)', {
        category: 'easing',
        expected: 'cubic-bezier(0.22,1,0.36,1)',
        actual: { animationTimingFunction: groupComputed.animationTimingFunction || null },
      })
    } else {
      results.skip('m1.' + spec.name + '.vt-group-easing', '未捕获到伪元素计算样式（路径未产生 group 伪元素）', 'duration')
    }
    // P4.2 方向性断言（仅升降焦点的路径）：被降级窗口 new 延迟到 150ms 再淡入。
    if (before.focusId && spec.expect.focusId !== before.focusId) {
      const demotedNew = findKind(items, windowName(before.focusId), 'new')
      if (demotedNew) {
        results.assert('m1.' + spec.name + '.vt-demoted-card-delayed', Number(demotedNew.delay) === 150, {
          category: 'jank',
          expected: '150ms（候场卡等 group 收拢后再淡入，避免放大鬼影）',
          actual: { pseudo: demotedNew.pseudoElement, duration: demotedNew.duration, delay: demotedNew.delay },
        })
      }
    }
  } else if (route === 'skipped') {
    results.skip('m1.' + spec.name + '.route-skipped', '控制器 skip 分支（Lead 口径允许）：无 VT 组动画，最终状态仍需一致', 'duration')
    results.assert('m1.' + spec.name + '.skip-no-pseudo', items.length === 0, {
      category: 'duration',
      expected: 'skip 时无 VT 伪元素动画',
      actual: items.map((item) => item.pseudoElement),
    })
  } else {
    results.assert('m1.' + spec.name + '.route-vt', false, {
      category: 'morph',
      expected: 'route=vt（非 reduced 上下文）',
      actual: { route, kind, motion },
    })
  }

  // 2) 状态正确性（focusId + 候场集合）。
  const stateCheck = snapshotCheck(after.snapshot, spec.expect)
  results.assert('m1.' + spec.name + '.state', stateCheck.focusOk && stateCheck.candidatesOk, {
    category: 'state',
    expected: spec.expect,
    actual: stateCheck.actual,
    note: 'missing=' + JSON.stringify(stateCheck.missing) + ' extra=' + JSON.stringify(stateCheck.extra),
  })

  // 3) 结束几何：DOM vs actions.layout() ≤0.5px + 基线槽位。
  const check = geometryCheck(after, spec.baseline || beforeGeo.baseline)
  results.assert('m1.' + spec.name + '.geometry-layout', check.layoutMax <= 0.5, {
    category: 'geometry',
    expected: '≤0.5px',
    actual: { layoutMax: check.layoutMax, detail: check.detail },
  })
  results.assert('m1.' + spec.name + '.geometry-focus-slot', check.focusVsBaselineMax <= 0.5, {
    category: 'geometry',
    expected: '焦点窗 rect = 基线焦点槽位（≤0.5px）',
    actual: { deviation: check.focusVsBaselineMax, focus: after.focus && after.focus.rect, baseline: after.layout && after.layout.focus },
  })
  results.assert('m1.' + spec.name + '.geometry-candidate-slots', check.candidateVsBaselineMax <= 0.5, {
    category: 'geometry',
    expected: '候场卡 rect 落在基线候场槽位（≤0.5px）',
    actual: { deviation: check.candidateVsBaselineMax, matches: check.detail.candidateMatches },
  })
  results.assert('m1.' + spec.name + '.no-residual-vt', after.motion && after.motion.controller ? after.motion.controller.active === false && after.dom.vtPseudoCount === 0 : false, {
    category: 'cleanup',
    expected: { active: false, vtPseudoCount: 0 },
    actual: { controller: after.motion && after.motion.controller, vtPseudoCount: after.dom.vtPseudoCount },
  })

  // 4) 关键帧内容防闪（theme-aware 相对判据）。
  if (keyframeResult && spec.keyframes) {
    const postFile = await shot(results, page, 'm1-' + spec.name + '-post.png')
    const images = {
      mid: decodePng(fs.readFileSync(keyframeResult.shots[1].file)),
      end: decodePng(fs.readFileSync(keyframeResult.shots[keyframeResult.shots.length - 1].file)),
      post: decodePng(fs.readFileSync(postFile)),
    }
    const rect = after.layout && after.layout.focus ? after.layout.focus : null
    const flash = contentFlashCheck(images, rect)
    results.metric('m1.' + spec.name + '.contentFlash', flash)
    results.assert('m1.' + spec.name + '.content-no-blank', flash.checks.postHasContent, {
      category: 'content',
      expected: 'post 帧有内容（std≥5、颜色桶≥24）',
      actual: flash.stats.post,
    })
    results.assert('m1.' + spec.name + '.content-no-flash-mid', flash.checks.midLuminance && flash.checks.midBuckets && flash.checks.midStd && flash.checks.midMeanDiff, {
      category: 'content',
      expected: 't' + keyframeResult.shots[1].t + ' 与 post 相对亮度/颜色桶/结构一致、无白屏',
      actual: { checks: flash.checks, mid: flash.stats.mid, post: flash.stats.post, diff: { meanAbsDiff: flash.diffs.mid.meanAbsDiff, changedFraction: flash.diffs.mid.changedFraction } },
    })
    results.assert('m1.' + spec.name + '.content-no-flash-end', flash.checks.endLuminance && flash.checks.endMeanDiff && flash.checks.endBuckets, {
      category: 'content',
      expected: '动画结束帧（t' + keyframeResult.shots[keyframeResult.shots.length - 1].t + '）与 post 一致',
      actual: { checks: flash.checks, end: flash.stats.end, diff: { meanAbsDiff: flash.diffs.end.meanAbsDiff } },
    })
  }

  return { before, after, motion, route, groups, items, call, watch }
}

try {
  app = await openVerifyApp({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
  const page = app.page
  results.setEnv('viewport', '1440x900')
  results.setEnv('colorScheme', 'light')
  const setup = await setupFourWindows(page)
  results.metric('m1.setup', { windows: setup.windows, focusId: setup.focusId, candidates: setup.candidates, baseline: setup.baseline })
  results.assert('m1.setup.windows', setup.windows.length === 4, {
    category: 'setup', expected: 4, actual: setup.windows,
  })
  const baseline = setup.baseline

  // 路径 1：promote（候场 → 焦点，220ms；关键帧 + 命名唯一性）
  let snap = await snapshot(page)
  const promoteTarget = snap.candidates[0]
  await runPath(page, {
    name: 'promote',
    trigger: () => page.evaluate((id) => window.__ONESTEP__.actions.promote(id), promoteTarget),
    expect: { focusId: promoteTarget, candidates: [snap.focusId, ...snap.candidates.slice(1)] },
    groupName: () => windowName(promoteTarget),
    durationKind: 'promote',
    baseline,
    keyframes: true,
    times: [0, 110, 220],
    collectNaming: true,
  })

  // 路径 2：demote（焦点 → 候场，由 focusSession 切换触发，220ms）
  snap = await snapshot(page)
  const demoteTarget = snap.candidates[0]
  await runPath(page, {
    name: 'demote',
    trigger: () => page.evaluate((id) => window.__ONESTEP__.actions.focusSession(id), demoteTarget),
    expect: { focusId: demoteTarget, candidates: [snap.focusId, ...snap.candidates.slice(1)] },
    groupName: () => windowName(demoteTarget),
    durationKind: 'demote',
    baseline,
  })

  // 路径 3：cycle（Ctrl+Alt+→ 等价，220ms）
  snap = await snapshot(page)
  const cycleTarget = snap.candidates[0]
  let cycleResult = null
  await runPath(page, {
    name: 'cycle',
    trigger: async () => {
      cycleResult = await page.evaluate(() => window.__ONESTEP__.actions.cycleFocus(1))
    },
    expect: { focusId: cycleTarget, candidates: [snap.focusId, ...snap.candidates.slice(1)] },
    groupName: () => windowName(cycleTarget),
    durationKind: 'cycle',
    baseline,
  })
  results.assert('m1.cycle.action-returned', !!(cycleResult && cycleResult.version), {
    category: 'state', expected: 'cycleFocus 返回 snapshot', actual: { version: cycleResult && cycleResult.version, focusId: cycleResult && cycleResult.focusId },
  })

  // 路径 4：close 焦点窗（160ms；关键帧）
  snap = await snapshot(page)
  const closePrev = snap.focusId
  const closeNext = snap.candidates[0]
  await runPath(page, {
    name: 'close',
    trigger: () => page.evaluate(() => window.__ONESTEP__.actions.closeFocus()),
    expect: { focusId: closeNext, candidates: snap.candidates.slice(1) },
    groupName: () => windowName(closePrev),
    durationKind: 'close',
    baseline,
    keyframes: true,
    times: [0, 80, 160],
  })

  // 路径 5：evict（移出候场，160ms）
  snap = await snapshot(page)
  const evictTarget = snap.candidates[Math.min(1, snap.candidates.length - 1)]
  await runPath(page, {
    name: 'evict',
    trigger: () => page.evaluate((id) => window.__ONESTEP__.actions.removeCandidate(id), evictTarget),
    expect: { focusId: snap.focusId, candidates: snap.candidates.filter((id) => id !== evictTarget) },
    groupName: () => windowName(evictTarget),
    durationKind: 'evict',
    baseline,
  })

  // 路径 6：add（新增候场，160ms new-only）
  snap = await snapshot(page)
  const addTarget = setup.extraIds.find((id) => !snap.candidates.includes(id) && id !== snap.focusId)
  if (addTarget) {
    await runPath(page, {
      name: 'add',
      trigger: () => page.evaluate((id) => window.__ONESTEP__.actions.addCandidate(id), addTarget),
      expect: { focusId: snap.focusId, candidates: [...snap.candidates, addTarget].slice(0, 3) },
      groupName: () => windowName(addTarget),
      durationKind: 'add',
      baseline,
    })
  } else {
    results.skip('m1.add', '没有可用候选 sessionId', 'setup')
  }

  // 快速连切 5 次（间隔 80ms）：允许 VT/skip 混合，最终状态必须正确。
  await waitMotionIdle(page)
  const rapidBefore = await snapshot(page)
  const rapid = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const actions = window.__ONESTEP__.actions
    window.__V.startVtWatch('m1.rapid')
    const calls = []
    for (let index = 0; index < 5; index += 1) {
      if (index > 0) await sleep(80)
      const snap = actions.snapshot()
      const pool = snap.candidates || []
      if (pool.length === 0) {
        calls.push({ index, error: 'no-candidate' })
        break
      }
      const target = pool[index % pool.length]
      let result = null
      try {
        result = actions.promote(target)
      } catch (error) {
        result = { thrown: String((error && error.message) || error) }
      }
      calls.push({ index, target, result })
    }
    return { calls, startedAt: performance.now() }
  })
  await waitFor(async () => {
    const current = await snapshot(page)
    return current.mounted === true
  }, { timeout: 8000, label: 'rapid.mounted' })
  await waitMotionIdle(page, 20000)
  const rapidWatch = await page.evaluate(() => window.__V.stopVtWatch())
  const rapidAfter = await geometry(page)
  const rapidMotion = await motionState(page)
  // probe.promote 返回 snapshot（无 ok 字段）：页面内循环的 target 均取自当刻 candidates，视为被接受；
  // 队列按调用顺序 drain，最终状态应等于最后一次调用的 target。
  const acceptedCalls = (rapid.calls || []).filter((call) => call && call.target && (!call.result || !call.result.thrown))
  const lastTarget = acceptedCalls.length > 0 ? acceptedCalls[acceptedCalls.length - 1].target : null
  const rapidPool = new Set([...rapidBefore.candidates, rapidBefore.focusId])
  results.metric('m1.rapid', {
    calls: rapid.calls.map((call) => ({ index: call.index, target: call.target })),
    vtCalls: rapidWatch ? rapidWatch.calls.length : 0,
    lastTarget,
    focusId: rapidAfter.snapshot.focusId,
    candidates: rapidAfter.snapshot.candidates,
    motion: rapidMotion,
    residualPseudo: rapidAfter.dom.vtPseudoCount,
  })
  results.assert('m1.rapid.final-focus', !!lastTarget && rapidAfter.snapshot.focusId === lastTarget, {
    category: 'state',
    expected: lastTarget || 'last promote target',
    actual: rapidAfter.snapshot.focusId,
    note: 'calls=' + JSON.stringify(rapid.calls.map((call) => ({ index: call.index, target: call.target }))),
  })
  results.assert('m1.rapid.final-candidates', (rapidAfter.snapshot.candidates || []).length === rapidBefore.candidates.length && rapidAfter.snapshot.candidates.every((id) => rapidPool.has(id)), {
    category: 'state',
    expected: '候场数不变且成员来自原 4 窗',
    actual: rapidAfter.snapshot.candidates,
  })
  results.assert('m1.rapid.no-residual-vt', rapidAfter.dom.vtPseudoCount === 0 && rapidMotion.controller.active === false && rapidMotion.controller.activeState === 'idle', {
    category: 'cleanup',
    expected: { vtPseudoCount: 0, active: false, activeState: 'idle' },
    actual: { vtPseudoCount: rapidAfter.dom.vtPseudoCount, controller: rapidMotion.controller },
  })
  results.assert('m1.rapid.vt-mix', (rapidWatch ? rapidWatch.calls.length : 0) >= 1 && (rapidWatch ? rapidWatch.calls.length : 0) <= 5, {
    category: 'morph',
    expected: '1..5 次 VT（VT/skip 混合允许）',
    actual: rapidWatch ? rapidWatch.calls.length : 0,
  })
  results.assert('m1.rapid.no-pageerror', app.handles.pageErrors.length === 0, {
    category: 'runtime', expected: 0, actual: app.handles.pageErrors,
  })

  // 静态收尾断言：静止时各窗口 vtName = sessionId 命名、无重复。
  const namingRest = await page.evaluate(() => window.__V.naming())
  const windowNamesRest = namingRest.names.filter((item) => String(item.name).indexOf('onestep-w-') === 0)
  const railNamesRest = namingRest.names.filter((item) => item.name === 'onestep-rail')
  results.assert('m1.rest.unique-names', namingRest.duplicates.length === 0 && windowNamesRest.length === rapidPool.size && railNamesRest.length === 1, {
    category: 'morph',
    expected: '每个窗口一个唯一命名（' + rapidPool.size + '）+ 1 个 onestep-rail，且无重复',
    actual: { count: namingRest.count, windowNames: windowNamesRest.map((item) => item.name), rail: railNamesRest.map((item) => item.name), duplicates: namingRest.duplicates },
  })

  // reduced context：不启动 VT（Lead 口径：route 非 vt + VT 调用数 0 + 无伪元素动画）。
  reducedApp = await openVerifyApp({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const reducedPage = reducedApp.page
  const reducedSetupRows = await listSessions(reducedPage)
  const reducedIds = Object.keys(reducedSetupRows || {}).slice(0, 3)
  await reducedPage.evaluate((ids) => window.__ONESTEP__.actions.enterStage(ids), reducedIds)
  await waitFor(async () => {
    const current = await snapshot(reducedPage)
    return current.mounted === true && !!current.focusId && current.candidates.length >= 1
  }, { timeout: 15000, label: 'reduced.stage' })
  await waitMotionIdle(reducedPage)
  const reducedMotionBefore = await motionState(reducedPage)
  const reducedWatchStart = await reducedPage.evaluate(() => window.__V.startVtWatch('m1.reduced'))
  const reducedSnap = await snapshot(reducedPage)
  const reducedTarget = reducedSnap.candidates[0]
  await reducedPage.evaluate((id) => window.__ONESTEP__.actions.promote(id), reducedTarget)
  await waitFor(async () => {
    const current = await snapshot(reducedPage)
    return current.focusId === reducedTarget
  }, { timeout: 12000, label: 'reduced.promote' })
  await waitMotionIdle(reducedPage)
  const reducedWatch = await reducedPage.evaluate(() => window.__V.stopVtWatch())
  const reducedMotionAfter = await motionState(reducedPage)
  const reducedGeo = await geometry(reducedPage)
  results.metric('m1.reduced', {
    motionBefore: reducedMotionBefore,
    motionAfter: reducedMotionAfter,
    vtCalls: reducedWatch ? reducedWatch.calls.length : 0,
    pseudoFirst: reducedWatch ? reducedWatch.pseudoFirst : null,
    pseudoNow: reducedGeo.dom.vtPseudoCount,
  })
  results.assert('m1.reduced.attr', reducedMotionAfter.attribute === 'reduced' && reducedMotionAfter.mode === 'reduced', {
    category: 'reduced', expected: { attribute: 'reduced', mode: 'reduced' }, actual: { attribute: reducedMotionAfter.attribute, mode: reducedMotionAfter.mode },
  })
  results.assert('m1.reduced.route-not-vt', reducedMotionAfter.controller.last.route !== 'vt' && reducedMotionAfter.controller.last.route !== 'queued', {
    category: 'reduced', expected: 'instant（非 vt）', actual: reducedMotionAfter.controller.last,
  })
  results.assert('m1.reduced.no-vt-call', (reducedWatch ? reducedWatch.calls.length : 0) === 0, {
    category: 'reduced', expected: 0, actual: reducedWatch ? reducedWatch.calls.length : 0,
  })
  results.assert('m1.reduced.no-pseudo', reducedGeo.dom.vtPseudoCount === 0 && (!reducedWatch || reducedWatch.pseudoFirst === null), {
    category: 'reduced', expected: { pseudoNow: 0, pseudoFirst: null }, actual: { pseudoNow: reducedGeo.dom.vtPseudoCount, pseudoFirst: reducedWatch ? reducedWatch.pseudoFirst : null },
  })
  results.assert('m1.reduced.state', reducedGeo.snapshot.focusId === reducedTarget, {
    category: 'state', expected: reducedTarget, actual: reducedGeo.snapshot.focusId,
  })

  assertNoPageErrors(results, app.handles, 'm1')
  assertNoPageErrors(results, reducedApp.handles, 'm1.reduced')
} catch (error) {
  results.fatal(error)
} finally {
  try {
    if (app) await closeApp(app)
  } catch (_error) { /* ignore */ }
  try {
    if (reducedApp) await closeApp(reducedApp)
  } catch (_error) { /* ignore */ }
  finishSuite(results)
}
process.exitCode = results.data.ok ? 0 : 1
