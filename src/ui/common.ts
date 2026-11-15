// Shared pieces of the view: the context every part gets, the clipboard, collapsible sections and
// name/value lists.

import { append, h, maskedText, svg } from '../dom'
import type { SideFiles } from '../har/body'
import type { Model } from '../har/model'
import type { HarNameValue } from '../har/types'
import type { Strings } from '../i18n'
import { icon } from '../icons'

export type SaveAs = (options: {
  suggestedName?: string
  mimeType?: string
  data: string | ArrayBuffer | ArrayBufferView
}) => Promise<{ status: 'saved' | 'cancelled' }>

export type Ctx = {
  strings: Strings
  locale: string
  bytes(n: number): string
  ms(n: number): string
  count(n: number): string
  toast(text: string): void
  saveAs?: SaveAs
}

/** What the view shows: the HAR as read, or its masked copy. */
export type Dataset = { model: Model; files?: SideFiles; maskedEntries?: Set<number> }

/**
 * Copies text. `execCommand` runs inside the click that asked for it, which the async clipboard
 * may refuse in a frame; the async clipboard is the second try.
 */
export async function copyText(text: string): Promise<boolean> {
  const active = document.activeElement as HTMLElement | null
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0'
  document.body.append(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  active?.focus?.()
  if (ok) return true
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

const sectionState = new Map<string, boolean>()

/** A collapsible block with a title; open or closed is remembered by `key` while the tab lives. */
export function section(
  key: string,
  title: string,
  body: Node,
  options: { count?: number; actions?: Node[]; open?: boolean } = {}
): HTMLElement {
  const open = sectionState.get(key) ?? options.open ?? true
  const header = h(
    'header',
    { role: 'button', tabindex: 0, 'aria-expanded': String(open) },
    svg(icon('chevron', 'hv-chev')),
    title,
    options.count !== undefined ? h('span', { className: 'hv-count' }, `(${options.count})`) : null,
    h('span', { className: 'hv-spacer' })
  )
  for (const action of options.actions ?? []) {
    action.addEventListener('click', (event) => event.stopPropagation())
    header.append(action)
  }
  const el = h('section', { className: `hv-section${open ? '' : ' hv-closed'}` }, header, h('div', { className: 'hv-sbody' }, body))
  const toggle = () => {
    const next = el.classList.toggle('hv-closed')
    sectionState.set(key, !next)
    header.setAttribute('aria-expanded', String(!next))
  }
  header.addEventListener('click', toggle)
  header.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggle()
    }
  })
  return el
}

/** A two-column list; values may show `[masked]`. */
export function kvList(rows: [string, string | Node][], className = ''): HTMLElement {
  const dl = h('dl', { className: `hv-kv ${className}` })
  for (const [name, value] of rows) {
    append(dl, h('dt', { title: name }, name), h('dd', {}, typeof value === 'string' ? maskedText(value) : value))
  }
  return dl
}

export function headerRows(headers: HarNameValue[] | undefined): [string, string][] {
  if (!Array.isArray(headers)) return []
  return headers
    .filter((header) => header && typeof header.name === 'string')
    .map((header) => [header.name, typeof header.value === 'string' ? header.value : String(header.value ?? '')])
}

export function note(text: string): HTMLElement {
  return h('div', { className: 'hv-dnote' }, text)
}

export function button(label: string | Node, options: { title?: string; className?: string; onClick: (event: MouseEvent) => void }): HTMLButtonElement {
  const el = h('button', { type: 'button', className: `hv-btn ${options.className ?? ''}`, title: options.title }, label)
  el.addEventListener('click', options.onClick)
  return el
}

export function iconButton(name: Parameters<typeof icon>[0], label: string, onClick: (event: MouseEvent) => void, text?: string): HTMLButtonElement {
  const el = h('button', { type: 'button', className: `hv-btn${text ? '' : ' hv-square'}`, title: label, 'aria-label': label }, svg(icon(name)))
  if (text) el.append(text)
  el.addEventListener('click', onClick)
  return el
}

/** Whether keys typed now belong to a text field rather than to the viewer. */
export function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
}
