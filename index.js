/**
 * dsh-turn-undo — server half of the turn-undo plugin.
 *
 * Core mechanisms (content-addressed turn snapshots):
 *   1. Listen to `session/event` for `turn/end` (reliable, covers every file
 *      write including bash shell commands — no tool-argument parsing, which
 *      is impossible for bash and was rejected in design).
 *   2. On turn/end, queue an async workspace snapshot (content-addressed by
 *      sha256, hardlink-reusing unchanged files) into $DSH_HOME/turn-undo/.
 *   3. Restore = fetch a target turn's manifest, align the workspace to it
 *      (write back + delete extra files), skipping excluded dirs.
 *   4. Undo = fork: create a child session from the event prefix BEFORE the
 *      target message via `sessionController.fork` (the same RPC as the web
 *      UI fork button), then rename and archive the old session so it can no
 *      longer be continued. The child log physically omits the undone events
 *      — model context, web transcript and restarts all agree, so no surface
 *      shadowing and no client-side DOM hiding are needed.
 */


import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  renameSync,
  unlinkSync,
  statSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  rmSync,
  chmodSync,
  createWriteStream,
  createReadStream,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, basename, relative, resolve } from 'node:path'

export const name = 'turn-undo'

// Exported for integration testing (class is otherwise module-private).
export { SnapshotStore }

// Injected services (via ctx.inject in apply()): webServer, sessions,
// sessionQuery, sessionController, workspaceController.
export const inject = [
  'webServer',
  'sessions',
  'sessionQuery',
  'sessionController',
  'workspaceController',
]

// ---- Configuration defaults ----
const DEFAULT_SNAPSHOT_TTL_DAYS = 7
const DEFAULT_MAX_SNAPSHOTS_PER_SESSION = 50
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB
const DEFAULT_MAX_FILES_PER_SNAPSHOT = 10000
const DEFAULT_MAX_SNAPSHOT_BYTES = 500 * 1024 * 1024 // 500 MB
const DEFAULT_SNAPSHOT_DELAY_MS = 250
// Object-store GC: unreferenced objects are only reclaimed once they are older
// than the grace window (a capture writes objects before its manifest, so a
// young unreferenced object may still be in flight). The sweep itself is
// throttled because it stats every object and parses every surviving manifest.
const DEFAULT_OBJECT_GC_GRACE_MS = 60 * 60 * 1000
const DEFAULT_OBJECT_GC_INTERVAL_MS = 6 * 60 * 60 * 1000
const DEFAULT_EXCLUDES = [
  'node_modules/',
  '.git/',
  '.venv/',
  'venv/',
  '__pycache__/',
  'target/',
  'dist/',
  'build/',
  '.next/',
  '.turbo/',
  '.gradle/',
  '.idea/',
  '.vscode/',
  'coverage/',
  '.DS_Store',
  '*.log',
]
const API_PATH = '/api/turn-undo'

/**
 * Get the base directory for turn-undo storage.
 */
function getBaseDir(_ctx) {
  const dshHome = process.env.DSH_HOME || join(process.env.HOME || '', '.dsh')
  return join(dshHome, 'turn-undo')
}

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function readJsonFile(filePath) {
  if (!existsSync(filePath)) return null
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

function writeJsonFile(filePath, data) {
  const dir = dirname(filePath)
  ensureDir(dir)
  const tmpFile = filePath + '.tmp'
  writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8')
  try {
    renameSync(tmpFile, filePath)
  } catch {
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
    if (existsSync(tmpFile)) unlinkSync(tmpFile)
  }
}

function json(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value) + '\n')
}

function getCwd(source) {
  return source?.header?.cwd
}

/**
 * Explicit-service variant of readSession for the HTTP handler.
 *
 * The handler runs long after the inject scope's effect — its fiber may be in
 * a LOADING/UNLOADING window (config reload / HMR) where fiber.store is
 * undefined. Resolving services lazily through scope.sessions then throws
 * 'cannot get required service "sessions" in inactive context'. The services
 * are captured as plain references at handler-creation time, so the request
 * path never touches the fiber proxy.
 */
async function readSessionLive(sessions, sessionQuery, sessionId) {
  const live = sessions?.get?.(sessionId)
  if (live) {
    return {
      id: sessionId,
      header: live.header || {},
      events: typeof live.snapshotEvents === 'function'
        ? live.snapshotEvents(0, live.seq)
        : (live.events || []),
    }
  }
  const stored = await sessionQuery?.readSession?.(sessionId)
  if (stored) {
    return {
      id: sessionId,
      header: stored.session || {},
      events: stored.events || [],
    }
  }
  return null
}

async function readSession(ctx, sessionId) {
  const live = ctx.sessions?.get?.(sessionId)
  if (live) {
    // Live Session objects expose snapshotEvents() rather than a public events array.
    return {
      id: sessionId,
      header: live.header || {},
      events: typeof live.snapshotEvents === 'function'
        ? live.snapshotEvents(0, live.seq)
        : (live.events || []),
    }
  }
  const stored = await ctx.sessionQuery?.readSession?.(sessionId)
  if (stored) {
    return {
      id: sessionId,
      header: stored.session || {},
      events: stored.events || [],
    }
  }
  return null
}

// ===========================================================================
// Content-addressed snapshot store
// ===========================================================================

/**
 * Build the ignore predicate from the excludes config. Patterns are matched
 * as path prefixes (for trailing-slash dir patterns) or basename globs
 * (e.g. "*.log"). Simplified but covers common cases.
 */
function makeIgnore(cwd, excludes) {
  const patterns = (excludes || DEFAULT_EXCLUDES).filter(Boolean)
  return function isIgnored(absPath) {
    const rel = relative(cwd, absPath).split('\\').join('/')
    for (const pat of patterns) {
      if (pat.startsWith('*')) {
        // basename glob e.g. "*.log"
        if (pat.slice(1) && basename(rel).endsWith(pat.slice(1))) return true
      } else {
        if (rel === pat || rel.startsWith(pat)) return true
      }
    }
    return false
  }
}

/** sha256 of a file's bytes. */
function hashFile(absPath) {
  const h = createHash('sha256')
  h.update(readFileSync(absPath))
  return h.digest('hex')
}

/**
 * SnapshotStore manages objects/ + snapshots/<session>/<turn>.manifest.
 * Pure Node fs — no git dependency.
 */
