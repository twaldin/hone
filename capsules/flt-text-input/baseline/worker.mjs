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
// redefine `JSON.stringify`/`JSON.parse`, or patch `process.stdout` and the
// readline machinery. The whole record-and-report path is therefore built to
// be independent of every candidate-mutable seam:
//   * The ENTIRE request stream is drained from fd 0 and parsed BEFORE any
//     candidate code runs (the trusted parent writes the request and closes
//     stdin immediately, so this cannot block). No readline / stream / parser
//     machinery is consulted after the candidate is loaded.
//   * Every primordial the reporting path needs (JSON.stringify, Object.keys,
//     Object.create, Array.isArray, Reflect.apply, Buffer.from, process.exit)
//     is captured into a local const before the candidate import. `writeSync`
//     is an ESM live binding, so its VALUE is copied into `S_writeSync` before
//     import too — a later `syncBuiltinESMExports()` export rebind cannot then
//     redirect the emission path.
//   * Trusted code NEVER calls a prototype-resolved array method after the
//     import: every trusted-built list is a null-prototype array (created via
//     the captured Object.create) filled by index assignment, so replacing
//     Array.prototype.push/map/includes or defining numeric accessors on
//     Array.prototype cannot observe or rewrite the recorded sequence.
//   * Serialization uses a hand-rolled encoder that NEVER consults `toJSON`
//     and reads only own enumerable keys; bytes go out through the captured
//     `fs.writeSync`. Candidate-derived values are deep-cloned into
//     null-prototype structures (rejecting malformed records) before encoding.
//   * The bounded-emission counter lives in this trusted closure, unreachable
//     by the candidate, so a truthful `emits` value always reaches the parent
//     gate. The parent additionally rejects any output that is not exactly the
//     two protocol lines, so direct fd-1 writes by the candidate self-destruct.

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFileSync, writeSync } from 'node:fs'

// --- Primordials captured before ANY candidate code runs. ---
const S_stringify = JSON.stringify
const S_isArray = Array.isArray
const S_ObjKeys = Object.keys
const S_ObjCreate = Object.create
const S_numIsFinite = Number.isFinite
const S_String = String
const S_BufferFrom = Buffer.from.bind(Buffer)
const S_apply = Reflect.apply
const S_exit = process.exit.bind(process)
const S_setProto = Object.setPrototypeOf
// writeSync is an ESM live import binding: a candidate on Node 18 can replace
// the node:fs `writeSync` export and call `syncBuiltinESMExports()` to rebind
// it, which would update the imported name AFTER this module loads and let it
// interpose on the handshake/response bytes (nonce, sealed counters). Copy the
// function VALUE into a local const now, before any candidate code runs, so the
// recording path calls the original regardless of any later export rebinding.
const S_writeSync = writeSync

const MAX_EMITS_PER_OP = 32
// Null-prototype allowlist: membership test is an own-key read, never a
// (candidate-replaceable) Array.prototype.includes call.
const HELPER_FNS = S_ObjCreate(null)
HELPER_FNS.wordBoundaryLeft = true
HELPER_FNS.wordBoundaryRight = true
HELPER_FNS.lineStart = true
HELPER_FNS.lineEnd = true
const MAX_SANITIZE_DEPTH = 16

const workspace = process.argv[2] ?? '/workspace'

class MalformedRecord extends Error {}

// Fresh trusted list: a null-prototype array. Array.isArray still recognizes
// it, but index assignment can never hit an accessor planted on
// Array.prototype/Object.prototype (the prototype chain is empty), and no
// prototype method (push/map/...) is ever invoked on it.
function newList() {
  const list = []
  S_setProto(list, null)
  return list
}

// --- Request intake: drain and parse ALL of stdin BEFORE the candidate can
// run. eval.py writes the single request line and closes stdin right away
// (proc.communicate), so this read completes immediately and the candidate
// never gets a chance to observe or interpose on the request channel.
const requests = newList()
{
  const lines = readFileSync(0, 'utf8').split('\n')
  let n = 0
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim()) continue
    let entry
    try {
      entry = { unparseable: false, request: JSON.parse(line) }
    } catch {
      entry = { unparseable: true, request: null }
    }
    requests[n] = entry
    n += 1
  }
}

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
  S_writeSync(1, S_BufferFrom(text, 'utf8'))
}

function println(obj) {
  writeOut(encode(obj) + '\n')
}

