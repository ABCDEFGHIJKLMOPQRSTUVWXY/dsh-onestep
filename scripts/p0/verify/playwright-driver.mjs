#!/usr/bin/env node
/**
 * playwright-driver.mjs — dsh-onestep P0 浏览器验证器
 *
 * 用 headless Edge（playwright-core channel:'msedge'）打开真实 DSH Web 实例，
 * 采集 boot payload / client scripts / console / DOM / CSS 变量 / 截图，供 S1-S10 探针复用。
 *
 * 快速用法（从仓库根目录运行）：
 *   node scripts/p0/verify/playwright-driver.mjs smoke
 *   node scripts/p0/verify/playwright-driver.mjs smoke --out artifacts/p0/verify/smoke.json
 *   node scripts/p0/verify/playwright-driver.mjs eval --expr '({title: document.title})'
 *   node scripts/p0/verify/playwright-driver.mjs probe --script scripts/p0/verify/probes/example.js
 *   node scripts/p0/verify/playwright-driver.mjs screenshot --out artifacts/p0/verify/page.png
 *   node scripts/p0/verify/playwright-driver.mjs boot
 *
 * 公共参数：
 *   --url-file <path>        含 token 的 URL 文件（默认 artifacts/p0/server-url.txt）
 *   --url <url>              直接给 URL（替代 --url-file）
 *   --out <path|json>        结果 JSON 落盘路径（smoke 默认 artifacts/p0/verify/smoke.json）
 *   --screenshot <path.png>  截图路径（smoke 默认 artifacts/p0/verify/smoke.png）
 *   --full-page              整页截图
 *   --timeout <ms>           goto / 就绪等待上限（默认 60000）
 *   --wait-for <selector>    就绪后再等某个选择器可见
 *   --wait-ms <ms>           就绪后额外静置时间（smoke 默认 2500，其它 800）
 *   --headless <true|false>  默认 true
 *   --channel <name>         playwright channel（默认 msedge）
 *   --executable-path <exe>  显式指定浏览器可执行文件
 *   --viewport <WxH>         默认 1440x900
 *   --console-limit <n>      console 事件上限（默认 1000）
 *   --print <full|summary|none>   stdout 输出形态（有 --out 时默认 summary）
 *   --quiet                  不向 stdout 打印
 *   --verbose                stderr 打进度
 *   --reveal-token           输出里不掩码 token（默认掩码）
 *
 * 退出码：0 OK / 2 用法错误 / 3 目标不可达或鉴权失败 / 4 浏览器启动失败 / 5 超时 / 6 页面内脚本错误 / 7 其它
 *
 * 输出：stdout 只有 JSON（除 --help/--quiet）；诊断信息一律走 stderr。
 * 页面内 helper：eval/probe 会注入 window.__P0__ = { v, sleep, waitFor, waitForText, qsa, clickText, textOf }。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const TOOLS_PW = path.join(REPO_ROOT, 'tools', 'pw');
const DEFAULT_URL_FILE = path.join(REPO_ROOT, 'artifacts', 'p0', 'server-url.txt');
const OUT_DIR = path.join(REPO_ROOT, 'artifacts', 'p0', 'verify');
const DRIVER_VERSION = '1.0.0';

const EXIT = {
  OK: 0,
  USAGE: 2,
  TARGET: 3,
  LAUNCH: 4,
  TIMEOUT: 5,
  EVAL: 6,
  INTERNAL: 7,
};

const COMMANDS = ['smoke', 'eval', 'probe', 'screenshot', 'boot'];

const VALUE_FLAGS = new Map([
  ['url-file', 'urlFile'],
  ['url', 'url'],
  ['out', 'out'],
  ['screenshot', 'screenshot'],
  ['timeout', 'timeout'],
  ['wait-for', 'waitFor'],
  ['wait-ms', 'waitMs'],
  ['headless', 'headless'],
  ['channel', 'channel'],
  ['executable-path', 'executablePath'],
  ['viewport', 'viewport'],
  ['color-scheme', 'colorScheme'],
  ['console-limit', 'consoleLimit'],
  ['expr', 'expr'],
  ['expr-file', 'exprFile'],
  ['script', 'script'],
  ['print', 'print'],
]);
const BOOL_FLAGS = new Map([
  ['help', 'help'],
  ['quiet', 'quiet'],
  ['verbose', 'verbose'],
  ['full-page', 'fullPage'],
  ['reveal-token', 'revealToken'],
  ['skip-preflight', 'skipPreflight'],
]);

const EDGE_CANDIDATES = [
  process.env.DSH_PW_EDGE,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function clip(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…(' + s.length + ')' : s;
}

function log(msg) {
  process.stderr.write('[driver] ' + msg + '\n');
}

function vlog(cfg, msg) {
  if (cfg && cfg.verbose) log(msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function absPath(p) {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

function relPath(p) {
  const rel = path.relative(REPO_ROOT, p);
  return rel.startsWith('..') ? p : rel.split(path.sep).join('/');
}

function maskUrl(url, cfg) {
  let s = String(url == null ? '' : url);
  if (cfg && cfg.revealToken) return s;
  s = s.replace(/([?&]token=)[^&#\s"']*/gi, '$1***');
  return s;
}

function exitCodeFor(code) {
  switch (code) {
    case 'USAGE':
      return EXIT.USAGE;
    case 'TARGET_UNREACHABLE':
    case 'AUTH_REQUIRED':
      return EXIT.TARGET;
    case 'LAUNCH_FAILED':
      return EXIT.LAUNCH;
    case 'TIMEOUT':
      return EXIT.TIMEOUT;
    case 'EVAL_ERROR':
    case 'PROBE_ERROR':
      return EXIT.EVAL;
    default:
      return EXIT.INTERNAL;
  }
}

function intOpt(raw, def, name, min, max) {
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.floor(n) !== n) throw new CliError('USAGE', `${name} 需要整数，收到: ${raw}`);
  if (n < min || n > max) throw new CliError('USAGE', `${name} 超出范围 [${min}, ${max}]: ${n}`);
  return n;
}

function boolOpt(raw, def, name) {
  if (raw === undefined || raw === null || raw === '') return def;
  const s = String(raw).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  throw new CliError('USAGE', `${name} 需要 true/false，收到: ${raw}`);
}

function parseViewport(raw) {
  const m = String(raw || '').trim().match(/^(\d+)\s*[xX*]\s*(\d+)$/);
  if (!m) throw new CliError('USAGE', `--viewport 需要 WxH 形式，例如 1440x900，收到: ${raw}`);
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width < 320 || height < 240 || width > 7680 || height > 4320) throw new CliError('USAGE', `--viewport 尺寸不合法: ${raw}`);
  return { width, height };
}

function parseColorScheme(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const s = String(raw).toLowerCase();
  if (!['light', 'dark', 'no-preference'].includes(s)) {
    throw new CliError('USAGE', `--color-scheme 只能是 light|dark|no-preference，收到: ${raw}`);
  }
  return s;
}

class CliError extends Error {
  constructor(code, message, hint, detail) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.hint = hint || null;
    this.detail = detail || null;
  }
}

// ---------------------------------------------------------------------------
// CLI 解析 / 配置
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      opts._.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      opts._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (BOOL_FLAGS.has(name)) {
      if (value !== undefined) throw new CliError('USAGE', `--${name} 不接受值`);
      opts[BOOL_FLAGS.get(name)] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new CliError('USAGE', `未知参数 --${name}`, '用 --help 查看可用参数');
    if (value === undefined) {
      const next = argv[i + 1];
      if (name === 'headless' && (next === undefined || next.startsWith('--'))) {
        value = 'true';
      } else if (next === undefined || next.startsWith('--')) {
        throw new CliError('USAGE', `--${name} 需要一个值`);
      } else {
        value = next;
        i++;
      }
    }
    opts[VALUE_FLAGS.get(name)] = value;
  }
  return opts;
}

