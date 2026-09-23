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
if (process.argv[2] === 'mcp') {
  if (process.env.FAKE_REVIEW === 'NOLIST') process.exit(1)
  const odd = process.env.FAKE_REVIEW === 'ODDNAME' ? [{ name: 'odd.name' }] : []
  console.log(JSON.stringify([{ name: 'serena' }, { name: 'cc-bridge' }, ...odd])); process.exit(0)
}
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

// Plan review is opt-in; these tests turn it on in their own config file.
const configFile = path.join(tmp, 'config.json')
fs.writeFileSync(configFile, JSON.stringify({ plan_review: { review_claude_plans: true, review_codex_plans: true } }))
const baseEnv = {
  ...process.env,
  CODEX_HOME: path.join(tmp, 'codex-home'), // never read the user's Codex sessions
  CC_BRIDGE_CONFIG: configFile,
  CC_BRIDGE_CODEX_BIN: path.join(tmp, 'codex'),
  CC_BRIDGE_CLAUDE_BIN: path.join(tmp, 'claude'),
  CC_BRIDGE_DATA_DIR: path.join(tmp, 'data'),
  CC_BRIDGE_PLAN_REVIEW: '',
  CC_BRIDGE_CLAUDE_PROC: 'none',
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
  // Isolated: hooks/plugins/apps off and every configured MCP server disabled, then read-only.
  assert.deepEqual(call.args.slice(0, 11), ['exec', '--disable', 'hooks', '--disable', 'plugins', '--disable', 'apps',
    '-c', 'mcp_servers.serena.enabled=false', '-c', 'mcp_servers.cc-bridge.enabled=false'])
  assert.deepEqual(call.args.slice(11, 16), ['--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check', '-C'])
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
  // If the MCP servers can't be listed (so not disabled), the reviewer doesn't run at all.
  const before = fs.readFileSync(calls, 'utf8')
  assert.match(hook('--claude', exitPlan('s3'), 'NOLIST').systemMessage, /unavailable \(cannot list Codex MCP servers/)
  assert.match(hook('--claude', exitPlan('s3'), 'ODDNAME').systemMessage, /unavailable \(cannot disable Codex MCP server\(s\) odd\.name/)
  assert.equal(fs.readFileSync(calls, 'utf8'), before)
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

test('Codex plan mode: the plan is a separate Plan item, not in last_assistant_message', () => {
  // Same shape as a real Codex 0.156 plan-mode rollout: commentary is the "last" message.
  const turn = '01a0cd82-e614-7e71-8c46-da15a51aaf68'
  const session = '01a0cd82-6db5-76c1-93da-0bb66be86ce0'
  const rollout = path.join(tmp, 'sessions', '2026', '09', '23', `rollout-2026-09-23T11-04-32-${session}.jsonl`)
  fs.mkdirSync(path.dirname(rollout), { recursive: true })
  fs.writeFileSync(rollout, [
    { type: 'turn_context', payload: { turn_id: 'older-turn' } },
    { type: 'event_msg', payload: { type: 'item_completed', turn_id: 'older-turn', item: { type: 'Plan', text: '# Old plan' } } },
    { type: 'turn_context', payload: { turn_id: turn } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Verified: all good.' }] } },
    { type: 'event_msg', payload: { type: 'item_completed', turn_id: turn, item: { type: 'Plan', text: '# Sentiment plan\n1. Preserve research' } } },
  ].map(e => JSON.stringify(e)).join('\n') + '\n')
  const base = { hook_event_name: 'Stop', last_assistant_message: 'Verified: all good.', stop_hook_active: false, cwd: tmp }
  for (const input of [
    { ...base, transcript_path: rollout, turn_id: turn },
    { ...base, session_id: session }, // no transcript_path: found under CODEX_HOME/sessions
  ]) {
    const r = spawnSync(process.execPath, [path.join(root, 'bin', 'plan-review'), '--codex'], {
      input: JSON.stringify(input), encoding: 'utf8', env: { ...baseEnv, FAKE_REVIEW: '- missing rollback', CODEX_HOME: tmp },
    })
    assert.equal(JSON.parse(r.stdout).decision, 'block', r.stderr)
    assert.match(lastCall().prompt, /# Sentiment plan\n1\. Preserve research/)
    assert.doesNotMatch(lastCall().prompt, /Old plan/)
  }
  // Every decision is in the bridge transcript for `cc-bridge log`.
  const logged = fs.readFileSync(path.join(tmp, 'data', 'transcript.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(logged.some(e => e.event === 'plan_review' && e.author === 'codex' && e.reviewer === 'claude' && e.outcome === 'sent back to revise'))
})

test('plan review is off by default; CC_BRIDGE_PLAN_REVIEW=1 turns it on for a session', () => {
  const off = path.join(tmp, 'no-config.json')
  for (const [side, input] of [['--claude', exitPlan('s5')], ['--codex', { last_assistant_message: '<proposed_plan>x</proposed_plan>', cwd: tmp }]]) {
    const run = extra => spawnSync(process.execPath, [path.join(root, 'bin', 'plan-review'), side], {
      input: JSON.stringify(input), encoding: 'utf8', env: { ...baseEnv, CC_BRIDGE_CONFIG: off, FAKE_REVIEW: 'LGTM', ...extra },
    })
    assert.equal(run().stdout, '', `${side} is not reviewed without config`)
    assert.match(run({ CC_BRIDGE_PLAN_REVIEW: '1' }).stdout, /reviewed this plan: LGTM/)
  }
})

test('a broken config never blocks a plan', () => {
  const broken = path.join(tmp, 'broken.json')
  fs.writeFileSync(broken, '{ "plan_review": ')
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'plan-review'), '--claude'], {
    input: JSON.stringify(exitPlan('s6')), encoding: 'utf8', env: { ...baseEnv, CC_BRIDGE_CONFIG: broken },
  })
  assert.equal(r.status, 0)
  assert.match(JSON.parse(r.stdout).systemMessage, /broken\.json is not valid JSON.*plan shown unreviewed/)
})

test('a reviewer that ignores SIGTERM is killed and the plan passes', () => {
  const quick = path.join(tmp, 'quick.json')
  fs.writeFileSync(quick, JSON.stringify({ plan_review: { review_claude_plans: true, timeout_seconds: 1 } }))
  const stubborn = path.join(tmp, 'stubborn-codex')
  fs.writeFileSync(stubborn, `#!/usr/bin/env node
if (process.argv[2] === 'mcp') { console.log('[]'); process.exit(0) }
process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`, { mode: 0o755 })
  const started = Date.now()
  const r = spawnSync(process.execPath, [path.join(root, 'bin', 'plan-review'), '--claude'], {
    input: JSON.stringify(exitPlan('s7')), encoding: 'utf8', env: { ...baseEnv, CC_BRIDGE_CONFIG: quick, CC_BRIDGE_CODEX_BIN: stubborn },
  })
  assert.equal(r.status, 0, r.stderr)
  assert.match(JSON.parse(r.stdout).systemMessage, /unavailable \(codex exec failed.*timed out after 1s/)
  assert.ok(Date.now() - started < 12000, 'bounded by timeout + kill grace')
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
