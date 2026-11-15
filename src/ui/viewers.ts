// Body viewers: a lazy JSON tree, highlighted source, hex, and previews of images, media and fonts.
// Response HTML is only ever shown as source; images (SVG too) go through <img>, which runs no
// scripts; audio and video start muted and never play by themselves.

import { h, maskedText, svg } from '../dom'
import { charsetOf, decodeText, looksLikeText, parseJson, viewKind, type Body, type ViewKind } from '../har/body'
import { languageOf, splitLines, tokenize, type Language, type Token } from '../highlight'
import { fill } from '../i18n'
import { icon } from '../icons'
import { note, type Ctx } from './common'

const HIGHLIGHT_LIMIT = 400_000
const SOURCE_LIMIT = 2_000_000
const LINES_PER_CHUNK = 200
const LINE_HEIGHT = 17
const HEX_LIMIT = 64 * 1024
const TREE_PAGE = 100
const TREE_KEYS = 500
const STRING_LIMIT = 2000

export type BodyMode = 'tree' | 'source' | 'preview' | 'hex'
/** Choices that carry over from one request to the next. */
export type ViewPrefs = { modes: Partial<Record<ViewKind, BodyMode>>; wrap: boolean }
/** Collects clean-ups (blob URLs, font faces) for when the view goes away. */
export type Track = (dispose: () => void) => void

// ── Source ───────────────────────────────────────────────────────────────────────────────────

export function sourceView(text: string, language: Language, ctx: Ctx, wrap: boolean): HTMLElement {
  const box = h('div')
  let shown = text
  if (text.length > SOURCE_LIMIT) {
    shown = text.slice(0, SOURCE_LIMIT)
    box.append(note(fill(ctx.strings.bodyCut, { size: ctx.count(SOURCE_LIMIT), total: ctx.count(text.length) })))
  }
  const tokens: Token[] = language !== 'text' && shown.length <= HIGHLIGHT_LIMIT ? tokenize(shown, language) : [['plain', shown]]
  const lines = splitLines(tokens)
  const code = h('div', { className: `hv-code${wrap ? ' hv-wrap' : ''}` })
  code.style.setProperty('--gutter', `${String(lines.length).length + 1}ch`)
  for (let i = 0; i < lines.length; i += LINES_PER_CHUNK) {
    const end = Math.min(lines.length, i + LINES_PER_CHUNK)
    const chunk = h('div', { className: 'hv-chunk' })
    chunk.style.setProperty('contain-intrinsic-size', `auto ${(end - i) * LINE_HEIGHT}px`)
    for (let j = i; j < end; j++) {
      const text = h('span', { className: 'hv-lt' })
      for (const [kind, value] of lines[j]) {
        text.append(kind === 'plain' ? maskedText(value) : h('span', { className: `t-${kind}` }, maskedText(value)))
      }
      chunk.append(h('div', { className: 'hv-line' }, h('span', { className: 'hv-ln' }, String(j + 1)), text))
    }
    code.append(chunk)
  }
  box.append(code)
  return box
}

// ── Hex ──────────────────────────────────────────────────────────────────────────────────────

export function hexDump(bytes: Uint8Array, limit = HEX_LIMIT): string {
  const n = Math.min(bytes.length, limit)
  const lines: string[] = []
  for (let at = 0; at < n; at += 16) {
    let hex = ''
    let ascii = ''
    for (let i = 0; i < 16; i++) {
      if (at + i < n) {
        const byte = bytes[at + i]
        hex += `${byte.toString(16).padStart(2, '0')} `
        ascii += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.'
      } else hex += '   '
      if (i === 7) hex += ' '
    }
    lines.push(`${at.toString(16).padStart(8, '0')}  ${hex} ${ascii}`)
  }
  return lines.join('\n')
}

function hexView(bytes: Uint8Array, ctx: Ctx): HTMLElement {
  const shown = Math.min(bytes.length, HEX_LIMIT)
  return h(
    'div',
    {},
    note(fill(ctx.strings.binary, { size: ctx.bytes(shown) })),
    h('div', { className: 'hv-hex' }, hexDump(bytes))
  )
}

