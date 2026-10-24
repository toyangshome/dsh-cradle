/**
 * Move the Cradle memory from the pre-fix fallback location to the
 * profile-scoped path, preserving the sovereign identity so the agent is not
 * silently reborn. Safe to re-run: it never overwrites an existing target.
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh')
const profile = (process.env.DSH_PROFILE ?? '').trim()
const legacy = join(home, 'cradle', 'sovereign.json')
const target = process.env.CRADLE_STATE_PATH
  ?? (profile !== '' ? join(home, 'profiles', profile, 'cradle', 'sovereign.json') : legacy)

if (!existsSync(legacy)) {
  console.log(`no legacy store at ${legacy}; nothing to migrate`)
  process.exit(0)
}
if (existsSync(target)) {
  console.log(`target already exists at ${target}; leaving it untouched`)
  console.log(`  legacy did: ${JSON.parse(readFileSync(legacy, 'utf8')).identity?.did}`)
  console.log(`  target did: ${JSON.parse(readFileSync(target, 'utf8')).identity?.did}`)
  process.exit(0)
}

mkdirSync(dirname(target), { recursive: true })
copyFileSync(legacy, target)
const copy = JSON.parse(readFileSync(target, 'utf8'))
console.log(`migrated memory to ${target}`)
console.log(`  preserved did: ${copy.identity?.did}`)
console.log(`  journal rows:  ${copy.journal?.length ?? 0}`)
