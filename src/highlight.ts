// A small tokenizer for highlighting response source: JSON, JavaScript, CSS, HTML and XML.
// It only colours text; nothing is parsed further or run.

export type TokenKind = 'plain' | 'comment' | 'string' | 'number' | 'keyword' | 'literal' | 'key' | 'tag' | 'attr' | 'punct' | 'prop' | 'at'

export type Token = [TokenKind, string]

export type Language = 'json' | 'js' | 'css' | 'html' | 'xml' | 'text'

const JS_KEYWORDS = new Set(
  'async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield'.split(
    ' '
  )
)
const JS_LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'])

export function tokenize(text: string, language: Language): Token[] {
  switch (language) {
    case 'json':
      return tokenizeJson(text)
    case 'js':
      return tokenizeJs(text)
    case 'css':
      return tokenizeCss(text)
    case 'html':
    case 'xml':
      return tokenizeMarkup(text)
    default:
      return [['plain', text]]
  }
}

/** Collects tokens and merges neighbours of the same kind. */
class Out {
  readonly tokens: Token[] = []
  push(kind: TokenKind, text: string): void {
    if (!text) return
    const last = this.tokens[this.tokens.length - 1]
    if (last && last[0] === kind) last[1] += text
    else this.tokens.push([kind, text])
  }
}

/** End of a quoted string starting at `start`; stops at a line break for ' and ". */
function quoted(text: string, start: number, multiline: boolean): number {
  const quote = text[start]
  let i = start + 1
  while (i < text.length) {
    const c = text[i]
    if (c === '\\') i += 2
    else if (c === quote) return i + 1
    else if (!multiline && c === '\n') return i
    else i++
  }
  return text.length
}

function tokenizeJson(text: string): Token[] {
  const out = new Out()
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]
    if (c === '"') {
      const end = quoted(text, i, false)
      let j = end
      while (j < n && (text[j] === ' ' || text[j] === '\t')) j++
      out.push(text[j] === ':' ? 'key' : 'string', text.slice(i, end))
      i = end
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 64))
      const len = m ? m[0].length : 1
      out.push('number', text.slice(i, i + len))
      i += len
    } else if (/[a-z]/.test(c)) {
      const m = /^[a-z]+/.exec(text.slice(i, i + 16))
      const word = m ? m[0] : c
      out.push(word === 'true' || word === 'false' || word === 'null' ? 'literal' : 'plain', word)
      i += word.length
    } else if ('{}[],:'.includes(c)) {
      out.push('punct', c)
      i++
    } else {
      let j = i + 1
      while (j < n && !'"{}[],:-0123456789abcdefghijklmnopqrstuvwxyz'.includes(text[j])) j++
      out.push('plain', text.slice(i, j))
      i = j
    }
  }
  return out.tokens
}

