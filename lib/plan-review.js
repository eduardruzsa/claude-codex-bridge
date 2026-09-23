// Cross-review of plans before they reach the user: a Claude plan is reviewed by a
// one-shot read-only Codex, a Codex plan by a one-shot read-only Claude. Driven by
// hooks (bin/plan-review). CC_BRIDGE_PLAN_REVIEW=0 turns it off; reviewers run with
// it off so their own hooks never start a nested review.
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { consultArgs, dataDir } from './common.js'

export const REVIEW_TIMEOUT_MS = 8 * 60 * 1000

export function reviewPrompt(author, plan, cwd) {
  return [
    `You are reviewing an implementation plan that ${author} wrote, before it is shown to the user.`,
    `The project is in ${cwd}; read files there as needed (read-only).`,
    'Report only substantive problems: wrong assumptions about the code, missing steps, risks,',
    'a clearly simpler approach, or gaps in how it will be verified. At most 8 bullets, most important first.',
    'If the plan is sound, reply with exactly "LGTM" on the first line, optionally followed by up to 2 short notes.',
    'Do not rewrite the plan and do not use <proposed_plan> tags.',
    '',
    'PLAN:',
    '<<<',
    plan.trim(),
    '>>>',
  ].join('\n')
}

export const isLgtm = review => /^\s*LGTM\b/i.test(review)

function run(cmd, args, { cwd, input }) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, CC_BRIDGE_PLAN_REVIEW: '0' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill('SIGTERM'), REVIEW_TIMEOUT_MS)
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (err += d))
    child.on('error', e => {
      clearTimeout(timer)
      resolve({ code: -1, out, err: e.message })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
    child.stdin.end(input)
  })
}

// The Codex reviewer must not be able to write anything: besides the read-only shell
// sandbox, turn off hooks, plugins and apps, and every configured MCP server (they
// run outside the sandbox). `-c mcp_servers={}` merges rather than replaces, so each
// server is disabled by name; if they can't be listed, don't run the reviewer.
export function codexIsolationArgs(codex = process.env.CC_BRIDGE_CODEX_BIN || 'codex') {
  const r = spawnSync(codex, ['mcp', 'list', '--json'], { encoding: 'utf8', timeout: 15000 })
  let servers
  try {
    servers = JSON.parse(r.stdout)
  } catch {
    throw new Error(`cannot list Codex MCP servers to disable them (${(r.stderr || r.error?.message || 'no output').trim().slice(0, 200)})`)
  }
  // `-c` can only address bare-key names (a quoted key is taken literally).
  const odd = servers.map(s => s.name).filter(n => !/^[A-Za-z0-9_-]+$/.test(n))
  if (odd.length) throw new Error(`cannot disable Codex MCP server(s) ${odd.join(', ')} for the reviewer`)
  return [
    '--disable', 'hooks', '--disable', 'plugins', '--disable', 'apps',
    ...servers.flatMap(s => ['-c', `mcp_servers.${s.name}.enabled=false`]),
  ]
}

// Codex reviews a Claude plan.
export async function codexReview(plan, cwd) {
  const codex = process.env.CC_BRIDGE_CODEX_BIN || 'codex'
  const isolation = codexIsolationArgs(codex)
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-plan-')), 'review.md')
  try {
    const r = await run(codex,
      ['exec', ...isolation, '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', '-C', cwd, '-o', outFile, '-'],
      { cwd, input: reviewPrompt('Claude Code', plan, cwd) })
    const review = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8').trim() : ''
    if (r.code !== 0 || !review) throw new Error(`codex exec failed (${r.code}): ${(r.err || r.out).trim().split('\n').slice(-2).join(' ')}`)
    return review
  } finally {
    fs.rmSync(path.dirname(outFile), { recursive: true, force: true })
  }
}

// Claude reviews a Codex plan (restricted: read/search tools only, no plugins or hooks).
export async function claudeReview(plan, cwd) {
  const r = await run(process.env.CC_BRIDGE_CLAUDE_BIN || 'claude', consultArgs(), { cwd, input: reviewPrompt('Codex', plan, cwd) })
  let result
  try {
    result = JSON.parse(r.out)
  } catch {
    throw new Error(`claude exited ${r.code} without JSON output: ${(r.err || r.out).trim().slice(-300)}`)
  }
  if (result.is_error || !String(result.result || '').trim()) throw new Error(`claude review failed: ${String(result.result || '').slice(0, 300)}`)
  return String(result.result).trim()
}

export function extractProposedPlan(message) {
  return /<proposed_plan>([\s\S]*?)<\/proposed_plan>/.exec(message || '')?.[1]?.trim() || null
}

// Claude side: one review round per plan presentation. After a review sent Claude
// back to revise, its next ExitPlanMode passes and the round resets.
const ROUND_TTL_MS = 2 * 60 * 60 * 1000
function roundFile(session) {
  const dir = path.join(dataDir(), 'plan-review')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return path.join(dir, `claude-${crypto.createHash('sha256').update(String(session)).digest('hex').slice(0, 32)}.json`)
}

export function takeReviewedRound(session, now = Date.now()) {
  const file = roundFile(session)
  try {
    const { at } = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.rmSync(file, { force: true })
    return now - at < ROUND_TTL_MS
  } catch {
    return false
  }
}

export function markReviewedRound(session, now = Date.now()) {
  fs.writeFileSync(roundFile(session), JSON.stringify({ at: now }), { mode: 0o600 })
}
