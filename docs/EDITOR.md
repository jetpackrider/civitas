# Block and city editing

Choose **Block**, then click a precinct or block group to open its census blocks. Opening is a view change. Paint or erase individual blocks; totals update during the stroke. **Done**, Escape or changing tools closes detail. Pieces with the same district assignment become one paintable virtual piece; assigning the remaining pieces together restores the parent.

**City** uses incorporated municipalities from Census TIGER/Line 2025, excluding CDPs. The map cuts blocks wherever precinct, block-group or city boundaries cross them. City paint and erase cover all matching pieces, including across parent boundaries. Pieces assigned to locked districts are skipped with a notice. Cyan outlines can be shown independently.

District balancing defaults to original **2020 Census** population; California adjusted population is a per-map option. ACS demographic views and historical population fields remain analysis estimates. Block fragments use equal-area allocation and deterministic integer remainders. Published block election allocations are used for 2016–2020; registration crosswalks link 2022/2024 results to blocks. Incomplete crosswalks or unmatched contests use the existing precinct results with VAP weights. Unlocated source-block placeholders are distributed within their county. Madera 2024 retains the corrected existing source. County reports identify fallback methods and source totals.

Geometry overlays use a 1 mm California Albers grid. After conversion to longitude/latitude, the builder reconstructs matching shared edges and repairs narrow overlay/rounding cracks inside the Census source footprint. The source's exterior and holes are protected. Newly shared vertices retain identical double coordinates; independent rounding cannot reopen their edges. Atom IDs, assignments, statistics and votes survive the repair. Source outlines are geographic representations, not surveys. Display simplification and subpixel filtering do not change counts, exact picking or exports.

Wheel zoom reaches 100,000× for close inspection. Tiny rings become visible as they grow beyond a fraction of a pixel; district geometry and block counts remain unchanged by zooming.

## History and files

Undo/Redo covers paint, erase, splits/remerges, population basis, district counts, names, locks and display mode. Viewing layers, zooming and opening block detail are outside history. Session history has no artificial limit. Saving retains up to 15 undo and 15 redo commands around the current position. A new edit clears the redo branch. Native text-field undo remains separate.

IndexedDB `civitas-editor` is authoritative. Saves commit the catalogue entry and its draft/history together. Existing `civitas-*` localStorage values are retained as recovery backups during migration. Legacy map IDs and parent IDs remain available; empty/shadowed parent geometries have zero totals. Legacy maps inherit assignments and recalculate totals, with a one-time upgrade notice and recovery copy.

`.civitasmap` exports use format version 2 and carry dataset ID, parent defaults and block overrides, population basis, district metadata and names. Version 1 imports remain readable; future versions or unknown datasets are rejected. Exports exclude local history. GeoJSON contains district geometry and numeric election/demographic statistics, identifies the population basis and marks analysis estimates.

## Developer checks

- `npm test`: reversible state, branching, history limits, allocation, grouping, city locks and display filtering.
- `npm run test:smoke`: isolated Electron profile; menus, both map types, save/reopen and Mac lifecycle.
- `npm run test:editor`: actual worker, Canvas and IndexedDB; offline editing, splits, native history, deletion, storage failure and restore.
- `npm run test:pointer`: actual canvas clicks to paint a parent, open blocks without a district selection, paint a block into another district and undo; deep zoom preserves its cursor anchor and aspect ratio, in both map types.
- `npm run test:sidebar`: actual sidebar layout remains stable across repeated refreshes, expands for long names and respects collapsed state.
- `.venv/bin/python -m unittest discover -s tests -p 'test_*.py'`: geometric enclaves, crossing boundaries and conservation.
- `npm run data:validate`: every county, both geographies, all audited races, block counts and legacy IDs; parent outlines must match the union of their serialized atoms, including holes and winding.
- `npm run data:repair:geometry`: upgrade existing generated geometry without reallocating counts; resumes completed counties and keeps originals in `.cache/geometry-before-repair/`. Run the full data audit again before packaging.
- `node scripts/render-benchmark.cjs`: dense-county Canvas redraw timings and a screenshot under `dist/`.

The map data works offline. The optional OpenFreeMap background uses the network; map editing and exports do not depend on it.
