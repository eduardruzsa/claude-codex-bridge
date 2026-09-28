import fs from 'node:fs'
import path from 'node:path'
import { shQuote } from './admin.js'

// argv goes through AppleScript's run handler, never through its source parser.
export const terminalScript = `on run argv
  tell application "Terminal"
    activate
    set newTab to do script (item 1 of argv)
    set custom title of newTab to (item 2 of argv)
  end tell
end run`
export function terminalShellCommand(file, node = process.execPath) {
  return [node, path.resolve(import.meta.dirname, '../bin/mac-terminal.js'), '--run', file].map(shQuote).join(' ')
}

// osascript succeeding only means Terminal accepted the command. The request holds
// the agent's environment, so remove it if the new shell hasn't taken it in time.
export async function awaitHandoff(dir, timeout = 60000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (!fs.existsSync(dir)) return true
    await new Promise(r => setTimeout(r, 200))
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return false
}
