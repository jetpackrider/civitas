const path = require('node:path');
const { run, root } = require('./python.cjs');
const integrity = require('./data-integrity.cjs');
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const dataset = path.join(root, 'web/data/block-v1');
  if (command === 'check') {
    await integrity.check(dataset, root);
    console.log('PASS: statewide dataset and audit code match the validation certificate.');
  } else if (command === 'validate') {
    // Partial and fixture checks never receive a release certificate.
    if (args.length) throw new Error('Use data:validate:completed or data:validate:fixture for previews.');
    await integrity.requireStatewide(dataset);
    const before = await integrity.inventory(dataset);
    const codeBefore = await integrity.sources(root);
    const status = run(['scripts/validate-block-data.py']);
    if (status !== 0) { process.exitCode = status; return; }
    const after = await integrity.inventory(dataset);
    const codeAfter = await integrity.sources(root);
    if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(codeBefore) !== JSON.stringify(codeAfter))
      throw new Error('Dataset or audit code changed during validation. Stop the builder and retry.');
    await integrity.seal(dataset, root);
    console.log('Wrote statewide validation certificate.');
  } else throw new Error('Usage: node scripts/data.cjs validate|check');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
