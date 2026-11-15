// Masks known secret patterns in a HAR before it is shown, copied, exported or saved: credential
// headers, cookies, secret-named parameters, fields and JSON keys, OAuth codes in OAuth flows,
// and token shapes in every remaining piece of text, from bodies and WebSocket frames to page
// titles, comments and vendor fields, and values that look random wherever they are. Pattern-based:
// it errs on the side of masking, and a sanitized file still deserves a read before it is shared.
// An entry that cannot be masked has all of its text replaced. The input is never modified.
//
// The layers: mask-text.ts (names, token shapes, free text), mask-url.ts (URLs, parameter lists,
// free-text fields), mask-body.ts (JSON in place, forms, multipart, frames, byte bodies).

import { decodeBase64, encodeBase64, isTextBody } from './body'
import { splitSetCookie } from './headers'
import { maskBodyBytes, maskBodyText } from './mask-body'
import { MASK, QUIET, isSensitiveName, maskText, type Counter, type MaskKind, type MaskOptions } from './mask-text'
import { blankStrings, isOauthUrl, maskOtherFields, maskParams, maskStrings, maskUrl } from './mask-url'
import type { Har, HarCookie, HarEntry, HarNameValue, HarPage, HarPostData, HarResponse, HarWebSocketMessage } from './types'

export { MASK, isSensitiveName, maskText, maskUrl, maskBodyText, maskBodyBytes, type Counter, type MaskKind }
export { maskJsonText } from './mask-body'
export { maskFreeText } from './mask-url'
export { splitSetCookie } from './headers'

export type SanitizeReport = Record<MaskKind, number> & {
  total: number
  /** Indexes of the entries with at least one masked value. */
  entries: Set<number>
  /** Indexes of the entries masking failed on, whose text was all replaced with `[masked]`. */
  failed: Set<number>
}

export function emptyReport(): SanitizeReport {
  return { total: 0, headers: 0, cookies: 0, query: 0, bodies: 0, other: 0, entries: new Set(), failed: new Set() }
}

// ── Headers and cookies ──────────────────────────────────────────────────────────────────────

const URL_HEADERS = new Set(['referer', 'location', 'content-location', 'origin', ':path', 'refresh'])

/**
 * Headers whose random-looking values identify a request, a trace or a resource version, or
 * describe content (ETags, digests, CSP hashes, WebSocket handshakes): no catch-all on them.
 */
const ID_HEADER =
  /request-?id|requestid|trace|span|correlation|^etag$|^if-(?:none-)?match$|^if-range$|^cf-ray$|digest|md5|hash|^sec-websocket-|content-security-policy|^x-served-by$|^via$|^server-timing$|^x-cache|^x-amz-id-2$|^x-amz-cf-id$|^x-vercel-id$|^x-amzn-requestid$|^nel$|^report-to$/

export function maskHeaderValue(name: string, value: string, counter: Counter, options: MaskOptions = {}): string {
  const lower = name.toLowerCase()
  if (typeof value !== 'string' || !value) return value
  if (lower === 'cookie') return maskCookieHeader(value, counter)
  if (lower === 'set-cookie') return value.split('\n').map((line) => splitSetCookie(line).map((one) => maskSetCookie(one, counter)).join('')).join('\n')
  if (lower === 'link') return value.replace(/<([^<>]*)>/g, (_, url: string) => `<${maskUrl(url, counter, 'headers', options)}>`)
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
  return maskText(value, counter, 'headers', ID_HEADER.test(lower) ? { ...options, noEntropy: true } : options)
}

/** `a=1; b=2` → `a=[masked]; b=[masked]`; a value without a name (`Cookie: abc`) is masked too. */
export function maskCookieHeader(value: string, counter: Counter): string {
  return value
    .split(';')
    .map((pair) => {
      const eq = pair.indexOf('=')
      const v = (eq < 0 ? pair : pair.slice(eq + 1)).trim()
      if (!v || v === MASK) return pair
      counter.add('cookies')
      if (eq < 0) return pair.replace(v, MASK)
      return `${pair.slice(0, eq)}=${MASK}`
    })
    .join(';')
}

/**
 * `id=abc; Path=/; HttpOnly` → `id=[masked]; Path=/; HttpOnly`; a cookie without a name
 * (`abc; Path=/`) has its value masked too. The attributes stay.
 */
