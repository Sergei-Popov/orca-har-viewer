// What the toolbar menus list, worked out from the model on screen (the masked one while masking is
// on, so page titles show [masked] there too). No DOM, so it is tested directly.

import type { Model } from '../har/model'

export type Choice = { value: string; label: string }

const TITLE_CHARS = 60

/** The page menu after "All pages": each page by title, and "Without a page" when some requests have none. */
export function pageChoices(model: Model, noPage: string): Choice[] {
  const out: Choice[] = model.pages.map((page) => ({
    value: `=${page.id}`,
    label: page.title.length > TITLE_CHARS ? `${page.title.slice(0, TITLE_CHARS)}…` : page.title
  }))
  if (model.pages.length && model.entries.some((e) => !e.pageId)) out.push({ value: '-', label: noPage })
  return out
}
