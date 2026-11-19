/**
 * P3-6 一键门禁：`npm run p3:verify`。
 *
 * 依次运行：P3-1 探针 G1–G4（scripts/p3/probe/run-all.mjs）→ 产品 e2e（P3-4/10、P3-11、P3-12）
 * → G5 回退 → G6 生命周期 → G7 回归（单测/构建/i18n/compat）→ G8 视觉/无障碍。
 * 汇总写 artifacts/p3/verify/run-all.json；任一 suite 失败退出码 1。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { ROOT, ARTIFACTS, readServerUrl, baselineInfo, sleep } from '../probe/lib.mjs'

const VERIFY_OUT = path.join(ARTIFACTS, 'verify')
const OUT_FILE = path.join(VERIFY_OUT, 'run-all.json')

const SUITES = [
  { id: 'probe-g1-g4', title: 'P3-1 探针 G1–G4（逐帧/槽位/DOM/分屏）', script: path.join(ROOT, 'scripts', 'p3', 'probe', 'run-all.mjs'), result: path.join(ARTIFACTS, 'probe', 'run-all.json') },
  { id: 'product-floats', title: 'P3-4/P3-10 产品链路 e2e', script: path.join(ROOT, 'scripts', 'p3', 'verify', 'product-floats.mjs'), result: path.join(VERIFY_OUT, 'product-floats.json') },
  { id: 'peek-tags', title: 'P3-11 收起与边缘标签层 e2e', script: path.join(ROOT, 'scripts', 'p3', 'verify', 'peek-tags.mjs'), result: path.join(VERIFY_OUT, 'peek-tags.json') },
  { id: 'split-mode', title: 'P3-12 手动分屏 e2e', script: path.join(ROOT, 'scripts', 'p3', 'verify', 'split-mode.mjs'), result: path.join(VERIFY_OUT, 'split-mode.json') },
  { id: 'g5-fallback', title: 'G5 回退（错误透传/直通/能力自检）', script: path.join(ROOT, 'scripts', 'p3', 'verify', 'g5-fallback.mjs'), result: path.join(VERIFY_OUT, 'g5-fallback.json') },
  { id: 'g6-lifecycle', title: 'G6 生命周期（刷新残留/包装还原重装）', script: path.join(ROOT, 'scripts', 'p3', 'verify', 'g6-lifecycle.mjs'), result: path.join(VERIFY_OUT, 'g6-lifecycle.json') },
  { id: 'g7-regression', title: 'G7 回归（单测/构建/i18n/compat）', script: path.join(ROOT, 'scripts', 'p3', 'verify', 'g7-regression.mjs'), result: path.join(VERIFY_OUT, 'g7-regression.json') },
  { id: 'g8-visual', title: 'G8 视觉/无障碍（主题/视口/键盘/动效）', script: path.join(ROOT, 'scripts', 'p3', 'verify', 'g8-visual.mjs'), result: path.join(VERIFY_OUT, 'g8-visual.json') },
  { id: 'release-hygiene', title: '发布自查（包内容/token/忽略规则/文档完整性）', script: path.join(ROOT, 'scripts', 'p3', 'verify', 'release-hygiene.mjs'), result: path.join(VERIFY_OUT, 'release-hygiene.json') },
]

const summary = {
  suite: 'p3-verify',
  title: 'P3-6 一键门禁',
  ok: false,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  baseline: baselineInfo(),
  env: { node: process.version },
  steps: [],
  totals: { suites: 0, ok: 0, failed: 0, assertions: 0, pass: 0, fail: 0, skipped: 0 },
  error: null,
}

fs.mkdirSync(VERIFY_OUT, { recursive: true })
let fatal = null
try {
  readServerUrl()
} catch (error) {
  fatal = String((error && error.message) || error)
}
if (!fatal) {
  for (const suite of SUITES) {
    const started = Date.now()
    const run = spawnSync(process.execPath, [suite.script], { cwd: ROOT, stdio: 'inherit', timeout: 600000 })
    const durationMs = Date.now() - started
    let parsed = null
    let readError = null
    try {
      parsed = JSON.parse(fs.readFileSync(suite.result, 'utf8'))
    } catch (error) {
      readError = String((error && error.message) || error)
    }
    // 产品 e2e 套件用 steps 记录（无 assertions 数组）：转成统一 summary 便于汇总。
    const derivedSummary = parsed && parsed.summary
      ? parsed.summary
      : parsed && Array.isArray(parsed.steps)
        ? { total: parsed.steps.length, pass: parsed.ok ? parsed.steps.length : Math.max(0, parsed.steps.length - 1), fail: parsed.ok ? 0 : 1, skipped: 0, failedNames: parsed.ok ? [] : ['steps'] }
        : null
    const entry = {
      id: suite.id,
      title: suite.title,
      exitCode: run.status,
      durationMs,
      ok: !!(run.status === 0 && parsed && parsed.ok === true),
      summary: derivedSummary,
      resultFile: path.relative(ROOT, suite.result).replace(/\\/g, '/'),
      readError,
      error: parsed && parsed.error ? parsed.error : null,
    }
    summary.steps.push(entry)
    summary.totals.suites += 1
    if (entry.ok) summary.totals.ok += 1
    else summary.totals.failed += 1
    const counts = entry.summary || {}
    summary.totals.assertions += counts.total || 0
    summary.totals.pass += counts.pass || 0
    summary.totals.fail += counts.fail || 0
    summary.totals.skipped += counts.skipped || 0
    console.log('[p3-verify] ' + suite.id + ' exit=' + run.status + ' ok=' + entry.ok + ' ' + JSON.stringify(counts))
    await sleep(80)
  }
}
summary.finishedAt = new Date().toISOString()
summary.baselineAfter = baselineInfo()
summary.fatal = fatal
summary.ok = !fatal && summary.totals.failed === 0 && summary.totals.suites > 0
fs.writeFileSync(OUT_FILE, JSON.stringify(summary, null, 2), 'utf8')
console.log('\n[p3-verify] totals ' + JSON.stringify(summary.totals) + ' ok=' + summary.ok + ' -> ' + path.relative(ROOT, OUT_FILE))
process.exitCode = summary.ok ? 0 : 1