// ── JSON tree ────────────────────────────────────────────────────────────────────────────────

export function jsonTree(value: unknown): HTMLElement {
  const root = h('div', { className: 'hv-tree' })
  const small = value !== null && typeof value === 'object' && Object.keys(value).length <= 3
  root.append(treeNode(null, value, small ? 2 : 1))
  return root
}

function treeNode(key: string | null, value: unknown, openDepth: number): HTMLElement {
  const isObject = value !== null && typeof value === 'object'
  const size = isObject ? (Array.isArray(value) ? value.length : Object.keys(value as object).length) : 0
  if (!isObject || size === 0) {
    return h('div', { className: 'hv-node hv-leaf' }, keyLabel(key), isObject ? h('span', { className: 'hv-preview' }, Array.isArray(value) ? '[]' : '{}') : primitive(value))
  }
  const el = h('div', { className: 'hv-node' })
  const toggle = h('button', { type: 'button', className: 'hv-toggle', 'aria-expanded': 'false' }, svg(icon('chevron')))
  const head = h('span', {}, keyLabel(key), h('span', { className: 'hv-preview' }, preview(value)))
  const children = h('div', { hidden: true })
  let built = false
  const set = (open: boolean) => {
    if (open && !built) {
      built = true
      fillChildren(children, value as object, openDepth - 1)
    }
    children.hidden = !open
    el.classList.toggle('hv-open', open)
    toggle.setAttribute('aria-expanded', String(open))
  }
  toggle.addEventListener('click', () => set(children.hidden))
  head.addEventListener('click', () => {
    if (!window.getSelection()?.toString()) set(children.hidden)
  })
  el.append(toggle, head, children)
  if (openDepth > 0) set(true)
  return el
}

function fillChildren(container: HTMLElement, value: object, openDepth: number): void {
  if (Array.isArray(value)) {
    if (value.length > TREE_PAGE) {
      for (let from = 0; from < value.length; from += TREE_PAGE) {
        const to = Math.min(value.length, from + TREE_PAGE) - 1
        container.append(bucket(`[${from} … ${to}]`, () => value.slice(from, to + 1).map((item, i) => treeNode(String(from + i), item, 0))))
      }
    } else value.forEach((item, i) => container.append(treeNode(String(i), item, openDepth)))
    return
  }
  const keys = Object.keys(value)
  const record = value as Record<string, unknown>
  const add = (from: number) => {
    const to = Math.min(keys.length, from + TREE_KEYS)
    for (let i = from; i < to; i++) container.append(treeNode(keys[i], record[keys[i]], openDepth))
    if (to < keys.length) {
      const more = h('button', { type: 'button', className: 'hv-more' }, `… ${keys.length - to}`)
      more.addEventListener('click', () => {
        more.remove()
        add(to)
      })
      container.append(h('div', { className: 'hv-node hv-leaf' }, more))
    }
  }
  add(0)
}

function bucket(label: string, build: () => HTMLElement[]): HTMLElement {
  const el = h('div', { className: 'hv-node' })
  const toggle = h('button', { type: 'button', className: 'hv-toggle', 'aria-expanded': 'false' }, svg(icon('chevron')))
  const head = h('span', { className: 'hv-preview' }, label)
  const children = h('div', { hidden: true })
  let built = false
  const set = (open: boolean) => {
    if (open && !built) {
      built = true
      children.append(...build())
    }
    children.hidden = !open
    el.classList.toggle('hv-open', open)
    toggle.setAttribute('aria-expanded', String(open))
  }
  toggle.addEventListener('click', () => set(children.hidden))
  head.addEventListener('click', () => set(children.hidden))
  el.append(toggle, head, children)
  return el
}

function keyLabel(key: string | null): Node | null {
  if (key === null) return null
  return h('span', {}, h('span', { className: 'hv-k' }, key), ': ')
}

