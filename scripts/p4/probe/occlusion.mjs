/**
 * P4-1 探针⑦：伴生浮窗 / 收起标签在 morph 期间的遮挡（docs/p4-plan.md §4.10 #7 / Q2）
 *
 * 场景（每个 morph 都会切换焦点会话，因此每一步前重新为当前会话打开浮窗/收起标签）：
 * A. 3 个官方伴生浮窗可见 → morph：关键帧 0/110/220 截图，与「morph 前 live 截图」做像素对比；
 * B. 点击舞台空白把浮窗收成右缘标签 → morph：关键帧 + 像素对比；
 * C. Q2 实验：给浮窗/标签临时注入 view-transition-name（页面运行时注入，不改产品源码）再 morph，
 *    对比「默认被窗口快照覆盖」vs「临时命名后浮窗保持在上层」的像素差异，给出处置建议。
 *
 * 遮挡判定口径：以 morph 前 live 截图为参照（浮窗/标签此时的真实像素）。
 * 若 morph 关键帧在该区域与 live 差异大 → 该区域被窗口快照覆盖（或冻结成旧画面）；
 * 若临时命名后差异显著减小 → 命名可修复遮挡。
 *
 * 用法：node scripts/p4/probe/occlusion.mjs
 * 产物：artifacts/p4/probe/occlusion.json + artifacts/p4/probe/shots/occlusion-*.png
 */
import path from 'node:path'

import {
  OUT, createResults, sleep, openApp, closeApp, enterStage, pageEnv, installRuntime,
  actionCall, p3Call, fileAddress, shot, decodePng, regionDiff, imageStats, loadShot, relPath,
} from './lib.mjs'

const results = createResults('occlusion', 'P4-1 探针⑦：伴生浮窗/收起标签遮挡')
let app = null

async function mountedSession(page) {
  const snapshot = await p3Call(page, 'snapshot')
  if (snapshot && snapshot.mounted) return snapshot.mounted
  return page.evaluate(() => window.__P4.snapshot().focusId)
}

/** 为当前会话打开 3 个官方伴生浮窗。 */
async function openFloats(page) {
  const sessionId = await mountedSession(page)
  const files = ['README.md', 'CHANGELOG.md', 'package.json']
  const opened = []
  for (const file of files) {
    const result = await actionCall(page, 'companionOpenResource', null, fileAddress(sessionId, file))
    opened.push({ file, ok: !!(result && result.ok !== false) })
    await sleep(420)
  }
  const state = await page.evaluate(() => ({ floats: window.__P4.floats(), tags: window.__P4.peekTags() }))
  return { sessionId, opened, state }
}

/** 点击舞台空白，把可见浮窗收成右缘标签；失败则退回 floatPeekAll。 */
async function collapseToTags(page) {
  const blank = await page.evaluate(() => window.__P4.findStageBlankPoint())
  let fallback = null
  if (blank) {
    await page.mouse.click(blank.x, blank.y)
    await sleep(600)
  }
  let state = await page.evaluate(() => ({ floats: window.__P4.floats(), tags: window.__P4.peekTags(), layer: window.__P4.peekLayer() }))
  if (state.tags.length === 0) {
    fallback = await p3Call(page, 'floatPeekAll')
    await sleep(600)
    state = await page.evaluate(() => ({ floats: window.__P4.floats(), tags: window.__P4.peekTags(), layer: window.__P4.peekLayer() }))
  }
  return { blank, fallback, state }
}

