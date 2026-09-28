import path from 'node:path'

export const shellQuote = value => `'${String(value).replaceAll("'", `'\\''`)}'`
// argv goes through AppleScript's run handler, never through its source parser.
export const terminalScript = `on run argv
  tell application "Terminal"
    activate
    set newTab to do script (item 1 of argv)
    set custom title of newTab to (item 2 of argv)
  end tell
end run`
export function terminalShellCommand(file, node = process.execPath) {
  return [node, path.resolve(import.meta.dirname, '../bin/mac-terminal.js'), '--run', file].map(shellQuote).join(' ')
}