function resolveTarget(opts) {
  let raw;
  let source;
  if (opts.url) {
    raw = opts.url;
    source = { kind: '--url' };
  } else {
    const file = opts.urlFile ? absPath(opts.urlFile) : DEFAULT_URL_FILE;
    source = { kind: 'url-file', path: file };
    if (!fs.existsSync(file)) {
      throw new CliError(
        'TARGET_UNREACHABLE',
        `URL 文件不存在: ${file}`,
        '向 Lead 索取当前 DSH Web 实例的 URL（含 token），或传 --url <url>',
      );
    }
    const stat = fs.statSync(file);
    source.mtime = stat.mtime.toISOString();
    source.ageSeconds = Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 1000));
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    raw = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    if (!raw) throw new CliError('TARGET_UNREACHABLE', `URL 文件为空: ${file}`, '重新写入含 token 的 URL');
  }
  raw = String(raw).replace(/^['"]|['"]$/g, '').trim();
  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    throw new CliError('USAGE', `URL 无效: ${clip(raw, 200)}`, '期望形如 http://127.0.0.1:4648/?token=...');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CliError('USAGE', `URL 协议必须是 http/https（收到 ${url.protocol}）`);
  }
  return { url, token: url.searchParams.get('token') || null, source };
}

function buildConfig(opts) {
  const command = opts._[0];
  if (!command) throw new CliError('USAGE', '缺少子命令', '可选: ' + COMMANDS.join(' | '));
  if (!COMMANDS.includes(command)) throw new CliError('USAGE', `未知子命令: ${command}`, '可选: ' + COMMANDS.join(' | '));
  if (opts._.length > 1) throw new CliError('USAGE', `多余的参数: ${opts._.slice(1).join(' ')}`);

  const cfg = {
    command,
    startedAt: new Date().toISOString(),
    timeout: intOpt(opts.timeout, 60000, '--timeout', 1000, 600000),
    waitMs: intOpt(opts.waitMs, command === 'smoke' ? 2500 : 800, '--wait-ms', 0, 120000),
    consoleLimit: intOpt(opts.consoleLimit, 1000, '--console-limit', 1, 100000),
    fullPage: !!opts.fullPage,
    revealToken: !!opts.revealToken,
    skipPreflight: !!opts.skipPreflight,
    quiet: !!opts.quiet,
    verbose: !!opts.verbose,
    print: opts.print || (opts.out ? 'summary' : 'full'),
    out: opts.out ? absPath(opts.out) : undefined,
    screenshot: opts.screenshot ? absPath(opts.screenshot) : undefined,
    waitFor: opts.waitFor || null,
    headless: boolOpt(opts.headless, true, '--headless'),
    channel: opts.channel || 'msedge',
    executablePath: opts.executablePath ? absPath(opts.executablePath) : undefined,
    viewport: parseViewport(opts.viewport || '1440x900'),
    colorScheme: parseColorScheme(opts.colorScheme),
    expr: opts.expr,
    exprFile: opts.exprFile ? absPath(opts.exprFile) : undefined,
    script: opts.script ? absPath(opts.script) : undefined,
  };
  if (!['full', 'summary', 'none'].includes(cfg.print)) {
    throw new CliError('USAGE', `--print 只能是 full|summary|none，收到: ${cfg.print}`);
  }

  if (command === 'smoke') {
    if (!cfg.out) cfg.out = path.join(OUT_DIR, 'smoke.json');
    if (!cfg.screenshot) cfg.screenshot = path.join(OUT_DIR, 'smoke.png');
  }
  if (command === 'screenshot' && !cfg.screenshot) {
    cfg.screenshot = path.join(OUT_DIR, 'screenshot.png');
  }
  if (command === 'eval') {
    if (!cfg.expr && !cfg.exprFile) throw new CliError('USAGE', 'eval 需要 --expr <js> 或 --expr-file <path>');
    if (cfg.expr && cfg.exprFile) throw new CliError('USAGE', '--expr 与 --expr-file 只能给一个');
    if (cfg.exprFile) {
      if (!fs.existsSync(cfg.exprFile)) throw new CliError('USAGE', `--expr-file 不存在: ${cfg.exprFile}`);
      cfg.expr = fs.readFileSync(cfg.exprFile, 'utf8');
    }
  }
  if (command === 'probe') {
    if (!cfg.script) throw new CliError('USAGE', 'probe 需要 --script <js 文件>');
    if (!fs.existsSync(cfg.script)) throw new CliError('USAGE', `--script 不存在: ${cfg.script}`);
    cfg.probeCode = fs.readFileSync(cfg.script, 'utf8');
  }

  const target = resolveTarget(opts);
  cfg.url = target.url;
  cfg.token = target.token;
  cfg.target = target;
  return cfg;
}

// ---------------------------------------------------------------------------
// 预检（Node fetch，不进浏览器先给诊断）
// ---------------------------------------------------------------------------

async function preflightTarget(cfg) {
  const t0 = Date.now();
  try {
    const res = await fetch(cfg.url.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: { 'user-agent': `dsh-onestep-pw-driver/${DRIVER_VERSION}` },
    });
    const body = await res.text().catch(() => '');
    return {
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      latencyMs: Date.now() - t0,
      bodyHead: clip(body.replace(/\s+/g, ' ').trim(), 300),
    };
  } catch (e) {
    const cause = (e && e.cause && (e.cause.code || e.cause.message)) || '';
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - t0,
      error: timeout ? 'timeout' : String(cause || (e && e.message) || e),
      bodyHead: null,
    };
  }
}

