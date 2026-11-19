#!/usr/bin/env node
/**
 * P2-2 i18n 热切换验证：切换产品语言后舞台窗口不重挂载、文案即时切换。
 *
 * 通过官方设置 UI 切换语言（设置 → 通用 → 语言），全程断言：
 *  1. 舞台上已挂载的官方聊天体 occurrence / 舞台根节点在切换前后是同一 DOM 节点（未重挂载）；
 *  2. 插件文案随语言切换（zh ↔ en）；
 *  3. 切回原语言后文案恢复，窗口仍不重挂载。
 *
 * 用法：
 *   node scripts/p2/i18n-hotswap.mjs --explore   # 只读探查设置/语言行 DOM，不切语言
 *   node scripts/p2/i18n-hotswap.mjs             # 完整验证（需要隔离实例；会临时切换语言并切回）
 * 产物：artifacts/p2/i18n/hotswap.json + hotswap-*.png
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const require = createRequire(path.join(ROOT, 'tools', 'pw') + path.sep)
const { chromium } = require('playwright-core')
const OUT = path.join(ROOT, 'artifacts', 'p2', 'i18n')
const URL_FILE = path.join(ROOT, 'artifacts', 'p2', 'server-url.txt')
const EXPLORE = process.argv.includes('--explore')

const result = { startedAt: new Date().toISOString(), explore: EXPLORE, steps: [], errors: [], consoleErrors: [], pass: {}, ok: false }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const step = (name, data) => {
  result.steps.push({ name, at: new Date().toISOString(), data })
  console.log('[i18n-hotswap] ' + name + ' ' + JSON.stringify(data).slice(0, 700))
}
const shot = async (page, name) => {
  fs.mkdirSync(OUT, { recursive: true })
  await page.screenshot({ path: path.join(OUT, name) })
}

const url = fs.readFileSync(URL_FILE, 'utf8').trim().split('#')[0]
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', locale: 'zh-CN' })
  const page = await context.newPage()
  page.on('pageerror', (error) => result.errors.push(String(error).slice(0, 400)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') result.consoleErrors.push(msg.text().slice(0, 400))
  })
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForFunction(() => !!window.__ONESTEP__, null, { timeout: 60000 })
  await sleep(2000)

  /** 探查 DOM 中可能的“设置”入口（explore 模式用；正式流程走官方快捷键 Ctrl+Alt+,）。 */
  const scanSettingsEntry = async () => {
    const entry = await page.evaluate(() => {
      const candidates = []
      for (const el of document.querySelectorAll('button, [role="button"], a')) {
        const label = [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent].filter(Boolean).join(' ')
        if (/设置|Settings/i.test(label)) candidates.push({ label: label.slice(0, 60), tag: el.tagName, cls: String(el.className).slice(0, 60) })
      }
      return candidates.slice(0, 12)
    })
    step('settings-entry-candidates', entry)
    return entry
  }

  if (EXPLORE) {
    await scanSettingsEntry()
    // 官方设置命令：web 默认 Ctrl+Alt+,
    await page.keyboard.press('Control+Alt+Comma')
    await sleep(1500)
    const dom = await page.evaluate(() => {
      const modal = document.querySelector('[class*="modal" i], [role="dialog"]') || document.body
      const rows = Array.from(modal.querySelectorAll('[class*="row" i], [role="button"], button, select, [role="combobox"]'))
        .map((el) => ({
          tag: el.tagName,
          role: el.getAttribute('role'),
          text: (el.textContent || '').trim().slice(0, 80),
          aria: (el.getAttribute('aria-label') || '').slice(0, 60),
          cls: String(el.className).slice(0, 50),
        }))
        .filter((item) => item.text || item.aria)
        .slice(0, 80)
      return { modalText: (modal.innerText || '').slice(0, 1500), rows }
    })
    step('settings-dom', dom)
    // 点「通用设置」后dump 通用页行
    const generalClicked = await page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('button'))
      const cell = cells.find((el) => /通用/.test(el.textContent || ''))
      if (!cell) return false
      cell.click()
      return true
    })
    step('general-clicked', generalClicked)
    await sleep(1200)
    const general = await page.evaluate(() => {
      const modal = document.querySelector('[class*="modal" i], [role="dialog"]') || document.body
      const rows = Array.from(modal.querySelectorAll('[class*="row" i], [role="button"], button, select, [role="combobox"], [class*="select" i]'))
        .map((el) => ({
          tag: el.tagName,
          role: el.getAttribute('role'),
          text: (el.textContent || '').trim().slice(0, 80),
          aria: (el.getAttribute('aria-label') || '').slice(0, 60),
          cls: String(el.className).slice(0, 50),
          value: el.value || null,
        }))
        .filter((item) => item.text || item.aria)
        .slice(0, 100)
      return { modalText: (modal.innerText || '').slice(0, 2000), rows }
    })
    step('general-dom', general)
    await shot(page, 'hotswap-explore.png')
    result.ok = true
    fs.writeFileSync(path.join(OUT, 'hotswap.json'), JSON.stringify(result, null, 2) + '\n', 'utf8')
    console.log('[i18n-hotswap] explore done -> ' + path.join(OUT, 'hotswap.json'))
    process.exit(0)
  }

  // ---------- 完整验证 ----------
  // 1) 建立舞台（2 个会话：1 焦点 + 1 候场）
  const sessions = await page.evaluate(() => window.__ONESTEP__.actions.listSessions())
  const ids = Object.keys(sessions).filter((id) => !sessions[id].blank).slice(0, 2)
  if (ids.length < 2) throw new Error('需要至少 2 个非空会话，当前=' + JSON.stringify(ids))
  await page.evaluate(async (all) => {
    window.__ONESTEP__.actions.exitStage()
    await new Promise((resolve) => setTimeout(resolve, 400))
    await window.__ONESTEP__.actions.enterStage(all)
  }, ids)
  await page.waitForFunction(() => !!document.querySelector('[data-onestep-stage]'), null, { timeout: 20000 })
  await sleep(1200)
  const baseline = await page.evaluate(() => {
    const stage = document.querySelector('[data-onestep-stage]')
    const occurrences = Array.from(document.querySelectorAll('[data-onestep-stage] [data-onestep-occurrence]'))
    for (const node of [stage, ...occurrences]) node.__onestepMark = 'kept'
    return {
      stageTexts: stage ? stage.innerText.slice(0, 200) : null,
      occurrenceCount: occurrences.length,
      htmlLang: document.documentElement.lang,
      focusAria: (document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]') || {}).getAttribute
        ? document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]').getAttribute('aria-label')
        : null,
      candidateCount: document.querySelectorAll('[data-onestep-stage] .onestep-frame[data-mode="candidate"]').length,
    }
  })
  step('baseline', baseline)
  if (baseline.candidateCount < 1) throw new Error('舞台候选窗为 0，无法验证')
  await shot(page, 'hotswap-before.png')

  // ---------- 2) 官方设置 → 通用 → 语言 ----------
  const LANG_LABEL = /^(中文|English|日本語|Español|Français|Deutsch|Русский|Português)$/
  const readStage = () =>
    page.evaluate(() => {
      const stage = document.querySelector('[data-onestep-stage]')
      const occurrences = Array.from(document.querySelectorAll('[data-onestep-stage] [data-onestep-occurrence]'))
      const focus = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="focus"]')
      const candidate = document.querySelector('[data-onestep-stage] .onestep-frame[data-mode="candidate"]')
      return {
        htmlLang: document.documentElement.lang,
        stageKept: !!stage && stage.__onestepMark === 'kept' && stage.isConnected,
        occurrenceCount: occurrences.length,
        occurrencesKept: occurrences.length > 0 && occurrences.every((node) => node.__onestepMark === 'kept' && node.isConnected),
        focusAria: focus ? focus.getAttribute('aria-label') : null,
        candidateAria: candidate ? candidate.getAttribute('aria-label') : null,
        focusText: focus ? focus.innerText.slice(0, 160) : null,
      }
    })

  const openSettings = async () => {
    await page.keyboard.press('Control+Alt+Comma')
    await sleep(1400)
    const opened = await page.evaluate(() => /通用设置|General/.test(document.body.innerText))
    if (!opened) throw new Error('设置未打开（Ctrl+Alt+,）')
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((el) => /^(通用设置|General)$/.test((el.textContent || '').trim()))
      if (!btn) return false
      btn.click()
      return true
    })
    if (!clicked) throw new Error('未找到「通用设置」页签')
    await sleep(900)
    return true
  }

  const readLanguage = () =>
    page.evaluate((source) => {
      const re = new RegExp(source)
      const btn = Array.from(document.querySelectorAll('button')).find((el) => re.test((el.textContent || '').trim()))
      return btn ? btn.textContent.trim() : null
    }, LANG_LABEL.source)

  const switchLanguage = async (targetLabel) => {
    const current = await page.evaluate((source) => {
      const re = new RegExp(source)
      const btn = Array.from(document.querySelectorAll('button')).find((el) => re.test((el.textContent || '').trim()))
      if (!btn) return null
      btn.click()
      return btn.textContent.trim()
    }, LANG_LABEL.source)
    if (!current) throw new Error('未找到语言选择器')
    await sleep(700)
    const clicked = await page.evaluate((target) => {
      const re = new RegExp(target)
      const candidates = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], button'))
      const item = candidates.find((el) => re.test((el.textContent || '').trim()) && (el.textContent || '').trim().length <= 24)
      if (!item) return null
      item.click()
      return (item.textContent || '').trim()
    }, targetLabel)
    if (!clicked) throw new Error('未找到目标语言项: ' + targetLabel)
    await sleep(1500)
    step('language.switched', { from: current, to: clicked })
    return clicked
  }

  const closeSettings = async () => {
    await page.keyboard.press('Escape')
    await sleep(700)
    const open = await page.evaluate(() => /通用设置|General/.test(document.body.innerText) && !!document.querySelector('[class*="modal" i], [role="dialog"]'))
    if (open) {
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((el) => /^(关闭|Close)$/.test((el.textContent || '').trim()))
        if (btn) btn.click()
      })
      await sleep(600)
    }
  }

  await openSettings()
  const originalLabel = await readLanguage()
  step('language.original', { originalLabel })
  if (originalLabel !== '中文') {
    throw new Error('当前语言不是中文（' + originalLabel + '），为避免改写用户语言偏好，跳过本探针')
  }

  // ---------- 3) 切到 English：文案切换但窗口不重挂载 ----------
  await switchLanguage('^(English|英语)$')
  await closeSettings()
  const afterEn = await readStage()
  step('after-en', afterEn)
  await shot(page, 'hotswap-en.png')
  result.pass.langSwitchEn = String(afterEn.htmlLang).toLowerCase().startsWith('en')
  result.pass.noRemountOnEn = afterEn.stageKept && afterEn.occurrencesKept
  result.pass.copySwitchedEn = /Focus session/i.test(afterEn.focusAria || '') && /Candidate session/i.test(afterEn.candidateAria || '')

  // ---------- 4) 切回中文：文案恢复，窗口仍不重挂载 ----------
  await openSettings()
  await switchLanguage('^中文$')
  await closeSettings()
  const afterZh = await readStage()
  step('after-zh', afterZh)
  await shot(page, 'hotswap-zh-restored.png')
  result.pass.langSwitchZh = /^zh/i.test(afterZh.htmlLang || '')
  result.pass.noRemountOnZh = afterZh.stageKept && afterZh.occurrencesKept
  result.pass.copyRestoredZh = /焦点会话/.test(afterZh.focusAria || '') && /候场会话/.test(afterZh.candidateAria || '')
  result.pass.sameNodesAcrossSwitches =
    afterEn.stageKept && afterEn.occurrencesKept && afterZh.stageKept && afterZh.occurrencesKept

  // 清理：退出舞台（locale 已恢复原样）
  await page.evaluate(() => window.__ONESTEP__.actions.exitStage())
  await sleep(600)

  result.ok = result.pass.langSwitchEn && result.pass.noRemountOnEn && result.pass.copySwitchedEn && result.pass.langSwitchZh && result.pass.noRemountOnZh && result.pass.copyRestoredZh && result.pass.sameNodesAcrossSwitches
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'hotswap.json'), JSON.stringify(result, null, 2) + '\n', 'utf8')
  console.log('[i18n-hotswap] ' + (result.ok ? 'PASS' : 'FAIL') + ' -> ' + path.join(OUT, 'hotswap.json'))
  if (!result.ok) process.exitCode = 1
} catch (error) {
  result.errors.push(String(error && error.stack ? error.stack : error).slice(0, 1200))
  console.error('[i18n-hotswap] FAILED: ' + String(error))
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'hotswap.json'), JSON.stringify(result, null, 2) + '\n', 'utf8')
  process.exitCode = 1
} finally {
  try {
    await browser.close()
  } catch (_error) {
    /* ignore */
  }
}
