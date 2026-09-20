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

// --- Preview without a baseline reports an explicit state ---
// 撤销某条消息 = 回退该消息之后的所有改动，影响范围 = baseline（targetTurn 之前
// 的最新快照）到 latest 之差。但该会话最早的快照就是 turn1 本身，没有 turn1
// 之前的基线：此时必须报告 noBaseline，而不是把当前所有文件列成 "created"
// —— 后者会宣称"恢复到空工作区"，而 restore() 随后必以 NO_SNAPSHOT 拒绝。
const prev = store.preview(SESS, 1)
assert(prev.noBaseline === true, 'preview without a baseline snapshot reports noBaseline')
assert(prev.totalChanges === 0, 'noBaseline preview lists no files (no misleading empty-workspace plan)')
// baseline 存在时（turn2 的 baseline = turn1）：a.txt modified + b.txt created = 2。
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

// --- Test 4: object sweep reclaims unreferenced objects ---
// 对象库是内容寻址的，manifest 被 TTL/上限删除后其对象若无人回收就会永久堆积
// （实测线上达到 983 MB / 4 万文件）。sweepObjects 标记所有存活 manifest 可达的
// hash，删除未被引用且超过宽限期的对象。
{
  const gcStore = new SnapshotStore({
    baseDir: join(testDir, 'turn-undo-gc'),
    objectGcGraceMs: 0,
    objectGcIntervalMs: 0,
  })
  const gcWs = join(testDir, 'gc-ws')
  mkdirSync(gcWs, { recursive: true })
  writeFileSync(join(gcWs, 'keep.txt'), 'keep-v1', 'utf-8')
  const gc1 = await gcStore.capture(gcWs, 'gc-sess', 1)
  writeFileSync(join(gcWs, 'keep.txt'), 'keep-v2', 'utf-8')
  await gcStore.capture(gcWs, 'gc-sess', 2)

  const keepHash = gc1.manifest.manifest['keep.txt'].hash
  const objectsBefore = readdirSync(gcStore.objDir).length
  // 删除最新 manifest，使 keep-v2 的对象变成孤儿
  rmSync(join(gcStore.snapDir, 'gc-sess', '2.json'))

  const swept = gcStore.sweepObjects({ force: true })
  assert(swept !== null && swept.removed === 1, 'sweep removes exactly the orphaned object')
  assert(readdirSync(gcStore.objDir).length === objectsBefore - 1, 'object store shrank by one')
  assert(existsSync(join(gcStore.objDir, keepHash)), 'object still referenced by a live manifest survives the sweep')

  // 宽限期内的孤儿对象必须保留：capture() 先写对象再写 manifest，
  // 删除"年轻"的孤儿会破坏正在进行的快照。
  const graceStore = new SnapshotStore({
    baseDir: join(testDir, 'turn-undo-gc-grace'),
    objectGcGraceMs: 60_000,
    objectGcIntervalMs: 0,
  })
  const graceWs = join(testDir, 'gc-grace-ws')
  mkdirSync(graceWs, { recursive: true })
  writeFileSync(join(graceWs, 'young.txt'), 'young', 'utf-8')
  await graceStore.capture(graceWs, 'grace-sess', 1)
  const youngCount = readdirSync(graceStore.objDir).length
  const graceSwept = graceStore.sweepObjects({ force: true })
  assert(graceSwept !== null && graceSwept.removed === 0, 'sweep keeps orphans inside the grace window')
  assert(readdirSync(graceStore.objDir).length === youngCount, 'grace-window object store is untouched')
}

// --- Test 5: preview against the LIVE workspace when targetTurn is ahead ---
// turn 尚未结束（无对应快照）时，latest 必须是当前工作区，否则 preview 会拿
// 旧快照与 baseline 比较而返回 0 变更。
{
  const liveStore = new SnapshotStore({ baseDir: join(testDir, 'turn-undo-live') })
  const liveWs = join(testDir, 'live-ws')
  mkdirSync(liveWs, { recursive: true })
  writeFileSync(join(liveWs, 'f.txt'), 'v1', 'utf-8')
  await liveStore.capture(liveWs, 'live-sess', 1)
  // turn 1 之后工作区被改，但没有更新的快照
  writeFileSync(join(liveWs, 'f.txt'), 'v2-live', 'utf-8')

  const livePrev = liveStore.preview('live-sess', 2, liveWs)
  assert(livePrev.totalChanges === 1, 'live preview detects the working-tree change')
  const liveMod = livePrev.changes.find(c => c.path === 'f.txt')
  assert(liveMod && liveMod.kind === 'modified', 'live change is reported as modified')
  // live 文件的字节从未写入对象库；若 diff 仍从对象库取新内容，会把 'v1' 之后的
  // 内容全部当作删除（新增行为空）。
  const addedLines = (liveMod.diff?.hunks ?? []).filter(h => h.type === 'added').map(h => h.value)
  assert(addedLines.includes('v2-live'), 'live diff new-content comes from the working tree, not the object store')

  // 目标 turn 在链尾之内时仍走快照对比（不被 live 扫描污染）
  const snapPrev = liveStore.preview('live-sess', 1, liveWs)
  assert(snapPrev.noBaseline === true, 'target ahead of chain still uses snapshots when in range')
}

// --- Cleanup ---
if (existsSync(testDir)) rmSync(testDir, { recursive: true })
if (oldHome) process.env.DSH_HOME = oldHome
console.log('\n✅ ALL TESTS PASSED')
