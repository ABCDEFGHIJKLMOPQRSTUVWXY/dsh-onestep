/** 快捷注册分组的二分测试。 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const base = fs.readFileSync(path.join(ROOT, 'artifacts', 'p1', 'server-url-baseline.txt'), 'utf8').trim().replace(/#.*$/, '')
const variants = [
  { name: 'all-on', flags: '' },
  { name: 'only-toggle', flags: 'no-sc-quick,no-sc-close,no-sc-undo,no-sc-focus' },
  { name: 'only-quick', flags: 'no-sc-toggle,no-sc-close,no-sc-undo,no-sc-focus' },
  { name: 'only-close', flags: 'no-sc-toggle,no-sc-quick,no-sc-undo,no-sc-focus' },
  { name: 'only-undo', flags: 'no-sc-toggle,no-sc-quick,no-sc-close,no-sc-focus' },
  { name: 'only-focus', flags: 'no-sc-toggle,no-sc-quick,no-sc-close,no-sc-undo' },
  { name: 'none', flags: 'no-sc-toggle,no-sc-quick,no-sc-close,no-sc-undo,no-sc-focus' },
]
for (const variant of variants) {
  const url = variant.flags ? base + '#onestep=' + variant.flags : base
  const urlFile = path.join(ROOT, 'artifacts', 'p1', 'tmp-url.txt')
  const outFile = path.join(ROOT, 'artifacts', 'p1', 'sc-' + variant.name + '.json')
  fs.writeFileSync(urlFile, url + '\n', 'utf8')
  try {
    execFileSync(process.execPath, [
      path.join(ROOT, 'scripts', 'p0', 'verify', 'playwright-driver.mjs'), 'probe', '--url-file', urlFile,
      '--script', path.join(ROOT, 'artifacts', 'p1', 'probes', 'baseline-check.js'), '--out', outFile, '--print', 'none',
    ], { cwd: ROOT, timeout: 120000, stdio: 'pipe' })
  } catch (_error) { /* driver 失败也看输出 */ }
  let report = { variant: variant.name }
  try {
    const data = JSON.parse(fs.readFileSync(outFile, 'utf8'))
    const errors = (data.console && data.console.messages ? data.console.messages : []).filter((m) => m.level === 'error')
    const registered = (data.console && data.console.messages ? data.console.messages : [])
      .map((m) => String(m.text)).filter((text) => text.includes('shortcut.register')).length
    report.errors = errors.length
    report.registerLogs = registered
    report.firstError = errors.length ? String(errors[0].text).split('\n')[0] : null
  } catch (error) { report.parseError = String(error) }
  console.log(JSON.stringify(report))
}
