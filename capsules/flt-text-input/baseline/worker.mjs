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
//
// GAMING-RESISTANCE: the candidate module is imported into this same realm, so
// it can freely mutate global prototypes (Object/Array/Number.prototype),
// redefine `JSON.stringify`, or patch `process.stdout`. Result serialization
// MUST therefore be independent of every candidate-mutable path. Before the
// candidate is imported we capture the primordials we need, we serialize with a
// hand-rolled encoder that NEVER consults `toJSON` and reads only own
// enumerable keys, we write bytes through a captured `fs.writeSync`, and we
// sanitize every candidate-derived value (rejecting malformed records). The
// bounded-emission counter lives in this trusted closure, unreachable by the
// candidate, so a truthful `emits` value always reaches the parent gate.

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { writeSync } from 'node:fs'

// --- Primordials captured before ANY candidate code runs. ---
const S_stringify = JSON.stringify
const S_isArray = Array.isArray
const S_ObjKeys = Object.keys
const S_numIsFinite = Number.isFinite
const S_String = String
const S_BufferFrom = Buffer.from.bind(Buffer)

const MAX_EMITS_PER_OP = 32
const HELPER_FNS = ['wordBoundaryLeft', 'wordBoundaryRight', 'lineStart', 'lineEnd']
const MAX_SANITIZE_DEPTH = 16

const workspace = process.argv[2] ?? '/workspace'

class MalformedRecord extends Error {}

// Trusted JSON encoder. Emits only plain JSON structure and never invokes a
// (candidate-pollutable) `toJSON`; objects are walked via captured Object.keys
// so any inherited/prototype property is ignored. Primitives are encoded with
// the captured JSON.stringify — the JSON spec does not consult `toJSON` for
// string/number/boolean values, so that path is pollution-safe.
function encode(value) {
  if (value === undefined) return undefined
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return S_stringify(value)
  if (t === 'object') {
    if (S_isArray(value)) {
      let out = '['
      for (let i = 0; i < value.length; i += 1) {
        if (i > 0) out += ','
        const enc = encode(value[i])
        out += enc === undefined ? 'null' : enc
      }
      return out + ']'
    }
    const keys = S_ObjKeys(value)
    let out = '{'
    let first = true
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i]
      const enc = encode(value[k])
      if (enc === undefined) continue
      if (!first) out += ','
      first = false
      out += S_stringify(k) + ':' + enc
    }
    return out + '}'
  }
  return undefined
}

function writeOut(text) {
  writeSync(1, S_BufferFrom(text, 'utf8'))
}

function println(obj) {
  writeOut(encode(obj) + '\n')
}

// Deep-clone a candidate-derived value into a prototype-independent JSON-safe
// structure. Rejects anything the protocol never carries (functions, symbols,
// bigints, cyclic/over-deep graphs) as a malformed record.
function sanitize(value, depth) {
  const d = depth ?? 0
  if (d > MAX_SANITIZE_DEPTH) throw new MalformedRecord('record nesting too deep')
  if (value === null) return null
  const t = typeof value
  if (t === 'string' || t === 'boolean') return value
  if (t === 'number') return S_numIsFinite(value) ? value : null
  if (t === 'undefined') return undefined
  if (t === 'object') {
    if (S_isArray(value)) {
      const out = []
      for (let i = 0; i < value.length; i += 1) out[i] = sanitize(value[i], d + 1)
      return out
    }
    const clean = Object.create(null)
    const keys = S_ObjKeys(value)
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i]
      const sv = sanitize(value[k], d + 1)
      if (sv !== undefined) clean[k] = sv
    }
    return clean
  }
  throw new MalformedRecord(`unserializable ${t} in candidate record`)
}

function expectString(value) {
  if (typeof value !== 'string') throw new MalformedRecord('expected string field')
  return value
}

function expectNumber(value) {
  if (typeof value !== 'number' || !S_numIsFinite(value)) throw new MalformedRecord('expected finite number field')
  return value
}

function expectBoolOrNull(value) {
  if (value !== null && typeof value !== 'boolean') throw new MalformedRecord('expected boolean|null field')
  return value
}

let mod
try {
  mod = await import(pathToFileURL(join(workspace, 'text_input.mjs')).href)
} catch (err) {
  println({ ready: false, error: `candidate import failed: ${S_String(err && err.message ? err.message : err)}` })
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

// Build a trusted, prototype-independent checkpoint. Scalars the trusted runner
// owns (`emits`, `cancels`) are enforced numeric; candidate-observed values are
// sanitized. The record has a null prototype and only these keys.
function makeCheckpoint(fields) {
  const cp = Object.create(null)
  cp.value = expectString(fields.value)
  cp.cursor = expectNumber(fields.cursor)
  cp.completion = fields.completion === null ? null : sanitize(fields.completion)
  cp.handled = expectBoolOrNull(fields.handled)
  cp.submitted = sanitize(fields.submitted)
  cp.cancels = expectNumber(fields.cancels)
  cp.history = sanitize(fields.history)
  cp.emits = expectNumber(fields.emits)
  return cp
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
      default: throw new Error(`unknown op: ${S_String(op.op)}`)
    }
    checkpoints.push(makeCheckpoint({
      value: ti.getValue(),
      cursor: ti.getCursor(),
      completion: normCompletion(ti.getCompletion()),
      handled,
      submitted,
      cancels,
      history: entries,
      emits: emitsThisOp,
    }))
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
    if (!HELPER_FNS.includes(op.fn)) throw new Error(`helper not allowlisted: ${S_String(op.fn)}`)
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
    else throw new Error(`unknown case kind: ${S_String(c.kind)}`)
    // Final serialization guarantee: clone every checkpoint into a
    // prototype-independent structure (widget checkpoints are already trusted;
    // parse/wrap/helper results carry raw candidate return values).
    println({ id, checkpoints: sanitize(checkpoints) })
  } catch (err) {
    println({ id, error: S_String(err && err.message ? err.message : err) })
  }
}
