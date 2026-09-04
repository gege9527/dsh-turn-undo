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
 *   4. Rewind in place via session.surface replacement (surfaceOp.replace): drop
 *      every surface node from the target user message onwards — no fork, no new
 *      session, and no cancel/rename (both removed in DSH 0.1.2+).
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
  linkSync,
  createWriteStream,
  createReadStream,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, basename, relative, resolve } from 'node:path'

export const name = 'turn-undo'

// Exported for integration testing (class is otherwise module-private).
export { SnapshotStore }

// Injected services (via ctx.inject in apply()): webServer, sessions,
// sessionQuery, agents, sessionController.
export const inject = ['webServer', 'sessions', 'sessionQuery', 'agents', 'sessionTitle', 'sessionController']

// ---- Configuration defaults ----
const DEFAULT_SNAPSHOT_TTL_DAYS = 7
const DEFAULT_MAX_SNAPSHOTS_PER_SESSION = 50
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB
const DEFAULT_MAX_FILES_PER_SNAPSHOT = 10000
const DEFAULT_MAX_SNAPSHOT_BYTES = 500 * 1024 * 1024 // 500 MB
const DEFAULT_SNAPSHOT_DELAY_MS = 250
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
    this.objDir = join(this.base, 'objects')
    this.snapDir = join(this.base, 'snapshots')
  }

  /**
   * Capture the workspace at cwd into the session's chain.
   * Returns the manifest (or null if unchanged since the session's last).
   */
  capture(cwd, sessionId, turn) {
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
      if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) {
        entry = prev // unchanged — reuse (no new object written)
      } else {
        const hash = hashFile(abs)
        const objPath = join(this.objDir, hash)
        if (!existsSync(objPath)) {
          this.copyIntoObjects(abs, objPath)
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

    const manifestData = {
      sessionId,
      turn,
      timestamp: new Date().toISOString(),
      totalBytes,
      manifest,
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
  copyIntoObjects(src, dst) {
    try {
      copyFileSync(src, dst)
    } catch {
      // e.g. src vanished mid-read; try streaming fallback
      try {
        const rs = createReadStream(src)
        const ws = createWriteStream(dst)
        rs.pipe(ws)
        return new Promise((resolve, reject) => {
          rs.on('error', reject)
          ws.on('error', reject)
          ws.on('finish', resolve)
        })
      } catch (e) {
        console.warn('[turn-undo] object write failed:', e.message)
      }
    }
  }

  /** Materialize an object into the workspace (write-back during restore). */
  materializeObject(objPath, dest) {
    try {
      unlinkSync(dest)
    } catch { /* may not exist */ }
    ensureDir(dirname(dest))
    try {
      linkSync(objPath, dest) // hard link back: cheap + safe (object won't be re-modified)
    } catch {
      copyFileSync(objPath, dest)
    }
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
    }
    return true
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
   * Restore the workspace at cwd to the state captured at or before targetTurn.
   * Creates a safety snapshot first. Returns stats.
   */
  restore(cwd, sessionId, targetTurn) {
    const chain = this.loadChain(sessionId)
    // Find the NEWEST snapshot whose turn <= targetTurn (best available state
    // at/before the boundary). Filter to only completed turns present.
    let target = null
    for (const m of chain) {
      if (m.turn <= targetTurn && (target === null || m.turn > target.turn)) {
        target = m
      }
    }
    if (!target) {
      return { ok: false, error: 'NO_SNAPSHOT' }
    }

    // Restore files to the target manifest state.
    const ignore = makeIgnore(cwd, this.excludes)
    const manifest = target.manifest
    const rels = Object.keys(manifest)

    let restoredFiles = 0
    let deletedFiles = 0
    // 1. Write back / refresh files present in target manifest.
    for (const rel of rels) {
      const entry = manifest[rel]
      const abs = resolve(cwd, rel)
      if (ignore(abs)) continue
      try {
        ensureDir(dirname(abs))
        if (entry.kind === 'file') {
          const objPath = join(this.objDir, entry.hash)
          if (!existsSync(objPath)) continue
          this.materializeObject(objPath, abs)
          restoredFiles++
        }
      } catch (e) {
        /* skip un-restorable files */
      }
    }

    // 2. Delete files present on disk but absent from the target manifest,
    //    except excluded dirs. Only within cwd. Uses a boundary-unlimited walk
    //    (unlike scan, whose caps would silently stop the pruning early).
    const current = this.walkAll(cwd, ignore)
    for (const abs of current) {
      if (ignore(abs)) continue
      const rel = relative(cwd, abs).split('\\').join('/')
      if (!(rel in manifest)) {
        try {
          rmSync(abs, { force: true })
          deletedFiles++
        } catch { /* noop */ }
      }
    }

    return {
      ok: true,
      restoredFiles,
      deletedFiles,
      targetTurn,
      restoredTurn: target.turn,
      totalFiles: rels.length,
    }
  }

  /**
   * Clean old snapshots (TTL + per-session cap).
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
  }
}

function numeric(a, b) {
  const na = parseFloat(a)
  const nb = parseFloat(b)
  return (isNaN(na) ? 0 : na) - (isNaN(nb) ? 0 : nb)
}

// ===========================================================================
// Boundary / fork resolution (mirrors dsh-turn-rewind messageTarget)
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
    return {
      boundary: previousEnd ? previousEnd.seq : null,
      turn,
      cwd,
      reason: previousEnd ? 'ok' : 'no-previous-end',
    }
  }

  // ── Strategy 2: text-based fallback ────────────────────────────────
  // Use promptText to match the user message, avoiding the bug of
  // treating messageSeq as an array index when seq is unavailable.
  //
  // If promptText is not provided, find the latest user message as a
  // safe fallback.
  if (promptText) {
    const normalizedPromptText = promptText.trim().substring(0, 200).toLowerCase()
    message = events.find(e => (
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
  }

  // If promptText matching failed or not provided, find the latest user message.
  if (!message) {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e.type === 'turn/start') break
      if (e.type === 'user/message'
          && e.data?.source && typeof e.data.source === 'object'
          && e.data.source.kind === 'user') {
        message = e
        break
      }
    }
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

/**
 * Archive an old session after a successful fork+restore: cancel it.
 * Cancelling removes the old session so it doesn't conflict with the forked one.
 * If cancel fails, we rename it as a last resort.
 */
async function archiveSession(ctx, sessionId) {
  // DSH 0.1.2+ 移除了 cancel/rename/getProjection；当前为 surface 原地回滚，
  // 不产生新会话，无需归档。此处保留为安全的 no-op 提示。
  try {
    console.info('[turn-undo] Session', sessionId, 'rewound in place; no archive needed')
    return true
  } catch (error) {
    console.warn('[turn-undo] Archive failed:', error.message)
    return false
  }
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
      const result = this.store.capture(cwd, sessionId, turn)
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
// Surface rewind utilities (P0-1: markerTurnOf, markerStepOf, planSurfaceRewind)
// ===========================================================================

/** Turn number for the rewind marker (reuse last started turn, never collides with a future turn/start). */
function markerTurnOf(events) {
  let lastStarted = 0
  for (const event of events) {
    if (event.type === 'turn/start' && event.data?.turn > lastStarted) {
      lastStarted = event.data.turn
    }
  }
  return lastStarted
}

/** Step number for the marker's ghost step frame (lastStarted + 1 is always safe). */
function markerStepOf(events, turn) {
  let lastStarted = 0
  for (const event of events) {
    if (event.type === 'step/start' && event.data?.turn === turn && event.data?.step > lastStarted) {
      lastStarted = event.data.step
    }
  }
  return lastStarted + 1
}

/**
 * Compute the surface replacement plan for a rewind target.
 * DSH 0.1.2+ 的 session.surface.nodes 是 seq 数字数组（number[]）；
 * 旧版可能是 { seq } 对象数组，这里两种都兼容。
 */
function planSurfaceRewind(events, surfaceNodes, targetSeq) {
  // 归一化 surface 节点为数字 seq 列表（DSH 0.1.2+ 的 surface.nodes 是 number[]，
  // 旧版可能是 { seq } 对象索引形式）。
  const seqList = surfaceNodes.length > 0 && typeof surfaceNodes[0] === 'number'
    ? surfaceNodes.slice()
    : surfaceNodes.map(n => n.seq)

  // 丢弃从该消息开始之后的 surface 节点：找到第一个 seq >= targetSeq 的节点并全部截断。
  // 不用精确 indexOf(targetSeq)——当 user 消息已被后续 replace 遮蔽、或 messageSeq
  // 介于两个 surface 节点之间时，精确匹配会失败而报 target seq not on surface；
  // at-or-after 策略从该消息或其后的最近 surface 节点截断，仍实现恢复到发送这条消息之前。
  const dropFrom = seqList.findIndex(s => s >= targetSeq)
  if (dropFrom === -1) {
    throw new Error('target seq ' + targetSeq + ' not on surface')
  }
  const shadowedSeqs = seqList.slice(dropFrom)
  return {
    targetSeq,
    targetIndex: dropFrom,
    shadowedSeqs,
    surfaceStart: shadowedSeqs[0],
    surfaceEnd: shadowedSeqs[shadowedSeqs.length - 1],
  }
}

/**
 * Rewind one live session's surface to before a target user message, in place:
 * append a ghost step/marker assistant/message carrying surfaceOp.replace that
 * drops every surface node from target onwards. No fork.
 */
async function executeSurfaceRewind(agent, targetSeq) {
  const session = agent.session
  const surfaceNodes = session.surface?.nodes || []
  if (!surfaceNodes || surfaceNodes.length === 0) {
    throw new Error('no surface nodes available')
  }
  const plan = planSurfaceRewind(session.events || [], surfaceNodes, targetSeq)
  const turn = markerTurnOf(session.events || [])
  const step = markerStepOf(session.events || [], turn)

  agent.session.append('step/start', { turn, step })
  try {
    const marker = {
      content: [],
      source: { provider: 'turn-undo', model: 'rewind-marker' },
    }
    agent.session.append('assistant/message', { turn, step, message: marker }, {
      surfaceOp: { op: 'replace', start: plan.surfaceStart, end: plan.surfaceEnd },
      sourceEventSeqs: plan.shadowedSeqs,
    })
  } finally {
    agent.session.append('step/end', { turn, step })
  }

  return plan
}

// ===========================================================================
// Fork + mark-undone
// ===========================================================================
/**
 * Fork a new child session at the message via DSH SessionController,
 * then mark the OLD session undone.
 *
 * - Uses the same `sessionController.fork` RPC as the web UI's
 *   "Branch into a new conversation" / "Fork session" buttons.
 * - Falls back to `sessionController.create` when the target message has
 *   no completed turn before it (e.g. the very first user message).
 * @returns the new child session id.
 */
async function forkAndMarkUndone(ctx, sessionId, messageSeq, promptText) {
  const source = await readSession(ctx, sessionId)
  if (!source) throw new Error('source session not found')
  const b = resolveForkBoundary(source, messageSeq, promptText)

  let childId
  if (typeof b.boundary === 'number') {
    const { sessionId: cid } = await ctx.sessionController.fork({ sessionId, atSeq: b.boundary })
    childId = cid
  } else {
    const cwd = source.header?.cwd
    if (!cwd) throw new Error('cannot undo first message without a cwd')
    const created = await ctx.sessionController.create({
      cwd,
      ...(source.header?.agentPreset ? { agentPreset: source.header.agentPreset } : {}),
    })
    childId = created.sessionId
  }

  try {
    let oldTitle = ''
    if (ctx.sessionQuery && typeof ctx.sessionQuery.readTitle === 'function') {
      const t = await ctx.sessionQuery.readTitle(sessionId)
      oldTitle = t && t.title ? t.title : ''
    }
    const prefix = '（已撤销）'
    if (!oldTitle.startsWith(prefix)) {
      await ctx.sessionController.rename({
        sessionId,
        title: prefix + (oldTitle || '（未命名会话）'),
      })
    }
  } catch (e) {
    console.warn('[turn-undo] Rename old session failed (non-fatal):', e.message)
  }

  return childId
}
// ===========================================================================
// HTTP handler + plugin entry
// ===========================================================================

function createHandler(ctx, runtime, sessions, agents) {
  return async (request, response) => {
    try {
      if (request.method === 'GET') {
        const url = new URL(request.url ?? API_PATH, 'http://dsh.local')
        const sessionId = url.searchParams.get('sessionId')
        const messageSeqParam = url.searchParams.get('messageSeq')
        const promptTextParam = url.searchParams.get('promptText')

        if (!sessionId) return json(response, 400, { error: 'Missing sessionId' })

        let targetTurn = null
        if (messageSeqParam) {
          const source = await readSession(ctx, sessionId)
          if (source) {
            const b = resolveForkBoundary(source, parseInt(messageSeqParam, 10), promptTextParam)
            // For preview, pass the turn that the user wants to undo (b.turn).
            // The preview function will compare this turn's snapshot with the previous one.
            targetTurn = b.turn !== null && b.turn > 0 ? b.turn : null
          }
        }

        // Wait for any in-flight snapshot capture so the preview reflects the
        // latest committed workspace state (avoids showing a stale turn/end).
        try { await runtime.waitForSnapshots() } catch {}
        const preview = runtime.store.preview(sessionId, targetTurn)
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
        if (!sessionId) return json(response, 400, { error: 'Missing sessionId' })

        const source = await readSession(ctx, sessionId)
        if (!source) return json(response, 400, { error: 'Session not found' })
        const cwd = getCwd(source)
        const b = messageSeq !== null ? resolveForkBoundary(source, messageSeq, promptText) : { boundary: null, turn: null, cwd }

        // Determine restore target: "recover to before this message" means
        // the state at turn/start, i.e. turn T - 0.5. That snapshot captures
        // the workspace before the user sent this message and before any AI work.
        let restoreTurn = null
        if (b.turn !== null && b.turn > 0) {
          restoreTurn = b.turn - 0.5
        }

        // 3. Wait for any pending snapshot to settle so the manifest is on disk.
        //    Without this, a restore issued right after turn/end may read an
        //    empty snapshot chain and skip file restoration.
        try { await runtime.waitForSnapshots() } catch {}

        // 3.5 Safety snapshot: before this irreversible restore wipes files,
        //    force-capture the CURRENT workspace into the session chain (as a
        //    fractional turn just past the newest snapshot) so the user can
        //    restore again to the pre-undo state if needed. Non-fatal on failure.
        try {
          const chain = runtime.store.loadChain(sessionId)
          const lastTurn = chain.length ? chain[chain.length - 1].turn : 0
          await runtime.captureNow(cwd, sessionId, lastTurn + 0.5)
        } catch (e) {
          console.warn('[turn-undo] safety snapshot failed (non-fatal):', e?.message)
        }

        // 4. Restore files to the best snapshot at/before restoreTurn.
        let restoreResult
        if (restoreTurn !== null) {
          restoreResult = runtime.store.restore(cwd, sessionId, restoreTurn)
        } else {
          restoreResult = { ok: false, error: 'NO_SNAPSHOT' }
        }

        // 5. Fork 新会话（DSH 原生，web 的在此分叉按钮同款：ctx.agents.create），
        //    并把旧会话标题加上 （已撤销） 前缀后保留。
        let newSessionId = null
        try {
          newSessionId = await forkAndMarkUndone(ctx, sessionId, messageSeq, promptText)
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
          newSessionId,
          restore: {
            ok: restoreResult?.ok === true,
            skipped: restoreResult?.error === 'NO_SNAPSHOT',
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
  ctx.inject(['webServer', 'sessions', 'sessionQuery', 'agents', 'sessionTitle', 'sessionController'], (scope) => {
    scope.effect(() => {
      const handler = createHandler(scope, runtime, scope.sessions, scope.agents)
      scope.webServer.register({
        kind: 'exact',
        path: API_PATH,
        handler,
      })
      return () => {}
    }, 'turn-undo: http-api')
  })
}

// Add preview helper to SnapshotStore prototype.
// Returns the files that changed during the target turn (turn/end vs turn/start).
SnapshotStore.prototype.preview = function (sessionId, targetTurn) {
  const chain = this.loadChain(sessionId)
  if (targetTurn === null) {
    return { ok: true, status: 'ready', targetTurn: null, totalChanges: 0, changes: [] }
  }

  // 撤销"发送这条消息之前"会一并回退该消息之后的所有改动，因此影响范围 =
  // baseline（targetTurn 之前最近的快照，即恢复到什么状态）与 latest
  // （会话最新快照，即撤销点之后累积到当前的状态终点）之差。
  // baseline 取小于 targetTurn 的最新快照：正常是该 turn/start 快照
  // (T - 0.5)，若中间某 turn 无文件变化没写 manifest，则回退到更早的最近
  // 快照；对于没有前置快照的首条消息，用空对象 {} 作为基线（即回到空状态）。
  let baseline = null
  for (const m of chain) {
    if (m.turn < targetTurn && (baseline === null || m.turn > baseline.turn)) {
      baseline = m
    }
  }
  const baselineManifest = baseline ? baseline.manifest : {}

  if (chain.length === 0) {
    return { ok: true, status: 'ready', targetTurn, totalChanges: 0, changes: [], noSnapshot: true }
  }

  // 会话最新快照 = 撤销点之后所有改动的累积终点。
  const latest = chain[chain.length - 1]
  const latestManifest = latest.manifest

  // Calculate changes between latest and baseline: these are the files that
  // undo (restoring to baseline) will affect — every change made at or after
  // the target turn.
  const changes = []
  for (const rel of Object.keys(latestManifest)) {
    const entry = latestManifest[rel]
    if (!baselineManifest[rel]) {
      changes.push({ path: rel, kind: 'created' })
    } else {
      const prevEntry = baselineManifest[rel]
      if (entry.hash !== prevEntry.hash) {
        changes.push({ path: rel, kind: 'modified' })
      }
    }
  }

  for (const rel of Object.keys(baselineManifest)) {
    if (!latestManifest[rel]) {
      changes.push({ path: rel, kind: 'deleted' })
    }
  }

  return {
    ok: true,
    status: 'ready',
    targetTurn,
    totalChanges: changes.length,
    changes,
  }
}
