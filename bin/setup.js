#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { root, install, minimumNode, supportedNode } from '../lib/admin.js'

try {
  if (!supportedNode()) throw new Error(`Node ${minimumNode} or newer is required.`)
  const deps = spawnSync('npm', ['ci'], { cwd: root, stdio: 'inherit' })
  if (deps.status !== 0) throw new Error('npm ci failed; configuration was not changed.')
  console.log(install())
} catch (e) { console.error(e.message); process.exitCode = 1 }
