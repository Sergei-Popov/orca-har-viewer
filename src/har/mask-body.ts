// Bodies and WebSocket frames, taken apart by what they are before the free-text pass: JSON (in
// place, so nothing but the masked values changes), NDJSON, SignalR and Socket.IO frames,
// multipart and urlencoded forms. Byte bodies (base64 and .har.zip files) are masked whenever the
// viewer would show them as text, and written back in the encoding they came in.

import { baseMime, isTextBody } from './body'
import { JsonTokens, isJsonContainer, jsonStringLike } from './json-text'
import { MASK, MAX_DEPTH, hasOauthNames, isSecretName, maskText, maskTokens, maskValue, safeDecode, type Counter, type MaskKind, type MaskOptions } from './mask-text'
import { maskFreeText } from './mask-url'

/** Which characters a byte body's encoding can write back; others become `\uXXXX` in JSON. */
type Encodable = (code: number) => boolean

/** Masks a text body by its type and shape, then token shapes and secret pairs in the rest. */
export function maskBodyText(
  text: string,
  mimeType: string,
  counter: Counter,
  kind: MaskKind = 'bodies',
  options: MaskOptions = {},
  encodable?: Encodable
): string {
  if (!text) return text
  const mime = baseMime(mimeType)
  if (mime.startsWith('multipart/') || (!mime && text.startsWith('--'))) {
    const boundary = boundaryOf(mimeType, text)
    if (boundary) {
      const out = maskMultipart(text, boundary, counter, kind, options, (part, type) =>
        maskBodyText(part, type || 'text/plain', counter, kind, options, encodable)
      )
      if (out !== null) return out
    }
  }
  const first = firstChar(text)
  if (first === '{' || first === '[' || mime.includes('json')) {
    const json = maskJsonText(text, counter, kind, options, encodable)
    if (json !== null) return json
    if (text.includes('\n')) {
      const lines = maskRecords(text, '\n', counter, kind, options, encodable)
      if (lines !== null) return lines
    }
  }
  // SignalR: JSON records each ending in U+001E.
  if (text.includes('\u001e')) {
    const records = maskRecords(text, '\u001e', counter, kind, options, encodable)
    if (records !== null) return records
  }
  // Engine.IO / Socket.IO: `42["event",{…}]`, `42/chat,7[…]`, `40{…}`.
  if (first >= '0' && first <= '9') {
    const prefix = SOCKET_IO.exec(text)
    if (prefix) {
      const json = maskJsonText(text.slice(prefix[0].length), counter, kind, options, encodable)
      if (json !== null) return prefix[0] + json
    }
  }
  if (mime === 'application/x-www-form-urlencoded' || isFormShaped(text)) return maskForm(text, counter, kind, options)
  return maskText(text, counter, kind, options)
}

