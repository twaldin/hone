// Plausible naive controlled-input diagnostic.
// It supports a flat value/cursor pair, single-code-unit deletion, newline
// normalization, and submit/cancel.  Word/line navigation, history,
// completion, terminal escapes, and display wrapping are absent.
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
export class TextInput {
  constructor(opts = {}) {
    this.opts = opts
    this.value = opts.initialValue ?? ''
    this.cursorPos = this.value.length
    this.mode = opts.mode ?? 'single'
  }
  getValue() { return this.value }
  getCursor() { return this.cursorPos }
  getMode() { return this.mode }
  getCompletion() { return null }
  snapshot() { return { value: this.value, cursor: this.cursorPos, mode: this.mode, completion: null } }
  setValue(value, cursor) { this.value = value; this.cursorPos = clamp(cursor ?? value.length, 0, value.length); this.emitChange() }
  setCursor(cursor) { this.cursorPos = clamp(cursor, 0, this.value.length); this.emitChange() }
  clear() { this.setValue('') }
  insert(text) {
    if (!text) return
    text = this.mode === 'single' ? text.replace(/\r\n|\r|\n/g, ' ') : text.replace(/\r\n|\r/g, '\n')
    this.value = this.value.slice(0, this.cursorPos) + text + this.value.slice(this.cursorPos)
    this.cursorPos += text.length
    this.emitChange()
  }
  handleKey(key) {
    if (key === 'left') { this.cursorPos = clamp(this.cursorPos - 1, 0, this.value.length); this.emitChange(); return true }
    if (key === 'right') { this.cursorPos = clamp(this.cursorPos + 1, 0, this.value.length); this.emitChange(); return true }
    if (key === 'backspace') { this.deleteRange(this.cursorPos - 1, this.cursorPos); return true }
    if (key === 'delete') { this.deleteRange(this.cursorPos, this.cursorPos + 1); return true }
    if (key === 'shift-enter') { if (this.mode === 'multi') { this.insert('\n'); return true } return false }
    if (key === 'enter') { this.opts.onSubmit?.(this.value); return true }
    if (key === 'escape') { this.opts.onCancel?.(); return true }
    return false
  }
  async requestCompletion() {}
  closeCompletion() {}
  deleteRange(from, to) {
    const a = clamp(Math.min(from, to), 0, this.value.length)
    const b = clamp(Math.max(from, to), 0, this.value.length)
    if (a === b) return
    this.value = this.value.slice(0, a) + this.value.slice(b)
    this.cursorPos = a
    this.emitChange()
  }
  emitChange() { this.opts.onChange?.(this.snapshot()) }
}
export function parseRawKey() { return null }
export function wordBoundaryLeft() { return 0 }
export function wordBoundaryRight() { return 0 }
export function lineStart() { return 0 }
export function lineEnd() { return 0 }
export function wrapForDisplay() { return { lines: [''], cursorRow: 0, cursorCol: 0 } }
