import fs from 'node:fs'

// One version for the MCP servers, doctor and the plugin manifest (checked by a test).
export const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
