/* Robust display-outline unions. Usable in the block worker and in Node tests.
   Projected block edges that should coincide differ by floating-point noise, which makes
   polygon-clipping's sweep line fail ("Unable to complete output ring", "Infinite loop").
   Coordinates are snapped to the 1e-7 world-unit precision already used by serialized world
   paths, so shared vertices become identical; a 1e-6 grid is tried only if that fails. At the
   100,000x maximum zoom one CSS pixel is about 1e-5 world units, so the largest vertex move
   (grid*sqrt(2)/2) is about 0.007 px, or 0.07 px on the fallback grid.
   Inputs are never modified. Snapping can only remove a ring by collapsing it; a collapsed
   ring narrower than the 1e-7 world precision (a zero-width artifact) is counted and reported,
   and any wider collapse rejects the grid. Every source piece must also be covered by the result. */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../vendor/polygon-clipping.umd.js'));
  else root.CivitasUnion = factory(root.polygonClipping);
})(typeof globalThis === 'object' ? globalThis : this, function(polygonClipping) {
  'use strict';
  // QUANTUM is the world-path precision. A ring whose mean width (2*area/perimeter) is below it
  // has no representable interior, so snapping may collapse it; any wider collapse is an error.
  const GRIDS = [1e-7, 1e-6], QUANTUM = 1e-7, FAN_IN = 8;
  // Shoelace relative to the first vertex: coordinates near 1000 would otherwise cancel.
  function ringArea(ring) {
    if (ring.length < 3) return 0;
    const x0 = ring[0][0], y0 = ring[0][1];
    let a = 0;
    for (let i = 1; i + 1 < ring.length; i++) a += (ring[i][0] - x0) * (ring[i + 1][1] - y0) - (ring[i + 1][0] - x0) * (ring[i][1] - y0);
    return a / 2;
  }
  function ringLength(ring) {
    let n = 0;
    for (let i = 1; i < ring.length; i++) n += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
    return n;
  }
  const polygonsOf = geom => typeof geom[0]?.[0]?.[0] === 'number' ? [geom] : geom;
  // Area of a polygon or multipolygon, holes subtracted.
  function geomArea(geom) {
    let total = 0;
    for (const poly of polygonsOf(geom)) poly.forEach((ring, i) => { const a = Math.abs(ringArea(ring)); total += i ? -a : a; });
    return total;
  }
  function geomPerimeter(geom) {
    let total = 0;
    for (const poly of polygonsOf(geom)) for (const ring of poly) total += ringLength(ring);
    return total;
  }
  // Round to the grid and drop repeated vertices. Rings that become degenerate are omitted
  // and every omitted ring with nonzero source area is recorded in `collapsed`.
  function snapPolygons(geoms, grid, collapsed = []) {
    const scale = Math.round(1 / grid), out = [];
    geoms.forEach((geom, g) => {
      const snapped = [];
      polygonsOf(geom).forEach((poly, p) => {
        const rings = [];
        for (let r = 0; r < poly.length; r++) {
          const ring = [];
          for (const point of poly[r]) {
            const x = Math.round(point[0] * scale) / scale, y = Math.round(point[1] * scale) / scale, last = ring[ring.length - 1];
            if (!last || last[0] !== x || last[1] !== y) ring.push([x, y]);
          }
          if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) ring.push(ring[0].slice());
          if (ring.length >= 4 && ringArea(ring) !== 0) { rings.push(ring); continue; }
          const area = Math.abs(ringArea(poly[r]));
          if (area > 0) collapsed.push({geom: g, polygon: p, ring: r, area, width: 2 * area / ringLength(poly[r])});
          if (r === 0) break; // holes of a collapsed outer ring have nothing to cut
        }
        if (rings.length) snapped.push(rings);
      });
      if (snapped.length) out.push(snapped);
    });
    return out;
  }
  // Tree reduction: every step unions at most fanIn pieces of similar size, instead of
  // repeatedly re-sweeping an ever-growing accumulated result. Intersection points created by
  // earlier steps are off the grid; when a step fails, its inputs are re-snapped and it is
  // retried once. Rings collapsed by that re-snap are recorded like source collapses.
  function balancedUnion(geoms, fanIn = FAN_IN, grid = 0, collapsed = []) {
    if (geoms.length < 2) return geoms.length ? polygonClipping.union(geoms[0]) : [];
    const step = group => {
      try { return polygonClipping.union(...group); } catch (error) {
        if (!grid) throw error;
        const snapped = snapPolygons(group, grid, collapsed);
        return snapped.length ? polygonClipping.union(...snapped) : [];
      }
    };
    let level = geoms;
    while (level.length > 1) {
      const next = [];
      for (let i = 0; i < level.length; i += fanIn) {
        const group = level.slice(i, i + fanIn);
        next.push(group.length === 1 ? group[0] : step(group));
      }
      level = next;
    }
    return level[0];
  }
  // A point strictly inside a polygon: the middle of the widest span cut by a horizontal line
  // through the largest vertical gap between vertices, with its distance to the nearest edge.
  function interiorPoint(poly) {
    const ys = [...new Set(poly.flatMap(ring => ring.map(p => p[1])))].sort((a, b) => a - b);
    let y = null, gap = -1;
    for (let i = 1; i < ys.length; i++) if (ys[i] - ys[i - 1] > gap) { gap = ys[i] - ys[i - 1]; y = (ys[i] + ys[i - 1]) / 2; }
    if (y === null) return null;
    const xs = [];
    for (const ring of poly) for (let i = 1; i < ring.length; i++) {
      const [x1, y1] = ring[i - 1], [x2, y2] = ring[i];
      if ((y1 > y) !== (y2 > y)) xs.push(x1 + (y - y1) * (x2 - x1) / (y2 - y1));
    }
    xs.sort((a, b) => a - b);
    let best = null;
    for (let i = 0; i + 1 < xs.length; i += 2) if (!best || xs[i + 1] - xs[i] > best.width) best = {point: [(xs[i] + xs[i + 1]) / 2, y], width: xs[i + 1] - xs[i]};
    if (!best) return null;
    let clearance = Infinity;
    const [px, py] = best.point;
    for (const ring of poly) for (let i = 1; i < ring.length; i++) {
      const [ax, ay] = ring[i - 1], dx = ring[i][0] - ax, dy = ring[i][1] - ay, length = dx * dx + dy * dy;
      const t = length ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
      clearance = Math.min(clearance, Math.hypot(px - ax - t * dx, py - ay - t * dy));
    }
    return {point: best.point, clearance};
  }
  // Even-odd containment against every ring of a union result, using horizontal bands.
  function containment(polygons) {
    const edges = [];
    for (const poly of polygons) for (const ring of poly) for (let i = 1; i < ring.length; i++) edges.push([ring[i - 1], ring[i]]);
    let y0 = Infinity, y1 = -Infinity;
    for (const [a, b] of edges) { y0 = Math.min(y0, a[1], b[1]); y1 = Math.max(y1, a[1], b[1]); }
    const count = Math.max(1, Math.ceil(Math.sqrt(edges.length))), size = (y1 - y0) / count || 1, bands = Array.from({length: count}, () => []);
    for (const edge of edges) {
      const lo = Math.min(edge[0][1], edge[1][1]), hi = Math.max(edge[0][1], edge[1][1]);
      for (let b = Math.max(0, Math.floor((lo - y0) / size)); b <= Math.min(count - 1, Math.floor((hi - y0) / size)); b++) bands[b].push(edge);
    }
    return ([x, y]) => {
      if (y < y0 || y > y1) return false;
      let inside = false;
      for (const [[ax, ay], [bx, by]] of bands[Math.min(count - 1, Math.floor((y - y0) / size))])
        if ((ay > y) !== (by > y) && x < ax + (y - ay) * (bx - ax) / (by - ay)) inside = !inside;
      return inside;
    };
  }
  // Nest flat rings (for example the subpaths of a serialized geometry record) into
  // [outer, holes...] polygons by containment, largest first. Bounding boxes reject most
  // candidates, so a multipolygon of thousands of disjoint fragments stays linear in practice.
  function nestRings(rings) {
    const polys = [];
    const prepared = rings.map(ring => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of ring) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
      return {ring, area: Math.abs(ringArea(ring)), box: [x0, y0, x1, y1]};
    }).sort((a, b) => b.area - a.area);
    for (const {ring, box} of prepared) {
      const [x0, y0, x1, y1] = box, pt = ring[0];
      let placed = false;
      for (const poly of polys) {
        const outer = poly.box;
        if (pt[0] < outer[0] || pt[0] > outer[2] || pt[1] < outer[1] || pt[1] > outer[3]) continue;
        if (!pipRing(poly[0], pt)) continue;
        poly.push(ring); placed = true; break;
      }
      if (!placed) polys.push(Object.assign([ring], {box}));
    }
    return polys;
  }
  function pipRing(ring, [x, y]) {
    let inside = false;
    for (let i = 1; i < ring.length; i++) {
      const [x1, y1] = ring[i - 1], [x2, y2] = ring[i];
      if ((y1 > y) !== (y2 > y) && x < x1 + (y - y1) * (x2 - x1) / (y2 - y1)) inside = !inside;
    }
    return inside;
  }
  // Check coverage of the whole polygon, including cuts beyond its interior probe and
  // enclosed result holes. The spatial cells conservatively index every result edge's box.
  // An edge entering the source interior beyond the snap displacement requires repair;
  // if no edge does so, one interior point establishes which side contains the source.
  function needsCoverageRepair(polygons, margin = 0) {
    if (!polygons.length) return () => true;
    const edges = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const poly of polygons) for (const ring of poly) for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1], b = ring[i]; edges.push([a, b]);
      x0 = Math.min(x0, a[0], b[0]); y0 = Math.min(y0, a[1], b[1]);
      x1 = Math.max(x1, a[0], b[0]); y1 = Math.max(y1, a[1], b[1]);
    }
    const count = 2 ** Math.min(7, Math.ceil(Math.log2(Math.max(1, Math.sqrt(edges.length)))));
    const dx = (x1 - x0) / count, dy = (y1 - y0) / count;
    const col = x => Math.max(0, Math.min(count - 1, Math.floor((x - x0) / dx)));
    const row = y => Math.max(0, Math.min(count - 1, Math.floor((y - y0) / dy)));
    const boundary = new Map(), inside = containment(polygons);
    for (const [index, [a, b]] of edges.entries()) {
      const left = col(Math.min(a[0], b[0])), right = col(Math.max(a[0], b[0]));
      const top = row(Math.min(a[1], b[1])), bottom = row(Math.max(a[1], b[1]));
      for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
        const key = y * count + x;
        if (!boundary.has(key)) boundary.set(key, []);
        boundary.get(key).push(index);
      }
    }
    return poly => {
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
      for (const ring of poly) for (const [x, y] of ring) {
        a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y);
      }
      if (c < x0 || a > x1 || d < y0 || b > y1) return true;
      const left = col(a), right = col(c), top = row(b), bottom = row(d);
      let touches = false;
      for (let y = top; y <= bottom && !touches; y++) for (let x = left; x <= right; x++)
        if (boundary.has(y * count + x)) { touches = true; break; }
      if (!touches) return !inside(poly[0][0]);
      // Shared source/result edges do not cut the source interior. Split each nearby result
      // edge at every source-boundary intersection; if none of the intervening spans is
      // inside the source, coverage is constant throughout it. This avoids clipping every
      // boundary block while still detecting cuts and holes that an interior probe misses.
      const sourceEdges = poly.flatMap(ring => ring.slice(1).map((p, i) => [ring[i], p]));
      const epsilon = 64 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
      const nearby = new Set();
      for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++)
        for (const index of boundary.get(y * count + x) || []) nearby.add(index);
      const cuts = [...nearby].some(index => {
        const [p, q] = edges[index], vx = q[0] - p[0], vy = q[1] - p[1], length = vx * vx + vy * vy;
        if (!length || Math.max(p[0], q[0]) < a || Math.min(p[0], q[0]) > c ||
            Math.max(p[1], q[1]) < b || Math.min(p[1], q[1]) > d) return false;
        const ts = [0, 1];
        const band = Math.max(margin, epsilon) * Math.sqrt(length);
        for (const [s, e] of sourceEdges) {
          const wx = e[0] - s[0], wy = e[1] - s[1], sx = s[0] - p[0], sy = s[1] - p[1];
          const denominator = vx * wy - vy * wx;
          if (denominator) {
            const t = (sx * wy - sy * wx) / denominator, u = (sx * vy - sy * vx) / denominator;
            if (t >= 0 && t <= 1 && u >= 0 && u <= 1) ts.push(t);
          }
          // Refine parallel displacement bands at source vertices too. A simplified result
          // edge can follow several collinear source edges without crossing any of them.
          for (const v of [s, e]) {
            if (Math.abs((v[0] - p[0]) * vy - (v[1] - p[1]) * vx) <= band) {
              const t = ((v[0] - p[0]) * vx + (v[1] - p[1]) * vy) / length;
              if (t > 0 && t < 1) ts.push(t);
            }
          }
        }
        ts.sort((a, b) => a - b);
        for (let i = 1; i < ts.length; i++) {
          if (ts[i] === ts[i - 1]) continue;
          const t = (ts[i - 1] + ts[i]) / 2, point = [p[0] + t * vx, p[1] + t * vy];
          if (point[0] < a || point[0] > c || point[1] < b || point[1] > d) continue;
          const ends = [ts[i - 1], ts[i]].map(t => [p[0] + t * vx, p[1] + t * vy]);
          const onBoundary = sourceEdges.some(([s, e]) => {
            const dx = e[0] - s[0], dy = e[1] - s[1], len = dx * dx + dy * dy;
            // Both endpoints must lie in the same edge's displacement band. Distance to a
            // line segment is convex, so the entire span stays in that band; a midpoint
            // alone could overlook a cut beside a concave corner.
            return ends.every(([x, y]) => {
              const t = len ? Math.max(0, Math.min(1, ((x - s[0]) * dx + (y - s[1]) * dy) / len)) : 0;
              return Math.hypot(x - s[0] - t * dx, y - s[1] - t * dy) <= Math.max(margin, epsilon);
            });
          });
          if (!onBoundary && poly.reduce((hit, ring) => pipRing(ring, point) ? !hit : hit, false)) return true;
        }
        return false;
      });
      if (cuts) return true;
      const probe = interiorPoint(poly);
      if (!probe) throw new Error('could not establish remainder coverage');
      return !inside(probe.point);
    };
  }
  // A display remainder as (parent outline) minus (merged assigned pieces) instead of a full
  // union of every remainder atom, which is what makes large remainders slow. The parent
  // record is only trusted when it verifies: missing area in each remainder piece and extra
  // total area must stay within one snap displacement per source edge. A record that misses
  // mesh pieces — unmapped-block
  // debris outside the record outline, block-group outlines drifting from their blocks — has
  // those pieces added back (pieces clearing the result append; the rest merge in one sweep;
  // coverage only grows, so only the repaired pieces re-verify). A record that still
  // disagrees fails a guard, and the function falls back to the exact full union rather than
  // returning a wrong outline. If that union also fails, the error propagates.
  function robustDifference(subject, clips, remainder, options = {}) {
    const timing = options.timing || null;
    if (timing) { timing.clipMs = 0; timing.diffMs = 0; timing.guardMs = 0; }
    const errors = [];
    if (!Array.isArray(subject) || !subject.length || !Array.isArray(clips) || !clips.length)
      errors.push('difference needs a subject and at least one clip');
    else for (const grid of options.grids || GRIDS) {
      try {
        const t0 = timing && performance.now();
        const mergedClips = clips.map(clip => robustUnion(clip).polygons);
        const t1 = timing && performance.now();
        // snapPolygons keeps the input's geom structure, so wrap each multipolygon as one geom.
        const collapsed = [], snapOne = (mp, into) => snapPolygons([mp], grid, into)[0] || [];
        const snappedSubject = snapOne(nestRings(subject), collapsed);
        const snappedClips = mergedClips.map(clip => snapOne(clip, collapsed));
        if (!snappedSubject.length || snappedClips.some(clip => !clip.length)) throw new Error('subject or clip collapses on this grid');
        let polygons = polygonClipping.difference(snappedSubject, ...snappedClips);
        const t2 = timing && performance.now();
        let inputArea = 0, perimeter = 0;
        for (const g of remainder) { inputArea += geomArea(g); perimeter += geomPerimeter(g); }
        const displacement = grid * Math.SQRT1_2, tolerance = displacement * perimeter;
        const snappedRemainder = snapPolygons(remainder, grid, collapsed);
        const lost = collapsed.filter(c => c.width > QUANTUM).length;
        if (lost) throw new Error(lost + ' ring(s) wider than ' + QUANTUM + ' collapse on this grid');
        // Repair only adds coverage, so an already oversized difference cannot be fixed.
        if (geomArea(polygons) > inputArea + tolerance) {
          errors.push('grid ' + grid + ': difference area exceeds remainder area before repair');
          break; // an incompatible record needs the full union, not another display grid
        }
        // A nondegenerate remainder cannot be replaced by an empty result.
        if (snappedRemainder.length && !polygons.length) throw new Error('difference is empty');
        // Mesh pieces the record does not cover are added back rather than dropped. Repair only
        // unions area into the result, so previously covered pieces stay covered and only the
        // repaired pieces need re-verifying.
        const boxOf = poly => {
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const ring of poly) for (const [x, y] of ring) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
          return [x0, y0, x1, y1];
        };
        const needsRepair = needsCoverageRepair(polygons, displacement);
        const boxes = polygons.map(boxOf);
        let repaired = 0, appended = 0;
        const uncovered = [];
        for (const geom of snappedRemainder) for (const poly of geom) {
          if (needsRepair(poly)) uncovered.push(poly);
        }
        if (uncovered.length) {
          const near = [];
          for (const poly of uncovered) {
            const [x0, y0, x1, y1] = boxOf(poly);
            if (boxes.some(b => !(x1 < b[0] || x0 > b[2] || y1 < b[1] || y0 > b[3]))) near.push(poly);
            else { polygons.push(poly); appended++; }
          }
          if (near.length) polygons = polygonClipping.union(polygons, ...near);
          const recheck = needsCoverageRepair(polygons, displacement);
          let still = 0;
          for (const poly of uncovered) {
            if (recheck(poly)) still++;
          }
          if (still) throw new Error(still + ' remainder piece(s) missing after adding record gaps');
          repaired = uncovered.length;
        }
        const outputArea = geomArea(polygons);
        if (outputArea > inputArea + tolerance) {
          errors.push('grid ' + grid + ': difference area ' + outputArea + ' exceeds remainder area ' + inputArea);
          break;
        }
        if (timing) { timing.clipMs += t1 - t0; timing.diffMs += t2 - t1; timing.guardMs += performance.now() - t2; timing.attempts = (timing.attempts || 0) + 1; }
        return {polygons, grid, inputArea, outputArea, tolerance, droppedRings: collapsed.length,
          droppedArea: collapsed.reduce((n, c) => n + c.area, 0), unchecked: 0, repaired, appended, attempts: errors, method: 'difference'};
      } catch (error) { errors.push('grid ' + grid + ': ' + error.message); }
    }
    // The parent record does not verify against this mesh: compute the outline exactly.
    const fallback = robustUnion(remainder, options);
    return {...fallback, method: 'union', fallbackReason: errors.join('; ')};
  }
  // Snap and union, trying finer grids first. Throws, never returns partial geometry.
  // Rings narrower than QUANTUM that snapping removes are reported as droppedRings/droppedArea.
  // inputArea and perimeter are measured on the caller's original pieces. The union cannot
  // exceed inputArea by more than one snap displacement along every source edge. It may be
  // smaller where source pieces overlap, so loss is checked by coverage instead: snapping
  // losses are the collapses above, and an interior point of every snapped polygon must lie
  // inside the result. A re-snapped step may move edges by one displacement, so polygons too
  // thin to hold a point farther than that from their edges are counted as `unchecked`.
  function robustUnion(geoms, options = {}) {
    const errors = [], grids = options.grids || GRIDS;
    // Optional phase timings for the city benchmark; absent in normal operation.
    const timing = options.timing || null;
    if (timing) { timing.snapMs = 0; timing.unionMs = 0; timing.guardMs = 0; timing.attempts = 0; }
    let inputArea = 0, perimeter = 0;
    for (const g of geoms) { inputArea += geomArea(g); perimeter += geomPerimeter(g); }
    for (const grid of grids) {
      try {
        const t0 = timing && performance.now();
        const collapsed = [], input = snapPolygons(geoms, grid, collapsed);
        const t1 = timing && performance.now();
        const lost = collapsed.filter(c => c.width > QUANTUM).length;
        if (lost) throw new Error(lost + ' source ring(s) wider than ' + QUANTUM + ' collapse on this grid');
        const resnapped = [], polygons = balancedUnion(input, FAN_IN, grid, resnapped);
        const t2 = timing && performance.now();
        const resnapLost = resnapped.filter(c => c.width > QUANTUM).length;
        if (resnapLost) throw new Error(resnapLost + ' merged ring(s) wider than ' + QUANTUM + ' collapse when re-snapping a failed step');
        const dropped = collapsed.concat(resnapped);
        const outputArea = geomArea(polygons), displacement = grid * Math.SQRT1_2, tolerance = displacement * perimeter;
        if (input.length && !polygons.length) throw new Error('union is empty');
        if (outputArea > inputArea + tolerance) throw new Error('union area ' + outputArea + ' exceeds input area ' + inputArea);
        const inside = containment(polygons);
        let unchecked = 0, uncovered = 0;
        for (const geom of input) for (const poly of geom) {
          const probe = interiorPoint(poly);
          if (!probe || probe.clearance <= displacement) { unchecked++; continue; }
          if (!inside(probe.point)) uncovered++;
        }
        if (uncovered) throw new Error(uncovered + ' source polygon(s) missing from the union');
        if (timing) { timing.snapMs += t1 - t0; timing.unionMs += t2 - t1; timing.guardMs += performance.now() - t2; timing.attempts++; }
        return {polygons, grid, inputArea, outputArea, tolerance, droppedRings: dropped.length, droppedArea: dropped.reduce((n, c) => n + c.area, 0), unchecked, attempts: errors};
      } catch (error) {
        errors.push('grid ' + grid + ': ' + error.message);
      }
    }
    throw new Error('Could not merge outline (' + errors.join('; ') + ')');
  }
  return {GRIDS, QUANTUM, snapPolygons, balancedUnion, robustUnion, robustDifference, needsCoverageRepair, nestRings, interiorPoint, geomArea, geomPerimeter, ringArea};
});
