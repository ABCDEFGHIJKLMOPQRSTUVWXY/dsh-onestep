/**
 * P3-1 探针套件总入口：依次跑 g1-frames / g2-slots / g3-dom / g4-split，
 * 汇总写 artifacts/p3/probe/run-all.json；任一失败退出码 1。
 *
 * 每个套件是独立 Node 进程、独立浏览器 context（官方布局持久化互不影响），
 * 也可以单独执行：`node scripts/p3/probe/<suite>.mjs`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { PROBE_OUT, Results, ROOT, ensureDir, log } from './lib.mjs'

const SUITES = [
  { id: 'g1-frames', file: 'g1-frames.mjs', gate: 'G1', title: '默认打开不重排（逐帧）' },
  { id: 'g2-slots', file: 'g2-slots.mjs', gate: 'G2', title: '多浮窗槽位' },
  { id: 'g3-dom', file: 'g3-dom.mjs', gate: 'G3', title: 'DOM 注入 + z 层 + 点击外部' },
  { id: 'g4-split', file: 'g4-split.mjs', gate: 'G4', title: 'dock 分屏 / 回浮窗 / 刷新' },
]

const results = new Results('run-all', 'P3-1 探针套件总跑')
const startedAt = new Date().toISOString()
const suiteRuns = []

for (const suite of SUITES) {
  const scriptFile = path.join(ROOT, 'scripts', 'p3', 'probe', suite.file)
  const outFile = path.join(PROBE_OUT, suite.id + '.json')
  const started = Date.now()
  log('\n===== [' + suite.gate + '] ' + suite.file + ' =====')
  const run = spawnSync(process.execPath, [scriptFile], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 600000,
    env: process.env,
  })
  const durationMs = Date.now() - started
  let summary = null
  let ok = false
  try {
    const data = JSON.parse(fs.readFileSync(outFile, 'utf8'))
    summary = data.summary || null
    ok = data.ok === true
  } catch (error) {
    summary = { error: 'missing or invalid result json: ' + String(error && error.message ? error.message : error).slice(0, 200) }
    ok = false
  }
  suiteRuns.push({
    id: suite.id,
    gate: suite.gate,
    title: suite.title,
    exitCode: run.status === null ? 'null(' + String(run.signal || 'unknown') + ')' : run.status,
    durationMs,
    ok,
    summary,
    resultFile: path.relative(ROOT, outFile).replace(/\\/g, '/'),
  })
  results.step('suite.run', suiteRuns[suiteRuns.length - 1])
}

const failed = suiteRuns.filter((suite) => !suite.ok)
const runAll = {
  startedAt,
  finishedAt: new Date().toISOString(),
  durationMs: suiteRuns.reduce((total, suite) => total + suite.durationMs, 0),
  suites: suiteRuns,
  gates: Object.fromEntries(suiteRuns.map((suite) => [suite.gate, suite.ok ? 'go' : 'no-go'])),
  ok: failed.length === 0,
  failedSuites: failed.map((suite) => suite.id),
}
ensureDir(PROBE_OUT)
fs.writeFileSync(path.join(PROBE_OUT, 'run-all.json'), JSON.stringify(runAll, null, 2), 'utf8')
results.assert('run-all.all.suites.pass', failed.length === 0, {
  actual: { suites: suiteRuns.map((suite) => ({ id: suite.id, exitCode: suite.exitCode, ok: suite.ok, summary: suite.summary })), gates: runAll.gates },
  expected: { failedSuites: [] },
  category: 'run-all',
})
const data = results.finish({ runAll })
log('\n[run-all] gates ' + JSON.stringify(runAll.gates) + ' ok=' + runAll.ok)
process.exit(runAll.ok ? 0 : 1)
