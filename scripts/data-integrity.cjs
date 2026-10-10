const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream } = require('node:fs');
const certificate = 'validation.json';
async function hash(file) {
  const digest = crypto.createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}
async function inventory(root, relative = '') {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  const result = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (name === certificate) continue;
    if (entry.isSymbolicLink()) throw new Error(`Dataset contains a symlink: ${name}`);
    if (entry.isDirectory()) Object.assign(result, await inventory(root, name));
    else if (entry.isFile()) {
      if (name.endsWith('.tmp')) throw new Error(`Unfinished dataset write: ${name}`);
      result[name] = await hash(path.join(root, name));
    }
  }
  return result;
}
async function requireStatewide(root) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.fixture || new Set(manifest.counties).size !== 58 || manifest.counties.length !== 58 ||
      manifest.population !== 39538223 || manifest.blocks !== 519723)
    throw new Error('Release requires the complete statewide dataset. Run data:build, then data:validate.');
  return manifest;
}
async function sources(project) {
  const names = ['scripts/validate-block-data.py', 'scripts/build-block-data.py', 'scripts/geodata-sources.json'];
  return Object.fromEntries(await Promise.all(names.map(async name => [name, await hash(path.join(project, name))])));
}
async function seal(root, project) {
  await requireStatewide(root);
  const doc = { version: 1, scope: 'statewide', validatedAt: new Date().toISOString(),
    auditCode: await sources(project), files: await inventory(root) };
  const temporary = path.join(root, certificate + '.tmp');
  await fs.writeFile(temporary, JSON.stringify(doc, null, 2) + '\n');
  await fs.rename(temporary, path.join(root, certificate));
}
async function check(root, project) {
  await requireStatewide(root);
  let doc;
  try { doc = JSON.parse(await fs.readFile(path.join(root, certificate), 'utf8')); }
  catch { throw new Error('Dataset has no validation certificate. Run npm run data:validate.'); }
  if (doc.version !== 1 || doc.scope !== 'statewide') throw new Error('Unsupported validation certificate.');
  const actual = await inventory(root), code = await sources(project);
  for (const [label, expected, found] of [['dataset', doc.files, actual], ['audit code', doc.auditCode, code]]) {
    if (!expected || Object.keys(expected).length !== Object.keys(found).length ||
        Object.entries(found).some(([name, digest]) => expected[name] !== digest))
      throw new Error(`Changed ${label} since validation. Run npm run data:validate again.`);
  }
  return doc;
}
module.exports = { hash, inventory, requireStatewide, sources, seal, check };
