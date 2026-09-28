#!/usr/bin/env node
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { macHelper, withMutex } from '../lib/platform.js'
const root = path.resolve(import.meta.dirname, '..')
// Build early, but don't fail on it: this server runs in every Claude session, and
// without the helper the channel can't identify Claude, so it stays dormant.
if (process.platform === 'darwin') try { macHelper() } catch (e) { console.error(`cc-bridge: ${e.message}`) }
const installed = () => fs.existsSync(path.join(root, 'node_modules/@modelcontextprotocol/sdk'))
if (!installed()) await withMutex(`\0ccb-install-${crypto.createHash('sha256').update(root).digest('hex').slice(0, 40)}`, path.join(root, '.native', 'locks'), async () => {
  if (installed()) return
  const code = await new Promise((resolve, reject) => {
    const child = spawn('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: root, stdio: ['ignore', 2, 2] })
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (code !== 0) throw new Error(`npm ci failed (${code})`)
}, 120000)
// Import in this process: Claude must remain our ancestor and own our lifecycle.
await import('../claude-channel.js')