class SnapshotStore {
  constructor(cfg) {
    this.base = cfg.baseDir
    this.excludes = cfg.excludes || DEFAULT_EXCLUDES
    this.maxFileBytes = cfg.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.maxFiles = cfg.maxFilesPerSnapshot ?? DEFAULT_MAX_FILES_PER_SNAPSHOT
    this.maxBytes = cfg.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES
    this.ttlDays = cfg.snapshotTtlDays ?? DEFAULT_SNAPSHOT_TTL_DAYS
    this.maxSnapshots = cfg.maxSnapshotsPerSession ?? DEFAULT_MAX_SNAPSHOTS_PER_SESSION
    this.objectGcGraceMs = cfg.objectGcGraceMs ?? DEFAULT_OBJECT_GC_GRACE_MS
    this.objectGcIntervalMs = cfg.objectGcIntervalMs ?? DEFAULT_OBJECT_GC_INTERVAL_MS
    this.lastObjectSweep = 0
    this.objDir = join(this.base, 'objects')
    this.snapDir = join(this.base, 'snapshots')
  }

  /**
   * Capture the workspace at cwd into the session's chain.
   * Returns the manifest (or null if unchanged since the session's last).
   */
  async capture(cwd, sessionId, turn) {
    ensureDir(this.objDir)
    ensureDir(join(this.snapDir, sessionId))

    const ignore = makeIgnore(cwd, this.excludes)
    const chain = this.loadChain(sessionId)
    const prevManifest = chain.length ? chain[chain.length - 1].manifest : null

    const files = this.scan(cwd, ignore)
    if (!files) {
      // Exceeds limits — skip this turn (no snapshot).
      return { skipped: true, reason: 'limits' }
    }

    const manifest = {}
    let filesChanged = 0
    let totalBytes = 0
    for (const p of files) {
      const abs = p
      let st
      try {
        st = lstatSync(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) continue
      if (!st.isFile()) continue
      if (st.size > this.maxFileBytes) continue

      const rel = relative(cwd, abs).split('\\').join('/')
      let entry
      // Reuse previous object if content unchanged (compare size+mtime via
      // prev manifest, else re-hash the file).
      const prev = prevManifest && prevManifest[rel]
      const prevMode = prev && prev.mode
      const currentMode = st.mode.toString(8).padStart(4, '0')
      if (prev && prev.size === st.size && prev.mtime === st.mtimeMs && prevMode === currentMode) {
        entry = prev // unchanged — reuse (no new object written)
      } else {
        const hash = hashFile(abs)
        const objPath = join(this.objDir, hash)
        if (!existsSync(objPath)) {
          await this.copyIntoObjects(abs, objPath)
        }
        entry = {
          kind: 'file',
          hash,
          size: st.size,
          mtime: st.mtimeMs,
          mode: st.mode.toString(8).padStart(4, '0'),
        }
        filesChanged++
      }
      manifest[rel] = entry
      totalBytes += st.size
    }

    // If identical to previous manifest (nothing changed this turn), return null.
    if (prevManifest && this.manifestsEqual(prevManifest, manifest)) {
      return null
    }

    // 记录本 turn 相对上一快照**变化了哪些文件**（changedRels）。
    // 撤销恢复时只回滚这些文件——不是整个工作区在该时间段的所有改动，
    // 否则会把其他会话/外部进程改过的文件也一并回退。
    const changedRels = []
    if (prevManifest) {
      for (const rel of Object.keys(manifest)) {
        const prev = prevManifest[rel]
        if (!prev || prev.hash !== manifest[rel].hash || prev.mode !== manifest[rel].mode) {
          changedRels.push(rel)
        }
      }
      for (const rel of Object.keys(prevManifest)) {
        if (!manifest[rel]) changedRels.push(rel) // 被删除的文件
      }
    }

    const manifestData = {
      sessionId,
      turn,
      timestamp: new Date().toISOString(),
      cwd,
      totalBytes,
      manifest,
      changedRels,
    }
    const mfPath = join(this.snapDir, sessionId, `${turn}.json`)
    writeJsonFile(mfPath, manifestData)
    return { manifest: manifestData, filesChanged }
  }

  /** Recursively list workspace files, applying ignore + limits. */
  scan(cwd, ignore) {
    const files = []
    let total = 0
    let byteCount = 0
    const walk = (dir) => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const ent of entries) {
        const abs = join(dir, ent.name)
        if (ignore(abs)) continue
        let st
        try {
          st = lstatSync(abs)
        } catch {
          continue
        }
        if (st.isDirectory()) {
          if (files.length + total > this.maxFiles) return
          walk(abs)
        } else if (st.isFile()) {
          if (files.length >= this.maxFiles) return
          if (st.size > this.maxFileBytes) { total++ ; continue }
          byteCount += st.size
          if (byteCount > this.maxBytes) return
          files.push(abs)
        }
      }
    }
    walk(cwd)
    if (files.length > this.maxFiles || byteCount > this.maxBytes) {
      return null // over limits -> skip snapshot
    }
    return files
  }

  /**
   * Recursively list all workspace file paths, applying ignore but with NO
   * capacity caps. Used by restore's pruning step so a large/overflowing
   * workspace still has its "extra" files removed to match the snapshot.
   */
  walkAll(cwd, ignore) {
    const files = []
    const walk = (dir) => {
      let entries
      try {
        entries = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const ent of entries) {
        const abs = join(dir, ent.name)
        if (ignore(abs)) continue
        let st
        try {
          st = lstatSync(abs)
        } catch {
          continue
        }
        if (st.isDirectory()) {
          walk(abs)
        } else if (st.isFile()) {
          files.push(abs)
        }
      }
    }
    walk(cwd)
    return files
  }

  /**
   * Store a workspace file into the objects dir.
   *
   * MUST be a real copy, NOT a hard link: a hard link shares the inode with the
   * live workspace file, and any later in-place write to the workspace file
   * (the common `writeFileSync` / `>>` append path) would silently corrupt the
   * object. Content addressing already dedupes (same bytes -> one object) and
   * unchanged files reuse the previous manifest hash without writing a new
   * object, so a copy costs space only for genuinely new content.
   *
   * A hard link is used ONLY when restoring an object back into the workspace,
   * where the newly-materialized file is immediately superseded by the next
   * turn's capture and there is no long-lived object to corrupt.
   */
  async copyIntoObjects(src, dst) {
    let success = false
    try {
      copyFileSync(src, dst)
      success = true
    } catch {
      // e.g. src vanished mid-read; try streaming fallback
      try {
        const rs = createReadStream(src)
        const ws = createWriteStream(dst)
        await new Promise((resolve, reject) => {
          rs.on('error', reject)
          ws.on('error', reject)
          ws.on('finish', resolve)
        })
        success = true
      } catch (e) {
        console.warn('[turn-undo] object write failed:', e.message)
      }
    }
    // Verify the written object hash matches the source
    if (success) {
      const srcHash = hashFile(src)
      const dstHash = hashFile(dst)
      if (srcHash !== dstHash) {
        // Hash mismatch — file was corrupted during copy
        try { unlinkSync(dst) } catch {}
        throw new Error(`Object hash mismatch: expected ${srcHash}, got ${dstHash}`)
      }
    }
  }

  /** Materialize an object into the workspace (write-back during restore). */
  materializeObject(objPath, dest, mode) {
    try {
      unlinkSync(dest)
    } catch { /* may not exist */ }
    ensureDir(dirname(dest))
    copyFileSync(objPath, dest)
    if (mode) chmodSync(dest, parseInt(mode, 8))
  }

  manifestsEqual(a, b) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    for (const k of ka) {
      const ea = a[k]
      const eb = b[k]
      if (!eb) return false
      if (ea.kind !== eb.kind) return false
      if (ea.hash !== eb.hash) return false
      if (ea.mode !== eb.mode) return false
    }
    return true
  }

  /** Read an object file from the content-addressed store and return its text content. */
  readObjectContent(hash) {
    if (!hash) return null
    const objPath = join(this.objDir, hash)
    if (!existsSync(objPath)) return null
    try {
      return readFileSync(objPath, 'utf-8')
    } catch {
      return null
    }
  }

  /** Generate a simple line-based diff between two arrays of lines. */
  generateDiff(oldLines, newLines, contextLines = 10) {
    const m = oldLines.length
    const n = newLines.length
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (oldLines[i - 1] === newLines[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
        }
      }
    }

    const result = []
    let i = m
    let j = n

    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
        result.push({ type: 'same', value: oldLines[i - 1] })
        i--
        j--
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        result.push({ type: 'added', value: newLines[j - 1] })
        j--
      } else {
        result.push({ type: 'removed', value: oldLines[i - 1] })
        i--
      }
    }

    result.reverse()

    // 如果有上下文行数限制，过滤只保留变化行及其上下文
    if (contextLines > 0) {
      // 找出所有变化的行索引
      const changedIndices = new Set()
      for (let idx = 0; idx < result.length; idx++) {
        if (result[idx].type !== 'same') {
          changedIndices.add(idx)
        }
      }

      // 标记需要包含的行
      const keepIndices = new Set()
      for (const idx of changedIndices) {
        // 保留变化行本身
        keepIndices.add(idx)
        // 保留前后 contextLines 行
        for (let k = 1; k <= contextLines; k++) {
          if (idx - k >= 0) keepIndices.add(idx - k)
          if (idx + k < result.length) keepIndices.add(idx + k)
        }
      }

      // 过滤结果
      const filtered = []
      for (let idx = 0; idx < result.length; idx++) {
        if (keepIndices.has(idx)) {
          filtered.push(result[idx])
        } else if (result[idx].type === 'same') {
          // 省略相同行标记
          filtered.push({ type: 'same', value: '...' })
        }
      }

      // 合并连续的省略标记
      const merged = []
      for (const item of filtered) {
        if (item.type === 'same' && item.value === '...') {
          if (merged.length > 0 && merged[merged.length - 1].value === '...') {
            continue // 跳过连续的省略
          }
        }
        merged.push(item)
      }

      return merged
    }

    return result
  }

  /** Load snapshot manifests for a session, oldest first. */
  loadChain(sessionId) {
    const dir = join(this.snapDir, sessionId)
    if (!existsSync(dir)) return []
    const out = []
    for (const f of readdirSync(dir).filter(x => x.endsWith('.json')).sort(numeric)) {
      const data = readJsonFile(join(dir, f))
      if (data && data.manifest) out.push(data)
    }
    return out
  }

  /**
   * Restore ONLY the files this session changed in turns AFTER the target
   * message. Files the session never touched (other sessions, external
   * processes, pre-existing state) are left alone.
   * Creates a safety snapshot first. Returns stats.
   */
  restore(cwd, sessionId, targetTurn) {
    const chain = this.loadChain(sessionId)
    // Use the cwd from the latest snapshot (captures the workspace root at
    // capture time). This avoids cross-workspace bugs when the session's
    // header.cwd has changed or is wrong (e.g. forked from another workspace).
    const snapCwd = chain.length ? (chain[chain.length - 1].cwd ?? cwd) : cwd
    // baseline = NEWEST snapshot strictly BEFORE the target message (the state
    // right before that message was sent). turn/start snapshots are turn-0.5;
    // the message's own turn/end snapshot is AFTER the message, so strictly < .
    let baseline = null
    for (const m of chain) {
      if (m.turn < targetTurn && (baseline === null || m.turn > baseline.turn)) {
        baseline = m
      }
    }
    if (!baseline) {
      return { ok: false, error: 'NO_SNAPSHOT' }
    }

    const resolveCwd = snapCwd || cwd
    const ignore = makeIgnore(resolveCwd, this.excludes)

    // 收集 (baseline.turn, latest.turn] 之间**每个快照相对上一快照变化过的文件**
    // （changedRels）的并集 = 本会话在目标消息之后动过的文件。
    //
    // **只由已落盘快照决定**——不并入当前工作区状态（buildLiveManifest）。
    // 共享 cwd 的多会话/外部进程会把别处改动混进快照链，但基线之后若
    // **没有**新快照（纯对话 turn），本会话就没动过文件 → affected 为空。
    const affected = new Map() // rel -> true
    const baselineManifest = baseline.manifest
    const latest = chain[chain.length - 1]
    const latestManifest = latest.manifest
    let hasSnapshotAfterBaseline = false
    let anyChangedRels = false
    for (const m of chain) {
      if (m.turn <= baseline.turn) continue
      hasSnapshotAfterBaseline = true
      if (Array.isArray(m.changedRels) && m.changedRels.length) {
        anyChangedRels = true
        for (const rel of m.changedRels) affected.set(rel, true)
      }
    }
    if (!hasSnapshotAfterBaseline) {
      affected.clear()
    } else if (!anyChangedRels) {
      // 旧格式快照无 changedRels：退化到快照间 diff（baseline vs 最新快照）。
      for (const rel of Object.keys(baselineManifest)) {
        if (!latestManifest[rel] || latestManifest[rel].hash !== baselineManifest[rel].hash) {
          affected.set(rel, true)
        }
      }
      for (const rel of Object.keys(latestManifest)) {
        if (!baselineManifest[rel]) affected.set(rel, true)
      }
    }

    let restoredFiles = 0
    let deletedFiles = 0
    const skippedFiles = []
    const failedDeletions = []

    // 1. For each affected file: restore to the baseline (pre-message) state.
    for (const rel of affected.keys()) {
      const abs = resolve(resolveCwd, rel)
      if (ignore(abs)) continue
      const entry = baselineManifest[rel]
      if (entry) {
        try {
          ensureDir(dirname(abs))
          if (entry.kind === 'file') {
            const objPath = join(this.objDir, entry.hash)
            if (!existsSync(objPath)) {
              skippedFiles.push({ path: rel, reason: 'object_missing' })
              continue
            }
            this.materializeObject(objPath, abs, entry.mode)
            restoredFiles++
          }
        } catch (e) {
          skippedFiles.push({ path: rel, reason: 'materialize_failed', error: e.message })
        }
      } else {
        // File did not exist at baseline (created after the target message): delete it.
        try {
          rmSync(abs, { force: true })
          deletedFiles++
        } catch (e) {
          failedDeletions.push({ path: rel, error: e.message })
        }
      }
    }

    if (failedDeletions.length > 0) {
      console.warn('[turn-undo] restore failed to delete', failedDeletions.length, 'files:', failedDeletions.map(f => f.path).join(', '))
    }

    const result = {
      ok: skippedFiles.length === 0 && failedDeletions.length === 0,
      restoredFiles,
      deletedFiles,
      skippedFiles,
      failedDeletions,
      targetTurn,
      restoredTurn: baseline.turn,
      totalFiles: affected.size,
    }
    // Log skipped files for debugging
    if (skippedFiles.length > 0) {
      console.warn('[turn-undo] restore skipped', skippedFiles.length, 'files:', skippedFiles.map(f => f.path).join(', '))
    }
    return result
  }


  /**
   * Clean old snapshots (TTL + per-session cap).
   *
   * 性能：`sweepObjects()` 是 mark-and-sweep 全对象库扫描（可达数百 MB /
   * 数万文件），不能每次 capture 都跑。由 enqueueCapture 节流调用
   * （cleanupThrottleMs 内的清理只做快照 TTL/数量裁剪，不做对象 GC）。
   */
  cleanup() {
    const now = Date.now()
    const ttlMs = this.ttlDays * 24 * 60 * 60 * 1000
    if (!existsSync(this.snapDir)) return
    for (const sessionId of readdirSync(this.snapDir)) {
      const dir = join(this.snapDir, sessionId)
      if (!statSync(dir).isDirectory()) continue
      const files = readdirSync(dir).filter(x => x.endsWith('.json')).sort(numeric)
      // TTL
      for (const f of files) {
        const data = readJsonFile(join(dir, f))
        if (data?.timestamp) {
          const age = now - new Date(data.timestamp).getTime()
          if (age > ttlMs) { try { unlinkSync(join(dir, f)) } catch {} }
        }
      }
      // Cap newest N
      const remaining = readdirSync(dir).filter(x => x.endsWith('.json')).sort(numeric)
      const overflow = remaining.length - this.maxSnapshots
      for (let i = 0; i < overflow; i++) {
        try { unlinkSync(join(dir, remaining[i])) } catch {}
      }
    }
    // Manifests are pruned above; reclaim the objects they no longer reference.
    // sweepObjects() 自带 `objectGcIntervalMs`（默认 6h）节流，不会每次
    // capture 都做全库 mark-and-sweep——那是最重的操作（可达 983 MB / 40k
    // 文件）。这里直接委托它，由其内部节流决定是否真正扫描。
    try { this.sweepObjects() } catch (e) {
      console.warn('[turn-undo] object sweep failed:', e.message)
    }
  }

  /**
   * Mark-and-sweep the content-addressed object store.
   *
   * Every hash reachable from a surviving manifest is marked; unreferenced
   * objects older than the grace window are deleted. Objects younger than the
   * grace window are kept because capture() writes objects before it writes
   * the manifest that references them — deleting those would corrupt an
   * in-flight snapshot.
   *
   * Throttled to `objectGcIntervalMs` since the mark phase parses every
   * surviving manifest.
   * @param opts - `force` bypasses the throttle (tests / explicit invocation);
   *   `dryRun` counts what would be reclaimed without deleting anything.
   * @returns Counts, or null when the throttle skipped this call.
   */
  sweepObjects(opts = {}) {
    const now = Date.now()
    if (!opts.force && now - this.lastObjectSweep < this.objectGcIntervalMs) return null
    this.lastObjectSweep = now

    // ── Mark ──────────────────────────────────────────────────────────
    const referenced = new Set()
    let unreadable = 0
    if (existsSync(this.snapDir)) {
      for (const sessionId of readdirSync(this.snapDir)) {
        const dir = join(this.snapDir, sessionId)
        let dirStat
        try { dirStat = statSync(dir) } catch { continue }
        if (!dirStat.isDirectory()) continue
        for (const f of readdirSync(dir)) {
          if (!f.endsWith('.json')) continue
          const data = readJsonFile(join(dir, f))
          if (!data || !data.manifest) { unreadable++; continue }
          for (const entry of Object.values(data.manifest)) {
            if (entry && typeof entry.hash === 'string') referenced.add(entry.hash)
          }
        }
      }
    }

    // Fail-safe: an unparseable manifest would contribute no marks, so its
    // objects would look unreferenced and be deleted — silently destroying a
    // snapshot that is merely unreadable. Abort rather than sweep on a
    // possibly-incomplete mark set.
    if (unreadable > 0) {
      console.warn(`[turn-undo] object sweep skipped: ${unreadable} manifest(s) unreadable`)
      return { removed: 0, freedBytes: 0, keptYoung: 0, referenced: referenced.size, aborted: 'unreadable-manifest' }
    }

    // ── Sweep ─────────────────────────────────────────────────────────
    let removed = 0
    let freedBytes = 0
    let keptYoung = 0
    if (!existsSync(this.objDir)) return { removed, freedBytes, keptYoung, referenced: referenced.size }
    for (const name of readdirSync(this.objDir)) {
      if (referenced.has(name)) continue
      const abs = join(this.objDir, name)
      let st
      try { st = statSync(abs) } catch { continue }
      if (!st.isFile()) continue
      if (now - st.mtimeMs < this.objectGcGraceMs) { keptYoung++; continue }
      if (opts.dryRun) { removed++; freedBytes += st.size; continue }
      try {
        unlinkSync(abs)
        removed++
        freedBytes += st.size
      } catch {}
    }
    if (removed > 0) {
      console.info(`[turn-undo] object sweep reclaimed ${removed} objects (${Math.round(freedBytes / 1048576)} MB), kept ${keptYoung} young, ${referenced.size} referenced`)
    }
    return { removed, freedBytes, keptYoung, referenced: referenced.size }
  }
}

