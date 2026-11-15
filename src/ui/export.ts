// "Export for agent": picks requests (selected, failed or the ones in the list), builds the
// Markdown digest from the masked copy of the HAR, and copies it or saves it as a .md file.

import { h } from '../dom'
import type { SideFiles } from '../har/body'
import { buildDigest, DIGEST_MAX_BODY } from '../har/digest'
import type { Entry, Model } from '../har/model'
import { fill } from '../i18n'
import { copyText, iconButton, type Ctx } from './common'

export const EXPORT_CAP = 100

export type ExportChoice = 'selected' | 'failed' | 'visible'

/** Indexes of each choice, and the masked data the digest is built from. */
export type ExportInput = {
  model: Model
  files?: SideFiles
  selected: number[]
  failed: number[]
  visible: number[]
  date: string
}

export class ExportPopover {
  readonly root = h('div', { className: 'hv-pop', role: 'dialog', hidden: true })
  private choice: ExportChoice | null = null
  private bodies = true
  private markdown = ''
  private input: ExportInput | null = null
  private readonly onOutside = (event: MouseEvent) => {
    const target = event.target as Node
    if (!this.root.contains(target) && !(target instanceof Element && target.closest('[data-export-toggle]'))) this.close()
  }

  constructor(private readonly ctx: Ctx) {
    this.root.setAttribute('aria-label', ctx.strings.exportTitle)
  }

  get isOpen(): boolean {
    return !this.root.hidden
  }

  toggle(input: ExportInput): void {
    if (this.isOpen) this.close()
    else this.open(input)
  }

  open(input: ExportInput): void {
    this.input = input
    if (!this.choice || !input[this.choice].length) {
      this.choice = input.selected.length ? 'selected' : input.failed.length ? 'failed' : 'visible'
    }
    this.root.hidden = false
    this.render()
    document.addEventListener('mousedown', this.onOutside, true)
  }

  close(): void {
    this.root.hidden = true
    this.input = null
    document.removeEventListener('mousedown', this.onOutside, true)
  }

  private render(): void {
    const input = this.input
    if (!input || !this.choice) return
    const s = this.ctx.strings
    const choices: [ExportChoice, string][] = [
      ['selected', s.exportSelected],
      ['failed', s.exportFailed],
      ['visible', s.exportVisible]
    ]
    const fieldset = h('fieldset', {}, h('legend', {}, s.exportWhich))
    for (const [choice, label] of choices) {
      const n = input[choice].length
      const radio = h('input', { type: 'radio', name: 'hv-export', disabled: n === 0 })
      radio.checked = choice === this.choice
      radio.addEventListener('change', () => {
        this.choice = choice
        this.render()
      })
      const capped = n > EXPORT_CAP ? ` — ${fill(s.exportCapped, { n: EXPORT_CAP })}` : ''
      fieldset.append(h('label', { className: 'hv-check' }, radio, fill(label, { n: this.ctx.count(n) }) + capped))
      // How to pick requests for the export, which the list itself does not say.
      if (choice === 'selected') fieldset.append(h('span', { className: 'hv-note hv-hint' }, s.selectHint))
    }
    const bodies = h('input', { type: 'checkbox' })
    bodies.checked = this.bodies
    bodies.addEventListener('change', () => {
      this.bodies = bodies.checked
      this.render()
    })
    const indexes = input[this.choice].slice(0, EXPORT_CAP)
    const entries: Entry[] = indexes.map((i) => input.model.entries[i])
    this.markdown = buildDigest(input.model, entries, { title: digestTitle(this.choice, entries.length), bodies: this.bodies, files: input.files })
    const area = h('textarea', { readonly: true, spellcheck: 'false', 'aria-label': 'Markdown' })
    area.value = this.markdown
    const copy = h('button', { type: 'button', className: 'hv-btn hv-primary' }, s.exportCopy)
    copy.addEventListener('click', () => {
      void copyText(this.markdown).then((ok) => {
        if (ok) {
          this.ctx.toast(s.exportCopied)
          return
        }
        area.focus()
        area.select()
        this.ctx.toast(s.exportManual)
      })
    })
    const actions = h('div', { className: 'hv-actions' }, h('span', { className: 'hv-note' }, `${s.exportNote} ${s.characters(this.markdown.length)}.`))
    const saveAs = this.ctx.saveAs
    if (saveAs) {
      const save = h('button', { type: 'button', className: 'hv-btn' }, s.exportSave)
      save.addEventListener('click', () => {
        saveAs({ suggestedName: `har-digest-${input.date}.md`, mimeType: 'text/markdown', data: this.markdown })
          .then((result) => {
            if (result.status === 'saved') this.ctx.toast(s.saved)
          })
          .catch(() => this.ctx.toast(s.saveFailed))
      })
      actions.append(save)
    }
    actions.append(copy)
    this.root.replaceChildren(
      h('div', { style: 'display:flex;align-items:center;gap:8px' }, h('h3', { style: 'flex:1' }, s.exportTitle), iconButton('close', s.close, () => this.close())),
      fieldset,
      h('label', { className: 'hv-check' }, bodies, fill(s.exportBodies, { n: this.ctx.count(DIGEST_MAX_BODY) })),
      area,
      actions
    )
  }
}

/** The digest is read by agents, so its title stays English like the rest of it. */
function digestTitle(choice: ExportChoice, n: number): string {
  const what = choice === 'selected' ? 'selected request' : choice === 'failed' ? 'failed request' : 'request'
  return `${n} ${what}${n === 1 ? '' : 's'}${choice === 'visible' ? ' shown in the viewer' : ''}`
}
