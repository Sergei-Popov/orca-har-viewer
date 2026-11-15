// A tiny element builder: text goes in as text nodes, never as HTML, because everything shown
// comes from the HAR. Only the static icon strings in icons.ts are inserted as markup.

import { wrapPieces } from './format'
import { MASK } from './har/sanitize'

type Child = Node | string | null | undefined | false

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | number | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue
    if (key === 'className') el.className = String(value)
    else el.setAttribute(key, value === true ? '' : String(value))
  }
  append(el, ...children)
  return el
}

export function append(el: Element | DocumentFragment, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    el.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
}

/** One of the static SVG icons from icons.ts as an element. */
export function svg(markup: string): Element {
  const template = document.createElement('template')
  template.innerHTML = markup
  const el = template.content.firstElementChild
  if (!el) throw new Error('empty icon')
  return el
}

/** Text with each `[masked]` marked, so masked values stand out. */
export function maskedText(text: string): Node {
  if (!text.includes(MASK)) return document.createTextNode(text)
  const fragment = document.createDocumentFragment()
  const parts = text.split(MASK)
  parts.forEach((part, i) => {
    if (part) fragment.append(part)
    if (i < parts.length - 1) fragment.append(h('span', { className: 'hv-maskmark' }, MASK))
  })
  return fragment
}

/** A host name or URL that wraps only where {@link wrapPieces} allows, through `<wbr>`. */
export function wrappable(text: string): Node {
  const pieces = wrapPieces(text)
  if (pieces.length < 2) return document.createTextNode(text)
  const fragment = document.createDocumentFragment()
  pieces.forEach((piece, i) => {
    if (i) fragment.append(document.createElement('wbr'))
    fragment.append(piece)
  })
  return fragment
}

export function clear(el: Element): void {
  el.replaceChildren()
}