function classifyPreflight(cfg, p) {
  const masked = maskUrl(cfg.url.toString(), cfg);
  if (p.status === 401 || /authentication required/i.test(p.bodyHead || '')) {
    return new CliError(
      'AUTH_REQUIRED',
      `DSH Web 实例要求鉴权（HTTP ${p.status}），URL 里的 token 可能已失效`,
      `实例每次重启 URL/token 都会变；重新读取 Lead 输出到 --url-file 的新 URL，或传 --url 新 URL。目标: ${masked}`,
      { preflight: p },
    );
  }
  if (!p.ok) {
    if (p.error === 'timeout') {
      return new CliError('TARGET_UNREACHABLE', `预检超时（8s 无响应）: ${masked}`, '确认 Lead 的 DSH Web 实例仍在运行；重启后 server-url.txt 会变', { preflight: p });
    }
    return new CliError(
      'TARGET_UNREACHABLE',
      `无法连接 DSH Web 实例: ${masked}（${p.error || 'HTTP ' + p.status}）`,
      '实例未监听或端口已变。只读检查：Get-NetTCPConnection -LocalPort <port> -State Listen；不要自行重启 Lead 的实例',
      { preflight: p },
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// playwright-core 解析 / 浏览器启动
// ---------------------------------------------------------------------------

async function loadPlaywright() {
  const attempts = [];
  if (fs.existsSync(path.join(TOOLS_PW, 'package.json'))) {
    try {
      const req = createRequire(path.join(TOOLS_PW, 'package.json'));
      const pw = req('playwright-core');
      const pkg = req('playwright-core/package.json');
      return { pw, version: pkg.version, resolvedFrom: path.join(TOOLS_PW, 'node_modules') };
    } catch (e) {
      attempts.push({ from: 'tools/pw', error: clip(e.message, 500) });
    }
  }
  try {
    const pw = await import('playwright-core');
    let version = null;
    try {
      version = createRequire(import.meta.url)('playwright-core/package.json').version;
    } catch (e) {
      /* ignore */
    }
    return { pw, version, resolvedFrom: 'node resolution' };
  } catch (e) {
    attempts.push({ from: 'import', error: clip(e.message, 500) });
  }
  throw new CliError(
    'LAUNCH_FAILED',
    'playwright-core 未安装或无法加载',
    '在仓库根执行: cd tools/pw; npm i playwright-core（不要下载 chromium，用 channel:msedge）',
    { attempts },
  );
}

function describeLaunchCandidate(c) {
  if (c.channel) return `channel:${c.channel}`;
  if (c.executablePath) return `executablePath:${c.executablePath}`;
  return 'default';
}

async function launchBrowser(pw, cfg) {
  const attempts = [];
  const candidates = [];
  if (cfg.executablePath) candidates.push({ executablePath: cfg.executablePath });
  if (cfg.channel && cfg.channel !== 'none') candidates.push({ channel: cfg.channel });
  for (const exe of EDGE_CANDIDATES) candidates.push({ executablePath: exe });

  const launchArgs = ['--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio', '--disable-extensions'];

  for (const cand of candidates) {
    const mode = describeLaunchCandidate(cand);
    try {
      const browser = await pw.chromium.launch({ ...cand, headless: cfg.headless, args: launchArgs });
      attempts.push({ mode, ok: true });
      return { browser, launchMode: mode, attempts };
    } catch (e) {
      attempts.push({ mode, ok: false, error: clip(e && e.message, 800) });
    }
  }
  throw new CliError(
    'LAUNCH_FAILED',
    '无法启动 headless 浏览器（Edge 启动失败）',
    '确认 Edge 已安装：C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe；或用 --executable-path 指定；PLAYWRIGHT_BROWSERS_PATH 不需要下载 chromium',
    { attempts, candidates: candidates.map(describeLaunchCandidate), edgeCandidates: EDGE_CANDIDATES },
  );
}

// ---------------------------------------------------------------------------
// 会话状态 / 事件采集
// ---------------------------------------------------------------------------

function createSession(cfg) {
  const s = {
    cfg,
    warnings: [],
    events: [],
    eventsTruncated: false,
    browser: null,
    context: null,
    page: null,
    tNav: 0,
    tStart: Date.now(),
    timings: {},
    popup: { found: false, clicked: false, attempts: [] },
    push(ev) {
      if (this.events.length < cfg.consoleLimit) this.events.push(ev);
      else this.eventsTruncated = true;
    },
    ts() {
      return this.tNav ? Date.now() - this.tNav : 0;
    },
  };
  return s;
}

function attachPageListeners(s) {
  const page = s.page;
  page.on('console', (msg) => {
    let loc = {};
    try {
      loc = msg.location() || {};
    } catch (e) {
      /* ignore */
    }
    s.push({
      type: 'console',
      ts: s.ts(),
      level: msg.type(),
      text: clip(msg.text(), 4000),
      location: { url: maskUrl(loc.url || '', s.cfg), line: loc.lineNumber == null ? null : loc.lineNumber },
    });
  });
  page.on('pageerror', (err) => {
    const text = err && err.stack ? err.stack : String(err);
    s.push({ type: 'pageerror', ts: s.ts(), text: clip(text, 6000) });
  });
  page.on('requestfailed', (req) => {
    let failure = null;
    try {
      failure = req.failure();
    } catch (e) {
      /* ignore */
    }
    s.push({
      type: 'requestfailed',
      ts: s.ts(),
      text: `${req.method()} ${maskUrl(req.url(), s.cfg)} :: ${(failure && failure.errorText) || 'unknown'}`,
    });
  });
  page.on('response', (res) => {
    const status = res.status();
    if (status >= 400) s.push({ type: 'httperror', ts: s.ts(), text: `${status} ${res.request().method()} ${maskUrl(res.url(), s.cfg)}` });
  });
  page.on('dialog', async (dialog) => {
    s.push({ type: 'dialog', ts: s.ts(), text: `${dialog.type()} :: ${clip(dialog.message(), 500)}` });
    try {
      await dialog.dismiss();
    } catch (e) {
      /* ignore */
    }
  });
  page.on('crash', () => s.push({ type: 'crash', ts: s.ts(), text: 'page crashed' }));
}

function summarizeConsole(s) {
  const messages = [];
  const pageErrors = [];
  const requestFailures = [];
  const dialogs = [];
  const httpErrors = [];
  const counts = {};
  for (const e of s.events) {
    if (e.type === 'console') {
      messages.push({ ts: e.ts, level: e.level, text: e.text, location: e.location });
      counts[e.level] = (counts[e.level] || 0) + 1;
    } else if (e.type === 'pageerror') pageErrors.push({ ts: e.ts, text: e.text });
    else if (e.type === 'requestfailed') requestFailures.push({ ts: e.ts, text: e.text });
    else if (e.type === 'dialog') dialogs.push({ ts: e.ts, text: e.text });
    else if (e.type === 'httperror') httpErrors.push({ ts: e.ts, text: e.text });
  }
  return {
    counts,
    total: s.events.length,
    truncated: s.eventsTruncated,
    messages,
    pageErrors,
    requestFailures,
    dialogs,
    httpErrors,
  };
}

async function summarizeAuthCookies(context) {
  try {
    const cookies = await context.cookies();
    return {
      count: cookies.length,
      cookies: cookies.map((c) => ({ name: c.name, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite })),
    };
  } catch (e) {
    return { error: clip(e.message, 300) };
  }
}

// ---------------------------------------------------------------------------
// 页面就绪 / 弹窗 / 等待
// ---------------------------------------------------------------------------

async function tryDismissPreviewPopup(page, cfg, popup) {
  const names = ['继续'];
  for (const name of names) {
    try {
      const loc = page.getByRole('button', { name, exact: true });
      const count = await loc.count();
      if (!count) {
        popup.attempts.push({ name, count: 0 });
        continue;
      }
      for (let idx = 0; idx < Math.min(count, 3); idx++) {
        const btn = loc.nth(idx);
        const visible = await btn.isVisible().catch(() => false);
        if (!visible) {
          popup.attempts.push({ name, index: idx, visible: false });
          continue;
        }
        popup.attempts.push({ name, index: idx, visible: true, clicked: true });
        await btn.click({ timeout: 3000 });
        popup.found = true;
        popup.clicked = true;
        vlog(cfg, `已点击预览版弹窗按钮「${name}」`);
        await sleep(200);
        return true;
      }
    } catch (e) {
      popup.attempts.push({ name, error: clip(e.message, 400) });
    }
  }
  return false;
}

function pageAuthHint(bodyHead) {
  return /authentication required/i.test(String(bodyHead || ''));
}

async function waitReady(cfg, s) {
  const t0 = Date.now();
  const deadline = t0 + cfg.timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await s.page
      .evaluate(() => {
        const body = document.body;
        return {
          boot: !!window.__DSH_BOOT__,
          editor: !!document.querySelector('[role="textbox"], textarea, [contenteditable="true"], [data-placeholder]'),
          bodyTextLength: body ? body.innerText.length : 0,
          bodyHead: body ? body.innerText.slice(0, 200) : '',
        };
      })
      .catch(() => null);
    if (last && last.boot && (last.editor || last.bodyTextLength > 200)) {
      return { ok: true, waitedMs: Date.now() - t0, bootFound: true, editorFound: last.editor, bodyTextLength: last.bodyTextLength, strategy: 'boot+editor' };
    }
    await sleep(150);
  }
  return {
    ok: false,
    waitedMs: Date.now() - t0,
    bootFound: !!(last && last.boot),
    editorFound: !!(last && last.editor),
    bodyTextLength: last ? last.bodyTextLength : 0,
    bodyHead: last ? clip(last.bodyHead.replace(/\s+/g, ' '), 300) : '',
    strategy: 'boot+editor',
  };
}

async function waitBoot(cfg, s) {
  const t0 = Date.now();
  try {
    await s.page.waitForFunction(() => !!window.__DSH_BOOT__, null, { timeout: cfg.timeout, polling: 100 });
    return { ok: true, waitedMs: Date.now() - t0, strategy: 'boot-only' };
  } catch (e) {
    return { ok: false, waitedMs: Date.now() - t0, strategy: 'boot-only', error: clip(e.message, 600) };
  }
}

async function waitForSelector(cfg, s) {
  if (!cfg.waitFor) return null;
  const t0 = Date.now();
  try {
    await s.page.waitForSelector(cfg.waitFor, { state: 'visible', timeout: cfg.timeout });
    return { ok: true, selector: cfg.waitFor, waitedMs: Date.now() - t0 };
  } catch (e) {
    throw new CliError('TIMEOUT', `等待选择器超时: ${cfg.waitFor}`, '检查选择器是否存在于当前页面状态', { selector: cfg.waitFor, waitedMs: Date.now() - t0 });
  }
}

// ---------------------------------------------------------------------------
// 页面快照（在页面上下文执行）
// ---------------------------------------------------------------------------

function pageSnapshot() {
  const clip = (s, n) => {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…(' + s.length + ')' : s;
  };
  const mask = (u) => String(u == null ? '' : u).replace(/([?&]token=)[^&#\s"']*/gi, '$1***');
  const isVisible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.01;
  };

  // ---- window.__DSH_BOOT__ ----
  const boot = window.__DSH_BOOT__ || null;
  let bootInfo = { hasBoot: false };
  if (boot) {
    const entries = Array.isArray(boot.entries) ? boot.entries : [];
    const batches = Array.isArray(boot.batches) ? boot.batches : [];
    bootInfo = {
      hasBoot: true,
      topKeys: Object.keys(boot),
      rev: boot.rev == null ? null : boot.rev,
      release: boot.release ? { version: boot.release.version == null ? null : boot.release.version, commit: boot.release.commit == null ? null : boot.release.commit } : null,
      entriesCount: entries.length,
      entryKeysUnion: [...new Set(entries.flatMap((e) => (e && typeof e === 'object' ? Object.keys(e) : [])))],
      entryIds: entries.map((e) => (e && e.id) || null),
      entries: entries.map((e) => ({
        id: (e && e.id) || null,
        url: mask(e && e.url),
        rev: (e && e.rev) || null,
        inject: Array.isArray(e && e.inject) ? e.inject : e && e.inject != null ? e.inject : null,
        immediately: e && e.immediately === true,
        external: Array.isArray(e && e.external) ? e.external : e && e.external != null ? e.external : null,
      })),
      batches: batches.map((b) => ({
        phase: (b && b.phase) || null,
        rev: (b && b.rev) || null,
        url: mask(b && b.url),
        entriesCount: b && Array.isArray(b.entries) ? b.entries.length : null,
        entryIds: b && Array.isArray(b.entries) ? b.entries.slice(0, 200) : null,
      })),
    };
  }

  // ---- client scripts ----
  const clientScripts = [...document.querySelectorAll('script[src]')].map((el) => ({
    src: mask(el.src),
    type: el.type || null,
    async: !!el.async,
    defer: !!el.defer,
    crossOrigin: el.crossOrigin || null,
  }));

  // ---- resource timing 里的 /plugins/ 与 /assets/ ----
  const pluginResources = performance
    .getEntriesByType('resource')
    .map((r) => ({ url: mask(r.name), initiatorType: r.initiatorType || null, durationMs: Math.round(r.duration), transferSize: r.transferSize || 0 }))
    .filter((r) => /\/plugins\/|\/assets\//.test(r.url));

  // ---- DOM 计数 ----
  const SEL = {
    root: '#root',
    bodyChildren: 'body > *',
    button: 'button',
    textarea: 'textarea',
    roleTextbox: '[role="textbox"]',
    contentEditable: '[contenteditable]',
    contentEditableTrue: '[contenteditable="true"]',
    roleDialog: '[role="dialog"]',
    dialogTag: 'dialog',
    linkStylesheet: 'link[rel="stylesheet"]',
    scriptSrc: 'script[src]',
    iframe: 'iframe',
    canvas: 'canvas',
    img: 'img',
    svg: 'svg',
  };
  const dom = {};
  for (const [key, sel] of Object.entries(SEL)) {
    try {
      dom[key] = document.querySelectorAll(sel).length;
    } catch (e) {
      dom[key] = -1;
    }
  }

  // ---- composer / 编辑器 ----
  const editorCandidates = [...document.querySelectorAll('[role="textbox"], textarea, [contenteditable="true"], [contenteditable=""], [data-placeholder]')];
  const editor = editorCandidates.find(isVisible) || editorCandidates[0] || null;
  let composer = null;
  if (editor) {
    const r = editor.getBoundingClientRect();
    composer = {
      tag: editor.tagName,
      role: editor.getAttribute('role'),
      contentEditable: editor.getAttribute('contenteditable'),
      dataPlaceholder: editor.getAttribute('data-placeholder'),
      ariaPlaceholder: editor.getAttribute('aria-placeholder'),
      placeholder: editor.getAttribute('placeholder'),
      visible: isVisible(editor),
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      cssBeforeContent: clip(getComputedStyle(editor, '::before').content, 200),
      cssAfterContent: clip(getComputedStyle(editor, '::after').content, 200),
      textLength: (editor.innerText || '').length,
    };
  }

  // ---- 文案探针 ----
  const body = document.body;
  const bodyText = body ? body.innerText : '';
  const hint = {
    bodyTextLength: bodyText.length,
    bodyHasComposerHint: bodyText.includes('描述你想要构建的内容'),
    bodyHasPreviewBadge: bodyText.includes('预览版'),
    bodyHasNewSessionText: bodyText.includes('新会话'),
    bodyHasPluginText: bodyText.includes('插件'),
    bodyHead: clip(bodyText.replace(/\s+/g, ' ').trim(), 400),
  };

  // ---- CSS 变量（扫 stylesheet + computed 取值） ----
  const varNames = new Set();
  let sheets = 0;
  let sheetsSkipped = 0;
  for (const sheet of document.styleSheets) {
    sheets++;
    let rules;
    try {
      rules = sheet.cssRules;
    } catch (e) {
      sheetsSkipped++;
      continue;
    }
    if (!rules) {
      sheetsSkipped++;
      continue;
    }
    const walk = (rs) => {
      for (const rule of rs) {
        try {
          const txt = rule.cssText;
          if (txt) {
            const m = txt.match(/--[A-Za-z0-9_-]+\s*:/g);
            if (m) for (const x of m) varNames.add(x.replace(/\s*:$/, ''));
          }
          if (rule.cssRules) walk(rule.cssRules);
        } catch (e) {
          /* 单条规则失败忽略 */
        }
      }
    };
    try {
      walk(rules);
    } catch (e) {
      /* ignore */
    }
  }
  const rootCS = getComputedStyle(document.documentElement);
  const bodyCS = getComputedStyle(body || document.documentElement);
  const readVar = (n) => rootCS.getPropertyValue(n).trim() || bodyCS.getPropertyValue(n).trim();
  const allVars = [...varNames].sort();
  const dswVars = allVars.filter((n) => n.startsWith('--dsw'));
  const aliasVars = dswVars.filter((n) => n.startsWith('--dsw-alias'));
  const sampleNames = (aliasVars.length ? aliasVars : dswVars).slice(0, 16);
  const cssVars = {
    source: 'stylesheet-scan+computed',
    sheets,
    sheetsSkipped,
    totalVarNames: allVars.length,
    dswVarCount: dswVars.length,
    aliasVarCount: aliasVars.length,
    sample: Object.fromEntries(sampleNames.map((n) => [n, readVar(n)])),
    keyVars: Object.fromEntries(
      ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-brand-primary', '--dsw-alias-fg-default', '--dsw-alias-border-l1'].map((n) => [n, readVar(n)]),
    ),
  };

  // ---- window 上的 __* 全局 ----
  let globals = [];
  try {
    globals = Object.keys(window)
      .filter((k) => /^__/.test(k))
      .sort()
      .slice(0, 100);
  } catch (e) {
    /* ignore */
  }

  // ---- storage / cookie 名 ----
  const storage = {};
  for (const [key, store] of [
    ['localStorage', window.localStorage],
    ['sessionStorage', window.sessionStorage],
  ]) {
    try {
      const keys = [];
      for (let i = 0; i < store.length; i++) keys.push(store.key(i));
      storage[key] = { count: keys.length, keys: keys.slice(0, 50) };
    } catch (e) {
      storage[key] = { error: String(e) };
    }
  }
  storage.cookieNames = document.cookie
    ? document.cookie
        .split(';')
        .map((c) => c.split('=')[0].trim())
        .filter(Boolean)
    : [];

  // ---- navigation timing ----
  const nav = performance.getEntriesByType('navigation')[0];
  const timing = nav
    ? {
        domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
        loadMs: Math.round(nav.loadEventEnd),
        responseEndMs: Math.round(nav.responseEnd),
        transferSize: nav.transferSize || 0,
      }
    : null;

  // ---- 主题（DSH boot 内联脚本：preference -> html[data-ds-theme-source] + body[data-ds-dark-theme]） ----
  const rootStyle = getComputedStyle(document.documentElement);
  const bodyStyle = getComputedStyle(body || document.documentElement);
  const theme = {
    source: document.documentElement.dataset.dsThemeSource || null,
    darkAttr: body ? body.hasAttribute('data-ds-dark-theme') : null,
    prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
    colorScheme: rootStyle.colorScheme || null,
    bgBase: (rootStyle.getPropertyValue('--dsw-alias-bg-base') || bodyStyle.getPropertyValue('--dsw-alias-bg-base') || '').trim(),
    bodyBg: bodyStyle.backgroundColor || null,
    bodyColor: bodyStyle.color || null,
  };

  return {
    title: document.title,
    url: mask(location.href),
    readyState: document.readyState,
    boot: bootInfo,
    clientScripts,
    pluginResources,
    dom,
    composer,
    hint,
    cssVars,
    globals,
    storage,
    timing,
    theme,
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
    frames: window.frames.length,
  };
}

// ---------------------------------------------------------------------------
// 页面内 helper（eval / probe 用）
// ---------------------------------------------------------------------------

async function installHelpers(page) {
  await page.evaluate(() => {
    if (window.__P0__ && window.__P0__.v === 1) return;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (arg, timeout = 15000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        const hit = typeof arg === 'function' ? arg() : typeof arg === 'string' ? document.querySelector(arg) : null;
        if (hit) return hit;
        await sleep(100);
      }
      throw new Error('__P0__.waitFor timeout after ' + timeout + 'ms: ' + (typeof arg === 'string' ? arg : 'predicate'));
    };
    const waitForText = async (text, timeout = 15000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        const body = document.body ? document.body.innerText : '';
        if (body.includes(text)) return true;
        await sleep(100);
      }
      throw new Error('__P0__.waitForText timeout: ' + text);
    };
    const qsa = (sel) => [...document.querySelectorAll(sel)];
    const clickText = (text, selector = 'button,[role="button"],a') => {
      const els = [...document.querySelectorAll(selector)];
      const hit = els.find((el) => ((el.innerText || el.textContent || '') + '').trim().includes(text));
      if (!hit) throw new Error('__P0__.clickText: 没有文本含「' + text + '」的 ' + selector);
      hit.click();
      return true;
    };
    const textOf = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.innerText || el.textContent || '' : null;
    };
    // 向输入框/contenteditable 写入文本（尽量触发 React 可控组件更新）
    const typeText = (target, text) => {
      const el = typeof target === 'string' ? document.querySelector(target) : target;
      if (!el) throw new Error('__P0__.typeText: 未找到元素 ' + target);
      el.focus();
      if (el.isContentEditable) {
        document.execCommand('selectAll', false, null);
        const ok = document.execCommand('insertText', false, String(text));
        if (!ok) {
          el.textContent = String(text);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(text) }));
        }
      } else {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, String(text));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    };
    window.__P0__ = { v: 1, sleep, waitFor, waitForText, qsa, clickText, textOf, typeText };
  });
}

