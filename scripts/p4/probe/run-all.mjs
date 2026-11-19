/**
 * P4-1 探针总入口：顺序跑 5 个套件并汇总（docs/p4-plan.md §8：node scripts/p4/probe/run-all.mjs）
 *
 * 用法：node scripts/p4/probe/run-all.mjs [--only=capability,reduced,...]
 * 产物：artifacts/p4/probe/run-all.json（各套件 exit code / 耗时 / summary / 关键数字）
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

import { OUT, ROOT, ensureDirs, writeJson, relPath } from './lib.mjs'

const SUITES = [
  { name: 'capability', script: 'capability.mjs', title: '能力探测（VT API / 伪元素 / reduced context）' },
  { name: 'reduced', script: 'reduced.mjs', title: 'reduced motion（三层机制 + 现有降级）' },
  { name: 'morph-prototype', script: 'morph-prototype.mjs', title: '真实舞台 morph（ready/帧率/长任务/关键帧/几何/5连切）' },
  { name: 'morph-scroll', script: 'morph-scroll.mjs', title: '长对话滚动后的快照成本' },
  { name: 'drift-check', script: 'drift-check.mjs', title: '连续 10 次 morph 的 ready 漂移（fresh page）' },
  { name: 'occlusion', script: 'occlusion.mjs', title: '伴生浮窗/收起标签遮挡（含 Q2 临时命名实验）' },
  { name: 'baseline-audit', script: 'baseline-audit.mjs', title: '动效基线审计 + 外部主绑定切换' },
]

const onlyArg = process.argv.find((arg) => arg.startsWith('--only='))
const only = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map((item) => item.trim()).filter(Boolean)) : null
const suites = SUITES.filter((suite) => !only || only.has(suite.name))

ensureDirs()
const startedAt = new Date().toISOString()
const results = []

function runSuite(suite) {
  return new Promise((resolve) => {
    const script = path.join(ROOT, 'scripts', 'p4', 'probe', suite.script)
    const started = Date.now()
    const child = spawn(process.execPath, [script], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch (error) { /* ignore */ }
    }, 600000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, durationMs: Date.now() - started, stdout, stderr })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, durationMs: Date.now() - started, stdout, stderr: String(error) })
    })
  })
}

function readArtifact(name) {
  const file = path.join(OUT, name + '.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    return null
  }
}

/** 从各套件 JSON 提取给文档/汇报用的关键数字。 */
function extractMetrics(name, data) {
  if (!data) return null
  if (name === 'capability') {
    return {
      startViewTransition: data.steps && data.steps.find((step) => step.name === 'vt.api'),
      simple: data.metrics && data.metrics['vt.simple'],
      skip: data.metrics && data.metrics['vt.skip'],
      reducedSimple: data.metrics && data.metrics['vt.simple.reduced'],
      ok: data.ok,
    }
  }
  if (name === 'reduced') {
    return { audit: data.metrics && data.metrics['reduced.audit'], guard: data.metrics && data.metrics['reduced.promoteGuard'], cssFallback: data.metrics && data.metrics['reduced.vt.cssFallback'], ok: data.ok }
  }
  if (name === 'morph-prototype') {
    return {
      budgets: data.metrics && data.metrics['perf1440.budgets'],
      decomposition: data.metrics && data.metrics.decomposition,
      keyframe1440: data.metrics && data.metrics.keyframe1440,
      keyframe1280: data.metrics && data.metrics.keyframe1280,
      scrolled: data.metrics && data.metrics['perf.scrolled'],
      rapid: data.metrics && data.metrics.rapid,
      pairing: data.keyframe1440 && data.keyframe1440.pairing && data.keyframe1440.pairing.map((item) => ({ sessionId: item.sessionId, roleBefore: item.roleBefore, roleAfter: item.roleAfter, startMatches: item.startMatches, endMatches: item.endMatches })),
      keyframePixels: data.keyframePixels1440 && { diff0to110: data.keyframePixels1440.diff0to110 && data.keyframePixels1440.diff0to110.changedFraction, diff110to220: data.keyframePixels1440.diff110to220 && data.keyframePixels1440.diff110to220.changedFraction, diff220toPost: data.keyframePixels1440.diff220toPost && data.keyframePixels1440.diff220toPost.changedFraction, imageStats: data.keyframePixels1440.imageStats },
      shots: data.screenshots,
      ok: data.ok,
      failedNames: data.summary && data.summary.failedNames,
    }
  }
  if (name === 'occlusion') {
    return { analysis: data.metrics && data.metrics.occlusion, shots: data.screenshots, ok: data.ok, failedNames: data.summary && data.summary.failedNames }
  }
  if (name === 'morph-scroll') {
    return { metrics: data.metrics.scroll, shots: data.screenshots, ok: data.ok, failedNames: data.summary && data.summary.failedNames }
  }
  if (name === 'drift-check') {
    return { runs: data.runs, summarySeries: data.summarySeries, ok: data.ok, failedNames: data.summary && data.summary.failedNames }
  }
  if (name === 'baseline-audit') {
    return {
      pulse: data.pulse && { before: data.pulse.before, running: data.pulse.running, actualRunningDotsInInstance: data.pulse.actualRunningDotsInInstance },
      flash: data.flash && { animations: data.flash.animations },
      flashLife: data.flashLife,
      candidateHover: data.candidateHover,
      peek: data.peek && { tag: data.peek.peek && data.peek.peek.tag, tagHover: data.peek.tagHover, stageTokenBaseOnTag: data.peek.peek && data.peek.peek.stageTokenBaseOnTag },
      quick: data.quick,
      external: data.external && { beforeFocus: data.external.beforeFocus, afterFocus: data.external.after && data.external.after.geometry.snapshot.focusId, track: data.external.track && { rectChangeIndex: data.external.track.rectChangeIndex, focusIdChangeIndex: data.external.track.focusIdChangeIndex, distinctFocusRects: data.external.track.distinctFocusRects, pseudoMax: data.external.track.pseudoMax }, vtCallsDuringSwitch: data.external.vtCallsDuringSwitch },
      planComparison: data.planComparison && data.planComparison.map((item) => ({ row: item.planRow, status: item.status })),
      supplements: data.supplements,
      ok: data.ok,
      failedNames: data.summary && data.summary.failedNames,
    }
  }
  return { ok: data.ok }
}

