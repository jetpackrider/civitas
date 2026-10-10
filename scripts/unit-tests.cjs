const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { root } = require('./python.cjs');
function run() {
  const files = fs.readdirSync(`${root}/tests`).filter(name => name.endsWith('.test.cjs')).sort();
  if (!files.length) throw new Error('No unit tests found.');
  const result = spawnSync(process.execPath, ['--test', ...files.map(name => `tests/${name}`)], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
module.exports = { run };
if (require.main === module) process.exitCode = run();