function numeric(a, b) {
  const na = parseFloat(a)
  const nb = parseFloat(b)
  return (isNaN(na) ? 0 : na) - (isNaN(nb) ? 0 : nb)
}

// ===========================================================================
// Boundary / fork resolution
// ===========================================================================

/**
 * Locate the fork boundary (previous turn/end seq) and the turn number for a
 * given user message seq.
 *
 * Two strategies (tried in order):
 *   1. seq-based: match by e.seq === messageSeq, then use findLast with
 *      e.seq < ... comparisons. Works for live sessions where every event
 *      carries a reliable `seq`.
 *   2. text-based fallback: match by message text content. This covers
 *      persisted sessions (no seq field) and avoids the bug of treating
 *      `messageSeq` as an array index.
 */
function resolveForkBoundary(source, messageSeq, promptText) {
  const events = source?.events ?? []
  const cwd = source?.header?.cwd

  // ── Strategy 1: seq-based ──────────────────────────────────────────
  let message = events.find(e => (
    e.type === 'user/message'
    && e.seq === messageSeq
    && e.data?.source && typeof e.data.source === 'object'
    && e.data.source.kind === 'user'
  ))

  if (message && typeof message.seq === 'number') {
    const start = events.findLast(e => e.type === 'turn/start' && e.seq < message.seq)
    const turn = start ? start.data?.turn : undefined
    if (!start || typeof turn !== 'number' || turn < 0) {
      return { boundary: null, turn: null, cwd, reason: 'no-turn-start' }
    }
    const previousEnd = events.findLast(e => e.type === 'turn/end' && e.seq < start.seq)

    // 第一条消息（无前一个 turn/end）也必须 fork：边界取 turn/start 前
    // 最近的一个「索引==seq」有效事件（会话初始化完成处），子会话继承
    // workspace/preset/cwd，而不是 create() 一个空白会话 —— 这正是
    // 「点击撤销后直接创建新会话、没有 fork 出会话」的根因。
    let boundary = previousEnd ? previousEnd.seq : null
    if (boundary !== null && !(events[boundary] && events[boundary].seq === boundary)) {
      boundary = null
    }
    if (boundary === null) {
      const startIdx = events.indexOf(start)
      for (let i = startIdx - 1; i >= 0; i--) {
        if (events[i] && events[i].seq === i) { boundary = i; break }
      }
    }
    return {
      boundary,
      turn,
      cwd,
      reason: boundary !== null ? 'ok' : 'no-previous-end',
    }
  }

  // ── Strategy 2: text-based fallback ────────────────────────────────
  // Only reached for event streams that carry no usable `seq` (persisted
  // sessions). When the stream DOES carry seqs but none is this user message,
  // the requested point genuinely does not exist — guessing a different
  // message here would silently restore the workspace to the wrong turn.
  const seqsAvailable = events.some(e => typeof e.seq === 'number')
  if (seqsAvailable && typeof messageSeq === 'number') {
    return { boundary: null, turn: null, cwd, reason: 'no-matching-message' }
  }

  // Use promptText to match the user message, avoiding the bug of
  // treating messageSeq as an array index when seq is unavailable.
  if (promptText) {
    const normalizedPromptText = promptText.trim().substring(0, 200).toLowerCase()
    const candidates = events.filter(e => (
      e.type === 'user/message'
      && e.data?.source && typeof e.data.source === 'object'
      && e.data.source.kind === 'user'
      && e.data?.content
      && Array.isArray(e.data.content)
      && e.data.content.some(part => {
        if (part.type !== 'text') return false
        const text = (part.text || '').trim().substring(0, 200).toLowerCase()
        return text.includes(normalizedPromptText) || normalizedPromptText.includes(text)
      })
    ))
    // Ambiguous text must not be resolved by position: the first match is
    // routinely an earlier prompt that merely contains the same words
    // ("继续" and the like).
    if (candidates.length > 1) {
      return { boundary: null, turn: null, cwd, reason: 'ambiguous-message' }
    }
    if (candidates.length === 1) message = candidates[0]
  }

  if (!message) return { boundary: null, turn: null, cwd, reason: 'no-user-message' }

  const targetIndex = events.indexOf(message)
  if (targetIndex === -1) return { boundary: null, turn: null, cwd, reason: 'no-user-message' }

  // Look for turn/start before the target message (by position, not seq)
  let turn = null
  let startIdx = -1
  for (let i = targetIndex - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'turn/start' && typeof e.data?.turn === 'number' && e.data.turn >= 0) {
      turn = e.data.turn
      startIdx = i
      break
    }
    // Stop at turn/end — the turn/start for this message must be after the
    // last turn/end and before the current user message.
    if (e.type === 'turn/end') break
  }
  if (turn === null) {
    return { boundary: null, turn: null, cwd, reason: 'no-turn-start' }
  }

  // Find the previous turn/end (before the found turn/start)
  let boundary = null
  for (let i = startIdx - 1; i >= 0; i--) {
    if (events[i].type === 'turn/end') {
      // Use seq if available; otherwise null (will trigger session.create
      // instead of fork, which is safe).
      boundary = 'seq' in events[i] ? events[i].seq : null
      break
    }
  }

  return { boundary, turn, cwd, reason: 'ok' }
}

