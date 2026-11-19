#!/usr/bin/env node
/**
 * P2-7 R6/R8：从仓库生成 tmp 演练副本（不改仓库）。
 *
 * - 复制发布所需文件（package.json / index.js / client.js / cordis.patch.yml / README.md / LICENSE）
 *   与构建输入（src/**、scripts/build.mjs）；
 * - `--version`：把 package.json、index.js、src/client/index.js 三处 VERSION 同步改为临时版本，
 *   然后在副本里跑 `node scripts/build.mjs` 重建 client.js（与真实发版一致：改版本 → 重建）；
 * - `--corrupt-client`：把副本 client.js 前置一段语法错误（R8 坏 bundle 负向），不做构建覆盖；
 * - 用 `node --check` 记录 client.js 语法状态，产出 JSON 证据。
 *
 * 用法：
 *   node scripts/p2/pack/make-copy.mjs --dest tmp/release-copy --version 0.1.0-p2.0-rehearsal --out artifacts/p2/pack/upgrade-copy.json
 *   node scripts/p2/pack/make-copy.mjs --dest tmp/bad-copy --corrupt-client --out artifacts/p2/pack/bad-copy.json
 *
 * 安全：只允许写入仓库 tmp/ 下；拒绝删除/覆盖其它路径。
 * 退出码：0 成功 / 1 失败 / 2 用法。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const TMP_ROOT = path.join(ROOT, 'tmp')
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', 'p2', 'pack')

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase()
const read = (file) => fs.readFileSync(file, 'utf8')
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8') }

function parseArgs(argv) {
  const cfg = { dest: path.join(TMP_ROOT, 'release-copy'), version: null, corruptClient: false, out: path.join(ARTIFACT_DIR, 'copy.json'), tag: 'copy' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dest') cfg.dest = path.resolve(ROOT, argv[++i])
    else if (arg === '--version') cfg.version = argv[++i]
    else if (arg === '--corrupt-client') cfg.corruptClient = true
    else if (arg === '--out') cfg.out = path.resolve(ROOT, argv[++i])
    else if (arg === '--tag') cfg.tag = argv[++i]
    else throw new Error('unknown argument: ' + arg)
  }
  return cfg
}

function assertSafeDest(dest) {
  const resolved = path.resolve(dest)
  const rel = path.relative(TMP_ROOT, resolved)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw Object.assign(new Error('refusing dest outside tmp/: ' + resolved), { code: 'USAGE' })
  }
  if (resolved === ROOT) throw Object.assign(new Error('refusing to use repo root as dest'), { code: 'USAGE' })
  return resolved
}

function copyFile(rel) {
  const src = path.join(ROOT, rel)
  if (!fs.existsSync(src)) throw new Error('missing source file: ' + rel)
  write(path.join(DEST, rel), read(src))
}

function copyDir(rel) {
  const srcDir = path.join(ROOT, rel)
  if (!fs.existsSync(srcDir)) throw new Error('missing source dir: ' + rel)
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const childRel = path.join(rel, entry.name)
    if (entry.isDirectory()) copyDir(childRel)
    else if (entry.isFile()) copyFile(childRel)
  }
}

const cfg = (() => { try { return parseArgs(process.argv.slice(2)) } catch (error) { process.stderr.write('[make-copy] ' + error.message + '\n'); process.exitCode = 2; return null } })()
if (!cfg) process.exit()
const DEST = (() => { try { return assertSafeDest(cfg.dest) } catch (error) { process.stderr.write('[make-copy] ' + error.message + '\n'); process.exitCode = 2; return null } })()
if (!DEST) process.exit()

const t0 = Date.now()
const result = { ok: false, tag: cfg.tag, dest: path.relative(ROOT, DEST).split(path.sep).join('/'), version: cfg.version, corruptClient: cfg.corruptClient, steps: [], files: {}, error: null }
const step = (name, data) => { result.steps.push({ name, at: new Date().toISOString(), data: data === undefined ? null : data }) }

try {
  // 1) 清空并重建副本目录（仅限 tmp/ 内）
  fs.rmSync(DEST, { recursive: true, force: true })
  fs.mkdirSync(DEST, { recursive: true })
  step('dest.reset', { dest: result.dest })
  for (const rel of ['package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'LICENSE', path.join('scripts', 'build.mjs')]) copyFile(rel)
  copyDir('src')
  step('copy.files', { files: ['package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'LICENSE', 'scripts/build.mjs', 'src/**'] })

  // 2) 版本号同步（package.json + index.js + src/client/index.js）
  if (cfg.version) {
    const pkgPath = path.join(DEST, 'package.json')
    const pkg = JSON.parse(read(pkgPath))
    const fromVersion = pkg.version
    pkg.version = cfg.version
    write(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
    for (const rel of ['index.js', 'src/client/index.js']) {
      const file = path.join(DEST, rel)
      const text = read(file)
      const next = text.replace(/const VERSION = '[^']*'/, "const VERSION = '" + cfg.version + "'")
      if (next === text) throw new Error('VERSION constant not found in ' + rel)
      write(file, next)
    }
    step('version.bump', { from: fromVersion, to: cfg.version, files: ['package.json', 'index.js', 'src/client/index.js'] })
  }

  // 3) 坏 bundle：前置语法错误（不构建，保留坏文件）
  if (cfg.corruptClient) {
    const clientPath = path.join(DEST, 'client.js')
    const original = read(clientPath)
    write(clientPath, '/* P2-7 R8 negative smoke: intentionally broken bundle */\nvar __p2_7_bad = ;\n' + original)
    step('client.corrupt', { file: 'client.js', injection: 'var __p2_7_bad = ;' })
  } else if (cfg.version) {
    // 4) 构建（真实发版路径：改版本 → 重建 client.js）
    const build = spawnSync(process.execPath, [path.join(DEST, 'scripts', 'build.mjs')], { cwd: DEST, encoding: 'utf8', timeout: 120000, windowsHide: true })
    step('build', { exitCode: build.status, stdout: String(build.stdout || '').trim().slice(0, 1200), stderr: String(build.stderr || '').trim().slice(0, 1200) })
    if (build.status !== 0) throw new Error('build failed in copy: ' + String(build.stderr || '').slice(0, 800))
  } else {
    step('build', { skipped: 'no version bump; copy keeps repository client.js' })
  }

  // 5) client.js / index.js 语法与指纹
  for (const rel of ['client.js', 'index.js', 'package.json', 'src/client/index.js']) {
    const file = path.join(DEST, rel)
    const check = spawnSync(process.execPath, ['--check', file], { cwd: DEST, encoding: 'utf8', timeout: 60000, windowsHide: true })
    result.files[rel] = {
      sha256: sha256File(file),
      bytes: fs.statSync(file).size,
      syntaxCheckExit: check.status,
      syntaxCheckError: check.status === 0 ? null : String(check.stderr || check.stdout || '').trim().split(/\r?\n/).slice(0, 6).join(' | ').slice(0, 800),
    }
  }
  const versionText = read(path.join(DEST, 'src/client/index.js')).match(/const VERSION = '([^']*)'/)
  result.effectiveVersion = versionText ? versionText[1] : null
  result.vsRepo = {
    repoVersion: JSON.parse(read(path.join(ROOT, 'package.json'))).version,
    copyVersion: JSON.parse(read(path.join(DEST, 'package.json'))).version,
    repoClientSha256: sha256File(path.join(ROOT, 'client.js')),
    copyClientSha256: sha256File(path.join(DEST, 'client.js')),
    copyClientDiffers: sha256File(path.join(DEST, 'client.js')) !== sha256File(path.join(ROOT, 'client.js')),
  }
  result.ok = true
  step('done', { version: result.effectiveVersion, clientSyntaxOk: result.files['client.js'].syntaxCheckExit === 0 })
} catch (error) {
  result.error = String(error && error.message ? error.message : error)
  process.stderr.write('[make-copy] FAILED: ' + result.error + '\n')
}
result.finishedAt = new Date().toISOString()
result.durationMs = Date.now() - t0
fs.mkdirSync(path.dirname(cfg.out), { recursive: true })
fs.writeFileSync(cfg.out, JSON.stringify(result, null, 2) + '\n', 'utf8')
if (!result.ok) process.exitCode = 1
else process.stdout.write('[make-copy] OK dest=' + result.dest + ' version=' + (result.effectiveVersion || '(repo)') + ' clientSyntaxExit=' + result.files['client.js'].syntaxCheckExit + ' -> ' + path.relative(ROOT, cfg.out).split(path.sep).join('/') + '\n')