console.log('[p4-probe] 运行套件: ' + suites.map((suite) => suite.name).join(' → '))
for (const suite of suites) {
  process.stdout.write('[p4-probe] ' + suite.name + ' ... ')
  const outcome = await runSuite(suite)
  const data = readArtifact(suite.name)
  const entry = {
    name: suite.name,
    title: suite.title,
    script: 'scripts/p4/probe/' + suite.script,
    exitCode: outcome.code,
    durationMs: outcome.durationMs,
    ok: !!(data && data.ok),
    summary: data && data.summary,
    json: 'artifacts/p4/probe/' + suite.name + '.json',
    metrics: extractMetrics(suite.name, data),
    stdoutTail: outcome.stdout.slice(-3000),
    stderrTail: outcome.stderr.slice(-3000),
  }
  results.push(entry)
  console.log((entry.ok ? 'OK' : 'FAIL') + ' (' + Math.round(outcome.durationMs / 1000) + 's, exit=' + outcome.code + ')')
}

const finishedAt = new Date().toISOString()
const allOk = results.every((entry) => entry.ok)
const morph = results.find((entry) => entry.name === 'morph-prototype')
const occlusion = results.find((entry) => entry.name === 'occlusion')
const payload = {
  suite: 'p4-probe-run-all',
  title: 'P4-1 动效基线与能力探针（Go/No-Go）',
  startedAt,
  finishedAt,
  totalMs: Date.parse(finishedAt) - Date.parse(startedAt),
  commands: {
    runAll: 'node scripts/p4/probe/run-all.mjs',
    single: suites.map((suite) => 'node scripts/p4/probe/' + suite.script),
    serverStatus: 'powershell -File scripts/p3/probe/server.ps1 -Action status',
  },
  suites: results,
  allOk,
  headline: {
    ready: morph && morph.metrics && morph.metrics.budgets && morph.metrics.budgets.ready,
    readyP95: morph && morph.metrics && morph.metrics.budgets && morph.metrics.budgets.readyP95,
    frameCleanP95: morph && morph.metrics && morph.metrics.budgets && morph.metrics.budgets.frameCleanP95,
    frameRawP95: morph && morph.metrics && morph.metrics.budgets && morph.metrics.budgets.frameRawP95,
    longtasks: morph && morph.metrics && morph.metrics.budgets && { animationPhase: morph.metrics.budgets.longtaskAnimationPhase, callbackPhase: morph.metrics.budgets.longtaskCallbackPhase, noopVt: morph.metrics.budgets.noopVtLongtasks },
    vtReadyOverhead: morph && morph.metrics && morph.metrics.budgets && morph.metrics.budgets.readyOverhead,
    occlusionJudgement: occlusion && occlusion.metrics && occlusion.metrics.analysis && occlusion.metrics.analysis.judgement,
    occlusionChange: occlusion && occlusion.metrics && occlusion.metrics.analysis && { floatsDefault: occlusion.metrics.analysis.floatsDefault, floatsNamed: occlusion.metrics.analysis.floatsNamed, tagsDefault: occlusion.metrics.analysis.tagsDefault, tagsNamed: occlusion.metrics.analysis.tagsNamed },
  },
}
ensureDirs()
writeJson(path.join(OUT, 'run-all.json'), payload)
console.log('')
console.log('[p4-probe] allOk=' + allOk + ' total=' + Math.round(payload.totalMs / 1000) + 's')
console.table(results.map((entry) => ({ suite: entry.name, ok: entry.ok, exit: entry.exitCode, seconds: Math.round(entry.durationMs / 1000), failed: entry.summary ? entry.summary.failedNames.join(',') : 'n/a' })))
console.log('[p4-probe] json=' + relPath(path.join(OUT, 'run-all.json')))
process.exitCode = allOk ? 0 : 1