// ===========================================================================
// Snapshot runtime (turn/end listener)
// ===========================================================================

class SnapshotRuntime {
  constructor(cfg) {
    // Use the shared store passed in by apply(); only build one if absent.
    this.store = cfg.store || new SnapshotStore(cfg)
    this.delayMs = cfg.snapshotDelayMs ?? DEFAULT_SNAPSHOT_DELAY_MS
    this.queues = new Map() // cwd -> Promise chain (serialize per workspace)
    this.logger = cfg.logger
  }

  observe(session, event) {
    const cwd = getCwd(session)
    if (!cwd) return
    const sessionId = session.id
    const turn = event.data?.turn
    if (typeof turn !== 'number') return

    // Capture base snapshot at turn/start (before any AI work).
    // Use a fractional turn number so it doesn't overwrite the turn/end snapshot.
    if (event.type === 'turn/start') {
      this.enqueueCapture(cwd, sessionId, turn - 0.5)
      return
    }

    // Track nothing per-tool — the whole turn is snapshotted at turn/end.
    if (event.type !== 'turn/end') return
    this.enqueueCapture(cwd, sessionId, turn)
  }

  /** Force a snapshot now (e.g. right after cancel during a mid-turn undo). */
  captureNow(cwd, sessionId, turn) {
    return this.enqueueCapture(cwd, sessionId, turn, true)
  }

