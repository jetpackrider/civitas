// Exercise district sidebar stability, long names, deviation figures, and collapsed state in an isolated Electron profile.
const assert = require('node:assert/strict');
const { _electron: electron } = require('playwright');
const { prepare } = require('./test-environment.cjs');

(async () => {
  const { profile, env, cleanup } = await prepare('sidebar');
  let app;
  const errors = [];
  try {
    app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env, timeout: 60000 });
    await app.context().route('https://**', r => r.abort());
    const page = await app.firstWindow();
    page.on('pageerror', e => { errors.push(e.message); console.error('Renderer error:', e.message); });
    await page.waitForFunction(() => !!window.CivitasApp);

    console.log('Sidebar smoke: creating map...');
    await page.selectOption('#home-geo-select', 'precinct');
    await page.fill('#home-district-count', '3');
    await page.click('#home-create-btn');
    await page.locator('#loading').waitFor({ state: 'hidden', timeout: 120000 });
    await page.evaluate(() => CivitasApp.ready());

    const getSidebarWidth = async () => {
      // A hidden CI window can start its transition later than a fixed sleep.
      // Observe the panel's actual layout before asserting the requested width.
      await page.waitForFunction(() => {
        const panel = document.getElementById('district-sidebar');
        const width = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--district-sidebar-w')) || 0;
        return panel.offsetWidth === width && panel.getAnimations().every(animation => animation.playState !== 'running');
      }, null, { polling: 100, timeout: 15000 });
      return page.evaluate(() => {
        const panel = document.getElementById('district-sidebar');
        const cssVar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--district-sidebar-w')) || 0;
        return { offsetWidth: panel.offsetWidth, cssVar };
      });
    };

    // 1. Initial default state
    const initial = await getSidebarWidth();
    console.log('Initial sidebar width:', initial);
    assert.equal(initial.cssVar, 310, 'Initial sidebar CSS width should be 310px');
    assert.equal(initial.offsetWidth, 310, 'Initial sidebar offsetWidth should be 310px');

    // 2. Stability test: repeated city clicks / recomputes with unchanged row contents
    console.log('Testing stability over repeated recomputes/city painting...');
    for (let i = 0; i < 6; i++) {
      await page.evaluate(async (step) => {
        const city = CivitasApp.editor.cities[0];
        if (city) {
          await CivitasApp.editor.paintCity(city, 'paint', (step % 2) + 1, {});
        } else {
          CivitasApp.editor.endStroke();
        }
      }, i);
      const current = await getSidebarWidth();
      assert.equal(current.cssVar, 310, `Sidebar width must remain 310px after repaint step ${i}, got ${current.cssVar}px`);
      assert.equal(current.offsetWidth, 310, `Sidebar offsetWidth must remain 310px after repaint step ${i}, got ${current.offsetWidth}px`);
    }

    // 3. Long district name: use actual UI rename button in detail panel
    console.log('Testing long district name expansion via UI rename...');
    await page.locator('#district-list .district-box').nth(0).click();
    await page.click('#di-rename-btn');
    const longName = 'North Lake Tahoe & Truckee Regional District';
    await page.fill('#di-name-input', longName);
    await page.locator('#di-name-input').blur();

    const expanded = await getSidebarWidth();
    console.log('Expanded sidebar width for long name:', expanded);
    assert.ok(expanded.cssVar > 310, `Sidebar must expand beyond 310px for long name, got ${expanded.cssVar}px`);
    assert.ok(expanded.cssVar <= 560, `Sidebar must not exceed 560px, got ${expanded.cssVar}px`);
    assert.equal(expanded.offsetWidth, expanded.cssVar, 'Panel offsetWidth must match CSS var');

    // Repeated renders/clicks with long name must stay completely stable
    for (let i = 0; i < 5; i++) {
      await page.evaluate(async (step) => {
        const city = CivitasApp.editor.cities[0];
        if (city) {
          await CivitasApp.editor.paintCity(city, 'paint', (step % 2) + 1, {});
        } else {
          CivitasApp.editor.endStroke();
        }
      }, i);
      const check = await getSidebarWidth();
      assert.equal(check.cssVar, expanded.cssVar, `Expanded sidebar width must not creep on render ${i}: expected ${expanded.cssVar}px, got ${check.cssVar}px`);
      assert.equal(check.offsetWidth, expanded.cssVar, 'Panel offsetWidth must match CSS var');
    }

    // 4. Renaming back to default restores default 310px width
    console.log('Testing reset back to default name...');
    await page.click('#di-rename-btn');
    await page.fill('#di-name-input', 'District 1');
    await page.locator('#di-name-input').blur();

    const restored = await getSidebarWidth();
    console.log('Restored sidebar width:', restored);
    assert.equal(restored.cssVar, 310, 'Sidebar must shrink back to 310px when default name is restored');
    assert.equal(restored.offsetWidth, 310, 'Panel offsetWidth must return to 310px');

    // 5. Collapsed sidebar: stays collapsed across renders and restores correctly
    console.log('Testing collapsed sidebar behavior...');
    await page.click('#toggle-district-sidebar');
    const collapsed = await getSidebarWidth();
    assert.equal(collapsed.cssVar, 0, 'Collapsed sidebar CSS var should be 0px');
    assert.equal(collapsed.offsetWidth, 0, 'Collapsed sidebar width should be 0px');

    // Trigger city painting while collapsed
    await page.evaluate(async () => {
      const city = CivitasApp.editor.cities[0];
      if (city) await CivitasApp.editor.paintCity(city, 'paint', 1, {});
      else CivitasApp.editor.endStroke();
    });
    const stillCollapsed = await getSidebarWidth();
    assert.equal(stillCollapsed.cssVar, 0, 'Sidebar must remain 0px after paint while collapsed');
    assert.equal(stillCollapsed.offsetWidth, 0, 'Sidebar offsetWidth must remain 0px after paint while collapsed');

    // Reopen sidebar
    await page.click('#toggle-district-sidebar');
    const reopened = await getSidebarWidth();
    assert.equal(reopened.cssVar, 310, 'Reopened sidebar should return to 310px');
    assert.equal(reopened.offsetWidth, 310, 'Reopened sidebar offsetWidth should return to 310px');

    // Exercise large deviation figures through real district aggregation in this
    // disposable profile. Production data and the user's map are never changed.
    const originalPopulation = await page.evaluate(() => {
      const e = CivitasApp.editor, p = e.parents.find(p => p.rings.length);
      const original = p.pop20;
      window.sidebarFixtureParent = p;
      p.pop20 = 999999999;
      e.apply(p, 'paint', 'unit', 1, {}); e.endStroke();
      return original;
    });
    const largeFigures = await getSidebarWidth();
    assert.ok(largeFigures.cssVar > 310 && largeFigures.cssVar <= 560);
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => CivitasApp.editor.endStroke());
      assert.deepEqual(await getSidebarWidth(), largeFigures, 'Large figures must not cause width creep');
    }
    assert.equal(await page.evaluate(() => {
      const row = document.querySelector('#district-list .district-box');
      const bounds = row.getBoundingClientRect();
      return [...row.querySelectorAll('.district-count-badge,.district-pct-badge')].every(badge => {
        const b = badge.getBoundingClientRect();
        return b.left >= bounds.left && b.right <= bounds.right && badge.scrollWidth <= badge.clientWidth + 1;
      });
    }), true, 'Large population figures must remain inside the district row');

    await page.click('#di-rename-btn');
    await page.fill('#di-name-input', 'W'.repeat(40));
    await page.locator('#di-name-input').blur();
    assert.equal((await getSidebarWidth()).cssVar, 560, 'Very wide text must respect the existing cap');
    await page.click('#di-rename-btn');
    await page.fill('#di-name-input', 'District 1');
    await page.locator('#di-name-input').blur();
    await page.evaluate(population => {
      sidebarFixtureParent.pop20 = population;
      CivitasApp.editor.apply(sidebarFixtureParent, 'eraser', 'unit', 1, {});
      CivitasApp.editor.endStroke();
    }, originalPopulation);
    assert.equal((await getSidebarWidth()).cssVar, 310, 'Normal contents restore the default width');

    assert.deepEqual(errors, []);
    console.log('PASS: District sidebar width is stable across repeated paints, fits long names without runaway growth, caps at 560px, and honors collapsed state.');
  } finally {
    if (app) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy()));
      await app.close();
    }
    await cleanup();
  }
})().catch(err => {
  console.error('Sidebar smoke test failed:', err);
  process.exitCode = 1;
});
