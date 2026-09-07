// Preset registry — faithful ES-module port of the owner FLT source
// (src/presets.ts @ fe05463a921b9c4d808a338ea07d33abe45b6487), trimmed to the
// surface the workflow parser consumes: loadPresets/getPreset and their
// validation helpers. Behavior, error messages, and normalization are
// preserved verbatim; TypeScript type annotations are stripped. The dotenv /
// listPresets / addPreset command-surface helpers are omitted because the
// parser never calls them.
//
// The preset table is read from $HOME/.flt/presets.json on every lookup,
// exactly like the owner code. The trusted evaluator runs every candidate
// with a fresh throwaway HOME containing the sealed presets.json, so preset
// resolution is deterministic and offline.

import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

function home() {
  return process.env.HOME || homedir()
}

export function getPresetsDir() {
  return join(home(), '.flt')
}

export function getPresetsPath() {
  return join(getPresetsDir(), 'presets.json')
}

function isValidName(name) {
  return /^[a-zA-Z0-9_-]+$/.test(name)
}

function validatePresetName(name) {
  if (!isValidName(name)) {
    throw new Error('Preset name must be alphanumeric with dashes/underscores only.')
  }
}

function normalizeDescription(description) {
  if (!description) return undefined
  const trimmed = description.trim()
  return trimmed ? trimmed : undefined
}

