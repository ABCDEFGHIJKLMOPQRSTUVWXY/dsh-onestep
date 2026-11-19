#!/usr/bin/env node
/**
 * s7-drag-demo.mjs — S7 可行性 demo：headless 下「真实鼠标拖拽侧栏会话行到页面中央」
 *
 * 目的：验证 headless Edge + Playwright 能否触发 HTML5 dragstart（带 data-row-key / dataTransfer），
 *      并区分两种通路：
 *        A) page.mouse.down/move/up  —— 合成鼠标事件，看 Chromium 是否进入原生 HTML5 拖拽
 *        B) page.dragAndDrop(...)    —— Playwright 的 CDP 拖拽实现
 *      两种都采集页面内的 dragstart/dragenter/dragover/drop/dragend 事件序列（捕获阶段）。
 *
 * 用法（从仓库根）：
 *   node scripts/p0/verify/s7-drag-demo.mjs
 *   node scripts/p0/verify/s7-drag-demo.mjs --url-file artifacts/p0/server-url.txt --out artifacts/p0/verify/s7-drag-demo.json
 *
 * 输出：stdout 一份 JSON；--out 落盘；截图 artifacts/p0/verify/s7-drag-before.png / s7-drag-after.png。
 * 退出码：0 demo 跑完（无论拖拽是否成功，看 JSON 结论）；3 目标不可达/鉴权；4 启动失败；5 就绪超时。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const TOOLS_PW = path.join(REPO_ROOT, 'tools', 'pw');
const OUT_DIR = path.join(REPO_ROOT, 'artifacts', 'p0', 'verify');
const DEFAULT_URL_FILE = path.join(REPO_ROOT, 'artifacts', 'p0', 'server-url.txt');

const EXIT = { OK: 0, USAGE: 2, TARGET: 3, LAUNCH: 4, TIMEOUT: 5, INTERNAL: 7 };

function clip(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function log(msg) {
  process.stderr.write('[s7-drag] ' + msg + '\n');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
  const opts = {
    urlFile: DEFAULT_URL_FILE,
    out: path.join(OUT_DIR, 's7-drag-demo.json'),
    timeout: 60000,
    viewport: { width: 1440, height: 900 },
    headless: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url-file') opts.urlFile = path.resolve(argv[++i]);
    else if (a === '--url') opts.url = argv[++i];
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--timeout') opts.timeout = Number(argv[++i]);
    else if (a === '--viewport') {
      const m = String(argv[++i]).match(/^(\d+)x(\d+)$/);
      if (!m) throw new Error('--viewport 需要 WxH');
      opts.viewport = { width: Number(m[1]), height: Number(m[2]) };
    } else if (a === '--headed') opts.headless = false;
    else throw new Error('未知参数: ' + a);
  }
  return opts;
}

function readUrl(opts) {
  let raw;
  if (opts.url) raw = opts.url;
  else {
    if (!fs.existsSync(opts.urlFile)) throw new Error('URL 文件不存在: ' + opts.urlFile);
    raw = fs
      .readFileSync(opts.urlFile, 'utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
  }
  if (!raw) throw new Error('URL 为空');
  const url = new URL(raw.replace(/^['"]|['"]$/g, '').trim());
  return url;
}

function maskUrl(u) {
  return String(u).replace(/([?&]token=)[^&#\s"']*/gi, '$1***');
}