// Deep-clone a candidate-derived value into a prototype-independent JSON-safe
// structure (null-prototype records, null-prototype arrays). Rejects anything
// the protocol never carries (functions, symbols, bigints, cyclic/over-deep
// graphs) as a malformed record.
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
      const out = newList()
      for (let i = 0; i < value.length; i += 1) out[i] = sanitize(value[i], d + 1)
      return out
    }
    const clean = S_ObjCreate(null)
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
  S_exit(0)
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
  const items = newList()
  if (S_isArray(c.items)) {
    for (let i = 0; i < c.items.length; i += 1) {
      const it = c.items[i]
      items[i] = it && typeof it === 'object' ? it.value : it
    }
  }
  return {
    selectedIndex: c.selectedIndex,
    replaceFrom: c.replaceFrom,
    prefix: c.prefix,
    items,
  }
}

// Build a trusted, prototype-independent checkpoint. Scalars the trusted runner
// owns (`emits`, `cancels`) are enforced numeric; candidate-observed values are
// sanitized. The record has a null prototype and only these keys.
function makeCheckpoint(fields) {
  const cp = S_ObjCreate(null)
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
  // Trusted recording lists are null-prototype: candidate-replaced
  // Array.prototype methods can neither observe them nor capture references.
  const submitted = newList()
  let cancels = 0
  let emitsThisOp = 0
  // `entries` is candidate-facing contract state (the widget may read and,
  // via history.push, append to it), so it stays an ordinary array; its
  // integrity is enforced by the sealed-oracle comparison, and sanitize()
  // snapshots its own indices at every checkpoint. Copied without the
  // (candidate-patchable) array iterator.
  const src = S_isArray(setup.history) ? setup.history : []
  const entries = []
  for (let i = 0; i < src.length; i += 1) entries[i] = src[i]
  const history = setup.history === undefined
    ? undefined
    : setup.historyPush
      ? { entries, push: (v) => { entries[entries.length] = v } }
      : { entries }
  const completions = S_isArray(setup.completions) ? setup.completions : []
  const complete = completions.length === 0
    ? undefined
    : (text, cursor) => {
        for (let i = 0; i < completions.length; i += 1) {
          const entry = completions[i]
          if (entry.value === text && entry.cursor === cursor) {
            const items = []
            for (let j = 0; j < entry.items.length; j += 1) items[j] = { value: entry.items[j] }
            return { items, replaceFrom: entry.replaceFrom }
          }
        }
        return { items: [], replaceFrom: cursor }
      }
  const ti = new mod.TextInput({
    mode: setup.mode ?? 'single',
    ...(setup.initialValue !== undefined ? { initialValue: setup.initialValue } : {}),
    ...(history !== undefined ? { history } : {}),
    ...(complete !== undefined ? { complete } : {}),
    onSubmit: (v) => { submitted[submitted.length] = v },
    onCancel: () => { cancels += 1 },
    onChange: () => {
      emitsThisOp += 1
      if (emitsThisOp > MAX_EMITS_PER_OP) throw new Error('unbounded onChange emissions')
    },
  })

  const checkpoints = newList()
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
    checkpoints[i] = makeCheckpoint({
      value: ti.getValue(),
      cursor: ti.getCursor(),
      completion: normCompletion(ti.getCompletion()),
      handled,
      submitted,
      cancels,
      history: entries,
      emits: emitsThisOp,
    })
  }
  return checkpoints
}

function runParseCase(c) {
  const out = newList()
  for (let i = 0; i < c.ops.length; i += 1) {
    const op = c.ops[i]
    out[i] = {
      result: mod.parseRawKey(op.key, op.rawHex !== undefined ? S_BufferFrom(op.rawHex, 'hex') : undefined),
    }
  }
  return out
}

function runWrapCase(c) {
  const out = newList()
  for (let i = 0; i < c.ops.length; i += 1) {
    const op = c.ops[i]
    const r = mod.wrapForDisplay(op.text, op.width, op.cursor)
    out[i] = { lines: r.lines, cursorRow: r.cursorRow, cursorCol: r.cursorCol }
  }
  return out
}

function runHelperCase(c) {
  const out = newList()
  for (let i = 0; i < c.ops.length; i += 1) {
    const op = c.ops[i]
    if (HELPER_FNS[op.fn] !== true) throw new Error(`helper not allowlisted: ${S_String(op.fn)}`)
    out[i] = { result: S_apply(mod[op.fn], mod, op.args) }
  }
  return out
}

for (let r = 0; r < requests.length; r += 1) {
  const entry = requests[r]
  if (entry.unparseable) {
    println({ error: 'unparseable request' })
    continue
  }
  const request = entry.request
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