function validatePresetValue(name, value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid preset "${name}": expected an object.`)
  }

  const preset = value
  if (preset.cli !== undefined && (typeof preset.cli !== 'string' || !preset.cli.trim())) {
    throw new Error(`Invalid preset "${name}": "cli" must be a non-empty string when set.`)
  }
  if (preset.model !== undefined && (typeof preset.model !== 'string' || !preset.model.trim())) {
    throw new Error(`Invalid preset "${name}": "model" must be a non-empty string when set.`)
  }
  if (preset.description !== undefined && typeof preset.description !== 'string') {
    throw new Error(`Invalid preset "${name}": "description" must be a string.`)
  }
  if (preset.soul !== undefined && typeof preset.soul !== 'string') {
    throw new Error(`Invalid preset "${name}": "soul" must be a string path.`)
  }
  if (preset.dir !== undefined && typeof preset.dir !== 'string') {
    throw new Error(`Invalid preset "${name}": "dir" must be a string path.`)
  }
  if (preset.parent !== undefined && typeof preset.parent !== 'string') {
    throw new Error(`Invalid preset "${name}": "parent" must be a string.`)
  }
  if (preset.worktree !== undefined && typeof preset.worktree !== 'boolean') {
    throw new Error(`Invalid preset "${name}": "worktree" must be a boolean.`)
  }
  if (preset.worktree_base !== undefined && (typeof preset.worktree_base !== 'string' || !preset.worktree_base.trim())) {
    throw new Error(`Invalid preset "${name}": "worktree_base" must be a non-empty string.`)
  }
  if (preset.worktree_branch_prefix !== undefined && (typeof preset.worktree_branch_prefix !== 'string' || !preset.worktree_branch_prefix.trim())) {
    throw new Error(`Invalid preset "${name}": "worktree_branch_prefix" must be a non-empty string.`)
  }
  if (preset.persistent !== undefined && typeof preset.persistent !== 'boolean') {
    throw new Error(`Invalid preset "${name}": "persistent" must be a boolean.`)
  }
  if (preset.pr_adapter !== undefined && preset.pr_adapter !== 'gh' && preset.pr_adapter !== 'gt' && preset.pr_adapter !== 'manual') {
    throw new Error(`Invalid preset "${name}": "pr_adapter" must be one of: gh, gt, manual`)
  }
  let envNormalized
  if (preset.skills !== undefined) {
    if (!Array.isArray(preset.skills) || preset.skills.some(v => typeof v !== 'string' || !v.trim())) {
      throw new Error(`Invalid preset "${name}": "skills" must be an array of non-empty strings.`)
    }
  }
  if (preset.allSkills !== undefined && typeof preset.allSkills !== 'boolean') {
    throw new Error(`Invalid preset "${name}": "allSkills" must be a boolean.`)
  }

  if (preset.env !== undefined) {
    if (typeof preset.env !== 'object' || preset.env === null || Array.isArray(preset.env)) {
      throw new Error(`Invalid preset "${name}": "env" must be an object mapping string to string.`)
    }
    const entries = {}
    for (const [k, v] of Object.entries(preset.env)) {
      if (typeof v !== 'string') {
        throw new Error(`Invalid preset "${name}": env["${k}"] must be a string.`)
      }
      entries[k] = v
    }
    envNormalized = Object.keys(entries).length > 0 ? entries : undefined
  }

  if (preset.pr_title_template !== undefined && typeof preset.pr_title_template !== 'string') {
    throw new Error(`Invalid preset "${name}": "pr_title_template" must be a string.`)
  }
  if (preset.pr_branch_prefix !== undefined && typeof preset.pr_branch_prefix !== 'string') {
    throw new Error(`Invalid preset "${name}": "pr_branch_prefix" must be a string.`)
  }
  if (preset.pr_base_branch !== undefined && typeof preset.pr_base_branch !== 'string') {
    throw new Error(`Invalid preset "${name}": "pr_base_branch" must be a string.`)
  }
  if (preset.pr_reviewers !== undefined) {
    if (!Array.isArray(preset.pr_reviewers) || preset.pr_reviewers.some(v => typeof v !== 'string' || !String(v).trim())) {
      throw new Error(`Invalid preset "${name}": "pr_reviewers" must be an array of non-empty strings.`)
    }
  }
  if (preset.pr_labels !== undefined) {
    if (!Array.isArray(preset.pr_labels) || preset.pr_labels.some(v => typeof v !== 'string' || !String(v).trim())) {
      throw new Error(`Invalid preset "${name}": "pr_labels" must be an array of non-empty strings.`)
    }
  }
  if (preset.pr_body_template !== undefined && typeof preset.pr_body_template !== 'string') {
    throw new Error(`Invalid preset "${name}": "pr_body_template" must be a string.`)
  }
  if (preset.git_hooks !== undefined && typeof preset.git_hooks !== 'boolean') {
    throw new Error(`Invalid preset "${name}": "git_hooks" must be a boolean.`)
  }

  const prReviewers = Array.isArray(preset.pr_reviewers)
    ? preset.pr_reviewers.map(v => String(v).trim()).filter(Boolean)
    : undefined
  const prLabels = Array.isArray(preset.pr_labels)
    ? preset.pr_labels.map(v => String(v).trim()).filter(Boolean)
    : undefined

  return {
    cli: typeof preset.cli === 'string' ? preset.cli.trim() || undefined : undefined,
    model: typeof preset.model === 'string' ? preset.model.trim() || undefined : undefined,
    description: normalizeDescription(preset.description),
    soul: typeof preset.soul === 'string' ? preset.soul.trim() || undefined : undefined,
    dir: typeof preset.dir === 'string' ? preset.dir.trim() || undefined : undefined,
    parent: typeof preset.parent === 'string' ? preset.parent.trim() || undefined : undefined,
    worktree: typeof preset.worktree === 'boolean' ? preset.worktree : undefined,
    worktree_base: typeof preset.worktree_base === 'string' ? preset.worktree_base.trim() || undefined : undefined,
    worktree_branch_prefix: typeof preset.worktree_branch_prefix === 'string' ? preset.worktree_branch_prefix.trim() || undefined : undefined,
    persistent: typeof preset.persistent === 'boolean' ? preset.persistent : undefined,
    pr_adapter: preset.pr_adapter === 'gh' || preset.pr_adapter === 'gt' || preset.pr_adapter === 'manual' ? preset.pr_adapter : undefined,
    skills: Array.isArray(preset.skills) ? preset.skills.map(v => String(v).trim()).filter(Boolean) : undefined,
    allSkills: typeof preset.allSkills === 'boolean' ? preset.allSkills : undefined,
    env: envNormalized,
    pr_title_template: typeof preset.pr_title_template === 'string' ? preset.pr_title_template.trim() || undefined : undefined,
    pr_branch_prefix: typeof preset.pr_branch_prefix === 'string' ? preset.pr_branch_prefix.trim() || undefined : undefined,
    pr_base_branch: typeof preset.pr_base_branch === 'string' ? preset.pr_base_branch.trim() || undefined : undefined,
    pr_reviewers: prReviewers && prReviewers.length > 0 ? prReviewers : undefined,
    pr_labels: prLabels && prLabels.length > 0 ? prLabels : undefined,
    pr_body_template: typeof preset.pr_body_template === 'string' ? preset.pr_body_template.trim() || undefined : undefined,
    git_hooks: typeof preset.git_hooks === 'boolean' ? preset.git_hooks : undefined,
  }
}

function sortPresetMap(presets) {
  const sorted = {}
  for (const name of Object.keys(presets).sort()) {
    sorted[name] = presets[name]
  }
  return sorted
}

const DEFAULT_PRESETS = {
  default: { cli: 'claude-code', model: 'sonnet', description: 'Default agent' },
}

export function loadPresets() {
  try {
    const raw = readFileSync(getPresetsPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Preset file must contain a JSON object.')
    }

    const loaded = {}
    for (const [name, value] of Object.entries(parsed)) {
      validatePresetName(name)
      loaded[name] = validatePresetValue(name, value)
    }

    if (Object.keys(loaded).length === 0) {
      savePresets(DEFAULT_PRESETS)
      return { ...DEFAULT_PRESETS }
    }

    return loaded
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      savePresets(DEFAULT_PRESETS)
      return { ...DEFAULT_PRESETS }
    }
    if (error instanceof Error) {
      throw new Error(`Failed to load presets from ${getPresetsPath()}: ${error.message}`)
    }
    throw error
  }
}

export function savePresets(presets) {
  const normalized = {}
  for (const [name, preset] of Object.entries(presets)) {
    validatePresetName(name)
    normalized[name] = validatePresetValue(name, preset)
  }

  mkdirSync(getPresetsDir(), { recursive: true })
  writeFileSync(getPresetsPath(), JSON.stringify(sortPresetMap(normalized), null, 2) + '\n')
}

export function getPreset(name) {
  validatePresetName(name)
  const presets = loadPresets()
  return presets[name]
}
