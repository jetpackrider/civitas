// ElectionCord Civitas desktop app (Electron).
//
// The map page is the same ElectionCordCivitas.html used on the website. It is served to the window through a
// private "civitas://app/" address that reads straight from the program's own files, so there is no web server,
// no network port, and nothing for anyone else on the network to reach. Saved maps live in the app's own
// storage and stay on this computer.

const { app, BrowserWindow, Menu, protocol, net, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// Packaged: the page and immutable data live inside app.asar beside this module.
// One archive avoids extracting tens of thousands of small map files on Windows.
// Running from source (npm start): use the recovered web assets in this project.
// Fixture roots are allowed only in source-mode tests with disposable profiles.
const TEST_WEB_ROOT = !app.isPackaged && process.env.CIVITAS_TEST_WEB_ROOT &&
  process.env.CIVITAS_TEST_HIDE_WINDOW === '1' && process.argv.some(arg => arg.startsWith('--user-data-dir='));
const WEB_ROOT = TEST_WEB_ROOT ? path.resolve(process.env.CIVITAS_TEST_WEB_ROOT) : path.join(__dirname, 'web');
const INDEX = fs.existsSync(path.join(WEB_ROOT, 'index.html')) ? 'index.html' : 'ElectionCordCivitas.html';

// The page loads one script from a CDN (polygon-clipping, which merges precincts into district outlines).
// Swap it for the copy installed with the app so everything works without that download.
const CDN_POLYGON_CLIPPING = 'https://cdn.jsdelivr.net/npm/polygon-clipping@0.15.7/dist/polygon-clipping.umd.js';
const LOCAL_POLYGON_CLIPPING = path.join(__dirname, 'node_modules', 'polygon-clipping', 'dist', 'polygon-clipping.umd.js');

protocol.registerSchemesAsPrivileged([
  { scheme: 'civitas', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

function registerProtocol() {
  protocol.handle('civitas', async (request) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(request.url).pathname);
    } catch (err) {
      return notFound();
    }
    if (rel === '/' || rel === '') rel = '/' + INDEX;

    if (rel === '/vendor/polygon-clipping.umd.js') {
      try {
        return new Response(fs.readFileSync(LOCAL_POLYGON_CLIPPING), { headers: { 'content-type': 'text/javascript' } });
      } catch (err) {
        return notFound();
      }
    }

    // Only ever serve files inside the web folder.
    const file = path.normalize(path.join(WEB_ROOT, rel));
    if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + path.sep)) {
      return new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/plain' } });
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return notFound();

    if (path.basename(file) === INDEX) {
      const html = fs.readFileSync(file, 'utf8').split(CDN_POLYGON_CLIPPING).join('vendor/polygon-clipping.umd.js');
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}

let mainWindow = null;
// Keep automated checks off the user's desktop, and require their isolated profile.
const HIDE_TEST_WINDOW = process.env.CIVITAS_TEST_HIDE_WINDOW === '1' && process.argv.some(arg => arg.startsWith('--user-data-dir='));

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#ffffff',
    title: 'ElectionCord Civitas',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !HIDE_TEST_WINDOW,
      // Native alert/confirm dialogs can surface even when their test window is hidden.
      disableDialogs: HIDE_TEST_WINDOW,
    },
  });
  mainWindow.once('ready-to-show', () => { if (!HIDE_TEST_WINDOW) mainWindow.show(); });
  mainWindow.on('closed', () => { mainWindow = null; });

  // Links to the web (map credits, etc.) open in the normal browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('civitas://')) {
      event.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  // The page asks "leave with unsaved changes?" when it is closed. A browser shows that prompt itself; here we
  // have to, or the window simply refuses to close.
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Close without saving', 'Keep editing'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: 'This map has changes you have not saved.',
    });
    if (choice === 0) event.preventDefault();   // ignore the page's objection and close
  });

  mainWindow.loadURL('civitas://app/');
}

function buildMenu() {
  const historyAction = direction => async (_item, selectedWindow) => {
    const window = selectedWindow || BrowserWindow.getFocusedWindow() || mainWindow;
    if (!window) return;
    const editing = await window.webContents.executeJavaScript("!!document.activeElement?.closest('input,textarea,[contenteditable=\"true\"]')");
    if (editing) window.webContents[direction]();
    else await window.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('civitas-history', {detail: '${direction}'}))`);
  };
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [{ role: process.platform === 'darwin' ? 'close' : 'quit' }] },
    { label: 'Edit', submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: historyAction('undo') },
      { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: historyAction('redo') },
      ...(process.platform === 'win32' ? [{ label: 'Redo', accelerator: 'Ctrl+Y', visible: false, acceleratorWorksWhenHidden: true, click: historyAction('redo') }] : []),
      { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ] },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        ...(app.isPackaged ? [] : [{ type: 'separator' }, { role: 'toggleDevTools' }]),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      label: 'Help',
      submenu: [
        { label: 'ElectionCord website', click: () => shell.openExternal('https://electioncord.com') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// One copy at a time: opening the program again just brings the existing window forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow && app.isReady()) createWindow();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    registerProtocol();
    buildMenu();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