  /**
   * Wait for all pending snapshot captures to finish.
   * This ensures the latest manifest is on disk before restore reads it.
   */
  async waitForSnapshots() {
    const promises = []
    for (const [, pending] of this.queues) {
      promises.push(pending.catch(() => {})) // swallow errors, we just wait
    }
    if (promises.length) {
      await Promise.all(promises)
    }
  }

  enqueueCapture(cwd, sessionId, turn, propagate = false) {
    const key = cwd
    const prev = this.queues.get(key) || Promise.resolve()
    const run = prev.then(async () => {
      // brief delay so writes settle
      await wait(this.delayMs)
      const result = await this.store.capture(cwd, sessionId, turn)
      this.store.cleanup()
      return result
    })
    const settled = run.catch((e) => {
      this.logger?.warn?.(`[turn-undo] snapshot failed: ${e.message}`)
      return null
    })
    this.queues.set(key, settled)
    return propagate ? run : settled
  }
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)) }

// ===========================================================================
// Fork + archive (undo = fork child + archive old)
// ===========================================================================
/**
 * Fork a child session from the event prefix BEFORE the target message, then
 * rename + archive the old session.
 *
 * - Uses the same `sessionController.fork` RPC as the web UI fork buttons;
 *   DSH `buildForkSeed` copies prefix [0..boundary] and closes the open tail
 *   with synthetic `forked` closers, so the child log physically contains NONE
 *   of the undone events. Model context, web transcript and restart all agree
 *   — this is a real undo, not a surface shadow (no DOM hiding needed).
 * - Falls back to `sessionController.create` only when no fork boundary exists
 *   (defensive; the POST handler already rejects boundary-less targets).
 * - Old session: rename with a （已撤销） prefix (best-effort), then archive via
 *   `workspaceController.archiveSession` so it leaves the active session list
 *   and can no longer be continued.
 *
 * @returns {{ newSessionId: string, createFallback: boolean, renamed: boolean, archived: boolean }}
 */
