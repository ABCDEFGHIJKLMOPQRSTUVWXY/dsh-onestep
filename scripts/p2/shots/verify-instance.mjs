#!/usr/bin/env node
/**
 * P2-6 收尾核对：确认隔离实例当前处于「普通模式」（无舞台残留）。
 *
 * 独立临时 context 打开 artifacts/p2/server-url.txt 的实例，断言：
 *  - window.__ONESTEP__ 就绪、boot entries 含 dsh-onestep；
 *  - snapshot().mounted=false、candidates=[]、页面无 [data-onestep-stage]；
 *  - 官方会话/composer 正常；
 * 若发现舞台残留（不应发生），先 exitStage + 重置 localStorage 再复查一次。
 *
 * 产物：artifacts/p2/shots/instance-final.json；不通过 exit 1。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, readServerUrl, openApp, closeApp, snapshot, sleep, sha256File, fileSize } from '../verify/lib.mjs'

const OUT = path.join(ROOT, 'artifacts', 'p2', 'shots', 'instance-final.json')
const result = { at: new Date().toISOString(), ok: false, server: null, checks: {}, error: null }

let app = null
try {
  app = await openApp({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', settleMs: 1800 })
  const { page } = app
  result.server = { origin: new URL(readServerUrl()).origin, urlFile: 'artifacts/p2/server-url.txt' }
  const boot = await page.evaluate(() => {
    const graph = window.__DSH_BOOT__ || {}
    const entry = (graph.entries || []).find((item) => item.id === 'dsh-onestep')
    return { release: graph.release || null, entries: (graph.entries || []).length, hasSelf: !!entry }
  })
  const probeReady = await page.evaluate(() => !!window.__ONESTEP__)
  let snap = await snapshot(page)
  let dom = await page.evaluate(() => ({
    stage: document.querySelectorAll('[data-onestep-stage]').length,
    picker: document.querySelectorAll('[data-onestep-picker="1"]').length,
    quickBars: document.querySelectorAll('.onestep-quick').length,
    editableComposers: document.querySelectorAll('[contenteditable="true"]').length,
    stageStorage: (() => {
      try {
        return JSON.parse(localStorage.getItem('dsh.onestep.v1') || 'null')
      } catch (_error) {
        return null
      }
    })(),
  }))

  if (snap.mounted || (snap.candidates || []).length > 0 || dom.stage > 0) {
    result.checks.stageWasActive = true
    await page.evaluate(() => {
      try {
        window.__ONESTEP__.actions.exitStage()
      } catch (_error) {
        /* ignore */
      }
      localStorage.setItem(
        'dsh.onestep.v1',
        JSON.stringify({ version: 3, candidates: [], railSide: 'left', railSize: 240, railCollapsed: false, previewMode: 'live', autoLite: true, persistStage: true }),
      )
    })
    await sleep(800)
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForFunction(() => !!window.__ONESTEP__, null, { timeout: 60000 })
    await sleep(1800)
    snap = await snapshot(page)
    dom = await page.evaluate(() => ({
      stage: document.querySelectorAll('[data-onestep-stage]').length,
      picker: document.querySelectorAll('[data-onestep-picker="1"]').length,
      quickBars: document.querySelectorAll('.onestep-quick').length,
      editableComposers: document.querySelectorAll('[contenteditable="true"]').length,
      stageStorage: (() => {
        try {
          return JSON.parse(localStorage.getItem('dsh.onestep.v1') || 'null')
        } catch (_error) {
          return null
        }
      })(),
    }))
  }

  result.checks = {
    probeReady,
    bootHasSelf: boot.hasSelf,
    bootEntries: boot.entries,
    bootRelease: boot.release,
    mounted: snap.mounted,
    candidates: snap.candidates,
    stageDom: dom.stage,
    picker: dom.picker,
    quickBars: dom.quickBars,
    editableComposers: dom.editableComposers,
    stageStorage: dom.stageStorage,
    clientJs: { sha256: sha256File(path.join(ROOT, 'client.js')), bytes: fileSize(path.join(ROOT, 'client.js')) },
    lang: await page.evaluate(() => document.documentElement.lang || null),
    theme: await page.evaluate(() => (document.body.getAttribute('data-ds-dark-theme') === '' ? 'dark' : 'light')),
  }
  const pass =
    probeReady &&
    boot.hasSelf &&
    snap.mounted === false &&
    (snap.candidates || []).length === 0 &&
    dom.stage === 0 &&
    dom.picker === 0 &&
    dom.editableComposers >= 1 &&
    (!dom.stageStorage || (Array.isArray(dom.stageStorage.candidates) && dom.stageStorage.candidates.length === 0))
  result.ok = !!pass
  console.log('[verify-instance] ' + (result.ok ? 'PASS' : 'FAIL') + ' ' + JSON.stringify(result.checks))
  if (!result.ok) process.exitCode = 1
} catch (error) {
  result.error = String((error && error.stack) || error)
  console.error('[verify-instance] FATAL ' + String(error))
  process.exitCode = 1
} finally {
  try {
    if (app) await closeApp(app)
  } catch (_error) {
    /* ignore */
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n', 'utf8')
  console.log('[verify-instance] wrote ' + path.relative(ROOT, OUT).replace(/\\/g, '/'))
}
