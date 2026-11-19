#!/usr/bin/env node
/**
 * P2-7 R9：registry 发布形态探测（只读网络查询）。
 *
 * 检查 npm registry 是否已存在 dsh-onestep（发布前/演练时通常尚未发布）：
 *   - `npm view dsh-onestep version` 的退出码与原始输出；
 *   - 若已发布，记录 dist-tags / versions 供 R9 的 registry 安装形态演练；
 *   - 未发布时 R9 按 [rehearsal.md] 退出判据记 ⚠️（用本地 tarball 形态替代，见 R3）。
 *
 * 用法：node scripts/p2/pack/registry-probe.mjs [--json artifacts/p2/pack/registry.json]
 * 退出码：0 探测完成（无论是否已发布）/ 2 用法或内部错误。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const DEFAULT_OUT = path.join(ROOT, 'artifacts', 'p2', 'pack', 'registry.json')
const PACKAGE = 'dsh-onestep'

function parseArgs(argv) {
  const cfg = { out: DEFAULT_OUT, package: PACKAGE }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json' || arg === '-o') cfg.out = path.resolve(ROOT, argv[++i])
    else if (arg === '--package') cfg.package = argv[++i]
    else throw new Error('unknown argument: ' + arg)
  }
  return cfg
}

function run(command) {
  const started = Date.now()
  try {
    const stdout = execSync(command, { cwd: ROOT, encoding: 'utf8', timeout: 60000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    return { exitCode: 0, stdout: String(stdout).trim().slice(0, 4000), stderr: '', durationMs: Date.now() - started }
  } catch (error) {
    return {
      exitCode: error.status === undefined || error.status === null ? -1 : error.status,
      stdout: String((error.stdout && error.stdout.toString()) || '').trim().slice(0, 4000),
      stderr: String((error.stderr && error.stderr.toString()) || (error.message || '')).trim().slice(0, 4000),
      durationMs: Date.now() - started,
    }
  }
}

function main() {
  let cfg
  try { cfg = parseArgs(process.argv.slice(2)) } catch (error) {
    process.stderr.write('[registry-probe] ' + error.message + '\n')
    process.exitCode = 2
    return
  }
  const result = {
    ok: true,
    probe: 'p2-7-registry',
    startedAt: new Date().toISOString(),
    package: cfg.package,
    commands: {},
    published: null,
    conclusion: null,
  }
  const version = run('npm view ' + cfg.package + ' version')
  result.commands.version = version
  const notFound = version.exitCode !== 0 && /E404|404 Not Found|no such package|could not be found/i.test(version.stdout + ' ' + version.stderr)
  if (version.exitCode === 0 && /^\d+\.\d+\.\d+/.test(version.stdout.split(/\r?\n/)[0] || '')) {
    result.published = true
    result.commands['dist-tags'] = run('npm view ' + cfg.package + ' dist-tags --json')
    result.commands.versions = run('npm view ' + cfg.package + ' versions --json')
    result.conclusion = 'published: registry 安装形态可在 R9 实测（npm install / dsh plugin add 包名@版本）'
  } else if (notFound) {
    result.published = false
    result.conclusion = 'not-published: R9 记 ⚠️，按 rehearsal 退出判据用本地 tarball 形态（R3/R4）替代；发布后 D6 用 registry 包复测'
  } else {
    result.ok = false
    result.conclusion = 'unknown: npm view 失败原因非 404，需人工复核（可能是网络/镜像问题）'
  }
  result.finishedAt = new Date().toISOString()
  fs.mkdirSync(path.dirname(cfg.out), { recursive: true })
  fs.writeFileSync(cfg.out, JSON.stringify(result, null, 2) + '\n', 'utf8')
  process.stdout.write('[registry-probe] published=' + result.published + ' exitCode=' + version.exitCode + ' -> ' + path.relative(ROOT, cfg.out).split(path.sep).join('/') + '\n')
  process.exitCode = result.ok ? 0 : 2
}

main()