const SOCKET_IO = /^\d{1,3}(?:\/[^,[{\s]{0,256},)?\d{0,20}(?=[[{])/

function firstChar(text: string): string {
  for (let i = 0; i < text.length && i < 4096; i++) {
    const c = text[i]
    if (c !== ' ' && c !== '\n' && c !== '\r' && c !== '\t' && c !== '﻿') return c
  }
  return ''
}

/** Records split by `separator` (NDJSON lines, SignalR frames): null unless one of them is JSON. */
function maskRecords(text: string, separator: string, counter: Counter, kind: MaskKind, options: MaskOptions, encodable?: Encodable): string | null {
  let json = false
  const out = text.split(separator).map((record) => {
    if (!record.trim()) return record
    const masked = maskJsonText(record, counter, kind, options, encodable)
    if (masked !== null) {
      json = true
      return masked
    }
    return maskText(record, counter, kind, options)
  })
  return json ? out.join(separator) : null
}

// ── JSON, in place ───────────────────────────────────────────────────────────────────────────

/** Keys that only OAuth and OpenID bodies have, so their `code` is a secret. */
const OAUTH_JSON = /"(?:grant_type|redirect_uri|code_verifier|session_state)"/

type Frame = {
  object: boolean
  expectKey: boolean
  /** Everything inside is under a secret-named key. */
  secret: boolean
  /** The value after the current key is secret. */
  valueSecret: boolean
  /** Token-shaped keys masked so far, to keep the masked keys apart. */
  maskedKeys: number
}

/**
 * Masks a JSON object or array without parsing it into values: whole values under secret-named
 * keys (strings and numbers inside them; booleans and null stay), JSON, URLs, token shapes and
 * secret pairs inside the other strings, and token-shaped keys. Every other byte stays as it was.
 * Null when the text is not a JSON object or array.
 */
export function maskJsonText(
  text: string,
  counter: Counter,
  kind: MaskKind = 'bodies',
  options: MaskOptions = {},
  encodable?: Encodable
): string | null {
  if (!isJsonContainer(text)) return null
  const inner: MaskOptions = { ...options, oauth: options.oauth || OAUTH_JSON.test(text) }
  const tokens = new JsonTokens(text)
  const stack: Frame[] = []
  const out: string[] = []
  let last = 0
  const replace = (start: number, end: number, value: string) => {
    out.push(text.slice(last, start), value)
    last = end
  }
  const inSecret = (top: Frame | undefined) => !!top && (top.object ? top.valueSecret : top.secret)
  while (tokens.next()) {
    const top = stack[stack.length - 1] as Frame | undefined
    const { type, start, end } = tokens
    if (type === '{' || type === '[') {
      stack.push({ object: type === '{', expectKey: type === '{', secret: inSecret(top), valueSecret: false, maskedKeys: 0 })
    } else if (type === '}' || type === ']') {
      stack.pop()
    } else if (type === ',') {
      if (top?.object) top.expectKey = true
    } else if (type === 'string') {
      const literal = text.slice(start, end)
      const value = literal.includes('\\') ? (JSON.parse(literal) as string) : literal.slice(1, -1)
      if (top?.object && top.expectKey) {
        top.expectKey = false
        top.valueSecret = top.secret || isSecretName(value, inner)
        const key = maskTokens(value, counter, kind)
        if (key !== value) {
          top.maskedKeys++
          replace(start, end, jsonStringLike(top.maskedKeys > 1 ? `${key}#${top.maskedKeys}` : key, literal, encodable))
        }
      } else if (inSecret(top)) {
        if (value && value !== MASK) {
          counter.add(kind)
          replace(start, end, `"${MASK}"`)
        }
      } else {
        const masked = maskJsonString(value, counter, kind, inner, encodable)
        if (masked !== value) replace(start, end, jsonStringLike(masked, literal, encodable))
      }
    } else if (type === 'scalar') {
      // Numbers under secret keys; true, false and null say nothing secret.
      const c = text.charCodeAt(start)
      if (inSecret(top) && (c === 0x2d || (c >= 0x30 && c <= 0x39))) {
        counter.add(kind)
        replace(start, end, `"${MASK}"`)
      }
    }
  }
  if (!out.length) return text
  out.push(text.slice(last))
  return out.join('')
}

/** A string inside JSON: JSON in it masked as JSON, a URL as a URL, anything else as text. */
function maskJsonString(value: string, counter: Counter, kind: MaskKind, options: MaskOptions, encodable?: Encodable): string {
  if (value.length < 6) return value
  const depth = options.depth ?? 0
  const first = firstChar(value)
  if (depth < MAX_DEPTH && (first === '{' || first === '[')) {
    const json = maskJsonText(value, counter, kind, { ...options, depth: depth + 1 }, encodable)
    if (json !== null) return json
  }
  return maskFreeText(value, counter, kind, options)
}

// ── Forms ────────────────────────────────────────────────────────────────────────────────────

const FORM_PAIR = /^[\w.%+\-[\]]{1,256}=/

/** `a=1&b=2`: urlencoded fields, whatever the declared type (`fetch` sends strings as text/plain). */
export function isFormShaped(text: string): boolean {
  const body = text.trimEnd()
  if (!body.includes('=') || /\s/.test(body)) return false
  return body.split('&').every((pair) => FORM_PAIR.test(pair))
}

function maskForm(text: string, counter: Counter, kind: MaskKind, options: MaskOptions): string {
  const body = text.trimEnd()
  const pairs = body.split('&')
  const names = pairs.map((pair) => safeDecode(pair.slice(0, Math.max(0, pair.indexOf('=')))))
  const inner: MaskOptions = { ...options, oauth: options.oauth || hasOauthNames(names) }
  let changed = false
  const out = pairs.map((pair, index) => {
    const eq = pair.indexOf('=')
    if (eq <= 0) return pair
    const name = pair.slice(0, eq)
    const value = pair.slice(eq + 1)
    if (!value || value === MASK) return pair
    let masked: string
    if (isSecretName(names[index], inner)) {
      counter.add(kind)
      masked = MASK
    } else masked = maskValue(value, counter, kind, inner)
    if (masked === value) return pair
    changed = true
    return `${name}=${masked}`
  })
  return changed ? out.join('&') + text.slice(body.length) : text
}

// ── Multipart ────────────────────────────────────────────────────────────────────────────────

/** The boundary from the type, or from a body that starts with one. */
export function boundaryOf(mimeType: string, text: string): string | null {
  const declared = /;\s*boundary\s*=\s*(?:"([^"]{1,200})"|([^;\s]{1,200}))/i.exec(mimeType)
  if (declared) return declared[1] ?? declared[2]
  const first = /^--([^\r\n]{1,200})\r?\n/.exec(text)
  return first && /content-disposition/i.test(text.slice(0, 4096)) ? first[1] : null
}

type Part = { bodyStart: number; bodyEnd: number; name: string; type: string; file: boolean }

/**
 * Masks the parts of a multipart body: the whole value of a part with a secret name, and the
 * others by their own type through `maskPart`. Delimiters, headers and line breaks stay as they
 * are. Null when the boundary is not in the text.
 */
export function maskMultipart(
  text: string,
  boundary: string,
  counter: Counter,
  kind: MaskKind,
  options: MaskOptions,
  maskPart: (body: string, type: string) => string
): string | null {
  const delimiter = `--${boundary}`
  const starts: number[] = []
  for (let from = 0; ; ) {
    const at = text.indexOf(delimiter, from)
    if (at < 0) break
    if (at === 0 || text.charCodeAt(at - 1) === 0x0a) {
      starts.push(at)
      // The closing delimiter: `--boundary--`.
      if (text.startsWith('--', at + delimiter.length)) break
    }
    from = at + delimiter.length
  }
  if (starts.length < 2) return null
  const parts: Part[] = []
  for (let k = 0; k + 1 < starts.length; k++) {
    const lineEnd = text.indexOf('\n', starts[k] + delimiter.length)
    if (lineEnd < 0 || lineEnd >= starts[k + 1]) continue
    const headerStart = lineEnd + 1
    // The line break before the next delimiter belongs to the delimiter.
    let bodyEnd = starts[k + 1] - 1
    if (text.charCodeAt(bodyEnd - 1) === 0x0d) bodyEnd--
    const head = text.slice(headerStart, Math.min(bodyEnd, headerStart + 8192))
    let blank = head.indexOf('\r\n\r\n')
    let gap = 4
    if (blank < 0) {
      blank = head.indexOf('\n\n')
      gap = 2
    }
    if (blank < 0) continue
    const headers = head.slice(0, blank)
    const name = /\bname\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(headers)
    const type = /^content-type[ \t]*:[ \t]*([^\r\n]*)/im.exec(headers)
    parts.push({
      bodyStart: headerStart + blank + gap,
      bodyEnd: Math.max(headerStart + blank + gap, bodyEnd),
      name: name ? (name[1] ?? name[2]) : '',
      type: type ? type[1].trim() : '',
      file: /\bfilename\*?\s*=/i.test(headers)
    })
  }
  const inner: MaskOptions = { ...options, oauth: options.oauth || hasOauthNames(parts.map((p) => p.name)) }
  const out: string[] = []
  let last = 0
  for (const part of parts) {
    const body = text.slice(part.bodyStart, part.bodyEnd)
    if (!body) continue
    let masked: string
    if (!part.file && isSecretName(part.name, inner)) {
      if (body === MASK) continue
      counter.add(kind)
      masked = MASK
    } else if (/^(?:image|audio|video|font)\//i.test(part.type)) continue
    else masked = maskPart(body, part.type)
    if (masked === body) continue
    out.push(text.slice(last, part.bodyStart), masked)
    last = part.bodyEnd
  }
  if (!out.length) return text
  out.push(text.slice(last))
  return out.join('')
}

// ── Byte bodies ──────────────────────────────────────────────────────────────────────────────

type Decoded = { text: string; encode(text: string): Uint8Array; encodable?: Encodable }

/**
 * Masks a body held as bytes (base64 in the HAR, or a .har.zip file) when it counts as text by
 * the same rule the viewer uses, and writes it back in the encoding it came in: UTF-8, UTF-16 or
 * a single-byte charset as declared, and byte for byte otherwise. The same array when nothing changed.
 */
export function maskBodyBytes(bytes: Uint8Array, mimeType: string, counter: Counter, kind: MaskKind = 'bodies', options: MaskOptions = {}): Uint8Array {
  if (!bytes.length) return bytes
  // Parts are found before the text check, so text parts are masked next to binary ones.
  if (baseMime(mimeType).startsWith('multipart/')) {
    // Binary parts must survive byte for byte, so the parts are found in a byte string.
    const text = BYTE_STRING.decode(bytes)
    const boundary = boundaryOf(mimeType, text)
    if (boundary) {
      const out = maskMultipart(text, boundary, counter, kind, options, (part, type) => {
        const partBytes = BYTE_STRING.encode(part)
        const masked = maskBodyBytes(partBytes, type || 'text/plain', counter, kind, options)
        return masked === partBytes ? part : BYTE_STRING.decode(masked)
      })
      if (out !== null) return out === text ? bytes : BYTE_STRING.encode(out)
    }
  }
  if (!isTextBody(bytes, mimeType)) return bytes
  const decoded = decodeForMasking(bytes, mimeType)
  const masked = maskBodyText(decoded.text, mimeType, counter, kind, options, decoded.encodable)
  return masked === decoded.text ? bytes : decoded.encode(masked)
}

function decodeForMasking(bytes: Uint8Array, mimeType: string): Decoded {
  const match = /charset\s*=\s*"?([\w.:-]+)/i.exec(mimeType)
  const label = (match ? match[1] : 'utf-8').toLowerCase()
  if (label === 'utf-8' || label === 'utf8' || label === 'unicode-1-1-utf-8') {
    try {
      // The byte order mark stays in the text, so it is written back.
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      return { text, encode: (t) => new TextEncoder().encode(t) }
    } catch {
      return byteString(bytes)
    }
  }
  if (label === 'utf-16' || label === 'utf-16le' || label === 'utf-16be') {
    // A byte order mark beats the label; without one, plain `utf-16` is little-endian.
    const big = bytes[0] === 0xfe && bytes[1] === 0xff ? true : bytes[0] === 0xff && bytes[1] === 0xfe ? false : label === 'utf-16be'
    try {
      const text = new TextDecoder(big ? 'utf-16be' : 'utf-16le', { fatal: true, ignoreBOM: true }).decode(bytes)
      return { text, encode: (t) => encodeUtf16(t, big) }
    } catch {
      return byteString(bytes)
    }
  }
  const single = singleByte(label)
  if (single) return { text: single.decode(bytes), encode: single.encode, encodable: single.encodable }
  return byteString(bytes)
}

function encodeUtf16(text: string, big: boolean): Uint8Array {
  const out = new Uint8Array(text.length * 2)
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    out[i * 2 + (big ? 1 : 0)] = code & 0xff
    out[i * 2 + (big ? 0 : 1)] = code >> 8
  }
  return out
}

type ByteCodec = { decode(bytes: Uint8Array): string; encode(text: string): Uint8Array; encodable: Encodable }

/**
 * Bytes as a string, one character per byte: ASCII as itself, other bytes as U+F780–U+F7FF
 * (the x-user-defined mapping), which no masking pattern takes for a letter or a space. Lets
 * ASCII patterns be masked in text of any or no valid encoding with every other byte kept.
 */
export const BYTE_STRING: ByteCodec = {
  decode(bytes) {
    let out = ''
    const chunk = new Uint16Array(Math.min(bytes.length, 0x8000))
    for (let at = 0; at < bytes.length; at += 0x8000) {
      const end = Math.min(bytes.length, at + 0x8000)
      for (let i = at; i < end; i++) chunk[i - at] = bytes[i] < 0x80 ? bytes[i] : 0xf700 + bytes[i]
      out += String.fromCharCode.apply(null, Array.from(chunk.subarray(0, end - at)))
    }
    return out
  },
  encode(text) {
    const out = new Uint8Array(text.length)
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      if (code < 0x80) out[i] = code
      else if (code >= 0xf780 && code <= 0xf7ff) out[i] = code - 0xf700
      else return encodeMixed(text)
    }
    return out
  },
  encodable: (code) => code < 0x80 || (code >= 0xf780 && code <= 0xf7ff)
}

/** A byte string with other characters in it (which masking never adds): those as UTF-8. */
function encodeMixed(text: string): Uint8Array {
  const out: number[] = []
  const utf8 = new TextEncoder()
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) out.push(code)
    else if (code >= 0xf780 && code <= 0xf7ff) out.push(code - 0xf700)
    else for (const byte of utf8.encode(text[i])) out.push(byte)
  }
  return Uint8Array.from(out)
}