export function maskSetCookie(line: string, counter: Counter): string {
  const semi = line.indexOf(';')
  let first = semi < 0 ? line : line.slice(0, semi)
  // The comma a folded value ends with belongs to no cookie.
  let tail = semi < 0 ? '' : line.slice(semi)
  if (semi < 0 && first.endsWith(',')) {
    first = first.slice(0, -1)
    tail = ','
  }
  const eq = first.indexOf('=')
  const value = (eq < 0 ? first : first.slice(eq + 1)).trim()
  if (!value || value === MASK) return line
  counter.add('cookies')
  if (eq < 0) return `${first.replace(value, MASK)}${tail}`
  return `${first.slice(0, eq)}=${MASK}${tail}`
}

/** Names of headers whose whole value is a credential. */
const CREDENTIAL_HEADERS = new Set(['cookie', 'set-cookie', 'authorization', 'proxy-authorization'])

function maskHeaders(headers: HarNameValue[] | undefined, counter: Counter, options: MaskOptions): HarNameValue[] | undefined {
  // Headers of another shape (`{"Authorization": "…"}`): every string in it, by name.
  if (!Array.isArray(headers)) return headers === undefined ? headers : (maskStrings(headers, counter, 'headers') as HarNameValue[])
  let changed = false
  const out = headers.map((header) => {
    if (!header || typeof header !== 'object') return maskStrings(header, counter, 'headers') as HarNameValue
    let next = header
    const name = String(header.name ?? '')
    if (typeof header.value === 'string') {
      const value = maskHeaderValue(name, header.value, counter, options)
      if (value !== header.value) next = { ...header, value }
    } else if (header.value !== undefined) {
      // A value of another type (an array of values, a number): its strings, all of them for a credential.
      const lower = name.toLowerCase()
      const value = CREDENTIAL_HEADERS.has(lower) || isSensitiveName(lower) ? blankStrings(header.value, counter, 'headers') : maskStrings(header.value, counter, 'headers')
      if (value !== header.value) next = { ...header, value: value as string }
    }
    next = maskOtherFields(next, ['name', 'value'], counter)
    if (next !== header) changed = true
    return next
  })
  return changed ? out : headers
}

