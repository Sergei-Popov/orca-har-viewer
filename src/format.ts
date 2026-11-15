// Numbers for people: sizes, durations, clock times. English by default; the view passes Russian
// units and separators when Orca's UI is Russian.

export type Units = { b: string; kb: string; mb: string; gb: string; ms: string; s: string; min: string }

export const EN_UNITS: Units = { b: 'B', kb: 'kB', mb: 'MB', gb: 'GB', ms: 'ms', s: 's', min: 'min' }

/** 0 B, 812 B, 12.3 kB, 1.4 MB (decimal units, like DevTools); '—' for unknown (< 0). */
export function formatBytes(bytes: number, units: Units = EN_UNITS, locale = 'en'): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1000) return `${Math.round(bytes)} ${units.b}`
  const steps: [number, string][] = [
    [1e9, units.gb],
    [1e6, units.mb],
    [1e3, units.kb]
  ]
  for (const [size, unit] of steps) {
    if (bytes >= size * 0.9995 || size === 1e3) {
      const value = bytes / size
      return `${number(value, value < 10 ? 1 : value < 100 ? 1 : 0, locale)} ${unit}`
    }
  }
  return `${bytes} ${units.b}`
}

/** 0.4 ms, 12 ms, 1.23 s, 2.1 min; '—' for unknown. */
export function formatMs(ms: number, units: Units = EN_UNITS, locale = 'en'): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1) return `${number(ms, 2, locale)} ${units.ms}`
  if (ms < 10) return `${number(ms, 1, locale)} ${units.ms}`
  if (ms < 1000) return `${number(ms, 0, locale)} ${units.ms}`
  if (ms < 60_000) return `${number(ms / 1000, 2, locale)} ${units.s}`
  return `${number(ms / 60_000, 1, locale)} ${units.min}`
}

/** Russian separators for any `ru-*` tag; English ones otherwise, whatever else the tag is. */
function numberLocale(locale: string): string {
  return locale.toLowerCase().startsWith('ru') ? 'ru' : 'en'
}

export function number(value: number, digits: number, locale = 'en'): string {
  return value.toLocaleString(numberLocale(locale), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })
}

export function count(value: number, locale = 'en'): string {
  return value.toLocaleString(numberLocale(locale))
}

/** 10:22:01.123 in UTC (HAR times are absolute; UTC keeps screenshots and exports stable). */
export function clockTime(epoch: number): string {
  if (!Number.isFinite(epoch)) return '—'
  const d = new Date(epoch)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
}

/** 2026-11-15 10:22:01 UTC */
export function dateTime(epoch: number): string {
  if (!Number.isFinite(epoch)) return '—'
  const d = new Date(epoch)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
}

/** A tick step for a time axis: 1, 2, 5 × 10ⁿ ms so that about `target` ticks fit. */
export function tickStep(span: number, target = 8): number {
  if (!(span > 0)) return 100
  const raw = span / target
  const power = 10 ** Math.floor(Math.log10(raw))
  for (const factor of [1, 2, 5, 10]) if (power * factor >= raw) return power * factor
  return power * 10
}

/** `29 requests`, or `4 / 29 requests` while a filter hides some: what the list counts. */
export function shownOf(shown: number, total: number, noun: (n: number) => string, format: (n: number) => string = (n) => count(n)): string {
  return shown === total ? noun(total) : `${format(shown)} / ${noun(total)}`
}

/**
 * Where a host name or URL may wrap in a narrow column: after dots, slashes (not inside `://`)
 * and query punctuation, so it reads `api.` / `example.com` rather than `api.ex` / `ample.com`.
 * A run of more than `max` characters with no such point, a random token for example, is cut
 * every `max` characters, so it cannot push a table wider than its pane. Joined, the pieces give
 * the text back; characters outside the BMP are never split.
 */
export function wrapPieces(text: string, max = 12): string[] {
  const chars = Array.from(text)
  const pieces: string[] = []
  let piece = ''
  let run = 0
  chars.forEach((ch, i) => {
    piece += ch
    run++
    const after = '.?&#=;,'.includes(ch) || /\s/.test(ch) || (ch === '/' && chars[i + 1] !== '/')
    if (after || run >= max) {
      pieces.push(piece)
      piece = ''
      run = 0
    }
  })
  if (piece) pieces.push(piece)
  return pieces
}
