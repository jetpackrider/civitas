const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
async function prepare(name, packaged = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `civitas-${name}-`));
  try {
    const env = { ...process.env, CIVITAS_TEST_HIDE_WINDOW: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.CIVITAS_TEST_WEB_ROOT;
    if (!packaged) {
      const web = path.join(directory, 'web');
      await fs.mkdir(path.join(web, 'data'), { recursive: true });
      for (const entry of await fs.readdir(path.join(root, 'web'), { withFileTypes: true })) {
        if (entry.name !== 'data') await fs.cp(path.join(root, 'web', entry.name), path.join(web, entry.name), { recursive: true });
      }
      await fs.cp(path.join(root, 'tests/fixtures/block-v1'), path.join(web, 'data/block-v1'), { recursive: true });
      env.CIVITAS_TEST_WEB_ROOT = web;
    }
    return { env, profile: path.join(directory, 'profile'), cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
  } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
}
module.exports = { prepare };
