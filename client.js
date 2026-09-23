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
//      holding the copy/branch buttons). DSH seats the row's renderer inside
//      passthrough wrappers (slot outlets render display:contents with one
//      child), so we walk down firstElementChild past single-child wrappers
//      to the UserStyleBubble root, whose LAST direct element child is the
//      MessageIconActions row (dimension-independent of hashed CSS classes).
//      "Parent of the first button" broke after the ui-attachment refactor:
//      attachment thumbnails are <button>s that render before the actions
//      row, so the first button is no longer the copy control.
//   3. That parent element becomes the portal target for the undo button.
//
// DSH 0.1.6+ CSS-reveals a user/steering row's .actions strip only on
// hover/focus while a later user/steering row exists
// (MessageIconActions.module.css:
//  :is([data-chat-flow-kind='user'],[data-chat-flow-kind='steering']):has(
//    ~ :is(...)) .actions { opacity:0 }). A portal button inside .actions
//  would inherit that invisibility, so collectPortalTargets tags the
//  injected container with `data-dtu-always` and the plugin stylesheet
//  forces `[data-dtu-always]{opacity:1!important}`, keeping the undo
//  control permanently visible without changing DSH's hover behavior for
//  the native copy/branch controls elsewhere in the row.
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

    // Locate the user/steering message's IconActions row container.
    //
    // Structure (ChatNodeSeat.tsx + MessageItem.tsx UserStyleBubble, DSH 0.1.6+):
    //   div[data-chat-flow-kind="user"]        (row, .flowItem)
    //     div[data-slot="conversation.chat.node"]  (SlotOutlet anchor,
    //                                              display:contents passthrough)
    //       div.userRow                         (UserStyleBubble root)
    //         div.userStack                     // bubble + attachment rows
    //         div.actions                       // MessageIconActions row,
    //                                             LAST child of userRow
    //
    // The number of passthrough wrappers between the row and userRow is NOT
    // stable across DSH versions (renderSlot outlets, providers, ...), so we
    // cannot hardcode `row.firstElementChild.lastElementChild`. Instead walk
    // down firstElementChild while the element is a single-child passthrough
    // (SlotOutlet anchors render display:contents with exactly one child);
    // the first element with 2+ children is userRow — UserStyleBubble always
    // renders [userStack, actions], and actions is always its LAST child.
    //
    // The container must NOT be located by "parent of the first <button>":
    // since the ui-attachment refactor, image thumbnails / file-card retry
    // controls are <button>s that render INSIDE userStack (attachmentRow),
    // before the actions row. The first button in document order is then an
    // attachment control, whose parent is the attachment row — landing the
    // undo button next to the image.
    //
    // DSH 0.1.6+ additionally CSS-gates the whole .actions strip to
    // opacity:0 on any user/steering row that has a later user/steering
    // sibling (MessageIconActions.module.css `:has(~ …) .actions{opacity:0}`),
    // revealing it only on row hover/focus. A portal child inside .actions
    // would be invisible at rest, so collectPortalTargets tags the resolved
    // container with `data-dtu-always` and the plugin stylesheet forces
    // `[data-dtu-always]{opacity:1!important}` — the undo control stays
    // permanently visible on every user row.
    function findIconActions(row) {
      if (!row || row.nodeType !== 1) return null
      var kind = row.getAttribute('data-chat-flow-kind')
      if (kind !== 'user' && kind !== 'steering') return null
      // Walk down through passthrough wrappers (slot outlets etc.): each
      // renders exactly one child. Stop at the first element with more than
      // one child — that is userRow ([userStack, actions]). The depth cap is
      // a runaway guard, not an expected bound.
      var el = row.firstElementChild
      var depth = 0
      while (el && el.children.length <= 1 && depth < 8) {
        el = el.firstElementChild
        depth++
      }
      if (!el || el.children.length < 2) return null
      var actions = el.lastElementChild
      if (!actions || actions.nodeType !== 1) return null
      if (!actions || actions.nodeType !== 1) return null
      // Guard: the actions row always carries at least one direct <button>
      // (the copy control). If it does not, the row has no action strip and
      // there is nowhere to seat the undo button.
      if (actions.querySelectorAll(':scope > button').length < 1) return null
      // The guard is content-level: an attachment gallery or retry control
      // that leaked into this container means the DOM structure drifted, and
      // seating the undo button there would repeat the "next to the image"
      // bug. Reject rather than inject into the wrong element.
      if (actions.querySelector('[data-variant]')) return null
      if (actions.querySelector('img')) return null
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
          // 点击后浏览器保留 :focus，hover 底色会「粘住」不恢复 —— 鼠标移开时
          // 显式清掉 focus/active 态的背景与描边。
          '.dtu-trigger:focus{outline:none}',
          '.dtu-trigger:focus:not(:hover),.dtu-trigger:focus-visible:not(:hover),.dtu-trigger:active:not(:hover){background:transparent;color:var(--dsw-alias-label-tertiary)}',
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
          // 插件把 portal 按钮注入 .actions 行；DSH 0.1.6+ 对"后面还有 user 行"的
          // user/steering 行默认 .actions{opacity:0}（仅 hover/focus 显现），
          // 注入按钮会跟着消失。给注入的容器打 data-dtu-always，用 !important
          // 强制常显，且不影响 DSH 原生 copy/branch 的 hover 行为（它们仍在
          // .actions 里，随父盒透明度一起显隐，与撤销按钮一致的常显）。
          '[data-dtu-always]{opacity:1!important}',
        ].join('')
        document.head.appendChild(styleEl)
      }

      ctx.inject(['slots', 'conversation', 'uiWorkspace'], function (scope) {
        scope.effect(function () {
          return scope.slots.inject('conversation.session.header.actions', function () {
            return scope.slots.register({
              name: 'conversation.session.header.actions',
              id: 'turn-undo-portals',
              order: 100,
              inject: function () {
                var workspaceSvc = scope.uiWorkspace
                var conversationSvc = scope.conversation
                return {
                  openRestoredSession: function (newSessionId, draftText) {
                    // 导航必须走 uiWorkspace：ISessions 没有 open()，
                    // 旧的 sessionsSvc.open(...) 永远被 if 守卫静默跳过 —— 这正是
                    // 「改名了但新会话没打开」的根因。
                    try {
                      if (workspaceSvc && typeof workspaceSvc.openSession === 'function') {
                        workspaceSvc.openSession(newSessionId)
                      } else {
                        console.warn('[turn-undo] uiWorkspace.openSession unavailable; new session not opened')
                      }
                    } catch (e) {
                      console.warn('[turn-undo] Failed to open restored session:', e.message)
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

        // 卡死根因 1：裸用 `useChat(s => s.nodes.values())`。
        // NodesView.values() 在 upsert 后构建**新数组**（流式输出期间几乎每帧都 dirty），
        // 而 useSyncExternalStoreWithSelector 的默认比较是 Object.is(选择器返回值)
        // → 组件每帧重渲染 → useLayoutEffect([nodes]) 每帧 teardown/recreate
        // body-subtree 的 MutationObserver + 全页扫描 → GUI 卡死。
        // 修复：用 eq 按内容比较，内容不变时选择器返回旧数组引用，渲染与 effect 都稳定。
        var nodes = useChat(function (snapshot) {
          return snapshot.nodes ? snapshot.nodes.values() : []
        }, sameNodeList)

        var targetsState = useState([])
        var targets = targetsState[0]
        var setTargets = targetsState[1]

        useLayoutEffect(function () {
          var active = true
          var timer = 0
          var refresh = function () {
            if (!active) return
            var next = collectPortalTargets(nodes)
            setTargets(function (current) {
              return samePortalTargets(current, next) ? current : next
            })
          }
          // 卡死根因 2：observer 回调对**任何** body 变更都跑全页扫描
          // （流式 token、输入框、hover 状态都在内）。只有关心 user/steering 行
          // 内部的变更才值得重扫；其余记录直接丢弃。
          // 再叠加 80ms 时间防抖，把"每帧重扫"压成"静默期结束后扫一次"。
          var isRelevant = function (record) {
            var target = record.target
            var relevant = false
            var node = target
            while (node && node.nodeType === 1) {
              if (node.hasAttribute && node.hasAttribute('data-chat-anchor-key')) {
                relevant = node.getAttribute('data-chat-flow-kind') === 'user'
                  || node.getAttribute('data-chat-flow-kind') === 'steering'
                if (relevant) break
              }
              node = node.parentNode
            }
            if (!relevant && record.addedNodes) {
              for (var i = 0; i < record.addedNodes.length; i++) {
                var added = record.addedNodes[i]
                var probe = added
                while (probe && probe.nodeType === 1) {
                  if (probe.hasAttribute && probe.hasAttribute('data-chat-anchor-key')) {
                    relevant = probe.getAttribute('data-chat-flow-kind') === 'user'
                      || probe.getAttribute('data-chat-flow-kind') === 'steering'
                    break
                  }
                  probe = probe.parentNode
                }
                if (relevant) break
              }
            }
            return relevant
          }
          var queueRefresh = function (records) {
            if (!active) return
            for (var i = 0; i < records.length; i++) {
              if (isRelevant(records[i])) {
                if (timer) clearTimeout(timer)
                timer = setTimeout(refresh, 80)
                return
              }
            }
          }
          refresh()
          var observer = new MutationObserver(queueRefresh)
          observer.observe(document.body, { childList: true, subtree: true })
          return function () {
            active = false
            if (timer) clearTimeout(timer)
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

      // eq for the useChat selector: content-level equality so the selected array
      // keeps its reference across snapshots whose node set did not structurally
      // change. A streaming frame that only refreshes node payloads therefore
      // neither re-renders this component nor re-runs the observer effect.
      //
      // 注意：不能把 `sameNodeList` 放在 RestoreMessagePortals 内部——
      // hook 行在函数声明提升之前执行时，词法作用域里的函数声明虽已提升，
      // 但 useChat 的第二参必须是一个稳定可调用对象；放模块级最稳。
      function sameNodeList(left, right) {
        if (left === right) return true
        if (left.length !== right.length) return false
        for (var i = 0; i < left.length; i++) {
          var a = left[i]
          var b = right[i]
          var av = ('key' in a && 'data' in a) ? a : { key: 'node', data: a }
          var bv = ('key' in b && 'data' in b) ? b : { key: 'node', data: b }
          if (av.key !== bv.key || av.data !== bv.data) return false
        }
        return true
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
        var loadingState = useState(false)
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

        // NOTE: preview 只在用户点开弹框时请求（见 show()）。挂载时预取毫无
        // 意义——按钮只渲染图标，不消费 preview——却会让每个会话在打开瞬间
        // 为每条用户消息各发一次全工作区扫描请求（实测单次 1.2–2.7 秒）。

        function show() {
          setOpen(true)
          setPreview(null)
          setDone(false)
          setLoading(true)
          // NOTE: 必须无条件收尾：任何未捕获错误都会让 setLoading(false) 不执行，
          // 弹框会永远停在"正在检查…"，且可能让 React 卸下 portal（按钮消失）。
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
        var noBaseline = (preview && preview.noBaseline) === true
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
            previewError: previewError, noSnapshot: noSnapshot, noBaseline: noBaseline,
            canApply: canApply, applyRestore: applyRestore,
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
                      
                      // 根据行类型决定左右栏内容
                      var leftText = (row.type === 'added') ? '' : escapedText
                      var rightText = (row.type === 'removed') ? '' : escapedText
                      
                      return h('div', { key: idx, className: rowClass },
                        // 左栏
                        h('div', { className: 'dtu-diff-cell dtu-diff-cell-left' },
                          h('span', { className: 'dtu-diff-line-num' }, row.oldLine || ''),
                          leftText
                        ),
                        // 右栏
                        h('div', { className: 'dtu-diff-cell dtu-diff-cell-right' },
                          h('span', { className: 'dtu-diff-line-num' }, row.newLine || ''),
                          rightText
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
        var noBaseline = props.noBaseline
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
                (!loading && !noSnapshot && noBaseline)
                  ? h('p', { className: 'dtu-status' }, '这条消息之前没有可用快照，无法恢复文件，将仅创建新会话。') : null,
                (!loading && !previewError && !noSnapshot && !noBaseline && changes.length === 0)
                  ? h('p', { className: 'dtu-status' }, '这条消息之前没有需要恢复的文件。') : null,
                (!loading && !previewError && !noSnapshot && !noBaseline && changes.length > 0)
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
          // DSH 0.1.6+ 的 CSS：有"后续 user/steering 行"的 user 行，其 .actions
          // 默认 opacity:0（仅 hover/focus 显现），portal 进去的撤销按钮会跟着
          // 不可见。给容器打 data-dtu-always，配合全局 [data-dtu-always]
          // {opacity:1!important} 让注入按钮常显。
          if (!actions.hasAttribute('data-dtu-always')) {
            actions.setAttribute('data-dtu-always', '')
          }
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
    exports.inject = ['slots', 'conversation', 'uiWorkspace']
    return module.exports
  },
})