// ---------------------------------------------------------------------------
// 表达式 / 探针脚本执行
// ---------------------------------------------------------------------------

function safeJsonValue(value, maxBytes = 200000) {
  if (value === undefined) return { value: null, valueType: 'undefined', note: '表达式返回 undefined' };
  let json;
  try {
    json = JSON.stringify(value);
  } catch (e) {
    return { value: clip(String(value), maxBytes), valueType: typeof value, note: '无法 JSON 序列化: ' + clip(e.message, 300) };
  }
  if (json === undefined) return { value: null, valueType: 'undefined' };
  if (json.length > maxBytes) return { value: json.slice(0, maxBytes) + '…', valueType: typeof value, truncated: true, originalLength: json.length };
  try {
    return { value: JSON.parse(json), valueType: Array.isArray(value) ? 'array' : typeof value };
  } catch (e) {
    return { value: json.slice(0, maxBytes), valueType: typeof value };
  }
}

async function evaluateInPage(page, code, cfg) {
  const t0 = Date.now();
  try {
    let value;
    try {
      value = await page.evaluate(code);
    } catch (e) {
      const msg = String((e && e.message) || e);
      // 常见：对象字面量 / 语句块被当成 block，或含 return 的语句 —— 用函数体兜底再试一次
      if (/SyntaxError|Unexpected token|Unexpected identifier|Illegal return|missing \) after argument list/i.test(msg)) {
        value = await page.evaluate('(async () => {\n' + code + '\n})()');
      } else {
        throw e;
      }
    }
    return { ok: true, value, durationMs: Date.now() - t0 };
  } catch (e) {
    const msg = String((e && e.message) || e);
    return { ok: false, error: clip(msg, 6000), durationMs: Date.now() - t0 };
  }
}

