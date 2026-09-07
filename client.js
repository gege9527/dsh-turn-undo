// Browser half of the dsh-turn-undo plugin.
//
// Injects a "restore to before this message" button into the IconActions row of
// EVERY USER MESSAGE ONLY (never AI replies), using React.createPortal.
//
// Injection logic mirrors dsh-turn-rewind's collectPortalTargets():
//   1. Locate message rows with [data-chat-flow-kind="user"][data-chat-anchor-key]
//      or [data-chat-flow-kind="steering"][data-chat-anchor-key] — only user
//      messages carry these flow kinds (AI replies use "assistant-step",
//      "tool-call", etc. and are never selected).
//   2. Inside the row, find the message actions container (the element
//      holding the copy/branch buttons). We locate it by taking the parent of
//      the row's first <button> (dimension-independent of hashed CSS classes).
//   3. That parent element becomes the portal target for the undo button.
//
// Communication:
//   GET  /api/turn-undo?sessionId=...&turn=...   -> preview
//   POST /api/turn-undo                          -> restore
//
// See DESIGN.md for full architecture.

window.__ModuleLoader__.load({
  id: 'dsh-turn-undo',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var API_PATH = '/api/turn-undo'
    var USER_ROW_SELECTOR = '[data-chat-flow-kind="user"][data-chat-anchor-key], [data-chat-flow-kind="steering"][data-chat-anchor-key]'

    // 定位用户/steering 消息的操作行容器。
    // 运行时用户行内没有 data-actions-reveal（该属性只在 turn-tail 上）；
    // 直接用稳定结构：取行内第一个 <button>（copy 等）的 parentElement 作为操作行。
    function findIconActions(row) {
      if (!row || row.nodeType !== 1) return null
      var kind = row.getAttribute('data-chat-flow-kind')
      if (kind !== 'user' && kind !== 'steering') return null
      var firstButton = row.querySelector('button')
      if (!firstButton) return null
      var actions = firstButton.parentElement
      if (!actions || actions.nodeType !== 1) return null
      if (actions.querySelectorAll(':scope > button').length < 1) return null
      return actions
    }

    function truncate(text, max) {
      return text.length > max ? text.substring(0, max) + '…' : text
    }

    function kindLabel(kind) {
      switch (kind) {
        case 'created': return '已创建'
        case 'modified': return '已修改'
        case 'deleted': return '已删除'
        default: return '已变更'
      }
    }

    function apply(ctx) {
      var react, reactDom
      try {
        react = require('react')
        reactDom = require('react-dom')
      } catch (error) {
        console.error('[turn-undo] client skipped: cannot load react', error)
        return
      }
      var h = react.createElement
      var useState = react.useState
      var useEffect = react.useEffect
      var useLayoutEffect = react.useLayoutEffect

      var STYLE_ID = 'dsh-turn-undo'
      if (!document.getElementById('dsh-turn-undo-styles')) {
        var styleEl = document.createElement('style')
        styleEl.id = 'dsh-turn-undo-styles'
        styleEl.textContent = [
          '.dtu-container{display:inline-flex;align-items:center}',
          '.dtu-trigger{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}',
          '.dtu-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
          '.dtu-trigger:disabled{cursor:not-allowed;opacity:.5}',
          '.dtu-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:10000}',
          '.dtu-dialog{box-sizing:border-box;width:min(560px,100%);max-height:calc(100dvh - 48px);overflow:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.2)}',
          '.dtu-body{display:flex;flex-direction:column;gap:14px;width:100%;min-width:0;max-width:100%;box-sizing:border-box;padding:18px}',
          '.dtu-header{display:flex;justify-content:space-between;align-items:center;gap:12px}',
          '.dtu-title{margin:0;font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary)}',
          '.dtu-close{width:28px;height:28px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:20px;cursor:pointer}.dtu-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
          '.dtu-section-label{font-size:14px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:0 0 8px}',
          '.dtu-msgbox{font-size:14px;color:var(--dsw-alias-label-primary);padding:8px 12px;background:var(--dsw-alias-bg-layer-2);border-radius:6px;line-height:1.5}',
          '.dtu-status{margin:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}',
          '.dtu-files{min-width:0;max-width:100%;box-sizing:border-box;max-height:220px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}',
          '.dtu-file{display:flex;justify-content:space-between;gap:16px;min-width:0;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px}.dtu-file:last-child{border-bottom:0}',
          '.dtu-more{display:flex;justify-content:center;gap:8px;padding:8px 10px;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
          '.dtu-file code{min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}',
          '.dtu-kind{flex:none;color:var(--dsw-alias-label-tertiary)}',
          '.dtu-warning,.dtu-error{box-sizing:border-box;max-width:100%;margin:0;padding:10px 12px;overflow-wrap:anywhere;word-break:break-word;border-radius:10px;font-size:12px;line-height:18px}',
          '.dtu-warning{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary)}',
          '.dtu-error{border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);color:var(--dsw-alias-state-error-primary)}',
          '.dtu-footer{display:flex;justify-content:flex-end;gap:12px}',
          '.dtu-btn{padding:8px 16px;border:0;border-radius:6px;font-size:14px;cursor:pointer}',
          '.dtu-btn-cancel{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}.dtu-btn-cancel:hover{background:var(--dsw-alias-interactive-bg-hover)}',
          '.dtu-btn-primary{background:var(--dsw-alias-state-business-primary);color:#fff;font-weight:500;min-width:120px}.dtu-btn-primary:hover{opacity:.9}.dtu-btn-primary:disabled{opacity:.5;cursor:not-allowed}',
          '.dtu-file{cursor:pointer}.dtu-file:hover{background:var(--dsw-alias-bg-layer-3)}',
          '.dtu-fullscreen-diff{position:fixed;inset:0;background:var(--dsw-alias-bg-layer-1);z-index:11000;display:flex;flex-direction:column}',
          '.dtu-fullscreen-header{display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l2);flex-shrink:0}',
          '.dtu-fullscreen-back{background:transparent;border:0;font-size:14px;cursor:pointer;color:var(--dsw-alias-label-secondary);padding:6px 10px;border-radius:6px}.dtu-fullscreen-back:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
          '.dtu-fullscreen-path{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
          '.dtu-fullscreen-close{background:transparent;border:0;font-size:24px;cursor:pointer;color:var(--dsw-alias-label-tertiary);padding:4px 8px;border-radius:6px}.dtu-fullscreen-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
          '.dtu-fullscreen-body{flex:1;display:flex;flex-direction:column;overflow:hidden}',
          '.dtu-diff-columns-wrapper{display:flex;padding:0 16px 8px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:0.5px;flex-shrink:0}',
          '.dtu-diff-column-label{flex:1;text-align:center;border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:4px}',
          '.dtu-diff-scroll-container{flex:1;overflow:auto}',
          '.dtu-diff-row{display:flex;border-bottom:1px solid var(--dsw-alias-border-l1);min-height:21px}',
          '.dtu-diff-row-removed{background:rgba(248,81,73,.15)}',
          '.dtu-diff-row-added{background:rgba(63,185,80,.15)}',
          '.dtu-diff-cell{flex:1;font-family:monospace;font-size:13px;line-height:21px;padding:0 8px 0 52px;display:flex;white-space:pre-wrap;word-break:break-all;position:relative}',
          '.dtu-diff-cell-left{border-right:1px solid var(--dsw-alias-border-l1)}',
          '.dtu-diff-cell-removed{color:#f85149}',
          '.dtu-diff-cell-added{color:#39b54e}',
          '.dtu-diff-line-num{position:absolute;left:4px;top:0;width:44px;text-align:right;color:var(--dsw-alias-label-tertiary);font-size:12px;pointer-events:none;padding-right:4px}',
          '.dtu-diff-line-num-empty{visibility:hidden}',
          '.dtu-diff-empty{display:flex;align-items:center;justify-content:center;height:100%;color:var(--dsw-alias-label-tertiary);font-size:14px}',
        ].join('')
        document.head.appendChild(styleEl)
      }

      function openRestoredSession(sessionId, draftText) {
        try {
          ctx.sessions.open(sessionId)
        } catch (error) {
          console.warn('[turn-undo] openRestoredSession open failed:', error.message)
          return
        }
        if (!draftText) return
        function trySetDraft(remaining) {
          if (remaining <= 0) return
          try {
            var scope = ctx.sessions.scope(sessionId)
            if (scope !== undefined) {
              ctx.conversation.input.for(scope).setDraft(draftText)
              return
            }
          } catch (error) {
            if (remaining <= 1) {
              console.warn('[turn-undo] openRestoredSession setDraft failed:', error.message)
            }
          }
          setTimeout(function () { trySetDraft(remaining - 1) }, 100)
        }
        trySetDraft(20)
      }

      ctx.inject(['slots', 'sessions', 'conversation'], function (scope) {
        scope.effect(function () {
          return scope.slots.inject('conversation.session.header.actions', function () {
            return scope.slots.register({
              name: 'conversation.session.header.actions',
              id: 'turn-undo-portals',
              order: 100,
              inject: function () {
                var sessionsSvc = scope.sessions
                var conversationSvc = scope.conversation
                return {
                  openRestoredSession: function (newSessionId, draftText) {
                    // Open first: the input shell only exists after the session binding is materialized.
                    if (sessionsSvc && sessionsSvc.open) {
                      sessionsSvc.open(newSessionId)
                    }
                    if (!conversationSvc || !conversationSvc.input || !draftText) return
                    function trySetDraft(remaining) {
                      if (remaining <= 0) return
                      try {
                        var shell = conversationSvc.input.shell(newSessionId)
                        if (shell && typeof shell.setDraft === 'function') {
                          shell.setDraft(draftText)
                          return
                        }
                      } catch (e) {
                        if (remaining <= 1) {
                          console.warn('[turn-undo] Failed to set draft in new session:', e.message)
                        }
                      }
                      setTimeout(function () { trySetDraft(remaining - 1) }, 100)
                    }
                    trySetDraft(20)
                  },
                }
              },
            }, RestoreMessagePortals)
          })
        })
      })

      function RestoreMessagePortals(props) {
        var sessionId = props.sessionId
        var openRestoredSessionProp = props.openRestoredSession
        var useChat = props.useChat
        var nodes = useChat(function (snapshot) {
          return snapshot.nodes ? snapshot.nodes.values() : []
        })
        var targetsState = useState([])
        var targets = targetsState[0]
        var setTargets = targetsState[1]

        useLayoutEffect(function () {
          var active = true
          var queued = false
          var refresh = function () {
            if (!active) return
            var next = collectPortalTargets(nodes)
            setTargets(function (current) {
              return samePortalTargets(current, next) ? current : next
            })
          }
          var queueRefresh = function () {
            if (queued || !active) return
            queued = true
            queueMicrotask(function () {
              queued = false
              refresh()
            })
          }
          refresh()
          var observer = new MutationObserver(queueRefresh)
          observer.observe(document.body, { childList: true, subtree: true })
          return function () {
            active = false
            observer.disconnect()
          }
        }, [nodes])

        var portals = []
        for (var i = 0; i < targets.length; i++) {
          var target = targets[i]
          portals.push(reactDom.createPortal(
            h(RestoreMessageAction, {
              matched: target.matched,
              sessionId: sessionId,
              openRestoredSession: openRestoredSessionProp,
            }),
            target.container,
            sessionId + ':' + String(target.matched.messageSeq),
          ))
        }
        return portals
      }

      function RestoreMessageAction(props) {
        var matched = props.matched
        var sessionId = props.sessionId
        var openRestoredSession = props.openRestoredSession
        var messageSeq = matched.messageSeq
        var messageText = matched.promptText
        var openState = useState(false)
        var open = openState[0]
        var setOpen = openState[1]
        var previewState = useState(null)
        var preview = previewState[0]
        var setPreview = previewState[1]
        var loadingState = useState(true)
        var loading = loadingState[0]
        var setLoading = loadingState[1]
        var errorState = useState(null)
        var error = errorState[0]
        var setError = errorState[1]
        var applyingState = useState(false)
        var applying = applyingState[0]
        var setApplying = applyingState[1]
        var doneState = useState(false)
        var done = doneState[0]
        var setDone = doneState[1]

        useEffect(function () {
          var cancelled = false
          setLoading(true)
          setError(null)
          fetch(API_PATH + '?sessionId=' + encodeURIComponent(sessionId) + '&messageSeq=' + messageSeq + '&promptText=' + encodeURIComponent(messageText), {
            method: 'GET', headers: { 'Accept': 'application/json' }, cache: 'no-store',
          })
            .then(function (res) { return res.json() })
            .then(function (data) { if (!cancelled) setPreview(data) })
            .catch(function (err) { if (!cancelled) setError(err.message || '请求失败') })
            .finally(function () { if (!cancelled) setLoading(false) })
          return function () { cancelled = true }
        }, [])

        function show() {
          setOpen(true)
          setPreview(null)
          setDone(false)
          setLoading(true)
          // NOTE: cancelled 只存在于 mount effect 闭包，show() 引用它会抛
          // ReferenceError → setLoading(false) 永不执行 → 弹框一直"正在检查…"，
          // 且未捕获错误可能导致 React 卸下 portal（按钮消失）。必须无条件收尾。
          fetch(API_PATH + '?sessionId=' + encodeURIComponent(sessionId) + '&messageSeq=' + messageSeq + '&promptText=' + encodeURIComponent(messageText), {
            method: 'GET', headers: { 'Accept': 'application/json' }, cache: 'no-store',
          })
            .then(function (res) { return res.json() })
            .then(function (data) { setPreview(data) })
            .catch(function (err) { setError(err.message || '请求失败') })
            .finally(function () { setLoading(false) })
        }

        function close() { if (applying) return; setOpen(false) }

        function canApply() {
          return preview !== null && !preview.error && !loading && !applying && !done
        }

        function applyRestore() {
          if (!canApply() || applying) return
          setApplying(true)
          setError(null)
          fetch(API_PATH, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: sessionId, messageSeq: messageSeq, promptText: messageText }),
          })
            .then(function (res) { return res.json() })
            .then(function (data) {
              if (data.error && data.ok === false) { setError(data.error); setApplying(false); return }
              setDone(true)
              setApplying(false)
              setOpen(false)
              if (data.newSessionId && openRestoredSession) {
                openRestoredSession(data.newSessionId, messageText)
              }
            })
            .catch(function (err) { setError(err.message || '请求失败'); setApplying(false) })
        }

        var changes = (preview && Array.isArray(preview.changes)) ? preview.changes : []
        var noSnapshot = (preview && preview.noSnapshot) === true
        var previewError = (preview && preview.error) ? preview.error : null

        return h('div', { className: 'dtu-container' },
          h('button', {
            type: 'button', className: 'dtu-trigger',
            title: '恢复到发送这条消息之前', 'aria-label': '恢复到发送这条消息之前',
            onClick: show, disabled: applying,
          },
            h('svg', {
              width: '16', height: '16', viewBox: '0 0 16 16',
              fill: 'none', 'aria-hidden': 'true', style: { display: 'block' },
            },
              h('path', {
                d: 'M6.35 3.25 2.75 7l3.6 3.75M3.1 7h5.15a4.25 4.25 0 0 1 4.25 4.25v1.25',
                stroke: 'currentColor', strokeWidth: '1.45',
                strokeLinecap: 'round', strokeLinejoin: 'round',
              }),
            ),
          ),
          open ? h(RestoreDialog, {
            sessionId: sessionId, messageText: messageText,
            onClose: close, preview: preview, loading: loading, error: error,
            applying: applying, done: done, changes: changes,
            previewError: previewError, noSnapshot: noSnapshot, canApply: canApply, applyRestore: applyRestore,
          }) : null,
        )
      }

      // Full-screen VSCode-style diff overlay — side-by-side with single scrollbar
            // Full-screen VSCode-style diff overlay — single scrollbar, line numbers
      function DiffOverlay(props) {
        var onClose = props.onClose
        var change = props.change
        
        var isCreated = change.kind === 'created'
        var isDeleted = change.kind === 'deleted'
        var isModified = change.kind === 'modified'
        
        // 构建 diff 行数据
        var diffRows = []
        
        if (change.diff && change.diff.hunks) {
          var oldLine = 0
          var newLine = 0
          
          for (var i = 0; i < change.diff.hunks.length; i++) {
            var hunk = change.diff.hunks[i]
            
            if (hunk.type === 'removed') {
              diffRows.push({
                type: 'removed',
                text: hunk.value,
                oldLine: ++oldLine,
                newLine: null
              })
            } else if (hunk.type === 'added') {
              diffRows.push({
                type: 'added',
                text: hunk.value,
                oldLine: null,
                newLine: ++newLine
              })
            } else {
              diffRows.push({
                type: 'same',
                text: hunk.value,
                oldLine: ++oldLine,
                newLine: ++newLine
              })
            }
          }
        }
        
        var leftLabel = isCreated ? '' : '原始版本'
        var rightLabel = isDeleted ? '' : '修改后版本'
        
        // 安全转义 HTML
        function escapeHtml(text) {
          if (!text) return ''
          return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;')
        }
        
        return reactDom.createPortal(
          h('div', {
            className: 'dtu-fullscreen-diff',
            onClick: onClose,
            onKeyDown: function (e) {
              if (e.key === 'Escape') onClose()
            }
          },
            h('div', { className: 'dtu-fullscreen-header', onClick: function (e) { e.stopPropagation() } },
              h('button', {
                className: 'dtu-fullscreen-back',
                onClick: onClose
              }, '← 关闭'),
              h('span', { className: 'dtu-fullscreen-path' }, change.path),
              h('div', null,
                isCreated ? h('span', { style: { color: '#39b54e', fontSize: '11px' } }, '● 新文件') : null,
                isDeleted ? h('span', { style: { color: '#f85149', fontSize: '11px' } }, '● 已删除') : null,
                isModified ? h('span', { style: { color: '#f85149', fontSize: '11px', marginRight: '8px' } }, '● 删除') : null,
                isModified ? h('span', { style: { color: '#39b54e', fontSize: '11px' } }, '● 添加') : null
              ),
              h('button', {
                className: 'dtu-fullscreen-close',
                onClick: onClose
              }, '✕')
            ),
            h('div', { className: 'dtu-fullscreen-body' },
              h('div', { className: 'dtu-diff-columns-wrapper' },
                leftLabel ? h('div', { className: 'dtu-diff-column-label' }, leftLabel) : null,
                rightLabel ? h('div', { className: 'dtu-diff-column-label' }, rightLabel) : null
              ),
              h('div', { className: 'dtu-diff-scroll-container' },
                diffRows.length > 0
                  ? h('div', null, diffRows.map(function (row, idx) {
                      var rowClass = 'dtu-diff-row'
                      if (row.type === 'removed') rowClass += ' dtu-diff-row-removed'
                      else if (row.type === 'added') rowClass += ' dtu-diff-row-added'
                      
                      var escapedText = escapeHtml(row.text)
                      
                      return h('div', { key: idx, className: rowClass },
                        // 左栏
                        h('div', { className: 'dtu-diff-cell dtu-diff-cell-left' },
                          h('span', { className: 'dtu-diff-line-num' }, row.oldLine || ''),
                          escapedText
                        ),
                        // 右栏
                        h('div', { className: 'dtu-diff-cell dtu-diff-cell-right' },
                          h('span', { className: 'dtu-diff-line-num' }, row.newLine || ''),
                          escapedText
                        )
                      )
                    }))
                  : h('div', { className: 'dtu-diff-empty' }, '(无差异)')
              )
            )
          ),
          document.body
        )
      }function RestoreDialog(props) {
        var sessionId = props.sessionId
        var messageText = props.messageText
        var onClose = props.onClose
        var preview = props.preview
        var loading = props.loading
        var error = props.error
        var applying = props.applying
        var done = props.done
        var changes = props.changes
        var previewError = props.previewError
        var noSnapshot = props.noSnapshot
        var canApply = props.canApply
        var applyRestore = props.applyRestore
        
        // Diff viewing state
        var showDiffState = useState(null)
        var showDiff = showDiffState[1]
        var viewingDiff = showDiffState[0]

        // 文件很多时避免一次性渲染大量 DOM（性能优化）：只渲染前 200 个，
        // 其余折叠成一条提示。总数仍在标题里显示。
        var MAX_PREVIEW_FILES = 200
        var shownChanges = changes.length > MAX_PREVIEW_FILES
          ? changes.slice(0, MAX_PREVIEW_FILES)
          : changes

        return reactDom.createPortal(
          h('div', { className: 'dtu-overlay', onClick: onClose },
            h('div', { className: 'dtu-dialog', onClick: function (e) { e.stopPropagation() } },
              h('div', { className: 'dtu-body' },
                h('div', { className: 'dtu-header' },
                  h('h3', { className: 'dtu-title' }, '恢复到发送这条消息之前'),
                  h('button', { onClick: onClose, className: 'dtu-close', 'aria-label': '关闭' },
                    h('span', {}, '×'),
                  ),
                ),
                messageText ? h('div', { className: 'dtu-section' },
                  h('div', { className: 'dtu-section-label' }, '消息'),
                  h('div', { className: 'dtu-msgbox' }, truncate(messageText, 200)),
                ) : null,
                loading ? h('p', { className: 'dtu-status' }, '正在检查可以恢复的项目文件…') : null,
                previewError ? h('p', { className: 'dtu-error' }, previewError) : null,
                (!loading && noSnapshot)
                  ? h('p', { className: 'dtu-status' }, '该时点没有可用快照，将仅创建新会话。') : null,
                (!loading && !previewError && !noSnapshot && changes.length === 0)
                  ? h('p', { className: 'dtu-status' }, '这条消息之前没有需要恢复的文件。') : null,
                (!loading && !previewError && changes.length > 0)
                  ? h('div', { className: 'dtu-section' },
                      h('div', { className: 'dtu-section-label' }, '将影响的文件 (' + changes.length + ' 个)'),
                      h('div', { className: 'dtu-files' },
                        h('div', { className: 'dtu-files' },
                          shownChanges.map(function (change, idx) {
                            var isModified = change.kind === 'modified' && change.diff
                            return h('div', {
                              key: idx,
                              className: 'dtu-file',
                              onClick: isModified ? function () { showDiff(isModified ? change : null) } : undefined,
                              style: isModified ? { cursor: 'pointer' } : {}
                            },
                              h('code', {}, change.path),
                              h('span', { className: 'dtu-kind' }, kindLabel(change.kind)),
                              isModified ? h('span', { className: 'dtu-diff-indicator', style: { fontSize: '11px', marginLeft: '4px', opacity: '.6' } }, '👁') : null
                            )
                          }),
                          (changes.length > shownChanges.length)
                            ? h('div', { className: 'dtu-more' },
                                '… 还有 ' + (changes.length - shownChanges.length) + ' 个文件未显示'
                              ) : null,
                        ),
                        // Full-screen diff overlay
                        viewingDiff
                          ? h(DiffOverlay, { change: viewingDiff, onClose: function () { showDiff(null) } })
                          : null,
                      ),
                    ) : null,
                (!loading && !previewError && changes.length > 0)
                  ? h('div', { className: 'dtu-warning' },
                      '警告：恢复会把文件覆盖到这条消息发送前的状态。'
                    ) : null,
                (error && !previewError) ? h('p', { className: 'dtu-error' }, error) : null,
                h('div', { className: 'dtu-footer' },
                  h('button', { onClick: onClose, className: 'dtu-btn dtu-btn-cancel', disabled: applying }, '取消'),
                  h('button', {
                    onClick: applyRestore, className: 'dtu-btn dtu-btn-primary',
                    disabled: !canApply(),
                  }, done ? '已完成' : (applying ? '正在恢复…' : '确认恢复并继续')),
                ),
              ),
            ),
          ),
          document.body,
        )
      }

      function selectUndoMessage(node) {
        if (node.kind !== 'user' && node.kind !== 'steering') return null
        if (typeof node.seq !== 'number' || node.seq < 0) return null
        var promptText = ''
        var content = node.content || []
        for (var i = 0; i < content.length; i++) {
          if (content[i].type === 'text' && typeof content[i].text === 'string') {
            promptText += content[i].text + '\n'
          }
        }
        if (!promptText.trim()) return null
        return { messageSeq: node.seq, promptText: promptText.trim().substring(0, 200) }
      }

      function selectUndoMessageTarget(value) {
        var node = ('key' in value && 'data' in value) ? value.data : value
        var matched = selectUndoMessage(node)
        if (matched === null) return null
        return {
          matched: matched,
          rowKey: ('key' in value && 'data' in value) ? value.key : ('node:' + String(node.seq)),
        }
      }

      function collectPortalTargets(nodes) {
        var nodeArr = (nodes && typeof nodes.length === 'number') ? nodes : Array.from(nodes || [])
        var rows = new Map()
        var elements = document.querySelectorAll(USER_ROW_SELECTOR)
        for (var i = 0; i < elements.length; i++) {
          var element = elements[i]
          var key = element.getAttribute('data-chat-anchor-key')
          if (key) rows.set(key, element)
        }
        var targets = []
        for (var i = 0; i < nodeArr.length; i++) {
          var node = nodeArr[i]
          var target = selectUndoMessageTarget(node)
          if (target === null) continue
          var row = rows.get(target.rowKey)
          if (!row) continue
          // 用与 findIconActions 相同的稳定策略定位操作行容器。
          var actions = findIconActions(row)
          if (!actions) continue
          targets.push({ container: actions, matched: target.matched })
        }
        return targets
      }

      function samePortalTargets(left, right) {
        return left.length === right.length && left.every(function (target, index) {
          var other = right[index]
          return other !== undefined
            && target.container === other.container
            && target.matched.messageSeq === other.matched.messageSeq
            && target.matched.promptText === other.matched.promptText
        })
      }
    }

    exports.apply = apply
    exports.inject = ['slots', 'sessions', 'conversation']
    return module.exports
  },
})