async function loadPlaywright() {
  const req = createRequire(path.join(TOOLS_PW, 'package.json'));
  return req('playwright-core');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const url = readUrl(opts);
  const masked = maskUrl(url.toString());
  log('target ' + masked);

  // 预检
  let preflight;
  try {
    const res = await fetch(url.toString(), { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const body = await res.text().catch(() => '');
    preflight = { status: res.status, ok: res.status >= 200 && res.status < 400, bodyHead: clip(body.replace(/\s+/g, ' ').trim(), 160) };
  } catch (e) {
    preflight = { status: null, ok: false, error: String((e && e.cause && e.cause.code) || (e && e.message) || e) };
  }
  if (!preflight.ok) {
    const out = {
      ok: false,
      error: { code: preflight.status === 401 ? 'AUTH_REQUIRED' : 'TARGET_UNREACHABLE', message: `实例不可用: HTTP ${preflight.status}`, preflight, target: masked },
    };
    writeAndPrint(opts, out);
    return preflight.status === 401 ? EXIT.TARGET : EXIT.TARGET;
  }

  const pw = await loadPlaywright();
  let browser;
  try {
    browser = await pw.chromium.launch({ channel: 'msedge', headless: opts.headless, args: ['--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio'] });
  } catch (e) {
    const out = { ok: false, error: { code: 'LAUNCH_FAILED', message: clip(e.message, 600), hint: '确认 Edge 可用或传 --headed' } };
    writeAndPrint(opts, out);
    return EXIT.LAUNCH;
  }

  const result = {
    ok: true,
    target: masked,
    browser: { version: browser.version(), headless: opts.headless, viewport: opts.viewport },
    timings: { preflightMs: null },
    source: null,
    attempts: [],
    verdict: null,
    warnings: [],
  };
  const startedAt = Date.now();

  try {
    const context = await browser.newContext({ viewport: opts.viewport, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    const page = await context.newPage();

    // 页面事件（诊断用）
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(clip(String((e && e.stack) || e), 500)));
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(clip(m.text(), 500));
    });

    const gotoResp = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: opts.timeout });
    result.httpStatus = gotoResp ? gotoResp.status() : null;
    if (result.httpStatus === 401) throw new Error('AUTH_REQUIRED');

    // 等前端就绪
    const readyStart = Date.now();
    await page.waitForFunction(
      () => !!window.__DSH_BOOT__ && !!document.querySelector('[role="textbox"], textarea, [contenteditable="true"]'),
      null,
      { timeout: opts.timeout, polling: 150 },
    );
    result.timings.readyMs = Date.now() - readyStart;

    // 预览版弹窗（可选）
    try {
      const cont = page.getByRole('button', { name: '继续', exact: true });
      if ((await cont.count()) > 0 && (await cont.first().isVisible())) {
        await cont.first().click({ timeout: 3000 });
        result.previewPopupClicked = true;
      }
    } catch (e) {
      /* 忽略 */
    }
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
    await sleep(1200);

    // 注入拖拽事件记录器（捕获阶段，能看到拖拽源自身的事件）
    await page.evaluate(() => {
      window.__S7__ = { events: [], seq: 0, mode: null };
      const rec = (type, e) => {
        const t = e.target;
        const rowEl = t && t.closest ? t.closest('[data-row-key]') : null;
        let types = null;
        const data = {};
        try {
          types = e.dataTransfer ? Array.from(e.dataTransfer.types) : null;
        } catch (x) {
          /* 忽略 */
        }
        try {
          if (e.dataTransfer && types) {
            for (const k of types) {
              try {
                data[k] = String(e.dataTransfer.getData(k)).slice(0, 200);
              } catch (x) {
                /* 忽略 */
              }
            }
          }
        } catch (x) {
          /* 忽略 */
        }
        window.__S7__.events.push({
          seq: ++window.__S7__.seq,
          type,
          mode: window.__S7__.mode,
          targetTag: t && t.tagName ? t.tagName : null,
          rowKey: rowEl ? rowEl.getAttribute('data-row-key') : null,
          targetCls: t && t.className ? String(t.className).slice(0, 100) : null,
          draggableAttr: t && t.getAttribute ? t.getAttribute('draggable') : null,
          dataTransferTypes: types,
          dataTransferData: data,
          defaultPrevented: e.defaultPrevented,
          clientX: e.clientX,
          clientY: e.clientY,
          ts: Date.now(),
        });
      };
      for (const type of ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend', 'dragleave']) {
        document.addEventListener(type, (e) => rec(type, e), true);
      }
    });

    // 找源元素：优先 [data-row-key] 且自身或祖先 draggable=true；否则左半屏任意 draggable
    const sourceInfo = await page.evaluate(() => {
      const describe = (el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          cls: String(el.className || '').slice(0, 100),
          rowKey: el.getAttribute('data-row-key'),
          draggable: el.getAttribute('draggable'),
          text: String(el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        };
      };
      const rows = Array.from(document.querySelectorAll('[data-row-key]'));
      const draggableOf = (row) => {
        let el = row;
        for (let i = 0; i < 8 && el; i += 1, el = el.parentElement) {
          if (el.getAttribute && el.getAttribute('draggable') === 'true') return el;
        }
        return null;
      };
      // 优先「会话行」（data-row-key 以 session: 开头且可拖），其次任意可拖行，最后任意可见行
      const sessionRows = rows.filter((r) => /^session:/.test(r.getAttribute('data-row-key') || ''));
      let source = null;
      let sourceRow = null;
      for (const row of sessionRows) {
        const d = draggableOf(row);
        if (d) {
          source = d;
          sourceRow = row;
          break;
        }
      }
      if (!source) {
        for (const row of rows) {
          const d = draggableOf(row);
          if (d) {
            source = d;
            sourceRow = row;
            break;
          }
        }
      }
      if (!source) {
        const probe = rows.find((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 20 && r.height > 10;
        });
        if (probe) {
          source = probe;
          sourceRow = probe;
        }
      }
      if (source) source.setAttribute('data-s7-source', '1');
      const rowKeyOf = (el) => (el && el.getAttribute ? el.getAttribute('data-row-key') : null);
      return {
        rowsCount: rows.length,
        sessionRowsCount: sessionRows.length,
        draggablesCount: document.querySelectorAll('[draggable="true"]').length,
        preferredKind: sourceRow && /^session:/.test(rowKeyOf(sourceRow) || '') ? 'session-row' : 'other-row',
        source: source ? describe(source) : null,
        sourceRow: sourceRow ? describe(sourceRow) : null,
        rowSamples: rows.slice(0, 5).map(describe),
        sidebarCandidates: Array.from(document.querySelectorAll('aside,[class*="sidebar"],[data-sidebar]')).slice(0, 3).map(describe),
      };
    });
    result.source = sourceInfo;
    if (!sourceInfo.source) {
      result.ok = false;
      result.error = { code: 'SOURCE_NOT_FOUND', message: '未找到可拖拽的侧栏会话行（[data-row-key] 或 [draggable=true]）', hint: '请先在 UI 里打开左侧会话列表；也可用 probe sidebar-dom 检查 DOM' };
      result.screenshot = await shot(page, 's7-drag-before.png');
      writeAndPrint(opts, result);
      return EXIT.OK;
    }

    const s = sourceInfo.source;
    const sourceCenter = { x: s.rect.x + Math.round(s.rect.w / 2), y: s.rect.y + Math.round(s.rect.h / 2) };
    const targetCenter = { x: Math.round(opts.viewport.width / 2), y: Math.round(opts.viewport.height / 2) };
    result.drag = { sourceCenter, targetCenter };
    result.screenshotBefore = await shot(page, 's7-drag-before.png');

    // ---- 尝试 A：page.mouse.down / move / up ----
    await page.evaluate(() => {
      window.__S7__.events = [];
      window.__S7__.mode = 'mouse';
    });
    await page.mouse.move(sourceCenter.x, sourceCenter.y);
    await sleep(120);
    await page.mouse.down();
    await sleep(80);
    for (let i = 1; i <= 12; i += 1) {
      const x = sourceCenter.x + ((targetCenter.x - sourceCenter.x) * i) / 12;
      const y = sourceCenter.y + ((targetCenter.y - sourceCenter.y) * i) / 12;
      await page.mouse.move(x, y, { steps: 3 });
      await sleep(35);
    }
    await sleep(200);
    await page.mouse.up();
    await sleep(400);
    const mouseEvents = await page.evaluate(() => window.__S7__.events.slice());
    result.attempts.push(summarizeAttempt('mouse.down/move/up', mouseEvents));
    result.screenshotAfterMouse = await shot(page, 's7-drag-after-mouse.png');

    // 刷新页面重置（避免 A 尝试残留状态影响 B）
    if (!result.attempts[0].dragstart) {
      log('mouse 通路未触发 dragstart，刷新后尝试 dragAndDrop');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: opts.timeout }).catch(() => {});
      await page.waitForFunction(() => !!window.__DSH_BOOT__ && !!document.querySelector('[role="textbox"], textarea, [contenteditable="true"]'), null, { timeout: opts.timeout, polling: 150 }).catch(() => {});
      await sleep(800);
      await page.evaluate(() => {
        window.__S7__ = { events: [], seq: 0, mode: 'dragAndDrop' };
        const rec = (type, e) => {
          const t = e.target;
          const rowEl = t && t.closest ? t.closest('[data-row-key]') : null;
          let types = null;
          try {
            types = e.dataTransfer ? Array.from(e.dataTransfer.types) : null;
          } catch (x) {
            /* 忽略 */
          }
          window.__S7__.events.push({
            seq: ++window.__S7__.seq,
            type,
            mode: window.__S7__.mode,
            targetTag: t && t.tagName ? t.tagName : null,
            rowKey: rowEl ? rowEl.getAttribute('data-row-key') : null,
            targetCls: t && t.className ? String(t.className).slice(0, 100) : null,
            dataTransferTypes: types,
            defaultPrevented: e.defaultPrevented,
            clientX: e.clientX,
            clientY: e.clientY,
          });
        };
        for (const type of ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend']) {
          document.addEventListener(type, (e) => rec(type, e), true);
        }
      });
      // 重新标记源（刷新后属性丢失）
      const redo = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('[data-row-key]'));
        let el = rows[0] || null;
        if (el) el.setAttribute('data-s7-source', '1');
        const r = el ? el.getBoundingClientRect() : null;
        return { found: !!el, rect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null };
      });
      if (redo.found) {
        try {
          await page.dragAndDrop('[data-s7-source="1"]', 'body', { targetPosition: { x: targetCenter.x, y: targetCenter.y }, timeout: 20000 });
        } catch (e) {
          result.attempts.push({ mode: 'page.dragAndDrop', error: clip(e.message, 400), events: await page.evaluate(() => window.__S7__.events.slice()) });
          result.dragAndDropError = clip(e.message, 600);
        }
        await sleep(400);
        if (!result.attempts.some((a) => a.mode === 'page.dragAndDrop')) {
          const cdpEvents = await page.evaluate(() => window.__S7__.events.slice());
          result.attempts.push(summarizeAttempt('page.dragAndDrop', cdpEvents));
        }
      }
    } else {
      log('mouse 通路已触发 dragstart，跳过 dragAndDrop 对照（可选）');
    }

    result.screenshotAfter = await shot(page, 's7-drag-after.png');
    result.consoleErrors = consoleErrors.slice(0, 20);
    result.timings.totalMs = Date.now() - startedAt;

    const mouseAttempt = result.attempts.find((a) => a.mode === 'mouse.down/move/up');
    const cdpAttempt = result.attempts.find((a) => a.mode === 'page.dragAndDrop');
    result.verdict = {
      mouseTriggeredDragstart: !!(mouseAttempt && mouseAttempt.dragstart),
      mouseTriggeredDrop: !!(mouseAttempt && mouseAttempt.drop),
      dragAndDropTriggeredDragstart: !!(cdpAttempt && cdpAttempt.dragstart),
      dragAndDropTriggeredDrop: !!(cdpAttempt && cdpAttempt.drop),
      canUseForS7: !!(mouseAttempt && mouseAttempt.dragstart) || !!(cdpAttempt && cdpAttempt.dragstart),
      recommended: mouseAttempt && mouseAttempt.dragstart ? 'page.mouse (真实鼠标事件，可读 dataTransfer)' : cdpAttempt && cdpAttempt.dragstart ? 'page.dragAndDrop (CDP)' : 'none',
    };
    writeAndPrint(opts, result);
    return EXIT.OK;
  } catch (e) {
    const msg = String((e && e.message) || e);
    result.ok = false;
    result.error = {
      code: /AUTH_REQUIRED|401/.test(msg) ? 'AUTH_REQUIRED' : /Timeout|timeout/.test(msg) ? 'TIMEOUT' : 'INTERNAL',
      message: clip(msg, 2000),
      hint: /AUTH_REQUIRED/.test(msg) ? 'token 已过期：重新读取 Lead 实例的新 URL' : null,
    };
    writeAndPrint(opts, result);
    return result.error.code === 'AUTH_REQUIRED' ? EXIT.TARGET : result.error.code === 'TIMEOUT' ? EXIT.TIMEOUT : EXIT.INTERNAL;
  } finally {
    try {
      await browser.close();
    } catch (e) {
      /* 忽略 */
    }
  }
}

