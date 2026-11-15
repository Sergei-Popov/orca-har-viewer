// The free-text layer of masking: which names hold secrets, token shapes (JWTs, `sk-…`, GitHub,
// Slack, AWS, Google, Stripe keys, private keys) wherever they appear, secret-named pairs in text
// (`password=…`, `"token": "…"`, `passcode:…` lines, `<input name="csrf" value=…>`), and a
// catch-all for values that look random (`maskRandom`). Bodies, URLs and JSON are taken apart
// structurally elsewhere first; this pass runs over whatever is left.
//
// Every pattern here runs on untrusted text, so none has nested or overlapping quantifiers that
// could backtrack: each is linear in the input (see the time-budget tests).

export const MASK = '[masked]'

export type MaskKind = 'headers' | 'cookies' | 'query' | 'bodies' | 'other'

export type Counter = { add(kind: MaskKind, count?: number): void }

/** Masks without counting, for values that repeat ones counted elsewhere. */
export const QUIET: Counter = { add: () => undefined }

/** What the surroundings say about a value. */
export type MaskOptions = {
  /** An OAuth or OpenID flow: its one-time `code` counts as a secret too. */
  oauth?: boolean
  /** How deep values nested in values (URLs in query values, JSON in strings) have gone. */
  depth?: number
  /** How deep multipart bodies nested in multipart parts have gone. */
  parts?: number
  /** Program text (JavaScript, CSS): no `name: value` line rule and no catch-all, as both would rewrite code. */
  code?: boolean
  /** Values that are identifiers by their name (`id`, `sha`, `etag`, `v`): no catch-all. */
  noEntropy?: boolean
}

/** Nested values deeper than this (decoding passes included) are only checked for token shapes. */
export const MAX_DEPTH = 4

// ── Names ────────────────────────────────────────────────────────────────────────────────────

const SENSITIVE_PARTS = [
  'authorization',
  'authentication',
  'password',
  'passwd',
  'passphrase',
  'passcode',
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
  'saml',
  'verifier',
  'authcode',
  'assertion',
  'devicecode',
  'mfacode',
  'verificationcode',
  'onetimecode',
  'wresult'
]
/** Whole words of a name (`otpCode`, `user_otp`), never a part of one (`rootPath`, `slotProps`). */
const SENSITIVE_WORDS = new Set(['otp', 'totp', 'hotp'])
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
  if (n.includes('otp')) for (const word of nameWords(name)) if (SENSITIVE_WORDS.has(word)) return true
  return false
}

/** `isSensitiveName`, plus OAuth's `code` and CAS's `ticket` inside a sign-in flow. */
export function isSecretName(name: string, options: MaskOptions = {}): boolean {
  if (isSensitiveName(name)) return true
  if (!options.oauth) return false
  const n = name.trim().toLowerCase()
  return n === 'code' || n === 'ticket'
}

/** The words of a name: `otpCode` → otp, code; `X-Request-ID` → x, request, id. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** Last words that make a value an identifier or a digest, which users need to see. */
const ID_WORDS = new Set([
  'id',
  'ids',
  'uuid',
  'guid',
  'sha',
  'sha1',
  'sha256',
  'sha512',
  'hash',
  'etag',
  'digest',
  'checksum',
  'md5',
  'crc',
  'crc32',
  'integrity',
  'commit',
  'revision',
  'rev',
  'version',
  'ver',
  'v',
  'build'
])

/** `requestId`, `node_id`, `sha`, `etag`, `v`: the value identifies something and is no secret. */
export function isIdName(name: string): boolean {
  if (!name || name.length > 64 || isSensitiveName(name)) return false
  const words = nameWords(name)
  return words.length > 0 && ID_WORDS.has(words[words.length - 1])
}

/** Parameter names that only appear in OAuth and OpenID requests and responses. */
const OAUTH_NAMES = new Set(['state', 'grant_type', 'redirect_uri', 'code_verifier', 'code_challenge', 'response_type', 'session_state', 'client_assertion'])

/** Whether a set of parameter or field names belongs to an OAuth flow. */
export function hasOauthNames(names: Iterable<string>): boolean {
  for (const name of names) if (OAUTH_NAMES.has(name.trim().toLowerCase())) return true
  return false
}

/** OAuth's `code` (and CAS's `ticket`) count as secrets on redirect, callback and sign-in URLs. */
export const OAUTH_PATH = /oauth|openid|callback|authori[sz]e|signin|sign-in|login|token|saml|sso\b|\bauth\b|\bcas\b/i

// ── Token shapes ─────────────────────────────────────────────────────────────────────────────

