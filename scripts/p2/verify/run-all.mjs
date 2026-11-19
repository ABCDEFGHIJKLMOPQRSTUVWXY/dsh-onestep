#!/usr/bin/env node
/**
 * P2 验证一键门禁：依次运行 a11y-keyboard / perf-bench / lite-degrade，聚合一键结果。
 *
 * - 隔离实例 URL 只从 artifacts/p2/server-url.txt 读取（不启动/不重启实例）。
 * - 运行前后各记录一次 client.js sha256（Lead 可能中途重建；用于报告基线归属）。
 * - 任一 suite 失败（或结果缺失/不可读）→ 退出码 1；基线阶段预期非 0（缺口报告）。
 *
 * 产物：artifacts/p2/verify/run-all.json
 * 用法：node scripts/p2/verify/run-all.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ARTIFACTS, VERIFY_OUT, readServerUrl, baselineInfo } from './lib.mjs'

const SUITES = [
  { name: 'a11y-keyboard', file: 'a11y-keyboard.mjs', result: 'a11y-keyboard.json', title: 'P2-1 无障碍与键盘全流程' },
  { name: 'perf-bench', file: 'perf-bench.mjs', result: 'perf-bench.json', title: 'P2-4 性能基准' },
  { name: 'lite-degrade', file: 'lite-degrade.mjs', result: 'lite-degrade.json', title: 'P2-3 lite 自动降级与手动档位' },
]

const startedAt = new Date().toISOString()
const before = baselineInfo()
const summary = {
  ok: false,
  startedAt,
  finishedAt: null,
  baselineBefore: before,
  baselineAfter: null,
  clientShaChangedDuringRun: null,
  serverUrlFile: path.relative(process.cwd(), path.join(ARTIFACTS, 'server-url.txt')).replace(/\\/g, '/'),
  node: process.version,
  suites: [],
  totals: { assertions: 0, pass: 0, fail: 0, skipped: 0, suitesOk: 0, suitesFailed: 0 },
}

let fatal = null
try {
  readServerUrl()
} catch (error) {
  fatal = String(error && error.message ? error.message : error)
}

if (!fatal) {
  for (const suite of SUITES) {
    const script = path.join(import.meta.dirname, suite.file)
    const resultFile = path.join(VERIFY_OUT, suite.result)
    const started = Date.now()
    console.log('\n[p2-verify] ===== ' + suite.name + ' =====')
    const run = spawnSync(process.execPath, [script], { cwd: process.cwd(), stdio: 'inherit' })
    const durationMs = Date.now() - started
    let parsed = null
    let readError = null
    try {
      parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    } catch (error) {
      readError = String(error && error.message ? error.message : error)
    }
    const entry = {
      name: suite.name,
      title: suite.title,
      exitCode: run.status,
      durationMs,
      resultFile: path.relative(process.cwd(), resultFile).replace(/\\/g, '/'),
      ok: !!(parsed && parsed.ok === true),
      summary: parsed && parsed.summary ? parsed.summary : null,
      error: (parsed && parsed.error) || null,
      readError,
      baselineClientSha256: parsed && parsed.baseline ? parsed.baseline.clientSha256 : null,
    }
    summary.suites.push(entry)
    const s = entry.summary || { total: 0, pass: 0, fail: 0, skipped: 0 }
    summary.totals.assertions += s.total || 0
    summary.totals.pass += s.pass || 0
    summary.totals.fail += s.fail || 0
    summary.totals.skipped += s.skipped || 0
    if (entry.ok) summary.totals.suitesOk += 1
    else summary.totals.suitesFailed += 1
    console.log('[p2-verify] ' + suite.name + ' exit=' + run.status + ' ok=' + entry.ok + ' ' + JSON.stringify(entry.summary))
  }
}

const after = baselineInfo()
summary.finishedAt = new Date().toISOString()
summary.baselineAfter = after
summary.clientShaChangedDuringRun = before.clientSha256 !== after.clientSha256
summary.fatal = fatal
summary.ok = !fatal && summary.totals.suitesFailed === 0 && summary.totals.assertions > 0
fs.mkdirSync(VERIFY_OUT, { recursive: true })
fs.writeFileSync(path.join(VERIFY_OUT, 'run-all.json'), JSON.stringify(summary, null, 2), 'utf8')
console.log('\n[p2-verify] baseline client.js sha256=' + before.clientSha256 + (summary.clientShaChangedDuringRun ? ' (CHANGED during run -> ' + after.clientSha256 + ')' : ' (stable)'))
console.log('[p2-verify] totals ' + JSON.stringify(summary.totals) + ' ok=' + summary.ok + ' -> artifacts/p2/verify/run-all.json')
process.exitCode = summary.ok ? 0 : 1