function summarizeAttempt(mode, events) {
  const dragstart = events.find((e) => e.type === 'dragstart');
  const drop = events.find((e) => e.type === 'drop');
  const dragend = events.find((e) => e.type === 'dragend');
  return {
    mode,
    eventsCount: events.length,
    eventTypes: [...new Set(events.map((e) => e.type))],
    dragstart: dragstart || null,
    dragstartRowKey: dragstart ? dragstart.rowKey : null,
    dragstartDataTransferTypes: dragstart ? dragstart.dataTransferTypes : null,
    dragstartDataTransferData: dragstart ? dragstart.dataTransferData : null,
    dragend: dragend ? { defaultPrevented: dragend.defaultPrevented } : null,
    drop: drop ? { targetTag: drop.targetTag, targetCls: drop.targetCls, defaultPrevented: drop.defaultPrevented, dataTransferTypes: drop.dataTransferTypes } : null,
    events: events.slice(0, 40),
  };
}

async function shot(page, name) {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const p = path.join(OUT_DIR, name);
    await page.screenshot({ path: p });
    return { path: p, relativePath: path.relative(REPO_ROOT, p).split(path.sep).join('/'), bytes: fs.statSync(p).size };
  } catch (e) {
    return { error: clip(e.message, 300) };
  }
}

function writeAndPrint(opts, obj) {
  const text = JSON.stringify(obj, null, 2);
  try {
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.writeFileSync(opts.out, text + '\n', 'utf8');
  } catch (e) {
    log('写 --out 失败: ' + clip(e.message, 300));
  }
  process.stdout.write(text + '\n');
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    log('fatal: ' + String((e && e.stack) || e));
    process.exitCode = EXIT.INTERNAL;
  });
