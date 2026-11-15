// URLs and name/value lists: each query and fragment parameter by name (hash routes too:
// `#/callback?code=…`), OAuth's `code` in an OAuth flow, URLs nested in values
// (`?next=/reset?token=…`, encoded once or more), matrix parameters (`;jsessionid=…`), passwords
// in the authority, and token-shaped or random path segments.

import {
  MASK,
  OAUTH_PATH,
  URL_PASSWORD,
  encodeLike,
  hasOauthNames,
  isIdName,
  isSecretName,
  maskJsonValue,
  maskRandom,
  maskText,
  maskTokens,
  maskValue,
  safeDecode,
  setNestedMasker,
  type Counter,
  type MaskKind,
  type MaskOptions,
  MAX_DEPTH
} from './mask-text'
import type { HarNameValue } from './types'

/** `;jsessionid=…` and other matrix parameters in a path. */
const MATRIX = /;([^=;/?#]{1,64})=([^;/?#]*)/g

/** Splits a URL into the part before `?`/`#`, the query and the fragment (null when absent). */
function splitUrl(url: string): { base: string; query: string | null; hash: string | null } {
  const hashAt = url.indexOf('#')
  const queryAt = url.indexOf('?')
  const hasQuery = queryAt >= 0 && (hashAt < 0 || queryAt < hashAt)
  const baseEnd = hasQuery ? queryAt : hashAt >= 0 ? hashAt : url.length
  return {
    base: url.slice(0, baseEnd),
    query: hasQuery ? url.slice(queryAt + 1, hashAt >= 0 ? hashAt : url.length) : null,
    hash: hashAt >= 0 ? url.slice(hashAt + 1) : null
  }
}

/**
 * A fragment as a route and its parameters: `#/auth/callback?code=…` → `/auth/callback` and
 * `code=…`; `#access_token=…&state=…` → no route; `#/settings` → a route only.
 */
function splitHash(hash: string): { route: string; query: string | null } {
  const at = hash.indexOf('?')
  if (at >= 0) return { route: hash.slice(0, at), query: hash.slice(at + 1) }
  return hash.includes('=') ? { route: '', query: hash } : { route: hash, query: null }
}

function pairNames(part: string | null): string[] {
  if (!part) return []
  return part.split('&').map((pair) => safeDecode(pair.slice(0, Math.max(0, pair.indexOf('=')))))
}

/** Whether a URL belongs to an OAuth or OpenID flow, so its `code` is a secret. */
export function isOauthUrl(url: string): boolean {
  const { base, query, hash } = splitUrl(url)
  // A file a page loads (`login.css`, `reset.js?hash=…`) is never a sign-in step.
  if (ASSET_FILE.test(base)) return false
  if (OAUTH_PATH.test(base) || hasOauthNames(pairNames(query))) return true
  if (hash === null) return false
  const route = splitHash(hash)
  return OAUTH_PATH.test(route.route) || hasOauthNames(pairNames(route.query))
}

// ── SignalR ──────────────────────────────────────────────────────────────────────────────────

/** `host/path` of a URL's part before `?`, lower case, without scheme or a trailing slash: a hub's key. */
function hubKey(base: string): string {
  return base.replace(/^[a-z][a-z0-9+.-]{0,31}:\/\//i, '').replace(/\/+$/, '').toLowerCase()
}

/** The hub a SignalR negotiate request is for (`https://host/_blazor/negotiate?…` → `host/_blazor`), or null. */
export function negotiatedHub(url: string): string | null {
  const match = /^(.*\/[^/]*)\/negotiate\/?$/i.exec(splitUrl(url).base)
  return match ? hubKey(match[1]) : null
}

/**
 * Whether a URL is a transport URL of a hub the recording negotiated (`wss://host/_blazor?id=…`,
 * the long-polling and server-sent events requests): its `id` is the connection token.
 */
export function isHubUrl(url: string, hubs: Set<string> | undefined): boolean {
  if (!hubs?.size) return false
  const key = hubKey(splitUrl(url).base)
  if (hubs.has(key)) return true
  // A path alone (`:path`, a relative URL): the hub's path on any host.
  if (key.startsWith('/')) for (const hub of hubs) if (hub.slice(hub.indexOf('/')) === key) return true
  return false
}

/** A parameter that holds a connection token: `id` on a hub's transport URL, or a token a body named. */
function isTokenParam(name: string, value: string, hub: boolean, counter: Counter): boolean {
  if (hub && name.trim().toLowerCase() === 'id') return true
  return !!counter.tokens?.size && counter.tokens.has(safeDecode(value))
}

/** Files a page loads (scripts, styles, fonts, images): their content hashes are no secrets. */
const ASSET_FILE = /\.(?:m?js|cjs|css|map|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico|bmp|mp4|webm|mp3|ogg|wasm)$/i
const STATIC_PATH = /\/(?:_next|static|assets|chunks|dist|build|fonts|images|img)\//i

function isStaticPath(base: string): boolean {
  return ASSET_FILE.test(base) || STATIC_PATH.test(base)
}

/** Masks secret query and fragment parameters, nested URLs, URL passwords and token-shaped path parts. */
export function maskUrl(url: string, counter: Counter, kind: MaskKind = 'query', options: MaskOptions = {}): string {
  if (!url) return url
  const { base: rawBase, query: rawQuery, hash: rawHash } = splitUrl(url)
  const oauth = !!options.oauth || isOauthUrl(url)
  // A file the page loads: hashes in its name and cache-busting values are not secrets.
  const inner: MaskOptions = { ...options, oauth, noEntropy: options.noEntropy || isStaticPath(rawBase) }
  const hub = isHubUrl(rawBase, counter.hubs)
  const params = (part: string) =>
    part
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=')
        if (eq <= 0) return pair
        const name = pair.slice(0, eq)
        const value = pair.slice(eq + 1)
        if (!value || value === MASK) return pair
        const decodedName = safeDecode(name)
        if (isSecretName(decodedName, inner) || isTokenParam(decodedName, value, hub, counter)) {
          counter.add(kind)
          return `${name}=${MASK}`
        }
        const masked = maskValue(value, counter, kind, isIdName(decodedName) ? { ...inner, noEntropy: true } : inner)
        return masked === value ? pair : `${name}=${masked}`
      })
      .join('&')
  const path = (part: string) => {
    const out = maskTokens(part, counter, kind)
    return inner.noEntropy ? out : maskRandom(out, counter, kind, { path: true })
  }
  const query = rawQuery !== null ? params(rawQuery) : null
  let hash = rawHash
  if (hash) {
    const route = splitHash(hash)
    hash = `${route.route ? path(route.route) : ''}${route.query !== null ? `${hash.includes('?') ? '?' : ''}${params(route.query)}` : ''}`
  }
  let base = rawBase
  if (base.includes('://')) {
    base = base.replace(URL_PASSWORD, (match, scheme: string, user: string) => {
      counter.add(kind)
      return `${scheme}${user}:${MASK}@`
    })
  }
  if (base.includes(';')) {
    base = base.replace(MATRIX, (match, name: string, value: string) => {
      if (!value || value === MASK || !isSecretName(safeDecode(name), inner)) return match
      counter.add(kind)
      return `;${name}=${MASK}`
    })
  }
  base = path(base)
  return `${base}${query !== null ? `?${query}` : ''}${hash !== null ? `#${hash}` : ''}`
}

/** A URL: an absolute one, or a path with a query. */
export function looksLikeUrl(text: string): boolean {
  return /^[a-z][a-z0-9+.-]{0,31}:\/\/\S/i.test(text) || (text.startsWith('/') && !/\s/.test(text) && /[?#;]/.test(text))
}

/**
 * The nested-value masker for `maskValue`: decodes a value as many times as it was encoded
 * (`%252Freset%253Ftoken%253D…` twice; each pass counts as a level of nesting), masks it as JSON
 * when it is a JSON object or array, as a URL when it is one, else as text (where `name=value` pairs are found by name), and encodes it back
 * the way it came.
 */
function maskNested(value: string, counter: Counter, kind: MaskKind, options: MaskOptions): string {
  const layers = [value]
  let depth = options.depth ?? 1
  for (;;) {
    const last = layers[layers.length - 1]
    const next = safeDecode(last)
    if (next === last) break
    layers.push(next)
    if (!/%[0-9A-Fa-f]{2}/.test(next) || depth >= MAX_DEPTH) break
    depth++
  }
  const decoded = layers[layers.length - 1]
  const inner: MaskOptions = { ...options, depth }
  let masked: string
  const json = maskJsonValue(decoded, counter, kind, inner)
  if (json !== null) masked = json
  else if (looksLikeUrl(decoded) || (decoded.includes('?') && !/\s/.test(decoded))) masked = maskUrl(decoded, counter, kind, inner)
  else if (decoded.includes('=')) masked = maskText(decoded, counter, kind, inner)
  else {
    masked = maskTokens(decoded, counter, kind)
    if (!inner.noEntropy) masked = maskRandom(masked, counter, kind)
  }
  if (masked === decoded) return value
  for (let i = layers.length - 1; i >= 1; i--) masked = encodeLike(layers[i - 1], layers[i], masked)
  return masked
}

setNestedMasker(maskNested)

/** Text that is a URL is masked as one (so its `code` and nested URLs are found), anything else as text. */
export function maskFreeText(text: string, counter: Counter, kind: MaskKind = 'other', options: MaskOptions = {}): string {
  if (text.length < 6) return text
  return looksLikeUrl(text) ? maskUrl(text, counter, kind, options) : maskText(text, counter, kind, options)
}

/**
 * Masks a list of name/value pairs (a query string, form fields): values under secret names, and
 * nested URLs and token shapes in the others. Values may be percent-encoded or not.
 */
export function maskParams(
  params: HarNameValue[] | undefined,
  counter: Counter,
  kind: MaskKind,
  options: MaskOptions = {}
): HarNameValue[] | undefined {
  // A list of another shape (an object of names to values): every string in it, by name.
  if (!Array.isArray(params)) return params === undefined ? params : (maskStrings(params, counter, kind) as HarNameValue[])
  const names = params.map((param) => (param && typeof param.name === 'string' ? safeDecode(param.name) : ''))
  const inner: MaskOptions = { ...options, oauth: options.oauth || hasOauthNames(names) }
  let changed = false
  const out = params.map((param, index) => {
    if (!param || typeof param !== 'object') return maskStrings(param, counter, kind) as HarNameValue
    let next: HarNameValue = param
    const secret = isSecretName(names[index], inner) || (typeof param.value === 'string' && isTokenParam(names[index], param.value, !!inner.hub, counter))
    if (typeof param.value === 'string' && param.value && param.value !== MASK) {
      let value: string
      if (secret) {
        counter.add(kind)
        value = MASK
      } else value = maskValue(param.value, counter, kind, isIdName(names[index]) ? { ...inner, noEntropy: true } : inner)
      if (value !== param.value) next = { ...param, value }
    } else if (param.value !== undefined && typeof param.value !== 'string') {
      // A value of another type (an array, a number): every string in it, all of them when the name is secret.
      const value = secret ? blankStrings(param.value, counter, kind) : maskStrings(param.value, counter, kind)
      if (value !== param.value) next = { ...param, value: value as string }
    }
    const rest = maskOtherFields(next, ['name', 'value'], counter)
    if (rest !== param) changed = true
    return rest
  })
  return changed ? out : params
}

/** Free text in the fields of an object other than `handled`: comments and vendor fields. */
export function maskOtherFields<T extends object>(value: T, handled: string[], counter: Counter, kind: MaskKind = 'other'): T {
  let out: Record<string, unknown> | null = null
  for (const [key, item] of Object.entries(value)) {
    if (handled.includes(key)) continue
    const next = maskStrings(item, counter, kind)
    if (next !== item) {
      out ??= { ...(value as Record<string, unknown>) }
      out[key] = next
    }
  }
  return (out as T | null) ?? value
}

/**
 * Copies `value` with every string inside masked as free text (URLs as URLs): whole values under
 * secret-named keys (every string and number inside them), identifiers by their name without the
 * catch-all, and keys that look random.
 */
export function maskStrings(value: unknown, counter: Counter, kind: MaskKind = 'other', depth = 0, options: MaskOptions = {}): unknown {
  if (typeof value === 'string') return maskFreeText(value, counter, kind, options)
  if (typeof value !== 'object' || value === null || depth > 256) return value
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((item) => {
      const next = maskStrings(item, counter, kind, depth + 1, options)
      if (next !== item) changed = true
      return next
    })
    return changed ? out : value
  }
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    let next: unknown
    if (isSecretName(key)) next = blankStrings(item, counter, kind, depth + 1)
    else next = maskStrings(item, counter, kind, depth + 1, isIdName(key) ? { ...options, noEntropy: true } : options)
    let name = key
    if (key.length >= 20) {
      name = maskRandom(maskTokens(key, counter, kind), counter, kind)
      while (name !== key && name in out) name = `${name}#`
    }
    if (next !== item || name !== key) changed = true
    out[name] = next
  }
  return changed ? out : value
}

/** Copies `value` with every string and number inside replaced by `[masked]`: a secret, whatever its shape. */
export function blankStrings(value: unknown, counter: Counter, kind: MaskKind = 'other', depth = 0): unknown {
  if (typeof value === 'string') {
    if (!value || value === MASK) return value
    counter.add(kind)
    return MASK
  }
  if (typeof value === 'number') {
    counter.add(kind)
    return MASK
  }
  if (typeof value !== 'object' || value === null || depth > 256) return value
  if (Array.isArray(value)) return value.map((item) => blankStrings(item, counter, kind, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = blankStrings(item, counter, kind, depth + 1)
  return out
}
