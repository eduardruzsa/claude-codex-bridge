// Plan cross-review hooks, driven like Claude Code / Codex drive them: JSON on stdin,
// JSON decision on stdout. Reviewers are fake codex/claude binaries.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-plan-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))
const calls = path.join(tmp, 'calls.jsonl')

// Fake reviewers: reply with $FAKE_REVIEW (or fail when it is "FAIL"), log how they were called.
const log = `require('fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), guard: process.env.CC_BRIDGE_PLAN_REVIEW, prompt: input }) + '\\n')`
fs.writeFileSync(path.join(tmp, 'codex'), `#!/usr/bin/env node
let input = ''; process.stdin.on('data', d => (input += d)).on('end', () => {
  ${log}
  if (process.env.FAKE_REVIEW === 'FAIL') { console.error('boom'); process.exit(3) }
  const a = process.argv.slice(2); require('fs').writeFileSync(a[a.indexOf('-o') + 1], process.env.FAKE_REVIEW)
})`, { mode: 0o755 })
fs.writeFileSync(path.join(tmp, 'claude'), `#!/usr/bin/env node
let input = ''; process.stdin.on('data', d => (input += d)).on('end', () => {
  ${log}
  console.log(JSON.stringify({ result: process.env.FAKE_REVIEW, session_id: 's', is_error: process.env.FAKE_REVIEW === 'FAIL' }))
})`, { mode: 0o755 })

const baseEnv = {
  ...process.env,
  CC_BRIDGE_CODEX_BIN: path.join(tmp, 'codex'),
  CC_BRIDGE_CLAUDE_BIN: path.join(tmp, 'claude'),
  CC_BRIDGE_DATA_DIR: path.join(tmp, 'data'),
  CC_BRIDGE_PLAN_REVIEW: '',
}
function hook(side, input, review = '- step 2 misses the migration') {
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'plan-review'), side], {
    input: JSON.stringify(input), encoding: 'utf8', env: { ...baseEnv, FAKE_REVIEW: review },
  })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout ? JSON.parse(r.stdout) : null
}
const lastCall = () => fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse).at(-1)
const exitPlan = (session, plan = '# Plan\n1. Do X\n2. Do Y') =>
  ({ hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_input: { plan }, session_id: session, cwd: tmp })

test('Claude plan: Codex findings send it back once; the revised plan passes; the next plan is reviewed again', () => {
  const first = hook('--claude', exitPlan('s1'))
  assert.equal(first.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(first.hookSpecificOutput.permissionDecisionReason, /Codex reviewed this plan[\s\S]*step 2 misses the migration[\s\S]*call ExitPlanMode again/)
  const call = lastCall()
  assert.deepEqual(call.args.slice(0, 6), ['exec', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', '-C'])
  assert.equal(call.cwd, fs.realpathSync(tmp))
  assert.equal(call.guard, '0', 'reviewer runs with plan review off')
  assert.match(call.prompt, /Claude Code wrote[\s\S]*1\. Do X/)

  assert.equal(hook('--claude', exitPlan('s1', '# Plan v2')), null, 'revised plan passes')
  assert.equal(hook('--claude', exitPlan('s2')).hookSpecificOutput.permissionDecision, 'deny', 'other sessions are independent')
  assert.equal(hook('--claude', exitPlan('s1', '# Another plan')).hookSpecificOutput.permissionDecision, 'deny', 'a later plan is reviewed again')
})

test('Claude plan: LGTM and reviewer failure pass with a visible note', () => {
  assert.match(hook('--claude', exitPlan('s3'), 'LGTM\n- minor: name things').systemMessage, /^Codex reviewed this plan: LGTM/)
  assert.match(hook('--claude', exitPlan('s3'), 'FAIL').systemMessage, /Codex plan review unavailable/)
  assert.equal(hook('--claude', { ...exitPlan('s3'), tool_name: 'Bash' }), null)
})

test('Codex plan: Claude findings continue the turn once; non-plan turns are untouched', () => {
  const msg = 'Here it is.\n<proposed_plan>\n# Plan\n1. Refactor\n</proposed_plan>'
  const first = hook('--codex', { hook_event_name: 'Stop', last_assistant_message: msg, stop_hook_active: false, cwd: tmp })
  assert.equal(first.decision, 'block')
  assert.match(first.reason, /Claude Code reviewed your proposed plan[\s\S]*step 2 misses[\s\S]*<proposed_plan> block/)
  const call = lastCall()
  assert.ok(call.args.includes('--restricted') && call.args.includes('--strict-mcp-config'))
  assert.match(call.prompt, /Codex wrote[\s\S]*1\. Refactor/)
  assert.doesNotMatch(call.prompt, /<proposed_plan>\s*#/, 'plan is passed without its tags')

  assert.equal(hook('--codex', { last_assistant_message: msg, stop_hook_active: true, cwd: tmp }), null)
  assert.equal(hook('--codex', { last_assistant_message: 'just chatting', stop_hook_active: false, cwd: tmp }), null)
  assert.match(hook('--codex', { last_assistant_message: msg, cwd: tmp }, 'LGTM').systemMessage, /^Claude reviewed this plan: LGTM/)
})

test('CC_BRIDGE_PLAN_REVIEW=0 disables both hooks', () => {
  for (const [side, input] of [['--claude', exitPlan('s4')], ['--codex', { last_assistant_message: '<proposed_plan>x</proposed_plan>' }]]) {
    const r = spawnSync(process.execPath, [path.join(root, 'bin', 'plan-review'), side], {
      input: JSON.stringify(input), encoding: 'utf8', env: { ...baseEnv, CC_BRIDGE_PLAN_REVIEW: '0' },
    })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
  }
})
