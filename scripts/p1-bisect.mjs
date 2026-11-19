/**
 * P1 诊断二分：逐个关闭插件注册块，定位「哪个注册影响官方插件激活（sidebar-right failed）」。
 * 用法：node scripts/p1-bisect.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const base = fs.readFileSync(path.join(ROOT, 'artifacts', 'p1', 'server-url-baseline.txt'), 'utf8').trim()
const tokenUrl = base.replace(/#.*$/, '')
const variants = [
  { name: 'all-off', flags: 'no-locale,no-shortcuts,no-entries,no-overlay,no-sessions,no-main' },
  { name: 'no-main', flags: 'no-main' },
  { name: 'no-entries', flags: 'no-entries' },
  { name: 'no-overlay', flags: 'no-overlay' },
  { name: 'no-sessions', flags: 'no-sessions' },
  { name: 'no-shortcuts', flags: 'no-shortcuts' },
  { name: 'no-locale', flags: 'no-locale' },
]

for (const variant of variants) {
  const url = tokenUrl + '#onestep=' + variant.flags
  const urlFile = path.join(ROOT, 'artifacts', 'p1', 'tmp-url.txt')
  const outFile = path.join(ROOT, 'artifacts', 'p1', 'bisect-' + variant.name + '.json')
  fs.writeFileSync(urlFile, url + '\n', 'utf8')
  let ok = false
  try {
    execFileSync(
      process.execPath,
      [
        path.join(ROOT, 'scripts', 'p0', 'verify', 'playwright-driver.mjs'),
        'probe',
        '--url-file',
        urlFile,
        '--script',
        path.join(ROOT, 'artifacts', 'p1', 'probes', 'baseline-check.js'),
        '--out',
        outFile,
        '--print',
        'none',
      ],
      { cwd: ROOT, timeout: 120000, stdio: 'pipe' },
    )
    ok = true
  } catch (error) {
    ok = false
  }
  let report = { variant: variant.name, ok, driverOk: false }
  try {
    const data = JSON.parse(fs.readFileSync(outFile, 'utf8'))
    const errors = (data.console && data.console.messages ? data.console.messages : [])
      .filter((message) => message.level === 'error')
      .map((message) => String(message.text).split('\n')[0])
    report.driverOk = !!data.ok
    report.bootErrorCount = errors.length
    report.firstErrors = errors.slice(0, 3)
    report.value = data.probe && data.probe.value
  } catch (error) {
    report.parseError = String(error)
  }
  console.log(JSON.stringify(report))
}
