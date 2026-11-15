// Bodies and WebSocket frames, taken apart by what they are before the free-text pass: JSON (in
// place, so nothing but the masked values changes), NDJSON, SignalR, Socket.IO (WebSocket and
// long-polling), SockJS and STOMP frames, server-sent events, JSON behind XSSI guards and JSONP
// callbacks, JSON in HTML (`<script type="application/json">`, escaped attributes), multipart and
// urlencoded forms. Byte bodies (base64 and .har.zip files) are masked whenever the viewer would
// show them as text, and written back in the encoding they came in.

import { baseMime, isTextBody, sniffBom } from './body'
import { JsonTokens, isJsonContainer, jsonStringLike, stringEnd } from './json-text'
import {
  MASK,
  MAX_DEPTH,
  hasOauthNames,
  isIdName,
  isSecretName,
  learnId,
  maskRandom,
  maskText,
  maskTokens,
  maskValue,
  nameWords,
  safeDecode,
  setJsonMasker,
  type Counter,
  type MaskKind,
  type MaskOptions
} from './mask-text'
import { maskFreeText } from './mask-url'

/** Which characters a byte body's encoding can write back; others become `\uXXXX` in JSON. */
type Encodable = (code: number) => boolean

/**
 * Multipart nested deeper than this is replaced whole with `[masked]`: real bodies nest two or
 * three levels (batch requests), so only a crafted file gets there.
 */
export const MAX_PARTS = 4

/** JavaScript and CSS: masked by names and token shapes only, so code is not rewritten. */
function isCode(mime: string): boolean {
  return mime.includes('javascript') || mime.includes('ecmascript') || mime.includes('typescript') || mime === 'text/css'
}

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
  if (isCode(mime) && !options.code) options = { ...options, code: true }
  const parts = options.parts ?? 0
  if (mime.startsWith('multipart/') && parts >= MAX_PARTS) {
    if (text !== MASK) counter.add(kind)
    return MASK
  }
  if ((mime.startsWith('multipart/') || (!mime && text.startsWith('--'))) && parts < MAX_PARTS) {
    const boundary = boundaryOf(mimeType, text)
    if (boundary) {
      const inner: MaskOptions = { ...options, parts: parts + 1 }
      const out = maskMultipart(text, boundary, counter, kind, inner, (part, type) =>
        maskBodyText(part, type || 'text/plain', counter, kind, inner, encodable)
      )
      if (out !== null) return out
    }
  }
  const first = firstChar(text)
  if (first === '{' || first === '[' || mime.includes('json')) {
    const json = maskJsonText(text, counter, kind, options, encodable)
    if (json !== null) return json
  }
  const framed = maskFramed(text, counter, kind, options, encodable)
  if (framed !== null) return framed
  if (mime === 'text/event-stream' || (!mime && /^(?:data|event|id|retry):/.test(text))) {
    return maskEventStream(text, counter, kind, options, encodable)
  }
  if (STOMP.test(text)) return maskStomp(text, counter, kind, options, encodable)
  // SignalR and Engine.IO 4 long-polling: records each ending in (or split by) U+001E.
  if (text.includes('\u001e')) {
    const records = maskRecords(text, '\u001e', counter, kind, options, encodable)
    if (records !== null) return records
  }
  const html = mime === 'text/html' || mime === 'application/xhtml+xml' || (!mime && first === '<')
  // NDJSON, SockJS and Socket.IO streams: one frame a line.
  if (!html && !options.code && text.includes('\n')) {
    const lines = maskRecords(text, '\n', counter, kind, options, encodable)
    if (lines !== null) return lines
  }
  if (mime === 'application/x-www-form-urlencoded' || isFormShaped(text)) return maskForm(text, counter, kind, options)
  // HTML: JSON script blocks and escaped attributes, then JSON anywhere else (`window.__STATE__ = {…}`).
  if (html || (first === '<' && mime.includes('xml'))) return maskPlain(maskHtmlJson(text, counter, kind, options, encodable), counter, kind, options, encodable)
  return maskPlain(text, counter, kind, options, encodable)
}

