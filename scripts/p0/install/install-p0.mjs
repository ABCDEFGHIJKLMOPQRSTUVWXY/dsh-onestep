#!/usr/bin/env node
// Thin wrapper so the repository-level `npm run p0:install` script works on Windows:
// the P0 S1 install harness itself lives in PowerShell (scripts/p0/install/*.ps1).
// Forwards every argument after `--` to install-plugin.ps1.
//
// Usage:
//   npm run p0:install
//   node scripts/p0/install/install-p0.mjs -Tag s1 -NoRestart
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'install-plugin.ps1')

const child = spawn(
  'powershell.exe',
  ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...process.argv.slice(2)],
  { stdio: 'inherit' },
)
child.on('error', (error) => {
  console.error('[install-p0] failed to launch PowerShell:', error.message)
  process.exit(1)
})
child.on('exit', (code) => process.exit(code ?? 1))
