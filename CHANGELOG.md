# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/). `scripts/release-plugin.sh` in the hub turns
`[Unreleased]` into the released version.

## [Unreleased]

### Added

- **HAR Viewer** custom editor, the default view for `.har` and `.har.zip` (Archive Viewer, when
  installed, keeps `.har.zip` and offers HAR Viewer in the view switcher): read-only and
  offline. Reads HAR 1.2 from Chrome, Edge, Firefox, Safari, Playwright and agent tools with
  their extra fields, base64 bodies, missing or `-1` timings and requests without pages.
- `.har.zip` from Playwright with bodies in separate files, unpacked in the tab (vendored
  fflate 0.8.3).
- A virtualized request list with sortable columns (status, method, domain, path, type,
  initiator, transferred, size, time) and a waterfall with a time scale and each page's
  DOMContentLoaded and load lines; a resizable split; keyboard navigation.
- Filters: text over the URL, headers or everything including bodies, with negation, phrases,
  regular expressions and properties such as `status:5xx` or `larger-than:100k`; type chips;
  errors only; page and domain.
- Details tabs: Headers with raw views, Payload, Response (JSON tree, highlighted source,
  image, font, muted audio and video previews, hex), Cookies, Timing with `Server-Timing`,
  WebSocket messages and Initiator with the call stack and related requests.
- An overview with totals, requests by type and status, a per-domain table that filters the
  list, and the slowest, largest and failed requests; a summary strip under the list.
- Copy as cURL and as fetch; "Export for agent", a Markdown digest of selected, failed or
  listed requests with bodies cut and secrets masked, to copy or save.
- "Mask secrets" with a banner counting what was masked, and "Save sanitized…" for a masked
  `.har` or `.har.zip`.
- Messages for empty, non-JSON and non-HAR files; cut-off and damaged files open with what
  could be read and say where they break.
- English and Russian, following Orca's language; light and dark themes; the tab icon.
