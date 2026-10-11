const { spawnSync } = require('node:child_process');
const { run, root } = require('./python.cjs');
function node(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
try {
  const checks = [
    () => require('./unit-tests.cjs').run(),
    () => run(['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py']),
    () => run(['scripts/validate-block-data.py', '--fixture', '--root', 'tests/fixtures/block-v1']),
    ...['smoke-test', 'editor-smoke', 'pointer-smoke', 'sidebar-smoke'].map(name => () => node([`scripts/${name}.cjs`])),
    () => node(['scripts/smoke-test.cjs', '--archive']),
  ];
  for (const check of checks) { const status = check(); if (status !== 0) { process.exitCode = status; break; } }
} catch (error) { console.error(error.message); process.exitCode = 1; }
