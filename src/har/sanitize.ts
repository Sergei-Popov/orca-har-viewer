// Masks secrets in a HAR before it is shown, copied, exported or saved: credentials headers,
// cookies, keys and tokens in URLs, form fields, JSON bodies and WebSocket frames, and
// token-shaped values anywhere (JWTs, `sk-…`, GitHub, Slack, AWS, Google, Stripe keys, private
// keys). It errs on the side of masking. The input is never modified.

import { baseMime, decodeBase64, decodeText, encodeBase64, isTextual, parseJson } from './body'
import type { Har, HarCookie, HarEntry, HarNameValue, HarPage, HarPostData, HarResponse } from './types'

export const MASK = '[masked]'

export type MaskKind = 'headers' | 'cookies' | 'query' | 'bodies' | 'other'

export type SanitizeReport = Record<MaskKind, number> & {
  total: number
  /** Indexes of the entries with at least one masked value. */
  entries: Set<number>
}

export type Counter = { add(kind: MaskKind, count?: number): void }

/** Masks without counting, for values that repeat ones counted elsewhere. */
const QUIET: Counter = { add: () => undefined }

// ── Names ────────────────────────────────────────────────────────────────────────────────────

const SENSITIVE_PARTS = [
  'authorization',
  'authentication',
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'accesskey',
  'privatekey',
  'credential',
  'session',
  'sessid',
  'cookie',
  'csrf',
  'xsrf',
  'signature',
  'bearer',
  'jwt',
  'otp'
]
const SENSITIVE_EXACT = new Set(['auth', 'pwd', 'pass', 'key', 'sig', 'sid', 'pin', 'ssn', 'cvv', 'cvc'])
const SENSITIVE_SUFFIXES = ['key', 'auth', 'pwd', 'sid']
const NOT_SENSITIVE = new Set([
  'secwebsocketkey',
  'secwebsocketaccept',
  'secwebsocketextensions',
  'tokentype',
  'keyboard',
  'monkey',
  'turkey',
  'hotkey',
  'otpauth'
])

/** Whether a header, cookie, field or JSON key with this name holds a secret. */
export function isSensitiveName(name: string): boolean {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!n || NOT_SENSITIVE.has(n)) return false
  if (SENSITIVE_EXACT.has(n)) return true
  for (const part of SENSITIVE_PARTS) if (n.includes(part)) return true
  for (const suffix of SENSITIVE_SUFFIXES) if (n.length > suffix.length && n.endsWith(suffix)) return true
  return false
}

// ── Free text ────────────────────────────────────────────────────────────────────────────────

