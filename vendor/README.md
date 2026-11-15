# Vendored libraries

Plugin frames load no npm packages and have no network, so the one library HAR Viewer uses is
copied here as a readable, unminified ES module. It is not patched.

| File                | Library                                            | Version | Licence |
| ------------------- | -------------------------------------------------- | ------- | ------- |
| `fflate/fflate.mjs` | [fflate](https://github.com/101arrowz/fflate)      | 0.8.3   | MIT     |

## fflate

- **Why:** reading Playwright's `.har.zip` (the HAR and its body files are DEFLATE-compressed ZIP
  entries; `src/har/zip.ts` reads the ZIP directory itself and uses fflate's streaming `Inflate`)
  and writing the masked `.har.zip` copy (`zipSync`).
- **Source:** the npm package `fflate@0.8.3`, file `esm/browser.js`, copied unchanged.
- **SHA-256 of `fflate.mjs`:** `b7ca4450b19559a1d50eb381adcee94b82449674be4cd17789d9beba7e6122a1`
- **Licence:** `fflate/LICENSE` (MIT), from the same package.
- **Types:** `fflate/fflate.d.mts` declares only what HAR Viewer imports.
- The file also holds fflate's asynchronous API, which runs in workers; HAR Viewer does not call it.

Rebuild (and check the hash):

```sh
npm pack fflate@0.8.3
tar xzf fflate-0.8.3.tgz
cp package/esm/browser.js vendor/fflate/fflate.mjs
cp package/LICENSE vendor/fflate/LICENSE
shasum -a 256 vendor/fflate/fflate.mjs
```
