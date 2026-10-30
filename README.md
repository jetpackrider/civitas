# Civitas

ElectionCord Civitas desktop source, California data and local release artifacts.

## Develop and verify

Use the Node/Python versions in `.node-version` and `.python-version`, run `npm run setup`, then `npm start`. `npm run check` runs the complete local check suite. Run `npm test`, `npm run test:smoke`, `npm run test:editor` and `npm run test:pointer`. Electron checks use hidden windows, temporary profiles and a committed offline Alpine fixture; they do not touch saved user maps. CI runs core/data checks on Linux and desktop checks on macOS/Windows. See [the workflow guide](docs/WORKFLOW.md) for branches, parallel work and release gates. See [the editor guide](docs/EDITOR.md) for tools, history, migration and data methods.

Rebuild the geodata after setup:

```sh
npm run data:fetch
npm run data:build
npm run data:validate
```

Downloaded inputs and intermediate tables live in `.cache/geodata/`. Bundled output lives in `web/data/block-v1/`, including source URLs/checksums and county allocation audits. Public inputs are checked against `scripts/geodata-sources.json`. The builder resumes counties matching its build revision. Keep an incomplete dataset out of release packages; the final manifest must contain all 58 counties and 39,538,223 original Census residents.

## Package

Packaging requires the full dataset and a matching validation certificate from `npm run data:validate`. `npm run data:check` verifies it. `npm run dist:mac` builds Apple Silicon and Intel DMG/ZIP files. `npm run dist:win` builds a Windows x64 ZIP. Artifacts are local and unsigned/ad-hoc signed; these commands do not publish. Run `npm run release:checksums` to record artifact hashes.

Packaged builds keep the app and immutable map data in one `app.asar` archive, so Windows ZIP extraction does not create tens of thousands of individual map files. Extract the entire Windows ZIP before running `ElectionCord Civitas.exe`; keep the extracted runtime files together. `npm run test:archive` checks offline loading and saved-map reopen from that archive layout using the small fixture and an isolated profile.

## Folder layout

- `main.js`, `web/`: runnable Electron app and bundled data.
- `scripts/`, `tests/`, `docs/`: build pipeline, checks and editor documentation.
- `dist/`: new build artifacts and verification screenshots.
- `releases/<platform>/<version>/`: preserved release downloads.
- `builds/windows/win-unpacked/`: original complete extracted Windows app.
- `archives/source/0.0.1/`: original source downloads, which contained only README files.
- `archives/legacy-project/`: preserved sibling-project source and Git history, unique build artifacts and checksum inventory.

The recovered runnable source has been consolidated here. Release binaries, archived downloads, build artifacts, dependencies and caches are ignored by Git. Original downloads and unique artifacts have been preserved.