function probeCodeToExpression(code) {
  const text = String(code || '');
  const exprMarker = text.match(/^\s*\/\/\s*@expr\b[^\n]*\n?/m);
  if (exprMarker) return text.replace(exprMarker[0], '');
  return '(async () => {\n' + text + '\n})()';
}

// ---------------------------------------------------------------------------
// 结果组装 / 输出
// ---------------------------------------------------------------------------

function baseResult(cfg, s, ok) {
  return {
    ok,
    driver: {
      name: 'dsh-onestep-playwright-driver',
      version: DRIVER_VERSION,
      command: cfg.command,
      node: process.version,
      playwright: s.pwInfo ? s.pwInfo.version : null,
      playwrightFrom: s.pwInfo ? s.pwInfo.resolvedFrom : null,
    },
    startedAt: cfg.startedAt,
    timings: Object.assign({}, s.timings, { totalMs: Date.now() - s.tStart }),
    target: {
      source: cfg.target.source,
      requestedUrl: maskUrl(cfg.url.toString(), cfg),
      pageUrl: s.page ? maskUrl(s.page.url(), cfg) : null,
      httpStatus: s.httpStatus == null ? null : s.httpStatus,
      preflight: s.preflight ? { ok: s.preflight.ok, status: s.preflight.status, latencyMs: s.preflight.latencyMs, error: s.preflight.error || null } : null,
      authCookies: s.authCookies || null,
      tokenPresent: !!cfg.token,
    },
    browser: {
      channel: cfg.channel,
      launchMode: s.launchMode || null,
      version: s.browserVersion || null,
      headless: cfg.headless,
      viewport: cfg.viewport,
      colorScheme: cfg.colorScheme || null,
      launchAttempts: s.launchAttempts || [],
    },
    ready: s.ready || null,
    theme: s.theme || null,
    popup: s.popup || null,
    console: summarizeConsole(s),
    screenshot: s.screenshot || null,
    waitFor: s.waitForResult || null,
    warnings: s.warnings,
  };
}

