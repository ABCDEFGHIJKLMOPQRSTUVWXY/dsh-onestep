/**
 * P4-9 验证套件入口：顺序跑 m1-m6，汇总 artifacts/p4/verify/run-all.json。
 *
 * 运行：
 *   node scripts/p4/verify/run-all.mjs                  # 全量
 *   node scripts/p4/verify/run-all.mjs --only m1,m2     # 子集
 *   node scripts/p4/verify/run-all.mjs --list           # 列出套件
 *
 * 任一 suite 失败（断言失败 / fatal / 退出码非 0）→ 汇总 ok=false，进程退出码 1。
 * 每个 suite 自己写 artifacts/p4/verify/<suite>.json（P3 Results 风格）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { ROOT, OUT, ensureDirs, baselineInfo, relPath } from './lib.mjs'

const SUITES = [
  { id: 'm1', suite: 'm1-morph', title: 'G3 舞台几何 morph', file: 'm1-morph.mjs' },
  { id: 'm2', suite: 'm2-stage', title: 'G4/G5 舞台进场/栏/反馈', file: 'm2-stage.mjs' },
  { id: 'm3', suite: 'm3-overlays', title: 'G6 覆盖层动效', file: 'm3-overlays.mjs' },
  { id: 'm4', suite: 'm4-peek', title: 'G7 伴生窗 peek 动效', file: 'm4-peek.mjs' },
  { id: 'm5', suite: 'm5-reduced', title: 'G8 reduced motion 全量', file: 'm5-reduced.mjs' },
  { id: 'm6', suite: 'm6-perf', title: 'G9 性能与清理', file: 'm6-perf.mjs' },
]

const argv = process.argv.slice(2)
let onlyList = null
let listOnly = false
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index]
  if (arg === '--list') {
    listOnly = true
    continue
  }
  if (arg === '--only' || arg.startsWith('--only=')) {
    const value = arg === '--only' ? argv[++index] : arg.slice('--only='.length)
    if (onlyList !== null || !value || value.startsWith('--')) {
      console.error('--only 必须指定一次非空的 suite 列表，例如 --only m1,m2')
      process.exit(2)
    }
    onlyList = value.split(',').map((item) => item.trim()).filter(Boolean)
    if (onlyList.length === 0) {
      console.error('--only 必须指定非空的 suite 列表')
      process.exit(2)
    }
    continue
  }
  console.error('未知参数：' + arg)
  process.exit(2)
}
if (onlyList) {
  const unknown = onlyList.filter((name) => !SUITES.some((item) => item.id === name || item.suite === name))
  if (unknown.length > 0) {
    console.error('未知 suite：' + unknown.join(','))
    process.exit(2)
  }
}
const selected = onlyList
  ? SUITES.filter((item) => onlyList.includes(item.id) || onlyList.includes(item.suite))
  : SUITES

if (listOnly) {
  for (const item of selected) console.log(item.id + '  ' + item.suite + '  ' + item.title)
  process.exit(0)
}
ensureDirs()

const startedAt = new Date().toISOString()
const report = {
  suite: 'run-all',
  title: 'P4-9 验证套件 m1-m6',
  ok: false,
  startedAt,
  finishedAt: null,
  baseline: baselineInfo(),
  order: selected.map((item) => item.suite),
  suites: [],
  failed: [],
  env: {
    node: process.version,
    platform: process.platform,
    urlFile: 'artifacts/p3/server-url.txt',
    note: '隔离实例由 P3 server.ps1 维护，本套件不启动/重启实例',
  },
}

try {
  for (const item of selected) {
    const script = path.join(ROOT, 'scripts', 'p4', 'verify', item.file)
    const suiteStarted = Date.now()
    console.log('')
    console.log('========== [' + item.id + '] ' + item.suite + ' :: ' + item.title + ' ==========')
    const result = spawnSync(process.execPath, [script], {
      cwd: ROOT,
      stdio: 'inherit',
      timeout: 15 * 60 * 1000,
    })
    const exitCode = result.status === null ? -1 : result.status
    const durationMs = Date.now() - suiteStarted
    const jsonFile = path.join(OUT, item.suite + '.json')
    let data = null
    try {
      data = JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
    } catch (_error) {
      data = null
    }
    const failedAssertions = data && Array.isArray(data.assertions) ? data.assertions.filter((assertion) => !assertion.pass) : []
    const record = {
      id: item.id,
      suite: item.suite,
      title: item.title,
      ok: !!(data && data.ok === true) && exitCode === 0,
      exitCode,
      signal: result.signal || null,
      durationMs,
      file: relPath(jsonFile),
      summary: data ? data.summary : null,
      error: data ? data.error : (result.error ? String(result.error) : null),
      failedAssertions: failedAssertions.map((assertion) => ({
        name: assertion.name,
        category: assertion.category,
        expected: assertion.expected,
        actual: assertion.actual,
        note: assertion.note,
      })),
      skips: data && Array.isArray(data.skips) ? data.skips.map((skip) => ({ name: skip.name, reason: skip.reason, category: skip.category })) : [],
      metrics: data ? data.metrics : null,
    }
    report.suites.push(record)
    if (!record.ok) {
      report.failed.push({
        suite: item.suite,
        exitCode,
        failedAssertions: record.failedAssertions,
        error: record.error,
      })
      console.error('[' + item.suite + '] FAIL exitCode=' + exitCode + ' failed=' + failedAssertions.length)
    } else {
      console.log('[' + item.suite + '] PASS (' + Math.round(durationMs / 1000) + 's, ' + (data && data.summary ? data.summary.pass : '?') + ' assertions)')
    }
  }
} catch (error) {
  report.error = String((error && error.stack) || error)
  console.error('[run-all] FATAL ' + report.error)
} finally {
  report.finishedAt = new Date().toISOString()
  report.ok = report.failed.length === 0 && !report.error
  const outFile = path.join(OUT, 'run-all.json')
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8')
  console.log('')
  console.log('[run-all] wrote ' + relPath(outFile) + ' ok=' + report.ok + ' suites=' + report.suites.map((item) => item.suite + ':' + (item.ok ? 'pass' : 'FAIL')).join(' '))
  if (!report.ok) {
    for (const failed of report.failed) {
      console.log('  FAIL ' + failed.suite + ' exitCode=' + failed.exitCode)
      for (const assertion of failed.failedAssertions) {
        console.log('    - ' + assertion.name + ' expected=' + JSON.stringify(assertion.expected) + ' actual=' + JSON.stringify(assertion.actual))
      }
      if (failed.error) console.log('    fatal: ' + String(failed.error).slice(0, 800))
    }
  }
  process.exitCode = report.ok ? 0 : 1
}
