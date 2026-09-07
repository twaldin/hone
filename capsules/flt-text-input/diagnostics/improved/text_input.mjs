// Shared text-input widget for the TUI.
//
// Owns a text buffer + cursor and reacts to key events. Rendering is the
// caller's job — `render*()` helpers shape the buffer into displayable lines,
// but final placement on the cell grid happens at the use site.
//
// Modes: 'single' (one line, history nav on Up/Down) or 'multi' (newlines on
// Shift+Enter or Ctrl+J, plain Enter still commits — picked because that's the
// macOS Terminal / iTerm2 / Ghostty / Warp common denominator for chat-style
// inputs).
//
// Mac-native key bindings recognised:
//   Opt+Left / Opt+Right     → word jump (parses ESC b/f, ESC[1;3D/C, ESC[1;9D/C)
//   Cmd+Left / Cmd+Right     → line jump (Home/End — also ESC[H/F, ESC[1~/4~)
//   Cmd+Backspace            → kill to start of line
//   Opt+Backspace            → kill word
//   Ctrl+A / Ctrl+E          → line start / end
//   Ctrl+W                   → kill word backwards
//   Ctrl+U / Ctrl+K          → kill to start / end of line
//
// History (single-line only) is pluggable: the caller passes in/out a string[]
// and the widget tracks an index. Up/Down recall, Esc/Enter resets.
//
// Tab completion is pluggable: the caller passes a `complete(prefix, position)`
// callback which returns candidate completions. The widget owns the popup
// state (items + selected index); the caller renders it.
export class TextInput {
    value;
    cursorPos;
    mode;
    historyStore;
    historyIndex;
    /** Buffer that was being edited before the user started navigating history. */
    historyDraft;
    completer;
    completion;
    opts;
    constructor(opts = {}) {
        this.value = opts.initialValue ?? '';
        this.cursorPos = this.value.length;
        this.mode = opts.mode ?? 'single';
        this.historyStore = opts.history ?? null;
        this.historyIndex = -1;
        this.historyDraft = null;
        this.completer = opts.complete ?? null;
        this.completion = null;
        this.opts = opts;
    }
    // ── public read API ──
    getValue() { return this.value; }
    getCursor() { return this.cursorPos; }
    getMode() { return this.mode; }
    getCompletion() { return this.completion; }
    snapshot() {
        return {
            value: this.value,
            cursor: this.cursorPos,
            mode: this.mode,
            completion: this.completion ? { ...this.completion, items: [...this.completion.items] } : null,
        };
    }
    // ── public write API ──
    setValue(value, cursor) {
        this.value = value;
        this.cursorPos = clamp(cursor ?? value.length, 0, value.length);
        this.completion = null;
        this.historyIndex = -1;
        this.historyDraft = null;
        this.emitChange();
    }
    setCursor(cursor) {
        this.cursorPos = clamp(cursor, 0, this.value.length);
        this.emitChange();
    }
    clear() {
        this.setValue('');
    }
    insert(text) {
        if (!text)
            return;
        if (this.mode === 'single') {
            // Strip newlines; convert to space so pasted multiline becomes one line.
            text = text.replace(/\r\n|\r|\n/g, ' ');
        }
        else {
            text = text.replace(/\r\n|\r/g, '\n');
        }
        const before = this.value.slice(0, this.cursorPos);
        const after = this.value.slice(this.cursorPos);
        this.value = before + text + after;
        this.cursorPos += text.length;
        this.completion = null;
        this.historyIndex = -1;
        this.historyDraft = null;
        this.emitChange();
    }
    // ── key handler ──
    //
    // Returns true if the key was consumed. Returning false lets the caller fall
    // back to its own handler (e.g. command-mode keybinds).
    handleKey(key) {
        // Completion popup is open: arrow/tab/enter/esc bind differently.
        if (this.completion && this.completion.items.length > 0) {
            if (key === 'tab' || key === 'complete' || key === 'down') {
                this.cycleCompletion(1);
                return true;
            }
            if (key === 'shift-tab' || key === 'complete-reverse' || key === 'up') {
                this.cycleCompletion(-1);
                return true;
            }
            if (key === 'enter' || key === 'complete-confirm') {
                this.applyCompletion();
                return true;
            }
            if (key === 'escape' || key === 'complete-cancel') {
                this.completion = null;
                this.emitChange();
                return true;
            }
            // Any other key closes the popup; fall through to the normal handler so
            // the keystroke takes effect (e.g. Backspace shrinks the buffer).
            this.completion = null;
            this.emitChange();
        }
        switch (key) {
            case 'left':
                this.moveCursor(-1);
                return true;
            case 'right':
                this.moveCursor(1);
                return true;
            case 'word-left':
                this.cursorPos = wordBoundaryLeft(this.value, this.cursorPos);
                this.emitChange();
                return true;
            case 'word-right':
                this.cursorPos = wordBoundaryRight(this.value, this.cursorPos);
                this.emitChange();
                return true;
            case 'home':
            case 'line-start':
                this.cursorPos = lineStart(this.value, this.cursorPos);
                this.emitChange();
                return true;
            case 'end':
            case 'line-end':
                this.cursorPos = lineEnd(this.value, this.cursorPos);
                this.emitChange();
                return true;
            case 'backspace':
                this.deleteRange(this.cursorPos - 1, this.cursorPos);
                return true;
            case 'delete':
                this.deleteRange(this.cursorPos, this.cursorPos + 1);
                return true;
            case 'kill-line-back':
                this.deleteRange(lineStart(this.value, this.cursorPos), this.cursorPos);
                return true;
            case 'kill-line-fwd': {
                const end = lineEnd(this.value, this.cursorPos);
                // Ctrl+K on an empty line eats the newline ahead; matches readline.
                if (end === this.cursorPos && end < this.value.length && this.value[end] === '\n') {
                    this.deleteRange(this.cursorPos, this.cursorPos + 1);
                }
                else {
                    this.deleteRange(this.cursorPos, end);
                }
                return true;
            }
            case 'kill-word-back':
                this.deleteRange(wordBoundaryLeft(this.value, this.cursorPos), this.cursorPos);
                return true;
            case 'kill-word-fwd':
                this.deleteRange(this.cursorPos, wordBoundaryRight(this.value, this.cursorPos));
                return true;
            case 'up':
                if (this.mode === 'multi') {
                    const moved = this.moveCursorVertical(-1);
                    if (moved)
                        return true;
                }
                return this.recallHistory(-1);
            case 'down':
                if (this.mode === 'multi') {
                    const moved = this.moveCursorVertical(1);
                    if (moved)
                        return true;
                }
                return this.recallHistory(1);
            case 'history-prev': return this.recallHistory(-1);
            case 'history-next': return this.recallHistory(1);
            case 'shift-enter':
                if (this.mode === 'multi') {
                    this.insert('\n');
                    return true;
                }
                return false;
            case 'enter':
                if (this.mode === 'single') {
                    this.commit();
                    return true;
                }
                // multi-line: plain Enter commits.
                this.commit();
                return true;
            case 'tab':
            case 'complete':
                void this.requestCompletion(false);
                return true;
            case 'shift-tab':
            case 'complete-reverse':
                void this.requestCompletion(true);
                return true;
            case 'escape':
            case 'complete-cancel':
                if (this.opts.onCancel)
                    this.opts.onCancel();
                return true;
        }
        return false;
    }
    // ── completion ──
    /** Force-open the completion popup. Useful for caller-driven Tab handling. */
    async requestCompletion(reverse = false) {
        if (!this.completer)
            return;
        const result = await this.completer(this.value, this.cursorPos);
        if (!result || result.items.length === 0) {
            this.completion = null;
            this.emitChange();
            return;
        }
        const prefix = this.value.slice(result.replaceFrom, this.cursorPos);
        if (result.items.length === 1) {
            // Auto-apply if there's only one candidate.
            this.applyCompletionEntry(result.items[0], result.replaceFrom);
            return;
        }
        this.completion = {
            items: result.items,
            selectedIndex: reverse ? result.items.length - 1 : 0,
            replaceFrom: result.replaceFrom,
            prefix,
        };
        this.emitChange();
    }
    cycleCompletion(delta) {
        if (!this.completion)
            return;
        const len = this.completion.items.length;
        if (len === 0)
            return;
        this.completion.selectedIndex = ((this.completion.selectedIndex + delta) % len + len) % len;
        this.emitChange();
    }
    applyCompletion() {
        if (!this.completion)
            return;
        const item = this.completion.items[this.completion.selectedIndex];
        if (!item)
            return;
        this.applyCompletionEntry(item, this.completion.replaceFrom);
    }
    closeCompletion() {
        if (!this.completion)
            return;
        this.completion = null;
        this.emitChange();
    }
    applyCompletionEntry(entry, replaceFrom) {
        const before = this.value.slice(0, replaceFrom);
        const after = this.value.slice(this.cursorPos);
        this.value = before + entry.value + after;
        this.cursorPos = before.length + entry.value.length;
        this.completion = null;
        this.historyIndex = -1;
        this.historyDraft = null;
        this.emitChange();
    }
    // ── history ──
    /** Pull `delta` (-1 = older, +1 = newer) from the history store into the buffer. */
    recallHistory(delta) {
        if (!this.historyStore)
            return false;
        const entries = this.historyStore.entries;
        if (entries.length === 0)
            return false;
        if (this.historyIndex === -1) {
            this.historyDraft = this.value;
            this.historyIndex = entries.length;
        }
        let next = this.historyIndex + delta;
        next = clamp(next, 0, entries.length);
        if (next === this.historyIndex)
            return true;
        this.historyIndex = next;
        if (next === entries.length) {
            this.value = this.historyDraft ?? '';
            this.historyDraft = null;
            this.historyIndex = -1;
        }
        else {
            this.value = entries[next] ?? '';
        }
        this.cursorPos = this.value.length;
        this.emitChange();
        return true;
    }
    // ── commit ──
    commit() {
        const text = this.value;
        if (this.historyStore && text.length > 0) {
            const last = this.historyStore.entries[this.historyStore.entries.length - 1];
            if (last !== text) {
                if (this.historyStore.push)
                    this.historyStore.push(text);
                else
                    this.historyStore.entries.push(text);
            }
        }
        this.historyIndex = -1;
        this.historyDraft = null;
        if (this.opts.onSubmit)
            this.opts.onSubmit(text);
    }
    // ── cursor primitives ──
    moveCursor(delta) {
        this.cursorPos = clamp(this.cursorPos + delta, 0, this.value.length);
        this.emitChange();
    }
    /**
     * Multi-line vertical cursor movement. Returns false at the buffer edge so
     * the caller can fall back to history.
     */
    moveCursorVertical(delta) {
        const start = lineStart(this.value, this.cursorPos);
        const col = this.cursorPos - start;
        if (delta < 0) {
            if (start === 0)
                return false;
            const prevEnd = start - 1; // newline at start-1
            const prevStart = lineStart(this.value, prevEnd);
            const prevLen = prevEnd - prevStart;
            this.cursorPos = prevStart + Math.min(col, prevLen);
            this.emitChange();
            return true;
        }
        const end = lineEnd(this.value, this.cursorPos);
        if (end >= this.value.length)
            return false;
        const nextStart = end + 1;
        const nextEnd = lineEnd(this.value, nextStart);
        const nextLen = nextEnd - nextStart;
        this.cursorPos = nextStart + Math.min(col, nextLen);
        this.emitChange();
        return true;
    }
    deleteRange(from, to) {
        const a = clamp(Math.min(from, to), 0, this.value.length);
        const b = clamp(Math.max(from, to), 0, this.value.length);
        if (a === b)
            return;
        this.value = this.value.slice(0, a) + this.value.slice(b);
        this.cursorPos = a;
        this.completion = null;
        this.historyIndex = -1;
        this.historyDraft = null;
        this.emitChange();
    }
    emitChange() {
        if (this.opts.onChange)
            this.opts.onChange(this.snapshot());
    }
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