function maskCookies(cookies: HarCookie[] | undefined, counter: Counter): HarCookie[] | undefined {
  // Every cookie value is a secret, whatever the shape of the list.
  if (!Array.isArray(cookies)) return cookies === undefined ? cookies : (blankStrings(cookies, counter, 'cookies') as HarCookie[])
  let changed = false
  const out = cookies.map((cookie) => {
    if (!cookie || typeof cookie !== 'object') return blankStrings(cookie, counter, 'cookies') as HarCookie
    let next = cookie
    if (typeof cookie.value === 'string' && cookie.value && cookie.value !== MASK) {
      counter.add('cookies')
      next = { ...cookie, value: MASK }
    } else if (cookie.value !== undefined && typeof cookie.value !== 'string') {
      next = { ...cookie, value: blankStrings(cookie.value, counter, 'cookies') as string }
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
  if (!holder || typeof holder !== 'object') return holder === undefined ? holder : (maskStrings(holder, counter, 'bodies') as T)
  let out = holder
  if (holder.text !== undefined && typeof holder.text !== 'string') {
    // A body of another type (a parsed object): every string in it, by key.
    const text = maskStrings(holder.text, counter, 'bodies')
    if (text !== holder.text) out = { ...holder, text: text as string }
  } else if (typeof holder.text === 'string' && holder.text) {
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
  if (!post || typeof post !== 'object') return post === undefined ? post : (maskStrings(post, counter, 'bodies') as HarPostData)
  // The fields repeat the text when both are there: the text counts.
  const params = maskParams(post.params as HarNameValue[] | undefined, typeof post.text === 'string' ? QUIET : counter, 'bodies', options)
  const withText = maskInlineBody(post, counter, options) ?? post
  return params === post.params ? withText : { ...withText, params: params as HarPostData['params'] }
}

/** A WebSocket frame: text frames as text, binary frames when their bytes are text. */
function maskFrame(message: HarWebSocketMessage, counter: Counter, options: MaskOptions): HarWebSocketMessage {
  if (!message || typeof message !== 'object') return maskStrings(message, counter, 'bodies') as HarWebSocketMessage
  let out = message
  if (message.data !== undefined && typeof message.data !== 'string') {
    const data = maskStrings(message.data, counter, 'bodies')
    if (data !== message.data) out = { ...message, data: data as string }
  } else if (typeof message.data === 'string' && message.data) {
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
        if (field === 'url') return typeof item === 'string' ? maskUrl(item, counter, 'query') : maskStrings(item, counter)
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
        if (field === 'redirectURL') return typeof item === 'string' ? maskUrl(item, counter, 'headers') : maskStrings(item, counter)
        return undefined
      }, counter)
    } else if (key === '_webSocketMessages' && Array.isArray(value)) {
      out[key] = value.map((message) => maskFrame(message as HarWebSocketMessage, counter, options))
    } else if (key === 'request' || key === 'response') {
      out[key] = maskStrings(value, counter)
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

/** Fields a wholesale-masked entry keeps: they say what the request was, not what it carried. */
const KEPT_WHEN_BLANKED = new Set(['startedDateTime', 'pageref', 'method', 'httpVersion', 'statusText', 'mimeType', 'encoding', 'name', 'type', 'serverIPAddress'])

/**
 * An entry masking failed on: every string and number in it replaced with `[masked]`, except the
 * fields that say what the request was (method, status, timings, header names), and the URL cut
 * to its origin. A comment says why.
 */
export function blankEntry(entry: HarEntry, reason: string): HarEntry {
  const blank = (value: unknown, key: string, depth: number): unknown => {
    if (typeof value === 'string') return !value || KEPT_WHEN_BLANKED.has(key) ? value : MASK
    if (typeof value !== 'object' || value === null || depth > 256) return value
    if (Array.isArray(value)) return value.map((item) => blank(item, key, depth + 1))
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Numbers are sizes, times and statuses, except under secret names.
      out[k] = typeof v === 'number' && isSensitiveName(k) ? MASK : blank(v, k, depth + 1)
    }
    return out
  }
  const out = blank(entry, '', 0) as HarEntry & { request?: { url?: unknown } }
  const url = typeof entry.request?.url === 'string' ? entry.request.url : ''
  if (out.request && typeof out.request === 'object') {
    let origin = MASK
    try {
      origin = `${new URL(url).origin}/${MASK}`
    } catch {
      // Not a URL: masked whole.
    }
    out.request.url = origin
  }
  out.comment = `HAR Viewer could not mask this request (${reason}), so every value in it was replaced with ${MASK}.`
  return out
}

function reasonOf(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 200)
}

/** A masked copy of the HAR and what was masked. */
export function sanitizeHar(har: Har): { har: Har; report: SanitizeReport } {
  const steps = sanitizeSteps(har)
  for (;;) {
    const next = steps.next()
    if (next.done) return next.value
  }
}

/** Entries masked between two progress reports of `sanitizeSteps`. */
const STEP_ENTRIES = 64

/**
 * `sanitizeHar` in steps: yields the share of entries done (0 to 1) every few entries, so a caller
 * can let the page paint and show progress; returns the masked copy and the report.
 */
export function* sanitizeSteps(har: Har): Generator<number, { har: Har; report: SanitizeReport }> {
  const report = emptyReport()
  let current = -1
  const counter: Counter = {
    add(kind, count = 1) {
      report[kind] += count
      report.total += count
      if (current >= 0) report.entries.add(current)
    }
  }
  const source = Array.isArray(har.log.entries) ? har.log.entries : []
  const entries: HarEntry[] = []
  for (let index = 0; index < source.length; index++) {
    current = index
    const entry = source[index]
    try {
      entries.push(sanitizeEntry(entry, counter))
    } catch (error) {
      // Never silently: the entry is masked wholesale and the report says so.
      report.failed.add(index)
      report.entries.add(index)
      entries.push(blankEntry(entry, reasonOf(error)))
    }
    if (index % STEP_ENTRIES === STEP_ENTRIES - 1) yield (index + 1) / (source.length + 1)
  }
  current = -1
  const safely = (value: unknown, mask: () => unknown) => {
    try {
      return mask()
    } catch {
      return blankStrings(value, counter)
    }
  }
  // Page titles are often the page's URL (Chrome writes it there), so they are masked as URLs.
  const pages = Array.isArray(har.log.pages)
    ? har.log.pages.map((page: HarPage) => safely(page, () => maskStrings(page, counter)) as HarPage)
    : har.log.pages
  const log: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(har.log)) {
    if (key === 'entries') log.entries = entries
    else if (key === 'pages') log.pages = pages
    else if (key === 'version') log[key] = value
    else if ((key === 'creator' || key === 'browser') && value && typeof value === 'object' && !Array.isArray(value)) {
      log[key] = safely(value, () => maskOtherFields(value as Record<string, unknown>, ['name', 'version'], counter))
    } else log[key] = safely(value, () => maskStrings(value, counter))
  }
  if (!('entries' in log)) log.entries = entries
  return { har: { ...har, log: log as Har['log'] }, report }
}
