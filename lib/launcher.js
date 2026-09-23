import fs from 'node:fs'
import path from 'node:path'

const quote = s => `'${s.replaceAll("'", "'\\''")}'`
export function launchArgs(args, root, dir, label, node = process.execPath) {
  const forwarded = []
  let settings = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--settings' || args[i].startsWith('--settings=')) {
      const value = args[i] === '--settings' ? args[++i] : args[i].slice('--settings='.length)
      if (!value) throw new Error('--settings requires JSON or a file path')
      settings = { ...settings, ...JSON.parse(value.trim().startsWith('{') ? value : fs.readFileSync(value, 'utf8')) }
    } else forwarded.push(args[i])
  }
  const hooks = { ...settings.hooks }
  const command = [node, path.join(root, 'bin', 'lifecycle-hook.js'), dir].map(quote).join(' ')
  for (const event of ['SessionStart', 'SessionEnd']) {
    hooks[event] = [...(hooks[event] || []), { hooks: [{ type: 'command', command, timeout: 4 }] }]
  }
  settings = { ...settings, hooks }
  const config = { mcpServers: { 'cc-bridge': { command: node, args: [path.join(root, 'claude-channel.js')],
    env: { CC_BRIDGE_LABEL: label, CC_BRIDGE_LIFECYCLE_DIR: dir } } } }
  return ['--mcp-config', JSON.stringify(config), '--settings', JSON.stringify(settings),
    '--dangerously-load-development-channels', 'server:cc-bridge', ...forwarded]
}
