// Masks known secret patterns in a HAR before it is shown, copied, exported or saved: credential
// headers, cookies, secret-named parameters, fields and JSON keys, OAuth codes in OAuth flows,
// and token shapes in every remaining piece of text, from bodies and WebSocket frames to page
// titles, comments and vendor fields. Pattern-based: it errs on the side of masking, and a
// sanitized file still deserves a read before it is shared. The input is never modified.
//
// The layers: mask-text.ts (names, token shapes, free text), mask-url.ts (URLs, parameter lists,
// free-text fields), mask-body.ts (JSON in place, forms, multipart, frames, byte bodies).

import { decodeBase64, encodeBase64, isTextBody } from './body'
import { maskBodyBytes, maskBodyText } from './mask-body'
import { MASK, QUIET, isSensitiveName, maskText, type Counter, type MaskKind, type MaskOptions } from './mask-text'
import { isOauthUrl, maskOtherFields, maskParams, maskStrings, maskUrl } from './mask-url'
import type { Har, HarCookie, HarEntry, HarNameValue, HarPage, HarPostData, HarResponse, HarWebSocketMessage } from './types'

export { MASK, isSensitiveName, maskText, maskUrl, maskBodyText, maskBodyBytes, type Counter, type MaskKind }
export { maskJsonText } from './mask-body'
export { maskFreeText } from './mask-url'

export type SanitizeReport = Record<MaskKind, number> & {
  total: number
  /** Indexes of the entries with at least one masked value. */
  entries: Set<number>
}

// ── Headers and cookies ──────────────────────────────────────────────────────────────────────

const URL_HEADERS = new Set(['referer', 'location', 'content-location', 'origin', ':path', 'link', 'refresh'])

export function maskHeaderValue(name: string, value: string, counter: Counter, options: MaskOptions = {}): string {
  const lower = name.toLowerCase()
  if (typeof value !== 'string' || !value) return value
  if (lower === 'cookie') return maskCookieHeader(value, counter)
  if (lower === 'set-cookie') return value.split('\n').map((line) => maskSetCookie(line, counter)).join('\n')
  if (lower === 'authorization' || lower === 'proxy-authorization') {
    if (value === MASK) return value
    counter.add('headers')
    const space = value.indexOf(' ')
    return space > 0 && /^[A-Za-z-]+$/.test(value.slice(0, space)) ? `${value.slice(0, space)} ${MASK}` : MASK
  }
  if (isSensitiveName(lower)) {
    if (value === MASK || value.endsWith(` ${MASK}`)) return value
    counter.add('headers')
    return MASK
  }
  // `:path` repeats the request URL, which is counted already.
  if (URL_HEADERS.has(lower)) return maskUrl(value, lower === ':path' ? QUIET : counter, 'headers', options)
  return maskText(value, counter, 'headers', options)
}

/** `a=1; b=2` → `a=[masked]; b=[masked]`. */
export function maskCookieHeader(value: string, counter: Counter): string {
  return value
    .split(';')
    .map((pair) => {
      const eq = pair.indexOf('=')
      if (eq < 0) return pair
      const v = pair.slice(eq + 1).trim()
      if (!v || v === MASK) return pair
      counter.add('cookies')
      return `${pair.slice(0, eq)}=${MASK}`
    })
    .join(';')
}

/** `id=abc; Path=/; HttpOnly` → `id=[masked]; Path=/; HttpOnly`. */
export function maskSetCookie(line: string, counter: Counter): string {
  const semi = line.indexOf(';')
  const first = semi < 0 ? line : line.slice(0, semi)
  const eq = first.indexOf('=')
  if (eq < 0) return line
  const value = first.slice(eq + 1).trim()
  if (!value || value === MASK) return line
  counter.add('cookies')
  return `${first.slice(0, eq)}=${MASK}${semi < 0 ? '' : line.slice(semi)}`
}

