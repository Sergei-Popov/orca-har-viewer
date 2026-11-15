// URLs and name/value lists: each query and fragment parameter by name, OAuth's `code` in an OAuth
// flow, URLs nested in values (`?next=/reset?token=…`, `redirect_uri=https%3A%2F%2F…`), matrix
// parameters (`;jsessionid=…`), passwords in the authority and token-shaped path segments.

import {
  MASK,
  OAUTH_PATH,
  URL_PASSWORD,
  encodeLike,
  hasOauthNames,
  isSecretName,
  maskText,
  maskTokens,
  maskValue,
  safeDecode,
  setNestedMasker,
  type Counter,
  type MaskKind,
  type MaskOptions
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

function pairNames(part: string | null): string[] {
  if (!part) return []
  return part.split('&').map((pair) => safeDecode(pair.slice(0, Math.max(0, pair.indexOf('=')))))
}

/** Whether a URL belongs to an OAuth or OpenID flow, so its `code` is a secret. */
export function isOauthUrl(url: string): boolean {
  const { base, query, hash } = splitUrl(url)
  return OAUTH_PATH.test(base) || hasOauthNames(pairNames(query)) || hasOauthNames(pairNames(hash))
}

/** Masks secret query and fragment parameters, nested URLs, URL passwords and token-shaped path parts. */
export function maskUrl(url: string, counter: Counter, kind: MaskKind = 'query', options: MaskOptions = {}): string {
  if (!url) return url
  const { base: rawBase, query: rawQuery, hash: rawHash } = splitUrl(url)
  const oauth = !!options.oauth || isOauthUrl(url)
  const inner: MaskOptions = { ...options, oauth }
  const params = (part: string) =>
    part
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=')
        if (eq <= 0) return pair
        const name = pair.slice(0, eq)
        const value = pair.slice(eq + 1)
        if (!value || value === MASK) return pair
        if (isSecretName(safeDecode(name), inner)) {
          counter.add(kind)
          return `${name}=${MASK}`
        }
        const masked = maskValue(value, counter, kind, inner)
        return masked === value ? pair : `${name}=${masked}`
      })
      .join('&')
  const query = rawQuery !== null ? params(rawQuery) : null
  let hash = rawHash
  if (hash !== null && hash.includes('=')) hash = params(hash)
  else if (hash) hash = maskTokens(hash, counter, kind)
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
  base = maskTokens(base, counter, kind)
  return `${base}${query !== null ? `?${query}` : ''}${hash !== null ? `#${hash}` : ''}`
}

/** A URL: an absolute one, or a path with a query. */
export function looksLikeUrl(text: string): boolean {
  return /^[a-z][a-z0-9+.-]{0,31}:\/\/\S/i.test(text) || (text.startsWith('/') && !/\s/.test(text) && /[?#;]/.test(text))
}

/**
 * The nested-value masker for `maskValue`: decodes a value, masks it as a URL when it is one, else
 * as text (where `name=value` pairs are found by name), and encodes it back the way it came.
 */
function maskNested(value: string, counter: Counter, kind: MaskKind, options: MaskOptions): string {
  const decoded = safeDecode(value)
  let masked: string
  if (looksLikeUrl(decoded) || (decoded.includes('?') && !/\s/.test(decoded))) masked = maskUrl(decoded, counter, kind, options)
  else if (decoded.includes('=')) masked = maskText(decoded, counter, kind, options)
  else masked = maskTokens(decoded, counter, kind)
  return masked === decoded ? value : encodeLike(value, decoded, masked)
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
  if (!Array.isArray(params)) return params
  const names = params.map((param) => (param && typeof param.name === 'string' ? safeDecode(param.name) : ''))
  const inner: MaskOptions = { ...options, oauth: options.oauth || hasOauthNames(names) }
  let changed = false
  const out = params.map((param, index) => {
    if (!param || typeof param !== 'object') return param
    let next: HarNameValue = param
    if (typeof param.value === 'string' && param.value && param.value !== MASK) {
      let value: string
      if (isSecretName(names[index], inner)) {
        counter.add(kind)
        value = MASK
      } else value = maskValue(param.value, counter, kind, inner)
      if (value !== param.value) next = { ...param, value }
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

/** Copies `value` with every string inside masked as free text (URLs as URLs). */
export function maskStrings(value: unknown, counter: Counter, kind: MaskKind = 'other', depth = 0): unknown {
  if (typeof value === 'string') return maskFreeText(value, counter, kind)
  if (typeof value !== 'object' || value === null || depth > 256) return value
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((item) => {
      const next = maskStrings(item, counter, kind, depth + 1)
      if (next !== item) changed = true
      return next
    })
    return changed ? out : value
  }
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    let next: unknown
    if (typeof item === 'string' && item && item !== MASK && isSecretName(key)) {
      counter.add(kind)
      next = MASK
    } else next = maskStrings(item, counter, kind, depth + 1)
    if (next !== item) changed = true
    out[key] = next
  }
  return changed ? out : value
}
