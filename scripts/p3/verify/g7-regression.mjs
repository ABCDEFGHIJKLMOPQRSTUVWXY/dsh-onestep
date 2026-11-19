/**
 * P3-6 G7 回归门禁：单测 / 构建一致性 / i18n / compat smoke（针对隔离实例）。
 * 产物：artifacts/p3/verify/g7-regression.json（含每条命令 exitCode 与输出尾部）。
 */
import path from 'node:path'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

import { ROOT, Results, readServerUrl, sleep } from '../probe/lib.mjs'

const OUT = path.join(ROOT, 'artifacts', 'p3', 'verify')
const results = new Results('g7-regression', 'P3-6 G7 回归（单测/构建/i18n/compat）', path.join(OUT, 'g7-regression.json'))

function run(label, command, args, options = {}) {
  const started = Date.now()
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: options.timeout || 300000,
    shell: options.shell === true,
    env: { ...process.env },
  })
  const tail = String((result.stdout || '') + (result.stderr || '')).trim().split(/\r?\n/).slice(-12).join('\n')
  const record = { label, command: command + ' ' + args.join(' '), exitCode: result.status, durationMs: Date.now() - started, tail: tail.slice(0, 2000) }
  results.step(label, record)
  results.assert('g7.' + label, result.status === 0, { actual: { exitCode: result.status, tail: tail.slice(-600) } })
  return record
}

try {
  readServerUrl()
  run('build-check', process.execPath, [path.join(ROOT, 'scripts', 'build.mjs'), '--check'])
  run('unit-tests', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test'], { shell: true, timeout: 240000 })
  run('i18n', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'i18n:check'], { shell: true, timeout: 180000 })
  run('compat-smoke', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'compat:smoke', '--', '--url-file', 'artifacts/p3/server-url.txt', '--out', 'artifacts/p3/verify/compat-smoke.json'], { shell: true, timeout: 240000 })
  await sleep(50)
} catch (error) {
  results.fatal(error)
}
const summary = results.finish()
fs.mkdirSync(OUT, { recursive: true })
process.exitCode = summary.ok ? 0 : 1
