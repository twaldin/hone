// Trusted naive control: a deliberately narrow line-split/regex parser.
// It understands only one legacy shell step and performs no graph, gate,
// preset, error-localization, or field validation.

function unquote(value) {
  const text = value.trim()
  if (text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text) } catch { return text.slice(1, -1) }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1)
  return text
}

function projectObject(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.steps) || doc.steps.length !== 1) {
    throw new Error('naive parser supports one step')
  }
  const step = doc.steps[0]
  if (!step || typeof step.id !== 'string' || typeof step.run !== 'string') {
    throw new Error('naive parser requires id and run')
  }
  return {
    name: String(doc.name || ''),
    steps: [{
      id: step.id,
      run: step.run,
      ...(typeof step.on_complete === 'string' ? { on_complete: step.on_complete } : {}),
    }],
  }
}

export function parseWorkflowText(text) {
  if (typeof text !== 'string') throw new Error('naive parser expects text')
  if (text.trimStart().startsWith('{')) return projectObject(JSON.parse(text))
  const name = text.match(/^name:\s*(.+)$/m)?.[1]
  const id = text.match(/^\s*-\s*id:\s*(.+)$/m)?.[1]
  const run = text.match(/^\s+run:\s*(.+)$/m)?.[1]
  const onComplete = text.match(/^\s+on_complete:\s*(.+)$/m)?.[1]
  if (!name || !id || !run) throw new Error('naive parser requires name, id, and run lines')
  return projectObject({
    name: unquote(name),
    steps: [{
      id: unquote(id),
      run: unquote(run),
      ...(onComplete ? { on_complete: unquote(onComplete) } : {}),
    }],
  })
}