function maskHeaders(headers: HarNameValue[] | undefined, counter: Counter, options: MaskOptions): HarNameValue[] | undefined {
  if (!Array.isArray(headers)) return headers
  let changed = false
  const out = headers.map((header) => {
    if (!header || typeof header !== 'object') return header
    let next = header
    if (typeof header.value === 'string') {
      const value = maskHeaderValue(String(header.name ?? ''), header.value, counter, options)
      if (value !== header.value) next = { ...header, value }
    }
    next = maskOtherFields(next, ['name', 'value'], counter)
    if (next !== header) changed = true
    return next
  })
  return changed ? out : headers
}

function maskCookies(cookies: HarCookie[] | undefined, counter: Counter): HarCookie[] | undefined {
  if (!Array.isArray(cookies)) return cookies
  let changed = false
  const out = cookies.map((cookie) => {
    if (!cookie || typeof cookie !== 'object') return cookie
    let next = cookie
    if (typeof cookie.value === 'string' && cookie.value && cookie.value !== MASK) {
      counter.add('cookies')
      next = { ...cookie, value: MASK }
    }
    next = maskOtherFields(next, ['name', 'value', 'path', 'domain', 'expires', 'httpOnly', 'secure', 'sameSite'], counter)
    if (next !== cookie) changed = true
    return next
  })
  return changed ? out : cookies
}

// ── Bodies ───────────────────────────────────────────────────────────────────────────────────

const BODY_FIELDS = ['text', 'encoding', 'mimeType', 'size', 'compression', '_file', 'params']

/**
 * A body stored inline: text is masked as text; base64 is decoded and masked whenever the viewer
 * would show it as text (`isTextBody`), then encoded back the way it came. Its other fields
 * (comments, vendor fields) are masked as free text.
 */
function maskInlineBody<T extends { text?: string; encoding?: string; mimeType?: string }>(
  holder: T | undefined,
  counter: Counter,
  options: MaskOptions
): T | undefined {
  if (!holder || typeof holder !== 'object') return holder
  let out = holder
  if (typeof holder.text === 'string' && holder.text) {
    const mimeType = typeof holder.mimeType === 'string' ? holder.mimeType : ''
    let text = holder.text
    if (holder.encoding === 'base64') {
      const bytes = decodeBase64(holder.text)
      // Text that is not valid base64 is shown as it is, so it is masked as it is.
      if (!bytes) text = maskBodyText(holder.text, mimeType, counter, 'bodies', options)
      else {
        const masked = maskBodyBytes(bytes, mimeType, counter, 'bodies', options)
        if (masked !== bytes) text = encodeBase64(masked)
      }
    } else text = maskBodyText(holder.text, mimeType, counter, 'bodies', options)
    if (text !== holder.text) out = { ...holder, text }
  }
  return maskOtherFields(out, BODY_FIELDS, counter)
}

/** A body file of a .har.zip, masked by the same rule as inline bodies. */
export function sanitizeSideFile(bytes: Uint8Array, mimeType: string, counter: Counter, options: MaskOptions = {}): Uint8Array {
  return maskBodyBytes(bytes, mimeType, counter, 'bodies', options)
}

function maskPostData(post: HarPostData | undefined, counter: Counter, options: MaskOptions): HarPostData | undefined {
  if (!post || typeof post !== 'object') return post
  // The fields repeat the text when both are there: the text counts.
  const params = maskParams(post.params as HarNameValue[] | undefined, typeof post.text === 'string' ? QUIET : counter, 'bodies', options)
  const withText = maskInlineBody(post, counter, options) ?? post
  return params === post.params ? withText : { ...withText, params: params as HarPostData['params'] }
}

/** A WebSocket frame: text frames as text, binary frames when their bytes are text. */
function maskFrame(message: HarWebSocketMessage, counter: Counter, options: MaskOptions): HarWebSocketMessage {
  if (!message || typeof message !== 'object') return message
  let out = message
  if (typeof message.data === 'string' && message.data) {
    let data = message.data
    if (message.opcode === 2) {
      const bytes = decodeBase64(message.data)
      if (!bytes) data = maskBodyText(message.data, '', counter, 'bodies', options)
      else if (isTextBody(bytes, '')) {
        const masked = maskBodyBytes(bytes, '', counter, 'bodies', options)
        if (masked !== bytes) data = encodeBase64(masked)
      }
    } else data = maskBodyText(message.data, '', counter, 'bodies', options)
    if (data !== message.data) out = { ...message, data }
  }
  return maskOtherFields(out, ['type', 'time', 'opcode', 'data'], counter)
}