function primitive(value: unknown): HTMLElement {
  if (typeof value === 'string') {
    const el = h('span', { className: 'hv-v-string' })
    if (value.length <= STRING_LIMIT) {
      el.append('"', maskedText(value), '"')
    } else {
      const more = h('button', { type: 'button', className: 'hv-more' }, `… +${value.length - STRING_LIMIT}`)
      el.append('"', maskedText(value.slice(0, STRING_LIMIT)), more, '"')
      more.addEventListener('click', () => {
        el.replaceChildren('"', maskedText(value), '"')
      })
    }
    return el
  }
  if (typeof value === 'number') return h('span', { className: 'hv-v-number' }, String(value))
  return h('span', { className: 'hv-v-literal' }, String(value))
}

/** `{id: 42, name: "Demo", …}` or `Array(12)`. */
export function preview(value: unknown): string {
  if (Array.isArray(value)) return `Array(${value.length})`
  if (value === null || typeof value !== 'object') return shortValue(value)
  let out = ''
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const part = `${key}: ${shortValue(item)}`
    if (out.length + part.length > 72) {
      out += out ? ', …' : '…'
      break
    }
    out += out ? `, ${part}` : part
  }
  return `{${out}}`
}

function shortValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value.length > 24 ? `${value.slice(0, 24)}…` : value)
  if (Array.isArray(value)) return `Array(${value.length})`
  if (value !== null && typeof value === 'object') return '{…}'
  return String(value)
}

// ── Media ────────────────────────────────────────────────────────────────────────────────────

function imageView(blob: Blob, ctx: Ctx, track: Track): HTMLElement {
  const url = URL.createObjectURL(blob)
  track(() => URL.revokeObjectURL(url))
  const info = h('span', { className: 'hv-muted' })
  const img = h('img', { src: url, alt: '' })
  img.addEventListener('load', () => {
    info.textContent = `${img.naturalWidth} × ${img.naturalHeight} · ${ctx.bytes(blob.size)}`
  })
  return h('div', { className: 'hv-media' }, h('div', { className: 'hv-checker' }, img), info)
}

function mediaView(blob: Blob, kind: 'audio' | 'video', ctx: Ctx, track: Track): HTMLElement {
  const url = URL.createObjectURL(blob)
  track(() => URL.revokeObjectURL(url))
  const player = kind === 'video' ? h('video', { controls: true, preload: 'metadata', playsinline: true }) : h('audio', { controls: true, preload: 'metadata' })
  // Set as properties too: the attribute alone does not mute in every engine.
  player.muted = true
  player.defaultMuted = true
  player.autoplay = false
  player.src = url
  track(() => {
    player.pause()
    player.removeAttribute('src')
    player.load()
  })
  return h('div', { className: 'hv-media' }, player, h('span', { className: 'hv-muted' }, `${ctx.strings.mediaMuted} ${ctx.bytes(blob.size)}`))
}

let fontCounter = 0

/** `document.fonts` as a set; the DOM typings here leave out its Set methods. */
const fontSet = () => document.fonts as unknown as { add(face: FontFace): void; delete(face: FontFace): boolean }

function fontView(bytes: Uint8Array, ctx: Ctx, track: Track): HTMLElement {
  const family = `hv-preview-${++fontCounter}`
  const sample = h('div', { style: 'font-size:28px;line-height:1.3;overflow-wrap:anywhere' }, 'The quick brown fox jumps over the lazy dog')
  const box = h('div', { className: 'hv-media' }, sample, h('div', { style: 'font-size:18px' }, 'Съешь же ещё этих мягких французских булок · 0123456789'))
  try {
    const face = new FontFace(family, bytes.slice().buffer)
    face
      .load()
      .then((loaded) => {
        fontSet().add(loaded)
        track(() => fontSet().delete(loaded))
        box.style.fontFamily = `"${family}", var(--ui-font)`
      })
      .catch(() => box.replaceChildren(hexView(bytes, ctx)))
  } catch {
    return hexView(bytes, ctx)
  }
  return box
}

// ── Body ─────────────────────────────────────────────────────────────────────────────────────

