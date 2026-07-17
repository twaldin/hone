// Historical partial seed for the FLT TextInput capsule.
//
// The parent of the shared-widget introduction (FLT a5b07aa0) edited the
// command buffer with appendCommandText/backspaceCommand: insertion appended
// to the buffer and Backspace removed its final UTF-16 code unit.  This honest
// adapter preserves that historical editing behavior behind the later
// TextInput API.  The pure display/key helpers are carried from the pinned
// target so the search is narrowly the state machine, not environment setup.
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
  setValue(value, cursor) {
    this.value = value
    this.cursorPos = Math.max(0, Math.min(value.length, cursor ?? value.length))
    this.emitChange()
  }
  setCursor(cursor) {
    this.cursorPos = Math.max(0, Math.min(this.value.length, cursor))
    this.emitChange()
  }
  clear() { this.setValue('') }
  insert(text) {
    if (!text) return
    this.value += text
    this.cursorPos = this.value.length
    this.emitChange()
  }
  handleKey(key) {
    if (key === 'backspace') {
      if (!this.value) return true
      this.value = this.value.slice(0, -1)
      this.cursorPos = this.value.length
      this.emitChange()
      return true
    }
    if (key === 'enter') {
      this.opts.onSubmit?.(this.value)
      return true
    }
    if (key === 'escape') {
      this.opts.onCancel?.()
      return true
    }
    return false
  }
  async requestCompletion() {}
  closeCompletion() {}
  emitChange() { this.opts.onChange?.(this.snapshot()) }
}

// ── helpers ──
function clamp(n, lo, hi) {
    if (hi < lo)
        return lo;
    return Math.max(lo, Math.min(hi, n));
}
const WORD_RE = /[A-Za-z0-9_]/;
function isWordChar(ch) {
    return !!ch && WORD_RE.test(ch);
}
export function wordBoundaryLeft(text, pos) {
    let i = pos;
    // Skip non-word chars left.
    while (i > 0 && !isWordChar(text[i - 1]))
        i -= 1;
    // Skip word chars left.
    while (i > 0 && isWordChar(text[i - 1]))
        i -= 1;
    return i;
}
export function wordBoundaryRight(text, pos) {
    let i = pos;
    while (i < text.length && !isWordChar(text[i]))
        i += 1;
    while (i < text.length && isWordChar(text[i]))
        i += 1;
    return i;
}
export function lineStart(text, pos) {
    const idx = text.lastIndexOf('\n', pos - 1);
    return idx === -1 ? 0 : idx + 1;
}
export function lineEnd(text, pos) {
    const idx = text.indexOf('\n', pos);
    return idx === -1 ? text.length : idx;
}
// ── escape-sequence to Key mapping ──
//
// The TUI's RawKeyParser already classifies common keys, but several Mac-native
// chords arrive as raw escape sequences that vary between terminals. This map
// is consulted by the use site to translate parser output into widget keys.
//
// `parseRawKey` accepts:
//   - keys already classified by RawKeyParser (e.g. 'left', 'alt-backspace')
//   - raw escape sequences that the parser passed through (e.g. ESC b)
//
// Returns null if the key isn't a TextInput key. Callers should treat null as
// "not for me, do something else".
export function parseRawKey(key, raw) {
    switch (key) {
        case 'left': return 'left';
        case 'right': return 'right';
        case 'up': return 'up';
        case 'down': return 'down';
        case 'enter': return 'enter';
        case 'shift-enter': return 'shift-enter';
        case 'tab': return 'tab';
        case 'shift-tab': return 'shift-tab';
        case 'escape': return 'escape';
        case 'backspace': return 'backspace';
        case 'alt-backspace': return 'kill-word-back';
        case 'alt-d': return 'kill-word-fwd';
        case 'ctrl-u': return 'kill-line-back';
        case 'ctrl-k': return 'kill-line-fwd';
        case 'ctrl-w': return 'kill-word-back';
        case 'ctrl-a': return 'line-start';
        case 'ctrl-e': return 'line-end';
        case 'ctrl-j': return 'shift-enter';
        case 'home': return 'home';
        case 'end': return 'end';
        case 'word-left': return 'word-left';
        case 'word-right': return 'word-right';
        case 'cmd-backspace': return 'kill-line-back';
        case 'delete': return 'delete';
    }
    if (raw) {
        const text = raw.toString('utf8');
        // Opt+f / Opt+b → ESC f / ESC b
        if (text === '\x1bf')
            return 'word-right';
        if (text === '\x1bb')
            return 'word-left';
        // Modifier-aware arrows: ESC[1;3D/C (alt) and ESC[1;9D/C (some Macs)
        if (/^\x1b\[1;[35]D$/.test(text))
            return 'word-left';
        if (/^\x1b\[1;[35]C$/.test(text))
            return 'word-right';
        if (/^\x1b\[1;9D$/.test(text))
            return 'word-left';
        if (/^\x1b\[1;9C$/.test(text))
            return 'word-right';
        // Home/End variants
        if (text === '\x1b[H' || text === '\x1bOH' || text === '\x1b[1~')
            return 'home';
        if (text === '\x1b[F' || text === '\x1bOF' || text === '\x1b[4~')
            return 'end';
        // Delete
        if (text === '\x1b[3~')
            return 'delete';
        // Ctrl+Backspace in some terminals: \b (0x08)
        if (text === '\b')
            return 'kill-word-back';
    }
    return null;
}
export function wrapForDisplay(text, width, cursor) {
    if (width <= 0) {
        return { lines: [text], cursorRow: 0, cursorCol: 0 };
    }
    const lines = [];
    let cursorRow = 0;
    let cursorCol = 0;
    let charIdx = 0;
    const hardLines = text.split('\n');
    for (let li = 0; li < hardLines.length; li += 1) {
        const ln = hardLines[li];
        if (ln.length === 0) {
            if (cursor === charIdx) {
                cursorRow = lines.length;
                cursorCol = 0;
            }
            lines.push('');
        }
        else {
            let i = 0;
            while (i < ln.length) {
                const slice = ln.slice(i, i + width);
                if (cursor >= charIdx + i && cursor <= charIdx + i + slice.length) {
                    cursorRow = lines.length;
                    cursorCol = cursor - (charIdx + i);
                    if (cursorCol > slice.length)
                        cursorCol = slice.length;
                }
                lines.push(slice);
                i += slice.length;
                if (slice.length === 0)
                    break;
            }
        }
        charIdx += ln.length;
        // Account for the newline char between hard lines.
        if (li < hardLines.length - 1) {
            if (cursor === charIdx) {
                cursorRow = lines.length - 1;
                cursorCol = lines[lines.length - 1].length;
            }
            charIdx += 1;
        }
    }
    if (cursor >= text.length) {
        const last = lines[lines.length - 1] ?? '';
        if (last.length >= width && width > 0) {
            // End cursor wraps to new visual row.
            lines.push('');
            cursorRow = lines.length - 1;
            cursorCol = 0;
        }
        else {
            cursorRow = lines.length - 1;
            cursorCol = last.length;
        }
    }
    return { lines, cursorRow, cursorCol };
}