async function forkAndArchiveSession({ sessionController, workspaceController, sessionQuery }, sessionId, boundary, sourceCwd) {
  let childId
  let createFallback = false
  if (typeof boundary === 'number') {
    // fork() attaches the child to the source workspace automatically
    // (upstream commands.ts forkWorkspace), so it appears in the sidebar.
    const { sessionId: cid } = await sessionController.fork({ sessionId, atSeq: boundary })
    childId = cid
  } else {
    // Defensive fallback: never reached by the POST handler, which rejects
    // targets without a boundary before calling this function.
    createFallback = true
    const created = await sessionController.create({
      ...(sourceCwd ? { cwd: sourceCwd } : {}),
    })
    childId = created.sessionId
  }

  // Best-effort: mark the old session undone before archiving it.
  let renamed = false
  try {
    let oldTitle = ''
    if (sessionQuery && typeof sessionQuery.readTitle === 'function') {
      const t = await sessionQuery.readTitle(sessionId)
      oldTitle = t && t.title ? t.title : ''
    }
    const prefix = '（已撤销）'
    if (!oldTitle.startsWith(prefix)) {
      await sessionController.rename({
        sessionId,
        title: prefix + (oldTitle || '（未命名会话）'),
      })
      renamed = true
    } else {
      renamed = true
    }
  } catch (e) {
    console.warn('[turn-undo] Rename old session failed (non-fatal):', e.message)
  }

  // Archive the old session so it leaves the active list and cannot continue.
  // stopActivity:true stops any running model step first (archive otherwise
  // refuses active sessions with workspace/session-active).
  let archived = false
  try {
    if (workspaceController && typeof workspaceController.archiveSession === 'function') {
      await workspaceController.archiveSession({ sessionId, stopActivity: true })
      archived = true
    }
  } catch (e) {
    console.warn('[turn-undo] Archive old session failed (non-fatal):', e.message)
  }

  return { newSessionId: childId, createFallback, renamed, archived }
}
// ===========================================================================
// HTTP handler + plugin entry
// ===========================================================================

function createHandler({ sessions, sessionQuery, sessionController, workspaceController, logger }, runtime) {
  // 请求路径只使用这里捕获的**服务引用**（构造时即 ACTIVE 的快照），
  // 绝不通过 scope 动态解析 —— fiber 处于 LOADING/UNLOADING 窗口时
  // 解析会抛 'cannot get required service ... in inactive context'。
  return async (request, response) => {
    try {
      if (request.method === 'GET') {
        const url = new URL(request.url ?? API_PATH, 'http://dsh.local')
        const sessionId = url.searchParams.get('sessionId')
        const messageSeqParam = url.searchParams.get('messageSeq')
        const promptTextParam = url.searchParams.get('promptText')

        if (!sessionId) return json(response, 400, { error: 'Missing sessionId' })
        // 单次 readSessionLive 即可：live 会话的 snapshotEvents() 会重放事件，
        // 每个请求读两遍是纯浪费。
        const source = await readSessionLive(sessions, sessionQuery, sessionId)
        if (!source) return json(response, 404, { error: 'Session not found' })

        let targetTurn = null
        let unresolved = null
        if (messageSeqParam) {
          const b = resolveForkBoundary(source, parseInt(messageSeqParam, 10), promptTextParam)
          // For preview, pass the turn that the user wants to undo (b.turn),
          // SAME restore boundary as POST: b.turn - 0.5 (state before the
          // message's turn/start). Keeps preview and restore consistent.
          if (b.turn !== null && b.turn > 0) targetTurn = b.turn - 0.5
          else unresolved = b.reason ?? 'no-turn'
        }

        // Wait for any in-flight snapshot capture so the preview reflects the
        // latest committed workspace state (avoids showing a stale turn/end).
        try { await runtime.waitForSnapshots() } catch {}

        // 定位不到消息时返回明确失败，而不是 targetTurn=null 的"0 变更"
        // —— 后者会让弹框显示"无变化"，掩盖真实的解析失败。
        if (unresolved !== null) {
          return json(response, 200, {
            ok: false,
            status: 'unresolved',
            reason: unresolved,
            error: '定位不到这条消息对应的对话位置，无法撤销',
            targetTurn: null,
            totalChanges: 0,
            changes: [],
          })
        }

        let preview
        try {
          const chainLen = runtime.store.loadChain(sessionId).length
          logger?.info?.('[turn-undo] preview sid=' + sessionId + ' targetTurn=' + targetTurn + ' chainLen=' + chainLen + ' cwd=' + getCwd(source))
          preview = runtime.store.preview(sessionId, targetTurn, getCwd(source))
        } catch (e) {
          logger?.warn?.('[turn-undo] preview failed:', e.message)
          preview = {
            ok: false,
            status: 'preview-failed',
            error: '预览失败：' + e.message,
            targetTurn,
            totalChanges: 0,
            changes: [],
          }
        }
        return json(response, 200, preview)
      }

      if (request.method === 'POST') {
        let body = ''
        await new Promise((resolve, reject) => {
          request.on('data', c => { body += c })
          request.on('end', resolve)
          request.on('error', reject)
        })
        const data = JSON.parse(body)
        const sessionId = data.sessionId
        const messageSeq = data.messageSeq ? parseInt(data.messageSeq, 10) : null
        const promptText = data.promptText || null
        // 只回退对话（不动文件）时客户端传 restoreFiles:false；缺省/undefined = 回退文件。
        const restoreFiles = data.restoreFiles !== false
        if (!sessionId) return json(response, 400, { error: 'Missing sessionId' })

        const source = await readSessionLive(sessions, sessionQuery, sessionId)
        if (!source) return json(response, 400, { error: 'Session not found' })
        const cwd = getCwd(source)
        const b = messageSeq !== null
          ? resolveForkBoundary(source, messageSeq, promptText)
          : { boundary: null, turn: null, cwd, reason: 'no-message-seq' }

        // Determine restore target: "recover to before this message" means
        // the state at turn/start, i.e. turn T - 0.5. That snapshot captures
        // the workspace before the user sent this message and before any AI work.
        //
        // 解析不到目标消息时必须中止：继续执行会 fork 出新会话却跳过文件恢复，
        // 却仍返回 ok:true —— 用户会以为撤销成功。
        if (b.turn === null || b.turn <= 0) {
          return json(response, 200, {
            ok: false,
            status: 'unresolved',
            reason: b.reason ?? 'no-turn',
            error: '定位不到这条消息对应的对话位置，未做任何修改',
          })
        }
        const restoreTurn = b.turn - 0.5

        // 3. Wait for any pending snapshot to settle so the manifest is on disk.
        //    Without this, a restore issued right after turn/end may read an
        //    empty snapshot chain and skip file restoration.
        try { await runtime.waitForSnapshots() } catch {}

        // 3.5-4. 文件恢复：仅在用户勾选"同时回退文件"时执行。
        //    restoreFiles=false = 只回退对话（fork 新会话），不动任何文件。
        let restoreResult
        if (restoreFiles) {
          // Safety snapshot: before this irreversible restore wipes files,
          //    force-capture the CURRENT workspace into the session chain (as a
          //    fractional turn just past the newest snapshot) so the user can
          //    restore again to the pre-undo state if needed. Non-fatal on failure.
          try {
            const chain = runtime.store.loadChain(sessionId)
            const lastTurn = chain.length ? chain[chain.length - 1].turn : 0
            await runtime.captureNow(cwd, sessionId, lastTurn + 0.999)
          } catch (e) {
            console.warn('[turn-undo] safety snapshot failed (non-fatal):', e?.message)
          }
          restoreResult = runtime.store.restore(cwd, sessionId, restoreTurn)
        } else {
          restoreResult = { ok: true, skipped: true, reason: 'files-disabled', restoredFiles: 0, deletedFiles: 0 }
        }

        // 5. Fork + archive：从 boundary 以前的日志前缀创建子会话
        //    （真撤销——子会话日志不含被撤销事件），随后改名并归档旧会话。
        //    文件恢复已在第 4 步完成（restoreFiles=false 时跳过）。
        let forkResult
        try {
          forkResult = await forkAndArchiveSession(
            { sessionController, workspaceController, sessionQuery },
            sessionId,
            b.boundary,
            cwd,
          )
        } catch (e) {
          console.error('[turn-undo] Fork failed:', e.message)
          return json(response, 200, {
            ok: false,
            status: 'fork-failed',
            error: e.message,
            restore: restoreResult && {
              ok: restoreResult.ok === true,
              skipped: restoreResult.error === 'NO_SNAPSHOT',
            },
          })
        }

        return json(response, 200, {
          ok: true,
          status: 'completed',
          sessionId,                       // 旧会话 id（已改名并归档）
          newSessionId: forkResult.newSessionId,
          forked: {
            createFallback: forkResult.createFallback,
            renamed: forkResult.renamed,
            archived: forkResult.archived,
          },
          restore: {
            ok: restoreResult?.ok === true,
            skipped: restoreResult?.error === 'NO_SNAPSHOT' || restoreResult?.reason === 'files-disabled',
            restoredFiles: restoreResult?.restoredFiles ?? 0,
            deletedFiles: restoreResult?.deletedFiles ?? 0,
          },
        })
      }

      return json(response, 405, { error: 'Method not allowed' })
    } catch (error) {
      console.error('[turn-undo] Handler error:', error.message)
      return json(response, 500, { error: error.message })
    }
  }
}