/** Text of no known shape: JSON inside it masked as JSON, then the text rules over all of it. */
function maskPlain(text: string, counter: Counter, kind: MaskKind, options: MaskOptions, encodable?: Encodable): string {
  const islands = options.code ? null : maskJsonIslands(text, counter, kind, options, encodable)
  return maskText(islands ?? text, counter, kind, options)
}

/** Characters the island search may parse, per character of text. */
const ISLAND_WORK = 4

/**
 * JSON objects and arrays inside other text (`level=info data={…}`, Engine.IO 3 packets whose
 * lengths are off, a log line around a payload): each masked in place as JSON. Null when there
 * is none. Brackets are matched in one pass, and the outermost pairs that parse are taken within
 * a parse budget, so the work stays linear in the text.
 */
function maskJsonIslands(text: string, counter: Counter, kind: MaskKind, options: MaskOptions, encodable?: Encodable): string | null {
  const spans: [number, number][] = []
  const stack: number[] = []
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 0x7b || c === 0x5b) stack.push(i)
    else if (c === 0x7d || c === 0x5d) {
      const open = stack.pop()
      if (open === undefined) continue
      if (text.charCodeAt(open) !== (c === 0x7d ? 0x7b : 0x5b)) stack.length = 0
      else if (i > open + 1) spans.push([open, i + 1])
    } else if (c === 0x22 && stack.length) {
      const end = stringEnd(text, i)
      // A quote that never closes: nothing after it can be matched safely.
      if (end === text.length && (end - 1 === i || text.charCodeAt(end - 1) !== 0x22)) break
      i = end - 1
    }
  }
  if (!spans.length) return null
  spans.sort((a, b) => a[0] - b[0])
  let budget = ISLAND_WORK * text.length
  const out: string[] = []
  let last = 0
  for (const [open, close] of spans) {
    if (open < last || close - open > budget) continue
    budget -= close - open
    const piece = text.slice(open, close)
    const masked = maskJsonText(piece, counter, kind, options, encodable)
    if (masked === null) continue
    out.push(text.slice(last, open), masked)
    last = close
  }
  if (!out.length) return null
  out.push(text.slice(last))
  return out.join('')
}