// ── Whole entries ────────────────────────────────────────────────────────────────────────────

const PLAIN_ENTRY_KEYS = new Set(['startedDateTime', 'time', 'pageref', 'serverIPAddress', 'connection'])
const PLAIN_MESSAGE_KEYS = new Set(['method', 'httpVersion', 'headersSize', 'bodySize', 'status', 'statusText'])

export function sanitizeEntry(entry: HarEntry, counter: Counter): HarEntry {
  const out: Record<string, unknown> = {}
  const raw = entry as Record<string, unknown>
  const url = typeof entry.request?.url === 'string' ? entry.request.url : ''
  const options: MaskOptions = { oauth: isOauthUrl(url) }
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'request' && value && typeof value === 'object') {
      out.request = maskMessage(value as Record<string, unknown>, (field, item) => {
        if (field === 'url') return typeof item === 'string' ? maskUrl(item, counter, 'query') : item
        if (field === 'headers') return maskHeaders(item as HarNameValue[], counter, options)
        if (field === 'cookies') return maskCookies(item as HarCookie[], counter)
        // Mirrors the URL, which is counted already.
        if (field === 'queryString') return maskParams(item as HarNameValue[], QUIET, 'query', options)
        if (field === 'postData') return maskPostData(item as HarPostData, counter, options)
        return undefined
      }, counter)
    } else if (key === 'response' && value && typeof value === 'object') {
      out.response = maskMessage(value as Record<string, unknown>, (field, item) => {
        if (field === 'headers') return maskHeaders(item as HarNameValue[], counter, options)
        if (field === 'cookies') return maskCookies(item as HarCookie[], counter)
        if (field === 'content') return maskInlineBody(item as HarResponse['content'], counter, options)
        if (field === 'redirectURL') return typeof item === 'string' ? maskUrl(item, counter, 'headers') : item
        return undefined
      }, counter)
    } else if (key === '_webSocketMessages' && Array.isArray(value)) {
      out[key] = value.map((message) => maskFrame(message as HarWebSocketMessage, counter, options))
    } else if (PLAIN_ENTRY_KEYS.has(key)) {
      out[key] = value
    } else {
      // timings (and their comment), _initiator, comment and every vendor field.
      out[key] = maskStrings(value, counter)
    }
  }
  return out as HarEntry
}

/**
 * A request or response: the fields `special` handles (it returns undefined for the others),
 * plain fields as they are, and everything else as free text.
 */
function maskMessage(
  message: Record<string, unknown>,
  special: (field: string, value: unknown) => unknown,
  counter: Counter
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(message)) {
    if (PLAIN_MESSAGE_KEYS.has(field)) {
      out[field] = value
      continue
    }
    const handled = special(field, value)
    out[field] = handled !== undefined || value === undefined ? handled : maskStrings(value, counter)
  }
  return out
}

/** A masked copy of the HAR and what was masked. */
export function sanitizeHar(har: Har): { har: Har; report: SanitizeReport } {
  const report: SanitizeReport = { total: 0, headers: 0, cookies: 0, query: 0, bodies: 0, other: 0, entries: new Set() }
  let current = -1
  const counter: Counter = {
    add(kind, count = 1) {
      report[kind] += count
      report.total += count
      if (current >= 0) report.entries.add(current)
    }
  }
  const entries = (har.log.entries ?? []).map((entry, index) => {
    current = index
    return sanitizeEntry(entry, counter)
  })
  current = -1
  // Page titles are often the page's URL (Chrome writes it there), so they are masked as URLs.
  const pages = har.log.pages?.map((page: HarPage) => maskStrings(page, counter) as HarPage)
  const log: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(har.log)) {
    if (key === 'entries') log.entries = entries
    else if (key === 'pages') log.pages = pages
    else if (key === 'creator' || key === 'browser' || key === 'version') log[key] = value
    else log[key] = maskStrings(value, counter)
  }
  if (!('entries' in log)) log.entries = entries
  return { har: { ...har, log: log as Har['log'] }, report }
}
