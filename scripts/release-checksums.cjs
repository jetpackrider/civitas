const fs = require('node:fs/promises');
const path = require('node:path');
const { hash } = require('./data-integrity.cjs');
(async () => {
  const directory = path.resolve(process.argv[2] || 'dist');
  const names = (await fs.readdir(directory)).filter(name => /\.(zip|dmg|exe)$/.test(name)).sort();
  if (!names.length) throw new Error('No release artifacts to checksum.');
  const lines = [];
  for (const name of names) lines.push(`${await hash(path.join(directory, name))}  ${name}`);
  await fs.writeFile(path.join(directory, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
  console.log(`Wrote checksums for ${names.length} local artifacts.`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