/** Engine.IO / Socket.IO: `42["event",{…}]`, `42/chat,7[…]`, `40{…}`, `451-["upload",…]`. */
const SOCKET_IO = /^\d{1,3}(?:\d{0,10}-)?(?:\/[^,[{\s]{0,256},)?\d{0,20}(?=[[{])/
/** Engine.IO 3 long-polling: packets as `length:packet`, back to back. */
const ENGINE_IO_3 = /^\d{1,10}:/
/** Anti-hijacking prefixes before JSON: `)]}'`, `while(1);`, `for(;;);`. */
const XSSI = /^\s*(?:\)\]\}'[,;]?|while\s*\(\s*1\s*\)\s*;|for\s*\(\s*;\s*;\s*\)\s*;)\s*/
/** JSONP: `callback(` before JSON, `)` or `);` after it. */
const JSONP = /^\s*(?:\/\*\*\/\s*)?[A-Za-z_$][\w$.]{0,127}\s*\(\s*/
/** A STOMP frame: a command line, header lines, a blank line, then the body and a NUL. */
const STOMP = /^(?:CONNECT|STOMP|CONNECTED|SEND|SUBSCRIBE|UNSUBSCRIBE|ACK|NACK|BEGIN|COMMIT|ABORT|DISCONNECT|MESSAGE|RECEIPT|ERROR)\r?\n/

function firstChar(text: string): string {
  for (let i = 0; i < text.length && i < 4096; i++) {
    const c = text[i]
    if (c !== ' ' && c !== '\n' && c !== '\r' && c !== '\t' && c !== '\ufeff') return c
  }
  return ''
}

/**
 * One frame of a wire format that wraps JSON: a Socket.IO packet, Engine.IO 3 packets, a SockJS
 * `a[…]` frame, JSON behind an XSSI guard or in a JSONP call. The wrapper stays as it is and the
 * JSON inside is masked in place. Null when the text is none of these.
 */
function maskFramed(text: string, counter: Counter, kind: MaskKind, options: MaskOptions, encodable?: Encodable): string | null {
  const first = text.charCodeAt(0)
  if (first >= 0x30 && first <= 0x39) {
    const packet = maskSocketPacket(text, counter, kind, options, encodable)
    if (packet !== null) return packet
    if (ENGINE_IO_3.test(text)) return maskEngineIo3(text, counter, kind, options, encodable)
    return null
  }
  // SockJS: `a["…","…"]` carries messages, `c[3000,"…"]` closes.
  if ((first === 0x61 || first === 0x63) && text.charCodeAt(1) === 0x5b) {
    const json = maskJsonText(text.slice(1), counter, kind, options, encodable)
    return json === null ? null : text[0] + json
  }
  const guard = XSSI.exec(text)
  if (guard) {
    const json = maskJsonText(text.slice(guard[0].length), counter, kind, options, encodable)
    return json === null ? null : guard[0] + json
  }
  const call = JSONP.exec(text)
  if (call) {
    const end = jsonpEnd(text)
    if (end <= call[0].length) return null
    const json = maskJsonText(text.slice(call[0].length, end), counter, kind, options, encodable)
    return json === null ? null : call[0] + json + text.slice(end)
  }
  return null
}

/** `42["event",{…}]`: the packet prefix as it is, the JSON masked. Null when it is not a packet. */
function maskSocketPacket(text: string, counter: Counter, kind: MaskKind, options: MaskOptions, encodable?: Encodable): string | null {
  const prefix = SOCKET_IO.exec(text)
  if (!prefix) return null
  const json = maskJsonText(text.slice(prefix[0].length), counter, kind, options, encodable)
  return json === null ? null : prefix[0] + json
}

const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d

/** Where the JSON of a JSONP call ends: before `)`, `);` and spaces at the end. -1 when there is no `)`. */
function jsonpEnd(text: string): number {
  let end = text.length
  while (end > 0 && isSpace(text.charCodeAt(end - 1))) end--
  if (text.charCodeAt(end - 1) === 0x3b) {
    end--
    while (end > 0 && isSpace(text.charCodeAt(end - 1))) end--
  }
  if (text.charCodeAt(end - 1) !== 0x29) return -1
  end--
  while (end > 0 && isSpace(text.charCodeAt(end - 1))) end--
  return end
}

/** `60:42["auth",{…}]2:40`: each packet masked, its length written again. Null if it is not that framing. */
function maskEngineIo3(text: string, counter: Counter, kind: MaskKind, options: MaskOptions, encodable?: Encodable): string | null {
  const out: string[] = []
  let changed = false
  for (let at = 0; at < text.length; ) {
    const colon = text.indexOf(':', at)
    if (colon <= at || colon - at > 10) return null
    const length = Number(text.slice(at, colon))
    if (!Number.isInteger(length) || colon + 1 + length > text.length) return null
    const packet = text.slice(colon + 1, colon + 1 + length)
    const masked = maskSocketPacket(packet, counter, kind, options, encodable) ?? maskText(packet, counter, kind, options)
    if (masked !== packet) changed = true
    out.push(`${masked.length}:${masked}`)
    at = colon + 1 + length
  }
  return changed ? out.join('') : text
}

/** Records split by `separator` (NDJSON lines, SignalR frames): null unless one of them is JSON or a JSON frame. */
function maskRecords(text: string, separator: string, counter: Counter, kind: MaskKind, options: MaskOptions, encodable?: Encodable): string | null {
  let json = false
  const out = text.split(separator).map((record) => {
    if (!record.trim()) return record
    const masked = maskJsonText(record, counter, kind, options, encodable) ?? maskFramed(record, counter, kind, options, encodable)
    if (masked !== null) {
      json = true
      return masked
    }
    return maskPlain(record, counter, kind, options, encodable)
  })
  return json ? out.join(separator) : null
}

/** Server-sent events: each `data:` payload masked as a body of its own, the other lines as text. */
function maskEventStream(text: string, counter: Counter, kind: MaskKind, options: MaskOptions, encodable?: Encodable): string {
  const depth = options.depth ?? 0
  if (depth >= MAX_DEPTH) return maskText(text, counter, kind, options)
  const inner: MaskOptions = { ...options, depth: depth + 1 }
  let changed = false
  const out = text.split('\n').map((line) => {
    const data = /^data:[ ]?/.exec(line)
    let masked: string
    if (data) {
      const end = line.endsWith('\r') ? line.length - 1 : line.length
      masked = data[0] + maskBodyText(line.slice(data[0].length, end), '', counter, kind, inner, encodable) + line.slice(end)
    } else masked = maskText(line, counter, kind, options)
    if (masked !== line) changed = true
    return masked
  })
  return changed ? out.join('\n') : text
}

/** A STOMP frame: header lines as `name:value` lines (`passcode:…`), the body by its `content-type`. */
function maskStomp(text: string, counter: Counter, kind: MaskKind, options: MaskOptions, encodable?: Encodable): string {
  let blank = text.indexOf('\n\n')
  let gap = 2
  const crlf = text.indexOf('\r\n\r\n')
  if (crlf >= 0 && (blank < 0 || crlf < blank)) {
    blank = crlf
    gap = 4
  }
  if (blank < 0) return maskText(text, counter, kind, options)
  const head = maskText(text.slice(0, blank), counter, kind, options)
  let end = text.length
  while (end > blank + gap && (text.charCodeAt(end - 1) === 0 || text.charCodeAt(end - 1) === 0x0a || text.charCodeAt(end - 1) === 0x0d)) end--
  const type = /^content-type:([^\r\n]*)/im.exec(head)
  const depth = options.depth ?? 0
  const bodyText = text.slice(blank + gap, end)
  const body = depth < MAX_DEPTH ? maskBodyText(bodyText, type ? type[1].trim() : '', counter, kind, { ...options, depth: depth + 1 }, encodable) : maskText(bodyText, counter, kind, options)
  return head + text.slice(blank, blank + gap) + body + text.slice(end)
}

// ── JSON in HTML ─────────────────────────────────────────────────────────────────────────────

const SCRIPT_OPEN = /<script\b[^<>]*>/gi
const SCRIPT_CLOSE = /<\/script/gi
const JSON_SCRIPT = /\btype\s*=\s*["']?application\/(?:ld\+)?json\b/i
/** `data-page="{&quot;props&quot;:…}"`: JSON escaped into a double-quoted attribute. */
const ESCAPED_JSON = /(=[ \t]*")([{[]&quot;[^"]*)"/g
/** `data-props='{"token":"…"}'`: JSON as it is in a single-quoted attribute. */
const QUOTED_JSON = /(=[ \t]*')([{[][^']*)'/g
const ENTITY = /&(?:quot|amp|lt|gt|apos|#0?39|#x27|#34|#x22);/g
const ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&apos;': "'",
  '&#39;': "'",
  '&#039;': "'",
  '&#x27;': "'",
  '&#34;': '"',
  '&#x22;': '"'
}

/** Escapes text for an attribute the way `original` was escaped. */
function escapeLike(text: string, original: string): string {
  let out = text.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
  if (original.includes('&lt;')) out = out.replace(/</g, '&lt;')
  if (original.includes('&gt;')) out = out.replace(/>/g, '&gt;')
  const apos = ['&#39;', '&#039;', '&#x27;', '&apos;'].find((entity) => original.includes(entity))
  if (apos) out = out.replace(/'/g, apos)
  return out
}

/** JSON `<script>` blocks (`__NEXT_DATA__`, ld+json) and JSON in attributes, masked in place. */
function maskHtmlJson(html: string, counter: Counter, kind: MaskKind, options: MaskOptions, encodable?: Encodable): string {
  let out = html
  if (JSON_SCRIPT.test(out)) {
    const pieces: string[] = []
    let last = 0
    SCRIPT_OPEN.lastIndex = 0
    for (let open = SCRIPT_OPEN.exec(out); open; open = SCRIPT_OPEN.exec(out)) {
      const start = open.index + open[0].length
      SCRIPT_CLOSE.lastIndex = start
      const close = SCRIPT_CLOSE.exec(out)
      if (!close) break
      if (JSON_SCRIPT.test(open[0])) {
        const masked = maskJsonText(out.slice(start, close.index), counter, kind, options, encodable)
        if (masked !== null) {
          pieces.push(out.slice(last, start), masked)
          last = close.index
        }
      }
      SCRIPT_OPEN.lastIndex = close.index
    }
    if (pieces.length) out = pieces.join('') + out.slice(last)
  }
  if (out.includes('&quot;')) {
    out = out.replace(ESCAPED_JSON, (match, lead: string, value: string) => {
      const decoded = value.replace(ENTITY, (entity) => ENTITIES[entity] ?? entity)
      if (escapeLike(decoded, value) !== value) return match
      const masked = maskJsonText(decoded, counter, kind, options, encodable)
      return masked === null || masked === decoded ? match : `${lead}${escapeLike(masked, value)}"`
    })
  }
  if (out.includes("='{") || out.includes("='[") || /=[ \t]+'[{[]/.test(out)) {
    out = out.replace(QUOTED_JSON, (match, lead: string, value: string) => {
      const masked = maskJsonText(value, counter, kind, options, encodable)
      return masked === null || masked === value ? match : `${lead}${masked}'`
    })
  }
  return out
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
  /** Keys masked so far, to keep the masked keys apart. */
  maskedKeys: number
  /** The current key of an object. */
  key: string
  /** The values of an array are identifiers by the key it is under (`"ids": […]`). */
  ids: boolean
}

/** The shape of a key that names a field (`id`, `user`, `createdAt`, `line2`). */
const FIELD_NAME = /^[A-Za-z_$@][A-Za-z_$@.-]{0,63}[0-9]{0,3}$/

/**
 * A key that names a field rather than holding a value, for the keys of a secret-named object:
 * the field-name shape, no word of 16 letters or more, no long word without a vowel, and not
 * mostly one- and two-letter pieces (`AbCdEfGh…`), so session IDs made only of letters
 * (`kjhsdfkjhsdfkjhsdfkjhsdf`) are masked as the ones with digits are.
 */
export function isFieldName(key: string): boolean {
  if (!FIELD_NAME.test(key)) return false
  const words = nameWords(key)
  if (words.some((word) => word.length >= 16 || (word.length >= 6 && !/[aeiouy]/.test(word)))) return false
  const short = words.filter((word) => word.length <= 2).length
  return words.length < 4 || short * 2 <= words.length
}

/**
 * Masks a JSON object or array without parsing it into values: whole values under secret-named
 * keys (strings and numbers inside them, and keys there that are values rather than field names,
 * like the session IDs of `{"sessions":{"<id>":{…}}}`; booleans and null stay), JSON, URLs, token
 * shapes, secret pairs and random-looking values inside the other strings, and token-shaped or
 * random keys. Every other byte stays as it was. Null when the text is not a JSON object or array.
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
  const plainIds = (top: Frame | undefined) => !!top && (top.object ? isIdName(top.key) : top.ids)
  const random = !inner.code && !inner.noEntropy
  while (tokens.next()) {
    const top = stack[stack.length - 1] as Frame | undefined
    const { type, start, end } = tokens
    if (type === '{' || type === '[') {
      stack.push({ object: type === '{', expectKey: type === '{', secret: inSecret(top), valueSecret: false, maskedKeys: 0, key: '', ids: plainIds(top) })
    } else if (type === '}' || type === ']') {
      stack.pop()
    } else if (type === ',') {
      if (top?.object) top.expectKey = true
    } else if (type === 'string') {
      const literal = text.slice(start, end)
      const value = literal.includes('\\') ? (JSON.parse(literal) as string) : literal.slice(1, -1)
      if (top?.object && top.expectKey) {
        top.expectKey = false
        top.key = value
        top.valueSecret = top.secret || isSecretName(value, inner)
        let key = maskTokens(value, counter, kind)
        if (key === value && value && value !== MASK && top.secret && !isFieldName(value)) {
          counter.add(kind)
          key = MASK
        } else if (random) key = maskRandom(key, counter, kind)
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
        const ids = plainIds(top)
        const masked = maskJsonString(value, counter, kind, ids ? { ...inner, noEntropy: true } : inner, encodable)
        if (masked !== value) replace(start, end, jsonStringLike(masked, literal, encodable))
        else if (ids) learnId(counter, value)
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

/**
 * A string inside JSON: JSON in it masked as JSON, text over several lines as a body of its own
 * (a STOMP frame, server-sent events, NDJSON), a URL as a URL, anything else as text.
 */
function maskJsonString(value: string, counter: Counter, kind: MaskKind, options: MaskOptions, encodable?: Encodable): string {
  if (value.length < 6) return value
  const depth = options.depth ?? 0
  if (depth < MAX_DEPTH) {
    const first = firstChar(value)
    if (first === '{' || first === '[') {
      const json = maskJsonText(value, counter, kind, { ...options, depth: depth + 1 }, encodable)
      if (json !== null) return json
    }
    if (value.includes('\n') || maskFramedLike(value)) return maskBodyText(value, '', counter, kind, { ...options, depth: depth + 1 }, encodable)
  }
  return maskFreeText(value, counter, kind, options)
}

/** A string that may be a JSON-carrying frame on its own (`42[…]`, `a[…]`). */
function maskFramedLike(value: string): boolean {
  const c = value.charCodeAt(0)
  return (c >= 0x30 && c <= 0x39 && /^\d{1,3}[^\s]{0,40}[[{]/.test(value)) || ((c === 0x61 || c === 0x63) && value.charCodeAt(1) === 0x5b)
}

setJsonMasker((text, counter, kind, options) => maskJsonText(text, counter, kind, options))

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
  const parts = options.parts ?? 0
  if (baseMime(mimeType).startsWith('multipart/') && parts >= MAX_PARTS) {
    counter.add(kind)
    return new TextEncoder().encode(MASK)
  }
  if (baseMime(mimeType).startsWith('multipart/') && parts < MAX_PARTS) {
    // Binary parts must survive byte for byte, so the parts are found in a byte string.
    const text = BYTE_STRING.decode(bytes)
    const boundary = boundaryOf(mimeType, text)
    if (boundary) {
      const inner: MaskOptions = { ...options, parts: parts + 1 }
      const out = maskMultipart(text, boundary, counter, kind, inner, (part, type) => {
        const partBytes = BYTE_STRING.encode(part)
        const masked = maskBodyBytes(partBytes, type || 'text/plain', counter, kind, inner)
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

/** The WHATWG encoding a charset label names (`unicode`, `ucs-2` → utf-16le), or '' for none. */
export function encodingOf(label: string): string {
  try {
    return new TextDecoder(label).encoding
  } catch {
    return ''
  }
}

/**
 * Decodes by the declared charset (any WHATWG label), as the viewer does; a byte order mark beats
 * the label. UTF-16 is read code unit by code unit, so lone surrogates and an odd last byte
 * survive; UTF-8 that is not valid, and charsets that do not round-trip, are read byte for byte.
 */
function decodeForMasking(bytes: Uint8Array, mimeType: string): Decoded {
  const match = /charset\s*=\s*"?([\w.:-]+)/i.exec(mimeType)
  const encoding = sniffBom(bytes) ?? (match ? encodingOf(match[1]) : 'utf-8')
  if (encoding === 'utf-8') {
    try {
      // The byte order mark stays in the text, so it is written back.
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      return { text, encode: (t) => new TextEncoder().encode(t) }
    } catch {
      return byteString(bytes)
    }
  }
  if (encoding === 'utf-16le' || encoding === 'utf-16be') return utf16(bytes, encoding === 'utf-16be')
  const single = encoding ? singleByte(encoding) : null
  if (single) return { text: single.decode(bytes), encode: single.encode, encodable: single.encodable }
  return byteString(bytes)
}

/** UTF-16 as code units, lossless: unpaired surrogates stay, and so does an odd last byte. */
function utf16(bytes: Uint8Array, big: boolean): Decoded {
  const units = bytes.length >> 1
  let text = ''
  const chunk = new Uint16Array(Math.min(units, 0x8000))
  for (let at = 0; at < units; at += 0x8000) {
    const end = Math.min(units, at + 0x8000)
    for (let i = at; i < end; i++) chunk[i - at] = big ? (bytes[2 * i] << 8) | bytes[2 * i + 1] : bytes[2 * i] | (bytes[2 * i + 1] << 8)
    text += String.fromCharCode.apply(null, Array.from(chunk.subarray(0, end - at)))
  }
  const odd = bytes.length % 2 ? bytes[bytes.length - 1] : -1
  return {
    text,
    encode: (t) => {
      const out = encodeUtf16(t, big)
      if (odd < 0) return out
      const all = new Uint8Array(out.length + 1)
      all.set(out)
      all[out.length] = odd
      return all
    }
  }
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
