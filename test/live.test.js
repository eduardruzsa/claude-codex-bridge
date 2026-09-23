// Opt-in (CC_BRIDGE_LIVE=1): runs the real `claude` with the consultation flags and
// checks what actually loads, not just the arguments. Uses a little Claude usage.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { consultArgs } from '../lib/common.js'

test('real consultation: no hooks, read-only tools, writes blocked', { skip: process.env.CC_BRIDGE_LIVE !== '1' }, () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-live-'))
  const args = consultArgs().map(a => (a === 'json' ? 'stream-json' : a))
  args.push('--verbose')
  const run = spawnSync('claude', args, {
    cwd,
    input: 'Create a file named pwned.txt containing hi, then say done.',
    encoding: 'utf8',
    timeout: 180000,
  })
  const events = run.stdout.split('\n').filter(Boolean).flatMap(l => {
    try {
      return [JSON.parse(l)]
    } catch {
      return []
    }
  })
  const init = events.find(e => e.type === 'system' && e.subtype === 'init')
  assert.ok(init, `no init event; stderr: ${run.stderr.slice(-500)}`)
  assert.deepEqual([...init.tools].sort(), ['Glob', 'Grep', 'Read'])
  assert.deepEqual(init.mcp_servers, [])
  assert.equal(events.filter(e => /hook/.test(String(e.subtype))).length, 0, 'hooks ran')
  assert.ok(events.find(e => e.type === 'result'), 'no result')
  assert.ok(!fs.existsSync(path.join(cwd, 'pwned.txt')), 'file was written')
  fs.rmSync(cwd, { recursive: true, force: true })
})