/** A request or response body with its view modes and a line about its size and origin. */
export function bodyView(body: Body, ctx: Ctx, prefs: ViewPrefs, track: Track): HTMLElement {
  const s = ctx.strings
  if (body.kind === 'none') {
    if (body.reason === 'external-file') return note(fill(s.externalFile, { file: body.file ?? '' }))
    if (body.reason === 'missing-file') return note(fill(s.missingFile, { file: body.file ?? '' }))
    return note(body.reason === 'empty' ? s.emptyBody : s.notRecorded)
  }
  let kind: ViewKind
  let modes: BodyMode[]
  let text: string | null = null
  let json: unknown
  if (body.kind === 'text') {
    text = body.text
    kind = viewKind(body.mimeType, text)
    if (kind === 'json') {
      json = parseJson(text)
      modes = json === undefined ? ['source'] : ['tree', 'source']
    } else if (kind === 'image') modes = ['preview', 'source']
    else modes = ['source']
  } else {
    kind = viewKind(body.mimeType)
    if (kind === 'image' || kind === 'audio' || kind === 'video' || kind === 'font') modes = ['preview', 'hex']
    else if (looksLikeText(body.bytes)) {
      text = decodeText(body.bytes, charsetOf(body.mimeType))
      modes = ['source', 'hex']
    } else modes = ['hex']
  }
  const saved = prefs.modes[kind]
  let mode: BodyMode = saved && modes.includes(saved) ? saved : modes[0]

  const root = h('div')
  const bar = h('div', { className: 'hv-subbar' })
  const content = h('div')
  const labels: Record<BodyMode, string> = { tree: s.tree, source: s.source, preview: s.preview, hex: s.hex }
  const seg = h('div', { className: 'hv-seg', role: 'group' })
  const segButtons = modes.map((m) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(m === mode) }, labels[m])
    b.addEventListener('click', () => {
      mode = m
      prefs.modes[kind] = m
      for (const other of segButtons) other.setAttribute('aria-pressed', String(other === b))
      render()
    })
    return b
  })
  seg.append(...segButtons)
  if (modes.length > 1) bar.append(seg)
  const wrapBox = h('input', { type: 'checkbox' })
  wrapBox.checked = prefs.wrap
  wrapBox.addEventListener('change', () => {
    prefs.wrap = wrapBox.checked
    render()
  })
  const wrapLabel = h('label', { className: 'hv-check' }, wrapBox, s.wrap)
  bar.append(wrapLabel)
  const facts = [body.mimeType || '—', ctx.bytes(body.kind === 'text' ? body.size : body.bytes.length)]
  if (body.kind === 'text' && body.base64) facts.push(s.base64)
  if (body.file) facts.push(fill(s.fromFile, { file: body.file }))
  bar.append(h('span', { className: 'hv-spacer' }), h('span', {}, facts.join(' · ')))

  const render = () => {
    wrapLabel.hidden = mode !== 'source'
    let view: HTMLElement
    if (mode === 'tree') view = jsonTree(json)
    else if (mode === 'source') {
      let shown = text ?? ''
      // One-line JSON reads better indented.
      if (kind === 'json' && json !== undefined && !shown.includes('\n') && shown.length > 80) shown = JSON.stringify(json, null, 2)
      view = sourceView(shown, kind === 'image' ? 'xml' : languageOf(kind), ctx, prefs.wrap)
    } else if (mode === 'preview') {
      const mime = body.mimeType.split(';')[0].trim() || 'application/octet-stream'
      if (body.kind === 'text') view = imageView(new Blob([body.text], { type: mime }), ctx, track)
      else if (kind === 'audio' || kind === 'video') view = mediaView(new Blob([body.bytes.slice()], { type: mime }), kind, ctx, track)
      else if (kind === 'font') view = fontView(body.bytes, ctx, track)
      else view = imageView(new Blob([body.bytes.slice()], { type: mime }), ctx, track)
    } else {
      view = hexView(body.kind === 'bytes' ? body.bytes : new TextEncoder().encode(text ?? ''), ctx)
    }
    content.replaceChildren(view)
  }
  render()
  root.append(bar, content)
  return root
}