function tokenizeJs(text: string): Token[] {
  const out = new Out()
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i)
      const stop = end < 0 ? n : end
      out.push('comment', text.slice(i, stop))
      i = stop
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end < 0 ? n : end + 2
      out.push('comment', text.slice(i, stop))
      i = stop
    } else if (c === '"' || c === "'" || c === '`') {
      const end = quoted(text, i, c === '`')
      out.push('string', text.slice(i, end))
      i = end
    } else if (c >= '0' && c <= '9') {
      const m = /^(0[xXbBoO][\da-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?n?)/.exec(text.slice(i, i + 64))
      const len = m ? m[0].length : 1
      out.push('number', text.slice(i, i + len))
      i += len
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1
      while (j < n && /[\w$]/.test(text[j])) j++
      const word = text.slice(i, j)
      out.push(JS_KEYWORDS.has(word) ? 'keyword' : JS_LITERALS.has(word) ? 'literal' : 'plain', word)
      i = j
    } else {
      let j = i + 1
      while (j < n && !/[\w$"'`/]/.test(text[j])) j++
      out.push('plain', text.slice(i, j))
      i = j
    }
  }
  return out.tokens
}

function tokenizeCss(text: string): Token[] {
  const out = new Out()
  const n = text.length
  let i = 0
  let inBlock = 0
  while (i < n) {
    const c = text[i]
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end < 0 ? n : end + 2
      out.push('comment', text.slice(i, stop))
      i = stop
    } else if (c === '"' || c === "'") {
      const end = quoted(text, i, false)
      out.push('string', text.slice(i, end))
      i = end
    } else if (c === '@') {
      let j = i + 1
      while (j < n && /[\w-]/.test(text[j])) j++
      out.push('at', text.slice(i, j))
      i = j
    } else if (c === '{' || c === '}') {
      inBlock += c === '{' ? 1 : -1
      if (inBlock < 0) inBlock = 0
      out.push('punct', c)
      i++
    } else if (inBlock > 0 && /[\w-]/.test(c)) {
      let j = i
      while (j < n && /[\w-]/.test(text[j])) j++
      let k = j
      while (k < n && (text[k] === ' ' || text[k] === '\t')) k++
      const word = text.slice(i, j)
      if (text[k] === ':' && !/^\d/.test(word)) out.push('prop', word)
      else if (/^-?\d/.test(word)) out.push('number', word)
      else out.push('plain', word)
      i = j
    } else if (c === '#' && inBlock > 0) {
      let j = i + 1
      while (j < n && /[\da-fA-F]/.test(text[j])) j++
      out.push('number', text.slice(i, j))
      i = j
    } else {
      let j = i + 1
      while (j < n && !/[\w"'@{}#/-]/.test(text[j])) j++
      out.push(inBlock > 0 ? 'plain' : 'tag', text.slice(i, j))
      i = j
    }
  }
  return out.tokens
}

function tokenizeMarkup(text: string): Token[] {
  const out = new Out()
  const n = text.length
  let i = 0
  while (i < n) {
    const lt = text.indexOf('<', i)
    if (lt < 0) {
      out.push('plain', text.slice(i))
      break
    }
    if (lt > i) out.push('plain', text.slice(i, lt))
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4)
      const stop = end < 0 ? n : end + 3
      out.push('comment', text.slice(lt, stop))
      i = stop
      continue
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt)
      const stop = end < 0 ? n : end + 3
      out.push('string', text.slice(lt, stop))
      i = stop
      continue
    }
    // A tag: name, attributes, values.
    let j = lt + 1
    if (text[j] === '/' || text[j] === '!' || text[j] === '?') j++
    while (j < n && /[\w:.-]/.test(text[j])) j++
    out.push('tag', text.slice(lt, j))
    while (j < n && text[j] !== '>') {
      const c = text[j]
      if (c === '"' || c === "'") {
        const end = quoted(text, j, true)
        out.push('string', text.slice(j, end))
        j = end
      } else if (/[\w:@.-]/.test(c)) {
        let k = j
        while (k < n && /[\w:@.-]/.test(text[k])) k++
        out.push('attr', text.slice(j, k))
        j = k
      } else if (c === '/' || c === '?') {
        out.push('tag', c)
        j++
      } else {
        let k = j + 1
        while (k < n && !/[\w:@."'/?>-]/.test(text[k])) k++
        out.push('plain', text.slice(j, k))
        j = k
      }
    }
    if (j < n) {
      out.push('tag', '>')
      j++
    }
    // Script and style bodies stay plain text up to their closing tag.
    const name = /^<([\w-]+)/.exec(text.slice(lt, lt + 16))?.[1]?.toLowerCase()
    if (name === 'script' || name === 'style') {
      // A case-insensitive search from here: lowercasing the whole text per tag was quadratic, and
      // its offsets drift where a character lowercases to more than one (İ).
      const closing = name === 'script' ? CLOSE_SCRIPT : CLOSE_STYLE
      closing.lastIndex = j
      const close = closing.exec(text)?.index ?? -1
      const stop = close < 0 ? n : close
      if (stop > j) for (const [kind, part] of (name === 'script' ? tokenizeJs : tokenizeCss)(text.slice(j, stop))) out.push(kind, part)
      i = stop
    } else i = j
  }
  return out.tokens
}

const CLOSE_SCRIPT = /<\/script/gi
const CLOSE_STYLE = /<\/style/gi

/** Splits tokens into lines, each a list of tokens. */
export function splitLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = [[]]
  for (const [kind, text] of tokens) {
    let start = 0
    for (let nl = text.indexOf('\n'); nl >= 0; nl = text.indexOf('\n', start)) {
      if (nl > start) lines[lines.length - 1].push([kind, text.slice(start, nl)])
      lines.push([])
      start = nl + 1
    }
    if (start < text.length) lines[lines.length - 1].push([kind, text.slice(start)])
  }
  return lines
}

export function languageOf(kind: string): Language {
  return kind === 'json' || kind === 'js' || kind === 'css' || kind === 'html' || kind === 'xml' ? kind : 'text'
}