/**
 * Main plugin apply function.
 */
export function apply(ctx, config = {}) {
  const baseDir = getBaseDir(ctx)
  const logger = ctx.logger || console
  const store = new SnapshotStore({
    baseDir,
    excludes: config.excludes,
    maxFileBytes: config.maxFileBytes,
    maxFilesPerSnapshot: config.maxFilesPerSnapshot,
    maxSnapshotBytes: config.maxSnapshotBytes,
    snapshotTtlDays: config.snapshotTtlDays,
    maxSnapshotsPerSession: config.maxSnapshotsPerSession,
    objectGcGraceMs: config.objectGcGraceMs,
    objectGcIntervalMs: config.objectGcIntervalMs,
  })
  const runtime = new SnapshotRuntime({
    store,
    excludes: config.excludes,
    snapshotDelayMs: config.snapshotDelayMs,
    logger,
  })

  // Listen to session/event for turn/start and turn/end snapshots.
  // This is a global broadcast (DSH emits it with { global: true }), so we
  // attach on the root ctx. Exceptions here must never derail the agent turn.
  ctx.on('session/event', (session, event) => {
    try {
      if (event && (event.type === 'turn/start' || event.type === 'turn/end')) {
        runtime.observe(session, event)
      }
    } catch (e) {
      logger?.warn?.('[turn-undo] session/event handler error:', e.message)
    }
  })

  // HTTP API endpoints.
  ctx.inject(
    // handler 只在这五条服务 ACTIVE 时创建一次，请求路径用捕获的引用，
    // 不从 scope 动态解析 —— 见 createHandler 注释（inactive context 修复）。
    ['webServer', 'sessions', 'sessionQuery', 'sessionController', 'workspaceController'],
    (scope) => {
      scope.effect(() => {
        const handler = createHandler(
          {
            sessions: scope.sessions,
            sessionQuery: scope.sessionQuery,
            sessionController: scope.sessionController,
            workspaceController: scope.workspaceController,
            logger,
          },
          runtime,
        )
        // 必须显式注册到 webServer，否则路由 404。
        return scope.webServer.register({
          kind: 'exact',
          path: API_PATH,
          handler,
        })
      }, 'turn-undo: http-api')
    },
  )
}

/**
 * Build a manifest from the current workspace state without persisting it.
 *
 * Entries whose size+mtime+mode already match `referenceManifest` reuse the
 * recorded hash instead of re-reading the bytes — the same short-circuit
 * capture() uses. Without it every preview re-hashes the whole workspace.
 * @param cwd - workspace root being scanned.
 * @param referenceManifest - a prior manifest (usually the latest snapshot).
 */
SnapshotStore.prototype.buildLiveManifest = function (cwd, referenceManifest) {
  const ignore = makeIgnore(cwd, this.excludes)
  const files = this.scan(cwd, ignore)
  if (!files) return null
  const manifest = {}
  for (const abs of files) {
    let st
    try { st = lstatSync(abs) } catch { continue }
    if (!st.isFile()) continue
    const rel = relative(cwd, abs).split('\\').join('/')
    const mode = st.mode.toString(8).padStart(4, '0')
    const prev = referenceManifest && referenceManifest[rel]
    if (prev && prev.kind === 'file' && prev.hash
        && prev.size === st.size && prev.mtime === st.mtimeMs && prev.mode === mode) {
      manifest[rel] = prev
    } else {
      manifest[rel] = {
        kind: 'file',
        hash: hashFile(abs),
        size: st.size,
        mtime: st.mtimeMs,
        mode,
      }
    }
  }
  return manifest
}