function collectWarnings(cfg, s, snapshot) {
  const w = [];
  if (!cfg.token) w.push('URL 不含 token：全新浏览器上下文会收到 401，请使用服务器打印的带 token URL');
  if (cfg.target.source.kind === 'url-file' && cfg.target.source.ageSeconds > 600) {
    w.push(`URL 文件已 ${cfg.target.source.ageSeconds}s 未更新（>10min）：若实例重启过，token 已失效`);
  }
  if (s.popup && s.popup.clicked) w.push('已自动点击「继续」关闭预览版弹窗');
  if (snapshot) {
    if (!snapshot.boot.hasBoot) w.push('window.__DSH_BOOT__ 不存在：页面可能未完成启动');
    if (snapshot.boot.hasBoot && snapshot.boot.entriesCount === 0) w.push('boot.entries 为空数组');
    if (!snapshot.composer) w.push('未找到 composer/编辑器元素（role=textbox / textarea / contenteditable=true）');
  }
  const failures = s.events.filter((e) => e.type === 'requestfailed');
  const wsFail = failures.filter((e) => /^.*ws(s)?:\/\//.test(e.text) || /WebSocket/i.test(e.text));
  if (wsFail.length) w.push(`检测到 ${wsFail.length} 次 WebSocket 连接失败（前端连接可能异常）: ${clip(wsFail[0].text, 200)}`);
  const httpErr = s.events.filter((e) => e.type === 'httperror');
  if (httpErr.length) w.push(`检测到 ${httpErr.length} 个 HTTP >=400 响应: ${clip(httpErr.slice(0, 3).map((e) => e.text).join(' | '), 300)}`);
  if (s.eventsTruncated) w.push(`console 事件超过上限 ${cfg.consoleLimit} 条，已截断`);
  if (snapshot && snapshot.hint && !snapshot.hint.bodyHasComposerHint) {
    w.push('页面文本未出现「描述你想要构建的内容」（composer 提示文案），前端可能尚未完全就绪或处于不同页面状态');
  }
  return w;
}

function makeMasker(cfg) {
  if (cfg && cfg.revealToken) return (v) => v;
  const token = cfg && cfg.token;
  const walk = (v) => {
    if (typeof v === 'string') {
      let out = v;
      if (/[?&]token=/i.test(out)) out = out.replace(/([?&]token=)[^&#\s"']*/gi, '$1***');
      if (token && token.length > 8 && out.includes(token)) out = out.split(token).join('***');
      return out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x);
      return o;
    }
    return v;
  };
  return walk;
}

function summarizeResult(cfg, result) {
  const summary = {
    ok: result.ok,
    command: result.driver ? result.driver.command : null,
    out: cfg && cfg.out ? cfg.out : null,
    totalMs: result.timings ? result.timings.totalMs : null,
    pageUrl: result.target ? result.target.pageUrl : null,
    httpStatus: result.target ? result.target.httpStatus : null,
    ready: result.ready ? { ok: result.ready.ok, waitedMs: result.ready.waitedMs } : null,
    boot: result.page && result.page.boot ? { hasBoot: result.page.boot.hasBoot, entriesCount: result.page.boot.entriesCount, rev: result.page.boot.rev } : null,
    screenshot: result.screenshot ? result.screenshot.path : null,
    warnings: result.warnings && result.warnings.length ? result.warnings : undefined,
    error: result.error || undefined,
  };
  if (result.eval && Object.prototype.hasOwnProperty.call(result.eval, 'value')) {
    const s = JSON.stringify(result.eval.value);
    summary.evalValuePreview = s && s.length > 2000 ? s.slice(0, 2000) + '…' : result.eval.value;
  }
  if (result.probe && Object.prototype.hasOwnProperty.call(result.probe, 'value')) {
    const s = JSON.stringify(result.probe.value);
    summary.probeValuePreview = s && s.length > 2000 ? s.slice(0, 2000) + '…' : result.probe.value;
  }
  return summary;
}

function emit(cfg, result) {
  const masked = makeMasker(cfg)(result);
  if (cfg.out) {
    try {
      fs.mkdirSync(path.dirname(cfg.out), { recursive: true });
      fs.writeFileSync(cfg.out, JSON.stringify(masked, null, 2) + '\n', 'utf8');
    } catch (e) {
      log(`写 --out 失败: ${clip(e.message, 500)}`);
    }
  }
  if (!cfg.quiet && cfg.print !== 'none') {
    const payload = cfg.print === 'summary' ? summarizeResult(cfg, masked) : masked;
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  }
  return masked;
}

function errorScreenshotPath(cfg) {
  if (!cfg) return path.join(OUT_DIR, 'error.png');
  const base = cfg.screenshot || path.join(OUT_DIR, (cfg.command || 'run') + '.png');
  return base.replace(/\.png$/i, '') + '-error.png';
}

async function takeScreenshot(cfg, s, outPath) {
  if (!outPath) return null;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const t0 = Date.now();
  await s.page.screenshot({ path: outPath, fullPage: cfg.fullPage });
  s.timings.screenshotMs = Date.now() - t0;
  const stat = fs.statSync(outPath);
  return {
    path: outPath,
    relativePath: relPath(outPath),
    fullPage: cfg.fullPage,
    bytes: stat.size,
    viewport: cfg.viewport,
    takenAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 各子命令
// ---------------------------------------------------------------------------

async function runSmoke(cfg, s) {
  await gotoAndPrepare(cfg, s);
  const snapshot = await s.page.evaluate(pageSnapshot);
  s.snapshot = snapshot;
  s.warnings = collectWarnings(cfg, s, snapshot);
  s.screenshot = await takeScreenshot(cfg, s, cfg.screenshot);

  const result = baseResult(cfg, s, true);
  result.page = snapshot;
  emit(cfg, result);
  return EXIT.OK;
}

async function runBoot(cfg, s) {
  await gotoAndPrepare(cfg, s, { waitReady: false });
  const snapshot = await s.page.evaluate(pageSnapshot);
  s.snapshot = snapshot;
  s.warnings = collectWarnings(cfg, s, snapshot);
  s.screenshot = await takeScreenshot(cfg, s, cfg.screenshot);

  const result = baseResult(cfg, s, true);
  result.page = snapshot;
  emit(cfg, result);
  return EXIT.OK;
}

async function runEval(cfg, s) {
  await gotoAndPrepare(cfg, s);
  await installHelpers(s.page);
  const { value, error, durationMs } = await evaluateInPage(s.page, cfg.expr, cfg);
  s.timings.evalMs = durationMs;
  s.warnings = collectWarnings(cfg, s, null);
  s.screenshot = await takeScreenshot(cfg, s, cfg.screenshot);
  if (error) {
    throw new CliError('EVAL_ERROR', '页面内表达式执行失败', '检查 --expr 语法；对象字面量请用 ([...]) 或 ({...}) 包裹；页面上下文无 Node 变量', {
      expr: cfg.expr,
      error,
    });
  }
  const serialized = safeJsonValue(value);
  const result = baseResult(cfg, s, true);
  result.eval = Object.assign({ expr: cfg.expr, source: cfg.exprFile ? cfg.exprFile : '--expr', durationMs }, serialized);
  emit(cfg, result);
  return EXIT.OK;
}

async function runProbe(cfg, s) {
  await gotoAndPrepare(cfg, s);
  await installHelpers(s.page);
  const expr = probeCodeToExpression(cfg.probeCode);
  const { value, error, durationMs } = await evaluateInPage(s.page, expr, cfg);
  s.timings.probeMs = durationMs;
  s.warnings = collectWarnings(cfg, s, null);
  s.screenshot = await takeScreenshot(cfg, s, cfg.screenshot);
  if (error) {
    throw new CliError('PROBE_ERROR', '探针脚本在页面内执行失败', 'probe 脚本按函数体执行（可 return，可用 await）；或首行写 // @expr 按表达式执行', {
      script: cfg.script,
      error,
    });
  }
  const serialized = safeJsonValue(value);
  const result = baseResult(cfg, s, true);
  result.probe = Object.assign({ script: cfg.script, relativeScript: relPath(cfg.script), durationMs }, serialized);
  emit(cfg, result);
  return EXIT.OK;
}

async function runScreenshot(cfg, s) {
  await gotoAndPrepare(cfg, s);
  s.warnings = collectWarnings(cfg, s, null);
  s.screenshot = await takeScreenshot(cfg, s, cfg.screenshot);
  const result = baseResult(cfg, s, true);
  emit(cfg, result);
  return EXIT.OK;
}

const HANDLERS = { smoke: runSmoke, boot: runBoot, eval: runEval, probe: runProbe, screenshot: runScreenshot };

// ---------------------------------------------------------------------------
// 打开页面 + 就绪流程（smoke / eval / probe / screenshot 共用）
// ---------------------------------------------------------------------------

async function gotoAndPrepare(cfg, s, opts) {
  const options = Object.assign({ waitReady: true }, opts || {});

  // 1) 预检（Node fetch，只读 GET；--skip-preflight 可跳过）
  if (cfg.skipPreflight) {
    s.preflight = { ok: true, skipped: true, status: null, latencyMs: 0 };
  } else {
    s.preflight = await preflightTarget(cfg);
    s.timings.preflightMs = s.preflight.latencyMs;
    const preErr = classifyPreflight(cfg, s.preflight);
    if (preErr) throw preErr;
  }

  // 2) playwright + 浏览器
  const pwInfo = await loadPlaywright();
  s.pwInfo = pwInfo;
  const tLaunch = Date.now();
  const launched = await launchBrowser(pwInfo.pw, cfg);
  s.timings.launchMs = Date.now() - tLaunch;
  s.browser = launched.browser;
  s.launchMode = launched.launchMode;
  s.launchAttempts = launched.attempts;
  s.browserVersion = launched.browser.version();
  vlog(cfg, `浏览器就绪: ${s.launchMode} v${s.browserVersion}`);

  // 3) context / page / 监听
  s.context = await s.browser.newContext({
    viewport: cfg.viewport,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    deviceScaleFactor: 1,
    ...(cfg.colorScheme ? { colorScheme: cfg.colorScheme } : {}),
  });
  s.page = await s.context.newPage();
  s.tNav = Date.now();
  attachPageListeners(s);

  // 4) goto（保留 token query；token 会被前端消费后从地址栏抹掉）
  const tGoto = Date.now();
  let response = null;
  let gotoError = null;
  try {
    response = await s.page.goto(cfg.url.toString(), { waitUntil: 'domcontentloaded', timeout: cfg.timeout });
  } catch (e) {
    gotoError = e;
  }
  s.timings.gotoMs = Date.now() - tGoto;
  if (gotoError) throw classifyGotoError(cfg, gotoError);
  s.httpStatus = response ? response.status() : null;
  vlog(cfg, `goto HTTP ${s.httpStatus} (${s.timings.gotoMs}ms)`);

  // 5) 鉴权检查（token 失效时是 401 + 纯文本提示）
  await checkAuthPage(cfg, s.page, response);

  // 6) 预览版弹窗（可能挡 UI，先试一次）
  await tryDismissPreviewPopup(s.page, cfg, s.popup).catch(() => false);

  // 7) 就绪等待
  if (options.waitReady) {
    const ready = await waitReady(cfg, s);
    s.ready = ready;
    if (!ready.ok) {
      const bodyHead = await s.page
        .evaluate(() => (document.body ? document.body.innerText.slice(0, 300) : ''))
        .catch(() => '');
      if (pageAuthHint(bodyHead)) throw classifyAuthFromBody(cfg, bodyHead);
      throw new CliError('TIMEOUT', `等待 DSH 前端就绪超时（${cfg.timeout}ms）`, '检查页面是否白屏/是否仍在校验 token；可加大 --timeout 或看 console/pageErrors', {
        ready,
        bodyHead: clip(String(bodyHead).replace(/\s+/g, ' '), 300),
      });
    }
    vlog(cfg, `前端就绪（${ready.waitedMs}ms, bodyLen=${ready.bodyTextLength}）`);

    await s.page.waitForLoadState('load', { timeout: Math.min(15000, cfg.timeout) }).catch(() => {});
    await tryDismissPreviewPopup(s.page, cfg, s.popup).catch(() => false);

    if (cfg.waitMs > 0) {
      const tSettle = Date.now();
      await sleep(cfg.waitMs);
      s.timings.settleMs = Date.now() - tSettle;
    }
    if (cfg.waitFor) s.waitForResult = await waitForSelector(cfg, s);
    // 静置后再补一次弹窗点击（有些弹窗在前端就绪后才挂载）
    await tryDismissPreviewPopup(s.page, cfg, s.popup).catch(() => false);
  } else {
    s.ready = await waitBoot(cfg, s);
    if (!s.ready.ok) {
      const bodyHead = await s.page
        .evaluate(() => (document.body ? document.body.innerText.slice(0, 300) : ''))
        .catch(() => '');
      if (pageAuthHint(bodyHead)) throw classifyAuthFromBody(cfg, bodyHead);
      throw new CliError('TIMEOUT', `等待 window.__DSH_BOOT__ 超时（${cfg.timeout}ms）`, '前端未完成引导；检查 HTTP 状态与 console', {
        ready: s.ready,
        bodyHead: clip(String(bodyHead).replace(/\s+/g, ' '), 300),
      });
    }
    if (cfg.waitMs > 0) await sleep(cfg.waitMs);
    if (cfg.waitFor) s.waitForResult = await waitForSelector(cfg, s);
  }

  // 8) 鉴权 cookie（token 被消费后应落成 HttpOnly cookie；新 context 没有 token 会 401）
  s.authCookies = await summarizeAuthCookies(s.context);

  // 9) 主题判定（DSH boot 内联脚本：preference -> html[data-ds-theme-source] + body[data-ds-dark-theme]）
  s.theme = await s.page
    .evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const body = getComputedStyle(document.body);
      return {
        source: document.documentElement.dataset.dsThemeSource || null,
        darkAttr: document.body.hasAttribute('data-ds-dark-theme'),
        prefersDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
        colorScheme: root.colorScheme || null,
        bgBase: (root.getPropertyValue('--dsw-alias-bg-base') || body.getPropertyValue('--dsw-alias-bg-base') || '').trim(),
        bodyBg: body.backgroundColor || null,
        bodyColor: body.color || null,
      };
    })
    .catch(() => null);
}

function classifyGotoError(cfg, err) {
  const msg = String((err && err.message) || err);
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_ADDRESS_UNREACHABLE|ERR_NAME_NOT_RESOLVED|ERR_EMPTY_RESPONSE|ERR_SOCKET_NOT_CONNECTED|ERR_ABORTED/i.test(msg)) {
    return new CliError('TARGET_UNREACHABLE', `浏览器无法连接 DSH Web 实例（${clip(msg, 300)}）`, '实例未监听或端口已变；不要自行重启 Lead 的实例，等 server-url.txt 更新', { gotoError: clip(msg, 3000) });
  }
  if (/Timeout|timeout/i.test(msg)) {
    return new CliError('TIMEOUT', `打开页面超时（${cfg.timeout}ms）`, '可加大 --timeout；页面可能被弹窗/鉴权阻塞', { gotoError: clip(msg, 3000) });
  }
  return new CliError('INTERNAL', '打开页面失败: ' + clip(msg, 2000), null, { gotoError: clip(msg, 4000) });
}

async function checkAuthPage(cfg, page, response) {
  let bodyHead = '';
  try {
    bodyHead = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 300) : ''));
  } catch (e) {
    /* ignore */
  }
  const status = response ? response.status() : null;
  if (status === 401 || pageAuthHint(bodyHead)) throw classifyAuthFromBody(cfg, bodyHead, status);
}

