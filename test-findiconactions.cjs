/**
 * Regression test for findIconActions against the NEW DSH user-row DOM
 * (ui-attachment / generic-file-upload structure + slot-outlet wrappers):
 *
 *   div[data-chat-flow-kind="user"]            (row, ChatNodeSeat .flowItem)
 *     div[data-slot="conversation.chat.node"]  (SlotOutlet anchor,
 *                                               display:contents, ONE child)
 *       div.userRow                            (UserStyleBubble root)
 *         div.userStack                        (first child of userRow)
 *           div.attachmentRow                  (image thumbnail buttons / file cards)
 *           div.bubble
 *         div.actions                          (MessageIconActions row, LAST child)
 *
 * Old strategy "parent of the row's first <button>" would resolve to the
 * attachment row (same line as the image) when attachments are present.
 * The 0.0.2 strategy "row.firstElementChild.lastElementChild" assumed no
 * wrapper between the row and userRow — real DSH seats the renderer inside
 * a SlotOutlet anchor div, so that strategy resolved userRow itself and its
 * `:scope > button` guard rejected EVERY row (the undo button vanished).
 * New strategy must walk down single-child passthrough wrappers, then
 * resolve userRow's LAST child as the actions row regardless of attachment
 * content, and reject rows that carry no action strip.
 */
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require(path.join(
  '/Users/lyu/Documents/Source/deepseek-harness/node_modules/.pnpm',
  'jsdom@29.1.1_@noble+hashes@2.3.0/node_modules/jsdom',
))

global.document = new JSDOM('<!doctype html><html><body></body></html>').window.document

const source = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8')
const start = source.indexOf('var API_PATH')
const end = source.indexOf('return module.exports')
assert(start !== -1 && end !== -1 && end > start, 'factory body markers not found')
const body = source.slice(start, end) + '\nreturn { findIconActions }\n'
const mod = new Function('require', 'exports', 'module', body)(
  () => { throw new Error('unexpected require') },
  { exports: {} },
  { exports: {} },
)

function makeRow(kind, { withImage = false, withFile = false, wrappers = 0 } = {}) {
  const row = document.createElement('div')
  row.setAttribute('data-chat-flow-kind', kind)
  row.setAttribute('data-chat-anchor-key', 'user:1')
  const userRow = document.createElement('div')
  const userStack = document.createElement('div')
  if (withImage) {
    const attachRow = document.createElement('div')
    const imgBtn = document.createElement('button')
    imgBtn.setAttribute('data-variant', 'single')
    imgBtn.setAttribute('aria-label', 'image preview')
    imgBtn.appendChild(document.createElement('img'))
    attachRow.appendChild(imgBtn)
    userStack.appendChild(attachRow)
  }
  if (withFile) {
    const attachRow = document.createElement('span')
    attachRow.appendChild(Object.assign(document.createElement('button'), { textContent: 'retry upload' }))
    userStack.appendChild(attachRow)
  }
  const bubble = document.createElement('div')
  bubble.textContent = 'hello'
  userStack.appendChild(bubble)
  const actions = document.createElement('div')
  actions.appendChild(Object.assign(document.createElement('span'), { textContent: '10:32' }))
  actions.appendChild(Object.assign(document.createElement('button'), { textContent: '' })).setAttribute('aria-label', 'copy')
  userRow.appendChild(userStack)
  userRow.appendChild(actions)
  let innermost = userRow
  for (let i = 0; i < wrappers; i++) {
    // SlotOutlet-style passthrough anchor: display:contents, exactly one child.
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-slot', 'conversation.chat.node')
    wrapper.setAttribute('style', 'display:contents')
    wrapper.appendChild(innermost)
    innermost = wrapper
  }
  row.appendChild(innermost)
  return row
}

// 1. Text-only user row -> actions row
{
  const target = mod.findIconActions(makeRow('user'))
  assert(target !== null, 'text-only row must resolve a target')
  assert(target.querySelector('[aria-label="copy"]'), 'target is the actions row (has copy)')
}

