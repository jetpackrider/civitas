const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { root, executable } = require('./python.cjs');
function command(file, args, options = {}) {
  const result = spawnSync(file, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} exited with ${result.status}`);
}
try {
  const nodeVersion = fs.readFileSync(path.join(root, '.node-version'), 'utf8').trim();
  const pythonVersion = fs.readFileSync(path.join(root, '.python-version'), 'utf8').trim();
  if (process.versions.node !== nodeVersion) throw new Error(`Use Node ${nodeVersion} (see .node-version).`);
  const python = process.env.CIVITAS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const version = spawnSync(python, ['--version'], { encoding: 'utf8' });
  if (version.error || version.status !== 0 || `${version.stdout}${version.stderr}`.trim() !== `Python ${pythonVersion}`)
    throw new Error(`Use Python ${pythonVersion}; CIVITAS_PYTHON can select its executable.`);
  if (!fs.existsSync(executable)) command(python, ['-m', 'venv', '.venv']);
  command(executable, ['-c', `import sys; assert sys.version.split()[0] == '${pythonVersion}', 'Recreate .venv with Python ${pythonVersion}'`]);
  command(executable, ['-m', 'pip', 'install', '-r', 'scripts/geodata-requirements.txt']);
  // npm's JS entry point avoids Windows .cmd quoting and shell interpolation.
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Run this script through npm run setup.');
  command(process.execPath, [npm, 'ci']);
  console.log('Setup complete. Run npm run check.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