/** Read a workspace file's text; '' when unreadable (binary, deleted, permission). */
SnapshotStore.prototype.readWorkspaceContent = function (cwd, rel) {
  try { return readFileSync(resolve(cwd, rel), 'utf-8') } catch { return '' }
}

// Add preview helper to SnapshotStore prototype.
// Returns the files that undo (restoring to the target's baseline) will affect.
SnapshotStore.prototype.preview = function (sessionId, targetTurn, cwd) {
  if (targetTurn === null) {
    return { ok: true, status: 'ready', targetTurn: null, totalChanges: 0, changes: [] }
  }
  const chain = this.loadChain(sessionId)
  // Use cwd from latest snapshot to avoid cross-workspace path issues
  const snapCwd = chain.length ? (chain[chain.length - 1].cwd ?? cwd) : cwd
  if (chain.length === 0) {
    return { ok: true, status: 'no-snapshot', targetTurn, totalChanges: 0, changes: [], noSnapshot: true }
  }

  // 撤销"发送这条消息之前"会一并回退该消息之后的所有改动，因此影响范围 =
  // baseline（targetTurn 之前最近的快照，即恢复到什么状态）与 latest
  // （会话最新快照，即撤销点之后累积到当前的状态终点）之差。
  let baseline = null
  for (const m of chain) {
    if (m.turn < targetTurn && (baseline === null || m.turn > baseline.turn)) {
      baseline = m
    }
  }

  // 目标消息早于最早可用快照：既无法描述也无法执行恢复。把当前所有文件
  // 都列成 "created" 会宣称"恢复到空工作区"，而 restore() 随后必以
  // NO_SNAPSHOT 拒绝 —— 必须明确报告无基线，而不是给出误导性的文件清单。
  if (baseline === null) {
    return { ok: true, status: 'no-baseline', targetTurn, totalChanges: 0, changes: [], noBaseline: true }
  }
  const baselineManifest = baseline.manifest

  // 会话最新快照 = 撤销点之后所有改动的累积终点。
  const latest = chain[chain.length - 1]

  // If targetTurn is beyond the latest snapshot (e.g., the turn hasn't ended
  // yet or snapshots were skipped), compare baseline against the CURRENT
  // workspace state instead of the stale latest snapshot. This ensures the
  // preview shows meaningful changes even when the active turn has no snapshot.
  let latestManifest = latest.manifest
  let latestIsLive = false
  if (targetTurn > latest.turn && snapCwd) {
    const live = this.buildLiveManifest(snapCwd, latest.manifest)
    if (live) {
      latestManifest = live
      latestIsLive = true
    }
  }

  // ── Collect changed paths: ONLY the session's own changes ─────────────
  // 与 restore() 一致：只看 (baseline.turn, latest.turn] 之间各快照的
  // changedRels 并集（本会话动过的文件）。
  //
  // **绝不**并入 live（buildLiveManifest）——那会扫描整个工作区的当前状态，
  // 把**其他会话/外部进程**（如另一个 DSH 会话在 cwd 里改文件）产生的改动
  // 都算成"本会话的"。affected 只由已落盘的快照链决定：
  //  - 基线之后**没有**新快照 → 本会话没产生文件变化 → affected 为空
  //  - 有快照但都无 changedRels（旧快照）→ 退化到快照间 diff（不用 live）
  const affected = new Set()
  let hasSnapshotAfterBaseline = false
  for (const m of chain) {
    if (m.turn <= baseline.turn) continue
    hasSnapshotAfterBaseline = true
    if (Array.isArray(m.changedRels) && m.changedRels.length) {
      for (const rel of m.changedRels) affected.add(rel)
    }
  }
  if (!hasSnapshotAfterBaseline) {
    // 纯对话 turn（未产生 turn/end 快照）或目标消息就是最后一个：无文件变化。
    affected.clear()
  } else if (affected.size === 0) {
    // 旧格式快照无 changedRels：用快照间 diff（baseline vs 最新快照），不用 live。
    const snapLatest = latest.manifest
    for (const rel of Object.keys(baselineManifest)) {
      if (!snapLatest[rel] || snapLatest[rel].hash !== baselineManifest[rel].hash) {
        affected.add(rel)
      }
    }
    for (const rel of Object.keys(snapLatest)) {
      if (!baselineManifest[rel]) affected.add(rel)
    }
  }

  const deleted = []
  const created = []
  const modified = []
  for (const rel of affected) {
    const prev = baselineManifest[rel]
    const entry = latestManifest[rel]
    if (!prev && entry) created.push({ path: rel, hash: entry.hash })
    else if (prev && !entry) deleted.push({ path: rel, hash: prev.hash })
    else if (prev && entry && entry.hash !== prev.hash) {
      modified.push({ path: rel, oldHash: prev.hash, newHash: entry.hash })
    }
  }

  const changes = []
  for (const d of deleted) changes.push({ path: d.path, kind: 'deleted' })
  for (const c of created) changes.push({ path: c.path, kind: 'created' })
  for (const m of modified) {
    const oldContent = this.readObjectContent(m.oldHash) || ''
    // A live entry's bytes were never written to the object store; read the
    // working tree instead, or the diff would show every old line as removed.
    const newContent = latestIsLive
      ? this.readWorkspaceContent(cwd, m.path)
      : (this.readObjectContent(m.newHash) || '')
    const oldLines = oldContent.split('\n')
    const newLines = newContent.split('\n')
    // generateDiff is O(n*m) DP; skip hunks for pathologically large files
    // rather than allocating a multi-hundred-MB table on a preview click.
    const tooLarge = oldLines.length * newLines.length > 4_000_000
    changes.push({
      path: m.path,
      kind: 'modified',
      diff: tooLarge
        ? { oldLines: oldLines.length, newLines: newLines.length, hunks: [], truncated: true }
        : { oldLines: oldLines.length, newLines: newLines.length, hunks: this.generateDiff(oldLines, newLines, 10) },
    })
  }

  // Detect rename/move: same content hash, different path.
  // O(del × create) 双循环在文件多时是平方级（一百个文件 = 万次比较）；
  // 用 hash 索引降为线性：每个 hash 最多匹配一对 rename。
  const byHash = new Map() // hash -> created index
  for (let j = 0; j < created.length; j++) {
    if (!byHash.has(created[j].hash)) byHash.set(created[j].hash, j)
  }
  const renameMap = []
  for (let i = 0; i < deleted.length; i++) {
    const j = byHash.get(deleted[i].hash)
    if (j === undefined) continue
    deleted[i].matched = true
    created[j].matched = true
    renameMap.push({ oldPath: deleted[i].path, newPath: created[j].path })
  }

  return {
    ok: true,
    status: 'ready',
    targetTurn,
    totalChanges: changes.length,
    changes,
    renameMap,
  }
}