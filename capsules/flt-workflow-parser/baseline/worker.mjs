#!/usr/bin/env node
import { readFileSync, writeSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

// --- Immutable primordials captured BEFORE any candidate code is imported. ---
// canonicalValue/canonicalJson, error shaping, and the response write use ONLY
// these local copies. The candidate module is loaded via dynamic import() below
// and can rebind global JSON.stringify, Object.keys, Array iteration, or the
// stdout write path, but those live references resolve against the mutated
// globals only if we read them lazily. By binding them here, up front, a
// candidate cannot install a call-count wrapper that returns the first canonical
// string for the second canonicalJson(reparsed) call (faking roundTripStable) or
// intercept the final emission. Every seam runs through captured primitives.
const _stringify = JSON.stringify
const _objectKeys = Object.keys
const _isArray = Array.isArray
const _numberIsInteger = Number.isInteger
const _mapCall = Function.prototype.call.bind(Array.prototype.map)
const _sortCall = Function.prototype.call.bind(Array.prototype.sort)
const _writeSync = writeSync

const MAX_REQUEST_BYTES = 512 * 1024

function canonicalValue(value) {
  if (_isArray(value)) return _mapCall(value, canonicalValue)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of _sortCall(_objectKeys(value))) {
      if (value[key] !== undefined) out[key] = canonicalValue(value[key])
    }
    return out
  }
  return value
}

function canonicalJson(value) {
  return _stringify(canonicalValue(value))
}

function errorShape(error) {
  const value = error instanceof Error ? error : new Error(String(error))
  let line = null
  let column = null
  if (_isArray(value.linePos) && value.linePos.length > 0) {
    const start = value.linePos[0]
    if (start && _numberIsInteger(start.line) && _numberIsInteger(start.col)) {
      line = start.line
      column = start.col
    }
  }
  return { name: value.name || 'Error', message: value.message, line, column }
}

async function main() {
  const bytes = readFileSync(0)
  if (bytes.length === 0 || bytes.length > MAX_REQUEST_BYTES) {
    throw new Error('invalid request size')
  }
  const request = JSON.parse(bytes.toString('utf8'))
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      typeof request.nonce !== 'string' || request.nonce.length < 16 ||
      typeof request.text !== 'string') {
    throw new Error('invalid request schema')
  }

  const workspace = process.env.CAPSULE_WORKSPACE || '/workspace'
  const moduleUrl = pathToFileURL(resolve(workspace, 'src/workflow/parser.mjs')).href
  let result
  try {
    const candidate = await import(moduleUrl)
    if (typeof candidate.parseWorkflowText !== 'function') {
      throw new Error('Candidate parser must export parseWorkflowText(text)')
    }
    const ast = candidate.parseWorkflowText(request.text)
    const projected = canonicalValue(ast)
    const canonical = canonicalJson(projected)
    const reparsed = canonicalValue(candidate.parseWorkflowText(canonical))
    result = {
      ok: true,
      ast: projected,
      canonical,
      roundTripStable: canonicalJson(reparsed) === canonical,
    }
  } catch (error) {
    result = { ok: false, error: errorShape(error) }
  }
  _writeSync(1, `${_stringify({ nonce: request.nonce, result })}\n`)
}

main().catch(error => {
  try {
    _writeSync(2, `${error instanceof Error ? error.message : String(error)}\n`)
  } catch {
    // fd 2 unavailable; nothing further to report.
  }
  process.exitCode = 1
})
