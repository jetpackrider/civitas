// Exercise the real Electron app with an isolated profile; never touch saved user maps.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { prepare } = require('./test-environment.cjs');

(async () => {
  const executablePath = process.argv[2];
  const { profile, env, cleanup } = await prepare('smoke', !!executablePath);
  let app;
  try {
    app = await electron.launch({
      ...(executablePath ? { executablePath: path.resolve(executablePath) } : {}),
      args: [...(executablePath ? [] : ['.']), `--user-data-dir=${profile}`],
      env,
      timeout: 60000,
    });
    await app.context().route('https://**', route => route.abort());
    const errors = [];
    app.context().setDefaultTimeout(30000);
    const page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForLoadState('domcontentloaded');
    assert.equal(new URL(page.url()).origin, 'null'); // custom scheme
    assert.ok(page.url().startsWith('civitas://app/'));
    // Hidden tests must never open OS dialogs on the user's desktop.
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences().disableDialogs), true);
    const dialogs = [];
    // DevTools still reports dialog attempts when native display is disabled.
    page.on('dialog', dialog => { dialogs.push(dialog.type()); dialog.dismiss().catch(() => {}); });
    const confirmation = await page.evaluate(() => { alert('Isolated test alert'); return confirm('Isolated test confirmation'); });
    assert.equal(confirmation, false);
    assert.deepEqual(dialogs, ['alert', 'confirm']);
    await page.locator('#home-create-btn').waitFor();
    await page.waitForFunction(() => !!window.CivitasApp?.storage);
    const stored = () => page.evaluate(() => {
      const storage = CivitasApp.storage;
      return Object.fromEntries(storage.keys().sort().map(key => [key, storage.getItem(key)]));
    });
    const beforeImport = await stored();
    const rejected = page.waitForEvent('dialog');
    await page.setInputFiles('#home-import-file', { name: 'invalid.civitasmap', mimeType: 'application/json', buffer: Buffer.from('{}') });
    assert.equal((await rejected).message(), 'That file is not a Civitas map file.');
    assert.deepEqual(await stored(), beforeImport);
    // Simulate a large File without allocating 128 MiB in every CI runner.
    await page.evaluate(() => {
      window.testFileReads = 0;
      window.testOriginalRead = FileReader.prototype.readAsText;
      FileReader.prototype.readAsText = function(...args) { testFileReads++;return testOriginalRead.apply(this,args); };
      Object.defineProperty(File.prototype,'size',{configurable:true,get:()=>128*1024*1024+1});
    });
    try {
      const oversized = page.waitForEvent('dialog');
      await page.setInputFiles('#home-import-file', { name: 'oversized.civitasmap', mimeType: 'application/json', buffer: Buffer.from('{}') });
      assert.equal((await oversized).message(), 'That map file exceeds the 128 MiB import limit.');
      assert.equal(await page.evaluate(() => testFileReads), 0);
      assert.deepEqual(await stored(), beforeImport);
    } finally {
      await page.evaluate(() => { delete File.prototype.size;FileReader.prototype.readAsText=testOriginalRead;delete window.testOriginalRead;delete window.testFileReads; });
    }
    assert.equal(await page.evaluate(() => typeof polygonClipping.union), 'function');
    const roles = await app.evaluate(({ Menu }) => {
      const collect = menu => menu.items.flatMap(item => [item.role, ...(item.submenu ? collect(item.submenu) : [])]);
      return collect(Menu.getApplicationMenu());
    });
    for (const role of ['copy', 'paste', 'selectall', 'quit', ...(process.platform === 'darwin' ? ['close'] : [])]) {
      assert.ok(roles.includes(role), `Missing native menu role: ${role}`);
    }
    for (const geography of ['precinct', 'blockgroup']) {
      console.log(`Testing ${geography} map…`);
      await page.selectOption('#home-geo-select', geography);
      await page.click('#home-create-btn');
      await page.locator('#race-list button').first().waitFor({ state: 'attached', timeout: 90000 });
      await page.locator('#loading').waitFor({ state: 'hidden', timeout: 90000 });
      assert.ok(await page.locator('#race-list button').count() > 0);
      await page.fill('#map-name-input', `Desktop smoke ${geography}`);
      await page.locator('#map-name-input').press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
      assert.equal(await page.locator('#map-name-input').evaluate(el => el.selectionEnd - el.selectionStart), `Desktop smoke ${geography}`.length);
      await page.click('#nav-save-map');
      await page.waitForFunction(() => document.getElementById('nav-save-map').textContent === 'Saved');
      await page.click('#nav-home');
      await page.locator('#home-screen').waitFor();
      assert.ok((await page.locator('#home-maps-tbody').innerText()).includes(`Desktop smoke ${geography}`));
    }
    await fs.mkdir('dist', { recursive: true });
    await page.screenshot({ path: `dist/${process.platform}-smoke-test.png` });
    if (process.platform === 'darwin') {
    console.log('Saved both maps; testing window close and Dock activation…');
    // Closing the window leaves the Mac app alive; Dock activation recreates it.
    const closed = page.waitForEvent('close', { timeout: 10000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await closed;
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0);
    const reopened = app.waitForEvent('window', { timeout: 10000 });
    await app.evaluate(({ app }) => app.emit('activate'));
    const newPage = await reopened;
    await newPage.locator('#home-create-btn').waitFor();
    await newPage.waitForFunction(() => {
      const saved = document.getElementById('home-maps-tbody').innerText;
      return saved.includes('Desktop smoke precinct') && saved.includes('Desktop smoke blockgroup');
    });
    const saved = await newPage.locator('#home-maps-tbody').innerText();
    assert.ok(saved.includes('Desktop smoke precinct') && saved.includes('Desktop smoke blockgroup'));
    } else {
      await page.reload();
      await page.locator('#home-create-btn').waitFor();
      await page.waitForFunction(() => {
        const saved = document.getElementById('home-maps-tbody').innerText;
        return saved.includes('Desktop smoke precinct') && saved.includes('Desktop smoke blockgroup');
      });
      const saved = await page.locator('#home-maps-tbody').innerText();
      assert.ok(saved.includes('Desktop smoke precinct') && saved.includes('Desktop smoke blockgroup'));
    }
    assert.deepEqual(errors, []);
    console.log('PASS: native menus, select-all, both geographies and saved-map reopen; macOS also checks Dock activation.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (app) {
      // Discard only this temporary profile's windows, including unsaved test maps on failure.
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy()));
      await app.close();
    }
    await cleanup();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
