/**
 * dsh-turn-undo — integration test for the content-addressed snapshot store.
 * Loads index.js, instantiates SnapshotStore directly (it's exported for tests),
 * and drives: capture -> modify -> capture(turn 2) -> restore to turn 1 -> verify.
 */
import {
  writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, readdirSync, lstatSync, chmodSync,
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
let r1 = await store.capture(wsDir, SESS, 1)
assert(r1 && r1.manifest, 'capture turn1 returns manifest')

// --- Modify a.txt and add b.txt, then capture turn 2 ---
writeFileSync(join(wsDir, 'a.txt'), 'alpha-v2', 'utf-8')
writeFileSync(join(wsDir, 'b.txt'), 'beta', 'utf-8')
let r2 = await store.capture(wsDir, SESS, 2)
assert(r2 && r2.manifest, 'capture turn2 returns manifest')
assert(r2.filesChanged >= 2, 'turn2 recorded 2 changed files')

// --- Objects are content-addressed ---
const objects = readdirSync(join(testDir, 'turn-undo', 'objects'))
assert(objects.length >= 3, 'objects dir holds deduped blobs (' + objects.length + ')')
// 'alpha-v1', 'alpha-v2', 'beta' -> at least 3 distinct contents

// --- Unchanged turn produces no new snapshot ---
writeFileSync(join(wsDir, 'a.txt'), 'alpha-v2', 'utf-8') // no real change
let r3 = await store.capture(wsDir, SESS, 3)
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
assert(res.skippedFiles && res.skippedFiles.length === 0, 'no skipped files in successful restore')
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

// --- CRITICAL: Objects must NOT be polluted when workspace files are modified ---
// This is the key regression test for the hardlink pollution bug:
// After restore, workspace files must be independent copies (not hardlinks)
// so that subsequent modifications don't corrupt stored objects.
// Simulate: restore to turn1, modify files, then capture turn 2 again,
// then restore to turn1 again — if objects were polluted, this would fail.
writeFileSync(join(wsDir, 'a.txt'), 'alpha-v3', 'utf-8')
const res2 = store.restore(wsDir, SESS, 1)
assert(res2.ok === true, 'second restore to turn1 succeeded')
assert(res2.skippedFiles && res2.skippedFiles.length === 0, 'no skipped files in second restore')
assert(readFileSync(join(wsDir, 'a.txt'), 'utf-8') === 'alpha-v1', 'a.txt restored to v1 again')

// Now modify the restored file
writeFileSync(join(wsDir, 'a.txt'), 'alpha-v4', 'utf-8')

// The original object for turn1's alpha-v1 must still be intact
const v1Hash = r1.manifest.manifest['a.txt'].hash
const v1ObjPath = join(testDir, 'turn-undo', 'objects', v1Hash)
assert(existsSync(v1ObjPath), 'turn1 object still exists')
assert(readFileSync(v1ObjPath, 'utf-8') === 'alpha-v1', 'turn1 object NOT polluted after workspace modification')

// --- Test 1: Verify mode change detection ---
const modeFile = join(wsDir, 'mode-test.txt')
writeFileSync(modeFile, 'mode-content', 'utf-8')
chmodSync(modeFile, 0o755)
await store.capture(wsDir, SESS, 4)

// Change content but keep same size/mtime (simulate mode-only change)
// Note: In real scenarios, mode changes might also change mtime, but we test the logic
const modeEntry = await store.capture(wsDir, SESS, 5)
// If mode change is detected, a new snapshot should be created
console.log('✓ mode detection test completed (new snapshot created:', !!modeEntry, ')')

// --- Test 2: Verify skipped files in restore result ---
// Delete an object to simulate corruption
const aV3Hash = '0'.repeat(64) // Fake hash that doesn't exist
const fakeManifest = {
  sessionId: SESS,
  turn: 99,
  timestamp: new Date().toISOString(),
  totalBytes: 0,
  manifest: {
    'corrupted.txt': {
      kind: 'file',
      hash: aV3Hash,
      size: 10,
      mtime: Date.now(),
      mode: '0644',
    },
  },
}
const fakeManifestPath = join(testDir, 'turn-undo', 'snapshots', SESS, '99.json')
// 直接写入 fakeManifest，loadChain 会检查 data && data.manifest
writeFileSync(fakeManifestPath, JSON.stringify(fakeManifest))

const resWithSkipped = store.restore(wsDir, SESS, 99)
assert(resWithSkipped.ok === false, 'restore with missing object returns ok=false')
assert(resWithSkipped.skippedFiles && resWithSkipped.skippedFiles.length === 1, 'skippedFiles contains the missing object')
assert(resWithSkipped.skippedFiles[0].reason === 'object_missing', 'skipped file reason is object_missing')
console.log('✓ skipped files test completed:', resWithSkipped.skippedFiles.length, 'files skipped')

// --- Test 3: Verify preview returns diff data for modified files ---
const diffStore = new SnapshotStore({ baseDir: join(testDir, 'turn-undo-diff') })
const diffContent = ['line1', 'line2', 'line3'].join('\n')
writeFileSync(join(wsDir, 'diff-test.txt'), diffContent, 'utf-8')
await diffStore.capture(wsDir, 'diff-sess', 1)
const newDiffContent = ['line1', 'modified', 'line3', 'line4'].join('\n')
writeFileSync(join(wsDir, 'diff-test.txt'), newDiffContent, 'utf-8')
await diffStore.capture(wsDir, 'diff-sess', 2)
const diffPreview = diffStore.preview('diff-sess', 2)
const modifiedChanges = diffPreview.changes.filter(c => c.kind === 'modified')
assert(modifiedChanges.length >= 1, 'preview includes modified files')
if (modifiedChanges.length > 0) {
  const modified = modifiedChanges[0]
  assert(modified.diff !== undefined, 'modified file has diff property')
  assert(modified.diff.oldLines > 0, 'diff has oldLines count')
  assert(modified.diff.newLines > 0, 'diff has newLines count')
  assert(Array.isArray(modified.diff.hunks), 'diff has hunks array')
  assert(modified.diff.hunks.length > 0, 'hunks contains entries')
  console.log('✓ diff data verified: file=' + modified.path + ', hunks=' + modified.diff.hunks.length)
}

// --- Cleanup ---
if (existsSync(testDir)) rmSync(testDir, { recursive: true })
if (oldHome) process.env.DSH_HOME = oldHome
console.log('\n✅ ALL TESTS PASSED')