/**
 * Token shapes masked wherever they appear. A lookbehind or `\b` lets each start only where a run
 * starts, and every run ends in a plain character class, so a failed match never rescans a run.
 */
const TOKENS = new RegExp(
  [
    '-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\\s\\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)',
    // JWS: base64url JSON header and payload, then a signature.
    '(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\\.eyJ[A-Za-z0-9_-]{4,}\\.[A-Za-z0-9_-]*',
    // OpenAI, Anthropic, DeepSeek and similar: sk-…, sk-proj-…, sk-ant-…
    '(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}',
    '(?<![A-Za-z0-9_])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}',
    '(?<![A-Za-z0-9_])whsec_[A-Za-z0-9+/=]{16,}',
    '(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{30,}',
    '(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,}',
    '(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}',
    // Slack: bot, user, refresh (xoxe) and app-level (xapp) tokens.
    '(?<![A-Za-z0-9_.-])xox[abposre](?:\\.xox[abposre])?-[A-Za-z0-9-]{10,}',
    '(?<![A-Za-z0-9_-])xapp-\\d-[A-Za-z0-9-]{10,}',
    '(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])',
    '(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}',
    '(?<![A-Za-z0-9_])ya29\\.[0-9A-Za-z_-]{20,}',
    '(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])',
    '(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}',
    '(?<![A-Za-z0-9_])SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}',
    '(?<![A-Za-z0-9_])shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}(?![A-Za-z0-9])'
  ].join('|'),
  'g'
)

/** Only the token shapes (no name rules), for values whose name was already checked. */
export function maskTokens(text: string, counter: Counter, kind: MaskKind): string {
  if (text.length < 16) return text
  return text.replace(TOKENS, () => {
    counter.add(kind)
    return MASK
  })
}

// ── Pairs in free text ───────────────────────────────────────────────────────────────────────

/** `Bearer abc…`, `Basic dXNl…`: the scheme stays. */
const AUTH_SCHEME = /\b(Bearer|Basic|Digest|Token|Negotiate)([ \t]+)([A-Za-z0-9._~+/-]{8,}=*)/g
/** `scheme://user:password@host`: the user stays. */
export const URL_PASSWORD = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s/?#@:"'<>]+):([^\s/?#@"'<>]+)@/gi
/**
 * `name=value` at the start, after `?&#;`, a quote or a space: in URLs, forms, logs and prose.
 * Not `a.key===b.key`: the value never starts with `=`.
 */
