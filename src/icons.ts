// Inline 16×16 icons drawn with `currentColor`, so they follow the theme.

const paths = {
  search: '<circle cx="7" cy="7" r="4.25"/><path d="m10.25 10.25 3.5 3.5"/>',
  chevron: '<path d="M6 3.5 10.5 8 6 12.5"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  copy: '<rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.25"/><path d="M10.75 5.25V3.5c0-.69-.56-1.25-1.25-1.25H3.5c-.69 0-1.25.56-1.25 1.25v6c0 .69.56 1.25 1.25 1.25h1.75"/>',
  shield: '<path d="M8 1.75 2.75 3.75v4c0 3.1 2.2 5.4 5.25 6.5 3.05-1.1 5.25-3.4 5.25-6.5v-4z"/><path d="m5.75 8 1.6 1.6 3-3.1"/>',
  save: '<path d="M8 2v8.25M4.75 7 8 10.25 11.25 7M2.5 11.5v1.75c0 .41.34.75.75.75h9.5c.41 0 .75-.34.75-.75V11.5"/>',
  agent: '<rect x="2.25" y="4.25" width="11.5" height="8.5" rx="2"/><path d="M8 4.25V2.25M5.75 8.25v.5M10.25 8.25v.5M6 11h4"/>',
  warning: '<path d="M8 1.75 1.5 13.25h13z"/><path d="M8 6.25v3.5M8 11.5v.25"/>',
  error: '<circle cx="8" cy="8" r="6.25"/><path d="m5.75 5.75 4.5 4.5M10.25 5.75l-4.5 4.5"/>',
  terminal: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.25"/><path d="m4.5 6 2 2-2 2M8.5 10.5h3"/>',
  code: '<path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5l3.5 3.5-3.5 3.5"/>',
  link: '<path d="M6.75 9.25a2.6 2.6 0 0 0 3.7 0l2.1-2.1a2.6 2.6 0 0 0-3.7-3.7l-.6.6"/><path d="M9.25 6.75a2.6 2.6 0 0 0-3.7 0l-2.1 2.1a2.6 2.6 0 0 0 3.7 3.7l.6-.6"/>',
  up: '<path d="M8 13V3M4 7l4-4 4 4"/>',
  down: '<path d="M8 3v10M4 9l4 4 4-4"/>'
}

export type IconName = keyof typeof paths

export function icon(name: IconName, className = ''): string {
  return `<svg class="hv-icon ${className}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`
}
