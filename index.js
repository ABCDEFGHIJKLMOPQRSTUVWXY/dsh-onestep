/**
 * dsh-onestep —— 宿主半（Node 侧）。
 *
 * P0 阶段定位：只做「装载事实」探针，不注册任何面向用户的能力。
 * - 记录 apply / dispose 事件（console + 可选 JSONL 文件），作为 S1「最小持久插件可装载」
 *   的宿主侧一手证据；
 * - 日志文件路径来自 patch 配置 `probeLog` 或环境变量 `ONESTEP_P0_LOG`（不硬编码本机路径）；
 * - 卸载/热重载时 dispose 会把守卫复位，保证同一 fiber 重复 apply 幂等。
 *
 * 约定：本文件是 ESM（package.json "type":"module"），与 dsh-session-board 的宿主半同形。
 */
import fs from 'node:fs'
import path from 'node:path'

const VERSION = '1.0.2'
const TAG = '[onestep]'

/** 幂等守卫：cordis 同一 fiber 只 apply 一次；dispose 后复位。 */
let applied = false

function resolveLogPath(ctx) {
  try {
    const fromConfig = ctx && ctx.config && ctx.config.probeLog
    if (typeof fromConfig === 'string' && fromConfig) return fromConfig
  } catch (e) {
    /* ignore config shape differences */
  }
  const fromEnv = process.env.ONESTEP_P0_LOG
  return typeof fromEnv === 'string' && fromEnv ? fromEnv : null
}

function appendJsonl(file, record) {
  if (!file) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
  } catch (e) {
    console.log(TAG + ' ' + JSON.stringify({ event: 'host.log.write-failed', error: String(e && e.message ? e.message : e) }))
  }
}

function emit(ctx, record) {
  try {
    console.log(TAG + ' ' + JSON.stringify(record))
  } catch (e) {
    /* console is best effort */
  }
  appendJsonl(resolveLogPath(ctx), record)
}

export const inject = []

export function apply(ctx, config) {
  if (applied) {
    emit(ctx, { event: 'host.apply.skipped', reason: 'already-applied', version: VERSION, pid: process.pid })
    return
  }
  applied = true
  emit(ctx, {
    t: new Date().toISOString(),
    event: 'host.apply',
    version: VERSION,
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    configSeen: config === undefined ? null : typeof config,
    hasSlotsService: false,
  })

  ctx.effect(() => {
    return () => {
      applied = false
      emit(ctx, { t: new Date().toISOString(), event: 'host.dispose', version: VERSION, pid: process.pid })
    }
  }, 'dsh-onestep: P0 host probe lifecycle')
}
