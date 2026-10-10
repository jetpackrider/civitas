# Security audit: saved-map imports and the Electron file protocol

**Date:** 2026-10-10 · **Branch:** `chore/development-workflow` · **Original result: 237/237 checks passed; 2 low-severity findings**

The findings below describe the original code. Both have since been hardened; see the remediation section. Passing audit checks included observations of known weaknesses, so the original total was not a finding-free security assessment.

Scope: the desktop app's "Open map file…" import path (`importMapFile` / `applySavedPayload`), the `civitas://` protocol handler in `main.js`, and navigation/window-open handling. Everything was tested against the real Electron app running on disposable profiles; no user data was touched.

## How to reproduce

The updated audit harness is `scripts/security-audit.cjs`. Run from the repo root:

```sh
npm run test:security
```

It launches the packaged-from-source app via Playwright using `scripts/test-environment.cjs` (`prepare()` makes a temp web root + `--user-data-dir` profile), patches `shell.openExternal` in the main process to record calls instead of opening a browser, creates and saves a base map, then drives the real file-import input with crafted `.civitasmap` files. After every rejected import it asserts: catalogue deep-equal, storage key set unchanged, base-map entry byte-identical, home list intact, `Object.prototype` clean. Exit code 0 = all checks passed. Temp profiles are removed on exit.

## What was covered and the outcome

| Area | Cases | Outcome |
| --- | --- | --- |
| Malformed JSON | garbage, empty file, BOM+garbage, wrong `format`, null/string/array payload, version `3`/`"2"`/missing, 150k-deep nesting | All rejected with the correct alert/notice; base map intact |
| Invalid IDs/counts | unknown state, dataset mismatch, counts −1/1001/2.5/`"4"`/`null`/`1e400`, unknown unit ids, district ids 0/−5/999/1.5/`"2"`, unknown block overrides, out-of-range override values | All rejected before any write; 200k-key junk-assignment file rejects in ~200 ms |
| Rejected-import atomicity | every rejection case + the rollback path (different-state payload that fails *after* the app switched geography, while a map is open) | Name, hash and view restored (`web/index.html:4962-4967`); no draft/backup/catalogue leftovers |
| Prototype keys | `__proto__` in doc root, payload, assignments, names, locked; `constructor.prototype` in names; `__proto__` as override key; crafted `history` in an accepted import + undo | No pollution on any path; crafted history dropped (`web/index.html:5650`); override key rejected as `Unknown block assignment` |
| Encoded path traversal | canary file placed **outside** the web root; probes: `../`, `%2e%2e`, `..%2f`, `.%2e`, `%2E%2E`, nested `%2e%2e/%2e%2e`, double-encoded `%252e`, `..%5c`, `%00`, `//`, `civitas://otherhost/…`, direct `file://` fetch from the renderer | Canary never served. `..%2f` hits the containment check (403); the rest are neutralized by URL normalization or 404 |
| Navigation | `file://` navigation and iframes, `window.open` (https and file), http(s) navigation, `civitas://` self-navigation | `file://` blocked everywhere; popups always denied; http(s) handed to `shell.openExternal` only; self-navigation allowed |
| Electron hardening | `webPreferences` | `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, single-instance lock — no issues |

The 150k-deep nesting case parses without a stack overflow and rejects via state validation.

## Findings

### F1 (low, robustness): unbounded import metadata persisted

`payloadState` (`web/lib/editor-controller.js:208-214`) validates `count` and assignment ids but imposes no size or key-count bound on `names`, `locked` or `history`. `importMapFile` (`web/index.html:5639-5667`) uses `FileReader.readAsText` with no file-size cap and passes the parsed payload through.

**Observed:** a 10.5 MB `.civitasmap` (300k `names` keys) was accepted in 1.3 s, and a 60 MB file in 5.2 s — no crash or hang — with the full payload persisted to IndexedDB under `civitas-districts-v2`, then duplicated into the `map-v1-<id>` backup (`web/index.html:4952`) and the `civitas-draft-<id>` draft, i.e. ~3× amplification per import. A large shared file can exhaust storage or renderer memory.

**Repro:** see the `oversize` rows in the audit output; the harness writes the files into its temp dir and restores the catalogue afterwards.

**Suggested fix:** reject files over a sane cap (e.g. 5–10 MB) before `readAsText`, and in `payloadState` bound `names`/`locked` to `count`-many integer keys with primitive values.

### F2 (low, defense-in-depth): prototype-pollution sink in `History.apply`

`web/lib/editor-core.js:51-58` applies persisted history commands by assigning `result[c.section][c.key] = …`. If a command's `section` is `__proto__`, `result['__proto__']` resolves to `Object.prototype`, so redo writes through to it (and undo deletes from it). Verified in isolation:

```js
const {History} = require('./web/lib/editor-core.js');
const h = new History({commands:[{label:'x',changes:[{section:'__proto__',key:'pwned',before:null,after:{evil:1}}]}],cursor:0});
h.redo({assignments:{}});
Object.prototype.pwned;            // => { evil: 1 }
({}).pwned;                        // => { evil: 1 }
```

**Not reachable via file import today:** `importMapFile` does `delete p.history` (`web/index.html:5650`), and the audit confirmed an accepted import carrying a crafted history drops it and undo stays clean. However, `editor.restore` (`web/lib/editor-controller.js:215-221`) also builds a `History` from `payload.history` on two paths that do **not** pass through `importMapFile`:

- draft restore — `web/index.html:5188` (`restoreFromHash` → `applySavedPayload`)
- cloud-shared maps — `web/index.html:4977` (`loadSharedMap` → `applySavedPayload`)

Desktop builds have no cloud API and drafts are self-written, so there is no reachable path in this app; the website build or future cloud features would expose it.

**Suggested fix:** in `History.apply`, skip sections that are not own properties of the snapshot (or explicitly reject `__proto__`/`constructor.prototype`), so a persisted command can never escape the state object.

## Minor observations (no action required)

- The original known-unit check `if(!index[id])` used truthiness on a plain object, so `__proto__`/`constructor` keys passed via the prototype chain. Both unit-validation paths now use `Object.hasOwn(index, id)`.
- Path containment in the protocol handler (`main.js:54-57`) is lexical: a symlink inside the web root is followed. The web root is app-owned/read-only, so this is not attacker-reachable.
- The handler serves any `civitas://<host>/` (host is ignored). Inert, since only the app can use the registered scheme.
- The original `names`/`locked` values were not shape-validated. Both are now validated as described below.