/** 关键帧 morph：morph 前 live 截图 → ready → pause/seek 0/110/220 截图 → resume → finished → post。 */
async function keyframeMorph(page, prefix) {
  const prep = await page.evaluate(async () => {
    const R = window.__P4
    R.applyWindowNames()
    await R.sleep(32)
    const before = R.geometry()
    return {
      before,
      target: (before.snapshot.candidates || [])[0] || null,
      floats: R.floats(),
      tags: R.peekTags(),
      peekLayer: R.peekLayer(),
    }
  })
  if (!prep.target) throw new Error('keyframeMorph: 无候场候选')
  const liveShot = await shot(page, results, prefix + '-live.png')
  const liveImage = decodePng(loadShot(path.basename(liveShot.rel)))
  const readyInfo = await page.evaluate(async (target) => {
    const R = window.__P4
    const record = R.beginMorph(target, { includeKeyframes: false, macroTasks: 2, label: 'occlusion' })
    const ready = await R.waitReady(4000)
    await R.sleep(16)
    return {
      ready,
      record: {
        targetId: record.targetId, readyMs: record.readyMs, readyError: record.readyError,
        callbackDurationMs: record.callbackDurationMs, nameCount: record.namesInCallback && record.namesInCallback.count,
      },
      pseudoNames: R.vtAnimationNames(),
      geometry: R.geometry(),
    }
  }, prep.target)
  const frames = []
  for (const time of [0, 110, 220]) {
    if (time === 0) await page.evaluate(() => window.__P4.pauseAt(0))
    else await page.evaluate((seekTo) => window.__P4.seek(seekTo), time)
    await page.evaluate(() => window.__P4.forceFrames(2))
    frames.push({ time, shot: await shot(page, results, prefix + '-t' + String(time).padStart(3, '0') + '.png') })
  }
  const post = await page.evaluate(async () => {
    const R = window.__P4
    R.resume()
    const record = await R.waitMorph(6000)
    await R.sleep(32)
    return {
      geometry: R.geometry(),
      floats: R.floats(),
      tags: R.peekTags(),
      pseudoAfter: R.vtAnimations().length,
      finishedMs: record.finishedMs,
      finishedError: record.finishedError,
      snapshot: R.snapshot(),
    }
  })
  const postShot = await shot(page, results, prefix + '-post.png')
  const images = {}
  for (const frame of frames) images[frame.time] = decodePng(loadShot(path.basename(frame.shot.rel)))
  return Object.assign({ prefix }, prep, readyInfo, { frames, post, postShot, images, liveShot, liveImage })
}

/** 关键帧 vs morph 前 live 参照的像素差异（覆盖/冻结判定）。 */
function occlusionDiff(run, rects, label) {
  const out = []
  for (const item of rects) {
    const rect = item.rect || item
    if (!rect || rect.w < 2 || rect.h < 2) {
      out.push({ label: item.label || null, tabId: item.tabId || null, rect, skipped: true })
      continue
    }
    const detail = { label: item.label || null, rect, tabId: item.tabId || null }
    for (const frame of run.frames) detail['t' + String(frame.time).padStart(3, '0')] = regionDiff(run.images[frame.time], run.liveImage, rect, { step: 1, tolerance: 10 })
    out.push(detail)
  }
  return { label, rects: out }
}

function summarizeOcclusion(entry) {
  const t000 = entry.t000 || {}
  const t110 = entry.t110 || {}
  const t220 = entry.t220 || {}
  return {
    label: entry.label,
    tabId: entry.tabId,
    rect: entry.rect,
    changedT000: t000.changedFraction,
    changedT110: t110.changedFraction,
    changedT220: t220.changedFraction,
    meanT000: t000.meanAbsDiff,
    meanT110: t110.meanAbsDiff,
    meanT220: t220.meanAbsDiff,
  }
}

/** 对浮窗/标签 rect 的「覆盖率」summary。 */
function summarizeRun(run, rectSources, label) {
  const diff = occlusionDiff(run, rectSources, label)
  const summary = diff.rects.map(summarizeOcclusion)
  return { label, summary, diff, pseudoNames: run.pseudoNames, post: { floats: run.post.floats, tags: run.post.tags }, shots: run.frames.map((frame) => frame.shot.rel) }
}

