// The free-text layer of masking: which names hold secrets, token shapes (JWTs, `sk-…`, GitHub,
// Slack, AWS, Google, Stripe keys, private keys) wherever they appear, and secret-named pairs in
// text (`password=…`, `"token": "…"`, `<input name="csrf" value="…">`). Bodies, URLs and JSON
// are taken apart structurally elsewhere first; this pass runs over whatever is left.
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
}

/** Nested values deeper than this are only checked for token shapes. */
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
  'otp',
  'saml',
  'verifier',
  'authcode',
  'assertion'
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

/** `isSensitiveName`, plus OAuth's `code` inside an OAuth flow. */
export function isSecretName(name: string, options: MaskOptions = {}): boolean {
  return isSensitiveName(name) || (!!options.oauth && name.trim().toLowerCase() === 'code')
}

/** Parameter names that only appear in OAuth and OpenID requests and responses. */
const OAUTH_NAMES = new Set(['state', 'grant_type', 'redirect_uri', 'code_verifier', 'code_challenge', 'response_type', 'session_state', 'client_assertion'])

/** Whether a set of parameter or field names belongs to an OAuth flow. */
export function hasOauthNames(names: Iterable<string>): boolean {
  for (const name of names) if (OAUTH_NAMES.has(name.trim().toLowerCase())) return true
  return false
}

/** OAuth's `code` counts as a secret on redirect, callback and sign-in URLs. */
export const OAUTH_PATH = /oauth|openid|callback|authori[sz]e|signin|sign-in|login|token|saml|sso\b/i

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
/** `"password": "…"`, `token = '…'`, `apiKey: \`…\`` in code, logs and broken JSON. */
const QUOTED_PAIR = /(["'`]?)([A-Za-z_$][\w$.-]{0,63})\1([ \t]*[:=][ \t]*)(["'`])((?:\\.|(?!\4)[^\\\r\n]){1,4096})\4/g
/** `<meta name="csrf-token" content="…">`, `<input name="authenticity_token" value="…">`. */
const HTML_TAG = /<(?:meta|input)\b[^<>]*>/gi
const HTML_NAME = /\b(?:name|property|id)\s*=\s*(["'])([^"'<>]*)\1/i
const HTML_VALUE = /(\b(?:content|value)\s*=\s*)(["'])([^"'<>]*)\2/i
/** A hidden `state` field: the form is an OAuth form_post. */
const HTML_STATE = /\bname\s*=\s*["']state["']/i

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
      const masked = maskValue(value, counter, kind, options)
      return masked === value ? match : `${lead}${name}=${masked}`
    })
  }
  if (out.includes('"') || out.includes("'") || out.includes('`')) {
    out = out.replace(QUOTED_PAIR, (match, q1: string, key: string, sep: string, q2: string, value: string) => {
      if (value === MASK || !isSecretName(key.split('.').pop() ?? key, options)) return match
      counter.add(kind)
      return `${q1}${key}${q1}${sep}${q2}${MASK}${q2}`
    })
  }
  if (out.includes('<')) {
    const html = { ...options, oauth: options.oauth || HTML_STATE.test(out) }
    out = out.replace(HTML_TAG, (tag) => {
      const name = HTML_NAME.exec(tag)
      if (!name || !isSecretName(name[2], html)) return tag
      const value = HTML_VALUE.exec(tag)
      if (!value || !value[3] || value[3] === MASK) return tag
      counter.add(kind)
      return tag.replace(HTML_VALUE, (_, attribute: string, quote: string) => `${attribute}${quote}${MASK}${quote}`)
    })
  }
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
  return maskTokens(value, counter, kind)
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