/** Token shapes masked wherever they appear. */
const TOKENS = new RegExp(
  [
    '-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)',
    // JWS: base64url JSON header and payload, then a signature.
    'eyJ[A-Za-z0-9_-]{4,}\\.eyJ[A-Za-z0-9_-]{4,}\\.[A-Za-z0-9_-]*',
    // OpenAI, Anthropic, DeepSeek and similar: sk-…, sk-proj-…, sk-ant-…
    '\\bsk-[A-Za-z0-9_-]{16,}',
    '\\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}',
    '\\bwhsec_[A-Za-z0-9+/=]{16,}',
    '\\bgh[pousr]_[A-Za-z0-9]{30,}',
    '\\bgithub_pat_[A-Za-z0-9_]{20,}',
    '\\bglpat-[A-Za-z0-9_-]{20,}',
    '\\bxox[abposr]-[A-Za-z0-9-]{10,}',
    '\\b(?:AKIA|ASIA)[A-Z0-9]{16}\\b',
    '\\bAIza[0-9A-Za-z_-]{35}',
    '\\bya29\\.[0-9A-Za-z_-]{20,}',
    '\\bnpm_[A-Za-z0-9]{36}\\b',
    '\\bhf_[A-Za-z0-9]{30,}\\b',
    '\\bSG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}',
    '\\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}\\b'
  ].join('|'),
  'g'
)
/** `Bearer abc…`, `Basic dXNl…`: the scheme stays. */
const AUTH_SCHEME = /\b(Bearer|Basic|Digest|Token|Negotiate)(\s+)([A-Za-z0-9._~+/-]{8,}=*)/g
/** `scheme://user:password@host`: the user stays. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/?#@:"'<>]+):([^\s/?#@"'<>]+)@/gi
/** `?name=value`, `&name=value`, `#name=value` in URLs and text. */
const URL_PARAM = /([?&#;])([^=&#\s"'<>?]{1,64})=([^&#\s"'<>]+)/g
/** `"password": "…"`, `token = '…'`, `apiKey: \`…\`` in code, logs and broken JSON. */
const QUOTED_PAIR = /(["'`]?)([A-Za-z_$][\w$.-]{0,63})\1(\s*[:=]\s*)(["'`])((?:\\.|(?!\4)[^\\\r\n]){1,4096})\4/g
/** `<meta name="csrf-token" content="…">`, `<input name="authenticity_token" value="…">`. */
const HTML_TAG = /<(?:meta|input)\b[^>]*>/gi
const HTML_NAME = /\b(?:name|property|id)\s*=\s*(["'])(.*?)\1/i
const HTML_VALUE = /(\b(?:content|value)\s*=\s*)(["'])(.*?)\2/i

/** Masks token-shaped values, credentials in URLs and secret-named pairs in any text. */
export function maskText(text: string, counter: Counter, kind: MaskKind = 'other'): string {
  if (text.length < 6) return text
  // replace() with a global pattern always starts from the beginning.
  let out = text.replace(TOKENS, () => {
    counter.add(kind)
    return MASK
  })
  out = out.replace(AUTH_SCHEME, (match, scheme: string, space: string, value: string) => {
    if (!/[0-9]/.test(value) && !/[A-Z].*[a-z]|[a-z].*[A-Z]/.test(value)) return match
    counter.add(kind)
    return `${scheme}${space}${MASK}`
  })
  out = out.replace(URL_PASSWORD, (match, scheme: string, user: string) => {
    counter.add(kind)
    return `${scheme}${user}:${MASK}@`
  })
  if (out.includes('=')) {
    out = out.replace(URL_PARAM, (match, lead: string, name: string, value: string) => {
      if (value === MASK || !isSensitiveName(safeDecode(name))) return match
      counter.add(kind)
      return `${lead}${name}=${MASK}`
    })
  }
  if (out.includes('"') || out.includes("'") || out.includes('`')) {
    out = out.replace(QUOTED_PAIR, (match, q1: string, key: string, sep: string, q2: string, value: string) => {
      if (value === MASK || !isSensitiveName(key.split('.').pop() ?? key)) return match
      counter.add(kind)
      return `${q1}${key}${q1}${sep}${q2}${MASK}${q2}`
    })
  }
  if (out.includes('<')) {
    out = out.replace(HTML_TAG, (tag) => {
      const name = HTML_NAME.exec(tag)
      if (!name || !isSensitiveName(name[2])) return tag
      const value = HTML_VALUE.exec(tag)
      if (!value || !value[3] || value[3] === MASK) return tag
      counter.add(kind)
      return tag.replace(HTML_VALUE, `$1$2${MASK}$2`)
    })
  }
  return out
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '))
  } catch {
    return text
  }
}

// ── URLs and query strings ───────────────────────────────────────────────────────────────────

/** OAuth's one-time `code` counts as a secret on redirect and callback URLs. */
const OAUTH_PATH = /oauth|callback|authori[sz]e|signin|sign-in|login|token/i

/** Masks secret query and fragment parameters, URL passwords and token-shaped path parts. */
export function maskUrl(url: string, counter: Counter, kind: MaskKind = 'query'): string {
  if (!url) return url
  const hashAt = url.indexOf('#')
  const queryAt = url.indexOf('?')
  const baseEnd = Math.min(queryAt >= 0 ? queryAt : url.length, hashAt >= 0 ? hashAt : url.length)
  let base = url.slice(0, baseEnd)
  let query = queryAt >= 0 && (hashAt < 0 || queryAt < hashAt) ? url.slice(queryAt + 1, hashAt >= 0 ? hashAt : url.length) : null
  let hash = hashAt >= 0 ? url.slice(hashAt + 1) : null
  const oauth = OAUTH_PATH.test(base) || /(?:^|&)state=/.test(query ?? '') || /(?:^|&)state=/.test(hash ?? '')
  const params = (part: string) =>
    part
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=')
        if (eq <= 0) return pair
        const name = pair.slice(0, eq)
        const value = pair.slice(eq + 1)
        const decoded = safeDecode(name)
        if (value && value !== MASK && (isSensitiveName(decoded) || (oauth && decoded === 'code'))) {
          counter.add(kind)
          return `${name}=${MASK}`
        }
        const masked = maskTokens(value, counter, kind)
        return masked === value ? pair : `${name}=${masked}`
      })
      .join('&')
  if (query !== null) query = params(query)
  if (hash !== null && hash.includes('=')) hash = params(hash)
  base = base.replace(URL_PASSWORD, (match, scheme: string, user: string) => {
    counter.add(kind)
    return `${scheme}${user}:${MASK}@`
  })
  base = maskTokens(base, counter, kind)
  return `${base}${query !== null ? `?${query}` : ''}${hash !== null ? `#${hash}` : ''}`
}

/** Only the token shapes (no name rules), for values whose name was already checked. */
function maskTokens(text: string, counter: Counter, kind: MaskKind): string {
  if (text.length < 16) return text
  return text.replace(TOKENS, () => {
    counter.add(kind)
    return MASK
  })
}

// ── Headers and cookies ──────────────────────────────────────────────────────────────────────

const URL_HEADERS = new Set(['referer', 'location', 'content-location', 'origin', ':path', 'link', 'refresh'])

export function maskHeaderValue(name: string, value: string, counter: Counter): string {
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
    if (value === MASK) return value
    counter.add('headers')
    return MASK
  }
  // `:path` repeats the request URL, which is counted already.
  if (URL_HEADERS.has(lower)) return maskUrl(value, lower === ':path' ? QUIET : counter, 'headers')
  return maskText(value, counter, 'headers')
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

function maskHeaders(headers: HarNameValue[] | undefined, counter: Counter): HarNameValue[] | undefined {
  if (!Array.isArray(headers)) return headers
  return headers.map((header) => {
    if (!header || typeof header.value !== 'string') return header
    const value = maskHeaderValue(String(header.name ?? ''), header.value, counter)
    return value === header.value ? header : { ...header, value }
  })
}

function maskCookies(cookies: HarCookie[] | undefined, counter: Counter): HarCookie[] | undefined {
  if (!Array.isArray(cookies)) return cookies
  return cookies.map((cookie) => {
    if (!cookie || typeof cookie.value !== 'string' || !cookie.value || cookie.value === MASK) return cookie
    counter.add('cookies')
    return { ...cookie, value: MASK }
  })
}

function maskParams(params: HarNameValue[] | undefined, counter: Counter, kind: MaskKind): HarNameValue[] | undefined {
  if (!Array.isArray(params)) return params
  return params.map((param) => {
    if (!param || typeof param.value !== 'string') return param
    if (param.value && param.value !== MASK && isSensitiveName(String(param.name ?? ''))) {
      counter.add(kind)
      return { ...param, value: MASK }
    }
    const value = maskText(param.value, counter, kind)
    return value === param.value ? param : { ...param, value }
  })
}

// ── Bodies ───────────────────────────────────────────────────────────────────────────────────

/** Masks a JSON value: whole values under secret-named keys, token shapes in the other strings. */
export function maskJson(value: unknown, counter: Counter, kind: MaskKind = 'bodies', depth = 0): unknown {
  if (typeof value === 'string') return maskText(value, counter, kind)
  if (typeof value !== 'object' || value === null) return value
  if (depth > 256) {
    counter.add(kind)
    return MASK
  }
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((item) => {
      const next = maskJson(item, counter, kind, depth + 1)
      if (next !== item) changed = true
      return next
    })
    return changed ? out : value
  }
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    let next: unknown
    if (isSensitiveName(key)) next = maskAll(item, counter, kind, depth + 1)
    else next = maskJson(item, counter, kind, depth + 1)
    if (next !== item) changed = true
    out[key] = next
  }
  return changed ? out : value
}

/** Every string and number under a secret-named key. */
function maskAll(value: unknown, counter: Counter, kind: MaskKind, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (!value || value === MASK) return value
    counter.add(kind)
    return MASK
  }
  if (typeof value === 'number') {
    counter.add(kind)
    return MASK
  }
  if (typeof value !== 'object' || depth > 256) {
    counter.add(kind)
    return MASK
  }
  if (Array.isArray(value)) return value.map((item) => maskAll(item, counter, kind, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = maskAll(item, counter, kind, depth + 1)
  return out
}

/** Masks a text body by its type: JSON by key, forms by field, everything by token shape. */
export function maskBodyText(text: string, mimeType: string, counter: Counter, kind: MaskKind = 'bodies'): string {
  if (!text) return text
  const mime = baseMime(mimeType)
  const trimmed = text.trimStart()
  if (mime.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const value = parseJson(text)
    if (value !== undefined && typeof value === 'object' && value !== null) {
      const masked = maskJson(value, counter, kind)
      return masked === value ? text : JSON.stringify(masked, null, indentOf(text))
    }
    if (mime.includes('ndjson') || mime.includes('jsonl') || (mime.includes('json') && text.includes('\n'))) {
      const lines = text.split('\n')
      let changed = false
      const out = lines.map((line) => {
        const value = line.trim() ? parseJson(line) : undefined
        if (value === undefined || typeof value !== 'object' || value === null) return maskText(line, counter, kind)
        const masked = maskJson(value, counter, kind)
        if (masked === value) return line
        changed = true
        return JSON.stringify(masked)
      })
      if (changed) return out.join('\n')
    }
  }
  if (mime === 'application/x-www-form-urlencoded' || (!mime && /^[\w.%+-]+=[^\s]*(&[\w.%+-]+=[^\s]*)*$/.test(text))) {
    return maskForm(text, counter, kind)
  }
  return maskText(text, counter, kind)
}

function indentOf(text: string): number | undefined {
  const match = /^[[{]\r?\n([ \t]+)/.exec(text.trimStart())
  if (!match) return undefined
  return match[1].includes('\t') ? 2 : match[1].length
}

function maskForm(text: string, counter: Counter, kind: MaskKind): string {
  return text
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=')
      if (eq <= 0) return pair
      const name = pair.slice(0, eq)
      const value = pair.slice(eq + 1)
      if (value && value !== MASK && isSensitiveName(safeDecode(name))) {
        counter.add(kind)
        return `${name}=${MASK}`
      }
      const masked = maskTokens(safeDecode(value), counter, kind)
      return masked === safeDecode(value) ? pair : `${name}=${encodeURIComponent(masked).replace(/%5Bmasked%5D/g, MASK)}`
    })
    .join('&')
}

/** A body stored inline (text or base64): masked and stored back the same way. */
function maskInlineBody<T extends { text?: string; encoding?: string; mimeType?: string }>(
  holder: T | undefined,
  counter: Counter
): T | undefined {
  if (!holder || typeof holder.text !== 'string' || !holder.text) return holder
  const mimeType = typeof holder.mimeType === 'string' ? holder.mimeType : ''
  if (holder.encoding === 'base64') {
    if (!isTextual(mimeType)) return holder
    const bytes = decodeBase64(holder.text)
    if (!bytes) return holder
    const text = decodeText(bytes, charsetOf(mimeType))
    const masked = maskBodyText(text, mimeType, counter)
    if (masked === text) return holder
    return { ...holder, text: encodeBase64(new TextEncoder().encode(masked)), mimeType: withUtf8(mimeType) }
  }
  const masked = maskBodyText(holder.text, mimeType, counter)
  return masked === holder.text ? holder : { ...holder, text: masked }
}

function charsetOf(mimeType: string): string {
  const match = /charset\s*=\s*"?([\w.:-]+)/i.exec(mimeType)
  return match ? match[1] : 'utf-8'
}

function withUtf8(mimeType: string): string {
  return /charset=/i.test(mimeType) ? mimeType.replace(/charset\s*=\s*"?[\w.:-]+"?/i, 'charset=utf-8') : mimeType
}

/** A body file of a .har.zip: text types are masked and come back as UTF-8, others unchanged. */
export function sanitizeSideFile(bytes: Uint8Array, mimeType: string, counter: Counter): Uint8Array {
  if (!isTextual(mimeType)) return bytes
  const text = decodeText(bytes, charsetOf(mimeType))
  const masked = maskBodyText(text, mimeType, counter)
  return masked === text ? bytes : new TextEncoder().encode(masked)
}

// ── Whole entries ────────────────────────────────────────────────────────────────────────────

/** Copies `value` with `maskText` applied to every string inside. */
function maskStrings(value: unknown, counter: Counter, depth = 0): unknown {
  if (typeof value === 'string') return maskText(value, counter, 'other')
  if (typeof value !== 'object' || value === null || depth > 256) return value
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((item) => {
      const next = maskStrings(item, counter, depth + 1)
      if (next !== item) changed = true
      return next
    })
    return changed ? out : value
  }
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const next = key === 'url' && typeof item === 'string' ? maskUrl(item, counter, 'other') : maskStrings(item, counter, depth + 1)
    if (next !== item) changed = true
    out[key] = next
  }
  return changed ? out : value
}

const HANDLED_ENTRY_KEYS = new Set(['request', 'response', '_webSocketMessages', 'startedDateTime', 'time', 'timings', 'pageref', 'serverIPAddress', 'connection'])

export function sanitizeEntry(entry: HarEntry, counter: Counter): HarEntry {
  const out: Record<string, unknown> = {}
  const raw = entry as Record<string, unknown>
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'request' && value && typeof value === 'object') {
      const request = value as NonNullable<HarEntry['request']>
      out.request = {
        ...request,
        url: typeof request.url === 'string' ? maskUrl(request.url, counter, 'query') : request.url,
        headers: maskHeaders(request.headers, counter),
        cookies: maskCookies(request.cookies, counter),
        // Mirrors the URL, which is already counted.
        queryString: maskParams(request.queryString, QUIET, 'query'),
        postData: maskPostData(request.postData, counter)
      }
      dropUndefined(out.request as Record<string, unknown>, request as Record<string, unknown>)
    } else if (key === 'response' && value && typeof value === 'object') {
      const response = value as HarResponse
      out.response = {
        ...response,
        headers: maskHeaders(response.headers, counter),
        cookies: maskCookies(response.cookies, counter),
        content: maskInlineBody(response.content, counter),
        redirectURL: typeof response.redirectURL === 'string' ? maskUrl(response.redirectURL, counter, 'headers') : response.redirectURL
      }
      dropUndefined(out.response as Record<string, unknown>, response as Record<string, unknown>)
    } else if (key === '_webSocketMessages' && Array.isArray(value)) {
      out[key] = value.map((message) => {
        if (!message || typeof message.data !== 'string' || message.opcode === 2) return message
        const data = maskBodyText(message.data, '', counter)
        return data === message.data ? message : { ...message, data }
      })
    } else if (HANDLED_ENTRY_KEYS.has(key)) {
      out[key] = value
    } else {
      out[key] = maskStrings(value, counter)
    }
  }
  return out as HarEntry
}

/** Keeps a field absent when it was absent, instead of present and undefined. */
function dropUndefined(out: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(out)) if (out[key] === undefined && !(key in source)) delete out[key]
}

function maskPostData(post: HarPostData | undefined, counter: Counter): HarPostData | undefined {
  if (!post) return post
  const params = post.params ? maskParams(post.params as HarNameValue[], counter, 'bodies') : post.params
  const withText = maskInlineBody(post, counter) ?? post
  return params === post.params ? withText : { ...withText, params: params as HarPostData['params'] }
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
