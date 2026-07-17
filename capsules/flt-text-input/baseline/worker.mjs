// PROTECTED capsule file — candidate-side case runner for the flt-textinput
// capsule. Spawned by the trusted evaluator (eval.py) as an unprivileged
// subprocess; imports the CANDIDATE text_input.mjs from $CAPSULE_WORKSPACE and
// drives it through scripted editing cases received as newline-delimited JSON
// on stdin. It returns only OBSERVED behavior (post-op state checkpoints);
// all expectations, comparison, and scoring live in the trusted parent.
//
// Protocol (one JSON object per line):
//   handshake ->  {"ready":true,"contract":{...}} | {"ready":false,"error":s}
//   request   ->  {"id":nonce,"case":{...}}
//   response  ->  {"id":nonce,"checkpoints":[...]} | {"id":nonce,"error":s}
//
// Case kinds:
//   widget: construct TextInput from `setup`, run `ops`, checkpoint after each.
//   parse:  each op {key, rawHex?} -> {result: parseRawKey(key, raw)}
//   wrap:   each op {text, width, cursor} -> {lines, cursorRow, cursorCol}
//   helper: each op {fn, args} -> {result} (allowlisted pure helpers)
//
// Hard bound: a single op that triggers more than MAX_EMITS_PER_OP onChange
// emissions aborts the case with an error (unbounded update work).

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'

const MAX_EMITS_PER_OP = 32
const HELPER_FNS = ['wordBoundaryLeft', 'wordBoundaryRight', 'lineStart', 'lineEnd']

const workspace = process.argv[2] ?? '/workspace'

function println(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

let mod
try {
  mod = await import(pathToFileURL(join(workspace, 'text_input.mjs')).href)
} catch (err) {
  println({ ready: false, error: `candidate import failed: ${String(err && err.message ? err.message : err)}` })
  process.exit(0)
}

const contract = {
  TextInput: typeof mod.TextInput === 'function',
  parseRawKey: typeof mod.parseRawKey === 'function',
  wrapForDisplay: typeof mod.wrapForDisplay === 'function',
  wordBoundaryLeft: typeof mod.wordBoundaryLeft === 'function',
  wordBoundaryRight: typeof mod.wordBoundaryRight === 'function',
  lineStart: typeof mod.lineStart === 'function',
  lineEnd: typeof mod.lineEnd === 'function',
}
println({ ready: true, contract })

function normCompletion(c) {
  if (!c || typeof c !== 'object') return null
  return {
    selectedIndex: c.selectedIndex,
    replaceFrom: c.replaceFrom,
    prefix: c.prefix,
    items: Array.isArray(c.items) ? c.items.map((it) => (it && typeof it === 'object' ? it.value : it)) : [],
  }
}

async function runWidgetCase(c) {
  const setup = c.setup ?? {}
  const submitted = []
  let cancels = 0
  let emitsThisOp = 0
  const entries = Array.isArray(setup.history) ? [...setup.history] : []
  const history = setup.history === undefined
    ? undefined
    : setup.historyPush
      ? { entries, push: (v) => { entries.push(v) } }
      : { entries }
  const completions = Array.isArray(setup.completions) ? setup.completions : []
  const complete = completions.length === 0
    ? undefined
    : (text, cursor) => {
        for (const entry of completions) {
          if (entry.value === text && entry.cursor === cursor) {
            return { items: entry.items.map((v) => ({ value: v })), replaceFrom: entry.replaceFrom }
          }
        }
        return { items: [], replaceFrom: cursor }
      }
  const ti = new mod.TextInput({
    mode: setup.mode ?? 'single',
    ...(setup.initialValue !== undefined ? { initialValue: setup.initialValue } : {}),
    ...(history !== undefined ? { history } : {}),
    ...(complete !== undefined ? { complete } : {}),
    onSubmit: (v) => { submitted.push(v) },
    onCancel: () => { cancels += 1 },
    onChange: () => {
      emitsThisOp += 1
      if (emitsThisOp > MAX_EMITS_PER_OP) throw new Error('unbounded onChange emissions')
    },
  })

  const checkpoints = []
  for (let i = 0; i < c.ops.length; i += 1) {
    const op = c.ops[i]
    emitsThisOp = 0
    let handled = null
    switch (op.op) {
      case 'key': handled = ti.handleKey(op.key); break
      case 'insert': ti.insert(op.text); break
      case 'setCursor': ti.setCursor(op.pos); break
      case 'setValue': ti.setValue(op.value, op.cursor); break
      case 'clear': ti.clear(); break
      case 'complete': await ti.requestCompletion(op.reverse === true); break
      default: throw new Error(`unknown op: ${String(op.op)}`)
    }
    checkpoints.push({
      value: ti.getValue(),
      cursor: ti.getCursor(),
      completion: normCompletion(ti.getCompletion()),
      handled,
      submitted: [...submitted],
      cancels,
      history: [...entries],
      emits: emitsThisOp,
    })
  }
  return checkpoints
}

function runParseCase(c) {
  return c.ops.map((op) => ({
    result: mod.parseRawKey(op.key, op.rawHex !== undefined ? Buffer.from(op.rawHex, 'hex') : undefined),
  }))
}

function runWrapCase(c) {
  return c.ops.map((op) => {
    const r = mod.wrapForDisplay(op.text, op.width, op.cursor)
    return { lines: r.lines, cursorRow: r.cursorRow, cursorCol: r.cursorCol }
  })
}

function runHelperCase(c) {
  return c.ops.map((op) => {
    if (!HELPER_FNS.includes(op.fn)) throw new Error(`helper not allowlisted: ${String(op.fn)}`)
    return { result: mod[op.fn](...op.args) }
  })
}

const rl = createInterface({ input: process.stdin, terminal: false })
for await (const line of rl) {
  if (!line.trim()) continue
  let request
  try {
    request = JSON.parse(line)
  } catch {
    println({ error: 'unparseable request' })
    continue
  }
  const id = request.id
  try {
    const c = request.case
    let checkpoints
    if (c.kind === 'widget') checkpoints = await runWidgetCase(c)
    else if (c.kind === 'parse') checkpoints = runParseCase(c)
    else if (c.kind === 'wrap') checkpoints = runWrapCase(c)
    else if (c.kind === 'helper') checkpoints = runHelperCase(c)
    else throw new Error(`unknown case kind: ${String(c.kind)}`)
    println({ id, checkpoints })
  } catch (err) {
    println({ id, error: String(err && err.message ? err.message : err) })
  }
}
