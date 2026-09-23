// Stands in for the Codex process: holds rollout-<ts>-<uuid>.jsonl files open
// (one per FAKE_ROLLOUTS thread) and runs codex-mcp.js as its direct child.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(process.env.CC_BRIDGE_DATA_DIR, '..', 'rollouts-'))
for (const t of (process.env.FAKE_ROLLOUTS || '').split(',').filter(Boolean)) {
  fs.openSync(path.join(dir, `rollout-2026-09-23T09-00-00-${t}.jsonl`), 'w')
}
const child = spawn('node', [path.join(import.meta.dirname, '..', 'codex-mcp.js')], { stdio: 'inherit' })
child.on('exit', code => process.exit(code ?? 0))
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig))
