# Development workflow

These changes affect setup, verification and local packaging. The app uses its normal assets and saved-map profile when started with `npm start`.

## Setup and checks

Install the exact Node and Python versions in `.node-version` and `.python-version`, then run `npm run setup`. This creates `.venv`, installs the pinned geospatial dependencies and runs `npm ci`. Set `CIVITAS_PYTHON` to a Python executable path if it is not named `python3` on macOS/Linux or `python` on Windows. An existing environment with a different Python version must be recreated.

`npm run check` runs the Node tests, Python geometry tests, fixture audit and all four Electron integration checks. Individual commands are listed in `package.json`. Checks stop on failure. GitHub Actions runs the core/data checks on Linux and the actual Electron checks on macOS and Windows. The action revisions and runtime versions are pinned; dependency/runtime upgrades belong in their own reviewed change.

Electron checks use hidden windows, a temporary profile and an offline test web directory. Native alert/confirm dialogs are disabled for these isolated checks; DevTools dialog events remain available for audit scripts to capture and dismiss. Source-mode checks copy the Alpine fixture, never the working generated dataset. Packaged smoke checks use the package's actual bundled data. They leave the user's app and saved maps alone. Linux desktop checks need a display server such as Xvfb; the default CI desktop matrix covers the supported macOS and Windows targets.

The fixture has both parent geographies, original block counts and two presidential contests. It verifies clicks, splits, totals, history, persistence and deep zoom. It does not substitute for statewide, dense-county or cross-county testing. Cross-county city behavior is covered by the controller unit fixture. To deliberately refresh Alpine after a data-method change, run `npm run test:fixture:refresh`, review its diff and run the audit and desktop checks again.

## Branches and parallel work

Use a branch per task. Keep each parallel agent or tool in its own worktree with a distinct branch; `.worktrees/` is ignored. For example:

```sh
git switch -c fix/example
git worktree add .worktrees/audit -b perf-audit
```

Agree on file ownership before parallel edits. Avoid two builders writing the same output directory. Shared `node_modules` symlinks are convenient locally but couple dependency changes; use separate installs when tasks change dependencies. Do not commit downloaded inputs, local profiles, benchmark screenshots or release binaries.

To incorporate the original repository's updates into the fork, fetch `upstream`, merge `upstream/main` into the fork's `main`, run checks, then push `origin main`. Merge the updated `main` into an existing feature branch. Preserve published history. Open PRs against the fork for local review; merging into the original repository and enabling its required checks remain the owner's decisions.

## Data and packaging

`npm run data:fetch` verifies every cached or newly downloaded public input against `scripts/geodata-sources.json`. A changed upstream file fails rather than silently altering a build. Update the lock only after reviewing the source change. `npm run data:build` resumes the existing county builder. New JSON and gzip files are replaced atomically; completion reports and the dataset manifest are written after their data.

`npm run data:validate:completed` audits finished counties during a build. It issues no release certificate. Stop the builder before `npm run data:validate`: the full audit requires all 58 counties, 519,723 original blocks and 39,538,223 Census residents. It checks each parent and race against atom sums, race source audits, every original block's three official counts, legacy IDs and source provenance. It then records SHA-256 hashes of the dataset and audit/build code in `validation.json`.

`npm run data:check` verifies that certificate. The same check runs through electron-builder's `beforePack` hook, including direct builder invocations. Missing, partial, changed or unaudited data stops packaging. A data, provenance or audit-code change requires another full audit. The certificate is an accidental-change guard, not a signed security attestation. The fixture cannot receive a release certificate.

Use `npm run dist:mac` or `npm run dist:win` after validation. Run `npm run release:checksums` after packaging to write `dist/SHA256SUMS.txt`. Verify a local package with `npm run test:smoke -- /path/to/executable`. Builds remain local and ad-hoc signed/unsigned; publishing and release signing are separate owner-controlled steps.

Existing revision-3 county data can receive matching shared edges with `npm run data:repair:geometry`. This changes geometry and parent outlines while preserving atom IDs, parent/city memberships and every numeric value. It keeps the original county files in `.cache/geometry-before-repair/` and marks a county complete only after its writes finish. The full audit requires geometry revision 2, valid serialized polygons, matching edges, agreement with the Census source footprint and no nonzero statistics on empty fragments. A previous release certificate is invalid after this change; rerun `npm run data:validate`.

Noding retries use progressively finer tolerances without relaxing those guards. When GEOS flags a valid point where a hole touches its shell, an independent check verifies disjoint interiors, identical shared segments and matching vertices against every intersecting neighbor. Overlaps and partially noded edges still fail validation.

Final noding may leave microscopic enclosed voids. Only voids wholly covered by the source and below the roundoff area limit are assigned to an adjacent atom; real source holes remain protected. For a diagnosed county, `--snapping-distance 1e-10` (or a finer supported tolerance) skips known unsuccessful coarser attempts. The actual accepted tolerance is recorded in the county report, and all validation checks still run.

## Performance work

`npm run benchmark:render -- . label` records the existing dense Los Angeles canvas benchmark with runtime, hardware, dataset hashes, raw samples and process-memory observations in `dist/benchmarks/`. Compare runs on the same machine, viewport and dataset with other heavy jobs stopped. It measures synchronous canvas rendering after initialization with synthetic election colors; it does not measure startup, block decoding, city edits or end-to-end input latency.

`npm run benchmark:city -- current` paints Lancaster and Palmdale in both parent geographies using the generated Los Angeles data. It measures block loading, assignment, parent outline merges and final district outlines, then verifies repaint, undo and redo. Hidden temporary instances keep the user's profile untouched. Source and data hashes describe the copies actually tested; results are saved in `dist/benchmarks/`. The current implementation exits with failure for timeouts, merge errors or a history mismatch.

Use `npm run benchmark:city -- both <baseline-commit>` for comparison on the same data. A stalled baseline is recorded after the idle timeout instead of continuing to repaint; `CITY_BENCHMARK_TIMEOUT_MS` changes the default two-minute timeout. Stop other heavy jobs before comparing timings. These runs complement the fixture checks and require the generated county files.

Renderer module extraction, chunk-format changes, cache budgets and language changes should follow independent profiling and preserve visible behavior. This workflow change does not introduce them.
