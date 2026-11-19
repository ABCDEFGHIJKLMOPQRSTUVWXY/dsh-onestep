#!/usr/bin/env node
/**
 * 一次性跑完 P1 review 的 4 组实机验收探针，并校验 JSON 结果 ok=true。
 * 前置：隔离实例在跑（artifacts/review/server-url.txt）；Playwright 在 tools/pw。
 * 用法：node scripts/review/run-all.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const OUT = path.join(ROOT, 'artifacts', 'review', 'verify')
const CASES = [
  { name: 'verify-fix', result: 'verify-fix.json' },
  { name: 'verify-responsive', result: 'verify-responsive.json' },
  { name: 'verify-controls', result: 'verify-controls.json' },
  { name: 'verify-final', result: 'verify-final.json' },
  { name: 'verify-round2', result: 'verify-round2.json' },
  { name: 'verify-round3', result: 'verify-round3.json' },
]

const urlFile = path.join(ROOT, 'artifacts', 'review', 'server-url.txt')
if (!fs.existsSync(urlFile)) {
  console.error('[review] 缺少 ' + urlFile + '：请先启动隔离实例并写入带 token 的 URL。')
  process.exit(2)
}

const failed = []
for (const testCase of CASES) {
  const file = path.join(ROOT, 'scripts', 'review', testCase.name + '.mjs')
  console.log('\n[review] run ' + testCase.name)
  const run = spawnSync(process.execPath, [file], { cwd: ROOT, stdio: 'inherit' })
  const jsonPath = path.join(OUT, testCase.result)
  let ok = run.status === 0 && fs.existsSync(jsonPath)
  if (ok) {
    try {
      const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
      ok = parsed.ok === true && !parsed.error
      if (!ok) console.error('[review] ' + testCase.name + ' failed assertions: ' + JSON.stringify(parsed.pass))
    } catch (error) {
      ok = false
      console.error('[review] ' + testCase.name + ' result unreadable: ' + String(error))
    }
  }
  if (!ok) failed.push(testCase.name)
}

if (failed.length > 0) {
  console.error('\n[review] FAILED: ' + failed.join(', '))
  process.exit(1)
}
console.log('\n[review] all ' + CASES.length + ' verification suites passed (artifacts/review/verify/*.json)')
