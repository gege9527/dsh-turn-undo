/**
 * dsh-turn-undo — integration test for the content-addressed snapshot store.
 * Loads index.js, instantiates SnapshotStore directly (it's exported for tests),
 * and drives: capture -> modify -> capture(turn 2) -> restore to turn 1 -> verify.
 */
import {
  writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, readdirSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const testDir = join(__dirname, 'test-temp')
const wsDir = join(testDir, 'ws')
const oldHome = process.env.DSH_HOME
process.env.DSH_HOME = testDir
if (existsSync(testDir)) rmSync(testDir, { recursive: true })
mkdirSync(testDir, { recursive: true })
mkdirSync(wsDir, { recursive: true })

const mod = await import('./index.js' + '?t=' + Date.now())
const { SnapshotStore } = mod

function assert(cond, msg) {
  if (!cond) throw new Error('✗ ' + msg)
  console.log('✓ ' + msg)
}

const store = new SnapshotStore({ baseDir: join(testDir, 'turn-undo') })
const SESS = 'sess-A'

// --- Workspace state ---
writeFileSync(join(wsDir, 'a.txt'), 'alpha-v1', 'utf-8')

// --- Capture turn 1 (baseline) ---
let r1 = store.capture(wsDir, SESS, 1)
assert(r1 && r1.manifest, 'capture turn1 returns manifest')

// --- Modify a.txt and add b.txt, then capture turn 2 ---
writeFileSync(join(wsDir, 'a.txt'), 'alpha-v2', 'utf-8')
writeFileSync(join(wsDir, 'b.txt'), 'beta', 'utf-8')
let r2 = store.capture(wsDir, SESS, 2)
assert(r2 && r2.manifest, 'capture turn2 returns manifest')
assert(r2.filesChanged >= 2, 'turn2 recorded 2 changed files')

// --- Objects are content-addressed ---
const objects = readdirSync(join(testDir, 'turn-undo', 'objects'))
assert(objects.length >= 3, 'objects dir holds deduped blobs (' + objects.length + ')')
// 'alpha-v1', 'alpha-v2', 'beta' -> at least 3 distinct contents

// --- Unchanged turn produces no new snapshot ---
writeFileSync(join(wsDir, 'a.txt'), 'alpha-v2', 'utf-8') // no real change
let r3 = store.capture(wsDir, SESS, 3)
assert(r3 === null || r3.skipped, 'unchanged turn yields null (no new snapshot)')

// --- Preview lists EVERY change at/after the target turn (undo scope) ---
// 撤销某条消息 = 回退该消息之后的所有改动。因此 preview 的影响范围是从
// targetTurn 之前的最新快照（baseline）到会话最新快照（latest）之差。
// 撤销 turn1：baseline={}（turn1 之前无快照）, latest=turn2 => a.txt+b.txt = 2。
const prev = store.preview(SESS, 1)
assert(prev.totalChanges === 2, 'preview undo-turn1 lists changes at/after turn1 (a.txt,b.txt)')
assert(prev.changes.some(c => c.path === 'b.txt'), 'preview undo-turn1 includes later turn2 change (b.txt)')
// 撤销 turn2：baseline=turn1（a.txt v1）, latest=turn2 => a.txt modified + b.txt created = 2。
const prev2 = store.preview(SESS, 2)
assert(prev2.totalChanges === 2, 'preview undo-turn2 lists turn2 changes (2 files)')

// --- Restore to turn 1: a.txt->v1, b.txt removed ---
// Simulate further drift first.
writeFileSync(join(wsDir, 'a.txt'), 'alpha-v3', 'utf-8')
writeFileSync(join(wsDir, 'c.txt'), 'extra', 'utf-8')
const res = store.restore(wsDir, SESS, 1)
assert(res.ok === true, 'restore to turn1 succeeded')
assert(readFileSync(join(wsDir, 'a.txt'), 'utf-8') === 'alpha-v1', 'a.txt restored to v1')
assert(!existsSync(join(wsDir, 'b.txt')), 'b.txt (absent at turn1) deleted')
assert(!existsSync(join(wsDir, 'c.txt')), 'c.txt (absent at turn1) deleted')

// --- Restore past the newest snapshot falls back to the newest at/before target ---
const far = store.restore(wsDir, SESS, 99)
assert(far.ok === true && far.restoredTurn === 2, 'restore to far-future turn falls back to newest snapshot (turn2)')
assert(readFileSync(join(wsDir, 'a.txt'), 'utf-8') === 'alpha-v2', 'after fallback, a.txt = turn2 content')

// --- Restore before the first snapshot -> NO_SNAPSHOT (no crash) ---
const bad = store.restore(wsDir, SESS, 0)
assert(bad.ok === false && bad.error === 'NO_SNAPSHOT', 'restore before first snapshot returns NO_SNAPSHOT')

// Cleanup
if (existsSync(testDir)) rmSync(testDir, { recursive: true })
if (oldHome) process.env.DSH_HOME = oldHome
console.log('\n✅ ALL TESTS PASSED')