function classifyAuthFromBody(cfg, bodyHead, status) {
  return new CliError(
    'AUTH_REQUIRED',
    `页面要求鉴权（HTTP ${status == null ? '?' : status}）: ${clip(String(bodyHead || '').replace(/\s+/g, ' ').trim(), 200)}`,
    'token 已失效或 URL 不含 token。重新读取 Lead 实例打印的新 URL（重启后 token 会变），更新 --url-file 或传 --url',
    { bodyHead: clip(String(bodyHead || '').replace(/\s+/g, ' '), 500), httpStatus: status == null ? null : status },
  );
}

// ---------------------------------------------------------------------------
// 失败路径 / main
// ---------------------------------------------------------------------------

async function fail(cfg, s, err) {
  const code = (err && err.code) || 'INTERNAL';
  if (!cfg) {
    const out = {
      ok: false,
      error: { code, message: String((err && err.message) || err), hint: (err && err.hint) || null },
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return exitCodeFor(code);
  }
  const result = baseResult(cfg, s, false);
  result.error = {
    code,
    message: clip(String((err && err.message) || err), 6000),
    hint: (err && err.hint) || null,
    detail: err && err.detail ? err.detail : null,
    stack: cfg.verbose ? String((err && err.stack) || '').split('\n').slice(0, 15).join('\n') : null,
  };
  // 失败即截图（若页面已打开）
  if (s && s.page && !s.page.isClosed()) {
    try {
      const shotPath = errorScreenshotPath(cfg);
      fs.mkdirSync(path.dirname(shotPath), { recursive: true });
      await s.page.screenshot({ path: shotPath, fullPage: false });
      result.screenshot = { path: shotPath, relativePath: relPath(shotPath), error: true, bytes: fs.statSync(shotPath).size };
    } catch (e) {
      /* 截图失败不影响主错误 */
    }
  }
  emit(cfg, result);
  log(`FAIL ${code}: ${clip(String((err && err.message) || err), 500)}`);
  return exitCodeFor(code);
}

async function main() {
  let cfg = null;
  let s = null;
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      process.stdout.write(helpText() + '\n');
      return EXIT.OK;
    }
    cfg = buildConfig(opts);
    s = createSession(cfg);
    vlog(cfg, `command=${cfg.command} url=${maskUrl(cfg.url.toString(), cfg)}`);
    return await HANDLERS[cfg.command](cfg, s);
  } catch (err) {
    return await fail(cfg, s, err);
  } finally {
    if (s && s.browser) {
      try {
        await s.browser.close();
      } catch (e) {
        /* ignore */
      }
    }
  }
}