const PAIR = /(^|[?&#;\s"'])([\w.%+\-[\]]{1,64})=(?!=)([^&#\s"'<>]+)/g
/**
 * `"password": "…"`, `token = '…'`, `apiKey: \`…\`` in code, logs and broken JSON. The name
 * starts a word (not `xmlns:saml="…"`), and a value that starts or ends with a space is code
 * between two string literals (`"token: " + token.type + " ("`), not a value.
 */
const QUOTED_PAIR = /(?<![\w$:.-])(["'`]?)([A-Za-z_$][\w$.-]{0,63})\1([ \t]*[:=][ \t]*)(["'`])((?:\\.|(?!\4)[^\\\r\n]){1,4096})\4/g
/**
 * A line `name: value` or `name = value` with the value unquoted: STOMP and HTTP header lines,
 * YAML, .properties and .env files. The rest of the line is the value; a dotted name counts by
 * its last part (`spring.datasource.password`).
 */
const LINE_PAIR = /^([ \t]*)([\w.$-]{1,64})([ \t]*[:=][ \t]*)([^\s"'`][^\r\n]*)$/gm
/** `<meta name="csrf-token" content="…">`, `<input name=authenticity_token value=…>`. */
const HTML_TAG = /<(?:meta|input)\b[^<>]*>/gi
const HTML_NAME = /\b(?:name|property|id)\s*=\s*(?:(["'])([^"'<>]*)\1|([^\s"'=<>`]+))/i
const HTML_VALUE = /(\b(?:content|value)\s*=\s*)(?:(["'])([^"'<>]*)\2|([^\s"'=<>`]+))/i
/** A hidden `state` field: the form is an OAuth form_post. */
const HTML_STATE = /\bname\s*=\s*(?:["']state["']|state(?=[\s/>]))/i

/** Nested values: decoded, masked as a URL or as text, written back the way they came. */
export type NestedMasker = (value: string, counter: Counter, kind: MaskKind, options: MaskOptions) => string

let nested: NestedMasker | null = null

/** Lets the URL layer handle URLs nested in values, without an import cycle. */
export function setNestedMasker(masker: NestedMasker): void {
  nested = masker
}

/** Masks token-shaped values, credentials in URLs and secret-named pairs in any text. */
export function maskText(text: string, counter: Counter, kind: MaskKind = 'other', options: MaskOptions = {}): string {
  if (text.length < 6) return text
  let out = maskTokens(text, counter, kind)
  if (out.includes('Bearer') || out.includes('Basic') || out.includes('Digest') || out.includes('Token') || out.includes('Negotiate')) {
    out = out.replace(AUTH_SCHEME, (match, scheme: string, space: string, value: string) => {
      if (!/[0-9]/.test(value) && !(/[A-Z]/.test(value) && /[a-z]/.test(value))) return match
      counter.add(kind)
      return `${scheme}${space}${MASK}`
    })
  }
  if (out.includes('://')) {
    out = out.replace(URL_PASSWORD, (match, scheme: string, user: string) => {
      counter.add(kind)
      return `${scheme}${user}:${MASK}@`
    })
  }
  if (out.includes('=')) {
    out = out.replace(PAIR, (match, lead: string, name: string, value: string) => {
      if (value === MASK) return match
      if (isSecretName(safeDecode(name), options)) {
        counter.add(kind)
        return `${lead}${name}=${MASK}`
      }
      const masked = maskValue(value, counter, kind, isIdName(safeDecode(name)) ? { ...options, noEntropy: true } : options)
      return masked === value ? match : `${lead}${name}=${masked}`
    })
  }
  if (out.includes('"') || out.includes("'") || out.includes('`')) {
    out = out.replace(QUOTED_PAIR, (match, q1: string, key: string, sep: string, q2: string, value: string) => {
      if (value === MASK || /^\s|\s$/.test(value) || !isSecretName(key.split('.').pop() ?? key, options)) return match
      counter.add(kind)
      return `${q1}${key}${q1}${sep}${q2}${MASK}${q2}`
    })
  }
  if (!options.code && (out.includes(':') || out.includes('='))) {
    out = out.replace(LINE_PAIR, (match, indent: string, key: string, sep: string, value: string) => {
      // Already masked, or an auth scheme kept before its masked value (`Bearer [masked]`).
      if (value.startsWith(MASK) || /^[A-Za-z-]{1,20} \[masked\]$/.test(value) || !isSecretName(key.split('.').pop() ?? key, options)) return match
      counter.add(kind)
      return `${indent}${key}${sep}${MASK}`
    })
  }
  if (out.includes('<')) {
    const html = { ...options, oauth: options.oauth || HTML_STATE.test(out) }
    out = out.replace(HTML_TAG, (tag) => {
      const name = HTML_NAME.exec(tag)
      if (!name || !isSecretName(name[2] ?? name[3], html)) return tag
      const value = HTML_VALUE.exec(tag)
      const current = value ? (value[3] ?? value[4]) : ''
      if (!value || !current || current === MASK) return tag
      counter.add(kind)
      return tag.replace(HTML_VALUE, (_, attribute: string, quote: string | undefined) => `${attribute}${quote ?? ''}${MASK}${quote ?? ''}`)
    })
  }
  if (!options.code && !options.noEntropy) out = maskRandom(out, counter, kind)
  return out
}

/**
 * A value whose name is not secret: a URL or `name=value` text nested in it (`?next=/reset?token=…`,
 * `redirect_uri=https%3A%2F%2F…%3Fcode%3D…`) is decoded and masked too; otherwise token shapes only.
 */
export function maskValue(value: string, counter: Counter, kind: MaskKind, options: MaskOptions = {}): string {
  if (value.length < 6) return value
  const depth = options.depth ?? 0
  if (nested && depth < MAX_DEPTH && /[=?#%]/.test(value)) return nested(value, counter, kind, { ...options, depth: depth + 1 })
  // Nested deeper than masking takes apart: the whole value goes when anything in it is secret.
  if (depth === MAX_DEPTH && /[=?#%]/.test(value) && hasDeepSecret(value, kind, options)) {
    counter.add(kind)
    return MASK
  }
  const out = maskTokens(value, counter, kind)
  return options.noEntropy ? out : maskRandom(out, counter, kind)
}

/** Decoding passes `hasDeepSecret` makes at most. */
const DEEP_PASSES = 8

/** Whether a value, decoded fully, holds anything the text rules would mask. */
function hasDeepSecret(value: string, kind: MaskKind, options: MaskOptions): boolean {
  let text = value
  for (let pass = 0; pass < DEEP_PASSES && /%[0-9A-Fa-f]{2}/.test(text); pass++) {
    const next = safeDecode(text)
    if (next === text) break
    text = next
  }
  let found = false
  const probe: Counter = {
    add() {
      found = true
    }
  }
  // One level past the limit, so the rules do not come back here.
  const masked = maskText(text.replace(/[?#&]/g, ' '), probe, kind, { ...options, depth: MAX_DEPTH + 1 })
  return found || masked !== text.replace(/[?#&]/g, ' ')
}

// ── The catch-all: values that look random ───────────────────────────────────────────────────

/** A run of the base64, base64url and hex alphabets, 20 characters or more, then padding. */
const RUN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{20,}(?:={1,2}(?!=))?/g
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
/** The name a value is given in text: `request_id=`, `"etag": "`, `build: `. */
const NAME_BEFORE = /([A-Za-z_$][\w$.-]{0,40})["']?[ \t]*[:=][ \t]*["']?$/
/** A file or host name follows: `main.3f9a…c1.js`, `p7x…q2.ngrok.app`. */
const EXTENSION_AFTER = /^\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/

export type RandomOptions = {
  /** Path segments of a URL: object IDs (24 hex digits) and git commits (40) stay too. */
  path?: boolean
}

/**
 * Masks runs that look random: 20 or more characters of the base64, base64url or hex alphabets
 * with letters and digits mixed, high entropy (3.5 bits a character, 3 for hex) and none of the
 * shape of words (`user_profile_v2`, `getUserSettings2024`). What stays though it looks random:
 * UUIDs, `data:` URIs, `sha256-…` integrity hashes, content hashes in file and host names, and
 * values named as identifiers (`request_id=…`). Slashes split a run into path segments unless it
 * is padded or has a `+`, as base64 is.
 */
export function maskRandom(text: string, counter: Counter, kind: MaskKind, options: RandomOptions = {}): string {
  if (text.length < 20) return text
  return text.replace(RUN, (run: string, offset: number) => {
    if (offset >= 7 && text.startsWith('base64,', offset - 7)) return run
    if (/^sha(?:256|384|512)-/.test(run)) return run
    // A file or host name: only the last path piece is one.
    const fileName = EXTENSION_AFTER.test(text.slice(offset + run.length, offset + run.length + 10))
    const before = NAME_BEFORE.exec(text.slice(Math.max(0, offset - 48), offset))
    if (before && isIdName(before[1])) return run
    const body = run.replace(/=+$/, '')
    if (body.includes('/') && body.length === run.length && !body.includes('+')) {
      let changed = false
      const pieces = body.split('/')
      const last = pieces.length - 1
      pieces.forEach((piece, index) => {
        if ((fileName && index === last) || !isRandom(piece, options)) return
        changed = true
        counter.add(kind)
        pieces[index] = MASK
      })
      return changed ? pieces.join('/') : run
    }
    if (fileName || !isRandom(body, options)) return run
    counter.add(kind)
    return MASK
  })
}

const LOG2 = Math.log(2)

/** Whether a run of the base64 or hex alphabets reads as random rather than as words. */
export function isRandom(run: string, options: RandomOptions = {}): boolean {
  const n = run.length
  if (n < 20 || UUID.test(run)) return false
  let digits = 0
  let letters = 0
  let hex = true
  let words = 0
  let previous = 0
  const counts = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    const c = run.charCodeAt(i)
    counts.set(c, (counts.get(c) ?? 0) + 1)
    // 1 lower case, 2 upper case, 3 digit, 4 anything else.
    const type = c >= 0x30 && c <= 0x39 ? 3 : c >= 0x61 && c <= 0x7a ? 1 : c >= 0x41 && c <= 0x5a ? 2 : 4
    if (type === 3) digits++
    else if (type !== 4) letters++
    if (!((c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46))) hex = false
    // A word starts where the kind of character changes, except a capital before lower case (`Word`).
    if (type !== 4 && type !== previous && !(previous === 2 && type === 1)) words++
    previous = type
  }
  if (!digits || !letters) return false
  if (options.path && hex && (n === 24 || n === 40)) return false
  // Words: few long runs of one kind (`user_profile_settings_v2` has 5 in 24 characters).
  if (words / n < 0.3) return false
  let entropy = 0
  for (const count of counts.values()) {
    const p = count / n
    entropy -= (p * Math.log(p)) / LOG2
  }
  return entropy >= (hex ? 3 : 3.5)
}

/** `decodeURIComponent` with `+` as a space, or the text itself when it does not decode. */
export function safeDecode(text: string): string {
  if (!text.includes('%') && !text.includes('+')) return text
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '))
  } catch {
    return text
  }
}

/** Percent-encodes a masked value the way it was written: encoded if it was, `[masked]` kept readable. */
export function encodeLike(original: string, decoded: string, masked: string): string {
  if (original === decoded) return masked
  return encodeURIComponent(masked).split(encodeURIComponent(MASK)).join(MASK)
}
