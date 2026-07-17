#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const MAX_REQUEST_BYTES = 512 * 1024

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = canonicalValue(value[key])
    }
    return out
  }
  return value
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value))
}

function errorShape(error) {
  const value = error instanceof Error ? error : new Error(String(error))
  let line = null
  let column = null
  if (Array.isArray(value.linePos) && value.linePos.length > 0) {
    const start = value.linePos[0]
    if (start && Number.isInteger(start.line) && Number.isInteger(start.col)) {
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
  process.stdout.write(`${JSON.stringify({ nonce: request.nonce, result })}\n`)
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