function byteString(bytes: Uint8Array): Decoded {
  return { text: BYTE_STRING.decode(bytes), encode: BYTE_STRING.encode, encodable: BYTE_STRING.encodable }
}

const singleByteCodecs = new Map<string, ByteCodec | null>()

/** A single-byte charset whose 256 bytes decode to 256 distinct characters, so it round-trips. */
function singleByte(label: string): ByteCodec | null {
  if (singleByteCodecs.has(label)) return singleByteCodecs.get(label) ?? null
  let codec: ByteCodec | null = null
  try {
    const decoder = new TextDecoder(label)
    const table = new Array<string>(256)
    const reverse = new Map<number, number>()
    let ok = true
    for (let b = 0; b < 256 && ok; b++) {
      const c = decoder.decode(new Uint8Array([b]))
      if (c.length !== 1 || reverse.has(c.charCodeAt(0))) ok = false
      else {
        table[b] = c
        reverse.set(c.charCodeAt(0), b)
      }
    }
    if (ok) {
      codec = {
        decode: (bytes) => {
          let out = ''
          for (let i = 0; i < bytes.length; i++) out += table[bytes[i]]
          return out
        },
        encode: (text) => {
          const out = new Uint8Array(text.length)
          for (let i = 0; i < text.length; i++) out[i] = reverse.get(text.charCodeAt(i)) ?? 0x3f
          return out
        },
        encodable: (code) => reverse.has(code)
      }
    }
  } catch {
    codec = null
  }
  singleByteCodecs.set(label, codec)
  return codec
}