## Remediation and verification

Post-remediation verification on macOS: **253/253 updated audit checks**, **17/17 Node tests**, and the Electron smoke and editor integration suites passed. The disposable audit profile was confirmed removed after completion.

- Files larger than 128 MiB are rejected before `FileReader.readAsText`. This deliberately leaves room for statewide maps with over a million block-piece overrides; 5–10 MB could reject legitimate exports. The cap bounds input size rather than guaranteeing a memory budget.
- Every restored snapshot, including drafts and shared maps, validates district metadata before changing assignments. Names and locks have at most `count` entries with canonical integer keys from 1 through `count`. Names are strings no longer than the existing 40-character UI limit; locks are booleans. Excessive metadata rejects without persistence.
- History applies changes only to the snapshot's own object sections. Values are written with `Object.defineProperty` so even an own `__proto__` key cannot invoke an inherited setter. Undo/redo remains compatible with normal split assignments and metadata.
- The harness now checks prototype pollution in the renderer, explicitly verifies imported history is dropped, expects excessive metadata to reject, and allows its `finally` block to close the disposable app and remove its profile. The original use of `process.exit()` bypassed that cleanup.
- Focused Node regressions cover malicious persisted redo/undo, section prototypes, inherited unit IDs, invalid metadata and atomic rejection. The Electron smoke test verifies the file-size guard performs zero reads and leaves storage unchanged; the editor integration suite covers ordinary saved-map restore and history for both geographies.

The original source line numbers above refer to the audited version and may shift after remediation. This is a targeted audit of the listed surfaces, not a claim that the whole application is vulnerability-free.
