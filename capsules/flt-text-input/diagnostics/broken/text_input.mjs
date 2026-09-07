// Intentionally broken control: contract-shaped, behavior-free.
export class TextInput {
  constructor() { this.value = ''; this.cursor = 0 }
  getValue() { return this.value }
  getCursor() { return this.cursor }
  getMode() { return 'single' }
  getCompletion() { return null }
  setValue() {}
  setCursor() {}
  clear() {}
  insert() {}
  handleKey() { return false }
  async requestCompletion() {}
}
export function parseRawKey() { return null }
export function wordBoundaryLeft() { return 0 }
export function wordBoundaryRight() { return 0 }
export function lineStart() { return 0 }
export function lineEnd() { return 0 }
export function wrapForDisplay() { return { lines: [''], cursorRow: 0, cursorCol: 0 } }