function helpText() {
  return [
    'playwright-driver.mjs — dsh-onestep P0 浏览器验证器（headless Edge）',
    '',
    '用法:',
    '  node scripts/p0/verify/playwright-driver.mjs <命令> [参数]',
    '',
    '命令:',
    '  smoke       打开实例 → 等前端就绪 → 采集 boot/console/DOM/CSS/截图 → 写 artifacts/p0/verify/smoke.json + smoke.png',
    '  boot        只等 window.__DSH_BOOT__ 出现（更快），采集同一份快照',
    '  eval        在页面上下文执行 --expr <js>（对象字面量用 ({...}) 包裹）',
    '  probe       在页面上下文执行 --script <js 文件>（按函数体执行，可 return/await；首行 // @expr 则按表达式执行；可用 window.__P0__ helper）',
    '  screenshot  截图（--screenshot 默认 artifacts/p0/verify/screenshot.png）',
    '',
    '公共参数:',
    '  --url-file <path>   含 token 的 URL 文件（默认 artifacts/p0/server-url.txt；每次运行都重新读取，不缓存 token）',
    '  --url <url>         直接给 URL（替代 --url-file）',
    '  --out <path>        结果 JSON 落盘（smoke 默认 artifacts/p0/verify/smoke.json）',
    '  --screenshot <png>  截图路径（smoke 默认 artifacts/p0/verify/smoke.png）',
    '  --full-page         整页截图',
    '  --timeout <ms>      goto/就绪等待上限（默认 60000）',
    '  --wait-for <sel>    就绪后再等某选择器可见',
    '  --wait-ms <ms>      就绪后额外静置（smoke 默认 2500，其它 800）',
    '  --headless <bool>   默认 true',
    '  --channel <name>    playwright channel（默认 msedge）',
    '  --executable-path   显式浏览器可执行文件',
    '  --viewport <WxH>    默认 1440x900',
    '  --color-scheme <s>  light|dark|no-preference（模拟 prefers-color-scheme；DSH 偏好为 system 时切换主题，S10 双主题截图用）',
    '  --console-limit <n> console 事件上限（默认 1000）',
    '  --print <mode>      stdout 输出 full|summary|none（有 --out 时默认 summary）',
    '  --quiet             不向 stdout 打印',
    '  --verbose           stderr 打进度',
    '  --reveal-token      输出不掩码 token（默认掩码）',
    '',
    '退出码: 0 OK / 2 用法 / 3 目标不可达或鉴权 / 4 浏览器启动 / 5 超时 / 6 页面脚本错误 / 7 其它',
    '',
    '示例:',
    '  node scripts/p0/verify/playwright-driver.mjs smoke',
    '  node scripts/p0/verify/playwright-driver.mjs eval --expr "document.title"',
    '  node scripts/p0/verify/playwright-driver.mjs eval --expr "({entries: (window.__DSH_BOOT__||{}).entries?.length})"',
    '  node scripts/p0/verify/playwright-driver.mjs probe --script scripts/p0/verify/probes/example.js --out artifacts/p0/verify/probe-example.json',
  ].join('\n');
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    log('fatal: ' + String((err && err.stack) || err));
    process.exitCode = EXIT.INTERNAL;
  });