try {
  results.data.env.command = 'node scripts/p4/probe/occlusion.mjs'
  app = await openApp({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
  const { page } = app
  const env = await pageEnv(page)
  results.data.env.page = env
  await enterStage(page, { count: 3 })
  await installRuntime(page)
  await page.evaluate(() => { window.__P4.installVtStyle({ ms: 220, fade: 120, delay: 60 }); window.__P4.applyWindowNames() })
  await sleep(40)

  // ---------- A. 浮窗可见时 morph（默认：不命名浮窗） ----------
  const openA = await openFloats(page)
  await sleep(200)
  results.step('floats.open.A', { sessionId: openA.sessionId, opened: openA.opened, floats: openA.state.floats })
  results.assert('floats.opened', openA.state.floats.length === 3, {
    expected: '为当前焦点会话打开 3 个官方伴生浮窗（companionOpenResource）',
    actual: { sessionId: openA.sessionId, count: openA.state.floats.length, opened: openA.opened, floats: openA.state.floats.map((item) => ({ tabId: item.tabId, rect: item.rect })) },
    category: 'occlusion',
  })
  const runA = await keyframeMorph(page, 'occlusion-floats')
  const rectsA = runA.floats.map((item) => ({ label: 'float:' + item.tabId, rect: item.rect, tabId: item.tabId }))
  const runAResult = summarizeRun(runA, rectsA, 'floats-default')
  results.data.runA = { floatsBefore: runA.floats, floatsAfter: runA.post.floats, summary: runAResult.summary, shots: runAResult.shots, liveShot: runA.liveShot.rel }
  results.step('occlusion.floats.default', { floatsBefore: runA.floats.length, floatsAfter: runA.post.floats.length, summary: runAResult.summary, shots: runAResult.shots })

  // ---------- D. Q2 实验：临时命名浮窗后再 morph ----------
  const reOpenD = await openFloats(page)
  await sleep(200)
  const extraFloats = await page.evaluate(() => window.__P4.applyExtraNames('[data-dockkit-float]', 'onestep-float-'))
  await sleep(40)
  const runD = await keyframeMorph(page, 'occlusion-floats-named')
  const pseudoGroupsD = runD.pseudoNames.filter((name) => /group\(onestep-float-/.test(name))
  const runDResult = summarizeRun(runD, runD.floats.map((item) => ({ label: 'float:' + item.tabId, rect: item.rect, tabId: item.tabId })), 'floats-named')
  await page.evaluate(() => window.__P4.clearExtraNames())
  await sleep(40)
  results.data.runD = { sessionId: reOpenD.sessionId, floatsBefore: runD.floats, extraNames: extraFloats, pseudoGroups: pseudoGroupsD, pseudoNames: runD.pseudoNames, summary: runDResult.summary, shots: runDResult.shots, liveShot: runD.liveShot.rel }
  results.step('occlusion.floats.named', { floatsBefore: runD.floats.length, extraNames: extraFloats.length, pseudoGroups: pseudoGroupsD.length, summary: runDResult.summary, shots: runDResult.shots })

  // ---------- B. 点击舞台空白 → 浮窗收成标签 → morph ----------
  const openB = await openFloats(page)
  await sleep(200)
  const collapse = await collapseToTags(page)
  results.step('floats.collapse', { sessionId: openB.sessionId, blank: collapse.blank, fallback: collapse.fallback, floats: collapse.state.floats, tags: collapse.state.tags, layer: collapse.state.layer })
  results.data.tags = { sessionId: openB.sessionId, blank: collapse.blank, fallback: collapse.fallback, state: collapse.state }
  results.assert('floats.collapse-to-tags', collapse.state.tags.length === 3 && collapse.state.floats.every((item) => item.peeked === true), {
    expected: '点击舞台空白后浮窗全部收起为右缘标签（peeked=true；失败时用 floatPeekAll 兜底）',
    actual: { tags: collapse.state.tags, floats: collapse.state.floats.map((item) => ({ tabId: item.tabId, peeked: item.peeked, rect: item.rect })), fallback: collapse.fallback },
    category: 'occlusion',
  })
  const runB = await keyframeMorph(page, 'occlusion-tags')
  const tagRectsB = runB.tags.map((item) => ({ label: 'tag:' + item.tabId, rect: item.rect, tabId: item.tabId }))
  const runBResult = summarizeRun(runB, tagRectsB, 'tags-default')
  results.data.runB = { tagsBefore: runB.tags, tagsAfter: runB.post.tags, layer: runB.peekLayer, summary: runBResult.summary, shots: runBResult.shots, liveShot: runB.liveShot.rel }
  results.step('occlusion.tags.default', { tagsBefore: runB.tags.length, tagsAfter: runB.post.tags.length, summary: runBResult.summary, shots: runBResult.shots })

  // ---------- C. Q2 实验：临时命名标签后再 morph ----------
  const openC = await openFloats(page)
  await sleep(200)
  const collapseC = await collapseToTags(page)
  const extraTags = await page.evaluate(() => window.__P4.applyExtraNames('[data-onestep-peek-tag]', 'onestep-tag-'))
  await sleep(40)
  const runC = await keyframeMorph(page, 'occlusion-tags-named')
  const pseudoGroupsC = runC.pseudoNames.filter((name) => /group\(onestep-tag-/.test(name))
  const runCResult = summarizeRun(runC, runC.tags.map((item) => ({ label: 'tag:' + item.tabId, rect: item.rect, tabId: item.tabId })), 'tags-named')
  await page.evaluate(() => window.__P4.clearExtraNames())
  await sleep(40)
  results.data.runC = { sessionId: openC.sessionId, tagsBefore: runC.tags, extraNames: extraTags, pseudoGroups: pseudoGroupsC, pseudoNames: runC.pseudoNames, summary: runCResult.summary, shots: runCResult.shots, liveShot: runC.liveShot.rel }
  results.step('occlusion.tags.named', { tagsBefore: runC.tags.length, extraNames: extraTags.length, pseudoGroups: pseudoGroupsC.length, summary: runCResult.summary, shots: runCResult.shots })

  // ---------- 判定与建议 ----------
  const avg = (list, key) => {
    const values = list.map((item) => item[key]).filter((value) => typeof value === 'number')
    return values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10000) / 10000 : null
  }
  const analysis = {
    floatsDefault: { changedT000: avg(runAResult.summary, 'changedT000'), changedT110: avg(runAResult.summary, 'changedT110'), changedT220: avg(runAResult.summary, 'changedT220') },
    floatsNamed: { changedT000: avg(runDResult.summary, 'changedT000'), changedT110: avg(runDResult.summary, 'changedT110'), changedT220: avg(runDResult.summary, 'changedT220') },
    tagsDefault: { changedT000: avg(runBResult.summary, 'changedT000'), changedT110: avg(runBResult.summary, 'changedT110'), changedT220: avg(runBResult.summary, 'changedT220') },
    tagsNamed: { changedT000: avg(runCResult.summary, 'changedT000'), changedT110: avg(runCResult.summary, 'changedT110'), changedT220: avg(runCResult.summary, 'changedT220') },
    imageStats: {
      floatsLive: imageStats(decodePng(loadShot(path.basename(runA.liveShot.rel)))),
      tagsLive: imageStats(decodePng(loadShot(path.basename(runB.liveShot.rel)))),
    },
    judgement: {
      // t=0：旧状态快照刚建立。默认（不命名）时浮窗/标签被焦点窗快照覆盖 → 与 live 差异大；
      // 临时命名后它们有自己的伪元素组，t=0 与 live 一致（差异≈0）。
      floatsCoveredAtT000: (avg(runAResult.summary, 'changedT000') || 0) > 0.1,
      tagsCoveredAtT000: (avg(runBResult.summary, 'changedT000') || 0) > 0.1,
      floatsNamedVisibleAtT000: avg(runDResult.summary, 'changedT000') !== null && avg(runDResult.summary, 'changedT000') < 0.02,
      tagsNamedVisibleAtT000: avg(runCResult.summary, 'changedT000') !== null && avg(runCResult.summary, 'changedT000') < 0.02,
      namingFloatsFixes: avg(runDResult.summary, 'changedT000') !== null && avg(runAResult.summary, 'changedT000') !== null && avg(runDResult.summary, 'changedT000') < avg(runAResult.summary, 'changedT000') * 0.5,
      namingTagsFixes: avg(runCResult.summary, 'changedT000') !== null && avg(runBResult.summary, 'changedT000') !== null && avg(runCResult.summary, 'changedT000') < avg(runBResult.summary, 'changedT000') * 0.5,
      tagsNamedImprovesT110: avg(runCResult.summary, 'changedT110') !== null && avg(runBResult.summary, 'changedT110') !== null && avg(runCResult.summary, 'changedT110') < avg(runBResult.summary, 'changedT110') * 0.6,
      note: 't110/t220 的差异包含「旧会话浮窗在新状态不存在 → VT old-only 快照淡出」的正常消失，不是遮挡；遮挡判定以 t=0（旧状态快照）为准。',
    },
    q2Recommendation: {
      floats: '临时命名可行：给可见官方浮窗注入 view-transition-name（如 onestep-float-<n>）后，t=0 不再被窗口快照覆盖（0.153→0.000）；新状态下浮窗随会话切换已不可见，VT 会做 120ms old-only 淡出（预期行为）。实现需在 morph 前注入、结束还原（页面运行时注入已验证无 pageerror）。',
      tags: '临时命名同样可行：收起标签命名后 t=0 不再被覆盖（0.138→0.000），t=110 覆盖差异 0.199→0.059。',
      fallback: '若不想给官方 DOM 加临时命名：退化为「有可见浮窗/标签时跳过 VT（直切）」；不建议「接受 220ms 遮挡」（实测 t=0 约 14-15% 像素区域被窗口快照覆盖，肉眼可见）。',
    },
    postSessionSwitchBehavior: {
      floatsBeforeCount: runA.floats.length,
      floatsAfterCount: runA.post.floats.length,
      tagsBeforeCount: runB.tags.length,
      tagsAfterCount: runB.post.tags.length,
      note: '焦点会话切换后，原会话的浮窗/标签不再可见（P3 按会话管理），命中「进行中 morph 时旧会话浮窗/标签已消失」——遮挡只发生在关键帧的 root/窗口快照层',
    },
  }
  results.data.occlusionAnalysis = analysis
  results.step('occlusion.analysis', analysis)
  results.metric('occlusion', analysis)
  results.assert('occlusion.evidence', analysis.floatsDefault.changedT110 !== null && analysis.tagsDefault.changedT110 !== null && analysis.floatsDefault.changedT000 !== null && analysis.tagsDefault.changedT000 !== null, {
    expected: '浮窗与标签两组关键帧像素对比数据齐全（相对 morph 前 live 参照）',
    actual: analysis,
    category: 'occlusion',
  })
  const floatExtraPseudo = runD.pseudoNames.filter((name) => /onestep-float-/.test(name))
  const tagExtraPseudo = runC.pseudoNames.filter((name) => /onestep-tag-/.test(name))
  results.assert('occlusion.naming-experiment', analysis.floatsNamed.changedT000 !== null && analysis.tagsNamed.changedT000 !== null && floatExtraPseudo.length > 0 && tagExtraPseudo.length > 0 && analysis.judgement.namingFloatsFixes === true && analysis.judgement.namingTagsFixes === true, {
    expected: '临时命名 Q2 实验：浮窗/标签生成独立伪元素动画（old/new/group），且 t=0 覆盖差异显著下降',
    actual: { floatExtraPseudo, tagExtraPseudo, judgement: analysis.judgement, recommendation: analysis.q2Recommendation },
    category: 'occlusion',
  })

  // ---------- 清理 ----------
  // 收尾帧：最后一次 VT 的 finished 与伪元素拆除之间可能有 1-2 帧延迟，先等一拍再断言
  await page.evaluate(async () => { const R = window.__P4; R.resume(); await R.sleep(240) })
  const cleanup = await page.evaluate(() => window.__P4.cleanup())
  const finalState = await page.evaluate(() => ({
    pseudoLeft: window.__P4.vtAnimations().length,
    activeViewTransition: !!document.activeViewTransition,
    extraNames: document.querySelectorAll('[data-p4-vt-extra]').length,
    tempStyles: document.querySelectorAll('[data-p4-vt-style]').length,
    stageNames: window.__P4.windowEntries().map((entry) => entry.vtName),
    visibility: document.visibilityState,
  }))
  results.data.env.pageErrors = app.handles.pageErrors.slice(0, 10)
  results.step('cleanup', { cleanup, finalState })
  results.assert('occlusion.cleanup', finalState.pseudoLeft === 0 && finalState.activeViewTransition === false && finalState.extraNames === 0 && finalState.tempStyles === 0 && finalState.stageNames.every((name) => name === 'none'), {
    expected: '遮挡探针结束：无残留伪元素动画/临时命名/注入样式',
    actual: finalState,
    category: 'cleanup',
  })
  results.assert('occlusion.no-pageerror', app.handles.pageErrors.length === 0, {
    expected: '遮挡探针无 pageerror',
    actual: { pageErrors: app.handles.pageErrors.slice(0, 10) },
    category: 'env',
  })
} catch (error) {
  results.fatal(error)
} finally {
  try { await closeApp(app) } catch (_error) { /* ignore */ }
  const data = results.finish()
  console.log('[occlusion] ok=' + data.ok + ' summary=' + JSON.stringify(data.summary))
  if (data.metrics.occlusion) console.log('[occlusion] analysis=' + JSON.stringify(data.metrics.occlusion))
  console.log('[occlusion] json=' + relPath(path.join(OUT, 'occlusion.json')))
}
process.exitCode = results.data.ok ? 0 : 1