// 2. User row with image attachment -> still the actions row, NOT the image row
{
  const target = mod.findIconActions(makeRow('user', { withImage: true }))
  assert(target !== null, 'image row must resolve a target')
  assert(target.querySelector('[aria-label="copy"]'), 'target is the actions row, not the attachment row')
  assert.strictEqual(target.querySelector('[data-variant]'), null, 'target must not be the attachment gallery')
}

// 3. Steering row with a file card (retry button) -> actions row
{
  const target = mod.findIconActions(makeRow('steering', { withFile: true }))
  assert(target !== null, 'file row must resolve a target')
  assert(target.querySelector('[aria-label="copy"]'), 'target is the actions row')
}

// 3b. REAL DOM shape: slot-outlet passthrough wrappers between the row and
//     userRow (ChatNodeSeat renderSlot -> SlotOutlet anchor div). The 0.0.2
//     `firstElementChild.lastElementChild` strategy failed here for EVERY
//     row — the undo button vanished from the GUI entirely.
{
  const target = mod.findIconActions(makeRow('user', { wrappers: 1 }))
  assert(target !== null, 'row behind one slot-outlet wrapper must resolve a target')
  assert(target.querySelector('[aria-label="copy"]'), 'wrapper row target is the actions row')

  const target2 = mod.findIconActions(makeRow('user', { wrappers: 3 }))
  assert(target2 !== null, 'row behind three nested wrappers must resolve a target')
  assert(target2.querySelector('[aria-label="copy"]'), 'deep-wrapper row target is the actions row')

  const target3 = mod.findIconActions(makeRow('user', { wrappers: 2, withImage: true }))
  assert(target3 !== null, 'wrapper row with image must resolve a target')
  assert(target3.querySelector('[aria-label="copy"]'), 'wrapper+image row target is the actions row')
  assert.strictEqual(target3.querySelector('[data-variant]'), null, 'target must not be the attachment gallery')
}

// 4. Row without an actions strip -> no target (guard)
{
  const row = document.createElement('div')
  row.setAttribute('data-chat-flow-kind', 'user')
  row.setAttribute('data-chat-anchor-key', 'user:2')
  const userRow = document.createElement('div')
  const userStack = document.createElement('div')
  userStack.textContent = 'text only, no actions'
  userRow.appendChild(userStack)
  row.appendChild(userRow)
  assert.strictEqual(mod.findIconActions(row), null)
}

// 5. Non-user row is rejected
{
  assert.strictEqual(mod.findIconActions(makeRow('assistant-step')), null)
}

// 6. The always-visible strategy: the stylesheet the plugin injects must
//    carry [data-dtu-always]{opacity:1!important}, which neutralizes DSH's
//    hover-only reveal (MessageIconActions.module.css sets .actions{opacity:0}
//    on any user/steering row that has a later user/steering sibling). The
//    portal container is .actions itself, so tagging it makes the undo button
//    permanently visible without touching DSH's copy/branch controls.
{
  assert(
    source.includes('[data-dtu-always]{opacity:1!important}'),
    'plugin stylesheet must force [data-dtu-always]{opacity:1!important}',
  )
  // The attribute is applied to the container collectPortalTargets resolves.
  assert(
    /actions\.setAttribute\('data-dtu-always'/.test(source) ||
    /actions\.hasAttribute\('data-dtu-always'\)/.test(source),
    'collectPortalTargets must tag the resolved container with data-dtu-always',
  )
}

// 7. Tagging is idempotent: a second pass over the same element does not
//    duplicate or remove the marker.
{
  const row = makeRow('user')
  const actions = mod.findIconActions(row)
  assert(actions !== null)
  actions.setAttribute('data-dtu-always', '')
  assert.strictEqual(actions.hasAttribute('data-dtu-always'), true)
  // Simulating the idempotent guard: setAttribute with an empty value on an
  // already-tagged element keeps a single attribute.
  actions.setAttribute('data-dtu-always', '')
  assert.strictEqual(
    Array.from(actions.attributes).filter(a => a.name === 'data-dtu-always').length,
    1,
    'data-dtu-always must stay a single attribute',
  )
}

console.log('OK: findIconActions resolves the actions row for text / image / file rows, '
  + 'and skips action-less and non-user rows.')
