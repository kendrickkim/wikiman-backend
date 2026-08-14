import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dirs = [path.join(root, 'src'), path.join(root, 'scripts'), path.join(root, 'test')]
let failed = 0

function walk(dir) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (/\.(js|mjs)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' })
      if (result.status !== 0) {
        failed += 1
        console.error(result.stderr || result.stdout || full)
      }
    }
  }
}

for (const dir of dirs) walk(dir)
if (failed) {
  console.error(`syntax check failed: ${failed} file(s)`)
  process.exit(1)
}
console.log('syntax check ok')
