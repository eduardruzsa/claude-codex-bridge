#!/usr/bin/env node
// Pass a private launch request to Terminal.app. Environment values stay out of
// AppleScript and shell history; the new agent gets the sender's cleaned env.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { runtimeDir } from '../lib/common.js'
import { agentEnv } from '../lib/launch.js'
import { terminalScript, terminalShellCommand } from '../lib/mac-terminal.js'

if (process.argv[2] === '--run') {
  const file = process.argv[3]
  const request = JSON.parse(fs.readFileSync(file, 'utf8'))
  fs.unlinkSync(file)
  fs.rmdirSync(path.dirname(file))
  const child = spawn(request.argv[0], request.argv.slice(1), {
    cwd: request.cwd, env: agentEnv(request.env), stdio: 'inherit',
  })
  child.once('error', err => { console.error(err.message); process.exitCode = 1 })
  child.once('exit', code => { process.exitCode = code ?? 1 })
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig))
} else {
  const [cwd, title, ...argv] = process.argv.slice(2)
  if (!cwd || !argv.length) throw new Error('usage: mac-terminal.js <cwd> <title> <command> [args...]')
  const base = runtimeDir()
  fs.mkdirSync(base, { recursive: true, mode: 0o700 })
  const dir = fs.mkdtempSync(path.join(base, 'terminal-'))
  fs.chmodSync(dir, 0o700)
  const file = path.join(dir, 'request.json')
  fs.writeFileSync(file, JSON.stringify({ cwd, argv, env: agentEnv() }), { mode: 0o600 })
  const child = spawn('/usr/bin/osascript', ['-e', terminalScript, terminalShellCommand(file), title], { stdio: ['ignore', 'ignore', 'inherit'] })
  const cleanup = () => { fs.rmSync(dir, { recursive: true, force: true }) }
  child.once('error', err => { cleanup(); console.error(err.message); process.exitCode = 1 })
  child.once('exit', code => { if (code !== 0) cleanup(); process.exitCode = code ?? 1 })
}
