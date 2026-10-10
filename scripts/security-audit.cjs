// Security audit: saved-map imports + the civitas:// file protocol + navigation handling.
// Runs the real app against a disposable profile (scripts/test-environment.cjs) and never touches user data.
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { prepare } = require('./test-environment.cjs');

const results = [];
function report(area, name, pass, detail) {
  results.push({ area, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${area}] ${name}${detail ? ' — ' + detail : ''}`);
}
const sanitize = s => s.replace(/[^a-z0-9]+/gi, '-').slice(0, 40);

(async () => {
  const { profile, env, cleanup } = await prepare('security', false);
  const tmpRoot = path.dirname(profile);            // <tmp>/ with web/ and profile/ inside
  const webRoot = path.join(tmpRoot, 'web');
  const inputs = path.join(tmpRoot, 'inputs');
  await fs.mkdir(inputs, { recursive: true });

  // Canary outside WEB_ROOT: a working traversal must be able to read this.
  const CANARY = 'canary-secret-3f9a2c.txt';
  const canaryPath = path.join(tmpRoot, CANARY);
  await fs.writeFile(canaryPath, 'SECRET-CANARY-CONTENT');
  // Symlink inside web/ pointing outside (web root is app-owned; informational only).
  await fs.symlink(path.join(tmpRoot, CANARY), path.join(webRoot, 'leak-symlink.txt'));

  const write = async (name, text) => { const f = path.join(inputs, name); await fs.writeFile(f, text); return f; };
  const doc = (payload, name, version = 2) => JSON.stringify({ format: 'civitas-map', version, name: name || 'T', payload });

  let app, page;
  const pageErrors = [];
  const dialogs = [];
  try {
    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env, timeout: 60000 });
    const ctx = app.context();
    await ctx.route('https://**', route => route.abort());
    ctx.setDefaultTimeout(60000);
    page = await app.firstWindow();
    page.on('pageerror', e => pageErrors.push(e.message));
    page.on('crash', () => pageErrors.push('RENDERER CRASH'));
    page.on('dialog', d => { dialogs.push({ type: d.type(), text: d.message() }); d.dismiss().catch(() => {}); });
    await page.waitForLoadState('domcontentloaded');
    await page.locator('#home-create-btn').waitFor();

    // Record shell.openExternal calls instead of opening a real browser.
    await app.evaluate(({ shell }) => {
      globalThis.__external = [];
      shell.openExternal = url => { globalThis.__external.push(String(url)); return Promise.resolve(); };
    });

    // ---------- Setup: create + save a base map, then snapshot storage ----------
    await page.selectOption('#home-geo-select', 'precinct');
    await page.fill('#home-district-count', '2');
    await page.click('#home-create-btn');
    await page.locator('#race-list button').first().waitFor({ timeout: 90000 });
    await page.locator('#loading').waitFor({ state: 'hidden', timeout: 90000 });
    await page.fill('#map-name-input', 'Base map');
    await page.click('#nav-save-map');
    await page.waitForFunction(() => document.getElementById('nav-save-map').textContent === 'Saved');
    await page.click('#nav-home');
    await page.locator('#home-screen').waitFor();

    const readState = () => page.evaluate(() => {
      const s = window.CivitasApp.storage;
      return { keys: s.keys().sort(), cat: s.getItem('civitas-districts-v2'), proto: Object.getOwnPropertyNames(Object.prototype).sort(), polluted: Object.hasOwn(Object.prototype,'pwned') };
    });
    let baseline = await readState();
    if (!JSON.parse(baseline.cat)['Base map']) throw new Error('base map was not saved');

    const clearNotice = () => page.evaluate(() => { const s = document.getElementById('editor-status'); s.hidden = true; s.textContent = ''; });

    // Drive the real "Open map file…" input; classify the outcome by what the app does.
    async function attemptImport(file, timeout = 30000) {
      await clearNotice();
      const beforeDialogs = dialogs.length;
      const catAtStart = await page.evaluate(() => window.CivitasApp.storage.getItem('civitas-districts-v2'));
      await page.setInputFiles('#home-import-file', file);
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (dialogs.length > beforeDialogs) return { kind: 'alert', text: dialogs[dialogs.length - 1].text };
        const out = await page.evaluate(prevCat => {
          const s = document.getElementById('editor-status');
          const notice = s && !s.hidden && s.classList.contains('error') ? s.textContent : null;
          return { notice, catChanged: window.CivitasApp.storage.getItem('civitas-districts-v2') !== prevCat };
        }, catAtStart).catch(() => ({ notice: null, catChanged: false }));
        if (out.notice) return { kind: 'notice', text: out.notice };
        if (out.catChanged) {
          await page.waitForTimeout(400);
          const names = await page.evaluate(() => Object.keys(JSON.parse(window.CivitasApp.storage.getItem('civitas-districts-v2') || '{}')));
          return { kind: 'accepted', text: 'catalogue now: ' + names.join(', ') };
        }
        await page.waitForTimeout(200);
      }
      return { kind: 'timeout', text: '' };
    }

    async function verifyIntact(label, expectAccepted = false) {
      // Accepted imports open the map view; go home to inspect the list.
      const onMap = await page.evaluate(() => document.getElementById('home-screen').hidden);
      if (onMap) { await page.click('#nav-home'); await page.locator('#home-screen').waitFor(); }
      await page.waitForTimeout(300);
      const now = await readState();
      const nowCat = JSON.parse(now.cat || '{}');
      const baseCat = JSON.parse(baseline.cat);
      report('intact', `${label}: base map entry unchanged`, JSON.stringify(nowCat['Base map']) === JSON.stringify(baseCat['Base map']));
      if (!expectAccepted) {
        report('intact', `${label}: catalogue deep-equal`, now.cat === baseline.cat,
          now.cat !== baseline.cat ? `catalogue keys: ${Object.keys(nowCat).join(', ')}` : '');
        report('intact', `${label}: storage key set unchanged`, JSON.stringify(now.keys) === JSON.stringify(baseline.keys),
          `before=${baseline.keys.length} after=${now.keys.length}`);
      }
      report('intact', `${label}: Object.prototype clean`,
        JSON.stringify(now.proto) === JSON.stringify(baseline.proto) && !now.polluted,
        now.polluted ? 'POLLUTED' : '');
      const listed = await page.evaluate(() => document.getElementById('home-maps-tbody').innerText);
      report('intact', `${label}: home list still shows base map`, listed.includes('Base map'));
    }

    async function refreshBaseline() {
      await page.evaluate(prev => window.CivitasApp.storage.setItem('civitas-districts-v2', prev), baseline.cat);
      await page.evaluate(() => window.CivitasApp.storage.flush());
      baseline = await readState();
    }

    // ---------- Section 1: malformed / structural ----------
    const cases = [
      ['malformed JSON', await write('bad-json.civitasmap', '{this is not json')],
      ['empty file', await write('empty.civitasmap', '')],
      ['BOM + malformed JSON', await write('bom.civitasmap', '﻿' + '{still not json')],
      ['wrong format field', await write('fmt.civitasmap', JSON.stringify({ format: 'evil', version: 2, payload: {} }))],
      ['payload null', await write('pnull.civitasmap', JSON.stringify({ format: 'civitas-map', version: 2, payload: null }))],
      ['payload string', await write('pstr.civitasmap', JSON.stringify({ format: 'civitas-map', version: 2, payload: 'x' }))],
      ['payload array', await write('parr.civitasmap', JSON.stringify({ format: 'civitas-map', version: 2, payload: [1] }))],
      ['version 3', await write('v3.civitasmap', doc({}, 'T', 3))],
      ['version "2" (string)', await write('vstr.civitasmap', JSON.stringify({ format: 'civitas-map', version: '2', payload: { state: 'CA', count: 2, assignments: {} } }))],
      ['version missing', await write('vmiss.civitasmap', JSON.stringify({ format: 'civitas-map', payload: { state: 'CA', count: 2, assignments: {} } }))],
      ['deep nesting (150k)', await write('deep.civitasmap',
        '{"format":"civitas-map","version":2,"payload":{"state":"ZZ","count":2,"names":' + '['.repeat(150000) + ']'.repeat(150000) + '}}')],
    ];
    for (const [name, file] of cases) {
      const r = await attemptImport(file);
      report('malformed', `${name}: rejected (${r.kind})`, r.kind === 'alert' || r.kind === 'notice', `${r.kind}: ${r.text}`);
      await verifyIntact(`reject ${name}`);
    }

    // ---------- Section 2: invalid ids / counts / dataset ----------
    const aid = await page.evaluate(() => window.CivitasApp.editor.parents[0]?._id);
    if (!aid) throw new Error('no geography unit id available');
    const vcases = [
      ['unknown state', doc({ state: 'ZZ', count: 2, assignments: {} })],
      ['dataset mismatch', doc({ state: 'CA', dataset: 'evil-dataset', count: 2, assignments: {} })],
      ['count -1', doc({ state: 'CA', count: -1, assignments: {} })],
      ['count 1001', doc({ state: 'CA', count: 1001, assignments: {} })],
      ['count 2.5', doc({ state: 'CA', count: 2.5, assignments: {} })],
      ['count "4"', doc({ state: 'CA', count: '4', assignments: {} })],
      ['count null', doc({ state: 'CA', count: null, assignments: {} })],
      ['count 1e400 (Infinity)', '{"format":"civitas-map","version":2,"payload":{"state":"CA","count":1e400,"assignments":{}}}'],
      ['unknown unit id', doc({ state: 'CA', count: 2, assignments: { 'EVIL|NOPE': 1 } })],
      ['district id 0', doc({ state: 'CA', count: 2, assignments: { [aid]: 0 } })],
      ['district id -5', doc({ state: 'CA', count: 2, assignments: { [aid]: -5 } })],
      ['district id 999 (> count)', doc({ state: 'CA', count: 2, assignments: { [aid]: 999 } })],
      ['district id 1.5', doc({ state: 'CA', count: 2, assignments: { [aid]: 1.5 } })],
      ['district id "2"', doc({ state: 'CA', count: 2, assignments: { [aid]: '2' } })],
      ['unknown block override', JSON.stringify({ format: 'civitas-map', version: 2, payload: {
        state: 'CA', count: 2, unitAssignments: { [aid]: { district: 1, overrides: { 'EVIL-BLOCK-9999': 1 } } } } })],
      ['override district 999', JSON.stringify({ format: 'civitas-map', version: 2, payload: {
        state: 'CA', count: 2, unitAssignments: { [aid]: { district: 1, overrides: { x: 999 } } } } })],
    ];
    for (const [name, text] of vcases) {
      const r = await attemptImport(await write(sanitize(name) + '.civitasmap', text));
      report('validation', `${name}: rejected`, r.kind === 'notice' || r.kind === 'alert', `${r.kind}: ${r.text}`);
      await verifyIntact(`reject ${name}`);
    }

    // ---------- Section 3: rejected import while a map is open (rollback path) ----------
    // A different-state payload skips eager validation, so the failure happens after the
    // app has already switched geography — this is the path that must roll back.
    await page.evaluate(() => document.querySelector('#home-maps-tbody tr')?.click());
    await page.locator('#loading').waitFor({ state: 'hidden', timeout: 90000 });
    await page.waitForFunction(() => !document.getElementById('app-view').hidden);
    const hashBefore = await page.evaluate(() => location.hash);
    const r = await attemptImport(await write('rollback.civitasmap', doc({ state: 'CA-BG', count: 2, assignments: { 'EVIL|NOPE': 1 } })));
    report('rollback', 'different-state bad import rejected while map open', r.kind === 'notice' || r.kind === 'alert', `${r.kind}: ${r.text}`);
    await page.waitForTimeout(1500); // let any rollback finish
    const after = await page.evaluate(() => ({
      hash: location.hash, name: document.getElementById('map-name-input').value,
      stillOpen: !document.getElementById('app-view').hidden,
    }));
    report('rollback', 'open map restored (name + hash + view)', after.name === 'Base map' && after.hash === hashBefore && after.stillOpen, JSON.stringify(after));
    await verifyIntact('rollback case');

    // ---------- Section 4: prototype keys (raw JSON text so __proto__ stays an own property) ----------
    // Valid CA payloads: each may be accepted (junk silently ignored) or rejected; what matters
    // is that Object.prototype stays clean and the base map survives either way.
    const protoCases = [
      ['__proto__ in payload', '{"format":"civitas-map","version":2,"name":"P","payload":{"__proto__":{"pwned":1},"state":"CA","count":2,"assignments":{}}}'],
      ['__proto__ in assignments key', '{"format":"civitas-map","version":2,"name":"P","payload":{"state":"CA","count":2,"assignments":{"__proto__":{"pwned":1},"' + aid + '":1}}}'],
      ['constructor.prototype in names', '{"format":"civitas-map","version":2,"name":"P","payload":{"state":"CA","count":2,"assignments":{},"names":{"constructor":{"prototype":{"pwned":1}}}}}'],
      ['__proto__ in doc root', '{"format":"civitas-map","version":2,"name":"P","__proto__":{"pwned":1},"payload":{"state":"CA","count":2,"assignments":{}}}'],
      ['__proto__ as override key', '{"format":"civitas-map","version":2,"payload":{"state":"CA","count":2,"unitAssignments":{"' + aid + '":{"district":1,"overrides":{"__proto__":1}}}}}'],
    ];
    for (const [name, text] of protoCases) {
      const rr = await attemptImport(await write(sanitize(name) + '.civitasmap', text));
      report('proto', `${name}: handled (${rr.kind})`, rr.kind !== 'timeout', rr.text);
      await verifyIntact(`proto ${name}`, rr.kind === 'accepted');
      if (rr.kind === 'accepted') await refreshBaseline();
    }
    // A valid CA map carrying crafted history must still import, dropping that history.
    const protoOk = '{"format":"civitas-map","version":2,"name":"ProtoOK","payload":' +
      '{"__proto__":{"pwned":1},"state":"CA","count":2,' +
      '"assignments":{"' + aid + '":1},"names":{"1":"First"},"locked":{"1":true},' +
      '"history":{"commands":[{"label":"x","changes":[{"section":"__proto__","key":"pwned","before":null,"after":{"evil":1}}]}],"cursor":0}}}';
    let rr = await attemptImport(await write('proto-accept.civitasmap', protoOk));
    report('proto', 'valid map with crafted history accepted (history must be dropped)', rr.kind === 'accepted', rr.kind);
    await page.waitForTimeout(800);
    let snapNow = await readState();
    report('proto', 'accept-path: Object.prototype clean', !snapNow.polluted && JSON.stringify(snapNow.proto) === JSON.stringify(baseline.proto));
    report('proto', 'crafted import history dropped', await page.evaluate(() => CivitasApp.editor.history.commands.length === 0));
    // If the crafted history somehow survived, undo must still not pollute.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('civitas-history', { detail: 'undo' })));
    await page.waitForTimeout(800);
    report('proto', 'undo after crafted-history import: Object.prototype clean', !(await readState()).polluted);
    await verifyIntact('proto accept-path', true);
    await refreshBaseline();

    // ---------- Section 5: oversized inputs ----------
    const junkKeys = n => { let s = ''; for (let i = 0; i < n; i++) s += `"junk${i}":1,`; return s; };
    let t0 = Date.now();
    rr = await attemptImport(await write('wide-assignments.civitasmap',
      '{"format":"civitas-map","version":2,"payload":{"state":"CA","count":2,"assignments":{' + junkKeys(200000) + '"last":1}}}'));
    report('oversize', '200k unknown assignment keys: rejected quickly', (rr.kind === 'notice' || rr.kind === 'alert') && Date.now() - t0 < 20000,
      `${rr.kind} in ${Date.now() - t0}ms: ${rr.text}`);
    await verifyIntact('wide assignments');

    const bigNames = k => Array.from({ length: k }, (_, i) => `"d${i}":"${'x'.repeat(24)}"`).join(',');
    const hugeDoc = '{"format":"civitas-map","version":2,"name":"HugeNames","payload":{"state":"CA","count":2,"assignments":{},"names":{' + bigNames(300000) + '}}}';
    t0 = Date.now();
    rr = await attemptImport(await write('huge-names.civitasmap', hugeDoc), 90000);
    report('oversize', `${(hugeDoc.length / 1048576).toFixed(1)}MB names metadata: handled without crash`,
      rr.kind !== 'timeout' && !pageErrors.some(e => e.includes('CRASH')), `${rr.kind} in ${Date.now() - t0}ms`);
    await page.waitForTimeout(500);
    snapNow = await readState();
    const hugeCat = JSON.parse(snapNow.cat || '{}');
    report('oversize', 'unbounded names metadata rejected without persistence',
      !hugeCat.HugeNames && ['notice','alert'].includes(rr.kind), rr.kind);
    report('oversize', 'huge import: prototype + base map intact', !snapNow.polluted && !!hugeCat['Base map']);
    await verifyIntact('huge names');

    // 60MB file
    const pad = 'y'.repeat(64);
    const big = '{"format":"civitas-map","version":2,"name":"Big60","payload":{"state":"CA","count":2,"assignments":{},"names":{' +
      Array.from({ length: Math.floor(60 * 1048576 / 80) }, (_, i) => `"k${i}":"${pad}"`).join(',') + '}}}';
    t0 = Date.now();
    rr = await attemptImport(await write('big-60mb.civitasmap', big), 180000);
    report('oversize', '60MB map file: no renderer crash / permanent hang', !pageErrors.some(e => e.includes('CRASH')) && rr.kind !== 'timeout',
      `${rr.kind} in ${Date.now() - t0}ms`);
    await page.waitForTimeout(500);
    report('oversize', '60MB invalid metadata rejected', ['notice','alert'].includes(rr.kind), rr.kind);
    await verifyIntact('60MB names');

    // ---------- Section 6: protocol (civitas://) ----------
    const fileURL = canaryPath.split('/').map(encodeURIComponent).join('/');
    const probes = [
      'civitas://app/',
      'civitas://app/index.html',
      `civitas://app/../${CANARY}`,
      `civitas://app/%2e%2e/${CANARY}`,
      `civitas://app/..%2f${CANARY}`,
      `civitas://app/.%2e/${CANARY}`,
      `civitas://app/%2E%2E/${CANARY}`,
      `civitas://app/data/%2e%2e/%2e%2e/${CANARY}`,
      `civitas://app/data/../../${CANARY}`,
      `civitas://app/%252e%252e/${CANARY}`,
      `civitas://app/..%5c${CANARY}`,
      `civitas://app/%00${CANARY}`,
      `civitas://app//${CANARY}`,
      'civitas://app/data/',
      'civitas://app/data/block-v1/CA/races.json',
      'civitas://app/index.html/../../../etc/passwd',
      `civitas://otherhost/${CANARY}`,
      'file:///etc/passwd',
      'file:///' + fileURL,
    ];
    const fetched = await page.evaluate(async urls => {
      const out = [];
      for (const u of urls) {
        try {
          const r = await fetch(u);
          const text = await r.text();
          out.push({ u, status: r.status, len: text.length, secret: text.includes('SECRET-CANARY-CONTENT'), head: text.slice(0, 40) });
        } catch (e) { out.push({ u, error: String(e).slice(0, 60) }); }
      }
      return out;
    }, probes);
    for (const f of fetched) {
      const outcome = f.error ? `blocked (${f.error})` : `${f.status} len=${f.len}`;
      report('protocol', `${f.u} → ${outcome}`, !f.secret, f.secret ? 'TRAVERSAL LEAK' : '');
    }
    const control = fetched.find(f => f.u.endsWith('CA/races.json'));
    report('protocol', 'control: fixture data still served', !!control && control.status === 200);

    // Symlink inside the app-owned web root: informational (lexical containment only).
    const link = await page.evaluate(async () => {
      try { const r = await fetch('civitas://app/leak-symlink.txt'); const t = await r.text(); return { status: r.status, secret: t.includes('SECRET-CANARY-CONTENT') }; }
      catch (e) { return { error: String(e) }; }
    });
    report('protocol', 'symlink in web root followed by handler (informational)', true,
      link.secret ? 'served — path check is lexical; web root is app-owned so not attacker-reachable' : JSON.stringify(link));

    // ---------- Section 7: navigation ----------
    const navUrl0 = await page.url();
    await page.evaluate(() => { location.href = 'file:///etc/passwd'; });
    await page.waitForTimeout(1200);
    report('navigation', 'file:// navigation blocked', (await page.url()) === navUrl0 && !(await page.evaluate(() => document.body.innerText.includes('root:'))));

    await page.evaluate(() => { location.href = 'https://example.com/external-nav'; });
    await page.waitForTimeout(1200);
    let ext = await app.evaluate(() => globalThis.__external);
    report('navigation', 'https navigation blocked in-app, sent to shell.openExternal',
      (await page.url()) === navUrl0 && ext.includes('https://example.com/external-nav'), JSON.stringify(ext));

    await page.evaluate(() => { window.open('https://example.com/window-open'); });
    await page.waitForTimeout(1200);
    ext = await app.evaluate(() => globalThis.__external);
    report('navigation', 'window.open(https) denied + handed to browser',
      ext.includes('https://example.com/window-open') && (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 1,
      JSON.stringify(ext));

    await page.evaluate(() => { window.open('file:///etc/passwd'); });
    await page.waitForTimeout(800);
    ext = await app.evaluate(() => globalThis.__external);
    report('navigation', 'window.open(file://) denied and NOT handed to shell', !ext.some(u => u.startsWith('file:')), JSON.stringify(ext));

    const iframeInner = await page.evaluate(async () => {
      const f = document.createElement('iframe');
      f.src = 'file:///etc/passwd'; f.style.display = 'none';
      document.body.appendChild(f);
      await new Promise(r => setTimeout(r, 1500));
      let inner = null; try { inner = f.contentDocument?.body?.innerText ?? null; } catch (e) { inner = 'blocked'; }
      f.remove(); return inner;
    });
    report('navigation', 'file:// iframe cannot read local files', !String(iframeInner).includes('root:'), String(iframeInner).slice(0, 40));

    await page.evaluate(() => { location.href = 'civitas://app/index.html'; });
    await page.waitForLoadState('domcontentloaded');
    await page.locator('#home-create-btn').waitFor();
    await page.waitForFunction(() => window.CivitasApp && window.CivitasApp.storage);
    report('navigation', 'civitas:// self-navigation allowed', (await page.url()).startsWith('civitas://app/'));

    // ---------- Section 8: valid control import ----------
    const basePayload = JSON.parse(baseline.cat)['Base map'];
    delete basePayload.id; delete basePayload.updated; delete basePayload.history;
    rr = await attemptImport(await write('good.civitasmap', JSON.stringify({ format: 'civitas-map', version: 2, name: 'Good import', payload: basePayload })));
    await page.waitForTimeout(800);
    const goodCat = JSON.parse((await readState()).cat || '{}');
    report('control', 'valid import accepted and listed', rr.kind === 'accepted' && !!goodCat['Good import'], rr.kind);
    report('control', 'valid import kept base map intact',
      JSON.stringify(goodCat['Base map']) === JSON.stringify(JSON.parse(baseline.cat)['Base map']));
    const listed = await page.evaluate(() => document.getElementById('home-maps-tbody').innerText);
    report('control', 'home list shows both maps', listed.includes('Base map') && listed.includes('Good import'));

    // ---------- Summary ----------
    if (pageErrors.length) console.log('\nRenderer errors during run:\n' + pageErrors.map(e => '  ' + e).join('\n'));
    const failed = results.filter(r => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
    if (failed.length) { console.log('FAILED:'); failed.forEach(f => console.log(`  [${f.area}] ${f.name} — ${f.detail}`)); }
    process.exitCode = failed.length ? 1 : 0;
  } catch (err) {
    console.error('AUDIT ERROR:', err);
    if (pageErrors.length) console.log('Renderer errors:\n' + pageErrors.join('\n'));
    process.exitCode = 2;
  } finally {
    try {
      if(app) {
        await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().forEach(window=>window.destroy()));
        await app.close();
      }
    } finally {await cleanup();}
  }
})().catch(error=>{console.error(error);process.exitCode=2;});
