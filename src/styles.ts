// The page's CSS, built on the `--orca-*` theme variables so it follows Orca's light and dark
// themes; Orca updates the variables in place and toggles `light`/`dark` on <html>.

export const ROW_HEIGHT = 22

export const css = String.raw`
:root {
  --bg: var(--orca-background, #ffffff);
  --fg: var(--orca-foreground, #0a0a0a);
  --card: var(--orca-card, #ffffff);
  --muted: var(--orca-muted, #f5f5f5);
  --muted-fg: var(--orca-muted-foreground, #737373);
  --accent: var(--orca-accent, #f5f5f5);
  --accent-fg: var(--orca-accent-foreground, #171717);
  --border: var(--orca-border, #e5e5e5);
  --input: var(--orca-input, #e5e5e5);
  --primary: var(--orca-primary, #171717);
  --primary-fg: var(--orca-primary-foreground, #fafafa);
  --ring: var(--orca-ring, #a3a3a3);
  --destructive: var(--orca-destructive, #dc2626);
  --popover: var(--orca-popover, #ffffff);
  --popover-fg: var(--orca-popover-foreground, #0a0a0a);
  --radius: var(--orca-radius, 6px);
  --select: color-mix(in srgb, var(--primary) 7%, transparent);
  --select-strong: color-mix(in srgb, #2f7fd8 20%, transparent);
  --hover: color-mix(in srgb, var(--fg) 5%, transparent);
  --stripe: color-mix(in srgb, var(--fg) 2.5%, transparent);
  --err: #d92d20;
  --warn: #b7791f;
  --ok: #1f8a4c;
  --redirect: #8a6d1f;
  --info: #2f6fd8;
  --masked: #8b5cf6;
  --wf-queue: #b8bec9;
  --wf-dns: #0f9b8e;
  --wf-connect: #e8891c;
  --wf-ssl: #a54fd6;
  --wf-send: #64748b;
  --wf-wait: #1f9d55;
  --wf-receive: #2f7fd8;
  --wf-fail: #e5484d;
  --mark-dcl: #2f7fd8;
  --mark-load: #e5484d;
  --tok-key: #9b2c8f;
  --tok-string: #1a7f37;
  --tok-number: #1f5fbf;
  --tok-literal: #b35900;
  --tok-keyword: #8a3ffc;
  --tok-comment: #8b949e;
  --tok-tag: #22863a;
  --tok-attr: #6f42c1;
  --tok-prop: #005cc5;
  --ui-font: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono-font: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --row: ${ROW_HEIGHT}px;
  color-scheme: light;
}
:root.dark {
  --bg: var(--orca-background, #0a0a0a);
  --fg: var(--orca-foreground, #fafafa);
  --card: var(--orca-card, #0a0a0a);
  --muted: var(--orca-muted, #262626);
  --muted-fg: var(--orca-muted-foreground, #a3a3a3);
  --accent: var(--orca-accent, #262626);
  --accent-fg: var(--orca-accent-foreground, #fafafa);
  --border: var(--orca-border, #2e2e2e);
  --input: var(--orca-input, #2e2e2e);
  --primary: var(--orca-primary, #fafafa);
  --primary-fg: var(--orca-primary-foreground, #171717);
  --ring: var(--orca-ring, #737373);
  --destructive: var(--orca-destructive, #f87171);
  --popover: var(--orca-popover, #171717);
  --popover-fg: var(--orca-popover-foreground, #fafafa);
  --select-strong: color-mix(in srgb, #4f8cff 26%, transparent);
  --err: #ff6b62;
  --warn: #e0a84a;
  --ok: #4cc38a;
  --redirect: #d2b25c;
  --info: #6aa1ff;
  --masked: #a78bfa;
  --wf-queue: #5b6270;
  --wf-dns: #22b8a8;
  --wf-connect: #f0a040;
  --wf-ssl: #c084fc;
  --wf-send: #8b98ad;
  --wf-wait: #34c46e;
  --wf-receive: #4f8cff;
  --wf-fail: #ff6b62;
  --mark-dcl: #6aa1ff;
  --mark-load: #ff6b62;
  --tok-key: #e6a5e0;
  --tok-string: #8fd18f;
  --tok-number: #79b8ff;
  --tok-literal: #ffab70;
  --tok-keyword: #c4a2ff;
  --tok-comment: #7d8590;
  --tok-tag: #7ee2a8;
  --tok-attr: #b392f0;
  --tok-prop: #79b8ff;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font: 12px/1.4 var(--ui-font);
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}
button, select, input, textarea { font: inherit; color: inherit; }
[hidden] { display: none !important; }
* { scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--muted-fg) 45%, transparent) transparent; }
.hv-icon { width: 14px; height: 14px; display: block; flex: none; }
.hv-mono { font-family: var(--mono-font); font-size: 11.5px; }
.hv-muted { color: var(--muted-fg); }
.hv-err { color: var(--err); }

.hv-app { display: flex; flex-direction: column; height: 100%; min-height: 0; position: relative; }

/* Toolbar */
.hv-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 6px 8px; border-bottom: 1px solid var(--border); }
.hv-bar + .hv-bar { padding-top: 0; }
.hv-spacer { flex: 1; }
.hv-search { position: relative; display: flex; align-items: center; flex: 0 1 300px; min-width: 160px; }
.hv-search .hv-icon { position: absolute; left: 7px; color: var(--muted-fg); pointer-events: none; }
.hv-search input {
  width: 100%; height: 26px; padding: 0 8px 0 26px; border: 1px solid var(--input); border-radius: var(--radius);
  background: var(--bg); color: var(--fg);
}
.hv-search input::placeholder { color: var(--muted-fg); }
.hv-select {
  height: 26px; padding: 0 6px; border: 1px solid var(--input); border-radius: var(--radius); background: var(--bg); color: var(--fg);
  max-width: 220px;
}
.hv-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 9px;
  border: 1px solid var(--input); border-radius: var(--radius); background: var(--bg); color: var(--fg); cursor: pointer; white-space: nowrap;
}
.hv-btn:hover:not(:disabled) { background: var(--accent); color: var(--accent-fg); }
.hv-btn:disabled { opacity: .5; cursor: default; }
.hv-btn[aria-pressed="true"] { background: var(--select-strong); border-color: color-mix(in srgb, var(--info) 45%, var(--input)); }
.hv-btn.hv-square { width: 26px; padding: 0; justify-content: center; }
.hv-btn.hv-primary { background: var(--primary); color: var(--primary-fg); border-color: var(--primary); }
.hv-btn.hv-primary:hover:not(:disabled) { background: color-mix(in srgb, var(--primary) 88%, var(--bg)); color: var(--primary-fg); }
.hv-btn.hv-errors[aria-pressed="true"] { color: var(--err); background: color-mix(in srgb, var(--err) 12%, transparent); border-color: color-mix(in srgb, var(--err) 40%, var(--input)); }
.hv-btn.hv-mask[aria-pressed="true"] { color: var(--masked); background: color-mix(in srgb, var(--masked) 13%, transparent); border-color: color-mix(in srgb, var(--masked) 45%, var(--input)); }
:is(.hv-btn, .hv-select, .hv-search input, .hv-chip, .hv-tab, .hv-link, .hv-th):focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.hv-chips { display: flex; flex-wrap: wrap; gap: 2px; align-items: center; }
.hv-chip {
  height: 22px; padding: 0 8px; border: 1px solid transparent; border-radius: 999px; background: none; color: var(--muted-fg);
  cursor: pointer; white-space: nowrap;
}
.hv-chip:hover { background: var(--hover); color: var(--fg); }
.hv-chip[aria-pressed="true"] { background: var(--select-strong); color: var(--fg); border-color: color-mix(in srgb, var(--info) 40%, transparent); }
.hv-chip .hv-count { opacity: .6; margin-left: 4px; font-size: 10.5px; }
@media (max-width: 1240px) { .hv-bar .hv-label { display: none; } .hv-select { max-width: 170px; } }
.hv-sep { width: 1px; height: 16px; background: var(--border); margin: 0 4px; }

/* Notices */
.hv-notice { display: flex; align-items: center; gap: 8px; padding: 5px 10px; border-bottom: 1px solid var(--border); }
.hv-notice.hv-warn { color: var(--warn); background: color-mix(in srgb, var(--warn) 9%, transparent); }
.hv-notice.hv-masked { color: var(--masked); background: color-mix(in srgb, var(--masked) 9%, transparent); }
.hv-notice .hv-btn { height: 22px; }
.hv-notice span { flex: 1; min-width: 0; }

/* Main split */
.hv-main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(300px, var(--list, 64%)) 5px minmax(260px, 1fr); }
.hv-split { cursor: col-resize; background: var(--border); background-clip: content-box; padding: 0 2px; }
.hv-split:hover, .hv-split.hv-dragging { background-color: var(--ring); }
@media (max-width: 760px) {
  .hv-main { grid-template-columns: 1fr; grid-template-rows: minmax(160px, var(--list-h, 55%)) 5px minmax(0, 1fr); }
  .hv-split { cursor: row-resize; padding: 2px 0; }
}

/* Request list */
.hv-list { display: flex; flex-direction: column; min-width: 0; min-height: 0; outline: none; }
.hv-grid { display: grid; grid-template-columns: var(--cols); align-items: center; }
.hv-head { border-bottom: 1px solid var(--border); background: var(--muted); color: var(--muted-fg); height: 24px; position: relative; }
.hv-th {
  height: 24px; padding: 0 6px; border: 0; border-right: 1px solid var(--border); background: none; color: inherit; text-align: left;
  display: flex; align-items: center; gap: 3px; cursor: pointer; overflow: hidden; white-space: nowrap; font-size: 11.5px;
}
.hv-th:hover { color: var(--fg); background: var(--hover); }
.hv-th.hv-num { justify-content: flex-end; }
.hv-th .hv-arrow { font-size: 9px; }
.hv-th.hv-wf { position: relative; border-right: 0; cursor: pointer; }
.hv-tick { position: absolute; top: 5px; font-size: 10px; color: var(--muted-fg); transform: translateX(-50%); white-space: nowrap; pointer-events: none; }
.hv-tick.hv-first { transform: none; }
.hv-viewport { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; position: relative; outline: none; }
.hv-sizer { position: relative; width: 100%; }
.hv-row {
  position: absolute; left: 0; right: 0; height: var(--row); cursor: default;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent);
}
.hv-row:nth-child(even) { background: var(--stripe); }
.hv-row:hover { background: var(--hover); }
.hv-row.hv-picked { background: var(--select); }
.hv-row.hv-current { background: var(--select-strong); }
.hv-row.hv-error { color: var(--err); }
.hv-row.hv-error .hv-dim { color: color-mix(in srgb, var(--err) 75%, var(--muted-fg)); }
.hv-cell { padding: 0 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: var(--row); }
.hv-cell.hv-num { text-align: right; font-variant-numeric: tabular-nums; }
.hv-dim { color: var(--muted-fg); }
.hv-st-3 { color: var(--redirect); }
.hv-shield { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--masked); margin-right: 5px; vertical-align: 1px; }
.hv-wfcell { position: relative; height: 100%; padding: 0; overflow: hidden; }
.hv-wf-grid { position: absolute; inset: 0; background-image: repeating-linear-gradient(to right, color-mix(in srgb, var(--border) 80%, transparent) 0 1px, transparent 1px var(--tick, 10%)); }
.hv-mark { position: absolute; top: 0; bottom: 0; width: 1px; }
.hv-mark.hv-dcl { background: var(--mark-dcl); }
.hv-mark.hv-load { background: var(--mark-load); }
.hv-bar-wf { position: absolute; top: 6px; height: 10px; display: flex; min-width: 2px; }
.hv-bar-wf i { display: block; height: 100%; min-width: 0; }
.hv-seg-setup { background: var(--wf-queue); }
.hv-seg-wait { background: var(--wf-wait); }
.hv-seg-receive { background: var(--wf-receive); }
.hv-seg-fail { background: var(--wf-fail); }
.hv-seg-cache { background: var(--wf-queue); opacity: .7; }
.hv-empty { padding: 32px 16px; text-align: center; color: var(--muted-fg); display: flex; flex-direction: column; align-items: center; gap: 10px; }

/* Summary strip */
.hv-summary {
  display: flex; align-items: center; gap: 0; flex-wrap: wrap; padding: 3px 8px; border-top: 1px solid var(--border);
  color: var(--muted-fg); background: var(--muted); min-height: 24px; font-variant-numeric: tabular-nums;
}
.hv-summary > * { white-space: nowrap; padding: 0 8px; border-right: 1px solid var(--border); line-height: 16px; }
.hv-summary > *:last-child { border-right: 0; }
.hv-summary .hv-dcl-text { color: var(--mark-dcl); }
.hv-summary .hv-load-text { color: var(--mark-load); }
.hv-link {
  border: 0; background: none; padding: 0; color: var(--info); cursor: pointer; text-decoration: none; max-width: 260px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom;
}
.hv-link:hover { text-decoration: underline; }
.hv-summary .hv-link { color: inherit; text-decoration: underline dotted; }
.hv-summary .hv-link.hv-err { color: var(--err); }

/* Details */
.hv-details { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--bg); }
.hv-dhead { display: flex; align-items: center; gap: 6px; padding: 6px 8px 0; min-width: 0; }
.hv-dtitle { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hv-pill { font-size: 10.5px; font-weight: 600; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border); background: var(--muted); white-space: nowrap; }
.hv-pill.hv-err { color: var(--err); border-color: color-mix(in srgb, var(--err) 40%, var(--border)); background: color-mix(in srgb, var(--err) 10%, transparent); }
.hv-pill.hv-ok { color: var(--ok); }
.hv-tabs { display: flex; gap: 2px; padding: 6px 8px 0; border-bottom: 1px solid var(--border); overflow-x: auto; scrollbar-width: none; }
.hv-tab {
  border: 0; background: none; padding: 5px 8px 6px; color: var(--muted-fg); cursor: pointer; white-space: nowrap;
  border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.hv-tab:hover { color: var(--fg); }
.hv-tab[aria-selected="true"] { color: var(--fg); border-bottom-color: var(--info); }
.hv-tab .hv-count { opacity: .6; margin-left: 3px; }
.hv-dbody { flex: 1; min-height: 0; overflow: auto; padding: 4px 0 16px; }
.hv-section { border-bottom: 1px solid var(--border); }
.hv-section > header {
  display: flex; align-items: center; gap: 6px; padding: 6px 10px; font-weight: 600; cursor: pointer; user-select: none;
}
.hv-section > header .hv-chev { transition: transform .12s; color: var(--muted-fg); transform: rotate(90deg); }
.hv-section.hv-closed > header .hv-chev { transform: none; }
.hv-section.hv-closed > .hv-sbody { display: none; }
.hv-section > header .hv-count { color: var(--muted-fg); font-weight: 400; }
.hv-section > header .hv-spacer { flex: 1; }
.hv-section > header .hv-btn { height: 20px; padding: 0 7px; font-weight: 400; font-size: 11px; }
.hv-sbody { padding: 0 10px 8px 28px; }
.hv-kv { display: grid; grid-template-columns: minmax(110px, max-content) minmax(0, 1fr); column-gap: 14px; row-gap: 2px; }
.hv-kv > dt { color: var(--muted-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
.hv-kv > dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; user-select: text; }
.hv-kv.hv-headers > dt { font-family: var(--mono-font); font-size: 11.5px; color: var(--fg); font-weight: 500; }
.hv-kv.hv-headers > dd { font-family: var(--mono-font); font-size: 11.5px; }
.hv-maskmark { color: var(--masked); font-weight: 600; }
.hv-raw { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--mono-font); font-size: 11.5px; user-select: text; }
.hv-dnote { padding: 12px; color: var(--muted-fg); }
.hv-subbar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; flex-wrap: wrap; color: var(--muted-fg); }
.hv-subbar .hv-btn { height: 22px; }
.hv-seg { display: inline-flex; border: 1px solid var(--input); border-radius: var(--radius); overflow: hidden; }
.hv-seg button { border: 0; background: none; padding: 2px 9px; cursor: pointer; color: var(--muted-fg); }
.hv-seg button[aria-pressed="true"] { background: var(--select-strong); color: var(--fg); }
.hv-check { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }

/* Code and trees */
.hv-code { font-family: var(--mono-font); font-size: 11.5px; line-height: 17px; padding: 0 10px; user-select: text; }
.hv-chunk { content-visibility: auto; }
.hv-line { display: flex; white-space: pre; min-height: 17px; }
.hv-code.hv-wrap .hv-line { white-space: pre-wrap; overflow-wrap: anywhere; }
.hv-ln { flex: none; width: var(--gutter, 4ch); padding-right: 12px; text-align: right; color: var(--muted-fg); opacity: .7; user-select: none; }
.hv-lt { flex: 1; min-width: 0; }
.t-key { color: var(--tok-key); }
.t-string { color: var(--tok-string); }
.t-number { color: var(--tok-number); }
.t-literal { color: var(--tok-literal); }
.t-keyword { color: var(--tok-keyword); }
.t-comment { color: var(--tok-comment); font-style: italic; }
.t-tag { color: var(--tok-tag); }
.t-attr { color: var(--tok-attr); }
.t-prop { color: var(--tok-prop); }
.t-at { color: var(--tok-keyword); }
.t-punct { color: var(--muted-fg); }
.hv-tree { font-family: var(--mono-font); font-size: 11.5px; line-height: 18px; padding: 2px 10px; user-select: text; }
.hv-node { padding-left: 14px; position: relative; white-space: nowrap; }
.hv-node > .hv-toggle { position: absolute; left: 0; top: 0; width: 14px; height: 18px; border: 0; padding: 0; background: none; cursor: pointer; color: var(--muted-fg); }
.hv-node > .hv-toggle .hv-icon { width: 10px; height: 10px; margin: 4px 2px; transition: transform .1s; }
.hv-node.hv-open > .hv-toggle .hv-icon { transform: rotate(90deg); }
.hv-node .hv-k { color: var(--tok-key); }
.hv-node .hv-preview { color: var(--muted-fg); }
.hv-node .hv-v-string { color: var(--tok-string); white-space: pre-wrap; overflow-wrap: anywhere; }
.hv-node .hv-v-number { color: var(--tok-number); }
.hv-node .hv-v-literal { color: var(--tok-literal); }
.hv-leaf { white-space: normal; }
.hv-more { border: 0; background: none; padding: 0; color: var(--info); cursor: pointer; font: inherit; }
.hv-hex { font-family: var(--mono-font); font-size: 11.5px; line-height: 17px; padding: 0 10px; white-space: pre; user-select: text; }
.hv-hex .hv-off { color: var(--muted-fg); }
.hv-media { padding: 12px; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.hv-media img, .hv-media video { max-width: 100%; max-height: 420px; border-radius: 4px; }
.hv-checker {
  background-color: #fff; background-image: linear-gradient(45deg, #e6e6e6 25%, transparent 25%), linear-gradient(-45deg, #e6e6e6 25%, transparent 25%),
  linear-gradient(45deg, transparent 75%, #e6e6e6 75%), linear-gradient(-45deg, transparent 75%, #e6e6e6 75%);
  background-size: 14px 14px; background-position: 0 0, 0 7px, 7px -7px, -7px 0; padding: 8px; border: 1px solid var(--border); border-radius: 6px;
}
:root.dark .hv-checker { background-color: #1c1c1c; background-image: linear-gradient(45deg, #262626 25%, transparent 25%), linear-gradient(-45deg, #262626 25%, transparent 25%),
  linear-gradient(45deg, transparent 75%, #262626 75%), linear-gradient(-45deg, transparent 75%, #262626 75%); }

/* Tables */
.hv-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.hv-table th { text-align: left; font-weight: 500; color: var(--muted-fg); padding: 3px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.hv-table td { padding: 3px 8px; border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent); vertical-align: top; }
.hv-table td.hv-num, .hv-table th.hv-num { text-align: right; white-space: nowrap; }
.hv-table td.hv-wrapcell { overflow-wrap: anywhere; font-family: var(--mono-font); font-size: 11.5px; }
.hv-table tr.hv-clickable { cursor: pointer; }
.hv-table tr.hv-clickable:hover td { background: var(--hover); }
.hv-table tr.hv-active td { background: var(--select-strong); }

/* Timing */
.hv-timing { display: grid; grid-template-columns: minmax(150px, max-content) minmax(80px, 1fr) 72px; column-gap: 12px; row-gap: 4px; align-items: center; }
.hv-timing .hv-group { grid-column: 1 / -1; color: var(--muted-fg); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin-top: 8px; }
.hv-track { position: relative; height: 12px; }
.hv-track i { position: absolute; top: 0; height: 12px; border-radius: 2px; min-width: 1px; }
.hv-timing .hv-total { font-weight: 600; border-top: 1px solid var(--border); padding-top: 4px; }
.hv-st { margin: 8px 0 0; }
.hv-swatch { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; }

/* WebSocket */
.hv-msgs { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.hv-msg-list { flex: 1 1 55%; min-height: 80px; overflow: auto; border-bottom: 1px solid var(--border); }
.hv-msg-detail { flex: 1 1 45%; min-height: 60px; overflow: auto; }
.hv-dir-send { color: var(--ok); }
.hv-dir-receive { color: var(--info); }
.hv-msg-data { font-family: var(--mono-font); font-size: 11.5px; max-width: 0; width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Overview */
.hv-overview { padding: 10px 12px 18px; display: flex; flex-direction: column; gap: 14px; }
.hv-ov-head { display: flex; flex-direction: column; gap: 2px; }
.hv-ov-head h2 { margin: 0; font-size: 14px; }
.hv-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 8px; }
.hv-card { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: var(--card); }
.hv-card b { display: block; font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
.hv-card span { color: var(--muted-fg); font-size: 11px; }
.hv-ov h3 { margin: 0 0 6px; font-size: 12px; font-weight: 600; }
.hv-bars { display: grid; grid-template-columns: max-content 1fr max-content; gap: 3px 8px; align-items: center; }
.hv-bars .hv-fill { height: 8px; border-radius: 2px; background: color-mix(in srgb, var(--info) 55%, transparent); min-width: 2px; }
.hv-bars .hv-fill.hv-err { background: color-mix(in srgb, var(--err) 60%, transparent); }

/* Export popover */
.hv-pop {
  position: absolute; z-index: 20; top: 40px; right: 8px; width: min(620px, calc(100% - 16px)); height: min(640px, calc(100% - 56px));
  display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: 10px;
  background: var(--popover); color: var(--popover-fg); box-shadow: 0 12px 32px rgba(0, 0, 0, .25);
}
.hv-pop h3 { margin: 0; font-size: 13px; }
.hv-pop fieldset { border: 0; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
.hv-pop legend { color: var(--muted-fg); margin-bottom: 4px; padding: 0; }
.hv-pop textarea {
  flex: 1; min-height: 120px; resize: none; width: 100%; border: 1px solid var(--input); border-radius: var(--radius);
  background: var(--bg); color: var(--fg); font-family: var(--mono-font); font-size: 11px; padding: 6px 8px;
}
.hv-pop .hv-actions { display: flex; gap: 6px; justify-content: flex-end; align-items: center; }
.hv-pop .hv-note { color: var(--muted-fg); flex: 1; }
.hv-pop .hv-hint { margin: -2px 0 2px 22px; font-size: 11px; }

/* Toast and loading */
.hv-toast {
  position: absolute; left: 50%; bottom: 36px; transform: translateX(-50%) translateY(8px); opacity: 0; pointer-events: none;
  padding: 6px 12px; border-radius: 6px; background: var(--primary); color: var(--primary-fg); transition: opacity .15s, transform .15s; z-index: 30;
  max-width: calc(100% - 32px);
}
.hv-toast.hv-show { opacity: 1; transform: translateX(-50%); }
.hv-state { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 24px; text-align: center; color: var(--muted-fg); }
.hv-state h2 { margin: 0; font-size: 15px; color: var(--fg); }
.hv-state p { margin: 0; max-width: 560px; }
.hv-state .hv-mono { color: var(--fg); }
.hv-spinner { width: 22px; height: 22px; border: 2px solid var(--border); border-top-color: var(--info); border-radius: 50%; animation: hv-spin .8s linear infinite; }
@keyframes hv-spin { to { transform: rotate(360deg); } }
`

export function installStyles(): void {
  const style = document.createElement('style')
  style.textContent = css
  document.head.append(style)
}
