// JSON as text. Masking and indenting work on the tokens of the original text instead of parsing
// and re-serializing it, so 64-bit integers, number spelling, key order, escapes and spacing
// survive byte for byte. Iterative, so any depth works, and linear in the text.

export type JsonTokenType = '{' | '}' | '[' | ']' | ':' | ',' | 'string' | 'scalar'

/** Whether the text is a JSON object or array. */
export function isJsonContainer(text: string): boolean {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const first = body.trimStart()[0]
  if (first !== '{' && first !== '[') return false
  try {
    JSON.parse(body)
    return true
  } catch {
    return false
  }
}

/** Index just past the string literal whose opening quote is at `start`. */
export function stringEnd(text: string, start: number): number {
  let i = start + 1
  for (;;) {
    const quote = text.indexOf('"', i)
    if (quote < 0) return text.length
    let backslashes = 0
    for (let j = quote - 1; j > start && text.charCodeAt(j) === 0x5c; j--) backslashes++
    if (backslashes % 2 === 0) return quote + 1
    i = quote + 1
  }
}

/** The tokens of valid JSON text, one at a time. */
export class JsonTokens {
  type: JsonTokenType = ','
  start = 0
  end = 0
  private i = 0

  constructor(readonly text: string) {}

  next(): boolean {
    const text = this.text
    let i = this.i
    for (;;) {
      if (i >= text.length) return false
      const c = text.charCodeAt(i)
      // Space, tab, line breaks and a byte order mark.
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0xfeff) i++
      else break
    }
    this.start = i
    const c = text[i]
    if (c === '{' || c === '}' || c === '[' || c === ']' || c === ':' || c === ',') {
      this.type = c
      this.end = i + 1
    } else if (c === '"') {
      this.type = 'string'
      this.end = stringEnd(text, i)
    } else {
      this.type = 'scalar'
      let j = i + 1
      while (j < text.length) {
        const d = text.charCodeAt(j)
        if (d === 0x2c || d === 0x7d || d === 0x5d || d === 0x20 || d === 0x09 || d === 0x0a || d === 0x0d || d === 0x3a) break
        j++
      }
      this.end = j
    }
    this.i = this.end
    return true
  }
}

/**
 * Valid JSON text indented by `indent` spaces, with every string and number literal exactly as it
 * was. Null when the text is not JSON, or nests deeper than `maxDepth` (the result would be huge).
 */
export function reindentJson(text: string, indent = 2, maxDepth = 100): string | null {
  if (!isJsonContainer(text)) return null
  const tokens = new JsonTokens(text)
  const out: string[] = []
  const pads = ['\n']
  const pad = (depth: number) => {
    while (pads.length <= depth) pads.push(`\n${' '.repeat(pads.length * indent)}`)
    return pads[depth]
  }
  let depth = 0
  let afterOpen = false
  while (tokens.next()) {
    const type = tokens.type
    if (type === '}' || type === ']') {
      depth--
      out.push(afterOpen ? type : `${pad(depth)}${type}`)
      afterOpen = false
      continue
    }
    if (afterOpen) {
      out.push(pad(depth))
      afterOpen = false
    }
    if (type === '{' || type === '[') {
      out.push(type)
      depth++
      if (depth > maxDepth) return null
      afterOpen = true
    } else if (type === ',') out.push(`,${pad(depth)}`)
    else if (type === ':') out.push(': ')
    else out.push(text.slice(tokens.start, tokens.end))
  }
  return out.join('')
}

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) return false
  return true
}

/**
 * A JSON string literal for `value`, written in the style of `original` (another literal): `\/`
 * when it escaped slashes, `<` for `<>&'` when it escaped those, `\uXXXX` for everything
 * outside ASCII when it was ASCII-only, and `\uXXXX` for any character `encodable` refuses.
 */
export function jsonStringLike(value: string, original: string, encodable?: (code: number) => boolean): string {
  let out = JSON.stringify(value)
  if (original.includes('\\/')) out = out.replace(/\//g, '\\/')
  if (/\\u00(?:3[cCeE]|26|27)/.test(original)) out = out.replace(/[<>&']/g, (c) => `\\u00${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
  const asciiOnly = /\\u(?!00[0-7])[0-9a-fA-F]{4}/.test(original) && isAscii(original)
  if (asciiOnly || encodable) {
    let escaped = ''
    let last = 0
    for (let i = 0; i < out.length; i++) {
      const code = out.charCodeAt(i)
      if (code < 0x80) continue
      if (!asciiOnly && encodable && encodable(code)) continue
      escaped += `${out.slice(last, i)}\\u${code.toString(16).padStart(4, '0')}`
      last = i + 1
    }
    if (last) out = escaped + out.slice(last)
  }
  return out
}
